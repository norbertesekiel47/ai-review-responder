'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { REFUSAL_CATEGORIES, type RefusalCategory } from '@/lib/refusals/vocabulary';
import type {
  ArchivedLocationSummary,
  ArchivedPeriod,
  RefusalLog,
  RefusalLogEntry,
} from '@/lib/refusals/read';

/** What `GET /api/dashboard/refusals` returns: the log plus the two route fields. */
export interface RestraintPayload extends RefusalLog {
  window: string;
  autoApprovalEnabled: boolean;
}

interface Props {
  log: RestraintPayload;
  /**
   * Which view this is. Passed rather than derived: `scopeLine` needs it, and
   * the alternative — inferring it from `archivedLocations !== null` — couples
   * the sentence an owner reads to the nullability of a footnote field, so a
   * later change to the read would flip the claim silently.
   */
  scope: 'account' | 'location';
  /** The routed Analytics tab bar. */
  tabs: ReactNode;
  /** The window selector. */
  periodToolbar: ReactNode;
}

/**
 * The **Restraint tab**'s presentation half: the window's total **Refusal**
 * count, its breakdown by **Refusal category** newest-first within each, and
 * every owner-facing sentence on the surface.
 *
 * THE SENTENCES LIVE HERE BY EXPLICIT BOUNDARY. `src/lib/refusals/vocabulary.ts`
 * states it at :30-33 — "There is no owner label table and no sentence copy —
 * the Restraint tab (#1014) owns all of that, and a label map here would make a
 * wording change a vocabulary change." Do not move it back.
 *
 * LINKS ONLY, NO WRITES. A held draft links to its review and shows no draft
 * text, no review text and no moderation reason (ADR 0023).
 */

/**
 * The owner-facing sentence for each **Refusal category**.
 *
 * IT CARRIES SENTENCES ONLY — NO LINK COLUMN, and that absence is the fix for
 * the sharpest defect plan round 1 found. Link authority is per-LANE, and a
 * **Refusal category** does not carry the lane: `held_draft` maps to
 * `unsafe_content` and so does `policy_gate_held`'s `moderation_flagged`, while
 * migration 116's CHECK C1 gives BOTH a `response` subject. A `link` column here
 * would therefore hand a policy-gate row the same review link a held draft gets
 * — a link to a draft the owner was never asked to review — and every promised
 * test would still pass, because they exercise a held-draft link and a no-link
 * category, never the collision.
 *
 * Links come from `entry.linkKind`, resolved server-side in `read.ts`
 * (invariant I14). This component turns a `linkKind` into a URL and decides
 * nothing about authority.
 */
const CATEGORY_COPY: Record<RefusalCategory, string> = {
  unsafe_content: 'We held a reply back because it was not safe to send.',
  watchdog_unavailable: 'We did not post because our reviewer was unavailable.',
  below_our_bar: 'We did not send a message that was not good enough.',
  no_permission: 'We did not contact someone who had not agreed to hear from us.',
  wrong_moment: 'We waited because it was not the right moment.',
  autonomy_paused: 'We stopped acting on your behalf.',
  missing_information: 'We stopped because we did not have what we needed.',
  owner_review_required: 'We sent a reply to you for review instead of posting it.',
};

/** The short heading above each group's rows. */
const CATEGORY_HEADING: Record<RefusalCategory, string> = {
  unsafe_content: 'Not safe to send',
  watchdog_unavailable: 'Could not be checked',
  below_our_bar: 'Not good enough',
  no_permission: 'No permission to contact',
  wrong_moment: 'Not the right moment',
  autonomy_paused: 'Acting on your behalf paused',
  missing_information: 'Missing information',
  owner_review_required: 'Sent to you for review',
};

const LINK_LABEL = {
  review: 'See the review',
  'auto-approval': 'Automatic posting settings',
  contacts: 'See your contacts',
} as const;

/**
 * `linkKind` → href. Presentation only; the authority decision already happened
 * server-side. `null` covers BOTH "this category links nowhere" and "the subject
 * aged away" — the tab drops the LINK, never the row, because the category and
 * `occurredAt` stay true either way.
 */
function hrefFor(entry: RefusalLogEntry): string | null {
  switch (entry.linkKind) {
    case 'review':
      return entry.subjectId ? `/dashboard/reviews/${encodeURIComponent(entry.subjectId)}` : null;
    case 'auto-approval':
      return '/settings/auto-approval';
    case 'contacts':
      return '/dashboard/contacts';
    case null:
      return null;
  }
}

// ── The contingent lines ────────────────────────────────────────────────────

/** **Coverage start** — a claim about the LEDGER, never about the account. */
function coverageLine(log: RestraintPayload): string | null {
  // `businesses.created_at` is nullable (migration 001). Omit rather than name a
  // date we do not have.
  if (!log.coverageStart) return null;
  return `We have been watching since ${formatDate(log.coverageStart)}.`;
}

/**
 * The lane that is not yet recording.
 *
 * `policy_gate_held` is SILENT whenever `AUTO_APPROVAL_ENABLED` is off, which is
 * production today: the flag off makes `auto_approval_disabled` a STRUCTURAL
 * gate, so no policy row is read and the lane writes zero rows — not few, zero.
 * Merging every write site does not start it; the flag does (#1013 D4).
 * Rendering one account-wide **Coverage start** without saying so would claim
 * account-created coverage for a lane that has never been able to write, which
 * `CONTEXT.md` forbids.
 */
function policyGateLine(autoApprovalEnabled: boolean): string | null {
  if (autoApprovalEnabled) return null;
  return 'One kind of decision — a reply an automatic policy check holds — is only recorded once automatic posting is switched on. It is off for your account today.';
}

/**
 * The empty window.
 *
 * SCOPED TO THE WINDOW, and that is the whole point. The parked branch read "We
 * did not hold anything back… Everything we were asked to do, we did." #1000
 * retired that PERMANENTLY: #1002's pre-ledger tail and #996's 180-day floor
 * leave holes the ledger never closes, so no Restraint surface may make a claim
 * about all time.
 */
function emptyLine(log: RestraintPayload): string {
  return `We did not hold anything back between ${formatDate(log.windowStart)} and ${formatDate(log.windowEnd)}.`;
}

/**
 * The archived-location footnote. Account view only — a location view shows one
 * ACTIVE location and hides nothing.
 *
 * NO LINK AND NO INSTRUCTION (#1005). Reactivation runs `assertCanAddLocation`,
 * which can DENY, and enqueues a Stripe increment. A trust surface does not sell
 * a billed, refusable action to show a number.
 */
function archivedFootnote(summary: ArchivedLocationSummary | null): string | null {
  if (!summary || summary.refusalCount === 0) return null;
  const locations = summary.locationCount === 1
    ? '1 archived location'
    : `${summary.locationCount} archived locations`;
  return `${summary.refusalCount} more from ${locations} are not shown.`;
}

/**
 * Without this line a reactivated location reads flat-then-spike under a
 * **Coverage start** claiming we watched throughout — the false zero one layer
 * down, at the PERIOD rather than the lane.
 */
function archivedPeriodLine(period: ArchivedPeriod): string {
  const end = period.reactivatedAt ? formatDate(period.reactivatedAt) : 'now';
  return `This location was archived from ${formatDate(period.archivedAt)} to ${end}. We watched nothing while it was archived, and caught up when it came back.`;
}

/**
 * WHICH NUMBER THIS IS.
 *
 * An account-wide suspension carries `business_id IS NULL` (migration 116, C3),
 * and the per-location scope admits it, so ONE suspension appears under every
 * location once each AND once in the account total. A per-location sum therefore
 * LEGITIMATELY exceeds the account total. `CONTEXT.md` requires the tab to say
 * which number it shows; #1014's body claimed the two always reconcile, which is
 * false (deviation D3).
 */
function scopeLine(kind: 'account' | 'location'): string {
  return kind === 'account'
    ? 'This is your whole account. Pauses that affect every location are counted once here.'
    : 'This is one location. Pauses that affect every location are counted here and at each of your other locations.';
}

// ── Grouping ────────────────────────────────────────────────────────────────

interface CategoryGroup {
  category: RefusalCategory;
  entries: RefusalLogEntry[];
}

/**
 * Group the flat entry list by **Refusal category**, newest first within each.
 *
 * The GROUP order is `REFUSAL_CATEGORIES`' own declaration order — safety
 * first — and never the order the rows happened to arrive in, so two owners
 * with the same categories read the same page in the same shape. The ROW order
 * is re-sorted here rather than trusted: the read already orders newest-first,
 * but this component is also rendered from fixtures and from a cached payload,
 * and a promised test feeds it deliberately unsorted input.
 */
function groupByCategory(entries: RefusalLogEntry[]): CategoryGroup[] {
  return REFUSAL_CATEGORIES
    .map((category) => ({
      category,
      entries: entries
        .filter((entry) => entry.category === category)
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
    }))
    .filter((group) => group.entries.length > 0);
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Module-scope formatter: building an `Intl` formatter per render is the
 * no-locale-format-in-render hotspot (`BatchReport.tsx` states the same rule).
 *
 * UTC because the stamp is a server instant and a viewer's zone must not slide a
 * Refusal onto a different day. The LOCALE is pinned rather than left to the
 * machine: an unpinned formatter renders "30 Aug 2026" on one developer's box
 * and "Aug 30, 2026" on another, which makes an assertion on the rendered text
 * pass or fail by environment.
 */
const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function formatDate(iso: string): string {
  return DAY_FORMAT.format(new Date(iso));
}

/** `.section-enter-1` is the summary card, so groups start at 2 and hold at the
 *  last step console.css defines rather than emitting a class it never wrote. */
function enterStagger(index: number): string {
  return `section-enter-${Math.min(index + 2, 6)}`;
}

// ── The component ───────────────────────────────────────────────────────────

export function RestraintReport({ log, scope, tabs, periodToolbar }: Props) {
  const groups = groupByCategory(log.entries);
  const coverage = coverageLine(log);
  const policyGate = policyGateLine(log.autoApprovalEnabled);
  const footnote = archivedFootnote(log.archivedLocations);

  return (
    <>
      <TopBar title="Analytics">{periodToolbar}</TopBar>
      <div className="content content--analytics">
        {tabs}
        <LiveRegion message="Restraint record ready." />
        <div className="rst-stack">
          <section
            className="card rst-summary section-enter section-enter-1"
            aria-labelledby="rst-summary-heading"
          >
            <h2 className="card-h2" id="rst-summary-heading">
              What we held back
            </h2>

            {log.total === 0 ? (
              // The empty window is a FACT, not an error and not an empty grid.
              // It is scoped to the window and makes no claim about all time.
              <p className="rst-summary-empty">{emptyLine(log)}</p>
            ) : (
              <>
                <p className="rst-summary-line">
                  <span className="rst-summary-count">{log.total}</span>
                  <span className="rst-summary-cap">
                    {log.total === 1 ? 'thing' : 'things'} we chose not to do
                    between {formatDate(log.windowStart)} and {formatDate(log.windowEnd)}
                  </span>
                </p>
                <p className="rst-summary-sub">
                  Grouped by what stopped us, newest first. None of it was sent.
                </p>
              </>
            )}

            <p className="rst-note rst-note-scope">{scopeLine(scope)}</p>
            {coverage && <p className="rst-note">{coverage}</p>}
            {policyGate && <p className="rst-note">{policyGate}</p>}
            {footnote && <p className="rst-note rst-note-footnote">{footnote}</p>}
            {log.archivedPeriods.map((period) => (
              <p className="rst-note" key={`${period.archivedAt}-${period.reactivatedAt ?? 'open'}`}>
                {archivedPeriodLine(period)}
              </p>
            ))}
          </section>

          {groups.map((group, index) => (
            <CategorySection key={group.category} group={group} index={index} />
          ))}
        </div>
      </div>
    </>
  );
}

/** One heading per **Refusal category** that actually held something. */
function CategorySection({ group, index }: { group: CategoryGroup; index: number }) {
  const headingId = `rst-group-${group.category}`;

  return (
    <section
      className={`card rst-group section-enter ${enterStagger(index)}`}
      aria-labelledby={headingId}
    >
      <div className="rst-group-head">
        <h2 className="rst-group-title" id={headingId}>
          {CATEGORY_HEADING[group.category]}
        </h2>
        <span className="rst-group-count">
          {group.entries.length} {group.entries.length === 1 ? 'time' : 'times'}
        </span>
      </div>
      {/* The owner's own sentence for this category. Never a re-worded copy:
          the words are the contract. */}
      <p className="rst-group-sentence">{CATEGORY_COPY[group.category]}</p>
      <ul className="rst-rows">
        {group.entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function EntryRow({ entry }: { entry: RefusalLogEntry }) {
  const href = hrefFor(entry);

  return (
    <li className="rst-row">
      <time className="rst-row-when" dateTime={entry.occurredAt} data-testid="refusal-date">
        {formatDate(entry.occurredAt)}
      </time>
      {href !== null && (
        <Link className="rst-row-link" href={href}>
          {LINK_LABEL[entry.linkKind as keyof typeof LINK_LABEL]}
        </Link>
      )}
    </li>
  );
}
