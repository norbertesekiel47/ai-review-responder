import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { FeaturesContent } from '@/components/sections/features/FeaturesContent';

export const metadata: Metadata = {
  title: 'Features · RepWorth',
  description:
    'The AI agent team for your reputation: Reply drafts in your voice, Guardian triages negative reviews, Autopilot posts within your policy, and a Judge reviews every auto-post.',
};

export default function FeaturesPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  return <FeaturesContent selfServeEnabled={selfServeEnabled} />;
}
