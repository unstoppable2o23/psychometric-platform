/**
 * Environment configuration. Parsed once, validated, and read only from the
 * server. Nothing here uses a NEXT_PUBLIC_ prefix, so none of it can be bundled
 * into client JavaScript.
 */
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Supabase pooled connection string. When unset, development falls back to an
   * in-process PGlite database so the app and migrations run with zero setup.
   */
  DATABASE_URL: z.string().url().optional(),
  DATABASE_PGSSL: z.coerce.boolean().default(false),

  /** Filesystem path for the local PGlite database (development only). */
  PGLITE_DATA_DIR: z.string().default('.pglite'),

  /**
   * true | dev | test | live. Selects the payment gateway implementation.
   */
  PAYMENT_PROVIDER: z.enum(['fake', 'razorpay']).default('fake'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  /**
   * Enables the passwordless local sign-in used in development.
   *
   * Opt-in on purpose. A Server Action is a public POST endpoint, so gating this
   * on NODE_ENV alone would leave it open on any deployment that is not exactly
   * "production". It is refused in production no matter what.
   */
  ALLOW_DEV_LOGIN: z.coerce.boolean().default(false),

  /** Secret used to sign session cookies. Required in production. */
  AUTH_SECRET: z.string().min(16).optional(),
  SESSION_COOKIE_NAME: z.string().default('psych_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  /** Where rendered PDFs are written. Must be private in production. */
  REPORT_STORAGE_DIR: z.string().default('.reports'),

  /**
   * Public base URL, used to build shareable assessment links. Optional on
   * Vercel: VERCEL_PROJECT_PRODUCTION_URL is used when it is unset.
   */
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),

  /** Set automatically by Vercel; used to derive the app URL when NEXT_PUBLIC_APP_URL is unset. */
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),

  /** Applied to auth, invite, and assessment endpoints. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

// AUTH_SECRET is deliberately not checked here. This module is imported during
// `next build`, where NODE_ENV is already "production" but no request is being
// signed yet. Requiring it at import time would make every build fail on a
// machine that legitimately has no secret. The throw lives in
// auth/tokens.ts signingKey(), so the failure happens when a session is
// actually created rather than when the module is loaded.

if (env.PAYMENT_PROVIDER === 'razorpay' && !(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)) {
  throw new Error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
}

export const isProduction = env.NODE_ENV === 'production';
export const usesLocalDatabase = !env.DATABASE_URL;

/**
 * Base URL of this deployment, used to build links that leave the browser
 * (assessment and activation links). Falls back to the Vercel-provided host and
 * then to localhost so a local dev run needs no configuration.
 */
export function appUrl(): string {
  if (env.NEXT_PUBLIC_APP_URL) return env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'http://localhost:3000';
}
