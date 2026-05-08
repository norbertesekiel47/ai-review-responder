'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PastReplyCard } from '@/components/dashboard/PastReplyCard';
import { HistoricalUpgradeBanner } from '@/components/dashboard/HistoricalUpgradeBanner';
import { Icon } from '@/components/dashboard/Icon';

interface Row {
  review_id: string;
  review_text: string | null;
  review_date: string;
  reviewer_name: string | null;
  star_rating: number | null;
  response_id: string;
  approved_text: string | null;
  posted_at: string | null;
  external_reply_ingested_at: string | null;
}

interface Props {
  gapRows: Row[];
  histRows: Row[];
  gapTotal: number;
  histTotal: number;
  avgStarRating: number | null;
  isPremium: boolean;
  hasHistoricalSection: boolean;
  page: number;
  totalPages: number;
}

export function PastRepliesClient({
  gapRows,
  histRows,
  gapTotal,
  histTotal,
  avgStarRating,
  isPremium,
  hasHistoricalSection,
  page,
  totalPages,
}: Props) {
  const [query, setQuery] = useState('');
  const [rating, setRating] = useState<'all' | 1 | 2 | 3 | 4 | 5>('all');

  const totalReplies = gapTotal + histTotal;
  const normalizedQuery = query.trim().toLowerCase();
  const hasActiveFilter = rating !== 'all' || normalizedQuery.length > 0;
  const avgDisplay = avgStarRating != null ? avgStarRating.toFixed(1) : '—';

  const visibleGap = useMemo(
    () =>
      gapRows.filter((r) => {
        if (rating !== 'all' && r.star_rating !== rating) return false;
        if (!normalizedQuery) return true;
        return (
          (r.review_text ?? '').toLowerCase().includes(normalizedQuery) ||
          (r.approved_text ?? '').toLowerCase().includes(normalizedQuery) ||
          (r.reviewer_name ?? '').toLowerCase().includes(normalizedQuery)
        );
      }),
    [gapRows, normalizedQuery, rating],
  );
  const visibleHist = useMemo(
    () =>
      histRows.filter((r) => {
        if (rating !== 'all' && r.star_rating !== rating) return false;
        if (!normalizedQuery) return true;
        return (
          (r.review_text ?? '').toLowerCase().includes(normalizedQuery) ||
          (r.approved_text ?? '').toLowerCase().includes(normalizedQuery) ||
          (r.reviewer_name ?? '').toLowerCase().includes(normalizedQuery)
        );
      }),
    [histRows, normalizedQuery, rating],
  );
  const gapSectionTotal = hasActiveFilter ? gapRows.length : gapTotal;
  const histSectionTotal = hasActiveFilter ? histRows.length : histTotal;

  return (
    <div className="pr-content">
      <div className="pr-stats">
        <Stat label="Total replies" icon="check" value={totalReplies} />
        <Stat label="Active period" icon="sparkle" value={gapTotal} />
        <Stat label="Historical" icon="history" value={histTotal} />
        <Stat label="Avg rating" icon="trend" value={avgDisplay} suffix={avgStarRating != null ? '★' : null} />
      </div>

      <div className="pr-toolbar">
        <div className="pr-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            placeholder="Search reviews and replies on this page…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
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
          <button type="button" className={`pr-chip ${rating === 'all' ? 'active' : ''}`} onClick={() => setRating('all')}>
            All
          </button>
          {([5, 4, 3, 2, 1] as const).map((n) => (
            <button
              key={n}
              type="button"
              className={`pr-chip ${rating === n ? 'active' : ''}`}
              onClick={() => setRating(n)}
            >
              {n}
              <span className="pr-chip-stars">★</span>
            </button>
          ))}
        </div>
      </div>

      <section>
        <div className="pr-section-head">
          <div className="pr-section-title">From your active period</div>
          <div className="pr-section-count">
            {visibleGap.length} of {gapSectionTotal}
          </div>
        </div>
        {visibleGap.length === 0 ? (
          <Empty />
        ) : (
          <div className="pr-list">
            {visibleGap.map((r) => (
              <PastReplyCard
                key={r.response_id}
                row={r}
                isImported={r.external_reply_ingested_at !== null}
                query={query}
              />
            ))}
          </div>
        )}
      </section>

      {hasHistoricalSection && (
        <section>
          <div className="pr-section-head">
            <div className="pr-section-title">From before you joined</div>
            <div className="pr-section-count">
              {visibleHist.length} of {histSectionTotal}
            </div>
          </div>
          {!isPremium && <HistoricalUpgradeBanner />}
          {visibleHist.length === 0 ? (
            <Empty />
          ) : (
            <div className="pr-list">
              {visibleHist.map((r) => (
                <PastReplyCard
                  key={r.response_id}
                  row={r}
                  isImported={r.external_reply_ingested_at !== null}
                  query={query}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {totalReplies > 0 && (
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
      )}
    </div>
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
        {suffix && <span style={{ color: 'var(--rw-yellow-500)', marginLeft: 4 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="pr-empty">
      <div className="pr-empty-icon">
        <Icon name="history" size={28} />
      </div>
      <div className="pr-empty-title">No replies match this filter</div>
      <div className="pr-empty-sub">Try clearing your search, or pick a different rating chip.</div>
    </div>
  );
}
