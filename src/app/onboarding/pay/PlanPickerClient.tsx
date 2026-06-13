'use client';

import { useState } from 'react';
import Link from 'next/link';
import { LazyMotion, m, domAnimation } from 'motion/react';
import { buttonMotion } from '../_shared/field-styles';

import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

import { getOnboardingPlans } from './plan-options';

const PLANS = getOnboardingPlans();

export function PlanPickerClient({ cancelled }: { cancelled: boolean }) {
  const [selecting, setSelecting] = useState<SubscriptionTierValue | null>(
    null,
  );
  const [error, setError] = useState('');

  async function handlePick(tier: SubscriptionTierValue) {
    if (selecting) return;
    setSelecting(tier);
    setError('');
    try {
      const res = await fetch('/api/onboarding/select-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          // Hard navigation (full reload) to clear stale client/auth state.
          // eslint-disable-next-line react-hooks/immutability
          window.location.href = '/login';
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.subscriptionStatus === SubscriptionStatus.ACTIVE) {
          // Hard navigation so the dashboard loads with fresh server state.
          // eslint-disable-next-line react-hooks/immutability
          window.location.href = '/dashboard';
          return;
        }
        setError(
          body.error === 'rate_limited'
            ? 'Too many attempts — wait a moment and try again.'
            : body.error === 'checkout_unavailable' || body.error === 'payment_link_unavailable'
              ? 'Checkout unavailable. Please contact support.'
              : 'Something went wrong. Please try again.',
        );
        setSelecting(null);
        return;
      }
      const { paymentUrl } = (await res.json()) as { paymentUrl: string };
      // Hand off to Stripe — full navigation, not a router.push, because
      // Stripe Payment Links live on a different origin.
      // eslint-disable-next-line react-hooks/immutability
      window.location.href = paymentUrl;
    } catch {
      setError('Connection failed. Please try again.');
      setSelecting(null);
    }
  }

  return (
    <LazyMotion features={domAnimation}>
    <div className="w-full">
      {cancelled && (
        <p className="text-sm text-[#6a6a6a] mb-4 text-center">
          No worries, pick a plan when you&apos;re ready.
        </p>
      )}
      <h1 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-2 text-center">
        Choose your plan
      </h1>
      <p className="text-[#6a6a6a] text-center mb-10">
        You can switch tiers any time from your dashboard.
      </p>

      <div className="grid md:grid-cols-4 gap-6">
        {PLANS.map((plan) => {
          const isLoading = selecting === plan.tier;
          const isOtherLoading = selecting !== null && !isLoading;
          return (
            <div
              key={plan.tier}
              className={`relative rounded-2xl p-7 mx-1 sm:mx-0 border shadow-lg flex flex-col bg-white ${
                plan.highlight
                  ? 'border-[#97B3AE]/40 bg-gradient-to-br from-[#F0EEEA]/60 to-white'
                  : 'border-[#97B3AE]/10'
              }`}
            >
              <div
                className="absolute -top-3 left-6 px-3 py-1 rounded-full text-xs font-medium"
                style={{ background: plan.badgeColor, color: plan.badgeText }}
              >
                {plan.badge}
              </div>

              <h3 className="text-xl font-medium text-[#2a2a2a] mt-2 mb-1">
                {plan.name}
              </h3>
              <p className="text-sm text-[#6a6a6a] mb-4">{plan.description}</p>
              <div className="mb-6">
                <span className="text-4xl font-medium text-[#2a2a2a]">
                  {plan.price}
                </span>
                <span className="text-[#6a6a6a] text-sm">/month</span>
              </div>

              <m.button
                type="button"
                onClick={() => handlePick(plan.tier)}
                disabled={isLoading || isOtherLoading}
                {...buttonMotion}
                className={`block w-full text-center py-3 rounded-full font-medium text-sm mb-6 transition disabled:opacity-50 disabled:cursor-not-allowed ${
                  plan.highlight
                    ? 'bg-[#97B3AE] text-white shadow-lg hover:bg-[#7e9b96]'
                    : 'bg-[#F0EEEA] text-[#2a2a2a] border border-[#97B3AE]/10 hover:bg-[#e7e3dc]'
                }`}
              >
                {isLoading ? 'Redirecting to checkout…' : plan.cta}
              </m.button>

              <p className="text-xs text-[#6a6a6a] -mt-4 mb-6 text-center">
                Auto-renews monthly until you cancel. Cancel anytime from your account.
              </p>

              <ul className="space-y-3 flex-1">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2 text-sm text-[#6a6a6a]"
                  >
                    <svg
                      className="size-4 text-[#97B3AE] shrink-0 mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.5}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-[#6a6a6a] text-center mt-8 max-w-xl mx-auto">
        Subscriptions auto-renew monthly at the listed price plus applicable taxes
        until cancelled. Cancel anytime from your account. By subscribing you agree
        to our{' '}
        <Link href="/legal/terms" className="underline hover:text-[#2a2a2a]">
          Terms
        </Link>
        .
      </p>

      {error && (
        <p role="alert" className="text-sm text-red-600 text-center mt-6">
          {error}
        </p>
      )}
    </div>
    </LazyMotion>
  );
}
