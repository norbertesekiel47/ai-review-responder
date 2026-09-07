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
import { useEffect, useState, type ReactNode } from 'react';
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
    sub: 'Your earlier choice stands, so nothing changed just now.',
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

/**
 * How long a completion notice stays on screen, and how long it takes to leave.
 *
 * The server side of the same rule is `IMPORT_NOTICE_WINDOW_MS`: that stops the
 * notice being permanent ACROSS loads, this retires it WITHIN one. Both are
 * needed — the window alone would leave the banner sitting there for the whole
 * visit, and this alone would bring it back on every reload forever.
 *
 * The leave is cosmetic. `.banner` already resolves to `animation: none` under
 * `prefers-reduced-motion`, and the second timer unmounts the banner either way,
 * so a reader who suppresses motion still gets the notice and still loses it.
 */
const NOTICE_VISIBLE_MS = 8_000;
const NOTICE_LEAVE_MS = 320;

type NoticePhase = 'visible' | 'leaving' | 'gone';

/**
 * The on-screen life of a completion notice: visible, leaving, gone.
 *
 * Extracted from `ImportOfferBanner` because adding it inline pushed that
 * component past the complexity gate — the behaviour is four statements, but it
 * costs the component two state hooks, an effect and a render-time adjustment,
 * and the component already carries a query, a mutation and eight render
 * branches.
 *
 * `noticeState` is the SUBJECT, not a boolean: passing the state value is what
 * lets the phase reset when one notice replaces another. Pass `null` for every
 * state that is not a notice and the hook stays inert.
 */
function useNoticePhase(noticeState: string | null): NoticePhase {
  const [phase, setPhase] = useState<NoticePhase>('visible');

  // Reset DURING RENDER, which is React's sanctioned shape for "adjust state
  // when an input changes". The same write inside an effect body is the
  // cascading render `react-hooks/set-state-in-effect` exists to stop.
  const [phaseKey, setPhaseKey] = useState<string | null>(noticeState);
  if (phaseKey !== noticeState) {
    setPhaseKey(noticeState);
    setPhase('visible');
  }

  // The effect owns ONLY the timers. Both write from a callback, never
  // synchronously, so neither cascades.
  useEffect(() => {
    if (!noticeState) return;
    const leaving = setTimeout(() => setPhase('leaving'), NOTICE_VISIBLE_MS);
    const gone = setTimeout(() => setPhase('gone'), NOTICE_VISIBLE_MS + NOTICE_LEAVE_MS);
    return () => {
      clearTimeout(leaving);
      clearTimeout(gone);
    };
  }, [noticeState]);

  return phase;
}

/** Mirrors `ConnectGoogleBanner.ReadOnlyNotice` — same slot, same treatment. */
function ReadOnlyNotice() {
  return (
    <p className="text-xs mt-1" style={{ color: 'var(--rw-app-text-muted)' }}>
      Update billing to import your reviews.
    </p>
  );
}

/**
 * The offer itself — the one branch that carries controls rather than a
 * sentence. Extracted to bring `ImportOfferBanner` back under the complexity
 * gate after the retire logic landed.
 *
 * It renders the INNER `.banner` only, never its own `BannerShell`. That is the
 * point: `BannerShell` must stay the element at the parent's return position
 * across every state, or React remounts the live region and the terminal
 * announcement is lost with it (the round-1 A6c contract this file's BannerShell
 * doc states).
 *
 * COPY IS LOCKED VERBATIM (owner decision 6, plan T5) — the 7-day disclosure and
 * the automatic-handling reassurance both. Moving it did not license rewording it.
 *
 * ARRANGEMENT IS THE SLOT'S JOB, NOT AN INLINE STYLE (#1087). This is the only
 * banner with TWO actions, and it was the only one that laid them out itself: a
 * raw `div` with an inline flex, holding two `.banner-cta`s that each carry
 * `margin-left: auto`. Three defects followed, measured in the real
 * `.content--dash` container across 360–1440px:
 *
 *  - the group had no `flex-shrink: 0`, so three lines of copy squeezed it. At
 *    1440px both button labels wrapped to two lines; at 390px nothing wrapped at
 *    all — the copy was crushed to a 95px column and the banner grew to 507px,
 *    and at 360px to 585px with a 78px column.
 *  - `.banner`'s `align-items: center` floated the actions at mid-height against
 *    a copy block four times their height.
 *  - two `margin-left: auto` CTAs inside one group split the free space between
 *    themselves and drifted apart whenever the group had any.
 *
 * So the group is now `.banner-actions` — a real element in the action slot,
 * which is where `margin-left: auto` belongs — and `.banner--top` anchors this
 * banner's icon and actions to the top of its multi-line copy and lets the
 * actions take their own row when the copy cannot fit beside them.
 *
 * WHAT "ADDITIVE" DOES AND DOES NOT MEAN HERE. `.banner` is byte-unchanged and
 * every new rule is scoped to `.banner-actions` or `.banner--top`, so no other
 * banner is reached. The first draft was NOT: it set `white-space: nowrap` on
 * `.banner-cta` itself, and there is a THIRD production call site nobody had
 * enumerated — `AutoApprovalClient`'s "Turn off auto-posting" banner — which it
 * regressed from 133px to 212px tall at 390px. Before claiming a rule touches
 * only this banner, grep the class; do not count the states you remember.
 *
 * The read-only notice goes in the SAME slot rather than beside the copy, so a
 * past-due owner reads the substitution where the buttons were.
 */
function OfferPrompt({
  retryable,
  readOnly,
  pending,
  onDecide,
}: {
  retryable: string;
  readOnly: boolean;
  pending: boolean;
  onDecide: (decision: 'accepted' | 'declined') => void;
}) {
  return (
    <div className="banner banner-blue banner--top">
      <div className="b-icon">
        <Icon name="google" size={18} />
      </div>
      <div className="banner-copy">
        <div className="b-title">Import your recent reviews?</div>
        <div className="b-sub">
          We can pull in your 100 most recent Google reviews from the past year so you can generate
          replies for them. Nothing gets posted, and you choose what to reply to.
        </div>
        <div className="b-sub">
          This is a one-time import, available for the next 7 days. New reviews will still be
          handled automatically either way.
        </div>
        {retryable && <div className="b-sub">{retryable}</div>}
      </div>
      <div className="banner-actions">
        {readOnly ? (
          <ReadOnlyNotice />
        ) : (
          <>
            <button
              type="button"
              className="banner-cta"
              disabled={pending}
              onClick={() => onDecide('accepted')}
            >
              Import my reviews
            </button>
            <button
              type="button"
              className="banner-cta banner-cta--ghost"
              disabled={pending}
              onClick={() => onDecide('declined')}
            >
              No thanks
            </button>
          </>
        )}
      </div>
    </div>
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

  // The two terminal SUCCESS states are notices and retire themselves; every
  // other state is a state and stays. `failed` in particular must persist — it
  // is the one branch an owner may still need to act on.
  const noticeState = data?.state === 'imported' || data?.state === 'empty' ? data.state : null;
  const noticePhase = useNoticePhase(noticeState);

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
        <OfferPrompt
          retryable={retryable}
          readOnly={readOnly}
          pending={decide.isPending}
          onDecide={(decision) => decide.mutate(decision)}
        />
      </BannerShell>
    );
  }

  return <ImportStatusBanner view={data} noticePhase={noticePhase} />;
}

/**
 * Every state AFTER the offer is answered: importing, and the three outcomes.
 *
 * They live in ONE component rather than four branches in `ImportOfferBanner`
 * for two reasons, and the second is a correctness constraint, not tidiness:
 *
 *  - it brings the parent back under the complexity gate;
 *  - it keeps `BannerShell` at the SAME tree position across importing →
 *    imported. A live region mounted in the same commit as its message announces
 *    nothing (round-1 A6c), so the region must already exist while the import
 *    runs and must be the same node when the message lands. Four sibling
 *    branches in the parent gave that for free; one component per state would
 *    have quietly taken it away.
 *
 * `importing` is a STATE and stays until it resolves. The two SUCCESS outcomes
 * are notices and retire on `noticePhase`. `failed` is neither — it keeps its own
 * urgent channel and never times out.
 */
function ImportStatusBanner({
  view,
  noticePhase,
}: {
  view: Extract<ImportOfferView, { state: 'importing' | 'imported' | 'empty' | 'failed' }>;
  noticePhase: NoticePhase;
}) {
  const message = statusMessage(view);
  // `empty` is a distinct OUTCOME, not a count of zero — "Imported 0 reviews"
  // reads as a bug to an owner (owner decision 4). `failed` is not a notice and
  // never retires, so it is named here rather than derived from "not importing".
  const retires = view.state === 'imported' || view.state === 'empty';
  if (retires && noticePhase === 'gone') return null;

  // ONE `BannerShell` FOR ALL FOUR STATES, including `failed` (#1087 review F3).
  // `failed` used to return its own shell from an early return at this position,
  // so React saw a type change, remounted the live region, and the region's first
  // paint already carried the failure text — the exact condition the A6c doc
  // above says produces NO announcement. It is also the announcement an owner
  // most needs read to them, and it is reached on the ordinary path: the
  // `importing` poll returns `failed` when the worker gives up. Sharing the shell
  // makes the message an UPDATE to a region that already exists.
  return (
    <BannerShell announcement={view.state === 'importing' ? '' : message}>
      {view.state === 'failed' ? (
        <FailedBanner />
      ) : (
        <StatusNotice
          message={message}
          icon={view.state === 'importing' ? 'refresh' : 'check'}
          leaving={retires && noticePhase === 'leaving'}
        />
      )}
    </BannerShell>
  );
}

/**
 * The one sentence each post-offer state says.
 *
 * A module-level function rather than a ternary chain inside the component
 * (#1087, fallow `css`/complexity gate): adding the `failed` arm in review F3
 * took `ImportStatusBanner` to cognitive complexity 16, and this component was
 * extracted in the first place to stay under that gate. Four branches that
 * depend on nothing but `view` do not need to live inside a render.
 *
 * ONE interpolated string per state, never `Imported {count} reviews.` in JSX.
 * The JSX form renders three sibling text nodes, which no exact-text query can
 * match and which a screen reader may read with odd pauses.
 */
function statusMessage(
  view: Extract<ImportOfferView, { state: 'importing' | 'imported' | 'empty' | 'failed' }>,
): string {
  switch (view.state) {
    case 'failed':
      return "We couldn't finish importing your reviews.";
    case 'importing':
      return 'Importing your reviews… this usually takes a minute.';
    case 'empty':
      return 'No recent reviews found, so there is nothing to import.';
    default:
      return `Imported ${view.count} reviews. They're in your reviews list.`;
  }
}

/**
 * The banner body shared by `importing` and the two success outcomes.
 *
 * Renders the inner `.banner` ONLY, never its own `BannerShell` — the same
 * contract `OfferPrompt` and `FailedBanner` keep.
 */
function StatusNotice({
  message,
  icon,
  leaving,
}: {
  message: string;
  icon: IconName;
  leaving: boolean;
}) {
  return (
    <div className={`banner banner-blue${leaving ? ' banner--leaving' : ''}`}>
      <div className="b-icon">
        <Icon name={icon} size={18} />
      </div>
      <div>
        <div className="b-title">{message}</div>
      </div>
    </div>
  );
}

/**
 * Neutral, with a support contact, and deliberately NO retry button. Retry
 * belongs to the worker via the `completed_at IS NULL` sentinel (spec §5.1); an
 * owner-facing retry would enqueue a second job.
 *
 * Renders the inner `.banner` ONLY, never its own `BannerShell` — the same
 * contract `OfferPrompt` keeps, and for the same reason (#1087 review F3).
 */
function FailedBanner() {
  return (
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
  );
}
