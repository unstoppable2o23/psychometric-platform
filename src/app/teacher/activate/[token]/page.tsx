import Link from 'next/link';
import { inspectInviteAction } from '@/app/actions/teachers';
import { PASSWORD_RULES } from '@/lib/password-policy';
import { ActivateForm } from './activate-form';

export const metadata = { title: 'Activate your account' };
export const dynamic = 'force-dynamic';

export default async function ActivatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await inspectInviteAction(token);

  if (invite.state !== 'valid') {
    return (
      <main className="mx-auto max-w-md px-5 py-14">
        <div className="rounded-lg border border-slate-200 bg-white p-7">
          <h1 className="text-xl font-semibold text-navy">This link is no longer valid</h1>
          <p className="mt-2 text-sm text-slate-600">
            Activation links work once, expire after 48 hours, and are withdrawn if the account is
            disabled. Ask your school administrator to issue a new one.
          </p>
          <Link
            href="/teacher/signin"
            className="mt-6 inline-block text-sm font-medium text-royal hover:underline"
          >
            Go to sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-5 py-14">
      <h1 className="text-2xl font-semibold text-navy">
        {invite.isReset ? 'Set a new password' : 'Set your password'}
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Hello {invite.displayName}. Choose {invite.isReset ? 'a new password' : 'a password'} for{' '}
        {invite.email}. Your school administrator never sees it.
      </p>
      {invite.isReset ? (
        <p className="mt-2 text-sm text-slate-600">
          Setting it will sign you out on any device where you are currently signed in.
        </p>
      ) : null}
      <p className="mt-1 text-xs text-slate-500">
        This link expires {new Date(invite.expiresAt).toLocaleString('en-IN')}.
      </p>
      <ActivateForm token={token} minLength={PASSWORD_RULES.minLength} />
    </main>
  );
}
