'use client';

import { useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { DashboardDataActive } from '@/lib/dashboard/types';

interface Props {
  data: DashboardDataActive;
}

export function GeneralPanel({ data }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.settings.googlePlaceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon blue">
          <Icon name="home" size={18} />
        </div>
        <div>
          <div className="set-section-title">Business profile</div>
          <div className="set-section-sub">
            Identity details from your Google listing. Reach out to support to update locked fields.
          </div>
        </div>
      </div>

      <div className="two-col">
        <div className="field">
          <label className="field-label" htmlFor="general-business-name">
            Business name <span className="locked-pill">Locked</span>
          </label>
          <input id="general-business-name" className="input locked" value={data.business.name} disabled readOnly />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="general-business-category">
            Category <span className="locked-pill">Locked</span>
          </label>
          <input id="general-business-category" className="input locked" value={data.settings.category} disabled readOnly />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="general-google-place-id">
          Google Place ID <span className="locked-pill">Locked</span>
        </label>
        <div className="copy-row">
          <input
            id="general-google-place-id"
            className="input locked"
            value={data.settings.googlePlaceId}
            disabled
            readOnly
            style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
          />
          <button type="button" className={`copy-btn ${copied ? 'copied' : ''}`} onClick={copy}>
            {copied ? (
              <>
                <Icon name="check" size={12} /> Copied
              </>
            ) : (
              <>📋 Copy</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
