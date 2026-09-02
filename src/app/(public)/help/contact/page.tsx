import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled } from '@/lib/payments/flags';
import { ContactContent } from './ContactContent';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Contact support',
  // No per-plan support commitments exist, so the description promises none.
  description: 'Email RepWorth support, billing, or security.',
};

export default function HelpContactPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  const trialOn = selfServeEnabled && isTrialEnabled();
  return <ContactContent selfServeEnabled={selfServeEnabled} trialEnabled={trialOn} />;
}
