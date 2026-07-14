import { AdminSecurityClient } from './AdminSecurityClient';

export const dynamic = 'force-dynamic';

export default function AdminSecurityPage() {
  return (
    <main className="min-h-screen bg-rw-cream text-rw-ink">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-rw-teal-strong">
          Account security
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Admin security</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-rw-ink-soft">
          Manage the multi-factor authenticator for your admin account. A verified factor is required
          to reach step-up-gated control-plane pages.
        </p>
        <AdminSecurityClient />
      </div>
    </main>
  );
}
