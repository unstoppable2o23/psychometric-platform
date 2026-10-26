/**
 * Password hashing.
 *
 * scrypt from Node's crypto, with a per-user random salt. Deliberately not a
 * third-party dependency: the primitives needed are in the standard library and
 * a native bcrypt/argon2 module is one more thing to keep patched.
 *
 * Costs are stored per row so they can be raised later without invalidating
 * anyone's existing password.
 */
import 'server-only';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../lib/password-policy';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** ~64MB of memory per hash. Sized so it is painful but not hostile to a school VPS. */
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

/** scrypt needs roughly 128 * N * r bytes; give it headroom or it throws. */
const MAXMEM = 256 * SCRYPT.N * SCRYPT.r;

export interface PasswordHash {
  hash: string;
  salt: string;
  n: number;
  r: number;
  p: number;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16).toString('base64');
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: MAXMEM,
  });

  return {
    hash: derived.toString('base64'),
    salt,
    n: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  };
}

/**
 * Verifies a candidate password against a stored hash.
 *
 * Returns false rather than throwing on a malformed row, because a corrupt
 * credential must read as "wrong password", never as an error that leaks
 * whether the account exists. Comparison is constant-time.
 */
export async function verifyPassword(
  password: string,
  stored: { password_hash: string; password_salt: string; hash_n: number; hash_r: number; hash_p: number },
): Promise<boolean> {
  try {
    const derived = await scrypt(password.normalize('NFKC'), stored.password_salt, SCRYPT.keylen, {
      N: stored.hash_n,
      r: stored.hash_r,
      p: stored.hash_p,
      maxmem: Math.max(MAXMEM, 256 * stored.hash_n * stored.hash_r),
    });

    const expected = Buffer.from(stored.password_hash, 'base64');
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

// Defined in a plain module so Client Components can import them too; this file
// is `server-only`.
export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH };
export interface PasswordProblem {
  code: string;
  message: string;
}

/**
 * Deliberately modest. A composition rule pushes people towards predictable
 * substitutions (`Password1!`), so the requirements are length, a character
 * spread, and rejection of the handful of passwords that appear first in any
 * breach corpus.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'password12345',
  'passw0rd', 'p@ssw0rd', 'p@ssword', 'p@ssword1',
  '12345678', '123456789', '1234567890', '12345678a', '123456789a',
  'qwertyuiop', 'qwerty123', 'letmein12', 'welcome123', 'admin123', 'administrator',
  'iloveyou1', 'teacher123', 'school123', 'changeme', 'changeme123', 'abcd1234',
  'sunshine1', 'football1', 'baseball1', 'princess1', 'trustno1',
]);

export function checkPassword(password: string): PasswordProblem[] {
  const problems: PasswordProblem[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push({
      code: 'too_short',
      message: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
    });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push({ code: 'too_long', message: 'That password is too long.' });
  }
  if (/\s/.test(password)) {
    problems.push({ code: 'has_whitespace', message: 'Remove spaces and tabs.' });
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    problems.push({
      code: 'too_simple',
      message: 'Mix at least three of: lowercase, uppercase, numbers, symbols.',
    });
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push({
      code: 'common',
      message: 'That password appears in every leaked-password list. Choose something else.',
    });
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Activation tokens                                                          */
/* -------------------------------------------------------------------------- */

/** 24 bytes is ample for a 48-hour, single-use, revocable token. */
export function generateInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function inviteHint(token: string): string {
  return token.slice(-4);
}
