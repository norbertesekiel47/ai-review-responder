'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';
import { Icon } from '@/components/dashboard/Icon';
import { getBriefBullets } from '@/components/dashboard/brief-bullets';

interface Props {
  brief: NonNullable<DashboardDataActive['latestBrief']>;
}

export function IntelligenceBriefCard({ brief }: Props) {
  const bullets = getBriefBullets(brief.text);

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
        {bullets.map((bullet, i) => (
          <li key={bullet.key} className="brief-li">
            <span className="brief-li-bullet">{i + 1}</span>
            <span>{bullet.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
