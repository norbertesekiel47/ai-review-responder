import type { Metadata } from 'next';
import { FeaturesContent } from '@/components/sections/features/FeaturesContent';

export const metadata: Metadata = {
  title: 'Features · RepWorth',
  description:
    'Owner-approved AI review replies, multi-location support, brand voice controls, and notifications — see what RepWorth does.',
};

export default function FeaturesPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <FeaturesContent selfServeEnabled={selfServeEnabled} />;
}
