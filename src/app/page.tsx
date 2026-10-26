import Link from 'next/link';
import { resolveActor } from '@/server/dal/actor';
import { env } from '@/server/env';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const actor = await resolveActor();
  const isDev = env.ALLOW_DEV_LOGIN && env.NODE_ENV !== 'production';

  return (
    <main>
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-4xl px-5 py-16">
          <p className="text-xs font-semibold uppercase tracking-wide text-royal">
            Grades 8 to 12
          </p>
          <h1 className="mt-2 max-w-2xl text-3xl leading-tight font-semibold text-navy sm:text-4xl">
            Understand what you are drawn to, before choosing a stream
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-600">
            The Stream Selector Test measures eleven dimensions across aptitude and interest, then
            shows how four academic streams compare against your own scores. It is designed to start
            a conversation with a teacher or counsellor, not to end one.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="#how"
              className="rounded-md bg-royal px-5 py-2.5 text-sm font-semibold text-white hover:bg-royal-600"
            >
              How it works
            </Link>
            <Link
              href="/teacher/signin"
              className="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-navy hover:border-slate-400"
            >
              Teacher sign in
            </Link>
            <Link
              href="/admin/signin"
              className="rounded-md px-3 py-2.5 text-sm font-medium text-slate-500 hover:text-navy"
            >
              Administrator
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-5 py-14">
        <h2 className="text-xl font-semibold text-navy">What it does and does not tell you</h2>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-teal">It does</h3>
            <ul className="mt-2 space-y-2 text-sm text-slate-700">
              <li>Measure five reasoning and accuracy dimensions against real questions.</li>
              <li>Record six interest dimensions on a five-point scale.</li>
              <li>Compare four streams using a transparent weighted model you can read.</li>
              <li>Point at the specific dimensions worth practising next.</li>
            </ul>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-navy">It does not</h3>
            <ul className="mt-2 space-y-2 text-sm text-slate-700">
              <li>Compare you with other students. There is no norm group behind it.</li>
              <li>Measure your intelligence. It is not a validated intelligence test.</li>
              <li>Predict a career, or decide eligibility for anything.</li>
              <li>Tell you what you cannot study. Nothing here is a limit.</li>
            </ul>
          </div>
        </div>

        <div id="how" className="mt-12">
          <h2 className="text-xl font-semibold text-navy">How an assessment works</h2>
          <ol className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['1', 'Your school issues a link', 'Each student gets their own secure, single-use link.'],
              ['2', 'You answer 150 questions', 'A 45-minute countdown runs on the server, not your browser.'],
              ['3', 'Scores are computed', 'Aptitude and interest are scored separately, never merged.'],
              ['4', 'You read your report', 'A personalised PDF with charts, reasoning and an action plan.'],
            ].map(([n, title, detail]) => (
              <li key={n} className="rounded-lg border border-slate-200 bg-white p-5">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-lavender text-sm font-semibold text-navy">
                  {n}
                </span>
                <h3 className="mt-3 text-sm font-semibold text-navy">{title}</h3>
                <p className="mt-1 text-sm text-slate-600">{detail}</p>
              </li>
            ))}
          </ol>
        </div>

        {isDev ? (
          <section className="mt-12 rounded-lg border border-dashed border-slate-300 bg-white p-6">
            <h2 className="text-sm font-semibold text-navy">Development build</h2>
            <p className="mt-2 text-sm text-slate-600">
              This build has one assessment wired end to end. Run{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">npm run db:seed</code>{' '}
              to print a working assignment link and the local test accounts. Then{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
                npm run demo:report
              </code>{' '}
              to render a PDF without using the browser.
            </p>
            {actor.ok ? (
              <p className="mt-3 text-sm text-slate-600">
                Signed in as <span className="font-medium text-navy">{actor.actor.displayName}</span>{' '}
                ({actor.actor.role}).
              </p>
            ) : (
              <p className="mt-3 text-sm text-slate-500">
                Open an assignment link to sign in as its student.
              </p>
            )}
          </section>
        ) : null}

        <p className="mt-10 border-t border-slate-200 pt-6 text-xs leading-relaxed text-slate-500">
          This platform provides educational guidance. Its assessments are not clinical, medical or
          diagnostic instruments, and results should never be used on their own to decide admission,
          eligibility or a student&rsquo;s future.
        </p>
      </section>
    </main>
  );
}
