import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { FeaturesContent } from '@/components/sections/features/FeaturesContent';

export const metadata: Metadata = {
  title: 'Features · RepWorth',
  description:
    'Owner-approved AI review replies, multi-location support, brand voice controls, and notifications — see what RepWorth does.',
};

export default function FeaturesPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  return <FeaturesContent selfServeEnabled={selfServeEnabled} />;
}
