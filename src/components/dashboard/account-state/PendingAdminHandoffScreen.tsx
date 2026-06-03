'use client';

export function PendingAdminHandoffScreen() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Account activation pending</h1>
        <p className="text-gray-700">
          Your RepWorth account is being set up by your account manager.
          You&apos;ll receive an email when it&apos;s ready.
        </p>
      </div>
    </div>
  );
}
