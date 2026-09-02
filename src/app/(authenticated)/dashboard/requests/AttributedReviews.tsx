'use client';

// The constant comes from the zero-import leaf, NEVER from
// `@/lib/solicitation/attribution` (#1010): that module is server code, and a
// runtime edge from this file into it drags `node:async_hooks` into the browser
// chunk and fails the build. The type import below is erased at compile time.
import { ATTRIBUTION_DISPLAY_WINDOW_DAYS } from '@/lib/solicitation/attribution-display';
import type { AttributedReviewView } from '@/lib/solicitation/attribution';
import { formatDay } from './timestamps';
import './requests.css';

/**
 * "Reviews from your requests" (#632): every Attributed review for this
 * location in the display window, with the evidence the owner can check.
 *
 * A STANDALONE section on the Requests screen, not a per-batch badge — the
 * locked owner decision. Attribution lands up to the matcher's window after a
 * send, by which time a newer batch usually exists, so a per-batch surface
 * would hide the common case. That is why it is a sibling of the batch screen
 * rather than a slot inside `BatchReport`, and why it renders in every
 * batch-build state.
 *
 * Pure presentation, like `BatchReport`: everything it renders comes from one
 * `view`, and the fetch lives in `RequestsClient`.
 *
 * SENTIMENT-BLIND by construction (the ADR 0012 reasoning): a one-star match
 * renders exactly like a five-star one — no filtering, no separate group, no
 * tone. The section is evidence, not a scoreboard.
 *
 * SHADOW METRIC. The copy says so in the owner's own words: a match is a
 * heuristic on name and timing, and nothing here is ever billed. It must never
 * be presented as revenue, as a guarantee, or as a conversion that is charged
 * for.
 *
 * D2: `attribution_detail` deliberately carries no personal data, so this
 * component renders only what the read model joins for. It never infers or
 * invents a contact name.
 *
 * Invariant #13: the section's existence IS how the browser learns
 * SOLICITATION_SEND_ENABLED is off — `enabled: false` renders nothing at all,
 * and there is no NEXT_PUBLIC companion.
 */

/**
 * The four states, as one closed union so an invalid pair cannot be
 * constructed: a list only exists on a resolved read, and `enabled` is only
 * knowable once the server has answered.
 */
export type AttributedReviewsView =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; enabled: boolean; reviews: AttributedReviewView[] };

const TITLE_ID = 'rq-attributed-title';

/**
 * The disclosure. Observational on purpose: it states what a match IS (a guess
 * from a name and a date) and what it is NOT (proof, or anything billed). No
 * revenue framing, no "requests earned you N reviews".
 */
const SHADOW_DISCLOSURE =
  'A match is our best guess from the name on the review and when it appeared — not proof that your request caused it. This count is never billed and never changes what you pay.';

export function AttributedReviews({ view }: { view: AttributedReviewsView }) {
  // The whole section is absent when the send lane is off, exactly as the
  // approval panel is. Nothing — not a heading, not an empty state — may hint
  // that a hidden feature exists.
  if (view.kind === 'ready' && !view.enabled) return null;

  return (
    <section
      className="card section-enter section-enter-3 rq-attributed"
      aria-labelledby={TITLE_ID}
      aria-busy={view.kind === 'loading' ? true : undefined}
    >
      <div className="rq-hero-head">
        <h2 className="card-h2" id={TITLE_ID} style={{ marginBottom: 0 }}>
          Reviews from your requests
        </h2>
        {/* Presentation only, and read from the read model's own constant so
            the window the owner is told about cannot drift from the window the
            query actually reaches back over. */}
        <span className="rq-attributed-window">
          Last {ATTRIBUTION_DISPLAY_WINDOW_DAYS} days
        </span>
      </div>
      <p className="rq-attributed-note">{SHADOW_DISCLOSURE}</p>
      <Body view={view} />
    </section>
  );
}

function Body({ view }: { view: AttributedReviewsView }) {
  if (view.kind === 'loading') {
    return (
      <div className="rq-skeleton" aria-hidden="true">
        <span className="rq-skeleton-bar rq-skeleton-bar--wide" />
        <span className="rq-skeleton-bar" />
      </div>
    );
  }

  if (view.kind === 'error') {
    // Deliberately NOT role="alert" and NOT the danger wash: a list that could
    // not be read is a quiet gap in an evidence section, not something the
    // owner has to act on, and the batch screen above it is unaffected.
    return (
      <p className="rq-attributed-state">
        We could not read this list just now. Nothing else on this page is
        affected — reload when you get a chance.
      </p>
    );
  }

  if (view.reviews.length === 0) {
    // "Nothing yet", never a failure: the matcher having found nobody is the
    // ordinary state of a location that has just started asking.
    return (
      <p className="rq-attributed-state">
        Nothing matched yet. When somebody you asked leaves a review, it shows
        up here.
      </p>
    );
  }

  return (
    <>
      <p className="rq-attributed-count">
        {view.reviews.length === 1
          ? '1 review matched a request'
          : `${NUMBER_FORMAT.format(view.reviews.length)} reviews matched a request`}
      </p>
      <ul className="rq-attributed-rows">
        {view.reviews.map((review) => (
          <MatchRow key={review.outreachId} review={review} />
        ))}
      </ul>
    </>
  );
}

/**
 * One match. Every row is the same shape whatever the rating: the star run is
 * the only thing that differs between a one-star and a five-star match, and it
 * carries no tone class, no ordering and no grouping of its own.
 */
function MatchRow({ review }: { review: AttributedReviewView }) {
  return (
    <li className="rq-attributed-row">
      <span className="rq-attributed-name">
        {/* The read model joins for the reviewer's own display name; there is
            nothing to fall back to but the absence itself (D2). */}
        {review.reviewerName ?? 'Reviewer name not shown'}
      </span>
      <Stars rating={review.starRating} />
      <span className="rq-attributed-dates">
        Reviewed {formatDayOrUnrecorded(review.reviewDate)} · asked {formatDayOrUnrecorded(review.askSentAt)}
      </span>
    </li>
  );
}

/**
 * The Console star run: warm gold filled glyphs, the same run muted for the
 * remainder, and the rating spoken as words. `role="img"` + `aria-label` rather
 * than a bare labelled span, so the rating survives for a screen reader and is
 * never carried by colour alone.
 */
function Stars({ rating }: { rating: number | null }) {
  if (rating === null) {
    return <span className="rq-attributed-stars-none">Rating not recorded</span>;
  }
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span
      className="rq-attributed-stars"
      role="img"
      aria-label={`${filled} out of 5 stars`}
    >
      <span aria-hidden="true">{'★'.repeat(filled)}</span>
      <span className="rq-attributed-stars-rest" aria-hidden="true">
        {'★'.repeat(5 - filled)}
      </span>
    </span>
  );
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Module-scope formatter: building an Intl formatter per render is the
 *  no-locale-format-in-render hotspot (BatchReport follows the same rule). */
const NUMBER_FORMAT = new Intl.NumberFormat();

/**
 * Both `askSentAt` and `reviewDate` arrive as Postgres `::text`, read through
 * the screen's shared `formatDay` (`./timestamps`). Its bare `YYYY-MM-DD`
 * branch is DEFENSIVE here, not a live case (branch-review L7 — an earlier
 * version of this comment claimed `reviewDate` arrives that way).
 * `reviews.review_date` is `TIMESTAMPTZ`, and the read model selects it
 * `::text`, so the timestamp branch is the one that runs.
 *
 * A null review date is a real state (the column is nullable) and says so.
 */
function formatDayOrUnrecorded(value: string | null): string {
  return value === null ? 'date not recorded' : formatDay(value);
}
