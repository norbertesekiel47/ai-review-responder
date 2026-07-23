'use client';

import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

const STEP1_ROWS = [
  { name: 'Sarah L.', initials: 'SL', stars: 5, excerpt: 'Best dry cleaners in town. Picked up my suits on time and they...', time: 'Just now', isNew: true },
  { name: 'Marcus T.', initials: 'MT', stars: 4, excerpt: 'Quick service, friendly staff. Will return for my shirts next week.', time: '12 min ago' },
  { name: 'Priya R.', initials: 'PR', stars: 5, excerpt: 'Saved my wedding dress. Honestly, nothing short of magic.', time: '48 min ago' },
  { name: 'David C.', initials: 'DC', stars: 3, excerpt: 'Decent service but the pickup hours could be better on weekends.', time: '2 hrs ago' },
];
const STEP1_COLORS = ['#F2C3B9', '#D6CBBF', '#D2E0D3', '#F0DDD6'];

export function WatchArtifact() {
  const reducedMotion = usePrefersReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const i = setInterval(() => setTick((t) => t + 1), 4200);
    return () => clearInterval(i);
  }, [reducedMotion]);
  const rows = STEP1_ROWS;
  const colors = STEP1_COLORS;
  const mins = String(4 - (tick % 5)).padStart(2, '0');
  const secs = String(59 - ((tick * 3) % 60)).padStart(2, '0');
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" />
        <span>Google Business Profile: Bright Linen Dry Cleaning</span>
        <span className="hiw-artifact-cap-tail">polling · next in {mins}:{secs}</span>
      </div>
      <div className="hiw-feed">
        {rows.map((r, i) => (
          <div key={r.name} className={`hiw-feed-row ${r.isNew ? 'is-new' : ''}`}>
            <div className="hiw-avatar" style={{ background: colors[i % colors.length] }}>{r.initials}</div>
            <div>
              <div className="hiw-feed-line1">
                <span className="hiw-feed-name">{r.name}</span>
                <span className="hiw-feed-stars" aria-label={`${r.stars} out of 5 stars`}>
                  <span aria-hidden="true">{'★'.repeat(r.stars)}</span>
                  <span aria-hidden="true" style={{ color: '#e5e5e5' }}>{'★'.repeat(5 - r.stars)}</span>
                </span>
              </div>
              <div className="hiw-feed-excerpt">{r.excerpt}</div>
            </div>
            <div className="hiw-feed-time">
              {r.isNew && <span className="hiw-pulse-dot" />}
              {r.time}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
