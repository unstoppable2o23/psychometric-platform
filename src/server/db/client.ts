/**
 * Unified Postgres access.
 *
 * Two drivers behind one interface so the same SQL and the same migration files
 * run in both environments:
 *   - development without credentials -> PGlite (Postgres 17 compiled to WASM)
 *   - production / Supabase            -> node-postgres pool
 *
 * Every value crossing this boundary is a parameterised placeholder ($1, $2).
 * There is no string interpolation path, by design.
 */
import { env, isProduction, usesLocalDatabase } from '../env';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  readonly driver: 'pglite' | 'pg';
  query<T>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Releases the underlying handle so a short-lived script can exit cleanly. */
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* node-postgres                                                               */
/* -------------------------------------------------------------------------- */

class PgDb implements Db {
  readonly driver = 'pg' as const;
  constructor(private readonly pool: import('pg').Pool) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const scoped = new PgDb(client as unknown as import('pg').Pool);
      const out = await fn(scoped);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/* -------------------------------------------------------------------------- */
/* PGlite                                                                      */
/* -------------------------------------------------------------------------- */

class PGliteDb implements Db {
  readonly driver = 'pglite' as const;

  constructor(
    private readonly pg: import('@electric-sql/pglite').PGlite,
    /** True while already inside a transaction callback. */
    private readonly inTx = false,
  ) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pg.query<T>(sql, params as unknown[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // PGlite is a single embedded instance; nested transactions collapse into the
    // outermost one rather than failing.
    if (this.inTx) return fn(this);
    return this.pg.transaction(async (tx) => fn(new PGliteDb(tx as never, true)));
  }

  async close(): Promise<void> {
    // A transaction handle shares the root instance; only the root closes it.
    if (!this.inTx) await this.pg.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Singleton                                                                   */
/* -------------------------------------------------------------------------- */

declare global {
  // Reused across dev-server hot reloads so the PGlite instance (and its data
  // directory handle) is not reopened on every rebuild.
  var __psychDb: Promise<Db> | undefined;
}

async function createDb(): Promise<Db> {
  if (!usesLocalDatabase) {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_PGSSL || env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    return new PgDb(pool);
  }

  if (isProduction) {
    throw new Error(
      'DATABASE_URL is not set but NODE_ENV is production. The embedded PGlite ' +
        'database cannot run on a serverless host. Configure a Postgres connection ' +
        'string (Supabase, Neon, Vercel Postgres) and re-run the migrations.',
    );
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create({ dataDir: env.PGLITE_DATA_DIR });
  await pg.waitReady;
  return new PGliteDb(pg);
}

export function getDb(): Promise<Db> {
  globalThis.__psychDb ??= createDb();
  return globalThis.__psychDb;
}

/** Convenience wrapper for one-off reads. Prefer the DAL for anything user-scoped. */
export async function query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const db = await getDb();
  return (await db.query<T>(sql, params)).rows;
}
