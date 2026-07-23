import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled } from '@/lib/payments/flags';
import { LandingExperience } from '@/components/sections/landing/LandingExperience';
import { getServerConfig } from '@/lib/config/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'RepWorth: Automated Google review responses',
  description:
    'RepWorth drafts on-brand replies to your Google reviews and posts them only after you approve. Reply to every review without the busywork.',
};

function resolveTrialDays(): number {
  const parsed = Number.parseInt(getServerConfig().TRIAL_PERIOD_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

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
    ? `Start your ${resolveTrialDays()}-day free trial`
    : 'Get early access';

  return <LandingExperience primaryCtaHref={primaryCtaHref} primaryCtaLabel={primaryCtaLabel} />;
}
