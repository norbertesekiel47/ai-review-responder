'use client';

import Link from 'next/link';
import type { Vertical, WithholdReason } from '@/lib/solicitation/restraint-policy';
import type { AskRow, BatchView, WithholdGroup } from '@/lib/solicitation/batch-view';
import './requests.css';

/**
 * The built Solicitation batch, as the owner reads it (#544): a funnel hero
 * over the spoilage report — every withheld Ask grouped by its withhold
 * reason, in the closed enum's precedence order.
 *
 * Pure presentation. Everything it renders comes from one `BatchView`, so the
 * hero and the ledger cannot disagree; fetching, polling and the reviewed_at
 * ping live in RequestsClient.
 *
 * ADR 0012 — no star rating, sentiment, or predicted-sentiment signal appears
 * here. `already_reviewed` evidence shows the review DATE only, and no
 * evidence line ever renders an internal id (review_id, batch_id, upload_id)
 * as owner-facing text.
 */

type BuiltBatch = Extract<BatchView, { state: 'built' }>;

/** Owner-readable gloss for each verbatim code. The CODES come from
 *  WITHHOLD_REASONS — re-typing them as string literals here would fork the
 *  closed enum. `velocity_banked` is volume shaping, not a refusal, which is
 *  why it is the one 'bank'-toned reason. */
const REASON_META: Record<
  WithholdReason,
  { label: string; tone: 'hold' | 'bank' }
> = {
  no_consent: { label: 'Not covered by your consent attestation', tone: 'hold' },
  suppressed: { label: 'Marked never-contact', tone: 'hold' },
  already_reviewed: { label: 'Already left a review', tone: 'hold' },
  stale_visit: { label: 'Visit is too old to ask about', tone: 'hold' },
  over_contacted: { label: 'Asked too recently', tone: 'hold' },
  velocity_banked: { label: 'Saved for the next batch', tone: 'bank' },
};

const COUNT_NOUN: Record<'hold' | 'bank', string> = {
  hold: 'held back',
  bank: 'banked',
};

/**
 * Owner-readable gloss for the second closed enum on this surface. `Vertical` is
 * an internal classification, not a code the owner is meant to learn — unlike
 * the withhold reasons, it is never rendered verbatim. Keyed
 * `Record<Vertical, string>` so a drifted enum is a compile error, and `other`
 * (an unmapped `businesses.category`) reads as a trade rather than as the word
 * "other".
 */
const VERTICAL_LABEL: Record<Vertical, string> = {
  food_and_drink: 'food and drink',
  retail: 'retail',
  personal_care: 'personal care',
  fitness: 'fitness',
  medical_dental: 'medical and dental',
  automotive: 'automotive',
  home_services: 'home services',
  other: 'your trade',
};

export function BatchReport({ view }: { view: BuiltBatch }) {
  return (
    <div className="rq-stack">
      <FunnelHero view={view} />

      <section className="card section-enter section-enter-2">
        <h2 className="card-h2">Held back</h2>
        <p className="rq-ledger-sub">
          Every hold has exactly one reason, checked in a fixed order. Reasons
          that held nobody are listed too, so you can see the whole rule set.
        </p>
        {view.groups.map((group) => (
          <ReasonGroup key={group.reason} group={group} />
        ))}
      </section>

      <p className="rq-footnote">
        Rows that failed validation when you uploaded the file never reached
        these checks and are not held back — they are listed in the{' '}
        <Link className="rq-footnote-link" href="/dashboard/requests/contacts">
          upload report
        </Link>
        .
      </p>
    </div>
  );
}

function FunnelHero({ view }: { view: BuiltBatch }) {
  return (
    <section className="card section-enter section-enter-1">
      <div className="rq-hero-head">
        <h2 className="card-h2" style={{ marginBottom: 0 }}>
          Latest batch
        </h2>
        <span className="rq-watch-pill">Watch-mode · nothing sent</span>
      </div>
      <p className="rq-built">{relativeBuildTime(view.builtAt)}</p>

      <ol className="rq-funnel" aria-label="Batch funnel">
        <Rung value={view.evaluated} caption="candidates evaluated" />
        <Rung value={view.held} caption="held back" tone="hold" />
        <Rung value={view.queued} caption="would have been sent" tone="send" />
      </ol>

      <p className="rq-fact">
        <span className="rq-fact-lead">
          {NUMBER_FORMAT.format(view.contactsOnFile)} contacts on file
        </span>{' '}
        — that is your list right now, and it keeps changing as you upload. The
        batch numbers above were fixed when the batch was built.
      </p>
    </section>
  );
}

function Rung({
  value,
  caption,
  tone,
}: {
  value: number;
  caption: string;
  tone?: 'hold' | 'send';
}) {
  return (
    <li className={`rq-rung${tone ? ` rq-rung--${tone}` : ''}`}>
      <span className="rq-rung-num">{NUMBER_FORMAT.format(value)}</span>
      <span className="rq-rung-cap">{caption}</span>
    </li>
  );
}

function ReasonGroup({ group }: { group: WithholdGroup }) {
  const { label, tone } = REASON_META[group.reason];
  const headingId = `rq-group-${group.reason}`;
  const remaining = group.total - group.sample.length;

  return (
    <section className="rq-group" aria-labelledby={headingId}>
      <div className="rq-group-head">
        <h3 className="rq-group-title" id={headingId}>
          <span className={`rq-chip rq-chip--${tone}`}>{group.reason}</span>
          <span className="rq-group-label">{label}</span>
        </h3>
        <span className="rq-group-count">
          {group.total} {COUNT_NOUN[tone]}
        </span>
      </div>

      {group.total === 0 ? (
        <p className="rq-empty">Nobody this batch.</p>
      ) : (
        <>
          <ul className="rq-rows">
            {group.sample.map((row) => (
              <li key={row.askId} className="rq-row">
                <span className="rq-row-name">
                  {row.contactName || 'Unnamed contact'}
                </span>
                <span className="rq-row-evidence">{evidenceLine(row)}</span>
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <p className="rq-more">…and {remaining} more</p>
          )}
        </>
      )}
    </section>
  );
}

// ── Evidence copy ───────────────────────────────────────────────────────────

/**
 * One sentence per Evidence snapshot, from the stored decision envelope.
 * Internal ids in the snapshot (upload_id, review_id, prior_batch_id,
 * ordering_basis.contact_id) are deliberately not rendered — they identify
 * rows for support, not for owners.
 */
function evidenceLine(row: AskRow): string {
  const { evidence } = row;
  // Rows in a withheld group are withholds by construction; the send branch is
  // here so a mislabelled row degrades to a true sentence instead of crashing.
  if (evidence.decision === 'send') return 'Passed every check.';

  switch (evidence.reason) {
    case 'no_consent':
      return 'Not covered by the consent attestation on the upload this row came from.';
    case 'suppressed':
      return `Marked never-contact (${evidence.suppression_source}) on ${formatDay(evidence.suppressed_at)}.`;
    case 'already_reviewed':
      // ADR 0012: the matched review's DATE only — never its rating.
      return `Matched to a review from ${formatDay(evidence.review_date)} · rating not shown, by design.`;
    case 'stale_visit': {
      const matched = evidence.matched_keyword
        ? ` (matched “${evidence.matched_keyword}”)`
        : '';
      return `Visited ${formatDay(evidence.last_visit_date)}, ${evidence.days_since_visit} days ago · past the ${evidence.freshness_window_days}-day window for ${VERTICAL_LABEL[evidence.vertical]}${matched}.`;
    }
    case 'over_contacted':
      return `Already in a batch on ${formatDay(evidence.prior_decision_at)} · ${evidence.min_gap_days}-day minimum gap between asks.`;
    case 'velocity_banked':
      return `Passed every check · batch cap of ${evidence.batch_cap} reached with ${evidence.eligible_count} eligible · first in line for the next batch.`;
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Module-scope formatters: building an Intl formatter per render is the
 *  no-locale-format-in-render hotspot (ContactList.tsx follows the same rule). */
const NUMBER_FORMAT = new Intl.NumberFormat();
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const RELATIVE_FORMAT = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Timestamps arrive as Postgres `::text` ("2026-07-22 12:00:00+00") or as ISO
 * strings from the stored evidence; evidence dates are plain `YYYY-MM-DD`.
 * Returns null rather than an Invalid Date so callers render the raw value.
 */
function parseTimestamp(value: string): Date | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00Z`
    : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDay(value: string): string {
  const parsed = parseTimestamp(value);
  return parsed === null ? value : DAY_FORMAT.format(parsed);
}

/**
 * "Built 3 days ago". Deliberately relative and deliberately unconditional:
 * watch-mode has no staleness threshold and no expiry banner — a batch is
 * never presented as out of date (the `expired` lifecycle state belongs to
 * send-mode).
 */
function relativeBuildTime(builtAt: string): string {
  const parsed = parseTimestamp(builtAt);
  if (parsed === null) return `Built ${builtAt}`;

  const elapsed = Date.now() - parsed.getTime();
  if (elapsed < HOUR_MS) {
    return `Built ${RELATIVE_FORMAT.format(-Math.round(elapsed / 60_000), 'minute')}`;
  }
  if (elapsed < DAY_MS) {
    return `Built ${RELATIVE_FORMAT.format(-Math.round(elapsed / HOUR_MS), 'hour')}`;
  }
  return `Built ${RELATIVE_FORMAT.format(-Math.round(elapsed / DAY_MS), 'day')}`;
}
