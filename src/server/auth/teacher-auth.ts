/**
 * Teacher sign-in and account activation.
 *
 * Activation: an admin issues a single-use link; the teacher sets their own
 * password, so no admin ever handles or stores a teacher's plaintext password.
 *
 * Sign-in failures are deliberately indistinguishable to the caller. An unknown
 * email and a wrong password take the same path and produce the same message, so
 * the form cannot be used to enumerate which teachers exist.
 */
import 'server-only';
import { getDb } from '../db/client';
import {
  checkPassword,
  hashInviteToken,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  verifyPassword,
} from '../auth/passwords';

const GENERIC_FAILURE = 'That email address and password do not match an active account.';

/**
 * A hash to verify against when no account matched.
 *
 * Computed once per process. It exists only so the failure path costs the same
 * as a real verification; nothing ever authenticates against it.
 */
let dummyHash: Promise<{ password_hash: string; password_salt: string; hash_n: number; hash_r: number; hash_p: number }> | null =
  null;

function dummyCredential() {
  dummyHash ??= hashPassword('timing-equalisation-placeholder').then((h) => ({
    password_hash: h.hash,
    password_salt: h.salt,
    hash_n: h.n,
    hash_r: h.r,
    hash_p: h.p,
  }));
  return dummyHash;
}

/** Failures after this many, for this long. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

export class AuthFailure extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'AuthFailure';
  }
}

/* -------------------------------------------------------------------------- */
/* Activation                                                                 */
/* -------------------------------------------------------------------------- */

export type InviteState =
  | {
      state: 'valid';
      userId: string;
      displayName: string;
      email: string;
      expiresAt: Date;
      /**
       * True when the account already has a password, i.e. this link is an
       * admin-issued reset rather than a first activation. Copy only; both
       * paths set the password the same way.
       */
      isReset: boolean;
    }
  | { state: 'invalid' };

/** Inspects an activation link without redeeming it. */
export async function inspectInvite(token: string): Promise<InviteState> {
  if (!token || token.length < 16) return { state: 'invalid' };

  const db = await getDb();
  const row = (
    await db.query<{
      user_id: string;
      display_name: string | null;
      email: string | null;
      expires_at: Date;
      status: string;
      is_active: boolean;
      already_has_password: boolean;
    }>(
      `select i.user_id, p.display_name, p.email, i.expires_at, i.status, p.is_active,
              (c.user_id is not null) as already_has_password
         from auth_invites i
         join profiles p on p.id = i.user_id
         left join auth_credentials c on c.user_id = p.id
        where i.token_hash = $1`,
      [hashInviteToken(token)],
    )
  ).rows[0];

  // A used, revoked, missing, expired or disabled link is all reported
  // identically, so the form cannot distinguish the cases. An account that
  // already has a password is *not* a failure: admins issue the same kind of
  // link to reset one.
  if (
    !row ||
    row.status !== 'pending' ||
    !row.is_active ||
    row.expires_at.getTime() <= Date.now()
  ) {
    return { state: 'invalid' };
  }

  return {
    state: 'valid',
    userId: row.user_id,
    displayName: row.display_name ?? 'Teacher',
    email: row.email ?? '',
    expiresAt: row.expires_at,
    isReset: row.already_has_password,
  };
}

/**
 * Redeems an invite link and sets the teacher's password.
 *
 * Used both for first activation and for an admin-issued reset. Returns the user
 * id on success so the caller can start a session. The invite is marked redeemed
 * in the same transaction as the credential is written, so a replayed link finds
 * nothing pending.
 */
export async function activateWithInvite(
  token: string,
  password: string,
): Promise<{ userId: string }> {
  const problems = checkPassword(password);
  if (problems.length > 0) {
    throw new AuthFailure(problems[0].message);
  }

  const state = await inspectInvite(token);
  if (state.state !== 'valid') {
    throw new AuthFailure('That activation link is no longer valid. Ask your administrator for a new one.');
  }

  const hashed = await hashPassword(password);
  const db = await getDb();

  return db.tx(async (tx) => {
    // Claim the invite first. If two requests race, only one UPDATE matches.
    const claimed = await tx.query<{ user_id: string }>(
      `update auth_invites
          set status = 'redeemed', redeemed_at = now()
        where token_hash = $1 and status = 'pending' and expires_at > now()
        returning user_id`,
      [hashInviteToken(token)],
    );

    if (!claimed.rows[0]) {
      throw new AuthFailure('That activation link has already been used.');
    }

    const existing = await tx.query<{ present: boolean }>(
      `select true as present from auth_credentials where user_id = $1`,
      [state.userId],
    );
    const isReset = existing.rows.length > 0;

    await tx.query(
      `insert into auth_credentials (user_id, password_hash, password_salt, hash_n, hash_r, hash_p)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id) do update
         set password_hash = excluded.password_hash,
             password_salt = excluded.password_salt,
             hash_n = excluded.hash_n,
             hash_r = excluded.hash_r,
             hash_p = excluded.hash_p,
             failed_attempts = 0,
             locked_until = null,
             -- A reset must invalidate sessions that are already signed in.
             credential_version = auth_credentials.credential_version + 1`,
      [state.userId, hashed.hash, hashed.salt, hashed.n, hashed.r, hashed.p],
    );

    await tx.query(
      `insert into audit_logs (actor_id, actor_role, action, entity_type, entity_id)
       values ($1::uuid, 'teacher', $2, 'profile', $1::text)`,
      [state.userId, isReset ? 'teacher.password_reset' : 'teacher.activated'],
    );

    return { userId: state.userId };
  });
}

/* -------------------------------------------------------------------------- */
/* Sign-in                                                                    */
/* -------------------------------------------------------------------------- */

export interface SignInResult {
  userId: string;
  role: 'admin' | 'teacher';
}

/**
 * Verifies an email and password for any staff account.
 *
 * Returns the user id and role on success; the caller is responsible for
 * starting the session. Keeping cookie writes out of here lets the same code run
 * from a test or a script, where there is no request to attach a cookie to.
 *
 * On failure the caller's response is always the same generic message. The
 * account lockout is a side effect that stops a sustained guessing attempt
 * against one account, and is reset by the admin if it trips by accident.
 */
export async function signInStaff(email: string, password: string): Promise<SignInResult> {
  const normalised = email.trim().toLowerCase();
  const db = await getDb();

  // Cap the input length so an oversized value cannot be used to burn CPU in
  // scrypt before it is rejected.
  const candidate = password.slice(0, PASSWORD_MAX_LENGTH);

  const row = (
    await db.query<{
      id: string;
      is_active: boolean;
      role: 'admin' | 'teacher';
      password_hash: string | null;
      password_salt: string | null;
      hash_n: number | null;
      hash_r: number | null;
      hash_p: number | null;
      failed_attempts: number;
      locked_until: Date | null;
    }>(
      `select p.id, p.is_active, p.role,
              c.password_hash, c.password_salt, c.hash_n, c.hash_r, c.hash_p,
              c.failed_attempts, c.locked_until
         from profiles p
         left join auth_credentials c on c.user_id = p.id
        where lower(p.email) = $1 and p.role in ('admin', 'teacher')`,
      [normalised],
    )
  ).rows[0];

  // Locked accounts are refused before any hashing work. The lockout message is
  // deliberately specific, so returning early here reveals nothing new.
  if (row?.locked_until && row.locked_until.getTime() > Date.now()) {
    throw new AuthFailure(
      `Too many failed attempts. Try again after ${new Date(row.locked_until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.`,
    );
  }

  // Always spend exactly one scrypt verification, even when no account matches.
  // Skipping it for unknown emails made sign-in measurably faster, which turns
  // response time into an account-existence oracle.
  const stored =
    row?.password_hash && row.password_salt
      ? {
          password_hash: row.password_hash,
          password_salt: row.password_salt,
          hash_n: row.hash_n ?? 16384,
          hash_r: row.hash_r ?? 8,
          hash_p: row.hash_p ?? 1,
        }
      : await dummyCredential();

  const ok = await verifyPassword(candidate, stored);

  // Uniform failure path: no distinguishing message.
  if (!row || !row.is_active || !row.password_hash || !ok) {
    await recordFailure(db, row?.id ?? null);
    throw new AuthFailure(GENERIC_FAILURE);
  }

  if (!ok) {
    await recordFailure(db, row.id);
    throw new AuthFailure(GENERIC_FAILURE);
  }

  await db.query(
    `update auth_credentials
        set failed_attempts = 0, locked_until = null, last_sign_in_at = now()
      where user_id = $1`,
    [row.id],
  );

  await db.query(
    `update profiles set last_login_at = now() where id = $1`,
    [row.id],
  );

  await db.query(
    `insert into audit_logs (actor_id, actor_role, action, entity_type, entity_id)
     values ($1::uuid, $2::app.user_role, 'staff.sign_in', 'profile', $1::text)`,
    [row.id, row.role],
  );

  return { userId: row.id, role: row.role };
}

/** Teacher-only sign-in, for callers that must not accept an admin account. */
export async function signInTeacher(email: string, password: string): Promise<SignInResult> {
  const result = await signInStaff(email, password);
  if (result.role !== 'teacher') throw new AuthFailure(GENERIC_FAILURE);
  return result;
}

/** Admin-only sign-in. */
export async function signInAdmin(email: string, password: string): Promise<SignInResult> {
  const result = await signInStaff(email, password);
  if (result.role !== 'admin') throw new AuthFailure(GENERIC_FAILURE);
  return result;
}

async function recordFailure(db: Awaited<ReturnType<typeof getDb>>, userId: string | null): Promise<void> {
  if (!userId) return;
  const updated = await db.query<{ failed_attempts: number }>(
    `update auth_credentials
        set failed_attempts = failed_attempts + 1,
            locked_until = case
              when failed_attempts + 1 >= $2 then now() + ($3 || ' minutes')::interval
              else locked_until end
      where user_id = $1
      returning failed_attempts`,
    [userId, MAX_FAILED_ATTEMPTS, String(LOCKOUT_MINUTES)],
  );
  void updated;
}

/* -------------------------------------------------------------------------- */
/* Password change                                                             */
/* -------------------------------------------------------------------------- */

export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ credentialVersion: number }> {
  const db = await getDb();
  const row = (
    await db.query<{
      password_hash: string;
      password_salt: string;
      hash_n: number;
      hash_r: number;
      hash_p: number;
    }>(
      `select password_hash, password_salt, hash_n, hash_r, hash_p
         from auth_credentials where user_id = $1`,
      [userId],
    )
  ).rows[0];

  if (!row) throw new AuthFailure('No password is set for this account.');

  const ok = await verifyPassword(currentPassword.slice(0, PASSWORD_MAX_LENGTH), row);
  if (!ok) throw new AuthFailure('Your current password is not correct.');

  const problems = checkPassword(newPassword);
  if (problems.length > 0) throw new AuthFailure(problems[0].message);

  if (await verifyPassword(newPassword.slice(0, PASSWORD_MAX_LENGTH), row)) {
    throw new AuthFailure('Choose a password you have not used here before.');
  }

  const hashed = await hashPassword(newPassword);
  const updated = await db.query<{ credential_version: number }>(
    `update auth_credentials
        set password_hash = $2, password_salt = $3, hash_n = $4, hash_r = $5, hash_p = $6,
            credential_version = credential_version + 1,
            failed_attempts = 0, locked_until = null
      where user_id = $1
      returning credential_version`,
    [userId, hashed.hash, hashed.salt, hashed.n, hashed.r, hashed.p],
  );

  await db.query(
    `insert into audit_logs (actor_id, actor_role, action, entity_type, entity_id)
     values ($1::uuid, 'teacher', 'teacher.password_changed', 'profile', $1::text)`,
    [userId],
  );

  // The caller re-issues the session cookie with this version; other devices
  // holding the old one stop resolving immediately.
  return { credentialVersion: updated.rows[0].credential_version };
}

export const POLICY = { MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES };
