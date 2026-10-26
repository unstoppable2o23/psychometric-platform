'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { changePasswordAction, signOutAction } from '@/app/actions/teachers';
import { PASSWORD_RULES } from '@/lib/password-policy';

export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await signOutAction();
          router.push('/teacher/signin');
          router.refresh();
        })
      }
      className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

export function ChangePasswordPanel() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  return (
    <form
      className="mt-3 max-w-md space-y-3"
      action={() =>
        startTransition(async () => {
          setMessage(null);
          setFieldError(null);

          const result = await changePasswordAction({
            currentPassword: current,
            newPassword: next,
            confirmPassword: confirm,
          });

          if (!result.ok) {
            setMessage({ kind: 'error', text: result.error ?? 'Could not change your password.' });
            if (result.fieldErrors?.newPassword) setFieldError(result.fieldErrors.newPassword);
            return;
          }

          setMessage({ kind: 'ok', text: 'Password changed. Other sessions were signed out.' });
          setCurrent('');
          setNext('');
          setConfirm('');
        })
      }
    >
      <div>
        <label htmlFor="current" className="block text-xs font-medium text-slate-700">
          Current password
        </label>
        <input
          id="current"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          disabled={pending}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
        />
      </div>
      <div>
        <label htmlFor="next" className="block text-xs font-medium text-slate-700">
          New password
        </label>
        <input
          id="next"
          type="password"
          autoComplete="new-password"
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          disabled={pending}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
        />
        <p className="mt-1 text-xs text-slate-500">At least {PASSWORD_RULES.minLength} characters.</p>
        {fieldError ? <p className="mt-1 text-xs text-red-700">{fieldError}</p> : null}
      </div>
      <div>
        <label htmlFor="confirm" className="block text-xs font-medium text-slate-700">
          Confirm new password
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
      </div>

      {message ? (
        <p
          role="status"
          className={`rounded-md p-3 text-sm ${
            message.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
          }`}
        >
          {message.text}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700 disabled:opacity-60"
      >
        {pending ? 'Updating…' : 'Change password'}
      </button>
    </form>
  );
}
