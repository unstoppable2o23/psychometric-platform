import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveActor } from '@/server/dal/actor';
import { query } from '@/server/db/client';
import { SignOutButton, ChangePasswordPanel } from './panels';

export const metadata = { title: 'Teacher' };
export const dynamic = 'force-dynamic';

export default async function TeacherHomePage() {
  const resolved = await resolveActor();
  if (!resolved.ok) redirect('/teacher/signin');

  const actor = resolved.actor;

  // Admins have their own management screen; send them there rather than showing
  // an empty teacher view.
  if (actor.role === 'admin') redirect('/admin/teachers');
  if (actor.role !== 'teacher') redirect('/');

  const org = actor.organizationId
    ? (
        await query<{ name: string; city: string | null; state: string | null }>(
          `select name, city, state from organizations where id = $1`,
          [actor.organizationId],
        )
      )[0]
    : null;

  const [students, activeAssignments, completed, credits] = await Promise.all([
    query<{ n: number }>(
      `select count(*)::int as n from students where organization_id = $1 and is_active`,
      [actor.organizationId],
    ),
    query<{ n: number }>(
      `select count(*)::int as n from assessment_assignments
        where organization_id = $1 and status in ('assigned','in_progress')`,
      [actor.organizationId],
    ),
    query<{ n: number }>(
      `select count(*)::int as n from assessment_sessions s
         join assessments a on a.id = (select assessment_id from assessment_versions where id = s.assessment_version_id)
        where s.organization_id = $1 and s.status in ('submitted','expired')`,
      [actor.organizationId],
    ),
    query<{ n: number }>(
      `select coalesce(sum(balance), 0)::int as n from app.credit_balances where organization_id = $1`,
      [actor.organizationId],
    ),
  ]);

  const stats = [
    { label: 'Students', value: students[0]?.n ?? 0, hint: 'in your school' },
    { label: 'Open assessments', value: activeAssignments[0]?.n ?? 0, hint: 'assigned or in progress' },
    { label: 'Completed', value: completed[0]?.n ?? 0, hint: 'all time' },
    { label: 'Credits left', value: credits[0]?.n ?? 0, hint: 'available to assign' },
  ];

  return (
    <main className="mx-auto max-w-4xl px-5 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-royal">Teacher</p>
          <h1 className="mt-1 text-2xl font-semibold text-navy">{actor.displayName}</h1>
          <p className="text-sm text-slate-600">
            {org ? `${org.name}${org.city ? `, ${org.city}` : ''}` : 'No school assigned yet'}
          </p>
        </div>
        <SignOutButton />
      </header>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold text-navy">{s.value}</p>
            <p className="text-xs text-slate-500">{s.hint}</p>
          </div>
        ))}
      </div>

      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-base font-semibold text-navy">What you can do here</h2>
        <p className="mt-1 text-sm text-slate-600">
          This is your account home. Managing your student roster and issuing individual assessment
          links is the next piece of work; until it lands, your school administrator issues links on
          your behalf.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-slate-700">
          <li className="flex gap-2">
            <span className="text-emerald-600">&check;</span>
            Sign in with your own email address and password
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-600">&check;</span>
            Change your password whenever you want
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-600">&check;</span>
            See your school&rsquo;s student and assessment totals
          </li>
          <li className="flex gap-2 text-slate-500">
            <span>&mdash;</span>
            Create the student roster and issue assessment links (coming next)
          </li>
        </ul>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-base font-semibold text-navy">Change your password</h2>
        <ChangePasswordPanel />
      </section>

      <p className="mt-6 text-xs text-slate-500">
        Need an account changed or disabled?{' '}
        <Link href="/" className="font-medium text-royal hover:underline">
          Ask your platform administrator
        </Link>
        . Disabling an account signs it out immediately everywhere.
      </p>
    </main>
  );
}
