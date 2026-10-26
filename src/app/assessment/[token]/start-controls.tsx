'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { beginAttemptAction, devSignInAction } from '@/app/actions/attempts';

export function StartButton({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="mt-6">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await beginAttemptAction(token);
            if (!result.ok) {
              setError(result.error ?? 'Could not start the assessment.');
              return;
            }
            router.push(`/assessment/${token}/take`);
          })
        }
        className="w-full rounded-md bg-royal px-5 py-3 text-sm font-semibold text-white transition hover:bg-royal-600 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {pending ? 'Starting…' : 'Start assessment'}
      </button>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function DevSignIn({ email }: { email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await devSignInAction(email);
            if (!result.ok) {
              setError(result.error ?? 'Sign-in failed.');
              return;
            }
            router.refresh();
          })
        }
        className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white transition hover:bg-navy-700 disabled:opacity-60"
      >
        {pending ? 'Signing in…' : `Continue as ${email}`}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
