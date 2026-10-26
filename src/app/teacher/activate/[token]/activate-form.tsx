'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { activateTeacherAction } from '@/app/actions/teachers';

export function ActivateForm({ token, minLength }: { token: string; minLength: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < minLength;

  const strength = useMemo(() => {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
    return Math.min(4, Math.max(classes, password.length >= minLength ? 1 : 0));
  }, [password, minLength]);

  const bar = ['bg-slate-200', 'bg-red-500', 'bg-amber-500', 'bg-teal', 'bg-emerald-600'];

  return (
    <form
      className="mt-6 space-y-3"
      action={() =>
        startTransition(async () => {
          setError(null);
          const result = await activateTeacherAction({ token, password, confirmPassword: confirm });
          if (!result.ok) {
            setError(result.error ?? 'Could not set your password.');
            return;
          }
          router.push('/teacher');
          router.refresh();
        })
      }
    >
      <div>
        <label htmlFor="password" className="block text-xs font-medium text-slate-700">
          New password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={pending}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
        />
        <div className="mt-2 flex gap-1" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`h-1 flex-1 rounded ${i < strength ? bar[strength] : 'bg-slate-200'}`} />
          ))}
        </div>
        <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
          <li className={tooShort ? 'text-red-700' : ''}>At least {minLength} characters</li>
          <li>Mix at least three of: lowercase, uppercase, numbers, symbols</li>
          <li>No spaces</li>
        </ul>
      </div>

      <div>
        <label htmlFor="confirm" className="block text-xs font-medium text-slate-700">
          Confirm password
        </label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={pending}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
        />
        {mismatch ? <p className="mt-1 text-xs text-red-700">The two passwords do not match.</p> : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending || mismatch || password.length === 0}
        className="w-full rounded-md bg-royal px-4 py-2.5 text-sm font-semibold text-white hover:bg-royal-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? 'Setting your password…' : 'Set password and sign in'}
      </button>
    </form>
  );
}
