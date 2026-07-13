'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@/components/dashboard/shell/Icon';
import { ESCALATION_STATUS, type OpenEscalationStatus } from '@/lib/escalations/types';
import {
  TRIAGE_SEVERITIES,
  TRIAGE_SEVERITY_LABELS,
  TRIAGE_SUGGESTED_ACTIONS,
  type TriageOutput,
  type TriageSeverity,
} from '@/lib/reviews/triage-schema';

/**
 * Query key for the open-escalation queue. Owned here; feed escalation
 * actions import it to invalidate the queue after a transition.
 */
export const DASHBOARD_OPEN_ESCALATIONS_QUERY_KEY = ['dashboard-open-escalations'] as const;

type OpenEscalationItem = {
  id: string;
  status: OpenEscalationStatus;
  severity: TriageSeverity;
  suggestedAction: TriageOutput['suggested_action'];
  createdAt: string;
  reviewId: string;
  businessName: string;
  reviewRating: number | null;
};

type OpenEscalationsResponse = {
  totalOpen: number;
  items: OpenEscalationItem[];
};

const OPEN_ESCALATION_STATUSES = new Set<unknown>([
  ESCALATION_STATUS.ESCALATED,
  ESCALATION_STATUS.ACKNOWLEDGED,
]);
const TRIAGE_SEVERITY_VALUES = new Set<unknown>(TRIAGE_SEVERITIES);
const SUGGESTED_ACTION_VALUES = new Set<unknown>(TRIAGE_SUGGESTED_ACTIONS);
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * Account-wide exception queue. A successful empty response stays hidden;
 * a failed load surfaces a compact error notice — the queue must never
 * silently disappear (mirrors AgentTeamStrip's error state).
 */
export function NeedsAttentionList() {
  const query = useQuery({
    queryKey: DASHBOARD_OPEN_ESCALATIONS_QUERY_KEY,
    queryFn: ({ signal }) => fetchOpenEscalations(signal),
  });

  if (query.isPending) return null;

  if (query.isError) {
    return (
      <section className="card needs-attention section-enter section-enter-4" aria-labelledby="needs-attention-heading">
        <h2 id="needs-attention-heading" className="card-h2">Needs attention</h2>
        <div className="agent-team-state agent-team-state--error" role="alert">
          {query.error instanceof Error ? query.error.message : 'Unable to load escalations'}
        </div>
      </section>
    );
  }

  if (query.data.items.length === 0) return null;

  const countCopy = query.data.totalOpen > query.data.items.length
    ? `Showing ${query.data.items.length} of ${query.data.totalOpen} open escalations.`
    : `${query.data.totalOpen} open ${query.data.totalOpen === 1 ? 'escalation' : 'escalations'}.`;

  return (
    <section className="card needs-attention section-enter section-enter-4" aria-labelledby="needs-attention-heading">
      <div className="needs-attention-head">
        <div className="needs-attention-title-icon" aria-hidden="true">
          <Icon name="shield" size={19} />
        </div>
        <div>
          <h2 id="needs-attention-heading" className="card-h2">Needs attention</h2>
          <p>{countCopy}</p>
        </div>
      </div>
      <ol className="needs-attention-list">
        {query.data.items.map((item) => (
          <li key={item.id} className="needs-attention-row">
            <div className="needs-attention-context">
              <span className={`badge escalation-badge escalation-badge--${item.severity}`}>
                {TRIAGE_SEVERITY_LABELS[item.severity]}
              </span>
              <span className="needs-attention-status">{formatIdentifier(item.status)}</span>
              <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
            </div>
            <div className="needs-attention-review">
              <strong>{item.businessName}</strong>
              <span>{item.reviewRating != null ? `${item.reviewRating}/5 rating` : 'No rating'}</span>
              <span>{formatIdentifier(item.suggestedAction)}</span>
            </div>
            <Link
              href={`/dashboard/reviews/${item.reviewId}/timeline`}
              className="needs-attention-link"
            >
              <Icon name="clock" size={16} aria-hidden="true" />
              Open {item.businessName} review timeline
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

async function fetchOpenEscalations(signal: AbortSignal): Promise<OpenEscalationsResponse> {
  const response = await fetch('/api/dashboard/escalations', {
    headers: { Accept: 'application/json' },
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = isObject(body) ? Reflect.get(body, 'error') : null;
    throw new Error(typeof error === 'string' ? error : 'Unable to load escalations');
  }
  if (!isOpenEscalationsEnvelope(body)) {
    throw new Error('Escalation response was incomplete');
  }
  // Validate per ITEM: one malformed row must not blank the whole queue.
  return { totalOpen: body.totalOpen, items: body.items.filter(isOpenEscalationItem) };
}

function isOpenEscalationsEnvelope(
  value: unknown,
): value is { totalOpen: number; items: unknown[] } {
  if (!isObject(value) || !Array.isArray(value.items)) return false;
  return [
    Number.isInteger(value.totalOpen),
    typeof value.totalOpen === 'number' && value.totalOpen >= 0,
    value.items.length <= 20,
    typeof value.totalOpen === 'number' && value.totalOpen >= value.items.length,
  ].every(Boolean);
}

function isOpenEscalationItem(value: unknown): value is OpenEscalationItem {
  if (!isObject(value)) return false;
  return [
    typeof value.id === 'string',
    OPEN_ESCALATION_STATUSES.has(value.status),
    TRIAGE_SEVERITY_VALUES.has(value.severity),
    SUGGESTED_ACTION_VALUES.has(value.suggestedAction),
    typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt)),
    typeof value.reviewId === 'string',
    typeof value.businessName === 'string',
    isValidReviewRating(value.reviewRating),
  ].every(Boolean);
}

/** reviews.star_rating is nullable — a rating-less review is a valid row. */
function isValidReviewRating(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function formatIdentifier(value: string): string {
  const words = value.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDate(value: string): string {
  return SHORT_DATE_FORMATTER.format(new Date(value));
}
