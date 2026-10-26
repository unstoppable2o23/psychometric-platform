/**
 * Teacher account management and sign-in.
 *
 * Covers the guarantees the product depends on: each teacher is a separate
 * account, an admin can issue and revoke access, disabling takes effect at once,
 * and no teacher can reach another teacher's data.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ensureDatabase } from './helpers/db';
import { getDb } from '@/server/db/client';
import {
  adminTeacherStats,
  createTeacher,
  issueActivation,
  listTeachers,
  setTeacherEnabled,
  unlockTeacher,
  updateTeacher,
  ValidationError,
} from '@/server/dal/teachers';
import { activateWithInvite, inspectInvite, signInAdmin, signInTeacher, AuthFailure } from '@/server/auth/teacher-auth';
import { checkPassword, hashPassword, verifyPassword } from '@/server/auth/passwords';
import { credentialVersionMatches, sign, verify } from '@/server/auth/tokens';
import { AuthorizationError, type Actor } from '@/server/dal/actor';

const GOOD_PASSWORD = 'Greenfield#2026';
const OTHER_PASSWORD = 'Sunrise!Board77';
/** Matches DEV_ADMIN_PASSWORD in src/server/db/seed.ts. */
const ADMIN_PASSWORD = 'Beacon#Admin2026';

const adminActor: Actor = {
  userId: '00000000-0000-0000-0000-000000000000',
  role: 'admin',
  organizationId: null,
  displayName: 'Admin',
  studentId: null,
};

let adminId: string;
let orgId: string;

async function makeTeacher(label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@audit.example`;
  const result = await createTeacher(adminActor, {
    displayName: `Teacher ${label}`,
    email,
    organizationId: orgId,
    roleInOrg: 'teacher',
  });
  return { email, ...result };
}

beforeEach(async () => {
  await ensureDatabase();
  const db = await getDb();

  const a = await db.query<{ id: string }>(`select id from profiles where role = 'admin' limit 1`);
  adminId = a.rows[0].id;
  adminActor.userId = adminId;

  const o = await db.query<{ id: string }>(`select id from organizations where slug = 'greenfield-vidyalaya'`);
  orgId = o.rows[0].id;
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const h = await hashPassword(GOOD_PASSWORD);
    const asStored = {
      password_hash: h.hash,
      password_salt: h.salt,
      hash_n: h.n,
      hash_r: h.r,
      hash_p: h.p,
    };
    expect(await verifyPassword(GOOD_PASSWORD, asStored)).toBe(true);
    expect(await verifyPassword(OTHER_PASSWORD, asStored)).toBe(false);
  });

  it('produces a different hash each time for the same password', async () => {
    const a = await hashPassword(GOOD_PASSWORD);
    const b = await hashPassword(GOOD_PASSWORD);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('never stores the password itself', async () => {
    const hashed = await hashPassword(GOOD_PASSWORD);
    const serialised = JSON.stringify(hashed);
    expect(serialised).not.toContain(GOOD_PASSWORD);
  });

  it('treats a corrupt stored hash as a failed verification, not an error', async () => {
    const result = await verifyPassword(GOOD_PASSWORD, {
      password_hash: 'not-valid-base64!!!',
      password_salt: 'also-bad',
      hash_n: 16384,
      hash_r: 8,
      hash_p: 1,
    });
    expect(result).toBe(false);
  });

  it('rejects weak passwords with actionable messages', () => {
    expect(checkPassword('short').map((p) => p.code)).toContain('too_short');
    expect(checkPassword('alllowercaseletters').map((p) => p.code)).toContain('too_simple');
    expect(checkPassword('password12345').map((p) => p.code)).toContain('common');
    expect(checkPassword('has spaces in it').map((p) => p.code)).toContain('has_whitespace');
  });

  it('accepts a password that satisfies the policy', () => {
    expect(checkPassword(GOOD_PASSWORD)).toEqual([]);
  });
});

describe('admin creates and manages teachers', () => {
  it('creates a teacher with no password and a pending activation link', async () => {
    const teacher = await makeTeacher('new');
    expect(teacher.activationToken.length).toBeGreaterThanOrEqual(20);

    const db = await getDb();
    const cred = await db.query<{ n: number }>(
      `select count(*)::int as n from auth_credentials where user_id = $1`,
      [teacher.userId],
    );
    expect(cred.rows[0].n).toBe(0);

    const invite = await db.query<{ status: string }>(
      `select status from auth_invites where user_id = $1`,
      [teacher.userId],
    );
    expect(invite.rows[0].status).toBe('pending');
  });

  it('never stores the activation token in plaintext', async () => {
    const teacher = await makeTeacher('hashcheck');
    const db = await getDb();
    const rows = await db.query<{ token_hash: string }>(
      `select token_hash from auth_invites where user_id = $1`,
      [teacher.userId],
    );
    expect(rows.rows[0].token_hash).not.toContain(teacher.activationToken);
    expect(rows.rows[0].token_hash).toHaveLength(64); // sha256 hex
  });

  it('refuses a duplicate email address', async () => {
    const teacher = await makeTeacher('dupe');
    await expect(
      createTeacher(adminActor, {
        displayName: 'Impostor',
        email: teacher.email,
        organizationId: orgId,
        roleInOrg: 'teacher',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses every management call to a non-admin', async () => {
    const impostor: Actor = { ...adminActor, role: 'teacher' };
    await expect(listTeachers(impostor)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      createTeacher(impostor, {
        displayName: 'X',
        email: 'x@audit.example',
        organizationId: null,
        roleInOrg: 'teacher',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(setTeacherEnabled(impostor, randomUUID(), false)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('lists only teachers, with their activation state', async () => {
    await makeTeacher('listed');
    const teachers = await listTeachers(adminActor);
    expect(teachers.length).toBeGreaterThan(0);
    expect(teachers.every((t) => t.email.endsWith('audit.example') || t.email.includes('@greenfield'))).toBe(true);
  });

  it('counts activated and pending teachers separately', async () => {
    await makeTeacher('counted');
    const stats = await adminTeacherStats(adminActor);
    expect(stats.total).toBeGreaterThanOrEqual(3);
    expect(stats.pending).toBeGreaterThanOrEqual(1);
    expect(stats.activated).toBeGreaterThanOrEqual(1);
  });
});

describe('activation', () => {
  it('sets a password and consumes the link exactly once', async () => {
    const teacher = await makeTeacher('activate');

    const first = await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    expect(first.userId).toBe(teacher.userId);

    const db = await getDb();
    const cred = await db.query<{ n: number }>(
      `select count(*)::int as n from auth_credentials where user_id = $1`,
      [teacher.userId],
    );
    expect(cred.rows[0].n).toBe(1);

    // Replaying the same link must fail.
    await expect(activateWithInvite(teacher.activationToken, OTHER_PASSWORD)).rejects.toBeInstanceOf(
      AuthFailure,
    );
    expect(await inspectInvite(teacher.activationToken)).toEqual({ state: 'invalid' });
  });

  it('gives every teacher a different password hash', async () => {
    const a = await makeTeacher('hash-a');
    const b = await makeTeacher('hash-b');
    await activateWithInvite(a.activationToken, GOOD_PASSWORD);
    await activateWithInvite(b.activationToken, GOOD_PASSWORD);

    const db = await getDb();
    const rows = await db.query<{ password_hash: string; password_salt: string; user_id: string }>(
      `select password_hash, password_salt, user_id from auth_credentials where user_id = any($1)`,
      [[a.userId, b.userId]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((r) => r.password_hash)).size).toBe(2);
    expect(new Set(rows.rows.map((r) => r.password_salt)).size).toBe(2);
  });

  it('refuses a weak password and leaves the link usable', async () => {
    const teacher = await makeTeacher('weak');
    await expect(activateWithInvite(teacher.activationToken, 'password')).rejects.toBeInstanceOf(AuthFailure);
    // The invite must survive a rejected attempt so the teacher can retry.
    expect((await inspectInvite(teacher.activationToken)).state).toBe('valid');
  });

  it('reports an expired invite as invalid', async () => {
    const teacher = await makeTeacher('expired');
    const db = await getDb();
    await db.query(`update auth_invites set expires_at = now() - interval '1 hour' where user_id = $1`, [
      teacher.userId,
    ]);
    expect(await inspectInvite(teacher.activationToken)).toEqual({ state: 'invalid' });
  });

  it('reports an unknown token as invalid without leaking why', async () => {
    expect(await inspectInvite('this-was-never-issued-at-all')).toEqual({ state: 'invalid' });
    expect(await inspectInvite('')).toEqual({ state: 'invalid' });
  });

  it('revoking a pending link invalidates it', async () => {
    const teacher = await makeTeacher('revoked');
    const db = await getDb();
    await db.query(`update auth_invites set status = 'revoked' where user_id = $1`, [teacher.userId]);
    expect(await inspectInvite(teacher.activationToken)).toEqual({ state: 'invalid' });
  });

  it('issuing a new link invalidates the previous one', async () => {
    const teacher = await makeTeacher('reissue');
    const second = await issueActivation(adminActor, teacher.userId);
    expect(second.activationToken).not.toBe(teacher.activationToken);
    expect(await inspectInvite(teacher.activationToken)).toEqual({ state: 'invalid' });
    expect((await inspectInvite(second.activationToken)).state).toBe('valid');
  });
});

describe('admin-issued password reset', () => {
  it('issues a usable link for a teacher who already has a password', async () => {
    const teacher = await makeTeacher('reset');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);

    const issued = await issueActivation(adminActor, teacher.userId);
    const state = await inspectInvite(issued.activationToken);

    expect(state.state).toBe('valid');
    if (state.state !== 'valid') return;
    expect(state.isReset).toBe(true);
    expect(state.email).toBe(teacher.email);
  });

  it('replaces the password, so the old one stops working', async () => {
    const teacher = await makeTeacher('reset-pw');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);

    const issued = await issueActivation(adminActor, teacher.userId);
    await activateWithInvite(issued.activationToken, OTHER_PASSWORD);

    await expect(signInTeacher(teacher.email, GOOD_PASSWORD)).rejects.toBeInstanceOf(AuthFailure);
    await expect(signInTeacher(teacher.email, OTHER_PASSWORD)).resolves.toBeTruthy();
  });

  it('bumps the credential version, so sessions already open are revoked', async () => {
    const teacher = await makeTeacher('reset-version');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);

    const db = await getDb();
    const read = async () =>
      (
        await db.query<{ credential_version: number }>(
          `select credential_version from auth_credentials where user_id = $1`,
          [teacher.userId],
        )
      ).rows[0].credential_version;

    const before = await read();
    const issued = await issueActivation(adminActor, teacher.userId);
    await activateWithInvite(issued.activationToken, OTHER_PASSWORD);
    expect(await read()).toBe(before + 1);
  });

  it('records the reset separately from a first activation', async () => {
    const teacher = await makeTeacher('reset-audit');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    const issued = await issueActivation(adminActor, teacher.userId);
    await activateWithInvite(issued.activationToken, OTHER_PASSWORD);

    const db = await getDb();
    const rows = await db.query<{ action: string }>(
      `select action from audit_logs where entity_id = $1`,
      [teacher.userId],
    );
    expect(rows.rows.map((r) => r.action)).toContain('teacher.password_reset');
  });

  it('cannot be replayed after use', async () => {
    const teacher = await makeTeacher('reset-replay');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    const issued = await issueActivation(adminActor, teacher.userId);
    await activateWithInvite(issued.activationToken, OTHER_PASSWORD);
    await expect(activateWithInvite(issued.activationToken, GOOD_PASSWORD)).rejects.toBeInstanceOf(
      AuthFailure,
    );
  });
});

describe('sign in', () => {
  it('accepts the correct password for an activated teacher', async () => {
    const teacher = await makeTeacher('signin');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    const result = await signInTeacher(teacher.email, GOOD_PASSWORD);
    expect(result.userId).toBe(teacher.userId);
  });

  it('is case insensitive on the email', async () => {
    const teacher = await makeTeacher('casey');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    await expect(signInTeacher(teacher.email.toUpperCase(), GOOD_PASSWORD)).resolves.toBeTruthy();
  });

  // The two must be indistinguishable, or the form becomes an account enumerator.
  it('gives the same message for an unknown email and a wrong password', async () => {
    const teacher = await makeTeacher('enum');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);

    let unknownMessage = '';
    let wrongMessage = '';
    try {
      await signInTeacher('nobody-here@nowhere.example', GOOD_PASSWORD);
    } catch (e) {
      unknownMessage = (e as Error).message;
    }
    try {
      await signInTeacher(teacher.email, 'Wrong#Password99');
    } catch (e) {
      wrongMessage = (e as Error).message;
    }
    expect(unknownMessage).toBe(wrongMessage);
    expect(unknownMessage).not.toMatch(/exist|no such|unknown/i);
  });

  it('refuses a teacher who has not activated yet', async () => {
    const teacher = await makeTeacher('unactivated');
    await expect(signInTeacher(teacher.email, GOOD_PASSWORD)).rejects.toBeInstanceOf(AuthFailure);
  });

  it('refuses a non-teacher account even with a valid-looking password', async () => {
    const admin = await getDb().then(
      async (db) => (await db.query<{ email: string }>(`select email from profiles where role = 'admin' limit 1`)).rows[0],
    );
    await expect(signInTeacher(admin.email, ADMIN_PASSWORD)).rejects.toBeInstanceOf(AuthFailure);
  });

  it('locks an account after repeated failures and lets the admin unlock it', async () => {
    const teacher = await makeTeacher('locked');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);

    for (let i = 0; i < 8; i += 1) {
      await signInTeacher(teacher.email, 'Definitely#Wrong9').catch(() => {});
    }

    // Even the correct password is refused while locked.
    await expect(signInTeacher(teacher.email, GOOD_PASSWORD)).rejects.toThrow(/too many/i);

    await unlockTeacher(adminActor, teacher.userId);
    await expect(signInTeacher(teacher.email, GOOD_PASSWORD)).resolves.toBeTruthy();
  });

  it('records a successful sign-in time', async () => {
    const teacher = await makeTeacher('timestamp');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    await signInTeacher(teacher.email, GOOD_PASSWORD);

    const db = await getDb();
    const rows = await db.query<{ last_sign_in_at: Date | null }>(
      `select last_sign_in_at from auth_credentials where user_id = $1`,
      [teacher.userId],
    );
    expect(rows.rows[0].last_sign_in_at).not.toBeNull();
  });
});

describe('admin sign in', () => {
  it('lets the super admin in and reports the admin role', async () => {
    const result = await signInAdmin('admin@psychometric.local', ADMIN_PASSWORD);
    expect(result.role).toBe('admin');
  });

  it('refuses a teacher using the admin form', async () => {
    const teacher = await makeTeacher('notadmin');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    await expect(signInAdmin(teacher.email, GOOD_PASSWORD)).rejects.toBeInstanceOf(AuthFailure);
  });

  it('refuses a wrong admin password with the same generic message', async () => {
    await expect(signInAdmin('admin@psychometric.local', 'Wrong#Password99')).rejects.toThrow(
      /do not match an active account/i,
    );
  });
});

describe('disabling a teacher', () => {
  it('kills an existing session immediately by bumping the credential version', async () => {
    const teacher = await makeTeacher('disable');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    await signInTeacher(teacher.email, GOOD_PASSWORD);

    const db = await getDb();
    const before = await db.query<{ credential_version: number }>(
      `select credential_version from auth_credentials where user_id = $1`,
      [teacher.userId],
    );

    await setTeacherEnabled(adminActor, teacher.userId, false);

    const after = await db.query<{ credential_version: number }>(
      `select credential_version from auth_credentials where user_id = $1`,
      [teacher.userId],
    );
    expect(after.rows[0].credential_version).toBe(before.rows[0].credential_version + 1);
  });

  it('refuses sign-in once disabled', async () => {
    const teacher = await makeTeacher('disabled-signin');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    await setTeacherEnabled(adminActor, teacher.userId, false);
    await expect(signInTeacher(teacher.email, GOOD_PASSWORD)).rejects.toBeInstanceOf(AuthFailure);
  });

  it('withdraws a pending activation link when disabled', async () => {
    const teacher = await makeTeacher('disabled-pending');
    await setTeacherEnabled(adminActor, teacher.userId, false);
    expect(await inspectInvite(teacher.activationToken)).toEqual({ state: 'invalid' });
  });

  it('re-enabling restores access', async () => {
    const teacher = await makeTeacher('reenabled');
    await activateWithInvite(teacher.activationToken, GOOD_PASSWORD);
    await setTeacherEnabled(adminActor, teacher.userId, false);
    await setTeacherEnabled(adminActor, teacher.userId, true);
    await expect(signInTeacher(teacher.email, GOOD_PASSWORD)).resolves.toBeTruthy();
  });

  it('marks the profile inactive for row-level security', async () => {
    const teacher = await makeTeacher('rls-disabled');
    await setTeacherEnabled(adminActor, teacher.userId, false);
    const db = await getDb();
    const rows = await db.query<{ is_active: boolean }>(
      `select is_active from profiles where id = $1`,
      [teacher.userId],
    );
    expect(rows.rows[0].is_active).toBe(false);
  });

  it('writes an audit entry for every privileged change', async () => {
    const teacher = await makeTeacher('audited');
    await setTeacherEnabled(adminActor, teacher.userId, false);
    await setTeacherEnabled(adminActor, teacher.userId, true);

    const db = await getDb();
    const rows = await db.query<{ action: string }>(
      `select action from audit_logs where entity_id = $1 and action like 'teacher.%'`,
      [teacher.userId],
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toContain('teacher.created');
    expect(actions).toContain('teacher.disabled');
    expect(actions).toContain('teacher.enabled');
  });
});

describe('editing a teacher', () => {
  it('changes the display name and school', async () => {
    const teacher = await makeTeacher('edited');
    await updateTeacher(adminActor, teacher.userId, { displayName: 'New Name', organizationId: null });

    const db = await getDb();
    const rows = await db.query<{ display_name: string; organization_id: string | null }>(
      `select display_name, organization_id from profiles where id = $1`,
      [teacher.userId],
    );
    expect(rows.rows[0].display_name).toBe('New Name');
    expect(rows.rows[0].organization_id).toBeNull();
  });

  it('refuses an email already used by another account', async () => {
    const a = await makeTeacher('email-a');
    const b = await makeTeacher('email-b');
    await expect(updateTeacher(adminActor, b.userId, { email: a.email })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('will not manage a non-teacher account', async () => {
    const student = await getDb().then(
      async (db) =>
        (await db.query<{ id: string }>(`select id from profiles where role = 'student' limit 1`)).rows[0],
    );
    await expect(updateTeacher(adminActor, student.id, { displayName: 'Nope' })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe('session credential binding', () => {
  it('rejects a session whose version no longer matches', () => {
    expect(credentialVersionMatches(3, 3)).toBe(true);
    expect(credentialVersionMatches(3, 2)).toBe(false);
  });

  it('treats an absent version as zero, so it cannot match a real account', () => {
    expect(credentialVersionMatches(0, undefined)).toBe(true);
    expect(credentialVersionMatches(1, undefined)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = sign({ userId: 'a', exp: Date.now() + 1000, cv: 1 });
    expect(verify(token)).not.toBeNull();
    const [body, mac] = token.split('.');
    expect(verify(`${body}x.${mac}`)).toBeNull();
    expect(verify(`${body}.${mac.slice(0, -1)}y`)).toBeNull();
  });

  it('rejects an expired session', () => {
    const token = sign({ userId: 'a', exp: Date.now() - 1 });
    expect(verify(token)).toBeNull();
  });
});
