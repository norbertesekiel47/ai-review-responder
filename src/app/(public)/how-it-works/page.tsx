import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled, trialPeriodDays } from '@/lib/payments/flags';
import { HowItWorksContent } from '@/components/sections/how-it-works/HowItWorksContent';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'How it works',
  description:
    'Watch, triage, draft, gate, post, judge: one review, end to end. Around it, Solicitor and a printable QR code bring new reviews in, Insights briefs you every Monday, and the dashboard keeps the score. On Copilot you approve every reply; on Autopilot, policy-cleared replies post after a veto window you control.',
};

export default function HowItWorksPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  const trialOn = selfServeEnabled && isTrialEnabled();
  // Same door as the landing page and /pricing: with self-serve on the CTA is
  // /signup (trial label only when the trial is also on); with it off the
  // lead-capture form is the only door there is.
  const signupCtaLabel = selfServeEnabled
    ? isTrialEnabled()
      ? `Start your ${trialPeriodDays()}-day free trial`
      : 'Create account'
    : null;
  return <HowItWorksContent selfServeEnabled={selfServeEnabled} trialEnabled={trialOn} signupCtaLabel={signupCtaLabel} />;
}
