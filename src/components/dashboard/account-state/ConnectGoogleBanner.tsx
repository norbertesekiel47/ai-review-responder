'use client';

import Link from 'next/link';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import { Icon } from '@/components/dashboard/shell/Icon';

interface Props {
  zernio: DashboardDataActive['zernioConnection'];
  readOnly?: boolean;
}

function ReadOnlyNotice() {
  return (
    <p className="text-xs text-gray-600 mt-1">
      Update billing to connect or reconnect Google Business.
    </p>
  );
}

export function ConnectGoogleBanner({ zernio, readOnly = false }: Props) {
  if (zernio.status === 'active') return null;

  if (zernio.status === 'finalize_unknown') {
    return (
      <div className="banner banner-attn" role="alert">
        <div className="b-icon">
          <Icon name="alert" size={18} />
        </div>
        <div>
          <div className="b-title">Connection requires manual review</div>
          <div className="b-sub">
            We&apos;ve notified our support team; they&apos;ll have this resolved within 24 hours. You don&apos;t need to do anything.
          </div>
        </div>
      </div>
    );
  }

  if (zernio.status === 'none') {
    return (
      <div className="banner banner-blue">
        <div className="b-icon">
          <Icon name="google" size={18} />
        </div>
        <div>
          <div className="b-title">Connect Google Business</div>
          <div className="b-sub">Start auto-posting your approved responses to Google.</div>
        </div>
        {readOnly ? (
          <ReadOnlyNotice />
        ) : (
          <Link href="/dashboard/connect" className="banner-cta">
            Connect
          </Link>
        )}
      </div>
    );
  }

  if (zernio.status === 'pending' && zernio.pendingFlow) {
    return (
      <div className="banner banner-blue">
        <div className="b-icon">
          <Icon name="google" size={18} />
        </div>
        <div>
          <div className="b-title">Connecting your Google Business…</div>
          <div className="b-sub">We&apos;ll let you know as soon as it&apos;s live.</div>
        </div>
        {readOnly ? (
          <ReadOnlyNotice />
        ) : (
          <Link href="/dashboard/connect" className="banner-cta">
            View progress
          </Link>
        )}
      </div>
    );
  }

  // status === 'pending' (no marker — stale row) | 'disconnected'
  const headline =
    zernio.queuedReconnectCount > 0
      ? `${zernio.queuedReconnectCount} approved ${
          zernio.queuedReconnectCount === 1 ? 'response is' : 'responses are'
        } waiting to publish.`
      : 'Auto-posting is currently disconnected.';

  return (
    <div className="banner banner-attn">
      <div className="b-icon">
        <Icon name="alert" size={18} />
      </div>
      <div>
        <div className="b-title">{headline}</div>
        <div className="b-sub">
          Reconnect Google Business to resume publishing. If you&apos;ve already reconnected and this still appears, our Google
          Reviews integration may be temporarily unavailable; we&apos;ll resume automatically once it&apos;s restored.
        </div>
      </div>
      {readOnly ? (
        <ReadOnlyNotice />
      ) : (
        <Link href="/dashboard/connect" className="banner-cta">
          Reconnect
        </Link>
      )}
    </div>
  );
}
