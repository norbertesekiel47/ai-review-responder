'use client';

import { useReducer, useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { AccountSettingsData } from '@/hooks/useAccountData';
import { type SubscriptionTierValue, TIER_CONFIG } from '@/lib/accounts/tier-config';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';
import { CancelSubscriptionPanel } from '@/components/dashboard/settings/CancelSubscriptionPanel';

const TIER_OPTIONS: SubscriptionTierValue[] = ['basic', 'standard', 'premium', 'founders'];

type BillingPreview = {
  basePriceCents: number;
  overagePriceCents: number;
  overageUnits: number;
  totalCents: number;
};

interface TierChangeState {
  selectedTier: SubscriptionTierValue | null;
  operationKey: string | null;
  billingPreview: BillingPreview | null;
  previewLoading: boolean;
  previewError: string | null;
  changing: boolean;
  tierChangeError: string | null;
}

const initialTierChangeState: TierChangeState = {
  selectedTier: null,
  operationKey: null,
  billingPreview: null,
  previewLoading: false,
  previewError: null,
  changing: false,
  tierChangeError: null,
};

type TierChangeAction =
  | { type: 'previewStart'; selectedTier: SubscriptionTierValue; operationKey: string }
  | { type: 'previewError'; previewError: string }
  | { type: 'previewSuccess'; billingPreview: BillingPreview | null }
  | { type: 'previewFinish' }
  | { type: 'confirmStart' }
  | { type: 'confirmSuccess' }
  | { type: 'confirmError'; tierChangeError: string }
  | { type: 'confirmFinish' }
  | { type: 'closeModal' };

function tierChangeReducer(state: TierChangeState, action: TierChangeAction): TierChangeState {
  switch (action.type) {
    case 'previewStart':
      return {
        ...state,
        selectedTier: action.selectedTier,
        operationKey: action.operationKey,
        billingPreview: null,
        previewError: null,
        previewLoading: true,
      };
    case 'previewError':
      return { ...state, previewError: action.previewError };
    case 'previewSuccess':
      return { ...state, billingPreview: action.billingPreview };
    case 'previewFinish':
      return { ...state, previewLoading: false };
    case 'confirmStart':
      return { ...state, changing: true, tierChangeError: null };
    case 'confirmSuccess':
      return { ...state, selectedTier: null, operationKey: null };
    case 'confirmError':
      return { ...state, tierChangeError: action.tierChangeError };
    case 'confirmFinish':
      return { ...state, changing: false };
    case 'closeModal':
      return {
        ...state,
        selectedTier: null,
        operationKey: null,
        billingPreview: null,
        previewError: null,
      };
  }
}

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

export function TierChangeModal({
  currentTier,
  newTier,
  billingPreview,
  previewLoading,
  previewError,
  onConfirm,
  onCancel,
  changing,
}: TierChangeModalProps) {
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
        <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, marginBottom: 12 }}>
          {isDowngrade
            ? 'Downgrading will reduce your plan. Your billing will be prorated.'
            : 'Upgrading will give you more features. Your billing will be prorated.'}
        </p>

        {/* Billing preview */}
        {previewLoading && (
          <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', textAlign: 'center', padding: 8 }}>
            Calculating new billing…
          </p>
        )}
        {previewError && (
          <div style={{ fontSize: 13, color: 'var(--rw-danger)', padding: 8 }}>
            {previewError}
          </div>
        )}
        {billingPreview && !previewLoading && (
          <div style={{
            background: 'var(--rw-recess)',
            border: '1px solid var(--rw-hair)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rw-app-text)', marginBottom: 8 }}>
              New monthly estimate
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--rw-app-text-muted)' }}>
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
                borderTop: '1px solid var(--rw-hair)',
                paddingTop: 4,
                marginTop: 4,
                fontWeight: 600,
                color: 'var(--rw-app-text)',
              }}>
                <span>Total</span>
                <span>${(billingPreview.totalCents / 100).toFixed(2)}/mo</span>
              </div>
            </div>
          </div>
        )}
        {billingPreview && !previewLoading && (
          <p style={{ fontSize: 12, color: 'var(--rw-app-text-muted)', marginBottom: 12, textAlign: 'center' }}>
            Estimate shown before any applicable taxes. Subscription continues
            monthly until cancelled.
          </p>
        )}

        {isDowngrade && newTier === 'basic' && (
          <div style={{
            background: 'var(--rw-blush-soft)',
            border: '1px solid var(--rw-blush)',
            borderRadius: 8,
            padding: 8,
            marginBottom: 12,
            fontSize: 12,
            color: 'var(--rw-blush-deep)',
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
        <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--rw-danger)', marginTop: 4 }}>
          {portalError}
        </div>
      )}
    </div>
  );
}

// ── BillingPanel ──────────────────────────────────────────────────────

interface Props {
  accountData: AccountSettingsData | null;
  accountLoading: boolean;
  accountError: string | null;
  onAccountRefetch: () => void;
}

export function BillingPanel({ accountData, accountLoading, accountError, onAccountRefetch }: Props) {
  const [tierChange, dispatch] = useReducer(tierChangeReducer, initialTierChangeState);
  const {
    selectedTier,
    operationKey,
    billingPreview,
    previewLoading,
    previewError,
    changing,
    tierChangeError,
  } = tierChange;

  async function openTierChangeModal(newTier: SubscriptionTierValue) {
    if (!accountData) return;
    dispatch({ type: 'previewStart', selectedTier: newTier, operationKey: crypto.randomUUID() });
    try {
      const res = await fetch('/api/billing/tier-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: accountData.accountId, newTier, preview: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        dispatch({ type: 'previewError', previewError: body.error ?? body.detail ?? `Tier change not allowed (${res.status})` });
        dispatch({ type: 'previewFinish' });
        return;
      }
      const result = await res.json();
      dispatch({ type: 'previewSuccess', billingPreview: result.newBilling ?? null });
    } catch (err) {
      dispatch({ type: 'previewError', previewError: err instanceof Error ? err.message : 'Failed to preview tier change' });
    } finally {
      dispatch({ type: 'previewFinish' });
    }
  }

  async function confirmTierChange() {
    if (!accountData || !selectedTier || !operationKey) return;
    dispatch({ type: 'confirmStart' });
    try {
      const res = await fetch('/api/billing/tier-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationKey },
        body: JSON.stringify({ accountId: accountData.accountId, newTier: selectedTier }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? body.detail ?? 'Tier change failed');
      }
      dispatch({ type: 'confirmSuccess' });
      onAccountRefetch();
    } catch (err) {
      dispatch({ type: 'confirmError', tierChangeError: err instanceof Error ? err.message : 'Failed to change tier' });
    } finally {
      dispatch({ type: 'confirmFinish' });
    }
  }

  const currentTier = (accountData?.subscription?.tier ?? 'standard') as SubscriptionTierValue;
  const otherTiers = TIER_OPTIONS.filter((t) => t !== currentTier);
  const upgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents > TIER_CONFIG[currentTier].baseCents);
  const downgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents < TIER_CONFIG[currentTier].baseCents);

  return (
    <>
      <div id="subscription-billing" className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon violet">
            <Icon name="chart" size={18} />
          </div>
          <div>
            <div className="set-section-title">Subscription &amp; billing</div>
            <div className="set-section-sub">Your plan, billing details, and location quota.</div>
          </div>
        </div>

        {accountLoading && (
          <p style={{ textAlign: 'center', color: 'var(--rw-app-text-muted)', padding: '24px 0' }}>Loading account data…</p>
        )}
        {accountError && <div style={{ fontSize: 13, color: 'var(--rw-danger)', padding: '8px 0' }}>{accountError}</div>}
        {accountData && (
          <>
            <PlanCard subscription={accountData.subscription} billing={accountData.billing} accountId={accountData.accountId} />

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rw-app-text)', marginBottom: 8 }}>Locations quota</div>
              <QuotaBar activeLocations={accountData.quota.activeLocations} included={accountData.quota.included} overage={accountData.quota.overage} />
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rw-app-text)', marginBottom: 8 }}>Change plan</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {downgradableTiers.map((tier) => (
                  <button key={tier} type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => openTierChangeModal(tier)}>
                    Downgrade to {tier.charAt(0).toUpperCase() + tier.slice(1)} (${(TIER_CONFIG[tier].baseCents / 100).toFixed(0)}/mo)
                  </button>
                ))}
                {upgradableTiers.map((tier) => (
                  <button key={tier} type="button" className="btn btn-primary" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => openTierChangeModal(tier)}>
                    Upgrade to {tier.charAt(0).toUpperCase() + tier.slice(1)} (${(TIER_CONFIG[tier].baseCents / 100).toFixed(0)}/mo)
                  </button>
                ))}
              </div>
              {tierChangeError && <div style={{ fontSize: 12, color: 'var(--rw-danger)', marginTop: 4 }}>{tierChangeError}</div>}
            </div>
          </>
        )}
      </div>

      <CancelSubscriptionPanel accountTimeZone={accountData?.timeZone ?? 'UTC'} onAccountRefetch={onAccountRefetch} />

      {selectedTier && accountData && (
        <TierChangeModal
          currentTier={currentTier}
          newTier={selectedTier}
          accountId={accountData.accountId}
          billingPreview={billingPreview}
          previewLoading={previewLoading}
          previewError={previewError}
          onConfirm={confirmTierChange}
          onCancel={() => dispatch({ type: 'closeModal' })}
          changing={changing}
        />
      )}
    </>
  );
}
