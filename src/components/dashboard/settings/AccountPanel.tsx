'use client';

import { useState } from 'react';
import { Icon } from '@/components/dashboard/Icon';
import { useAccountData, type AccountSettingsData } from '@/hooks/useAccountData';
import type { DashboardDataActive } from '@/lib/dashboard/types';
// ── QuotaBar subcomponent ──────────────────────────────────────────────

function QuotaBar({ activeLocations, included, overage }: {
  activeLocations: number;
  included: number;
  overage: number;
}) {
  const totalSlots = included + overage;
  const includedPct = totalSlots > 0 ? Math.min((Math.min(activeLocations, included) / totalSlots) * 100, 100) : 0;
  const overagePct = totalSlots > 0 ? (Math.min(overage, activeLocations - included) / totalSlots) * 100 : 0;

  return (
    <div className="quota-bar-wrap">
      <div className="quota-bar-label">
        <strong>{activeLocations}</strong> of {included} included{overage > 0 ? `, ${overage} overage` : ''}
      </div>
      <div className="quota-bar-track">
        <div
          className="quota-bar-fill included"
          style={{ width: `${includedPct}%` }}
        />
        {overage > 0 && (
          <div
            className="quota-bar-fill overage"
            style={{ width: `${overagePct}%`, marginLeft: 0 }}
          />
        )}
      </div>
    </div>
  );
}

// ── PlanCard subcomponent ──────────────────────────────────────────────

function PlanCard({ subscription, billing, accountId }: {
  subscription: AccountSettingsData['subscription'];
  billing: AccountSettingsData['billing'];
  accountId: string;
}) {
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  async function openBillingPortal() {
    setPortalLoading(true);
    setPortalError(null);
    try {
      const portalRes = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });
      if (!portalRes.ok) {
        const body = await portalRes.json().catch(() => ({}));
        throw new Error(body.detail ?? body.error ?? 'Unable to open billing portal');
      }
      const { url } = await portalRes.json();
      window.location.href = url;
    } catch (err) {
      setPortalError(err instanceof Error ? err.message : 'Failed to open billing portal');
    } finally {
      setPortalLoading(false);
    }
  }

  const basePrice = (billing.basePriceCents / 100).toFixed(2);
  const overagePrice = billing.overagePriceCents > 0 ? (billing.overagePriceCents / 100).toFixed(2) : null;
  const totalPrice = (billing.totalCents / 100).toFixed(2);

  return (
    <div className="plan-card">
      <div>
        <div className="plan-eyebrow">Current plan</div>
        <div className="plan-name">{subscription.tierLabel}</div>
        <div className="plan-price">
          ${basePrice}/mo base
          {overagePrice && billing.overageUnits > 0 && (
            <> + ${overagePrice}/mo × {billing.overageUnits} overage</>
          )}
        </div>
        <div className="plan-renew">
          Status: <span style={{ fontWeight: 600 }}>{subscription.statusLabel}</span>
          {subscription.activatedAt && (
            <> · Active since {new Date(subscription.activatedAt).toLocaleDateString()}</>
          )}
        </div>
      </div>
      {subscription.stripeCustomerId && (
        <button
          type="button"
          className="plan-cta"
          onClick={openBillingPortal}
          disabled={portalLoading}
        >
          {portalLoading ? 'Opening…' : 'Manage billing'}
        </button>
      )}
      {portalError && (
        <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#DC2626', marginTop: 4 }}>
          {portalError}
        </div>
      )}
    </div>
  );
}

// ── AccountPanel ──────────────────────────────────────────────────────

interface Props {
  data: DashboardDataActive;
  accountData: AccountSettingsData | null;
  accountLoading: boolean;
  accountError: string | null;
  onAccountRefetch: () => void;
}

export function AccountPanel({ data, accountData, accountLoading, accountError, onAccountRefetch }: Props) {
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
    <>
      {/* Business profile — reused from GeneralPanel */}
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
            <label className="field-label">
              Business name <span className="locked-pill">Locked</span>
            </label>
            <input className="input locked" value={data.business.name} disabled readOnly />
          </div>
          <div className="field">
            <label className="field-label">
              Category <span className="locked-pill">Locked</span>
            </label>
            <input className="input locked" value={data.settings.category} disabled readOnly />
          </div>
        </div>
        <div className="field">
          <label className="field-label">
            Google Place ID <span className="locked-pill">Locked</span>
          </label>
          <div className="copy-row">
            <input
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

      {/* Subscription & Billing section */}
      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon violet">
            <Icon name="chart" size={18} />
          </div>
          <div>
            <div className="set-section-title">Subscription &amp; billing</div>
            <div className="set-section-sub">
              Your plan, billing details, and location quota.
            </div>
          </div>
        </div>

        {accountLoading && (
          <p style={{ textAlign: 'center', color: '#6B7280', padding: '24px 0' }}>Loading account data…</p>
        )}
        {accountError && (
          <div style={{ fontSize: 13, color: '#DC2626', padding: '8px 0' }}>
            {accountError}
          </div>
        )}
        {accountData && (
          <>
            <PlanCard subscription={accountData.subscription} billing={accountData.billing} accountId={accountData.accountId} />

            {/* Locations quota */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                Locations quota
              </div>
              <QuotaBar
                activeLocations={accountData.quota.activeLocations}
                included={accountData.quota.included}
                overage={accountData.quota.overage}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
