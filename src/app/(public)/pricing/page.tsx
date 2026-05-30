import type { Metadata } from 'next';
import { PricingContent } from './PricingContent';

export const metadata: Metadata = {
  title: 'Pricing · RepWorth',
  description: 'Simple per-location pricing for automated, owner-approved Google review responses.',
};

export default function PricingPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <PricingContent selfServeEnabled={selfServeEnabled} />;
}
