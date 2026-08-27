'use client';

// Review QR settings client (CONTEXT.md "Review QR"): one card per
// non-archived location. Eligible locations get the QR preview, the encoded
// QR-redirect link, a PNG download, and a print-view link; ineligible ones
// (non-canonical Google Place ID) get the explanatory card and no actions.
// Console system: SettingsShell + .set-section primitives from settings.css;
// the few layout styles are inline with var(--rw-*) tokens because this
// task's file surface does not include the stylesheet.

import Link from 'next/link';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { OwnerReviewQrLocation } from '@/lib/locations/review-qr';

interface Props {
  locations: OwnerReviewQrLocation[];
}

export function ReviewQrClient({ locations }: Props) {
  if (locations.length === 0) {
    return (
      <SettingsShell>
        <div className="set-section">
          <p className="settings-body-copy">
            Add a location in{' '}
            <Link href="/settings/locations" style={{ color: 'var(--rw-accent-700)', fontWeight: 600 }}>
              Locations settings
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
                    download={`review-qr-${location.businessId}.png`}
                    href={location.qrDataUrl}
                  >
                    Download PNG
                  </a>
                  <Link
                    className="btn btn-secondary"
                    href={`/settings/review-qr/print/${location.businessId}`}
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
              This location needs a canonical Google Place ID before it can have a review QR.
            </p>
          </div>
        ),
      )}
    </SettingsShell>
  );
}
