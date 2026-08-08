'use client';

import Link from 'next/link';
import { uniqueSiblingKey } from '@/lib/shared/unique-sibling-key';
import { AutoApprovedBadge } from '@/components/dashboard/reviews/AutoApprovedBadge';
import { InlineGeneratePanel } from '@/components/dashboard/reviews/InlineGeneratePanel';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { ApprovalMethod } from '@/lib/auto-approval/types';
import type { ProvenanceBadge, ReviewRowState } from '@/lib/past-replies/replies-view';
import type { RegenBudgetStatus } from '@/lib/costs/tracker';

// PastReplyRow is the wire shape flowing from page.tsx → PastRepliesClient →
// PastReplyCard → EditReplyDrawer. Fields with `?` are added by the edit
// feature (Tasks 9-12); the drawer uses them for snapshot + recovery.
export interface PastReplyRow {
  review_id: string;
  review_text: string | null;
  review_date: string;
  reviewer_name: string | null;
  star_rating: number | null;
  /**
   * NULL for a never-replied review (#678, D15). The Reviews list LEFT JOINs
   * `responses`, and `resp.id IS NULL` IS the unanswered predicate — the same
   * NULL `deriveRowState` branches on. Do not "simplify" it back to `string`:
   * that type was true only while the list contained posted replies alone.
   */
  response_id: string | null;
  approved_text: string | null;
  approval_method: ApprovalMethod | null;
  posted_at: string | null;
  external_reply_ingested_at: string | null;
  /**
   * What the row offers, DERIVED SERVER-SIDE by `deriveRowState`
   * (`src/lib/past-replies/replies-view.ts`) — the card renders it, it never
   * computes one (D-D). Typed `string` at this wire boundary and narrowed once,
   * in `ReplySide`, so every "never offer Generate on X" rule stays in the one
   * module that owns it.
   */
  row_state: string;
  /** Server-derived `ProvenanceBadge` (D-E); null when no provenance applies. */
  provenance_badge?: string | null;
  // Optimistic-concurrency snapshot (required by EditReplyDrawer).
  review_content_hash?: string | null;
  version?: number | null;
  // Server-computed edit eligibility. Both paid launch tiers may edit history.
  canEdit?: boolean;
  // Recoverable failed sibling attached by the LATERAL sidecar query.
  failed_response_id?: string | null;
  failed_posting_error?: string | null;
}

interface Props {
  row: PastReplyRow;
  isImported: boolean;
  /** Optional: search query to highlight inside review + reply bodies. */
  query?: string;
  // Edit feature — all optional so the card is backward-compatible when the
  // flag is off (flag-off ⇒ no edit props passed ⇒ read-only, identical to today).
  editRepliesEnabled?: boolean;
  /**
   * Advisory per-review regeneration counter for an ANSWERED row.
   *
   * OPTIONAL on purpose (F6): `undefined` means UNKNOWN — the batched peek
   * failed open and returned no entry — and must render NO counter with the
   * button ENABLED. Reading a missing entry as "0 remaining" would disable
   * every Regenerate in the list during an Upstash outage, which is the exact
   * inversion the fail-open peek exists to prevent.
   */
  regenBudget?: RegenBudgetStatus;
  onEditClick?: (row: PastReplyRow) => void;
  onRecoveryClick?: (row: PastReplyRow) => void;
}

/** Owner-facing copy for each server-derived provenance badge (S3 / D-E). */
const PROVENANCE_LABEL: Record<ProvenanceBadge, string> = {
  posted_before_joining: 'Posted by you before joining',
  replied_on_google: 'Replied on Google',
  auto_approved: 'Auto-approved',
  owner_approved: 'You approved',
};

function provenanceLabel(badge: string | null | undefined): string | null {
  if (!badge) return null;
  return PROVENANCE_LABEL[badge as ProvenanceBadge] ?? null;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Stars({ rating }: { rating: number | null }) {
  if (rating == null) return null;
  const filled = Math.round(Math.max(0, Math.min(5, rating)));
  return (
    <span className="stars" aria-label={`${filled} stars`}>
      {'★'.repeat(filled)}
      <span style={{ opacity: 0.25 }}>{'★'.repeat(5 - filled)}</span>
    </span>
  );
}

function highlight(text: string | null, query?: string) {
  if (!text) return null;
  if (!query) return text;
  const trimmed = query.trim();
  if (!trimmed) return text;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  const seen = new Map<string, number>();
  return text.split(re).map((part) => {
    const isMatch = part.toLocaleLowerCase() === trimmed.toLocaleLowerCase();
    const key = uniqueSiblingKey(seen, `${isMatch ? 'mark' : 'text'}:${part}`);

    return isMatch ? (
      <mark key={key} className="pr-mark">
        {part}
      </mark>
    ) : (
      <span key={key}>{part}</span>
    );
  });
}

export function PastReplyCard({
  row,
  isImported,
  query,
  editRepliesEnabled = false,
  regenBudget,
  onEditClick,
  onRecoveryClick,
}: Props) {
  return (
    <article className="pr-card">
      <div className="pr-card-grid">
        <ReviewSide row={row} query={query} />
        <ReplySide
          row={row}
          isImported={isImported}
          query={query}
          editRepliesEnabled={editRepliesEnabled}
          regenBudget={regenBudget}
          onEditClick={onEditClick}
          onRecoveryClick={onRecoveryClick}
        />
      </div>
    </article>
  );
}

function ReviewSide({ row, query }: { row: PastReplyRow; query?: string }) {
  return (
    <div className="pr-side pr-side-review">
      <div className="pr-side-eyebrow">
        <Icon name="google" size={12} /> Customer review
      </div>
      <div className="pr-meta">
        <Stars rating={row.star_rating} />
        <span className="pr-name">{row.reviewer_name ?? 'Anonymous'}</span>
        <span className="pr-date">{fmt(row.review_date)}</span>
      </div>
      {row.review_text ? (
        <p className="pr-body">{highlight(row.review_text, query)}</p>
      ) : (
        <p className="pr-body italic">No review text — rating only.</p>
      )}
    </div>
  );
}

/**
 * The reply half of the card, dispatched on the SERVER-derived row state.
 *
 * The `switch` is the whole rendering contract: six states, no derivation, and
 * a `never`-typed default so a seventh member of `ReviewRowState` fails
 * typecheck instead of rendering a blank half-card. The single cast is the wire
 * boundary — `row_state` arrives as a string over the server→client seam and
 * `deriveRowState` is its only writer.
 */
function ReplySide({
  row,
  isImported,
  query,
  editRepliesEnabled,
  regenBudget,
  onEditClick,
  onRecoveryClick,
}: Props) {
  const state = row.row_state as ReviewRowState;

  switch (state) {
    case 'regenerate':
      return (
        <div className="pr-side pr-side-reply">
          <ReplyEyebrow />
          <ReplyBody row={row} query={query} />
          <Provenance row={row} isImported={isImported} />
          <AnsweredControls
            row={row}
            editRepliesEnabled={editRepliesEnabled}
            regenBudget={regenBudget}
            onEditClick={onEditClick}
            onRecoveryClick={onRecoveryClick}
          />
        </div>
      );

    case 'recover':
      return (
        <div className="pr-side pr-side-reply">
          <ReplyEyebrow />
          <ReplyBody row={row} query={query} />
          <Provenance row={row} isImported={isImported} />
          {/* D-G: an orphan reaches /retry or /restore-original and is never
              offered Generate — a first draft here would race recovery. */}
          <RecoveryControl
            row={row}
            editRepliesEnabled={editRepliesEnabled}
            onRecoveryClick={onRecoveryClick}
          />
        </div>
      );

    case 'draft_ready':
      // S2: the review is in BOTH surfaces. Here it is a cross-link to the
      // Needs Action queue that owns the approve/edit decision — never a second
      // LLM spend the partial unique index (023+026+029) would reject.
      return (
        <div className="pr-side pr-side-reply">
          <div className="pr-side-eyebrow reply">
            <Icon name="sparkle" size={12} /> Draft waiting for you
          </div>
          <p className="pr-body italic">
            A draft reply is ready to approve in Needs Action.
          </p>
          <div className="pr-gen-row">
            <Link href="/dashboard/reviews" className="pr-draft-link">
              <Icon name="inbox" size={12} aria-hidden="true" />
              Draft ready
            </Link>
          </div>
        </div>
      );

    case 'held':
      // Invariant #4 / D9: a high-severity moderation flag holds the draft.
      // No text, no button, no cross-link — Needs Action does not surface held
      // drafts either, so a cross-link would lead nowhere. The owner's only
      // path back is an admin disposition at /admin/flagged.
      return (
        <div className="pr-side pr-side-reply">
          <div className="pr-side-eyebrow reply">
            <Icon name="shield" size={12} /> Reply on hold
          </div>
          <p className="pr-body italic">
            We are double-checking this draft before anything is posted.
          </p>
          <div className="pr-prov">
            <span className="pr-prov-badge pr-prov-held">
              <Icon name="clock" size={10} /> Under review
            </span>
          </div>
        </div>
      );

    case 'generating':
    case 'generate':
      return (
        <div className="pr-side pr-side-reply">
          <div className="pr-side-eyebrow reply">
            <Icon name="sparkle" size={12} /> No reply yet
          </div>
          <p className="pr-body italic">This review has no reply on Google.</p>
          {/* The panel owns the poller, so it mounts only for the two states
              that can be generating (D-C: `generating` resumes after a refresh). */}
          <InlineGeneratePanel
            reviewId={row.review_id}
            resumeGenerating={state === 'generating'}
          />
        </div>
      );

    default: {
      // A seventh ReviewRowState must be rendered above, not fall through here.
      const unreachable: never = state;
      return unreachable;
    }
  }
}

function ReplyEyebrow() {
  return (
    <div className="pr-side-eyebrow reply">
      <Icon name="sparkle" size={12} /> Your reply on Google
    </div>
  );
}

function ReplyBody({ row, query }: { row: PastReplyRow; query?: string }) {
  return row.approved_text ? (
    <p className="pr-body">{highlight(row.approved_text, query)}</p>
  ) : (
    <p className="pr-body italic">(no reply text)</p>
  );
}

function Provenance({ row, isImported }: { row: PastReplyRow; isImported: boolean }) {
  // D-D: read the SERVER-derived state, never re-derive it. `recover` IS the
  // orphan state (`deriveRowState`, replies-view.ts). The old local predicate
  // (`failed_response_id` set + `posted_at` null) agreed with it only by
  // coincidence of two independent invariants, and `responses.posted_at` is
  // nullable in general.
  const isOrphanRecovery = row.row_state === 'recover';

  if (isOrphanRecovery) {
    return (
      <div className="pr-prov">
        <span className="pr-prov-badge pr-prov-recovery">
          <Icon name="history" size={10} /> Pending recovery
        </span>
      </div>
    );
  }

  // The server-derived badge answers "why are we showing this reply" in one
  // string (S3), so it REPLACES the imported/RepWorth pair rather than joining
  // it. It is legitimately null for a posted reply with no recorded approval
  // method and no external ingest, which is what the fallback below covers —
  // not a compatibility shim.
  const label = provenanceLabel(row.provenance_badge);
  if (label) {
    return (
      <div className="pr-prov">
        <span
          className={`pr-prov-badge ${
            row.external_reply_ingested_at !== null ? 'pr-prov-imported' : 'pr-prov-repworth'
          }`}
        >
          <Icon name={row.external_reply_ingested_at !== null ? 'history' : 'check'} size={10} />{' '}
          {label}
        </span>
        {row.posted_at && <span>· {fmt(row.posted_at)}</span>}
      </div>
    );
  }

  return (
    <div className="pr-prov">
      <span className={`pr-prov-badge ${isImported ? 'pr-prov-imported' : 'pr-prov-repworth'}`}>
        {isImported ? (
          <>
            <Icon name="history" size={10} /> Imported
          </>
        ) : (
          <>
            <Icon name="check" size={10} /> Posted via RepWorth
          </>
        )}
      </span>
      <AutoApprovedBadge method={row.approval_method} variant="provenance" />
      {row.posted_at && <span>· {fmt(row.posted_at)}</span>}
    </div>
  );
}

/**
 * Controls for an answered row. Precedence is unchanged from the pre-#678 card:
 * a recoverable failed sibling outranks everything, then edit eligibility.
 * `Regenerate` replaces a LIVE Google reply, so it stays behind
 * EDIT_REPLIES_ENABLED (#669) and opens the two-pane EditReplyDrawer.
 */
function AnsweredControls({
  row,
  editRepliesEnabled,
  regenBudget,
  onEditClick,
  onRecoveryClick,
}: {
  row: PastReplyRow;
  editRepliesEnabled?: boolean;
  regenBudget?: RegenBudgetStatus;
  onEditClick?: (row: PastReplyRow) => void;
  onRecoveryClick?: (row: PastReplyRow) => void;
}) {
  if (!editRepliesEnabled) return null;

  if (row.failed_response_id) {
    return (
      <RecoveryControl
        row={row}
        editRepliesEnabled={editRepliesEnabled}
        onRecoveryClick={onRecoveryClick}
      />
    );
  }

  if (!row.canEdit) {
    return (
      <div className="pr-edit-row">
        <span className="pr-edit-lock" aria-label="This historical reply cannot be edited">
          <LockIcon />
          Editing unavailable
        </span>
      </div>
    );
  }

  const exhausted = regenBudget != null && regenBudget.remaining === 0;

  return (
    <div className="pr-edit-row">
      <button
        type="button"
        onClick={() => onEditClick?.(row)}
        className="pr-edit-btn"
        disabled={exhausted}
        aria-label="Regenerate this reply"
      >
        <Icon name="regenerate" size={12} aria-hidden="true" />
        Regenerate
      </button>
      {/* No counter at all when the budget is UNKNOWN (F6). */}
      {regenBudget && (
        <span className="pr-regen-count">
          {regenBudget.used} of {regenBudget.limit} today
        </span>
      )}
    </div>
  );
}

function RecoveryControl({
  row,
  editRepliesEnabled,
  onRecoveryClick,
}: {
  row: PastReplyRow;
  editRepliesEnabled?: boolean;
  onRecoveryClick?: (row: PastReplyRow) => void;
}) {
  if (!editRepliesEnabled || !row.failed_response_id) return null;

  return (
    <div className="pr-edit-row">
      <button
        type="button"
        onClick={() => onRecoveryClick?.(row)}
        className="pr-recovery-btn"
        aria-label="This reply needs attention — click to retry or restore"
      >
        <WarningIcon />
        This reply needs attention
      </button>
    </div>
  );
}

function WarningIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}
