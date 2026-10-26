'use server';

/**
 * Admin teacher management and teacher self-service actions.
 *
 * All of these are reachable by direct POST, so each one resolves the actor
 * again and the DAL re-checks the role. A page-level guard is not a control.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { resolveActor, AuthorizationError, type Actor } from '@/server/dal/actor';
import { appUrl } from '@/server/env';
import {
  adminTeacherStats,
  createTeacher,
  issueActivation,
  listOrganizations,
  listTeachers,
  setTeacherEnabled,
  unlockTeacher,
  updateTeacher,
  ValidationError,
} from '@/server/dal/teachers';
import {
  activateWithInvite,
  changeOwnPassword,
  inspectInvite,
  signInAdmin,
  signInTeacher,
  AuthFailure,
} from '@/server/auth/teacher-auth';
import { checkPassword } from '@/server/auth/passwords';
import { PASSWORD_MAX_LENGTH } from '@/lib/password-policy';
import { clearSessionCookie, setSessionCookie } from '@/server/auth/session';
import { rateLimit } from '@/server/security/rate-limit';

export interface ActionResult<T> {
  ok: boolean;
  error?: string;
  /** Field-level messages for forms. */
  fieldErrors?: Record<string, string>;
  data?: T;
}

const fail = <T,>(error: string, fieldErrors?: Record<string, string>): ActionResult<T> => ({
  ok: false,
  error,
  ...(fieldErrors ? { fieldErrors } : {}),
});

function describe(err: unknown): string {
  if (err instanceof ValidationError) return err.message;
  if (err instanceof AuthFailure) return err.message;
  if (err instanceof AuthorizationError) {
    return err.reason === 'unauthenticated'
      ? 'Please sign in again.'
      : err.reason === 'forbidden'
        ? 'You do not have permission to do that.'
        : 'That record does not exist.';
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

async function admin(): Promise<Actor> {
  const resolved = await resolveActor();
  if (!resolved.ok) throw new AuthorizationError('unauthenticated');
  if (resolved.actor.role !== 'admin') throw new AuthorizationError('forbidden');
  return resolved.actor;
}

/* -------------------------------------------------------------------------- */
/* Admin: read                                                                */
/* -------------------------------------------------------------------------- */

export async function loadTeacherAdminData(search?: string) {
  const actor = await admin();
  const [teachers, organizations, stats] = await Promise.all([
    listTeachers(actor, search),
    listOrganizations(actor),
    adminTeacherStats(actor),
  ]);
  return { teachers, organizations, stats };
}

/* -------------------------------------------------------------------------- */
/* Admin: write                                                               */
/* -------------------------------------------------------------------------- */

const createSchema = z.object({
  displayName: z.string().trim().min(2, 'Enter the teacher’s name.').max(120),
  email: z.string().trim().email('Enter a valid email address.').max(200),
  organizationId: z.string().uuid().nullable(),
  roleInOrg: z.enum(['owner', 'admin', 'teacher']),
});

export async function createTeacherAction(input: {
  displayName: string;
  email: string;
  organizationId: string | null;
  roleInOrg: 'owner' | 'admin' | 'teacher';
}): Promise<ActionResult<{ userId: string; activationUrl: string }>> {
  try {
    const actor = await admin();
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[String(issue.path[0])] ??= issue.message;
      }
      return fail('Check the highlighted fields.', fieldErrors);
    }

    const created = await createTeacher(actor, parsed.data);
    revalidatePath('/admin/teachers');
    return {
      ok: true,
      data: {
        userId: created.userId,
        activationUrl: `${appUrl()}/teacher/activate/${created.activationToken}`,
      },
    };
  } catch (err) {
    return fail(describe(err));
  }
}

const updateSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().max(200).optional(),
  organizationId: z.string().uuid().nullable().optional(),
  roleInOrg: z.enum(['owner', 'admin', 'teacher']).optional(),
});

export async function updateTeacherAction(input: {
  userId: string;
  displayName?: string;
  email?: string;
  organizationId?: string | null;
  roleInOrg?: 'owner' | 'admin' | 'teacher';
}): Promise<ActionResult<null>> {
  try {
    const actor = await admin();
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) return fail('Those details are not valid.');

    await updateTeacher(actor, parsed.data.userId, parsed.data);
    revalidatePath('/admin/teachers');
    return { ok: true, data: null };
  } catch (err) {
    return fail(describe(err));
  }
}

export async function setTeacherEnabledAction(
  userId: string,
  enabled: boolean,
): Promise<ActionResult<null>> {
  try {
    const actor = await admin();
    await setTeacherEnabled(actor, z.string().uuid().parse(userId), enabled);
    revalidatePath('/admin/teachers');
    return { ok: true, data: null };
  } catch (err) {
    return fail(describe(err));
  }
}

export async function issueActivationAction(
  userId: string,
): Promise<ActionResult<{ activationUrl: string }>> {
  try {
    const actor = await admin();
    const result = await issueActivation(actor, z.string().uuid().parse(userId));
    revalidatePath('/admin/teachers');
    return {
      ok: true,
      data: { activationUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/teacher/activate/${result.activationToken}` },
    };
  } catch (err) {
    return fail(describe(err));
  }
}

export async function unlockTeacherAction(userId: string): Promise<ActionResult<null>> {
  try {
    const actor = await admin();
    await unlockTeacher(actor, z.string().uuid().parse(userId));
    revalidatePath('/admin/teachers');
    return { ok: true, data: null };
  } catch (err) {
    return fail(describe(err));
  }
}

/* -------------------------------------------------------------------------- */
/* Teacher: activation                                                        */
/* -------------------------------------------------------------------------- */

export async function inspectInviteAction(token: string) {
  return inspectInvite(token);
}

const activateSchema = z.object({
  token: z.string().min(16),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  confirmPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export async function activateTeacherAction(input: {
  token: string;
  password: string;
  confirmPassword: string;
}): Promise<ActionResult<{ email: string }>> {
  try {
    const parsed = activateSchema.safeParse(input);
    if (!parsed.success) return fail('That activation link is not valid.');

    if (parsed.data.password !== parsed.data.confirmPassword) {
      return fail('', { confirmPassword: 'The two passwords do not match.' });
    }

    const problems = checkPassword(parsed.data.password);
    if (problems.length > 0) {
      return fail(problems[0].message, { password: problems[0].message });
    }

    const { userId } = await activateWithInvite(parsed.data.token, parsed.data.password);
    await setSessionCookie(userId);

    const { query } = await import('@/server/db/client');
    const rows = await query<{ email: string | null }>(`select email from profiles where id = $1`, [userId]);
    return { ok: true, data: { email: rows[0]?.email ?? '' } };
  } catch (err) {
    return fail(describe(err));
  }
}

/* -------------------------------------------------------------------------- */
/* Staff: sign in / out / password                                            */
/* -------------------------------------------------------------------------- */

const credentialsSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(1),
});

async function signInWith(
  verifying: (email: string, password: string) => Promise<{ userId: string }>,
  scope: string,
  input: { email: string; password: string },
): Promise<ActionResult<null>> {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) return fail('Enter your email address and password.');

  // Per-account, not per-IP: a shared school network must not let one
  // student's typos lock out a colleague.
  const limiter = rateLimit(`${scope}-signin:${parsed.data.email.toLowerCase()}`, 20);
  if (!limiter.allowed) {
    return fail('Too many sign-in attempts. Wait a minute and try again.');
  }

  const { userId } = await verifying(parsed.data.email, parsed.data.password);
  await setSessionCookie(userId);
  revalidatePath('/', 'layout');
  return { ok: true, data: null };
}

export async function signInTeacherAction(input: {
  email: string;
  password: string;
}): Promise<ActionResult<null>> {
  try {
    return await signInWith(signInTeacher, 'teacher', input);
  } catch (err) {
    return fail(describe(err));
  }
}

export async function signInAdminAction(input: {
  email: string;
  password: string;
}): Promise<ActionResult<null>> {
  try {
    return await signInWith(signInAdmin, 'admin', input);
  } catch (err) {
    return fail(describe(err));
  }
}

export async function signOutAction(): Promise<ActionResult<null>> {
  try {
    await clearSessionCookie();
    revalidatePath('/', 'layout');
    return { ok: true, data: null };
  } catch (err) {
    return fail(describe(err));
  }
}

export async function changePasswordAction(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<ActionResult<null>> {
  try {
    const resolved = await resolveActor();
    if (!resolved.ok) return fail('Please sign in again.');

    if (input.newPassword !== input.confirmPassword) {
      return fail('', { confirmPassword: 'The two passwords do not match.' });
    }

    const problems = checkPassword(input.newPassword);
    if (problems.length > 0) {
      return fail(problems[0].message, { newPassword: problems[0].message });
    }

    await changeOwnPassword(resolved.actor.userId, input.currentPassword, input.newPassword);
    // Bind the current browser to the new credential version; other devices
    // holding the previous cookie stop resolving.
    await setSessionCookie(resolved.actor.userId);
    return { ok: true, data: null };
  } catch (err) {
    return fail(describe(err));
  }
}

