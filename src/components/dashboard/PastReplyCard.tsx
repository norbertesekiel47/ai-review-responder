'use client';

import { Icon } from './Icon';

// PastReplyRow is the wire shape flowing from page.tsx → PastRepliesClient →
// PastReplyCard → EditReplyDrawer. Fields with `?` are added by the edit
// feature (Tasks 9-12); the drawer uses them for snapshot + recovery.
export interface PastReplyRow {
  review_id: string;
  review_text: string | null;
  review_date: string;
  reviewer_name: string | null;
  star_rating: number | null;
  response_id: string;
  approved_text: string | null;
  posted_at: string | null;
  external_reply_ingested_at: string | null;
  // Optimistic-concurrency snapshot (required by EditReplyDrawer).
  review_content_hash?: string | null;
  version?: number | null;
  // C-2 gate computed server-side (canEdit = !isHistorical OR isPremium).
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
  onEditClick?: (row: PastReplyRow) => void;
  onRecoveryClick?: (row: PastReplyRow) => void;
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

export function PastReplyCard({
  row,
  isImported,
  query,
  editRepliesEnabled = false,
  onEditClick,
  onRecoveryClick,
}: Props) {
  const hasRecoverableFailure =
    editRepliesEnabled && !!row.failed_response_id;

  // An orphan row is a recovery card with no successfully posted sibling:
  // failed_response_id is present AND posted_at is null. These rows were never
  // successfully posted, so both provenance badges ("Posted via RepWorth" and
  // "Imported") are misleading and must be suppressed. Show "Pending recovery"
  // instead.
  const isOrphanRecovery = !!row.failed_response_id && row.posted_at === null;

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
          {row.review_text ? (
            <p className="pr-body">{highlight(row.review_text, query)}</p>
          ) : (
            <p className="pr-body italic">No review text — rating only.</p>
          )}
        </div>

        <div className="pr-side pr-side-reply">
          <div className="pr-side-eyebrow reply">
            <Icon name="sparkle" size={12} /> Your reply on Google
          </div>
          {row.approved_text ? (
            <p className="pr-body">{highlight(row.approved_text, query)}</p>
          ) : (
            <p className="pr-body italic">(no reply text)</p>
          )}
          <div className="pr-prov">
            {isOrphanRecovery ? (
              // Orphan rows were never successfully posted — suppress provenance
              // badges to avoid misleading the owner. Show a neutral recovery label.
              <span className="pr-prov-badge pr-prov-recovery">
                <Icon name="history" size={10} /> Pending recovery
              </span>
            ) : (
              <>
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
              </>
            )}
          </div>

          {/* ── Edit feature affordances (only rendered when flag is on) ── */}
          {editRepliesEnabled && (
            <div className="pr-edit-row">
              {hasRecoverableFailure ? (
                // Recovery branch: a failed sibling exists that can be retried/restored.
                <button
                  type="button"
                  onClick={() => onRecoveryClick?.(row)}
                  className="pr-recovery-btn"
                  aria-label="This reply needs attention — click to retry or restore"
                >
                  {/* Warning triangle SVG (no lucide) */}
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
                  This reply needs attention
                </button>
              ) : row.canEdit ? (
                // Edit CTA — canEdit is true (gap row or premium historical).
                <button
                  type="button"
                  onClick={() => onEditClick?.(row)}
                  className="pr-edit-btn"
                  aria-label="Edit reply"
                >
                  {/* Pencil SVG */}
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  Edit reply
                </button>
              ) : (
                // Lock badge — historical reply and non-premium.
                <span className="pr-premium-lock" aria-label="Editing historical replies requires Premium">
                  {/* Lock SVG */}
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
                  Premium feature
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
