'use client';

import { useState } from 'react';
import Link from 'next/link';
import { LazyMotion, m, domAnimation } from 'motion/react';
import { buttonMotion } from '../_shared/field-styles';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import type { PlanPresentationViewModel } from '@/lib/payments/plan-presentation';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { getOnboardingPlans } from './plan-options';

interface Props extends PlanPresentationViewModel {
  cancelled: boolean;
}

export function PlanPickerClient({
  cancelled,
  purchasable,
  prices,
  priceVariant,
  trialEnabled,
}: Props) {
  const viewModel = { purchasable, prices, priceVariant, trialEnabled };
  const plans = getOnboardingPlans(viewModel);
  const [selectedTier, setSelectedTier] = useState<SubscriptionTierValue | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (selecting) return;
    if (!selectedTier) {
      setError('Choose Copilot or Autopilot before continuing.');
      return;
    }
    if (!purchasable[selectedTier]) {
      setError('That plan is no longer available. Choose Copilot to continue.');
      return;
    }

    setSelecting(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding/select-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: selectedTier }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.subscriptionStatus === SubscriptionStatus.ACTIVE) {
          window.location.href = '/dashboard';
          return;
        }
        setError(
          body.error === 'rate_limited'
            ? 'Too many attempts — wait a moment and try again.'
            : body.error === 'tier_not_purchasable'
              ? 'That plan is no longer available. Choose Copilot to continue.'
              : body.error === 'checkout_unavailable' || body.error === 'payment_link_unavailable'
                ? 'Checkout unavailable. Please contact support.'
                : 'Something went wrong. Please try again.',
        );
        setSelecting(false);
        return;
      }
      const { paymentUrl } = (await res.json()) as { paymentUrl: string };
      window.location.href = paymentUrl;
    } catch {
      setError('Connection failed. Please try again.');
      setSelecting(false);
    }
  }

  return (
    <LazyMotion features={domAnimation}>
      <div className="w-full">
        {cancelled && (
          <p className="text-sm text-rw-ink-soft mb-4 text-center">
            No worries, choose a plan when you&apos;re ready.
          </p>
        )}
        <h1 className="text-3xl md:text-4xl font-medium text-rw-ink mb-2 text-center">
          Choose your plan
        </h1>
        <p className="text-rw-ink-soft text-center mb-3">
          Start with no default: choose the authority you want to grant your agent team.
        </p>
        {trialEnabled && (
          <p className="text-sm text-rw-teal-strong text-center mb-8 font-medium">
            30-day trial. Card required up front. Billing for your selected plan starts after the trial unless you cancel.
          </p>
        )}

        <fieldset className="grid md:grid-cols-2 gap-6" aria-describedby="plan-renewal-terms">
          <legend className="sr-only">RepWorth plan</legend>
          {plans.map((plan) => {
            const selected = selectedTier === plan.tier;
            const descriptionId = `${plan.tier}-plan-description`;
            const unavailableId = `${plan.tier}-plan-unavailable`;
            return (
              <label
                key={plan.tier}
                className={`relative rounded-2xl p-7 mx-1 sm:mx-0 border shadow-lg flex flex-col bg-rw-cream cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-rw-teal-strong ${
                  selected
                    ? 'border-rw-teal-strong ring-2 ring-rw-teal-strong/20'
                    : 'border-rw-teal/30'
                } ${plan.purchasable ? '' : 'opacity-65 cursor-not-allowed'}`}
              >
                <span className={`absolute -top-3 left-6 px-3 py-1 rounded-full text-xs font-medium text-rw-ink ${
                  plan.badgeTone === 'peach' ? 'bg-rw-peach' : 'bg-rw-sage'
                }`}>
                  {plan.badge}
                </span>
                <input
                  type="radio"
                  name="subscription-tier"
                  value={plan.tier}
                  checked={selected}
                  disabled={!plan.purchasable || selecting}
                  onChange={() => {
                    setSelectedTier(plan.tier);
                    setError('');
                  }}
                  aria-label={`Choose ${plan.name} plan`}
                  aria-describedby={`${descriptionId}${plan.unavailableReason ? ` ${unavailableId}` : ''}`}
                  className="sr-only"
                />

                <h2 className="text-xl font-medium text-rw-ink mt-2 mb-1">{plan.name}</h2>
                <p id={descriptionId} className="text-sm text-rw-ink-soft mb-4">{plan.description}</p>
                <div className="mb-2">
                  <span className="text-4xl font-medium text-rw-ink">{plan.price}</span>
                  <span className="text-rw-ink-soft text-sm">/month</span>
                </div>
                {priceVariant === 'founding' && (
                  <p className="text-xs text-rw-teal-strong font-medium mb-2">
                    Founding rate locked for the account&apos;s life · <span className="line-through">{plan.listPrice} list</span>
                  </p>
                )}
                <p className="text-xs text-rw-ink-soft mb-6">
                  One location included · {plan.overagePrice}/month per extra location
                </p>

                {plan.unavailableReason && (
                  <p id={unavailableId} className="text-sm text-rw-error mb-5" role="note">
                    {plan.unavailableReason}
                  </p>
                )}

                <ul className="space-y-3 flex-1">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm text-rw-ink-soft">
                      <svg className="size-4 text-rw-teal-strong shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>
              </label>
            );
          })}
        </fieldset>

        <m.button
          type="button"
          onClick={handleSubmit}
          disabled={selecting}
          {...buttonMotion}
          className="block w-full max-w-sm mx-auto mt-8 text-center py-3 rounded-full font-medium text-sm transition bg-rw-teal-strong text-rw-cream shadow-lg hover:bg-rw-teal-strong-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {selecting ? 'Redirecting to checkout…' : 'Continue to secure checkout'}
        </m.button>

        <p id="plan-renewal-terms" className="text-xs text-rw-ink-soft text-center mt-6 max-w-xl mx-auto">
          Subscriptions renew monthly at the listed base price plus extra locations and applicable taxes until cancelled. Cancel anytime from your account. By subscribing you agree to our{' '}
          <Link href="/legal/terms" className="underline hover:text-rw-ink">Terms</Link>.
        </p>

        {error && <p role="alert" className="text-sm text-rw-error text-center mt-6">{error}</p>}
      </div>
    </LazyMotion>
  );
}
