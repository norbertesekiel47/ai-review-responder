'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PastReplyCard } from '@/components/dashboard/reviews/PastReplyCard';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';
import { EditReplyDrawer } from '@/components/dashboard/reviews/EditReplyDrawer';
import { Icon } from '@/components/dashboard/shell/Icon';

interface Props {
  gapRows: PastReplyRow[];
  histRows: PastReplyRow[];
  gapTotal: number;
  histTotal: number;
  avgStarRating: number | null;
  hasHistoricalSection: boolean;
  // True when orphan gap rows were merged into gapRows (gapTotal may be 0).
  // Used so the gap section header denominator includes orphan rows even when
  // no posted gap replies exist (avoids "N of 0" with N > 0).
  hasGapOrphans?: boolean;
  page: number;
  totalPages: number;
  // Passed from the server page — true only when PAST_REPLIES_VIEW_ENABLED &&
  // EDIT_REPLIES_ENABLED are both 'true'. When false the page is read-only
  // (Phase A inertness).
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
  gapRows,
  histRows,
  gapTotal,
  histTotal,
  hasGapOrphans,
}: Pick<Props, 'gapRows' | 'histRows' | 'gapTotal' | 'histTotal'> & { hasGapOrphans: boolean }) {
  const [query, setQuery] = useState('');
  const [rating, setRating] = useState<RatingFilter>('all');
  const normalizedQuery = query.trim().toLowerCase();
  const hasActiveFilter = rating !== 'all' || normalizedQuery.length > 0;
  const visibleGap = useMemo(
    () => gapRows.filter((row) => matchesReplyFilter(row, rating, normalizedQuery)),
    [gapRows, normalizedQuery, rating],
  );
  const visibleHist = useMemo(
    () => histRows.filter((row) => matchesReplyFilter(row, rating, normalizedQuery)),
    [histRows, normalizedQuery, rating],
  );

  // Posted-only totals drive stats and pagination. Section totals also include
  // orphan rows, so their headers never show "N of M" with N > M.
  const gapOrphanCount = hasGapOrphans ? gapRows.length - gapTotal : 0;
  const histOrphanCount = histRows.length - histTotal;
  const gapSectionTotal = hasActiveFilter ? gapRows.length : gapTotal + Math.max(0, gapOrphanCount);
  const histSectionTotal = hasActiveFilter ? histRows.length : histTotal + Math.max(0, histOrphanCount);

  return {
    gapSectionTotal,
    hasActiveFilter,
    histSectionTotal,
    query,
    rating,
    setQuery,
    setRating,
    visibleGap,
    visibleHist,
  };
}

export function PastRepliesClient({
  gapRows,
  histRows,
  gapTotal,
  histTotal,
  avgStarRating,
  hasHistoricalSection,
  hasGapOrphans = false,
  page,
  totalPages,
  editRepliesEnabled = false,
}: Props) {
  const [drawerRow, setDrawerRow] = useState<PastReplyRow | null>(null);
  const [drawerMode, setDrawerMode] = useState<'edit' | 'recovery'>('edit');
  const totalReplies = gapTotal + histTotal;
  const filters = useReplyFilters({ gapRows, histRows, gapTotal, histTotal, hasGapOrphans });
  const openDrawer = (row: PastReplyRow, mode: 'edit' | 'recovery') => {
    setDrawerRow(row);
    setDrawerMode(mode);
  };

  return (
    <div className="pr-content">
      <ReplyStats {...{ totalReplies, gapTotal, histTotal, avgStarRating }} />
      <ReplyToolbar
        query={filters.query}
        rating={filters.rating}
        onQueryChange={filters.setQuery}
        onRatingChange={filters.setRating}
      />
      <ReplySection
        title="From your active period"
        rows={filters.visibleGap}
        total={filters.gapSectionTotal}
        firstRun={!filters.hasActiveFilter && totalReplies === 0}
        query={filters.query}
        editRepliesEnabled={editRepliesEnabled}
        onOpenDrawer={openDrawer}
      />
      {hasHistoricalSection && (
        <ReplySection
          title="From before you joined"
          rows={filters.visibleHist}
          total={filters.histSectionTotal}
          firstRun={false}
          query={filters.query}
          editRepliesEnabled={editRepliesEnabled}
          onOpenDrawer={openDrawer}
        />
      )}
      <ReplyPagination {...{ totalReplies, page, totalPages }} />
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
  totalReplies,
  gapTotal,
  histTotal,
  avgStarRating,
}: Pick<Props, 'gapTotal' | 'histTotal' | 'avgStarRating'> & { totalReplies: number }) {
  return (
    <div className="pr-stats">
      <Stat label="Total replies" icon="check" value={totalReplies} />
      <Stat label="Active period" icon="sparkle" value={gapTotal} />
      <Stat label="Historical" icon="history" value={histTotal} />
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
            style={{ background: 'none', border: 'none', color: '#9CA3AF', cursor: 'pointer', padding: 2 }}
            aria-label="Clear search"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      <div className="pr-chips" role="tablist" aria-label="Filter by rating">
        <button type="button" className={`pr-chip ${rating === 'all' ? 'active' : ''}`} onClick={() => onRatingChange('all')}>
          All
        </button>
        {([5, 4, 3, 2, 1] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`pr-chip ${rating === value ? 'active' : ''}`}
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

function ReplySection({
  title,
  rows,
  total,
  firstRun,
  query,
  editRepliesEnabled,
  onOpenDrawer,
}: {
  title: string;
  rows: PastReplyRow[];
  total: number;
  firstRun: boolean;
  query: string;
  editRepliesEnabled: boolean;
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
        <Empty firstRun={firstRun} />
      ) : (
        <div className="pr-list">
          {rows.map((row) => (
            <PastReplyCard
              key={row.response_id}
              row={row}
              isImported={row.external_reply_ingested_at !== null}
              query={query}
              editRepliesEnabled={editRepliesEnabled}
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
  totalReplies,
  page,
  totalPages,
}: Pick<Props, 'page' | 'totalPages'> & { totalReplies: number }) {
  if (totalReplies <= 0) return null;

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

function Stat({ label, icon, value, suffix }: { label: string; icon: 'check' | 'sparkle' | 'history' | 'trend'; value: number | string; suffix?: string | null }) {
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

function Empty({ firstRun }: { firstRun: boolean }) {
  return (
    <div className="pr-empty">
      <div className="pr-empty-icon">
        <Icon name="history" size={28} />
      </div>
      <div className="pr-empty-title">
        {firstRun ? 'No replies yet' : 'No replies match this filter'}
      </div>
      <div className="pr-empty-sub">
        {firstRun
          ? 'Approved replies will appear here as you respond to your reviews.'
          : 'Try clearing your search, or pick a different rating chip.'}
      </div>
    </div>
  );
}
