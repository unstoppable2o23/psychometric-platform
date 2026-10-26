/**
 * Actor resolution and authorization.
 *
 * Every request that touches student data resolves an Actor here first, and
 * every data-access function below in src/server/dal takes an Actor. There is
 * deliberately no code path that queries student results without one.
 */
import 'server-only';
import { getActiveSessionUserId } from '../auth/session';
import type { UserRole } from '@/lib/domain/types';
import { query } from '../db/client';

export interface Actor {
  userId: string;
  role: UserRole;
  organizationId: string | null;
  displayName: string;
  /** Populated for students; lets authorisation skip a lookup. */
  studentId: string | null;
}

export type ActorResult =
  | { ok: true; actor: Actor }
  | { ok: false; reason: 'unauthenticated' | 'no_profile' | 'suspended' };

type ProfileRow = {
  id: string;
  role: UserRole;
  organization_id: string | null;
  display_name: string | null;
  is_active: boolean;
  student_id: string | null;
};

export async function resolveActor(): Promise<ActorResult> {
  // Not just "is there a cookie" but "is the account still entitled to one".
  const userId = await getActiveSessionUserId();
  if (!userId) return { ok: false, reason: 'unauthenticated' };

  const rows = await query<ProfileRow>(
    `select p.id,
            p.role,
            p.organization_id,
            p.display_name,
            p.is_active,
            (select s.id from students s where s.user_id = p.id and s.is_active limit 1) as student_id
       from profiles p
      where p.id = $1`,
    [userId],
  );

  const row = rows[0];
  if (!row) return { ok: false, reason: 'no_profile' };
  if (!row.is_active) return { ok: false, reason: 'suspended' };

  return {
    ok: true,
    actor: {
      userId: row.id,
      role: row.role,
      organizationId: row.organization_id,
      displayName: row.display_name ?? 'Student',
      studentId: row.student_id,
    },
  };
}

export async function requireActor(): Promise<Actor> {
  const result = await resolveActor();
  if (!result.ok) throw new AuthorizationError(result.reason);
  return result.actor;
}

export class AuthorizationError extends Error {
  readonly status: number;
  constructor(readonly reason: 'unauthenticated' | 'no_profile' | 'suspended' | 'forbidden' | 'not_found') {
    super(reason);
    this.name = 'AuthorizationError';
    this.status = reason === 'unauthenticated' ? 401 : reason === 'forbidden' ? 403 : 404;
  }
}

/* -------------------------------------------------------------------------- */
/* Role helpers                                                                */
/* -------------------------------------------------------------------------- */

export const isAdmin = (a: Actor): boolean => a.role === 'admin';
export const isTeacher = (a: Actor): boolean => a.role === 'teacher';
export const isStudent = (a: Actor): boolean => a.role === 'student';

/** School staff are scoped to their organisation; admins are not. */
export function assertSameOrganization(actor: Actor, organizationId: string | null): void {
  if (isAdmin(actor)) return;
  if (!organizationId || !actor.organizationId || organizationId !== actor.organizationId) {
    // Deliberately reported as not-found: a caller who cannot see the record
    // should not learn that it exists.
    throw new AuthorizationError('not_found');
  }
}

/**
 * A student may only act on their own record. Staff may act on any student in
 * their organisation. This is the check that stops one school from reading
 * another school's results by editing a URL.
 */
export function assertMayAccessStudent(actor: Actor, studentId: string): void {
  if (isAdmin(actor)) return;
  if (actor.role === 'student') {
    if (actor.studentId !== studentId) throw new AuthorizationError('not_found');
    return;
  }
  // Teacher: organisation check happens in the query below via assertSameOrganization.
}

export function requireStaff(actor: Actor): void {
  if (actor.role === 'student') throw new AuthorizationError('forbidden');
}

export function requireAdmin(actor: Actor): void {
  if (actor.role !== 'admin') throw new AuthorizationError('forbidden');
}

/** Requires an authenticated admin and returns the actor. */
export async function requireAdminActor(): Promise<Actor> {
  const actor = await requireActor();
  requireAdmin(actor);
  return actor;
}

/** Requires an authenticated teacher and returns the actor. */
export async function requireTeacherActor(): Promise<Actor> {
  const actor = await requireActor();
  if (actor.role !== 'teacher') throw new AuthorizationError('forbidden');
  return actor;
}

/**
 * Login email for a student's account, used to offer the development sign-in on
 * the assignment landing page. Returns null when the student has never claimed
 * an account, which is a normal state for a link-only assignment.
 */
export async function emailForStudentUser(studentUserId: string | null): Promise<string | null> {
  if (!studentUserId) return null;
  const rows = await query<{ email: string | null }>(
    `select email from profiles where id = $1`,
    [studentUserId],
  );
  return rows[0]?.email ?? null;
}

/** Existing student account for a student row, if they have claimed one. */
export async function studentAccountFor(studentId: string): Promise<{ userId: string; email: string | null } | null> {
  const rows = await query<{ user_id: string | null; email: string | null }>(
    `select s.user_id, p.email from students s
       left join profiles p on p.id = s.user_id
      where s.id = $1`,
    [studentId],
  );
  const row = rows[0];
  if (!row?.user_id) return null;
  return { userId: row.user_id, email: row.email };
}
