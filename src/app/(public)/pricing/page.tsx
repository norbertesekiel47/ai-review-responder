import { PricingContent } from './PricingContent';

export default function PricingPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <PricingContent selfServeEnabled={selfServeEnabled} />;
}
