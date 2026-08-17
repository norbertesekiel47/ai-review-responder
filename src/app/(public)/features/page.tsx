import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled, trialPeriodDays } from '@/lib/payments/flags';
import { FeaturesContent } from '@/components/sections/features/FeaturesContent';

export const metadata: Metadata = {
  title: 'Features · RepWorth',
  description:
    'The AI agent team for your reputation: Reply drafts in your voice, Guardian triages negative reviews, Autopilot posts within your policy, and a Judge reviews every auto-post.',
};

export default function FeaturesPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  // Same door as the landing page and /pricing (see how-it-works/page.tsx).
  const signupCtaLabel = selfServeEnabled
    ? isTrialEnabled()
      ? `Start your ${trialPeriodDays()}-day free trial`
      : 'Create account'
    : null;
  return <FeaturesContent selfServeEnabled={selfServeEnabled} signupCtaLabel={signupCtaLabel} />;
}
