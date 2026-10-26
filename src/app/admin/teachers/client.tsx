'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  createTeacherAction,
  issueActivationAction,
  setTeacherEnabledAction,
  unlockTeacherAction,
  updateTeacherAction,
} from '@/app/actions/teachers';

export interface TeacherView {
  id: string;
  displayName: string;
  email: string;
  organizationName: string | null;
  roleInOrg: string | null;
  isActive: boolean;
  hasPassword: boolean;
  lastSignInAt: string | null;
  lockedUntil: string | null;
  failedAttempts: number;
}

function CopyableLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-3">
      <p className="text-xs font-medium text-emerald-900">{label}</p>
      <div className="mt-1 flex gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-xs text-slate-700">
          {url}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
          className="shrink-0 rounded bg-emerald-700 px-2 py-1 text-xs font-medium text-white"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-2 text-xs text-emerald-800">
        Shown once. It cannot be recovered later &mdash; issue a new link if it is lost.
      </p>
    </div>
  );
}

export function TeacherTable({
  teachers,
  organizations,
}: {
  teachers: TeacherView[];
  organizations: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [activationLinks, setActivationLinks] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusyId(id);
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? 'That did not work.');
      router.refresh();
      setBusyId(null);
    });
  };

  if (teachers.length === 0) {
    return (
      <p className="rounded-md bg-slate-50 p-6 text-center text-sm text-slate-600">
        No teacher accounts yet. Use the form to add the first one.
      </p>
    );
  }

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <ul className="divide-y divide-slate-100">
        {teachers.map((teacher) => {
          const locked = teacher.lockedUntil && new Date(teacher.lockedUntil) > new Date();
          const busy = busyId === teacher.id;

          return (
            <li key={teacher.id} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-navy">
                    {teacher.displayName}
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        teacher.isActive
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {teacher.isActive ? 'Active' : 'Disabled'}
                    </span>
                    {!teacher.hasPassword ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                        Not activated
                      </span>
                    ) : null}
                    {locked ? (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">
                        Locked
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-sm text-slate-600">{teacher.email}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {teacher.organizationName ?? 'No school assigned'}
                    {teacher.roleInOrg ? ` \u00b7 ${teacher.roleInOrg}` : ''}
                    {' \u00b7 '}
                    {teacher.lastSignInAt
                      ? `last signed in ${new Date(teacher.lastSignInAt).toLocaleDateString('en-IN')}`
                      : 'never signed in'}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <label className="sr-only" htmlFor={`org-${teacher.id}`}>
                    School for {teacher.displayName}
                  </label>
                  <select
                    id={`org-${teacher.id}`}
                    defaultValue={organizations.find((o) => o.name === teacher.organizationName)?.id ?? ''}
                    disabled={pending}
                    onChange={(e) =>
                      run(teacher.id, () =>
                        updateTeacherAction({
                          userId: teacher.id,
                          organizationId: e.target.value || null,
                          roleInOrg: (teacher.roleInOrg as 'owner' | 'admin' | 'teacher') ?? 'teacher',
                        }),
                      )
                    }
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-xs disabled:opacity-50"
                  >
                    <option value="">No school</option>
                    {organizations.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    disabled={pending || busy}
                    onClick={() =>
                      run(teacher.id, async () => {
                        const result = await issueActivationAction(teacher.id);
                        if (result.ok && result.data) {
                          setActivationLinks((prev) => ({ ...prev, [teacher.id]: result.data!.activationUrl }));
                        }
                        return result;
                      })
                    }
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-50"
                  >
                    {teacher.hasPassword ? 'New reset link' : 'Activation link'}
                  </button>

                  {locked ? (
                    <button
                      type="button"
                      disabled={pending || busy}
                      onClick={() => run(teacher.id, () => unlockTeacherAction(teacher.id))}
                      className="rounded-md border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-50"
                    >
                      Unlock
                    </button>
                  ) : null}

                  <button
                    type="button"
                    disabled={pending || busy}
                    onClick={() =>
                      run(teacher.id, () => setTeacherEnabledAction(teacher.id, !teacher.isActive))
                    }
                    className={`rounded-md px-2 py-1.5 text-xs font-medium disabled:opacity-50 ${
                      teacher.isActive
                        ? 'border border-red-300 text-red-700 hover:bg-red-50'
                        : 'border border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                    }`}
                  >
                    {teacher.isActive ? 'Disable' : 'Enable'}
                  </button>
                </div>
              </div>

              {activationLinks[teacher.id] ? (
                <CopyableLink
                  url={activationLinks[teacher.id]}
                  label={
                    teacher.hasPassword
                      ? 'Password reset link (single use, 48 hours)'
                      : 'Activation link (single use, 48 hours)'
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CreateTeacherForm({ organizations }: { organizations: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [activationUrl, setActivationUrl] = useState<string | null>(null);

  const field = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60';

  return (
    <form
      className="mt-4 space-y-3"
      action={() =>
        startTransition(async () => {
          const form = document.getElementById('new-teacher') as HTMLFormElement | null;
          const data = new FormData(form!);
          setError(null);
          setFieldErrors({});

          const result = await createTeacherAction({
            displayName: String(data.get('displayName') ?? ''),
            email: String(data.get('email') ?? ''),
            organizationId: (data.get('organizationId') as string) || null,
            roleInOrg: (data.get('roleInOrg') as 'owner' | 'admin' | 'teacher') || 'teacher',
          });

          if (!result.ok) {
            setError(result.error ?? 'Could not create that teacher.');
            setFieldErrors(result.fieldErrors ?? {});
            return;
          }

          setActivationUrl(result.data?.activationUrl ?? null);
          form?.reset();
          router.refresh();
        })
      }
    >
      <div id="new-teacher">
        <label htmlFor="displayName" className="block text-xs font-medium text-slate-700">
          Full name
        </label>
        <input
          id="displayName"
          name="displayName"
          required
          disabled={pending}
          className={field}
          aria-invalid={Boolean(fieldErrors.displayName)}
        />
        {fieldErrors.displayName ? (
          <p className="mt-1 text-xs text-red-700">{fieldErrors.displayName}</p>
        ) : null}

        <label htmlFor="email" className="mt-3 block text-xs font-medium text-slate-700">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          disabled={pending}
          className={field}
          aria-invalid={Boolean(fieldErrors.email)}
        />
        <p className="mt-1 text-xs text-slate-500">This is the teacher&rsquo;s own sign-in.</p>
        {fieldErrors.email ? <p className="mt-1 text-xs text-red-700">{fieldErrors.email}</p> : null}

        <label htmlFor="organizationId" className="mt-3 block text-xs font-medium text-slate-700">
          School
        </label>
        <select id="organizationId" name="organizationId" disabled={pending} className={field}>
          <option value="">No school assigned</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>

        <label htmlFor="roleInOrg" className="mt-3 block text-xs font-medium text-slate-700">
          Role in school
        </label>
        <select id="roleInOrg" name="roleInOrg" disabled={pending} className={field}>
          <option value="teacher">Teacher</option>
          <option value="admin">Administrator</option>
          <option value="owner">Owner</option>
        </select>
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
        {pending ? 'Creating…' : 'Create teacher account'}
      </button>

      {activationUrl ? <CopyableLink url={activationUrl} label="Activation link" /> : null}
    </form>
  );
}
