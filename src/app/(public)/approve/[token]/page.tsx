import { createHash } from 'node:crypto';
import { sql } from '@/lib/db/server';
import ApprovalClient from './approval-client';

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

  // Get business name for the shell
  const [biz] = await sql<{ name: string }[]>`
    SELECT name FROM businesses WHERE id = ${link.business_id}
  `;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-lg px-4 py-8">
        <h1 className="text-xl font-semibold text-gray-900">
          {biz?.name ?? 'Your Business'}
        </h1>
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
