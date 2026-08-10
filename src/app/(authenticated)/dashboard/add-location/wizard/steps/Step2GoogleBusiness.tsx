'use client';

// Step 2 — Google Business info (informational only; connect later from Settings).

import Link from 'next/link';
import { Icon } from '@/components/dashboard/shell/Icon';

interface Step2GoogleBusinessProps {
  onNext: () => void;
}

export function Step2GoogleBusiness({ onNext }: Step2GoogleBusinessProps) {
  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Google Business Profile</h2>
      <p className="wizard-desc">
        After adding your location, you can connect your Google Business
        Profile to automatically publish approved responses and import
        reviews. This can be done at any time from Settings.
      </p>

      <div className="wizard-info-box" style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <Icon name="google" size={20} />
          <div>
            <p style={{ fontWeight: 500, marginBottom: 4 }}>
              Connect later from Settings
            </p>
            <p style={{ color: 'var(--rw-app-text-muted)', fontSize: 14 }}>
              After creating your location, go to{' '}
              <Link
                href="/dashboard/connect"
                className="wizard-inline-link"
              >
                Connect
              </Link>{' '}
              or Settings → Locations to link your Google Business
              Profile and start importing reviews.
            </p>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary"
        onClick={onNext}
        style={{ marginTop: 20, width: '100%' }}
      >
        Continue <Icon name="chevron-down" size={14} style={{ transform: 'rotate(-90deg)' }} />
      </button>
    </div>
  );
}
