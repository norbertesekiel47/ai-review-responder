import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { HowItWorksContent } from '@/components/sections/how-it-works/HowItWorksContent';

export const metadata: Metadata = {
  title: 'How it works · RepWorth',
  description:
    'Connect Google, RepWorth drafts a reply to each new review, and you approve before anything posts. Here is the full flow.',
};

export default function HowItWorksPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  return <HowItWorksContent selfServeEnabled={selfServeEnabled} />;
}
