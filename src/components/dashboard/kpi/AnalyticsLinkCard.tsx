'use client';

import Link from 'next/link';
import { Icon } from '@/components/dashboard/shell/Icon';

const ANALYTICS_HREF = '/dashboard/analytics';

/**
 * Doorway strip on the glance dashboard that points to the full analytics page,
 * where the reputation trend, review velocity, local ranking and intelligence
 * brief now live. Reuses the "calm" approvals-strip styling so it sits in the
 * same visual rhythm as the rest of the dashboard.
 */
export function AnalyticsLinkCard() {
  return (
    <div className="approvals calm">
      <div className="approvals-ic">
        <Icon name="chart" size={22} />
      </div>
      <div className="approvals-txt">
        <div className="approvals-title">See your full analytics</div>
        <div className="approvals-sub">
          Reputation trend, review volume, and local search ranking, all in one place.
        </div>
      </div>
      <Link href={ANALYTICS_HREF} className="btn btn-ghost">
        View analytics
        <svg
          viewBox="0 0 24 24"
          width={16}
          height={16}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </Link>
    </div>
  );
}
