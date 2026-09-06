'use client';

// Review QR settings client (docs/context/review-qr.md "Review QR"): one card per
// non-archived location. Eligible locations get the QR preview, the encoded
// QR-redirect link, a PNG download, and a print-view link; ineligible ones
// (non-canonical Google Place ID) get a plain-language card that says what to
// do — reconnect Google — and no QR actions (UX audit S24).
// Console system: SettingsShell + .set-section primitives from settings.css.

import Link from 'next/link';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { OwnerReviewQrLocation } from '@/lib/locations/review-qr';

interface Props {
  locations: OwnerReviewQrLocation[];
}

/**
 * The PNG is named after the location, not its UUID (UX audit S33):
 * "Harbor Café — Main St" → review-qr-harbor-cafe-main-st.png.
 */
export function reviewQrFileName(displayName: string): string {
  const slug = displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `review-qr-${slug || 'location'}.png`;
}

/** Same reconnect entry the Locations page uses — one connect route per location. */
function reconnectHref(businessId: string): string {
  return `/dashboard/connect?locationId=${encodeURIComponent(businessId)}`;
}

export function ReviewQrClient({ locations }: Props) {
  if (locations.length === 0) {
    return (
      <SettingsShell>
        <div className="set-section">
          {/* Links the dashboard, not /settings/locations — that route 404s
              when the multi-location flag is off (adversarial R1 spec
              appendix): no owner may ever get a dead link. */}
          <p className="settings-body-copy">
            Add a location from your{' '}
            <Link href="/dashboard" style={{ color: 'var(--rw-accent-700)', fontWeight: 600 }}>
              dashboard
            </Link>{' '}
            to get its review QR code.
          </p>
        </div>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell>
      {locations.map((location) =>
        location.qrDataUrl !== null ? (
          <div className="set-section" key={location.businessId}>
            <div className="set-section-head">
              <div className="set-section-icon sage" aria-hidden>
                <Icon name="location" size={18} />
              </div>
              <div>
                <div className="set-section-title">{location.displayName}</div>
                <div className="set-section-sub">
                  Customers scan this code and land on your Google review page.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- data URL QR, no next/image optimization possible */}
              <img
                src={location.qrDataUrl}
                alt={`Review QR for ${location.displayName}`}
                width={160}
                height={160}
                style={{
                  width: 160,
                  height: 160,
                  padding: 8,
                  background: 'var(--rw-white)',
                  border: '1px solid var(--rw-app-border)',
                  borderRadius: 'var(--rw-radius-md)',
                }}
              />
              <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="field">
                  <span className="field-label">QR link</span>
                  <code
                    style={{
                      display: 'block',
                      padding: '8px 10px',
                      background: 'var(--rw-recess)',
                      border: '1px solid var(--rw-app-border-soft)',
                      borderRadius: 'var(--rw-radius-sm)',
                      font: 'var(--rw-app-micro)',
                      fontFamily: 'var(--rw-font-mono)',
                      color: 'var(--rw-app-text)',
                      overflowWrap: 'anywhere',
                      userSelect: 'all',
                    }}
                  >
                    {location.qrTargetUrl}
                  </code>
                  <span className="field-hint">
                    The code routes through RepWorth, so it keeps working even if your Google
                    listing changes.
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <a
                    className="btn btn-primary"
                    download={reviewQrFileName(location.displayName)}
                    href={location.qrDataUrl}
                  >
                    Download PNG
                  </a>
                  <Link
                    className="btn btn-secondary"
                    href={`/dashboard/requests/qr/print/${location.businessId}`}
                  >
                    Print
                  </Link>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="set-section" key={location.businessId}>
            <div className="set-section-head">
              <div className="set-section-icon peach" aria-hidden>
                <Icon name="alert" size={18} />
              </div>
              <div>
                <div className="set-section-title">{location.displayName}</div>
                <div className="set-section-sub">No review QR yet</div>
              </div>
            </div>
            <p className="settings-body-copy">
              We couldn&apos;t verify this location&apos;s Google listing yet. Reconnect Google and the
              QR code will appear here.
            </p>
            <Link
              className="btn btn-secondary"
              style={{ alignSelf: 'flex-start' }}
              href={reconnectHref(location.businessId)}
            >
              <Icon name="google" size={12} /> Reconnect Google
            </Link>
          </div>
        ),
      )}
    </SettingsShell>
  );
}
