import { createHash } from 'node:crypto';
import type { Metadata } from 'next';
import { sql } from '@/lib/db/server';
import { PageShell } from '@/components/ui/PageShell';
import { BrandLogo } from '@/components/ui/BrandLogo';
import {
  ApprovalErrorState,
  USED_LINK_MESSAGE,
  type ApprovalErrorVariant,
} from '@/components/approval/ApprovalErrorState';
import ApprovalClient from '@/components/approval/approval-client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Review a draft response · RepWorth',
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ token: string }>;
}

function BrandHeaderRow() {
  return (
    <div className="flex items-center justify-end gap-2">
      <BrandLogo size={32} />
      <span className="text-sm uppercase tracking-wider text-rw-teal-strong">
        RepWorth
      </span>
    </div>
  );
}

export default async function ApprovalPage({ params }: PageProps) {
  const { token: rawToken } = await params;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  // Minimal server-side check; just enough to render shell or error
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

  let errorMessage: string | null = null;
  // A consumed link is a neutral "already used" state, not a failure. The link
  // could have been spent by approve, edit, OR regenerate; so the copy stays
  // neutral rather than asserting "already approved".
  let errorVariant: ApprovalErrorVariant = 'error';
  if (!link) {
    errorMessage = 'This approval link is invalid or has expired.';
  } else if (link.consumed_at) {
    errorMessage = USED_LINK_MESSAGE;
    errorVariant = 'used';
  } else if (link.revoked_at) {
    errorMessage =
      'This approval link has been revoked. A new link may have been sent to your email.';
  } else if (new Date(link.expires_at) <= new Date()) {
    errorMessage =
      'This approval link has expired. Please contact us for a new one.';
  }

  return (
    <PageShell sections={[]}>
      <main id="main-content" className="px-6 py-8 sm:px-10 sm:py-12">
        <BrandHeaderRow />
        <div className="mx-auto mt-8 max-w-xl">
          {errorMessage ? (
            <ApprovalErrorState message={errorMessage} variant={errorVariant} />
          ) : (
            <>
              <h1 className="text-3xl font-medium leading-tight text-rw-ink">
                Review a draft response
              </h1>
              {/* Location chip and archived badge render in the client after
                  it fetches the token-bound review data. */}
              <div className="mt-6">
                <ApprovalClient token={rawToken} />
              </div>
            </>
          )}
        </div>
      </main>
    </PageShell>
  );
}
