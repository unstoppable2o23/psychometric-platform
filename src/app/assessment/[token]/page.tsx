import Link from 'next/link';
import { resolveLink } from '@/server/dal/attempts';
import { resolveActor, studentAccountFor } from '@/server/dal/actor';
import { env } from '@/server/env';
import { StartButton, DevSignIn } from './start-controls';

export const metadata = { title: 'Assessment' };

const REASONS: Record<string, { title: string; detail: string }> = {
  not_found: {
    title: 'This link is not valid',
    detail:
      'Check that you copied the whole link, including the long code at the end. If it still fails, ask your teacher to send a new one.',
  },
  revoked: {
    title: 'This link was withdrawn',
    detail: 'Your school cancelled this assessment. Please contact them about the next step.',
  },
  expired: {
    title: 'This link has expired',
    detail: 'Assessment links are time-limited. Ask your teacher to issue a fresh one.',
  },
  used_up: {
    title: 'This assessment is already complete',
    detail: 'You can view your report from your dashboard. Retakes need approval from your school.',
  },
};

export default async function AssessmentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const resolution = await resolveLink(token);
  if (!resolution.ok) {
    const copy = REASONS[resolution.reason];
    return (
      <main className="mx-auto max-w-xl px-5 py-16">
        <div className="rounded-lg border border-slate-200 bg-white p-8">
          <h1 className="text-xl font-semibold text-navy">{copy.title}</h1>
          <p className="mt-2 text-sm text-slate-600">{copy.detail}</p>
          <Link href="/" className="mt-6 inline-block text-sm font-medium text-royal hover:underline">
            Back to the home page
          </Link>
        </div>
      </main>
    );
  }

  const { assignment } = resolution;
  const actor = await resolveActor();
  const account = await studentAccountFor(assignment.student_id);

  const isProduction = env.NODE_ENV === 'production';
  const devSignInAvailable = env.ALLOW_DEV_LOGIN && !isProduction;

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <div className="rounded-lg border border-slate-200 bg-white p-7 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-royal">
          Assigned by your school
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-navy">Stream Selector Test</h1>
        <p className="mt-1 text-sm text-slate-600">
          Assigned to {assignment.student_name}
          {assignment.grade ? `, Grade ${assignment.grade}` : ''}
        </p>

        <dl className="mt-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase text-slate-500">Questions</dt>
            <dd className="font-medium text-navy">150</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Time limit</dt>
            <dd className="font-medium text-navy">45 minutes</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Attempts</dt>
            <dd className="font-medium text-navy">{assignment.max_attempts}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Link expires</dt>
            <dd className="font-medium text-navy">
              {assignment.expires_at
                ? new Date(assignment.expires_at).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                  })
                : 'No expiry'}
            </dd>
          </div>
        </dl>

        <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Before you start</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>The countdown starts immediately and keeps running if you close the tab.</li>
            <li>Your answers save automatically, so a refresh will not lose work.</li>
            <li>You need to answer at least 90% of the questions to submit.</li>
            <li>Find a quiet place and set aside the full 45 minutes.</li>
          </ul>
        </div>

        {actor.ok ? (
          <StartButton token={token} />
        ) : !devSignInAvailable ? (
          <p className="mt-6 rounded-md bg-slate-50 p-4 text-sm text-slate-600">
            Please sign in with the account your school registered for you before starting.
          </p>
        ) : (
          <div className="mt-6 rounded-md border border-dashed border-slate-300 p-4">
            <p className="text-sm text-slate-600">
              <strong className="text-navy">Development mode.</strong> Passwordless sign-in is enabled
              locally only and is refused in production.
            </p>
            {account?.email ? <DevSignIn email={account.email} /> : null}
          </div>
        )}
      </div>
    </main>
  );
}
