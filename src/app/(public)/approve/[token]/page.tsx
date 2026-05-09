import { createHash } from 'node:crypto';
import { sql } from '@/lib/db/server';
import { getDisplayLabel, type HasDisplayLabel } from '@/lib/locations/display-label';
import ApprovalClient from '@/components/approval/approval-client';

interface PageProps {
  params: { token: string };
}

export default async function ApprovalPage({ params }: PageProps) {
  const rawToken = params.token;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  // Minimal server-side check — just enough to render shell or error
  const [link] = await sql<
    {
      response_id: string;
      business_id: string;
      expires_at: Date;
      consumed_at: Date | null;
      revoked_at: Date | null;
    }[]
  >`
    SELECT response_id, business_id, expires_at, consumed_at, revoked_at
    FROM approval_links WHERE token_hash = ${tokenHash}
  `;

  if (!link) {
    return <ErrorPage message="This approval link is invalid or has expired." />;
  }
  if (link.consumed_at) {
    return (
      <ErrorPage message="This response has already been approved." />
    );
  }
  if (link.revoked_at) {
    return (
      <ErrorPage message="This approval link has been revoked. A new link may have been sent to your email." />
    );
  }
  if (new Date(link.expires_at) <= new Date()) {
    return (
      <ErrorPage message="This approval link has expired. Please contact us for a new one." />
    );
  }

  // Get business info for the shell — include display_label and archived_at
  const [biz] = await sql<{ name: string; display_label: string | null; archived_at: Date | null }[]>`
    SELECT name, display_label, archived_at FROM businesses WHERE id = ${link.business_id}
  `;

  const locationLabel = biz ? getDisplayLabel(biz as HasDisplayLabel) : 'Your Business';
  const isArchived = biz?.archived_at != null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-lg px-4 py-8">
        <h1 className="text-xl font-semibold text-gray-900">
          {locationLabel}
        </h1>
        <div className="mt-1 flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full whitespace-nowrap max-w-[160px] truncate">
            <svg className="h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 14.4a6.4 6.4 0 1 1 0-12.8 6.4 6.4 0 0 1 0 12.8z" />
              <path d="M8 4a1.6 1.6 0 1 0 0 3.2A1.6 1.6 0 0 0 8 4zm0 4.8a1.6 1.6 0 0 0-1.6 1.6v.8a1.6 1.6 0 0 0 3.2 0v-.8A1.6 1.6 0 0 0 8 8.8z" />
            </svg>
            {locationLabel}
          </span>
          {isArchived && (
            <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
              Archived
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500">Review a draft response</p>
        <div className="mt-6">
          <ApprovalClient token={rawToken} />
        </div>
      </div>
    </div>
  );
}

function ErrorPage({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md rounded-lg bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
          <svg
            className="h-6 w-6 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="2"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
        </div>
        <p className="text-gray-700">{message}</p>
      </div>
    </div>
  );
}
