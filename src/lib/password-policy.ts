/**
 * Password policy constants.
 *
 * Shared by the server (validation) and the client (hints under the field).
 * Deliberately not in `server/auth/passwords.ts`, which is `server-only` and
 * cannot be imported by a Client Component, and not in a `"use server"` module,
 * which may only export async functions.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

export const PASSWORD_RULES = {
  minLength: PASSWORD_MIN_LENGTH,
  maxLength: PASSWORD_MAX_LENGTH,
} as const;
