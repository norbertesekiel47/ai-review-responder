import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled, trialPeriodDays } from '@/lib/payments/flags';
import { HowItWorksContent } from '@/components/sections/how-it-works/HowItWorksContent';

export const metadata: Metadata = {
  title: 'How it works · RepWorth',
  description:
    'Watch, triage, draft, gate, post, judge. On Copilot you approve every reply; on Autopilot, policy-cleared replies post after a veto window you control.',
};

export default function HowItWorksPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  // Same door as the landing page and /pricing: with self-serve on the CTA is
  // /signup (trial label only when the trial is also on); with it off the
  // lead-capture form is the only door there is.
  const signupCtaLabel = selfServeEnabled
    ? isTrialEnabled()
      ? `Start your ${trialPeriodDays()}-day free trial`
      : 'Create account'
    : null;
  return <HowItWorksContent selfServeEnabled={selfServeEnabled} signupCtaLabel={signupCtaLabel} />;
}
