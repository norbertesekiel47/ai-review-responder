'use client';

import Link from 'next/link';
import type { DashboardWindow } from '@/lib/kpi/types';
import {
  REFUSAL_CATEGORY_META,
  type RefusalCategory,
} from '@/lib/refusals/vocabulary';
// TYPE-ONLY, and that is a requirement rather than a style choice. `read.ts` is
// server-only — it reaches `@/lib/approval/audit` and therefore `node:crypto`,
// which Next polyfills for nobody — so a value import here would drag it into
// the browser bundle. Its header states the same rule from the other side: a
// component that wants this shape takes it `import type`, as `BatchReport.tsx`
// takes its `BatchView`. `./vocabulary.ts` above is the client-safe leaf and is
// imported for real, because the owner labels live there.
import type {
  RefusalCategoryGroup,
  RefusalEntry,
  RefusalLog,
} from '@/lib/refusals/read';

/**
 * The **Restraint tab** (CONTEXT.md, LOCKED): what RepWorth chose not to do in
 * the selected window, and why.
 *
 * PURE PRESENTATION FED BY ONE `RefusalLog`, exactly as `BatchReport` is fed one
 * `BatchView` (plan §4, §6 T7). That is the whole reason for the shape: the
 * stated total and the per-category counts come from the SAME object, so they
 * cannot disagree. **Never recompute the total here** — `groupEntries`
 * (`src/lib/refusals/read.ts`) builds it as the sum of the group counts, and a
 * second derivation in the view is a second answer waiting to drift.
 *
 * ORDERING BELONGS TO THE READ. `getRefusalLog` ends `ORDER BY occurred_at DESC,
 * entry_id DESC` and `groupEntries` buckets in that order, so every group
 * arrives newest first and every group is already in `REFUSAL_CATEGORIES`
 * precedence order. This file maps; it does not sort.
 *
 * LINKS ONLY, NO WRITES (intake non-goal). Nothing here records a refusal,
 * changes a gate, or posts anything.
 *
 * NO REASON TEXT, EVER. The read never selects `flagged_responses.reason` (S1 is
 * deny-all RLS, invariant #4 — redaction is the whole security story, plan §7
 * risk 1), so a row simply has no prose to render. Do not add a "details"
 * affordance either: it would imply a stored reason the owner could reach, and
 * for the highest-volume lane there is none (plan §2, "the gap this feature
 * cannot close"). A row is a DATE and, when the vocabulary gives it one, a link.
 */

interface Props {
  /** The one object. Both the total and every count are read from it. */
  log: RefusalLog;
  /** The window the log was fetched for — the phrase, not a second filter. */
  period: DashboardWindow;
}

/**
 * How each window READS in a sentence. Keyed `Record<DashboardWindow, …>` so a
 * fifth window is a compile error rather than an unlabelled hero line. The
 * words differ from `PeriodToolbar`'s button labels on purpose: those name a
 * control, these complete a sentence.
 */
const WINDOW_PHRASE: Record<DashboardWindow, string> = {
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  '90d': 'the last 90 days',
  '12w': 'the last 12 weeks',
};

/**
 * The two fixed destinations the vocabulary names, and how each one reads.
 *
 * DERIVED FROM `REFUSAL_CATEGORY_META`, never re-listed. The key type is the
 * union of hrefs the vocabulary actually carries, so adding, removing or
 * re-pointing a category's link fails to compile HERE until the wording follows
 * it. The vocabulary owns the destination; this table owns only the words.
 */
type CategoryLink = (typeof REFUSAL_CATEGORY_META)[RefusalCategory]['link'];
type HrefDestination = Extract<CategoryLink, { kind: 'href' }>['href'];

const DESTINATION_LABEL: Record<HrefDestination, string> = {
  '/dashboard/requests/contacts': 'Who we may contact',
  '/settings/auto-approval': 'Auto-approval settings',
};

/** The per-review destination. `/dashboard/reviews/<id>` has no page of its own
 *  — the timeline IS the review page, and it is what `NeedsAttentionList` and
 *  `ReviewFeedCard` already link to, so the owner lands somewhere familiar. */
const REVIEW_LINK_LABEL = 'See the review';

/**
 * THE TWO LINK KINDS RENDER IN DIFFERENT PLACES, because the vocabulary says
 * they are different things: "`href` is the same page for every entry, `review`
 * is resolved per entry from the review that entry names"
 * (`REFUSAL_CATEGORY_META`'s own contract). So an `href` belongs to the
 * CATEGORY and is drawn once beside its sentence — repeating one destination on
 * every row is five copies of one fact — while a `review` belongs to the ROW.
 */
interface SharedDestination {
  href: string;
  label: string;
}

/** The category's single fixed destination, or `null` for a category that
 *  carries none and for the per-entry `review` kind, which {@link reviewHrefFor}
 *  owns. Unconditional by construction: same page, every entry. */
function sharedDestinationFor(
  category: RefusalCategory,
): SharedDestination | null {
  const link = REFUSAL_CATEGORY_META[category].link;
  return link !== null && link.kind === 'href'
    ? { href: link.href, label: DESTINATION_LABEL[link.href] }
    : null;
}

/**
 * The review link, and the reason it takes an ENTRY rather than a category
 * (T1's finding, deviation D8).
 *
 * `unsafe_content` is fed by TWO sources: S1 held drafts, which name a review,
 * and S6 `moderation_high` outreach withholds, which do not. Category and
 * source are not 1:1, so a link keyed off the category would render a dead
 * `/dashboard/reviews/null/timeline` for half of one heading. The vocabulary
 * marks the KIND; the ENTRY's own `reviewId` decides whether there is a link at
 * all.
 */
function reviewHrefFor(entry: RefusalEntry): string | null {
  const link = REFUSAL_CATEGORY_META[entry.category].link;
  if (link === null || link.kind !== 'review') return null;
  return entry.reviewId === null
    ? null
    : `/dashboard/reviews/${encodeURIComponent(entry.reviewId)}/timeline`;
}

export function RestraintReport({ log, period }: Props) {
  const phrase = WINDOW_PHRASE[period];

  return (
    <>
      <section
        className="card rst-summary section-enter section-enter-1"
        aria-labelledby="rst-summary-heading"
      >
        <h2 className="card-h2" id="rst-summary-heading">
          What we held back
        </h2>
        {log.total === 0 ? (
          // The empty window is a FACT, not an error and not an empty grid
          // (CONTEXT.md → Restraint tab). One plain sentence, and no headings
          // for categories that held nobody — `log.categories` is empty here by
          // construction, so there is nothing to suppress.
          <p className="rst-summary-empty">
            We did not hold anything back in {phrase}. Everything we were asked
            to do, we did.
          </p>
        ) : (
          <>
            <p className="rst-summary-line">
              <span className="rst-summary-count">{log.total}</span>
              <span className="rst-summary-cap">
                {log.total === 1 ? 'thing' : 'things'} we chose not to do in{' '}
                {phrase}
              </span>
            </p>
            <p className="rst-summary-sub">
              Grouped by what stopped us, newest first. None of it was sent.
            </p>
          </>
        )}
      </section>

      {log.categories.map((group, index) => (
        <CategorySection key={group.category} group={group} index={index} />
      ))}
    </>
  );
}

/** One heading per category that actually held something, in the order the
 *  read handed them over — `REFUSAL_CATEGORIES` precedence, safety first. */
function CategorySection({
  group,
  index,
}: {
  group: RefusalCategoryGroup;
  index: number;
}) {
  const meta = REFUSAL_CATEGORY_META[group.category];
  const headingId = `rst-group-${group.category}`;
  const shared = sharedDestinationFor(group.category);

  return (
    <section
      className={`card rst-group section-enter ${enterStagger(index)}`}
      aria-labelledby={headingId}
    >
      <div className="rst-group-head">
        <h2 className="rst-group-title" id={headingId}>
          {meta.label}
        </h2>
        <span className="rst-group-count">
          {group.count} {group.count === 1 ? 'time' : 'times'}
        </span>
      </div>
      {/* The owner's own sentence for this category, verbatim from the
          vocabulary. Never a re-worded copy: the words are the contract. */}
      <p className="rst-group-sentence">
        {meta.sentence}
        {shared !== null && (
          <>
            {' '}
            <Link className="rst-group-link" href={shared.href}>
              {shared.label}
            </Link>
          </>
        )}
      </p>
      <ul className="rst-rows">
        {group.entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function EntryRow({ entry }: { entry: RefusalEntry }) {
  const reviewHref = reviewHrefFor(entry);
  const occurred = new Date(entry.occurredAt);

  return (
    <li className="rst-row">
      <time className="rst-row-when" dateTime={entry.occurredAt}>
        {DAY_FORMAT.format(occurred)}
      </time>
      <span className="rst-row-ago">{relativeDay(occurred)}</span>
      {reviewHref !== null && (
        <Link className="rst-row-link" href={reviewHref}>
          {REVIEW_LINK_LABEL}
        </Link>
      )}
    </li>
  );
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Module-scope formatters: building an `Intl` formatter per render is the
 *  no-locale-format-in-render hotspot (`BatchReport.tsx` states the same rule).
 *  UTC for the same reason it does — the stamp is a server instant, and a
 *  viewer's zone must not slide a refusal onto a different day. */
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const RELATIVE_FORMAT = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
});

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** "3 days ago" beside the date — derived from the timestamp alone, so it adds
 *  a second reading of the same fact and no new information about the row. */
function relativeDay(occurred: Date): string {
  const elapsed = Date.now() - occurred.getTime();
  if (elapsed < HOUR_MS) {
    return RELATIVE_FORMAT.format(-Math.round(elapsed / 60_000), 'minute');
  }
  if (elapsed < DAY_MS) {
    return RELATIVE_FORMAT.format(-Math.round(elapsed / HOUR_MS), 'hour');
  }
  return RELATIVE_FORMAT.format(-Math.round(elapsed / DAY_MS), 'day');
}

/** `.section-enter-1` is the summary card, so the groups start at 2 and hold at
 *  the last defined step rather than emitting a class console.css never wrote. */
function enterStagger(index: number): string {
  return `section-enter-${Math.min(index + 2, 6)}`;
}
