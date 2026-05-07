'use client';

import { Icon } from './Icon';

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
  row: Row;
  isImported: boolean;
  /** Optional: search query to highlight inside review + reply bodies. */
  query?: string;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderStars(n: number | null) {
  if (n == null) return null;
  const filled = Math.round(Math.max(0, Math.min(5, n)));
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
  return text.split(re).map((part, i) =>
    re.test(part) ? (
      <mark key={i} className="pr-mark">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function PastReplyCard({ row, isImported, query }: Props) {
  return (
    <article className="pr-card">
      <div className="pr-card-grid">
        <div className="pr-side pr-side-review">
          <div className="pr-side-eyebrow">
            <Icon name="google" size={12} /> Customer review
          </div>
          <div className="pr-meta">
            {renderStars(row.star_rating)}
            <span className="pr-name">{row.reviewer_name ?? 'Anonymous'}</span>
            <span className="pr-date">{fmt(row.review_date)}</span>
          </div>
          <p className="pr-body">{highlight(row.review_text, query)}</p>
        </div>

        <div className="pr-side pr-side-reply">
          <div className="pr-side-eyebrow reply">
            <Icon name="sparkle" size={12} /> Your reply on Google
          </div>
          <p className="pr-body">{highlight(row.approved_text, query)}</p>
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
            {row.posted_at && <span>· {fmt(row.posted_at)}</span>}
          </div>
        </div>
      </div>
    </article>
  );
}
