import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { isFoundingWindowOpen } from '@/lib/payments/founding-window';
import { trialEnabled as isTrialEnabled } from '@/lib/payments/flags';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import { autopilotPurchasable } from '@/lib/payments/tier-purchasability';
import { PricingContent } from './PricingContent';

export const metadata: Metadata = {
  title: 'Pricing · RepWorth',
  description: 'Transparent monthly pricing for Copilot and policy-controlled Autopilot review response workflows.',
};

export default function PricingPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  const viewModel = buildPlanPresentation({
    priceVariant: isFoundingWindowOpen() ? 'founding' : 'list',
    autopilotPurchasable: autopilotPurchasable(),
    trialEnabled: selfServeEnabled && isTrialEnabled(),
  });
  return (
    <PricingContent
      selfServeEnabled={selfServeEnabled}
      viewModel={viewModel}
    />
  );
}
