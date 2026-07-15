import {
  SubscriptionTier,
  type Ws8SubscriptionTier,
} from '@/lib/accounts/tier-config';
import { autoApprovalRuntimeEnabled } from '@/lib/auto-approval/flags';
import { getServerConfig } from '@/lib/config/server';

export function autopilotPurchasable(): boolean {
  return (
    getServerConfig().AUTOPILOT_PURCHASABLE === 'true' &&
    autoApprovalRuntimeEnabled()
  );
}

export class TierNotPurchasableError extends Error {
  constructor() {
    super('Autopilot is not currently purchasable');
    this.name = 'TierNotPurchasableError';
  }
}

export function assertTierPurchasable(tier: Ws8SubscriptionTier): void {
  if (tier === SubscriptionTier.COPILOT) return;
  if (tier !== SubscriptionTier.AUTOPILOT) {
    throw new Error(`Unknown purchasable subscription tier: ${String(tier)}`);
  }
  if (!autopilotPurchasable()) {
    throw new TierNotPurchasableError();
  }
}
