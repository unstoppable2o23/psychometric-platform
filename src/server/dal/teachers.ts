/**
 * Teacher account management, restricted to the super admin.
 *
 * Every function here takes the acting admin and re-checks the role, because a
 * Server Action is reachable by direct POST and a page-level guard proves
 * nothing. All privileged writes are recorded in `audit_logs`.
 */
import 'server-only';
import { getDb } from '../db/client';
import { generateInviteToken, hashInviteToken, inviteHint } from '../auth/passwords';
import { generateAuthUserId, provisionAuthUser } from '../auth/provisioning';
import { AuthorizationError, requireAdmin, type Actor } from './actor';

/**
 * Request metadata for the audit log.
 *
 * Passed in by the caller rather than read from `next/headers` here. A data
 * access layer that reaches for request-scoped APIs cannot be called from a
 * script or a test, and it hides the dependency on the request lifecycle.
 */
export interface AuditMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** A rejected input, as opposed to an authorisation failure. */
export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface TeacherRow {
  id: string;
  displayName: string;
  email: string;
  organizationId: string | null;
  organizationName: string | null;
  isActive: boolean;
  roleInOrg: string | null;
  /** False until the teacher has redeemed an activation link. */
  hasPassword: boolean;
  lastSignInAt: Date | null;
  pendingInviteExpiresAt: Date | null;
  createdAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export async function listTeachers(actor: Actor, search?: string): Promise<TeacherRow[]> {
  requireAdmin(actor);
  const db = await getDb();

  const pattern = search?.trim() ? `%${search.trim()}%` : null;
  const { rows } = await db.query<{
    id: string;
    display_name: string | null;
    email: string | null;
    organization_id: string | null;
    organization_name: string | null;
    is_active: boolean;
    role_in_org: string | null;
    has_password: boolean;
    last_sign_in_at: Date | null;
    created_at: Date;
    failed_attempts: number;
    locked_until: Date | null;
    invite_expires: Date | null;
  }>(
    `select p.id, p.display_name, p.email, p.organization_id,
            o.name as organization_name,
            p.is_active,
            m.role_in_org,
            (c.user_id is not null) as has_password,
            c.last_sign_in_at, p.created_at, c.failed_attempts, c.locked_until,
            (select max(i.expires_at) from auth_invites i
              where i.user_id = p.id and i.status = 'pending') as invite_expires
       from profiles p
       left join organizations o on o.id = p.organization_id
       left join organization_members m on m.user_id = p.id and m.organization_id = p.organization_id
       left join auth_credentials c on c.user_id = p.id
      where p.role = 'teacher'
        and ($1::text is null
             or p.display_name ilike $1 or p.email ilike $1 or o.name ilike $1)
      order by p.is_active asc, lower(coalesce(p.display_name, p.email)) asc`,
    [pattern],
  );

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name ?? r.email ?? '(no name)',
    email: r.email ?? '',
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    isActive: r.is_active,
    roleInOrg: r.role_in_org,
    hasPassword: r.has_password,
    lastSignInAt: r.last_sign_in_at,
    pendingInviteExpiresAt: r.invite_expires,
    createdAt: r.created_at,
    failedAttempts: r.failed_attempts,
    lockedUntil: r.locked_until,
  }));
}

export async function listOrganizations(actor: Actor) {
  requireAdmin(actor);
  const db = await getDb();
  const { rows } = await db.query<{ id: string; name: string; slug: string }>(
    `select id, name, slug from organizations where is_active order by lower(name)`,
  );
  return rows;
}

export interface CreateTeacherInput {
  displayName: string;
  email: string;
  organizationId: string | null;
  roleInOrg: 'owner' | 'admin' | 'teacher';
}

export interface CreateTeacherResult {
  userId: string;
  /** Raw activation token. Returned once and never recoverable again. */
  activationToken: string;
  expiresAt: Date;
}

/**
 * Creates a teacher with no password and a single pending activation link.
 *
 * The plaintext token is returned to the admin to pass on; only its hash is
 * stored, matching how assessment links work. Reissuing an invite revokes the
 * previous one.
 */
export async function createTeacher(
  actor: Actor,
  input: CreateTeacherInput,
  meta: AuditMeta = {},
): Promise<CreateTeacherResult> {
  requireAdmin(actor);
  const db = await getDb();
  const email = input.email.trim().toLowerCase();

  return db.tx(async (tx) => {
    const clash = await tx.query<{ id: string; role: string }>(
      `select id, role from profiles where lower(email) = lower($1)`,
      [email],
    );
    if (clash.rows[0]) {
      throw new ValidationError(
        clash.rows[0].role === 'teacher'
          ? 'A teacher already uses that email address.'
          : 'That email address is already registered.',
      );
    }

    if (input.organizationId) {
      const org = await tx.query(`select id from organizations where id = $1 and is_active`, [
        input.organizationId,
      ]);
      if (!org.rows[0]) throw new ValidationError('That school is not available.');
    }

    const userId = generateAuthUserId();

    // profiles.id mirrors auth.users.id, so the auth user has to exist first.
    // See auth/provisioning.ts for how this changes on Supabase.
    await provisionAuthUser(tx, userId, email);

    await tx.query(
      `insert into profiles (id, role, display_name, email, organization_id)
       values ($1, 'teacher', $2, $3, $4)`,
      [userId, input.displayName.trim(), email, input.organizationId],
    );

    if (input.organizationId) {
      await tx.query(
        `insert into organization_members (organization_id, user_id, role_in_org)
         values ($1, $2, $3)
         on conflict (organization_id, user_id) do update set role_in_org = excluded.role_in_org`,
        [input.organizationId, userId, input.roleInOrg],
      );
    }

    const token = generateInviteToken();
    const invite = await tx.query<{ expires_at: Date }>(
      `insert into auth_invites (user_id, token_hash, token_hint, created_by)
       values ($1, $2, $3, $4) returning expires_at`,
      [userId, hashInviteToken(token), inviteHint(token), actor.userId],
    );

    await tx.query(
      `insert into audit_logs (actor_id, actor_role, action, entity_type, entity_id, metadata, ip, user_agent)
       values ($1, 'admin', 'teacher.created', 'profile', $2, $3, $4, $5)`,
      [
        actor.userId,
        userId,
        JSON.stringify({ email, organizationId: input.organizationId, roleInOrg: input.roleInOrg }),
        meta.ip ?? null,
        meta.userAgent ?? null,
      ],
    );

    return { userId, activationToken: token, expiresAt: invite.rows[0].expires_at };
  });
}

/** Edits a teacher's details. Changing email does not affect their password. */
export async function updateTeacher(
  actor: Actor,
  userId: string,
  patch: { displayName?: string; email?: string; organizationId?: string | null; roleInOrg?: string },
): Promise<void> {
  requireAdmin(actor);
  const db = await getDb();

  const existing = await db.query<{ email: string; role: string }>(
    `select email, role from profiles where id = $1`,
    [userId],
  );
  if (!existing.rows[0] || existing.rows[0].role !== 'teacher') {
    throw new AuthorizationError('not_found');
  }

  if (patch.email) {
    const clash = await db.query<{ id: string }>(
      `select id from profiles where lower(email) = lower($1) and id <> $2`,
      [patch.email.trim(), userId],
    );
    if (clash.rows[0]) throw new ValidationError('Another account already uses that email address.');
  }

  await db.tx(async (tx) => {
    await tx.query(
      `update profiles
          set display_name = coalesce($2, display_name),
              email = coalesce($3, email),
              organization_id = case when $4::boolean then $5 else organization_id end
        where id = $1`,
      [
        userId,
        patch.displayName?.trim() ?? null,
        patch.email ? patch.email.trim().toLowerCase() : null,
        patch.organizationId !== undefined,
        patch.organizationId ?? null,
      ],
    );

    if (patch.roleInOrg && patch.organizationId !== undefined) {
      await tx.query(
        `insert into organization_members (organization_id, user_id, role_in_org)
         values ($1, $2, $3)
         on conflict (organization_id, user_id) do update set role_in_org = excluded.role_in_org`,
        [patch.organizationId, userId, patch.roleInOrg],
      );
    }

    await tx.query(
      `insert into audit_logs (actor_id, actor_role, action, entity_type, entity_id, metadata)
       values ($1, 'admin', 'teacher.updated', 'profile', $2, $3)`,
      [actor.userId, userId, JSON.stringify(patch)],
    );
  });
}

/**
 * Enables or disables a teacher.
 *
 * Disabling goes through app.set_teacher_enabled, which bumps the credential
 * version (killing live sessions) and revokes any pending activation link.
 */
export async function setTeacherEnabled(actor: Actor, userId: string, enabled: boolean): Promise<void> {
  requireAdmin(actor);
  const db = await getDb();

  const changed = await db.query<{ was: boolean }>(
    `select is_active as was from profiles where id = $1 and role = 'teacher'`,
    [userId],
  );
  if (!changed.rows[0]) throw new AuthorizationError('not_found');
  if (changed.rows[0].was === enabled) return;

  await db.tx(async (tx) => {
    await tx.query(`select app.set_teacher_enabled($1, $2)`, [userId, enabled]);
    await tx.query(
      `insert into audit_logs (actor_id, actor_role, action, entity_type, entity_id, metadata)
       values ($1, 'admin', $2, 'profile', $3, '{}'::jsonb)`,
      [actor.userId, enabled ? 'teacher.enabled' : 'teacher.disabled', userId],
    );
  });
}

/** Issues a fresh activation link, revoking any outstanding one. */
export async function issueActivation(
  actor: Actor,
  userId: string,
): Promise<{ activationToken: string; expiresAt: Date }> {
  requireAdmin(actor);
  const db = await getDb();

  const teacher = await db.query<{ id: string }>(
    `select id from profiles where id = $1 and role = 'teacher'`,
    [userId],
  );
  if (!teacher.rows[0]) throw new AuthorizationError('not_found');

  return db.tx(async (tx) => {
    await tx.query(
      `update auth_invites set status = 'revoked' where user_id = $1 and status = 'pending'`,
      [userId],
    );
    const token = generateInviteToken();
    const invite = await tx.query<{ expires_at: Date }>(
      `insert into auth_invites (user_id, token_hash, token_hint, created_by)
       values ($1, $2, $3, $4) returning expires_at`,
      [userId, hashInviteToken(token), inviteHint(token), actor.userId],
    );
    await tx.query(
      `insert into audit_logs (actor_id, actor_role, action, entity_type, entity_id)
       values ($1, 'admin', 'teacher.activation_issued', 'profile', $2)`,
      [actor.userId, userId],
    );
    return { activationToken: token, expiresAt: invite.rows[0].expires_at };
  });
}

/** Clears a lockout so a teacher can try again immediately. */
export async function unlockTeacher(actor: Actor, userId: string): Promise<void> {
  requireAdmin(actor);
  const db = await getDb();
  const updated = await db.query(
    `update auth_credentials set failed_attempts = 0, locked_until = null where user_id = $1`,
    [userId],
  );
  if ((updated.rowCount ?? 0) === 0) {
    // No credential row yet means they have not activated, so nothing to unlock.
    return;
  }
  await db.query(
    `insert into audit_logs (actor_id, actor_role, action, entity_type, entity_id)
     values ($1, 'admin', 'teacher.unlocked', 'profile', $2)`,
    [actor.userId, userId],
  );
}

export async function adminTeacherStats(actor: Actor) {
  requireAdmin(actor);
  const db = await getDb();
  const { rows } = await db.query<{
    total: number;
    active: number;
    disabled: number;
    activated: number;
    pending: number;
  }>(
    `select
       count(*)::int as total,
       count(*) filter (where p.is_active)::int as active,
       count(*) filter (where not p.is_active)::int as disabled,
       count(*) filter (where c.user_id is not null)::int as activated,
       count(*) filter (where c.user_id is null and exists (
          select 1 from auth_invites i where i.user_id = p.id and i.status = 'pending'))::int as pending
     from profiles p
     left join auth_credentials c on c.user_id = p.id
     where p.role = 'teacher'`,
  );
  return rows[0] ?? { total: 0, active: 0, disabled: 0, activated: 0, pending: 0 };
}

