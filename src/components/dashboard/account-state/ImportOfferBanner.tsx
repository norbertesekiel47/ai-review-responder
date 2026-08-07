'use client';

// src/components/dashboard/account-state/ImportOfferBanner.tsx
//
// The Import offer prompt (#677, spec §3). A new ADAPTER at the existing
// dashboard banner seam — not a new seam: `ConnectGoogleBanner` already occupies
// the same slot and already self-nulls, so this follows its anatomy exactly
// (`banner` / `banner-blue` / `banner-attn`, `b-icon` / `b-title` / `b-sub`,
// `banner-cta`, `readOnly` → `ReadOnlyNotice`, and `Icon` from the shell).
// Console system, not the Island.
//
// STATE COMES FROM `GET /api/dashboard/import-offer`, NOT from
// `DashboardDataActive`. `getActiveDashboardData` is Redis-cached
// (`src/lib/dashboard/service.ts:118`), so a declined offer would keep
// re-rendering for the whole TTL. `src/lib/dashboard/**` is deliberately absent
// from this feature's edit surface for that reason.
//
// THE SECTION WRAPPER LIVES HERE, not in `DashboardContent` (round-1 A6b). This
// banner self-nulls on `{ state: 'none' }` — the overwhelmingly common case,
// since almost every location is past its offer — and the caller has nothing to
// gate a wrapper on, because the state is not on the dashboard payload. Owning
// the wrapper is what makes the animated element disappear WITH the banner
// instead of leaving an empty flex item that doubles the section gap.
//
// COPY IS LOCKED VERBATIM (owner decision 6, plan T5), including the 7-day
// disclosure and the mandatory reassurance line. The reassurance exists so that
// declining does not read as "reviews stop being handled": new reviews are still
// handled automatically either way. Do not reword it to save space.
//
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';
import { LiveRegion } from '@/components/ui/LiveRegion';
// TYPE-ONLY (invariant #1, ESLint-enforced): the wire contract has exactly one
// owner — the module that produces it — and re-declaring it here is how the two
// drift. Same boundary treatment as `DashboardContent.tsx:7`.
import type { ImportOfferView } from '@/lib/reviews/import-offer-view';

interface Props {
  /**
   * The location currently in scope. Part of the query key — round-1 High
   * (F110): a key that omits it serves location A's offer on location B, which
   * for THIS feature means one location's consent decision answering for
   * another's. That is the D8/D9 failure the ticket exists to prevent.
   */
  locationId: string;
  /**
   * Past-due read-only owner. Same prop, same treatment as
   * `ConnectGoogleBanner` (round-1 A6): the decision POST answers 402 for a
   * read-only scope, so live CTAs would be buttons that cannot work.
   */
  readOnly?: boolean;
}

interface RejectionCopy {
  title: string;
  sub: string;
  icon: IconName;
}

/**
 * The POST's rejection vocabulary → owner-facing copy.
 *
 * The route answers 409 `offer_expired` / `already_answered` and 404 `no_offer`
 * (`route.ts:116-125`), and A LATE CLICK IS THE ORDINARY CASE HERE: expiry is
 * derived and nothing fires at the deadline (#670), so a banner rendered at
 * T+6d59m is still on screen, with live buttons, after the offer expires. Each
 * of these is terminal — the offer is gone — so the banner REPLACES itself with
 * the explanation rather than leaving buttons that will be rejected again.
 */
const DECISION_REJECTIONS: Record<string, RejectionCopy> = {
  offer_expired: {
    title: 'This import offer has expired',
    sub: 'The one-time import is no longer available. Your new reviews are still being handled automatically.',
    icon: 'clock',
  },
  already_answered: {
    title: 'This offer was already answered',
    sub: 'Your earlier choice stands — nothing changed just now.',
    icon: 'check',
  },
  no_offer: {
    title: 'There is no import offer to answer',
    sub: 'Your new reviews are still being handled automatically.',
    icon: 'check',
  },
};

/**
 * Everything else — 402 read-only, 500, a dropped connection. NOT terminal, so
 * the offer keeps its buttons and this renders beside them.
 */
const DECISION_FAILED_MESSAGE =
  "We couldn't record your choice. Please try again in a moment.";

async function fetchImportOffer(): Promise<ImportOfferView> {
  const res = await fetch('/api/dashboard/import-offer', { cache: 'no-store' });
  if (!res.ok) throw new Error('import_offer_fetch_failed');
  return (await res.json()) as ImportOfferView;
}

async function postDecision(decision: 'accepted' | 'declined'): Promise<void> {
  const res = await fetch('/api/dashboard/import-offer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  if (res.ok) return;
  // The machine code is the error message; `onError` maps it to copy. Reading
  // the body can itself fail (an HTML error page, a truncated response), and
  // that is NOT swallowed — it falls through to the generic rejection, which is
  // rendered and announced.
  let code = 'import_offer_decision_failed';
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const value = (body as { error: unknown }).error;
      if (typeof value === 'string') code = value;
    }
  } catch {
    // Left as the generic code above.
  }
  throw new Error(code);
}

/**
 * The one element every rendered state shares.
 *
 * `LiveRegion` IS MOUNTED UNCONDITIONALLY (round-1 A6c) and only its `message`
 * changes — its own contract, and the reason it works: a screen reader does not
 * announce a message that appears in the same commit as its region. Because
 * every branch returns this same component in the same position, React
 * reconciles one `div` and one live region across the whole importing → terminal
 * transition instead of remounting them with their text already in place.
 *
 * `level` is stable for the same reason: swapping role/aria-live re-maps the
 * accessible node. The `failed` banner keeps its own `role="alert"` for the
 * urgent channel, matching `ConnectGoogleBanner`.
 */
function BannerShell({ announcement, children }: { announcement: string; children: ReactNode }) {
  return (
    <div className="section-enter section-enter-2">
      <LiveRegion message={announcement} />
      {children}
    </div>
  );
}

/** Mirrors `ConnectGoogleBanner.ReadOnlyNotice` — same slot, same treatment. */
function ReadOnlyNotice() {
  return (
    <p className="text-xs mt-1" style={{ color: 'var(--rw-app-text-muted)' }}>
      Update billing to import your reviews.
    </p>
  );
}

export function ImportOfferBanner({ locationId, readOnly = false }: Props) {
  const queryClient = useQueryClient();
  const queryKey = ['import-offer', locationId];

  const { data } = useQuery({
    queryKey,
    queryFn: fetchImportOffer,
    retry: false,
    // Poll ONLY while an import is in flight. A permanent interval would poll a
    // terminal state forever for every owner on every dashboard.
    refetchInterval: (query) =>
      (query.state.data as ImportOfferView | undefined)?.state === 'importing' ? 4000 : false,
  });

  const decide = useMutation({
    mutationFn: postDecision,
    // State advances ONLY on a successful response. An optimistic flip to
    // `importing` is exactly what title 51 exists to catch: it would tell the
    // owner an import started that never did.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
    // A rejected decision must be VISIBLE and must settle (round-1 A3). Without
    // this the owner clicks, the 409/404 is swallowed, and the banner keeps
    // rendering live buttons with no message and no refetch.
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const rejection = decide.error ? DECISION_REJECTIONS[decide.error.message] : undefined;
  // A terminal rejection outranks exactly the two states that cannot be the
  // truth after it: `none`, which the GET now reports for an expired or
  // declined-elsewhere offer and which would make the banner vanish leaving the
  // click unexplained, and a stale `offer`, which the server has just refused.
  // Any real outcome — the import another tab started, or its result — WINS,
  // because "your earlier choice stands" is a worse answer than showing it.
  if (rejection && (!data || data.state === 'none' || data.state === 'offer')) {
    return (
      <BannerShell announcement={`${rejection.title}. ${rejection.sub}`}>
        <div className="banner banner-blue">
          <div className="b-icon">
            <Icon name={rejection.icon} size={18} />
          </div>
          <div>
            <div className="b-title">{rejection.title}</div>
            <div className="b-sub">{rejection.sub}</div>
          </div>
        </div>
      </BannerShell>
    );
  }

  if (!data || data.state === 'none') return null;

  if (data.state === 'offer') {
    // Non-terminal failure: the offer stands and the buttons stay live.
    const retryable = decide.error ? DECISION_FAILED_MESSAGE : '';
    return (
      <BannerShell announcement={retryable}>
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
            {retryable && <div className="b-sub">{retryable}</div>}
          </div>
          {readOnly ? (
            <ReadOnlyNotice />
          ) : (
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
          )}
        </div>
      </BannerShell>
    );
  }

  if (data.state === 'importing') {
    return (
      <BannerShell announcement="">
        <div className="banner banner-blue">
          <div className="b-icon">
            <Icon name="refresh" size={18} />
          </div>
          <div>
            <div className="b-title">Importing your reviews… this usually takes a minute.</div>
          </div>
        </div>
      </BannerShell>
    );
  }

  if (data.state === 'imported') {
    // ONE interpolated string, not `Imported {count} reviews.` in JSX. The JSX
    // form renders three sibling text nodes, which no exact-text query can match
    // and which a screen reader may read with odd pauses.
    const importedMessage = `Imported ${data.count} reviews. They're in your reviews list.`;
    // The announcement is DERIVED from `data`, not held in state: setting state
    // during render is a React anti-pattern, and there is nothing here that
    // render cannot compute.
    return (
      <BannerShell announcement={importedMessage}>
        <div className="banner banner-blue">
          <div className="b-icon">
            <Icon name="check" size={18} />
          </div>
          <div>
            <div className="b-title">{importedMessage}</div>
          </div>
        </div>
      </BannerShell>
    );
  }

  if (data.state === 'empty') {
    // A distinct OUTCOME, not a count of zero — "Imported 0 reviews" reads as a
    // bug to an owner (owner decision 4).
    return (
      <BannerShell announcement="No recent reviews found — nothing to import.">
        <div className="banner banner-blue">
          <div className="b-icon">
            <Icon name="check" size={18} />
          </div>
          <div>
            <div className="b-title">No recent reviews found — nothing to import.</div>
          </div>
        </div>
      </BannerShell>
    );
  }

  // failed — neutral, with support contact, and deliberately NO retry button.
  // Retry belongs to the worker via the `completed_at IS NULL` sentinel (spec
  // §5.1); an owner-facing retry would enqueue a second job.
  return (
    <BannerShell announcement="We couldn't finish importing your reviews.">
      <div className="banner banner-attn" role="alert">
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
    </BannerShell>
  );
}
