/**
 * Cryptographic token primitives.
 *
 * Kept free of `server-only`, `next/headers`, and any Next import so that seed
 * scripts, the migration runner, and unit tests can use them directly. Only the
 * cookie plumbing in session.ts touches Next APIs.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

/* -------------------------------------------------------------------------- */
/* Signed payloads (session cookies)                                           */
/* -------------------------------------------------------------------------- */

export function signingKey(): string {
  const secret = env.AUTH_SECRET;
  if (secret) return secret;
  if (env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET must be configured in production');
  }
  // Deterministic dev fallback so sessions survive a dev-server restart.
  return 'dev-only-insecure-key-do-not-use-in-production';
}

const b64url = (input: Buffer): string => input.toString('base64url');

export function sign(payload: Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const mac = createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify<T>(token: string | undefined | null): T | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;

  const expected = createHmac('sha256', signingKey()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: number };
    if (typeof parsed.exp === 'number' && Date.now() > parsed.exp) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export interface SessionPayload {
  userId: string;
  /** Epoch milliseconds. */
  exp: number;
  /**
   * Version of the account's credentials when this session was issued.
   *
   * Disabling an account bumps the version, so cookies minted beforehand stop
   * validating. Without this, disabling a teacher would only take effect at their
   * next sign-in rather than immediately.
   */
  cv?: number;
  /** True for a privileged session that bypasses the credential check. */
  privileged?: boolean;
}

/**
 * A privileged session has no credentials row and no meaningful version.
 * `Number(undefined)` is NaN, so it is normalised to 0 for comparison.
 */
export const NO_CREDENTIAL_VERSION = 0;

export function credentialVersionMatches(expected: number, actual: number | undefined): boolean {
  return (actual ?? NO_CREDENTIAL_VERSION) === expected;
}

export function createSessionToken(
  userId: string,
  options: { credentialVersion?: number; privileged?: boolean; ttlHours?: number } = {},
): string {
  const ttlHours = options.ttlHours ?? env.SESSION_TTL_HOURS;
  return sign({
    userId,
    exp: Date.now() + ttlHours * 3600_000,
    cv: options.credentialVersion ?? NO_CREDENTIAL_VERSION,
    ...(options.privileged ? { privileged: true } : {}),
  } satisfies SessionPayload);
}

/* -------------------------------------------------------------------------- */
/* Assessment tokens                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 32 bytes of CSPRNG output, base64url. Roughly 256 bits of entropy, so tokens
 * are not enumerable and a leaked hash cannot be brute-forced.
 */
export function generateAssessmentToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is persisted; lookups are by hash, so a leak is not a breach. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Last four characters, shown to teachers so they can tell links apart. */
export function tokenHint(token: string): string {
  return token.slice(-4);
}

export function newReference(prefix: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}
