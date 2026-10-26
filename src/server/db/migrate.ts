/**
 * Migration runner.
 *
 *   npm run db:migrate          apply pending migrations
 *   npm run db:migrate -- --reset   drop the local PGlite store and reapply
 *   npm run db:status           show what is applied
 *
 * Production migrations run through Supabase's own migration pipeline
 * (`supabase db push`); this runner is the local/CI equivalent and reads the
 * same files from db/migrations.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDb, type Db } from './client';
import { env, usesLocalDatabase } from '../env';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const AUTH_SHIM = path.join(process.cwd(), 'db', 'dev', 'auth-shim.sql');

async function ensureMigrationsTable(db: Db): Promise<void> {
  // The `app` schema is created by 0001_foundation, so it has to exist before
  // the bookkeeping table can live inside it.
  await db.exec(`
    create schema if not exists app;
    create table if not exists app.schema_migrations (
      filename    text primary key,
      applied_at  timestamptz not null default now()
    );
  `);
}

async function appliedFiles(db: Db): Promise<Set<string>> {
  const { rows } = await db.query<{ filename: string }>(
    'select filename from app.schema_migrations',
  );
  return new Set(rows.map((r) => r.filename));
}

async function pendingFiles(): Promise<string[]> {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  return entries;
}

async function applyAuthShim(db: Db): Promise<void> {
  // Supabase already provides auth.users; only stand it up locally.
  if (!usesLocalDatabase) return;
  if (!existsSync(AUTH_SHIM)) {
    throw new Error(`Missing local auth shim at ${AUTH_SHIM}`);
  }
  await db.exec(await readFile(AUTH_SHIM, 'utf8'));
  process.stdout.write('  auth shim applied (local dev only)\n');
}

export async function migrate(opts: { reset?: boolean } = {}): Promise<void> {
  if (opts.reset) {
    if (!usesLocalDatabase) {
      throw new Error('--reset only applies to the local PGlite store; use `supabase db reset` instead.');
    }
    const { rm } = await import('node:fs/promises');
    await rm(env.PGLITE_DATA_DIR, { recursive: true, force: true });
    process.stdout.write(`  dropped ${env.PGLITE_DATA_DIR}\n`);
  }
  process.exit((await run()) ? 0 : 1);
}

async function run(): Promise<boolean> {
  const db = await getDb();
  try {
    await applyAuthShim(db);
    await ensureMigrationsTable(db);

    const done = await appliedFiles(db);
    const files = await pendingFiles();
    let applied = 0;

    for (const filename of files) {
      if (done.has(filename)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const started = Date.now();
      try {
        // exec() uses the simple query protocol, which is what makes
        // dollar-quoted function bodies containing semicolons safe.
        await db.exec(sql);
        await db.query('insert into app.schema_migrations (filename) values ($1)', [filename]);
      } catch (err) {
        process.stderr.write(`\n  FAILED ${filename}\n  ${(err as Error).message}\n`);
        return false;
      }
      applied += 1;
      process.stdout.write(`  applied ${filename} (${Date.now() - started}ms)\n`);
    }

    process.stdout.write(
      applied === 0
        ? '  nothing to apply; database is up to date\n'
        : `  ${applied} migration(s) applied\n`,
    );
    return true;
  } catch (err) {
    process.stderr.write(`  migration error: ${(err as Error).message}\n`);
    return false;
  }
}

const isDirectRun = process.argv[1]?.includes('migrate');
if (isDirectRun) {
  void migrate({ reset: process.argv.includes('--reset') });
}
