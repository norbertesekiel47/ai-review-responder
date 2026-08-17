import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled, trialPeriodDays } from '@/lib/payments/flags';
import { LandingExperience } from '@/components/sections/landing/LandingExperience';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'RepWorth: Automated Google review responses',
  description:
    'RepWorth drafts on-brand replies to your Google reviews and posts them only after your approval, or inside the bounds you set. Reply to every review without the busywork.',
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
