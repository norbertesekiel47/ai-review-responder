import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled } from '@/lib/payments/flags';
import { BookADemoContent } from './BookADemoContent';

export const metadata: Metadata = {
  // The one early-access phrase (EARLY_ACCESS_CTA in marketing-links.ts): the
  // tab title says what the pills that lead here say (the root layout's
  // template appends " · RepWorth"). A literal, not the
  // constant, because page-metadata.test.ts reads titles off the source.
  title: 'Get early access',
  description: 'Request early access to RepWorth: automated, owner-approved Google review responses for local businesses.',
};

export default function BookADemoPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  const trialOn = selfServeEnabled && isTrialEnabled();
  return <BookADemoContent selfServeEnabled={selfServeEnabled} trialEnabled={trialOn} />;
}
