/**
 * Prints a signed session cookie for a seeded account, so an HTTP smoke test can
 * reach authenticated pages. Development only; it reads the same secret and
 * token format the app uses.
 */
import { createSessionToken } from '../src/server/auth/tokens';
import { getDb } from '../src/server/db/client';

const email = process.argv[2];
if (!email) throw new Error('usage: print-session <email>');

const db = await getDb();
const rows = await db.query<{ id: string; credential_version: number | null }>(
  `select p.id, c.credential_version
     from profiles p left join auth_credentials c on c.user_id = p.id
    where lower(p.email) = lower($1)`,
  [email],
);
const row = rows.rows[0];
if (!row) throw new Error(`no account for ${email}`);

process.stdout.write(createSessionToken(row.id, { credentialVersion: row.credential_version ?? 0 }));
await db.close();
