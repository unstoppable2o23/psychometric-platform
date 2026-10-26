import { redirect } from 'next/navigation';
import { resolveLink } from '@/server/dal/attempts';
import { requireActor, AuthorizationError } from '@/server/dal/actor';
import { AssessmentRunner } from './runner';

export const metadata = { title: 'Taking the assessment' };

export default async function TakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const resolution = await resolveLink(token);
  if (!resolution.ok) redirect(`/assessment/${token}`);

  let actor;
  try {
    actor = await requireActor();
  } catch {
    redirect(`/assessment/${token}`);
  }

  let attempt;
  try {
    // Resumes an open attempt, or reports that one must be started from the
    // landing page first.
    const { startAttempt } = await import('@/server/dal/attempts');
    attempt = await startAttempt(actor, token);
  } catch (err) {
    if (err instanceof AuthorizationError) redirect(`/assessment/${token}`);
    throw err;
  }

  if (attempt.status !== 'in_progress') redirect(`/results/${attempt.sessionId}`);

  return <AssessmentRunner initial={attempt} />;
}
