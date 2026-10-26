import Link from 'next/link';
import { redirect } from 'next/navigation';
import { buildResultPayload, loadResult } from '@/server/dal/attempts';
import { requireActor } from '@/server/dal/actor';
import { DISCLAIMER } from '@/lib/scoring/interpret';

export const metadata = { title: 'Your result' };
export const dynamic = 'force-dynamic';

export default async function ResultsPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const actor = await requireActor().catch(() => redirect('/'));

  // Authorisation happens in the data access layer, which knows the difference
  // between a student reading their own result and staff reading one inside
  // their organisation. This page must not re-implement that rule.
  let meta;
  try {
    meta = await loadResult(actor, sessionId);
  } catch {
    return (
      <main className="mx-auto max-w-xl px-5 py-16">
        <div className="rounded-lg border border-slate-200 bg-white p-8">
          <h1 className="text-xl font-semibold text-navy">Report not available</h1>
          <p className="mt-2 text-sm text-slate-600">
            This result does not exist, or it is not yours to view.
          </p>
          <Link href="/" className="mt-6 inline-block text-sm font-medium text-royal hover:underline">
            Back to the home page
          </Link>
        </div>
      </main>
    );
  }

  if (meta.status === 'in_progress') redirect('/');

  const { dimensions, matches, narrative } = await buildResultPayload(sessionId);
  const reportReady = meta.report_status === 'ready' && meta.report_id;

  const aptitude = [...dimensions].filter((d) => d.kind === 'aptitude').sort((a, b) => a.rank - b.rank);
  const interest = [...dimensions].filter((d) => d.kind === 'interest').sort((a, b) => a.rank - b.rank);

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <header className="rounded-lg border border-slate-200 bg-white p-7">
        <p className="text-xs font-semibold uppercase tracking-wide text-royal">Assessment complete</p>
        <h1 className="mt-1 text-2xl font-semibold text-navy">Stream Selector Test</h1>
        <p className="mt-1 text-sm text-slate-600">
          Reference <span className="font-mono">{sessionId.slice(0, 8)}</span>
        </p>

        {reportReady ? (
          <a
            href={`/api/reports/${meta.report_id}`}
            className="mt-5 inline-block rounded-md bg-royal px-5 py-2.5 text-sm font-semibold text-white hover:bg-royal-600"
          >
            Download your PDF report
          </a>
        ) : (
          <p className="mt-5 inline-block rounded-md bg-amber-50 px-4 py-2 text-sm text-amber-800">
            Your report is {meta.report_status === 'failed' ? 'still being generated' : 'processing'}.
            Refresh in a moment.
          </p>
        )}
      </header>

      {/* Stream fit */}
      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-7">
        <h2 className="text-lg font-semibold text-navy">How your streams compare</h2>
        <p className="mt-1 text-sm text-slate-600">
          A weighted comparison of your own dimension scores. Not a prediction, and not a ranking
          against other students.
        </p>
        <ol className="mt-4 space-y-3">
          {matches.map((m, i) => (
            <li key={m.stream}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-navy">
                  {i + 1}. {m.label}
                </span>
                <span className="font-mono text-navy">{Math.round(m.fitScore)}%</span>
              </div>
              <div className="mt-1 h-2 w-full rounded bg-slate-100">
                <div className="h-2 rounded bg-royal" style={{ width: `${m.fitScore}%` }} />
              </div>
              <p className="mt-1 text-xs text-slate-500">{m.contributingDimensions.join(' · ')}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Dimensions */}
      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-7">
        <h2 className="text-lg font-semibold text-navy">Your dimension scores</h2>
        <p className="mt-1 text-sm text-slate-600">
          Measured aptitude and stated interests are reported separately, because they answer different
          questions. Scores are relative to your own paper only.
        </p>

        {[
          ['Measured aptitude', aptitude, 'bg-royal'],
          ['Stated interests', interest, 'bg-teal'],
        ].map(([title, list, colour]) => (
          <div key={title as string} className="mt-5">
            <h3 className="text-sm font-semibold text-navy">{title as string}</h3>
            <ul className="mt-2 space-y-2">
              {(list as typeof dimensions).map((d) => (
                <li key={d.key}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-slate-700">{d.label}</span>
                    <span className="font-mono text-slate-700">
                      {Math.round(d.normalizedScore)}
                      <span className="ml-1 text-xs text-slate-400">
                        ({d.itemsAnswered}/{d.itemsTotal})
                      </span>
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full rounded bg-slate-100">
                    <div
                      className={`h-2 rounded ${colour as string}`}
                      style={{ width: `${d.normalizedScore}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {/* Narrative */}
      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-7">
        <h2 className="text-lg font-semibold text-navy">What this means</h2>
        <div className="mt-3 space-y-3">
          {narrative.interpretation.map((p, i) => (
            <p key={i} className="text-sm leading-relaxed text-slate-700">
              {p}
            </p>
          ))}
        </div>
      </section>

      {/* Recommendations */}
      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-7">
        <h2 className="text-lg font-semibold text-navy">Suggestions</h2>
        <div className="mt-3 space-y-4">
          {narrative.recommendations.map((r, i) => (
            <div key={i}>
              <h3 className="text-sm font-semibold text-navy">{r.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-700">{r.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Action plan */}
      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-7">
        <h2 className="text-lg font-semibold text-navy">Your action plan</h2>
        {narrative.actionPlan.map((block, i) => (
          <div key={i} className="mt-4">
            <h3 className="text-sm font-semibold text-royal">{block.window}</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {block.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-6">
        <h2 className="text-sm font-semibold text-amber-900">Before you act on this</h2>
        <p className="mt-2 text-sm leading-relaxed text-amber-900">{DISCLAIMER}</p>
      </section>
    </main>
  );
}
