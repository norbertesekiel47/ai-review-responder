// src/lib/config/stripe-shape.ts
//
// Shared Stripe env shape for both lanes. The server and worker both need the
// same Stripe secret + 6 price IDs and narrow them identically, so the type, the
// required-var list, and the non-null narrowing live here once (DRY) instead of
// being duplicated in server.ts and worker.ts.
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
import { requirePresentIn } from './schema-helpers';

export const STRIPE_REQUIRED_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  ...STRIPE_PRICE_ENV_VARS,
] as const;

type StripePriceEnvConfig = {
  [Key in (typeof STRIPE_PRICE_ENV_VARS)[number]]: string;
};

export type StripeEnvConfig = StripePriceEnvConfig & {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
};

/**
 * Assert presence of every Stripe var in `env` and narrow to the non-null shape.
 * Asserts against the SAME snapshot it narrows (Stage label distinguishes the two
 * lanes), so the throw and the `!` narrowing can never disagree — every non-null
 * read below is guarded by the requirePresentIn throw above it, the
 * "required-ness at the accessor" pattern, not papering over `any`.
 */
export function narrowStripeConfig(
  env: Partial<Record<string, string>>,
  subsystem = 'stripe',
): StripeEnvConfig {
  requirePresentIn(env, STRIPE_REQUIRED_VARS, subsystem);
  const priceConfig = Object.fromEntries(
    STRIPE_PRICE_ENV_VARS.map((name) => [name, env[name]!]),
  ) as StripePriceEnvConfig;
  return {
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY!,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET!,
    ...priceConfig,
  };
}
