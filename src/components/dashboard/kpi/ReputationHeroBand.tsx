import type { ReputationSummary } from '@/lib/dashboard/types';
import { Icon } from '@/components/dashboard/shell/Icon';
import { RESPONSE_RATE_PERIOD_CONTEXT } from '@/components/dashboard/kpi/response-rate-copy';

interface Props {
  summary: ReputationSummary;
  /** Lifetime reassurance figures (from valueSummary). */
  lifetimeReviewsHandled: number;
  lifetimeTimeSavedMinutes: number;
  /** Whether Google is connected (drives the header pill). */
  connected: boolean;
}

function DeltaArrow({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {up ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M5 12l7 7 7-7" />}
    </svg>
  );
}

/** A windowed delta pill, suppressed when null (no prior sample / ramping). */
function Delta({ value, unit, decimals = 0 }: { value: number | null; unit: string; decimals?: number }) {
  if (value == null || value === 0) {
    if (value === 0) {
      return <span className="rep-delta flat">no change {unit}</span>;
    }
    return null;
  }
  const up = value > 0;
  const magnitude = Math.abs(value).toFixed(decimals);
  return (
    <span className={`rep-delta ${up ? 'up' : 'down'}`}>
      <DeltaArrow up={up} />
      {up ? '+' : '−'}{magnitude} {unit}
    </span>
  );
}

function Stars({ rating }: { rating: number }) {
  const filled = Math.round(rating);
  return (
    <span className="rep-stat-stars" aria-hidden="true">
      {'★'.repeat(Math.max(0, Math.min(5, filled)))}
      {'☆'.repeat(Math.max(0, 5 - filled))}
    </span>
  );
}

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  if (hours >= 10) return String(Math.round(hours));
  return (Math.round(hours * 10) / 10).toString();
}

export function ReputationHeroBand({
  summary,
  lifetimeReviewsHandled,
  lifetimeTimeSavedMinutes,
  connected,
}: Props) {
  const { averageStar, responseRate, timeSavedMinutes, isRamping } = summary;
  const lifetimeHours = Math.round(lifetimeTimeSavedMinutes / 60);

  return (
    <div className={`card rep-hero${isRamping ? ' ramping' : ''}`}>
      <div className="rep-hero-top">
        <span className="rep-eyebrow">Your reputation · last 30 days</span>
        {connected && (
          <span className="rep-connected">
            <Icon name="check" size={14} /> Google connected
          </span>
        )}
      </div>

      <div className="rep-stats">
        <div className="rep-stat anchor">
          <div className="rep-stat-top">
            <span className="rep-stat-num">
              {averageStar.current == null ? '—' : averageStar.current.toFixed(1)}
            </span>
            {averageStar.current != null && <Stars rating={averageStar.current} />}
          </div>
          <span className="rep-stat-label">Average rating</span>
          <Delta value={averageStar.delta} unit="rating points" decimals={1} />
        </div>

        <div className="rep-stat">
          <div className="rep-stat-top">
            <span className="rep-stat-num">
              {responseRate.current == null ? '—' : responseRate.current}
              {responseRate.current != null && <small>%</small>}
            </span>
          </div>
          <span className="rep-stat-label">Response rate</span>
          <Delta value={responseRate.delta} unit="points" />
        </div>

        <div className="rep-stat">
          <div className="rep-stat-top">
            <span className="rep-stat-num">
              {formatHours(timeSavedMinutes.current ?? 0)}<small>hrs</small>
            </span>
          </div>
          <span className="rep-stat-label">Time saved</span>
          <Delta
            value={timeSavedMinutes.delta == null ? null : Math.round(timeSavedMinutes.delta / 60)}
            unit="hrs vs prior 30 days"
          />
        </div>
      </div>

      <p className="rep-period-context">{RESPONSE_RATE_PERIOD_CONTEXT}</p>

      <div className="rep-foot">
        {isRamping ? (
          <>
            <Icon name="clock" size={15} />
            Still building your baseline. Trends and comparisons appear after a few weeks of reviews.
          </>
        ) : (
          <>
            <Icon name="check" size={15} />
            {lifetimeReviewsHandled.toLocaleString()} replies handled for you since joining. That&apos;s about {lifetimeHours} hours back in your day.
          </>
        )}
      </div>
    </div>
  );
}
