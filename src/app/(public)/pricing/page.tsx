import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { isFoundingWindowOpen } from '@/lib/payments/founding-window';
import { trialEnabled as isTrialEnabled } from '@/lib/payments/flags';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import { autopilotPurchasable } from '@/lib/payments/tier-purchasability';
import { PricingContent } from './PricingContent';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Pricing',
  description: 'Transparent monthly pricing for Copilot and Autopilot. Both plans include the whole agent team: review replies, review requests by email and QR code, the weekly brief, and the dashboard. Autopilot adds bounded autonomy inside your policy.',
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
