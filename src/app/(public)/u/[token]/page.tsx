import type { Metadata } from 'next';
import type { Sql } from 'postgres';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { PageShell } from '@/components/ui/PageShell';
import { getServerConfig } from '@/lib/config/server';
import { sql } from '@/lib/db/server';
import {
  findRedeemableUnsubscribeToken,
  hasLiveGlobalSuppressionForToken,
  verifyUnsubscribeReceipt,
} from '@/lib/solicitation/unsubscribe';

/**
 * `GET /u/<token>` — the recipient-facing unsubscribe landing page (#644 §5.3).
 * READ-ONLY: every mutation is the separate `POST /api/u/<token>`, because a
 * corporate link scanner that fetched this URL would otherwise remove someone
 * from every RepWorth account, permanently and invisibly.
 *
 * No login wall, no fee, no rate limit — CAN-SPAM §7704(a)(3) requires the
 * mechanism to operate, and a throttled opt-out is a lost statutory one (§9.2).
 *
 * The three views are ordered by precedence in `resolveLandingState`.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Unsubscribe · RepWorth',
  robots: { index: false, follow: false },
};

const GENERIC_SENDER = 'the business that contacted you';

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type LandingState =
  | { view: 'success' }
  | { view: 'button'; businessName: string | null }
  | { view: 'neutral' };

export default async function UnsubscribeLandingPage({ params, searchParams }: PageProps) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const state = await resolveLandingState(sql, token, query.ok);

  return (
    <PageShell sections={[]} maxWidthClassName="max-w-2xl">
      <main id="main-content" className="px-6 py-10 sm:px-12 sm:py-14">
        <div className="flex items-center justify-end gap-2">
          <BrandLogo size={32} />
          <span className="text-sm uppercase tracking-wider text-rw-teal-strong">RepWorth</span>
        </div>
        <LandingView state={state} token={token} />
      </main>
    </PageShell>
  );
}

/** Exhaustive over `LandingState`, so a fourth view cannot be added silently. */
function LandingView({ state, token }: { state: LandingState; token: string }) {
  switch (state.view) {
    case 'success':
      return <SuccessView />;
    case 'button':
      return <ButtonView token={token} businessName={state.businessName} />;
    case 'neutral':
      return <NeutralView />;
  }
}

/**
 * §1.8, the corrected invariant: *a page may claim "you are unsubscribed" only
 * from a ledger read taken during that render.*
 *
 * The receipt gates whether we are PERMITTED to show the success state (§5.4
 * enumeration resistance — an unknown token can never produce one). The live
 * ledger read establishes whether the claim is TRUE, because the audited
 * Correction path (§8.2) can remove the row inside the receipt's TTL. Both are
 * required; neither substitutes for the other, and a verified receipt with no
 * live suppression falls through to the honest neutral answer.
 *
 * A missing, malformed, forged, or expired receipt — including a hand-crafted
 * `?done=1`, which is not a receipt at all — reaches the two states below, never
 * this one.
 */
async function resolveLandingState(
  db: Sql,
  rawToken: string,
  receiptParam: string | string[] | undefined,
): Promise<LandingState> {
  // A repeated `?ok=` arrives as an array; there is no honest way to pick one,
  // so it is treated as no receipt at all.
  if (typeof receiptParam === 'string') {
    if (
      verifyUnsubscribeReceipt(rawToken, receiptParam)
      && (await hasLiveGlobalSuppressionForToken(db, rawToken))
    ) {
      return { view: 'success' };
    }
  }

  const redeemable = await findRedeemableUnsubscribeToken(db, rawToken);
  if (redeemable !== null) return { view: 'button', businessName: redeemable.businessName };

  return { view: 'neutral' };
}

/**
 * §5.5 truthfully, and §5.4 structurally: the success view names NO business.
 * Naming the sender here would mean resolving a now-redeemed token, which makes
 * this URL distinguishable from an unknown one — the §5.5/§5.4 conflict,
 * resolved in §5.4's favour with owner sign-off.
 */
function SuccessView() {
  return (
    <div className="mt-8">
      <h1 className="text-3xl font-medium leading-tight text-rw-ink">You&apos;re unsubscribed</h1>
      <p className="mt-4 text-lg leading-relaxed text-rw-ink-soft">
        You won&apos;t receive review requests from the business that contacted you, or from any
        other business that uses RepWorth.
      </p>
    </div>
  );
}

function ButtonView({ token, businessName }: { token: string; businessName: string | null }) {
  return (
    <div className="mt-8">
      <h1 className="text-3xl font-medium leading-tight text-rw-ink">
        Unsubscribe from review requests
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-rw-ink-soft">
        This link stops review requests from {businessName ?? GENERIC_SENDER}, and from every other
        business that uses RepWorth.
      </p>
      {/* A plain form post: no client component, no fetch, and therefore no
          dependency on scripting being enabled. `encodeURIComponent` because a
          token carrying a reserved character would otherwise split the path. */}
      <form method="post" action={`/api/u/${encodeURIComponent(token)}`} className="mt-8">
        <button
          type="submit"
          className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-rw-teal-strong px-8 py-4 text-white shadow-lg transition-colors hover:bg-rw-teal-strong/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rw-teal"
        >
          Unsubscribe me
        </button>
      </form>
      <p className="mt-4 text-sm text-rw-ink-soft">No account or sign-in needed.</p>
    </div>
  );
}

/**
 * The Neutral page (§5.4): ONE identical render for unknown, malformed, and
 * already-redeemed tokens. It takes no token-derived input, so there is nothing
 * here that could distinguish the three — enumeration resistance made
 * structural rather than remembered.
 */
function NeutralView() {
  const mailto = getServerConfig().SOLICITATION_UNSUBSCRIBE_MAILTO;

  return (
    <div className="mt-8">
      <h1 className="text-3xl font-medium leading-tight text-rw-ink">
        This unsubscribe link isn&apos;t active
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-rw-ink-soft">
        It may already have been used, or it may not be a link we recognise.
      </p>
      {mailto === undefined ? null : (
        <p className="mt-4 text-lg leading-relaxed text-rw-ink-soft">
          To make sure you stop receiving review requests, email{' '}
          <a
            href={`mailto:${mailto}`}
            className="text-rw-teal-strong underline underline-offset-4 hover:no-underline"
          >
            {mailto}
          </a>{' '}
          and we&apos;ll take care of it.
        </p>
      )}
    </div>
  );
}
