// src/lib/config/stripe-shape.ts
//
// Shared Stripe env shape for both lanes. The server and worker both need the
// same Stripe secret + 7 price IDs and narrow them identically, so the type, the
// required-var list, and the non-null narrowing live here once (DRY) instead of
// being duplicated in server.ts and worker.ts.
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';

export const STRIPE_REQUIRED_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  ...STRIPE_PRICE_ENV_VARS,
] as const;

export interface StripeEnvConfig {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_BASIC: string;
  STRIPE_PRICE_FOUNDING: string;
  STRIPE_PRICE_STANDARD: string;
  STRIPE_PRICE_PREMIUM: string;
  STRIPE_PRICE_STANDARD_OVERAGE: string;
  STRIPE_PRICE_PREMIUM_OVERAGE: string;
  STRIPE_PRICE_FOUNDERS_OVERAGE: string;
}

/**
 * Narrow a raw env snapshot to the non-null Stripe shape. The caller MUST have
 * already asserted presence (requirePresent(STRIPE_REQUIRED_VARS, …)) — every
 * non-null read below is guarded by that prior throw, the "required-ness at the
 * accessor" pattern, not papering over `any`.
 */
export function narrowStripeConfig(env: Partial<Record<string, string>>): StripeEnvConfig {
  return {
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY!,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET!,
    STRIPE_PRICE_BASIC: env.STRIPE_PRICE_BASIC!,
    STRIPE_PRICE_FOUNDING: env.STRIPE_PRICE_FOUNDING!,
    STRIPE_PRICE_STANDARD: env.STRIPE_PRICE_STANDARD!,
    STRIPE_PRICE_PREMIUM: env.STRIPE_PRICE_PREMIUM!,
    STRIPE_PRICE_STANDARD_OVERAGE: env.STRIPE_PRICE_STANDARD_OVERAGE!,
    STRIPE_PRICE_PREMIUM_OVERAGE: env.STRIPE_PRICE_PREMIUM_OVERAGE!,
    STRIPE_PRICE_FOUNDERS_OVERAGE: env.STRIPE_PRICE_FOUNDERS_OVERAGE!,
  };
}
