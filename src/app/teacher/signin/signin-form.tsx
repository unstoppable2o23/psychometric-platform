'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { signInAdminAction, signInTeacherAction } from '@/app/actions/teachers';

/**
 * One form for both staff sign-ins. `mode` decides which action runs and where
 * a successful sign-in lands; the server re-checks the role either way, so this
 * is presentation only.
 */
export function SignInForm({ mode = 'teacher' }: { mode?: 'teacher' | 'admin' }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const formId = `${mode}-signin`;
  const destination = mode === 'admin' ? '/admin/teachers' : '/teacher';

  return (
    <form
      className="mt-6 space-y-3"
      action={() =>
        startTransition(async () => {
          const form = document.getElementById(formId) as HTMLFormElement | null;
          const data = new FormData(form!);
          setError(null);

          const action = mode === 'admin' ? signInAdminAction : signInTeacherAction;
          const result = await action({
            email: String(data.get('email') ?? ''),
            password: String(data.get('password') ?? ''),
          });

          if (!result.ok) {
            setError(result.error ?? 'Could not sign in.');
            return;
          }

          form?.reset();
          router.push(destination);
          router.refresh();
        })
      }
    >
      <div id={formId}>
        <label htmlFor={`${mode}-email`} className="block text-xs font-medium text-slate-700">
          Email address
        </label>
        <input
          id={`${mode}-email`}
          name="email"
          type="email"
          autoComplete="username"
          required
          disabled={pending}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
        />

        <label htmlFor={`${mode}-password`} className="mt-4 block text-xs font-medium text-slate-700">
          Password
        </label>
        <input
          id={`${mode}-password`}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
        />
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-royal px-4 py-2.5 text-sm font-semibold text-white hover:bg-royal-600 disabled:opacity-60"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
