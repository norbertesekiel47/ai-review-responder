import {
  SubscriptionTier,
  type SubscriptionTierValue,
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

export function assertTierPurchasable(tier: SubscriptionTierValue): void {
  if (tier === SubscriptionTier.COPILOT) return;
  if (tier !== SubscriptionTier.AUTOPILOT) {
    throw new Error(`Unknown purchasable subscription tier: ${String(tier)}`);
  }
  if (!autopilotPurchasable()) {
    throw new TierNotPurchasableError();
  }
}
