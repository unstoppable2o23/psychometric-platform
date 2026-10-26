/**
 * Auth-user provisioning.
 *
 * `profiles.id` is a foreign key to `auth.users.id`, so a teacher account cannot
 * exist until the matching auth user does.
 *
 * HOW THIS DEPLOYS
 * ----------------
 * Locally (and on any Postgres where the app role may write the `auth` schema)
 * the row is inserted directly, which is what the dev shim in
 * db/dev/auth-shim.sql provides for.
 *
 * On Supabase the app role cannot write `auth.users`; rows there are owned by
 * GoTrue. Replace the body of `provisionAuthUser` with the admin API call:
 *
 *   import { createClient } from '@supabase/supabase-js'
 *   const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } })
 *   await supabase.auth.admin.createUser({
 *     id: userId, email, email_confirm: true,
 *   })
 *
 * `generateAuthUserId()` below must keep matching whatever id the identity
 * provider assigns, since `profiles.id` mirrors it.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';

export function generateAuthUserId(): string {
  return randomUUID();
}

/**
 * Ensures an auth user exists for this id and email. Idempotent, so a retry
 * after a partial failure does not collide.
 *
 * Takes the `Db` handle rather than calling `getDb()` itself: with the embedded
 * PGlite driver there is a single connection, so a query issued on the root
 * handle while a transaction is open would wait on that transaction forever.
 * The caller passes whichever handle is already in scope.
 */
export async function provisionAuthUser(db: Db, userId: string, email: string): Promise<void> {
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at)
     values ($1, $2, now())
     on conflict (id) do update set email = excluded.email`,
    [userId, email],
  );
}
