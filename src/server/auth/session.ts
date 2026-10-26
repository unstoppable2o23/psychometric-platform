/**
 * Cookie plumbing for the session cookie.
 *
 * The only module here that touches Next request APIs. All cryptography lives in
 * tokens.ts so it stays usable from scripts and tests.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { env, isProduction } from '../env';
import { credentialVersionMatches, createSessionToken, verify, type SessionPayload } from './tokens';
import { query } from '../db/client';

export {
  createSessionToken,
  credentialVersionMatches,
  generateAssessmentToken,
  hashToken,
  newReference,
  NO_CREDENTIAL_VERSION,
  tokenHint,
} from './tokens';

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verify<SessionPayload>(store.get(env.SESSION_COOKIE_NAME)?.value);
}

export async function getSessionUserId(): Promise<string | null> {
  return (await getSession())?.userId ?? null;
}

/**
 * Resolves the session user id, checking that the account still exists, is
 * active, and has not had its credentials revoked since the cookie was issued.
 *
 * This is the live-kill switch behind "disabled by the super admin": the cookie
 * itself remains cryptographically valid, but it stops resolving the moment the
 * account is disabled.
 */
export async function getActiveSessionUserId(): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;

  // Admin sessions have no credentials row and bypass the version check.
  if (session.privileged) return session.userId;

  const rows = await query<{ is_active: boolean; credential_version: number }>(
    `select p.is_active, coalesce(c.credential_version, 0) as credential_version
       from profiles p
       left join auth_credentials c on c.user_id = p.id
      where p.id = $1`,
    [session.userId],
  );

  const row = rows[0];
  if (!row || !row.is_active) return null;
  if (!credentialVersionMatches(row.credential_version, session.cv)) return null;

  return session.userId;
}

export async function setSessionCookie(userId: string, options?: { privileged?: boolean }): Promise<void> {
  // Read the current credential version so the cookie is bound to it.
  let version = 0;
  if (!options?.privileged) {
    const rows = await query<{ credential_version: number }>(
      `select credential_version from auth_credentials where user_id = $1`,
      [userId],
    );
    version = rows[0]?.credential_version ?? 0;
  }

  const store = await cookies();
  store.set(
    env.SESSION_COOKIE_NAME,
    createSessionToken(userId, { privileged: options?.privileged, credentialVersion: version }),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      path: '/',
      maxAge: env.SESSION_TTL_HOURS * 3600,
    },
  );
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(env.SESSION_COOKIE_NAME);
}
