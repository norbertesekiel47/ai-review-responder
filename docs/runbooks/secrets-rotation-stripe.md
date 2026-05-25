# Secrets Rotation: Stripe

Owner: founder
Cadence: every 6 months and immediately after suspected exposure

## Scope

- Stripe API secret key
- Stripe webhook signing secret
- Stripe price IDs are configuration, not secrets

## Procedure

1. Create replacement secret in Stripe dashboard.
2. Add replacement value to Railway and Vercel environment stores.
3. Deploy worker and app.
4. Verify webhook delivery and checkout portal creation.
5. Remove old secret.
6. Record date, actor, and verification result in the rotation log.

## Rotation Log

| Date | Actor | Secret | Verification |
|---|---|---|---|
