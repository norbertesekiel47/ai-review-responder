'use client';

import { useReducer, useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { AccountSettingsData } from '@/hooks/useAccountData';
import {
  isWs8SubscriptionTier,
  type PriceVariant,
  type Ws8SubscriptionTier,
} from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';
import { CancelSubscriptionPanel } from '@/components/dashboard/settings/CancelSubscriptionPanel';

const BILLING_PLAN_ORDER = ['copilot', 'autopilot'] as const satisfies readonly Ws8SubscriptionTier[];

type BillingPreview = {
  basePriceCents: number;
  includedLocations: number;
  overagePriceCents: number;
  overageUnits: number;
  totalCents: number;
};

interface TierChangeState {
  selectedTier: Ws8SubscriptionTier | null;
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
  | { type: 'previewStart'; selectedTier: Ws8SubscriptionTier; operationKey: string }
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
        tierChangeError: null,
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
      return { ...state, selectedTier: null, operationKey: null, billingPreview: null };
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

function planLabel(tier: Ws8SubscriptionTier): string {
  return tier === 'copilot' ? 'Copilot' : 'Autopilot';
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface TierChangeModalProps {
  newTier: Ws8SubscriptionTier;
  isDowngrade: boolean;
  priceVariant: PriceVariant;
  trialing: boolean;
  billingPreview: BillingPreview | null;
  previewLoading: boolean;
  previewError: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  changing: boolean;
}

export function TierChangeModal({
  newTier,
  isDowngrade,
  priceVariant,
  trialing,
  billingPreview,
  previewLoading,
  previewError,
  onConfirm,
  onCancel,
  changing,
}: TierChangeModalProps) {
  return (
    <SettingsModal
      title={isDowngrade ? 'Downgrade plan' : 'Upgrade plan'}
      closeLabel="Cancel tier change"
      onClose={onCancel}
    >
      <div className="set-section-title" style={{ marginBottom: 8 }}>
        {isDowngrade ? 'Downgrade' : 'Upgrade'} to {planLabel(newTier)}?
      </div>
      <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, marginBottom: 12 }}>
        {trialing
          ? 'Your current trial continues. The selected monthly plan price applies when the trial ends unless you cancel.'
          : isDowngrade
            ? 'Your plan will change immediately and Stripe will apply any required proration.'
            : 'Your plan will change immediately and Stripe will apply any required proration.'}
      </p>

      {previewLoading && (
        <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', textAlign: 'center', padding: 8 }}>
          Calculating new billing…
        </p>
      )}
      {previewError && (
        <div role="alert" style={{ fontSize: 13, color: 'var(--rw-danger)', padding: 8 }}>
          {previewError}
        </div>
      )}
      {billingPreview && !previewLoading && (
        <div className="billing-preview-card">
          <div className="billing-preview-title">
            New monthly estimate
            {priceVariant === 'founding' && <span className="billing-variant-badge">Founding-for-life</span>}
          </div>
          <div className="billing-preview-lines">
            <div><span>Base ({planLabel(newTier)})</span><span>{formatMoney(billingPreview.basePriceCents)}/month</span></div>
            <div><span>Included locations</span><span>{billingPreview.includedLocations}</span></div>
            <div><span>Extra-location rate</span><span>{formatMoney(billingPreview.overagePriceCents)}/month each</span></div>
            {billingPreview.overageUnits > 0 && (
              <div>
                <span>Extra locations ({billingPreview.overageUnits})</span>
                <span>{formatMoney(billingPreview.overagePriceCents * billingPreview.overageUnits)}/month</span>
              </div>
            )}
            <div className="billing-preview-total">
              <span>Total</span><span>{formatMoney(billingPreview.totalCents)}/month</span>
            </div>
          </div>
        </div>
      )}
      {billingPreview && !previewLoading && (
        <p style={{ fontSize: 12, color: 'var(--rw-app-text-muted)', marginBottom: 12, textAlign: 'center' }}>
          Estimate shown before any applicable taxes. Subscription continues monthly until cancelled.
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={changing}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onConfirm}
          disabled={changing || previewLoading || !billingPreview}
        >
          {changing ? 'Changing…' : `Confirm ${isDowngrade ? 'downgrade' : 'upgrade'}`}
        </button>
      </div>
    </SettingsModal>
  );
}

function QuotaBar({ activeLocations, included, overage }: {
  activeLocations: number;
  included: number;
  overage: number;
}) {
  const totalSlots = included + overage;
  const includedPct = totalSlots > 0 ? Math.min((Math.min(activeLocations, included) / totalSlots) * 100, 100) : 0;
  const overagePct = totalSlots > 0 ? (Math.min(overage, Math.max(0, activeLocations - included)) / totalSlots) * 100 : 0;

  return (
    <div className="quota-bar-wrap">
      <div className="quota-bar-label">
        <strong>{activeLocations}</strong> of {included} included{overage > 0 ? `, ${overage} overage` : ''}
      </div>
      <div className="quota-bar-track">
        <div className="quota-bar-fill included" style={{ width: `${includedPct}%` }} />
        {overage > 0 && <div className="quota-bar-fill overage" style={{ width: `${overagePct}%`, marginLeft: 0 }} />}
      </div>
    </div>
  );
}

function CurrentPlanCard({ account }: { account: AccountSettingsData }) {
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  async function openBillingPortal() {
    setPortalLoading(true);
    setPortalError(null);
    try {
      const portalRes = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: account.accountId }),
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

  const currentLabel = isWs8SubscriptionTier(account.subscription.tier)
    ? planLabel(account.subscription.tier)
    : account.subscription.tierLabel;

  return (
    <div className="plan-card">
      <div>
        <div className="plan-eyebrow">Current plan</div>
        <div className="plan-name">{currentLabel}</div>
        <div className="plan-price">
          {formatMoney(account.billing.basePriceCents)}/month base
          {account.billing.overageUnits > 0 && (
            <> + {formatMoney(account.billing.overagePriceCents)}/month × {account.billing.overageUnits} extra</>
          )}
        </div>
        <div className="plan-renew">
          {account.subscription.priceVariant === 'founding'
            ? 'Founding-for-life pricing'
            : 'List pricing'}
          {' · '}Status: <span style={{ fontWeight: 600 }}>{account.subscription.statusLabel}</span>
          {account.subscription.activatedAt && (
            <> · Active since {new Date(account.subscription.activatedAt).toLocaleDateString()}</>
          )}
        </div>
      </div>
      {account.subscription.stripeCustomerId && (
        <button type="button" className="plan-cta" onClick={openBillingPortal} disabled={portalLoading}>
          {portalLoading ? 'Opening…' : 'Manage billing'}
        </button>
      )}
      {portalError && (
        <div role="alert" style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--rw-danger)', marginTop: 4 }}>
          {portalError}
        </div>
      )}
    </div>
  );
}

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

  async function openTierChangeModal(newTier: Ws8SubscriptionTier) {
    if (!accountData) return;
    if (!accountData.planPresentation.purchasable[newTier]) {
      dispatch({ type: 'confirmError', tierChangeError: 'Autopilot is not currently available. Copilot remains available.' });
      return;
    }
    dispatch({ type: 'previewStart', selectedTier: newTier, operationKey: crypto.randomUUID() });
    try {
      const res = await fetch('/api/billing/tier-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: accountData.accountId, newTier, preview: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        dispatch({
          type: 'previewError',
          previewError: body.error === 'tier_not_purchasable'
            ? 'Autopilot is no longer available. Choose Copilot to continue.'
            : body.error ?? body.detail ?? `Tier change not allowed (${res.status})`,
        });
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
    if (!accountData || !selectedTier || !operationKey || !billingPreview) return;
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

  const currentTier = accountData && isWs8SubscriptionTier(accountData.subscription.tier)
    ? accountData.subscription.tier
    : null;
  const selectedPrice = accountData && selectedTier
    ? accountData.planPresentation.prices[selectedTier]
    : null;
  const selectedIsDowngrade = Boolean(
    accountData && selectedPrice && selectedPrice.basePriceCents < accountData.billing.basePriceCents,
  );

  return (
    <>
      <div id="subscription-billing" className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon violet"><Icon name="chart" size={18} /></div>
          <div>
            <div className="set-section-title">Subscription &amp; billing</div>
            <div className="set-section-sub">Your stored plan pricing, location quota, and monthly subscription.</div>
          </div>
        </div>

        {accountLoading && <p style={{ textAlign: 'center', color: 'var(--rw-app-text-muted)', padding: '24px 0' }}>Loading account data…</p>}
        {accountError && <div role="alert" style={{ fontSize: 13, color: 'var(--rw-danger)', padding: '8px 0' }}>{accountError}</div>}
        {accountData && (
          <>
            <CurrentPlanCard account={accountData} />

            <div style={{ marginTop: 16 }}>
              <div className="billing-subhead">Location quota</div>
              <QuotaBar activeLocations={accountData.quota.activeLocations} included={accountData.quota.included} overage={accountData.quota.overage} />
            </div>

            <div style={{ marginTop: 20 }}>
              <div className="billing-subhead">Copilot and Autopilot</div>
              {!currentTier && (
                <p className="billing-plan-note">Plan changes are unavailable until this account is on a launch tier.</p>
              )}
              <div className="billing-plan-grid">
                {BILLING_PLAN_ORDER.map((tier) => {
                  const option = accountData.planPresentation.prices[tier];
                  const isCurrent = tier === currentTier;
                  const isAvailable = accountData.planPresentation.purchasable[tier];
                  const isDowngrade = option.basePriceCents < accountData.billing.basePriceCents;
                  const action = isDowngrade ? 'Downgrade' : 'Upgrade';
                  const displayedBaseCents = isCurrent
                    ? accountData.billing.basePriceCents
                    : option.basePriceCents;
                  const displayedOverageCents = isCurrent
                    ? accountData.billing.overagePriceCents
                    : option.locationsOveragePriceCents;
                  const displayedIncluded = isCurrent
                    ? accountData.quota.included
                    : option.locationsIncluded;
                  return (
                    <article key={tier} className={`billing-plan-option ${isCurrent ? 'is-current' : ''}`}>
                      <div>
                        <div className="billing-plan-name">{planLabel(tier)}</div>
                        <div className="billing-plan-price">{formatMoney(displayedBaseCents)}/month</div>
                        <div className="billing-plan-overage">
                          {displayedIncluded} included · {formatMoney(displayedOverageCents)}/month each extra
                        </div>
                      </div>
                      {isCurrent ? (
                        <span className="billing-current-label">Current plan</span>
                      ) : (
                        <button
                          type="button"
                          className={isDowngrade ? 'btn btn-secondary' : 'btn btn-primary'}
                          onClick={() => openTierChangeModal(tier)}
                          disabled={!currentTier || !isAvailable}
                          aria-describedby={!isAvailable ? `${tier}-billing-unavailable` : undefined}
                        >
                          {isAvailable
                            ? `${action} to ${planLabel(tier)} (${formatMoney(option.basePriceCents)}/month)`
                            : 'Autopilot unavailable'}
                        </button>
                      )}
                      {!isAvailable && !isCurrent && (
                        <p id={`${tier}-billing-unavailable`} className="billing-plan-note">
                          Its safety runtime is closed. Copilot remains available.
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
              {tierChangeError && <div role="alert" style={{ fontSize: 12, color: 'var(--rw-danger)', marginTop: 8 }}>{tierChangeError}</div>}
            </div>
          </>
        )}
      </div>

      <CancelSubscriptionPanel accountTimeZone={accountData?.timeZone ?? 'UTC'} onAccountRefetch={onAccountRefetch} />

      {selectedTier && accountData && isPriceVariantForDisplay(accountData.subscription.priceVariant) && (
        <TierChangeModal
          newTier={selectedTier}
          isDowngrade={selectedIsDowngrade}
          priceVariant={accountData.subscription.priceVariant}
          trialing={accountData.subscription.status === SubscriptionStatus.TRIALING}
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

function isPriceVariantForDisplay(value: string): value is PriceVariant {
  return value === 'list' || value === 'founding';
}
