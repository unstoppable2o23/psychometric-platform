import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireAdminActor } from '@/server/dal/actor';
import { loadTeacherAdminData } from '@/app/actions/teachers';
import { TeacherTable, CreateTeacherForm } from './client';

export const metadata = { title: 'Teacher accounts' };
export const dynamic = 'force-dynamic';

export default async function AdminTeachersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAdminActor().catch(() => redirect('/'));
  const { q } = await searchParams;
  const { teachers, organizations, stats } = await loadTeacherAdminData(q);

  const cards = [
    { label: 'Total teachers', value: stats.total },
    { label: 'Active', value: stats.active },
    { label: 'Disabled', value: stats.disabled },
    { label: 'Awaiting activation', value: stats.pending },
  ];

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-royal hover:underline">
          &larr; Home
        </Link>
        <h1 className="mt-3 text-2xl font-semibold text-navy">Teacher accounts</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Every teacher signs in with their own email address and password. Accounts are created here,
          and disabling one takes effect immediately &mdash; any live session is ended and any pending
          activation link is withdrawn.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{c.label}</p>
            <p className="mt-1 text-2xl font-semibold text-navy">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-navy">
              {teachers.length} {teachers.length === 1 ? 'teacher' : 'teachers'}
            </h2>
            <form method="get" className="flex gap-2">
              <input
                type="search"
                name="q"
                defaultValue={q ?? ''}
                placeholder="Search name, email or school"
                aria-label="Search teachers"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              <button
                type="submit"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Search
              </button>
            </form>
          </div>
          <TeacherTable
            teachers={teachers.map((t) => ({
              id: t.id,
              displayName: t.displayName,
              email: t.email,
              organizationName: t.organizationName,
              roleInOrg: t.roleInOrg,
              isActive: t.isActive,
              hasPassword: t.hasPassword,
              lastSignInAt: t.lastSignInAt ? t.lastSignInAt.toISOString() : null,
              lockedUntil: t.lockedUntil ? t.lockedUntil.toISOString() : null,
              failedAttempts: t.failedAttempts,
            }))}
            organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
          />
        </section>

        <aside className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-navy">Add a teacher</h2>
          <p className="mt-1 text-sm text-slate-600">
            This creates the account and generates a one-time activation link. The teacher sets their
            own password, so no password is ever stored in plain text or seen by an administrator.
          </p>
          <CreateTeacherForm
            organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
          />
        </aside>
      </div>
    </main>
  );
}
