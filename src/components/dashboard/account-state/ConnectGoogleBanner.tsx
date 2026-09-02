'use client';

import Link from 'next/link';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';

interface Props {
  zernio: DashboardDataActive['zernioConnection'];
  readOnly?: boolean;
}

function ReadOnlyNotice() {
  return (
    <p className="text-xs mt-1" style={{ color: 'var(--rw-app-text-muted)' }}>
      Update billing to connect or reconnect Google Business.
    </p>
  );
}

interface BannerProps {
  /** `blue` invites an action; `attn` reports a problem. */
  tone: 'blue' | 'attn';
  icon: IconName;
  title: string;
  sub: string;
  /** Label of the `/dashboard/connect` CTA; omitted when the state offers no action. */
  cta?: string;
  readOnly: boolean;
  role?: 'alert';
}

/** One banner shape for every non-active connection state. */
function ConnectionBanner({ tone, icon, title, sub, cta, readOnly, role }: BannerProps) {
  return (
    <div className={`banner banner-${tone}`} role={role}>
      <div className="b-icon">
        <Icon name={icon} size={18} />
      </div>
      <div>
        <div className="b-title">{title}</div>
        <div className="b-sub">{sub}</div>
      </div>
      {cta !== undefined && (readOnly ? (
        <ReadOnlyNotice />
      ) : (
        <Link href="/dashboard/connect" className="banner-cta">
          {cta}
        </Link>
      ))}
    </div>
  );
}

export function ConnectGoogleBanner({ zernio, readOnly = false }: Props) {
  if (zernio.status === 'active') return null;

  if (zernio.status === 'finalize_unknown') {
    return (
      <ConnectionBanner
        tone="attn"
        icon="alert"
        role="alert"
        readOnly={readOnly}
        title="Connection requires manual review"
        sub="We've notified our support team; they'll have this resolved within 24 hours. You don't need to do anything."
      />
    );
  }

  if (zernio.status === 'none') {
    return (
      <ConnectionBanner
        tone="blue"
        icon="google"
        readOnly={readOnly}
        title="Connect Google Business"
        sub="Start auto-posting your approved replies to Google."
        cta="Connect"
      />
    );
  }

  if (zernio.status === 'pending' && zernio.pendingFlow) {
    return (
      <ConnectionBanner
        tone="blue"
        icon="google"
        readOnly={readOnly}
        title="Connecting your Google Business…"
        sub="We'll let you know as soon as it's live."
        cta="View progress"
      />
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
    <ConnectionBanner
      tone="attn"
      icon="alert"
      readOnly={readOnly}
      title={headline}
      sub="Reconnect Google Business to resume publishing. If you've already reconnected and this still appears, our Google Reviews integration may be temporarily unavailable; we'll resume automatically once it's restored."
      cta="Reconnect"
    />
  );
}
