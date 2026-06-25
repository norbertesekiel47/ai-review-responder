// src/lib/payments/stripe-client.ts
//
// Single owner of Stripe client construction. Every call site (checkout,
// portal, webhook ingress, overage worker, reconciliation poller, and the
// account-offboarding flows) MUST source its Stripe client from here so the
// apiVersion, timeout, and retry policy have one authoritative representation.
//
// apiVersion is pinned to the version the installed `stripe` SDK (22.2.0) is
// generated against. Bump this constant deliberately when upgrading the SDK,
// and keep the Stripe Dashboard webhook endpoint API version in lockstep
// (webhook payload shapes are governed by the ENDPOINT version, not this pin).

import Stripe from 'stripe';
import { getServerConfig } from '@/lib/config/server';

export const STRIPE_CLIENT_CONFIG = {
  apiVersion: '2026-05-27.dahlia',
  timeout: 20_000,
  maxNetworkRetries: 2,
} as const;

let stripeInstance: Stripe | null = null;

/** Lazy singleton. Throws (does not crash on import) when the key is absent. */
export function getStripe(): Stripe {
  if (!stripeInstance) {
    // getServerConfig() is read at RUNTIME inside this lazy singleton (never at
    // import), so the worker's dotenv (loaded in worker/env.ts before any job)
    // is populated by the time this runs — same value the old raw read saw.
    // STRIPE_SECRET_KEY is rawOptionalVar, so '   ' stays truthy and reaches
    // new Stripe('   ') exactly as before; the narrow `if (!key)` assert below is
    // preserved on the raw value (NOT the over-asserting getStripeConfig()).
    const key = getServerConfig().STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeInstance = new Stripe(key, {
      apiVersion: STRIPE_CLIENT_CONFIG.apiVersion,
      timeout: STRIPE_CLIENT_CONFIG.timeout,
      maxNetworkRetries: STRIPE_CLIENT_CONFIG.maxNetworkRetries,
    });
  }
  return stripeInstance;
}

/** Test-only: clears the singleton so env stubbing takes effect per case. */
export function resetStripeClientForTests(): void {
  stripeInstance = null;
}
