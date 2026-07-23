import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { HowItWorksContent } from '@/components/sections/how-it-works/HowItWorksContent';

export const metadata: Metadata = {
  title: 'How it works · RepWorth',
  description:
    'Watch, triage, draft, gate, post, judge. On Copilot you approve every reply; on Autopilot, policy-cleared replies post after a veto window you control.',
};

export default function HowItWorksPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  return <HowItWorksContent selfServeEnabled={selfServeEnabled} />;
}
