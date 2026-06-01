'use client';

import { useState } from 'react';
import { Icon } from '@/components/dashboard/Icon';
import { useAccountData, type AccountSettingsData } from '@/hooks/useAccountData';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import { SubscriptionTier, type SubscriptionTierValue, TIER_CONFIG } from '@/lib/accounts/tier-config';
import { SettingsModal } from './SettingsModal';

// ── TierChangeModal ───────────────────────────────────────────────────

interface TierChangeModalProps {
  currentTier: SubscriptionTierValue;
  newTier: SubscriptionTierValue;
  accountId: string;
  billingPreview: {
    basePriceCents: number;
    overagePriceCents: number;
    overageUnits: number;
    totalCents: number;
  } | null;
  previewLoading: boolean;
  previewError: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  changing: boolean;
}

function TierChangeModal({
  currentTier,
  newTier,
  accountId,
  billingPreview,
  previewLoading,
  previewError,
  onConfirm,
  onCancel,
  changing,
}: TierChangeModalProps) {
  const newConfig = TIER_CONFIG[newTier];
  const isDowngrade = TIER_CONFIG[newTier].baseCents < TIER_CONFIG[currentTier].baseCents;

  return (
    <SettingsModal
      title={isDowngrade ? 'Downgrade plan' : 'Upgrade plan'}
      closeLabel="Cancel tier change"
      onClose={onCancel}
    >
        <div className="set-section-title" style={{ marginBottom: 8 }}>
          {isDowngrade ? 'Downgrade' : 'Upgrade'} to {newTier.charAt(0).toUpperCase() + newTier.slice(1)}?
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5, marginBottom: 12 }}>
          {isDowngrade
            ? 'Downgrading will reduce your plan. Your billing will be prorated.'
            : 'Upgrading will give you more features. Your billing will be prorated.'}
        </p>

        {/* Billing preview */}
        {previewLoading && (
          <p style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', padding: 8 }}>
            Calculating new billing…
          </p>
        )}
        {previewError && (
          <div style={{ fontSize: 13, color: '#DC2626', padding: 8 }}>
            {previewError}
          </div>
        )}
        {billingPreview && !previewLoading && (
          <div style={{
            background: '#F9FAFB',
            border: '1px solid #E5E7EB',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
              New monthly estimate
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#4B5563' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Base ({newTier.charAt(0).toUpperCase() + newTier.slice(1)})</span>
                <span>${(billingPreview.basePriceCents / 100).toFixed(2)}/mo</span>
              </div>
              {billingPreview.overageUnits > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Overage ({billingPreview.overageUnits} location{billingPreview.overageUnits > 1 ? 's' : ''})</span>
                  <span>${(billingPreview.overagePriceCents * billingPreview.overageUnits / 100).toFixed(2)}/mo</span>
                </div>
              )}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                borderTop: '1px solid #E5E7EB',
                paddingTop: 4,
                marginTop: 4,
                fontWeight: 600,
                color: '#111827',
              }}>
                <span>Total</span>
                <span>${(billingPreview.totalCents / 100).toFixed(2)}/mo</span>
              </div>
            </div>
          </div>
        )}

        {isDowngrade && newTier === 'basic' && (
          <div style={{
            background: '#FEF3C7',
            border: '1px solid #F59E0B',
            borderRadius: 8,
            padding: 8,
            marginBottom: 12,
            fontSize: 12,
            color: '#92400E',
          }}>
            Basic plan supports only 1 location. Archive extra locations before downgrading.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={changing}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={changing || previewLoading}
          >
            {changing ? 'Changing…' : `Confirm ${isDowngrade ? 'downgrade' : 'upgrade'}`}
          </button>
        </div>
    </SettingsModal>
  );
}

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
  const [tierChangeError, setTierChangeError] = useState<string | null>(null);

  // Tier change modal state
  const [selectedTier, setSelectedTier] = useState<SubscriptionTierValue | null>(null);
  const [billingPreview, setBillingPreview] = useState<{
    basePriceCents: number;
    overagePriceCents: number;
    overageUnits: number;
    totalCents: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.settings.googlePlaceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  async function openTierChangeModal(newTier: SubscriptionTierValue) {
    if (!accountData) return;
    setSelectedTier(newTier);
    setBillingPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);

    try {
      const res = await fetch('/api/billing/tier-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: accountData.accountId, newTier, preview: true }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // If validation fails (e.g., same_tier, subscription_inactive), still open modal to show error
        setPreviewError(body.error ?? body.detail ?? `Tier change not allowed (${res.status})`);
        setPreviewLoading(false);
        return;
      }

      const result = await res.json();
      // The validation endpoint returns the preview but doesn't actually change the tier
      // We need to call a separate validate endpoint — but for simplicity,
      // we use the validation result from tier-change to preview
      setBillingPreview(result.newBilling ?? null);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to preview tier change');
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmTierChange() {
    if (!accountData || !selectedTier) return;
    setChanging(true);
    setTierChangeError(null);

    try {
      const res = await fetch('/api/billing/tier-change', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ accountId: accountData.accountId, newTier: selectedTier }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? body.detail ?? 'Tier change failed');
      }

      // Success — close modal and refetch
      setSelectedTier(null);
      onAccountRefetch();
    } catch (err) {
      setTierChangeError(err instanceof Error ? err.message : 'Failed to change tier');
    } finally {
      setChanging(false);
    }
  }

  // Available tier options for the current account
  const currentTier = (accountData?.subscription?.tier ?? 'standard') as SubscriptionTierValue;
  const tierOptions: SubscriptionTierValue[] = ['basic', 'standard', 'premium', 'founders'];
  const otherTiers = tierOptions.filter((t) => t !== currentTier);
  const upgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents > TIER_CONFIG[currentTier].baseCents);
  const downgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents < TIER_CONFIG[currentTier].baseCents);

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
            <label className="field-label" htmlFor="account-business-name">
              Business name <span className="locked-pill">Locked</span>
            </label>
            <input id="account-business-name" className="input locked" value={data.business.name} disabled readOnly />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="account-business-category">
              Category <span className="locked-pill">Locked</span>
            </label>
            <input id="account-business-category" className="input locked" value={data.settings.category} disabled readOnly />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="account-google-place-id">
            Google Place ID <span className="locked-pill">Locked</span>
          </label>
          <div className="copy-row">
            <input
              id="account-google-place-id"
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
      <div id="subscription-billing" className="set-section">
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

            {/* VAL-BILLING-073: Tier change buttons with confirmation modal */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                Change plan
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {downgradableTiers.map((tier) => {
                  const cfg = TIER_CONFIG[tier];
                  return (
                    <button
                      key={tier}
                      type="button"
                      className="btn btn-secondary"
                      style={{ fontSize: 12, padding: '6px 12px' }}
                      onClick={() => openTierChangeModal(tier)}
                    >
                      Downgrade to {tier.charAt(0).toUpperCase() + tier.slice(1)} (${(cfg.baseCents / 100).toFixed(0)}/mo)
                    </button>
                  );
                })}
                {upgradableTiers.map((tier) => {
                  const cfg = TIER_CONFIG[tier];
                  return (
                    <button
                      key={tier}
                      type="button"
                      className="btn btn-primary"
                      style={{ fontSize: 12, padding: '6px 12px' }}
                      onClick={() => openTierChangeModal(tier)}
                    >
                      Upgrade to {tier.charAt(0).toUpperCase() + tier.slice(1)} (${(cfg.baseCents / 100).toFixed(0)}/mo)
                    </button>
                  );
                })}
              </div>
              {tierChangeError && (
                <div style={{ fontSize: 12, color: '#DC2626', marginTop: 4 }}>
                  {tierChangeError}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Tier change confirmation modal */}
      {selectedTier && accountData && (
        <TierChangeModal
          currentTier={currentTier}
          newTier={selectedTier}
          accountId={accountData.accountId}
          billingPreview={billingPreview}
          previewLoading={previewLoading}
          previewError={previewError}
          onConfirm={confirmTierChange}
          onCancel={() => {
            setSelectedTier(null);
            setBillingPreview(null);
            setPreviewError(null);
          }}
          changing={changing}
        />
      )}
    </>
  );
}
