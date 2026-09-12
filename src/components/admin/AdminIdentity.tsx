'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AdminShellIdentity } from '@/lib/admin/shell-context';
import { mfaChallengePath } from '@/lib/auth/mfa';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

/** The legacy shell's identity controls, retained from the retired sidebar. */
export function AdminIdentity({ identity, pathname }: {
  identity: AdminShellIdentity | null;
  pathname: string | null;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!identity) return null;

  async function signOut() {
    setError(null);
    setSigningOut(true);
    try {
      const { error: signOutError } = await createBrowserSupabaseClient().auth.signOut();
      if (signOutError) throw signOutError;
      router.push('/admin/login');
      router.refresh();
    } catch {
      setSigningOut(false);
      setError('Sign out failed. You are still signed in.');
    }
  }

  return (
    <div className="min-w-0 text-xs">
      <p className="break-all font-medium text-rw-ink" title={identity.email ?? undefined}>
        {identity.email ?? 'Signed in'}
      </p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="flex flex-wrap items-center gap-1.5 text-rw-ink-soft">
          <span
            aria-hidden="true"
            className={`inline-block size-1.5 rounded-full ${identity.aal2 ? 'bg-rw-success' : 'bg-rw-ink-soft'}`}
          />
          {identity.aal2 ? (
            'Step-up verified (AAL2)'
          ) : (
            <>
              Step-up not verified ·{' '}
              <Link href={mfaChallengePath(pathname ?? '/admin')} className="inline-flex min-h-11 items-center rounded text-rw-teal-strong underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rw-teal-strong">
                Verify
              </Link>
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => { void signOut(); }}
          disabled={signingOut}
          className="min-h-11 rounded-md border border-rw-cream px-3 text-xs font-medium text-rw-ink hover:bg-rw-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rw-teal-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-rw-error">{error}</p>}
    </div>
  );
}
