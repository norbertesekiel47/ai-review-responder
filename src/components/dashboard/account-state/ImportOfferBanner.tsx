'use client';

// src/components/dashboard/account-state/ImportOfferBanner.tsx
//
// The Import offer prompt (#677, spec §3). A new ADAPTER at the existing
// dashboard banner seam — not a new seam: `ConnectGoogleBanner` already occupies
// the same slot and already self-nulls, so this follows its anatomy exactly
// (`banner` / `banner-blue` / `banner-attn`, `b-icon` / `b-title` / `b-sub`,
// `banner-cta`, and `Icon` from the shell). Console system, not the Island.
//
// STATE COMES FROM `GET /api/dashboard/import-offer`, NOT from
// `DashboardDataActive`. `getActiveDashboardData` is Redis-cached
// (`src/lib/dashboard/service.ts:118`), so a declined offer would keep
// re-rendering for the whole TTL. `src/lib/dashboard/**` is deliberately absent
// from this feature's edit surface for that reason.
//
// COPY IS LOCKED VERBATIM (owner decision 6, plan T5), including the 7-day
// disclosure and the mandatory reassurance line. The reassurance exists so that
// declining does not read as "reviews stop being handled": new reviews are still
// handled automatically either way. Do not reword it to save space.
//
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/dashboard/shell/Icon';
import { LiveRegion } from '@/components/ui/LiveRegion';

export type ImportOfferState =
  | { state: 'none' }
  | { state: 'offer'; expiresAt: string }
  | { state: 'importing' }
  | { state: 'imported'; count: number }
  | { state: 'empty' }
  | { state: 'failed' };

interface Props {
  /**
   * The location currently in scope. Part of the query key — round-1 High
   * (F110): a key that omits it serves location A's offer on location B, which
   * for THIS feature means one location's consent decision answering for
   * another's. That is the D8/D9 failure the ticket exists to prevent.
   */
  locationId: string;
}

async function fetchImportOffer(): Promise<ImportOfferState> {
  const res = await fetch('/api/dashboard/import-offer', { cache: 'no-store' });
  if (!res.ok) throw new Error('import_offer_fetch_failed');
  return (await res.json()) as ImportOfferState;
}

async function postDecision(decision: 'accepted' | 'declined'): Promise<void> {
  const res = await fetch('/api/dashboard/import-offer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) throw new Error('import_offer_decision_failed');
}

export function ImportOfferBanner({ locationId }: Props) {
  const queryClient = useQueryClient();
  const queryKey = ['import-offer', locationId];

  const { data } = useQuery({
    queryKey,
    queryFn: fetchImportOffer,
    retry: false,
    // Poll ONLY while an import is in flight. A permanent interval would poll a
    // terminal state forever for every owner on every dashboard.
    refetchInterval: (query) =>
      (query.state.data as ImportOfferState | undefined)?.state === 'importing' ? 4000 : false,
  });

  const decide = useMutation({
    mutationFn: postDecision,
    // State advances ONLY on a successful response. An optimistic flip to
    // `importing` is exactly what title 51 exists to catch: it would tell the
    // owner an import started that never did.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  if (!data || data.state === 'none') return null;

  if (data.state === 'offer') {
    return (
      <div className="banner banner-blue">
        <div className="b-icon">
          <Icon name="google" size={18} />
        </div>
        <div>
          <div className="b-title">Import your recent reviews?</div>
          <div className="b-sub">
            We can pull in your 100 most recent Google reviews from the past year so you can
            generate replies for them. Nothing gets posted — you choose what to reply to.
          </div>
          <div className="b-sub">
            This is a one-time import, available for the next 7 days. New reviews will still be
            handled automatically either way.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="banner-cta"
            disabled={decide.isPending}
            onClick={() => decide.mutate('accepted')}
          >
            Import my reviews
          </button>
          <button
            type="button"
            className="banner-cta"
            style={{ background: 'transparent', color: 'var(--rw-app-text-muted)' }}
            disabled={decide.isPending}
            onClick={() => decide.mutate('declined')}
          >
            No thanks
          </button>
        </div>
      </div>
    );
  }

  if (data.state === 'importing') {
    return (
      <div className="banner banner-blue">
        <div className="b-icon">
          <Icon name="refresh" size={18} />
        </div>
        <div>
          <div className="b-title">Importing your reviews… this usually takes a minute.</div>
        </div>
      </div>
    );
  }

  if (data.state === 'imported') {
    // ONE interpolated string, not `Imported {count} reviews.` in JSX. The JSX
    // form renders three sibling text nodes, which no exact-text query can match
    // and which a screen reader may read with odd pauses.
    const importedMessage = `Imported ${data.count} reviews. They're in your reviews list.`;
    // LiveRegion announces the importing → terminal transition for anyone who
    // cannot see the banner change under them (title 68). The message is DERIVED
    // from `data`, not held in state: setting state during render is a React
    // anti-pattern, and there is nothing here that render cannot compute.
    return (
      <div className="banner banner-blue">
        <LiveRegion message={importedMessage} />
        <div className="b-icon">
          <Icon name="check" size={18} />
        </div>
        <div>
          <div className="b-title">{importedMessage}</div>
        </div>
      </div>
    );
  }

  if (data.state === 'empty') {
    // A distinct OUTCOME, not a count of zero — "Imported 0 reviews" reads as a
    // bug to an owner (owner decision 4).
    return (
      <div className="banner banner-blue">
        <LiveRegion message="No recent reviews found — nothing to import." />
        <div className="b-icon">
          <Icon name="check" size={18} />
        </div>
        <div>
          <div className="b-title">No recent reviews found — nothing to import.</div>
        </div>
      </div>
    );
  }

  // failed — neutral, with support contact, and deliberately NO retry button.
  // Retry belongs to the worker via the `completed_at IS NULL` sentinel (spec
  // §5.1); an owner-facing retry would enqueue a second job.
  return (
    <div className="banner banner-attn" role="alert">
      <LiveRegion message="We couldn't finish importing your reviews." level="assertive" />
      <div className="b-icon">
        <Icon name="alert" size={18} />
      </div>
      <div>
        <div className="b-title">We couldn&apos;t finish importing your reviews</div>
        <div className="b-sub">
          Your new reviews are still being handled normally. Contact{' '}
          <a href="mailto:support@repworth.net">support@repworth.net</a> if you&apos;d like us to
          look into the import.
        </div>
      </div>
    </div>
  );
}
