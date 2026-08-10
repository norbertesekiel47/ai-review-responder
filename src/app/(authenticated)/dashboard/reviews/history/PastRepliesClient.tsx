'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PastReplyCard } from '@/components/dashboard/reviews/PastReplyCard';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';
import { EditReplyDrawer } from '@/components/dashboard/reviews/EditReplyDrawer';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { RegenBudgetStatus } from '@/lib/costs/tracker';

/**
 * The **Reviews list** surface: every review for the location, grouped
 * `Unanswered` then `Answered` (#678). The pre-#678 gap/historical split is
 * gone — the activation boundary survives only as the per-row provenance badge
 * the server derives, so this component has no bucketing arithmetic left.
 */
interface Props {
  unansweredRows: PastReplyRow[];
  answeredRows: PastReplyRow[];
  /** Denominators over ALL reviews for the location, not just this page. */
  unansweredTotal: number;
  answeredTotal: number;
  avgStarRating: number | null;
  /**
   * Advisory per-review regeneration counters keyed by `review_id`, for
   * ANSWERED rows only. A plain RECORD, not a `Map` (D12): this prop crosses
   * the server→client boundary and a `Map` does not serialize.
   *
   * A MISSING key means UNKNOWN, never "0 remaining" — the card then renders no
   * counter and leaves Regenerate enabled (F6).
   */
  regenBudgets: Record<string, RegenBudgetStatus>;
  page: number;
  totalPages: number;
  // Passed from the server page — true only when EDIT_REPLIES_ENABLED is on.
  // When false the answered rows are read-only (the live-Google mutation is the
  // only thing this flag gates; Generate is deliberately ungated).
  editRepliesEnabled?: boolean;
}

type RatingFilter = 'all' | 1 | 2 | 3 | 4 | 5;

function matchesReplyFilter(row: PastReplyRow, rating: RatingFilter, normalizedQuery: string) {
  if (rating !== 'all' && row.star_rating !== rating) return false;
  if (!normalizedQuery) return true;
  return (
    (row.review_text ?? '').toLowerCase().includes(normalizedQuery) ||
    (row.approved_text ?? '').toLowerCase().includes(normalizedQuery) ||
    (row.reviewer_name ?? '').toLowerCase().includes(normalizedQuery)
  );
}

function useReplyFilters({
  unansweredRows,
  answeredRows,
  unansweredTotal,
  answeredTotal,
}: Pick<Props, 'unansweredRows' | 'answeredRows' | 'unansweredTotal' | 'answeredTotal'>) {
  const [query, setQuery] = useState('');
  const [rating, setRating] = useState<RatingFilter>('all');
  const normalizedQuery = query.trim().toLowerCase();
  const hasActiveFilter = rating !== 'all' || normalizedQuery.length > 0;
  const visibleUnanswered = useMemo(
    () => unansweredRows.filter((row) => matchesReplyFilter(row, rating, normalizedQuery)),
    [unansweredRows, normalizedQuery, rating],
  );
  const visibleAnswered = useMemo(
    () => answeredRows.filter((row) => matchesReplyFilter(row, rating, normalizedQuery)),
    [answeredRows, normalizedQuery, rating],
  );

  // Both group totals now span every review for the location, and orphan rows
  // are inside the unanswered denominator by construction (no posted sibling),
  // so the pre-#678 orphan reconciliation arithmetic is gone. While a filter is
  // active the header denominator is the filtered page, as before.
  return {
    hasActiveFilter,
    query,
    rating,
    setQuery,
    setRating,
    visibleUnanswered,
    visibleAnswered,
    unansweredSectionTotal: hasActiveFilter ? unansweredRows.length : unansweredTotal,
    answeredSectionTotal: hasActiveFilter ? answeredRows.length : answeredTotal,
  };
}

export function PastRepliesClient({
  unansweredRows,
  answeredRows,
  unansweredTotal,
  answeredTotal,
  avgStarRating,
  regenBudgets,
  page,
  totalPages,
  editRepliesEnabled = false,
}: Props) {
  const [drawerRow, setDrawerRow] = useState<PastReplyRow | null>(null);
  const [drawerMode, setDrawerMode] = useState<'edit' | 'recovery'>('edit');
  const totalReviews = unansweredTotal + answeredTotal;
  const filters = useReplyFilters({
    unansweredRows,
    answeredRows,
    unansweredTotal,
    answeredTotal,
  });
  const openDrawer = (row: PastReplyRow, mode: 'edit' | 'recovery') => {
    setDrawerRow(row);
    setDrawerMode(mode);
  };

  return (
    <div className="pr-content">
      <ReplyStats {...{ totalReviews, unansweredTotal, answeredTotal, avgStarRating }} />
      <ReplyToolbar
        query={filters.query}
        rating={filters.rating}
        onQueryChange={filters.setQuery}
        onRatingChange={filters.setRating}
      />
      <ReplySection
        title="Unanswered"
        rows={filters.visibleUnanswered}
        total={filters.unansweredSectionTotal}
        empty={emptyCopy('unanswered', filters.hasActiveFilter, totalReviews === 0)}
        query={filters.query}
        editRepliesEnabled={editRepliesEnabled}
        regenBudgets={regenBudgets}
        onOpenDrawer={openDrawer}
      />
      <ReplySection
        title="Answered"
        rows={filters.visibleAnswered}
        total={filters.answeredSectionTotal}
        empty={emptyCopy('answered', filters.hasActiveFilter, totalReviews === 0)}
        query={filters.query}
        editRepliesEnabled={editRepliesEnabled}
        regenBudgets={regenBudgets}
        onOpenDrawer={openDrawer}
      />
      <ReplyPagination {...{ totalReviews, page, totalPages }} />
      <ReplyDrawer
        enabled={editRepliesEnabled}
        row={drawerRow}
        mode={drawerMode}
        onClose={() => setDrawerRow(null)}
      />
    </div>
  );
}

function ReplyStats({
  totalReviews,
  unansweredTotal,
  answeredTotal,
  avgStarRating,
}: Pick<Props, 'unansweredTotal' | 'answeredTotal' | 'avgStarRating'> & { totalReviews: number }) {
  return (
    <div className="pr-stats">
      <Stat label="Total reviews" icon="google" value={totalReviews} />
      <Stat label="Unanswered" icon="inbox" value={unansweredTotal} />
      <Stat label="Answered" icon="check" value={answeredTotal} />
      <Stat
        label="Avg rating"
        icon="trend"
        value={avgStarRating != null ? avgStarRating.toFixed(1) : '—'}
        suffix={avgStarRating != null ? '★' : null}
      />
    </div>
  );
}

function ReplyToolbar({
  query,
  rating,
  onQueryChange,
  onRatingChange,
}: {
  query: string;
  rating: RatingFilter;
  onQueryChange: (query: string) => void;
  onRatingChange: (rating: RatingFilter) => void;
}) {
  return (
    <div className="pr-toolbar">
      <div className="pr-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          aria-label="Search past replies"
          type="text"
          placeholder="Search reviews and replies on this page…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            style={{ background: 'none', border: 'none', color: 'var(--rw-app-text-soft)', cursor: 'pointer', padding: 2 }}
            aria-label="Clear search"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      <div className="pr-chips" role="group" aria-label="Filter by rating">
        <button type="button" className={`pr-chip ${rating === 'all' ? 'active' : ''}`} aria-pressed={rating === 'all'} onClick={() => onRatingChange('all')}>
          All
        </button>
        {([5, 4, 3, 2, 1] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`pr-chip ${rating === value ? 'active' : ''}`}
            aria-pressed={rating === value}
            onClick={() => onRatingChange(value)}
          >
            {value}
            <span className="pr-chip-stars">★</span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface EmptyCopy {
  title: string;
  sub: string;
}

/**
 * Per-section empty copy. The two sections need DIFFERENT wording for the same
 * situation — an empty `Unanswered` on a working account is good news, an empty
 * `Answered` is just "nothing yet" — and the filtered strings name their
 * section so the page never shows the same sentence twice.
 */
function emptyCopy(
  section: 'unanswered' | 'answered',
  hasActiveFilter: boolean,
  noReviewsAtAll: boolean,
): EmptyCopy {
  if (hasActiveFilter) {
    return {
      title:
        section === 'unanswered'
          ? 'No unanswered reviews match this filter'
          : 'No replied reviews match this filter',
      sub: 'Try clearing your search, or pick a different rating chip.',
    };
  }
  if (noReviewsAtAll) {
    return {
      title: 'No reviews yet',
      sub: 'Your Google reviews will appear here as they come in.',
    };
  }
  return section === 'unanswered'
    ? {
        title: "You're all caught up",
        sub: 'Every review for this location already has a reply.',
      }
    : {
        title: 'No replies yet',
        sub: 'Approved replies will appear here as you respond to your reviews.',
      };
}

function ReplySection({
  title,
  rows,
  total,
  empty,
  query,
  editRepliesEnabled,
  regenBudgets,
  onOpenDrawer,
}: {
  title: string;
  rows: PastReplyRow[];
  total: number;
  empty: EmptyCopy;
  query: string;
  editRepliesEnabled: boolean;
  regenBudgets: Record<string, RegenBudgetStatus>;
  onOpenDrawer: (row: PastReplyRow, mode: 'edit' | 'recovery') => void;
}) {
  return (
    <section>
      <div className="pr-section-head">
        <div className="pr-section-title">{title}</div>
        <div className="pr-section-count">
          {rows.length} of {total}
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty {...empty} />
      ) : (
        <div className="pr-list">
          {rows.map((row) => (
            <PastReplyCard
              // review_id, not response_id: an unanswered row has no response.
              key={row.review_id}
              row={row}
              isImported={row.external_reply_ingested_at !== null}
              query={query}
              editRepliesEnabled={editRepliesEnabled}
              regenBudget={regenBudgets[row.review_id]}
              onEditClick={(selectedRow) => onOpenDrawer(selectedRow, 'edit')}
              onRecoveryClick={(selectedRow) => onOpenDrawer(selectedRow, 'recovery')}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReplyPagination({
  totalReviews,
  page,
  totalPages,
}: Pick<Props, 'page' | 'totalPages'> & { totalReviews: number }) {
  if (totalReviews <= 0) return null;

  return (
    <nav className="pr-pager">
      <Link
        href={page <= 1 ? '#' : `?page=${page - 1}`}
        className="pr-pager-btn"
        aria-disabled={page <= 1}
        tabIndex={page <= 1 ? -1 : undefined}
        style={page <= 1 ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Previous
      </Link>
      <span className="pr-pager-page">
        Page <strong>{page}</strong> of <strong>{totalPages}</strong>
      </span>
      <Link
        href={page >= totalPages ? '#' : `?page=${page + 1}`}
        className="pr-pager-btn"
        aria-disabled={page >= totalPages}
        tabIndex={page >= totalPages ? -1 : undefined}
        style={page >= totalPages ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
      >
        Next
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </Link>
    </nav>
  );
}

function ReplyDrawer({
  enabled,
  row,
  mode,
  onClose,
}: {
  enabled: boolean;
  row: PastReplyRow | null;
  mode: 'edit' | 'recovery';
  onClose: () => void;
}) {
  if (!enabled || !row) return null;

  const initialFailureRecovery =
    mode === 'recovery' && row.failed_response_id
      ? {
          failedResponseId: row.failed_response_id,
          failedPostingError: row.failed_posting_error ?? null,
        }
      : null;

  return (
    <EditReplyDrawer
      open={true}
      onClose={onClose}
      row={row}
      canEdit={row.canEdit ?? false}
      initialFailureRecovery={initialFailureRecovery}
    />
  );
}

function Stat({ label, icon, value, suffix }: { label: string; icon: 'check' | 'google' | 'inbox' | 'trend'; value: number | string; suffix?: string | null }) {
  return (
    <div className="pr-stat">
      <div className="pr-stat-label">
        <Icon name={icon} size={12} /> {label}
      </div>
      <div className="pr-stat-value">
        {value}
        {suffix && <span style={{ color: 'var(--rw-star)', marginLeft: 4 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Empty({ title, sub }: EmptyCopy) {
  return (
    <div className="pr-empty">
      <div className="pr-empty-icon">
        <Icon name="history" size={28} />
      </div>
      <div className="pr-empty-title">{title}</div>
      <div className="pr-empty-sub">{sub}</div>
    </div>
  );
}
