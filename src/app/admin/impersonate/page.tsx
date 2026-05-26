import { ImpersonationStartClient } from './ImpersonationStartClient';

export const dynamic = 'force-dynamic';

export default function AdminImpersonatePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-8">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Support
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">
            Impersonation
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-gray-600">
            Start a scoped, read-only support session tied to a ticket and audit log.
          </p>
        </div>

        <ImpersonationStartClient />
      </div>
    </div>
  );
}
