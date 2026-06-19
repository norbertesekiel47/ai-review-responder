'use client';

export function PendingAdminHandoffScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--rw-app-bg)' }}>
      <div className="max-w-md w-full rounded-lg p-8 text-center" style={{ background: 'var(--rw-card)', border: '1px solid var(--rw-hair)' }}>
        <h1 className="text-2xl font-bold mb-4">Account activation pending</h1>
        <p style={{ color: 'var(--rw-app-text-muted)' }}>
          Your RepWorth account is being set up by your account manager.
          You&apos;ll receive an email when it&apos;s ready.
        </p>
      </div>
    </div>
  );
}
