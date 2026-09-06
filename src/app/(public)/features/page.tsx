import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled, trialPeriodDays } from '@/lib/payments/flags';
import { FeaturesContent } from '@/components/sections/features/FeaturesContent';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Features',
  description:
    'One system, five jobs: Reply answers every Google review in your voice, Solicitor and a printable QR code bring new reviews in, Insights briefs you every Monday, the dashboard keeps the score, and two watchdogs govern anything that posts on its own.',
};

export default function FeaturesPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  const trialOn = selfServeEnabled && isTrialEnabled();
  // Same door as the landing page and /pricing (see how-it-works/page.tsx).
  const signupCtaLabel = selfServeEnabled
    ? isTrialEnabled()
      ? `Start your ${trialPeriodDays()}-day free trial`
      : 'Create account'
    : null;
  return <FeaturesContent selfServeEnabled={selfServeEnabled} trialEnabled={trialOn} signupCtaLabel={signupCtaLabel} />;
}
