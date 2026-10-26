import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveActor } from '@/server/dal/actor';
import { SignInForm } from '@/app/teacher/signin/signin-form';

export const metadata = { title: 'Administrator sign in' };
export const dynamic = 'force-dynamic';

export default async function AdminSignInPage() {
  const actor = await resolveActor();
  if (actor.ok) {
    redirect(actor.actor.role === 'admin' ? '/admin/teachers' : '/teacher');
  }

  return (
    <main className="mx-auto max-w-md px-5 py-14">
      <Link href="/" className="text-sm font-medium text-royal hover:underline">
        &larr; Home
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-navy">Administrator sign in</h1>
      <p className="mt-1 text-sm text-slate-600">
        This account manages teacher access. Teachers sign in{' '}
        <Link href="/teacher/signin" className="font-medium text-royal hover:underline">
          here
        </Link>
        .
      </p>
      <SignInForm mode="admin" />
    </main>
  );
}
