/**
 * Shared test harness: one migrated and seeded database for the whole run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

process.env.PGLITE_DATA_DIR ??= '.pglite-test';

let ready: Promise<void> | null = null;

export const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

/** Applies the auth shim and every migration, then seeds. Idempotent. */
export function ensureDatabase(): Promise<void> {
  ready ??= (async () => {
    const { getDb } = await import('@/server/db/client');
    const db = await getDb();

    const shim = readFileSync(path.join(process.cwd(), 'db', 'dev', 'auth-shim.sql'), 'utf8');
    await db.exec(shim);

    // The bookkeeping table lives in the `app` schema, which 0001 creates, so it
    // has to be created before we can ask what has already been applied.
    await db.exec(`
      create schema if not exists app;
      create table if not exists app.schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const filename of files) {
      const { rows } = await db.query<{ n: number }>(
        'select count(*)::int as n from app.schema_migrations where filename = $1',
        [filename],
      );
      if ((rows[0]?.n ?? 0) > 0) continue;
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
      await db.query('insert into app.schema_migrations (filename) values ($1)', [filename]);
    }

    const { seed } = await import('@/server/db/seed');
    await seed();
  })();
  return ready;
}

/** The token the seed wrote, so tests can open the assignment link. */
export function seedToken(): string {
  const value = process.env.SEED_ASSIGNMENT_TOKEN;
  if (!value) throw new Error('Set SEED_ASSIGNMENT_TOKEN before ensureDatabase() runs');
  return value;
}

export const TEST_TOKEN = 'test-assessment-token-do-not-use-elsewhere';

process.env.SEED_ASSIGNMENT_TOKEN = TEST_TOKEN;
