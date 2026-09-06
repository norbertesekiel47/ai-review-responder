import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled, trialPeriodDays } from '@/lib/payments/flags';
import { LandingExperience } from '@/components/sections/landing/LandingExperience';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'RepWorth: The AI agent team for your reputation',
  description:
    'A supervised fleet of AI agents answers your Google reviews in your voice, asks your customers for new ones, briefs you every Monday, and keeps the score. Nothing posts outside the gate you control.',
};

export default function LandingPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  // Server-authoritative flags (invariant #13: no NEXT_PUBLIC_* companion). The
  // trial offer only shows when self-serve signup is also live; there is no
  // signup to start a trial from otherwise.
  const trialEnabled = isTrialEnabled() && selfServeEnabled;

  // Every CTA shares one target. `/signup` 404s when self-serve is off, so fall
  // back to the lead-capture route in that state.
  const primaryCtaHref = selfServeEnabled ? '/signup' : '/book-a-demo';
  const primaryCtaLabel = trialEnabled
    ? `Start your ${trialPeriodDays()}-day free trial`
    : 'Get early access';

  return (
    <LandingExperience
      primaryCtaHref={primaryCtaHref}
      primaryCtaLabel={primaryCtaLabel}
      selfServeEnabled={selfServeEnabled}
    />
  );
}
