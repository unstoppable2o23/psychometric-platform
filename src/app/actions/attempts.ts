'use server';

/**
 * Server actions for the attempt lifecycle.
 *
 * These are the mutation entry points from the client. Each one re-resolves the
 * actor and re-authorises inside the data access layer rather than trusting the
 * page that rendered the button, because a Server Action is reachable by direct
 * POST from anywhere.
 */
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';
import { resolveActor, AuthorizationError } from '@/server/dal/actor';
import {
  IncompleteSubmissionError,
  resolveLink,
  saveAnswers,
  startAttempt,
  submitAttempt,
} from '@/server/dal/attempts';
import { renderReport } from '@/server/reports/render';
import { setSessionCookie } from '@/server/auth/session';
import { isProduction, env } from '@/server/env';
import { clientKeyFromHeaders, rateLimit } from '@/server/security/rate-limit';

export interface ActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

function describe(err: unknown): string {
  if (err instanceof AuthorizationError) {
    switch (err.reason) {
      case 'unauthenticated':
        return 'Please sign in again to continue.';
      case 'not_found':
        return 'That assessment link is no longer valid.';
      case 'forbidden':
        return 'This assessment link cannot be used right now.';
      default:
        return 'This account cannot access that record.';
    }
  }
  if (err instanceof IncompleteSubmissionError) {
    const { answered, total, required } = err.detail;
    return `You have answered ${answered} of ${total} questions. At least ${required} are required before you can submit.`;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

async function requestMeta() {
  const h = await headers();
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: h.get('user-agent'),
  };
}

/* -------------------------------------------------------------------------- */

const tokenSchema = z.string().min(16).max(200);

export async function beginAttemptAction(token: string): Promise<ActionResult<{ sessionId: string }>> {
  try {
    const clean = tokenSchema.parse(token);
    const limits = limitersFor('begin', await requestClientKey());
    if (!limits.link.allowed) {
      return fail('Too many attempts from this connection. Wait a minute and try again.');
    }


    const resolution = await resolveLink(clean);
    if (!resolution.ok) {
      return fail(
        resolution.reason === 'expired'
          ? 'This assessment link has expired.'
          : resolution.reason === 'used_up'
            ? 'This assessment has already been completed.'
            : resolution.reason === 'revoked'
              ? 'This assessment link was withdrawn by your school.'
              : 'This assessment link is not valid.',
      );
    }

    const resolved = await resolveActor();
    if (!resolved.ok) return fail('Please sign in to start this assessment.');

    const attempt = await startAttempt(resolved.actor, clean, await requestMeta());
    revalidatePath(`/assessment/${clean}`);
    return { ok: true, data: { sessionId: attempt.sessionId } };
  } catch (err) {
    return fail(describe(err));
  }
}

const saveSchema = z.object({
  sessionId: z.string().uuid(),
  answers: z
    .array(z.object({ questionId: z.string().uuid(), value: z.union([z.string(), z.number()]) }))
    .max(400),
});

export async function saveAnswersAction(
  sessionId: string,
  answers: { questionId: string; value: string | number }[],
): Promise<ActionResult<{ answeredCount: number; remainingSeconds: number; closed: boolean }>> {
  try {
    const input = saveSchema.parse({ sessionId, answers });
    const resolved = await resolveActor();
    if (!resolved.ok) return fail('Your session has expired. Please sign in again.');

    const limits = limitersFor('save', await requestClientKey(), input.sessionId);
    if (!limits.save.allowed) return fail('Too many save requests. Please slow down.');

    const result = await saveAnswers(resolved.actor, input.sessionId, input.answers);
    return {
      ok: true,
      data: {
        answeredCount: result.answeredCount,
        remainingSeconds: result.clock.remainingSeconds,
        closed: result.closed,
      },
    };
  } catch (err) {
    return fail(describe(err));
  }
}

export async function submitAttemptAction(
  sessionId: string,
): Promise<ActionResult<{ sessionId: string; reference: string; reportId: string }>> {
  try {
    const input = z.object({ sessionId: z.string().uuid() }).parse({ sessionId });
    const resolved = await resolveActor();
    if (!resolved.ok) return fail('Your session has expired. Please sign in again.');

    const result = await submitAttempt(resolved.actor, input.sessionId);

    // Render inline for this slice. When this moves to a queue, this call becomes
    // an enqueue and the page polls the report status instead.
    try {
      await renderReport(result.reportId);
    } catch (renderError) {
      // The attempt is scored and stored; a failed render is reported as a
      // processing state rather than losing the result.
      console.error('report render failed', renderError);
    }

    revalidatePath(`/results/${result.sessionId}`);
    return {
      ok: true,
      data: { sessionId: result.sessionId, reference: result.reference, reportId: result.reportId },
    };
  } catch (err) {
    return fail(describe(err));
  }
}

const devSignInSchema = z.object({ email: z.string().email() });

/**
 * Guards the authentication and assessment endpoints.
 *
 * Each limiter is keyed differently on purpose:
 *   - sign-in is per email, so one attacker cannot lock out a whole school by
 *     spraying a shared IP;
 *   - link resolution is per client, so one student repeatedly opening links
 *     cannot exhaust a single global bucket for every other student;
 *   - autosave is per attempt session, because one student legitimately sends a
 *     great many of them.
 */
function limitersFor(action: string, clientKey: string, sessionId?: string) {
  const limit = env.RATE_LIMIT_PER_MINUTE;
  return {
    link: rateLimit(`link:${clientKey}`, 30),
    save: sessionId
      ? rateLimit(`save:${sessionId}`, Math.max(limit, 120))
      : { allowed: true, remaining: 0, retryAfterSeconds: 0 },
  };
}

export async function requestClientKey(): Promise<string> {
  return clientKeyFromHeaders(await headers());
}

/**
 * DEVELOPMENT ONLY. Signs in as a seeded account with no password.
 *
 * Gated on an explicit `ALLOW_DEV_LOGIN=true` rather than on NODE_ENV alone.
 * Server Actions are reachable by direct POST, so "it isn't production" is a
 * weaker guarantee than it looks: a preview deployment, a misconfigured
 * NODE_ENV, or a copied .env would all leave this open. Opting in has to be a
 * deliberate act.
 */
export async function devSignInAction(email: string): Promise<ActionResult<{ role: string }>> {
  if (!env.ALLOW_DEV_LOGIN || isProduction) {
    return fail('Development sign-in is disabled. Set ALLOW_DEV_LOGIN=true outside production to enable it.');
  }

  try {
    const input = devSignInSchema.parse({ email });

    const limiter = rateLimit(`signin:${email.toLowerCase()}`, 10);
    if (!limiter.allowed) {
      return fail('Too many sign-in attempts for this account. Wait a minute and try again.');
    }

    const { getDb } = await import('@/server/db/client');
    const db = await getDb();
    // Students only. Staff have real passwords now, and a passwordless path to
    // an admin session would undo that even on a development build.
    const row = (
      await db.query<{ id: string; role: string }>(
        `select id, role from profiles where email = $1 and is_active and role = 'student'`,
        [input.email],
      )
    ).rows[0];

    if (!row) return fail('No development account with that email.');
    await setSessionCookie(row.id);
    revalidatePath('/', 'layout');
    return { ok: true, data: { role: row.role } };
  } catch (err) {
    return fail(describe(err));
  }
}
