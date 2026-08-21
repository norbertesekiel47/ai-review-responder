'use client';

import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

const ROWS = [
  { name: 'Sarah L.', initials: 'SL', stars: 5, excerpt: 'Best dry cleaners in town. Picked up my suits on time and they…', time: 'Just now', isNew: true },
  { name: 'Marcus T.', initials: 'MT', stars: 4, excerpt: 'Quick service, friendly staff. Will return for my shirts next week.', time: '12 min ago' },
  { name: 'Priya R.', initials: 'PR', stars: 5, excerpt: 'Saved my wedding dress. Honestly, nothing short of magic.', time: '48 min ago' },
  { name: 'David C.', initials: 'DC', stars: 3, excerpt: 'Decent service but the pickup hours could be better on weekends.', time: '2 hrs ago' },
];

const COUNTDOWN_START_S = 299;

function Stars({ count }: { count: number }) {
  return (
    <span className="rw-dl-stars" aria-label={`${count} out of 5 stars`}>
      <span aria-hidden="true">{'★'.repeat(count)}</span>
      {count < 5 && (
        <span aria-hidden="true" className="off">{'★'.repeat(5 - count)}</span>
      )}
    </span>
  );
}

export function WatchArtifact() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_START_S);
  useEffect(() => {
    if (prefersReducedMotion) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : COUNTDOWN_START_S));
    }, 1000);
    return () => clearInterval(id);
  }, [prefersReducedMotion]);
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  return (
    <div className="rw-dl-card">
      <div className="rw-dl-cap">
        <span className="rw-dl-cap-dot" />
        <span>Google Business Profile · Bright Linen Dry Cleaning</span>
        <span className="rw-dl-cap-tail">live · backup check in {mm}:{ss}</span>
      </div>
      <div className="hiw-feed">
        {ROWS.map((row) => (
          <div key={row.name} className={`hiw-feed-row ${row.isNew ? 'is-new' : ''}`}>
            <div className="rw-dl-av">{row.initials}</div>
            <div>
              <div className="hiw-feed-l1">
                <span>{row.name}</span>
                <Stars count={row.stars} />
              </div>
              <div className="hiw-feed-ex">{row.excerpt}</div>
            </div>
            <div className="hiw-feed-tm">
              {row.isNew && <span className="rw-dl-pulse" />}
              {row.time}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
