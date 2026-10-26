import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveActor } from '@/server/dal/actor';
import { SignInForm } from './signin-form';

export const metadata = { title: 'Teacher sign in' };
export const dynamic = 'force-dynamic';

export default async function TeacherSignInPage() {
  const actor = await resolveActor();
  // Someone already signed in should not be sitting on a sign-in form.
  if (actor.ok) {
    redirect(actor.actor.role === 'admin' ? '/admin/teachers' : '/teacher');
  }

  return (
    <main className="mx-auto max-w-md px-5 py-14">
      <Link href="/" className="text-sm font-medium text-royal hover:underline">
        &larr; Home
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-navy">Teacher sign in</h1>
      <p className="mt-1 text-sm text-slate-600">
        Use the email address your school administrator registered for you. If you have not set a
        password yet, use the activation link they sent you.
      </p>
      <SignInForm />
    </main>
  );
}
