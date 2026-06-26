import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { PricingContent } from './PricingContent';

export const metadata: Metadata = {
  title: 'Pricing · RepWorth',
  description: 'Simple per-location pricing for automated, owner-approved Google review responses.',
};

export default function PricingPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  return <PricingContent selfServeEnabled={selfServeEnabled} />;
}
