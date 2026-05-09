'use client';

import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { Icon } from '../Icon';

interface Props {
  perLocationBriefs: AggregateDashboardData['perLocationBriefs'];
}

/** VAL-DASH-013 (partial): Intelligence brief in aggregate mode shows
 *  per-location prefix bullets grouped by location. */
export function AggregateIntelligenceBriefCard({ perLocationBriefs }: Props) {
  if (perLocationBriefs.length === 0) return null;

  // If there's only one brief, render it like the single-location version
  if (perLocationBriefs.length === 1 && perLocationBriefs[0]?.brief) {
    const { brief, displayName } = perLocationBriefs[0];
    return <SingleLocationBrief brief={brief!} displayName={displayName} />;
  }

  // Multiple briefs: group by location with prefix
  return (
    <div className="card">
      <div className="brief-head">
        <div className="brief-head-icon">
          <Icon name="lightbulb" size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 className="brief-h2">Intelligence Brief</h2>
          <div className="brief-period">
            <span className="brief-period-strong">All Locations</span> · combined summary
          </div>
        </div>
        <div className="brief-pill-wrap">
          <span className="brief-pill">{perLocationBriefs.length} locations</span>
        </div>
      </div>
      {perLocationBriefs.map((locBrief) => {
        if (!locBrief.brief) return null;
        const bullets = locBrief.brief.text
          .split(/\n+/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, ''));

        return (
          <div key={locBrief.locationId} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span className="location-chip" style={{ fontSize: 12, fontWeight: 600 }}>
                <Icon name="location" size={10} />
                {locBrief.displayName}
              </span>
              <span style={{ fontSize: 11, color: '#6B7280' }}>
                {locBrief.brief.type === 'monthly' ? 'monthly' : 'weekly'} · {locBrief.brief.periodLabel}
              </span>
            </div>
            <ul className="brief-list">
              {bullets.map((b, i) => (
                <li key={i} className="brief-li">
                  <span className="brief-li-bullet">{i + 1}</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function SingleLocationBrief({
  brief,
  displayName,
}: {
  brief: NonNullable<AggregateDashboardData['perLocationBriefs'][number]['brief']>;
  displayName: string;
}) {
  const bullets = brief.text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, ''));

  return (
    <div className="card">
      <div className="brief-head">
        <div className="brief-head-icon">
          <Icon name="lightbulb" size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 className="brief-h2">Intelligence Brief</h2>
          <div className="brief-period">
            <span className="brief-period-strong">{brief.periodLabel}</span> ·{' '}
            {brief.type === 'monthly' ? 'monthly summary' : 'weekly summary'}
          </div>
        </div>
        <div className="brief-pill-wrap">
          <span className="brief-pill">{brief.type === 'monthly' ? 'Monthly' : 'Weekly'}</span>
        </div>
      </div>
      <ul className="brief-list">
        {bullets.map((b, i) => (
          <li key={i} className="brief-li">
            <span className="brief-li-bullet">{i + 1}</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
