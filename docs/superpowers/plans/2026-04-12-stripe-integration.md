# Prompt 15: Stripe Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Stripe payments so that completing checkout transitions a business from `pending_payment` to `active`, unlocking recurring review polling by the ReconciliationPoller.

**Architecture:** The Stripe webhook handler runs on Railway (worker/ingress/stripe.ts), receives events, verifies signatures, deduplicates via `inbound_events`, and updates `businesses` table. The onboarding API returns a Payment Link URL in its response. No Vercel forwarding route — webhooks terminate on Railway directly.

**Tech Stack:** Stripe SDK (`stripe` — already installed), Fastify (rawBody), Postgres.js `sql`

---

## Prerequisites (manual — do before coding)

1. Create two Stripe Payment Links in dashboard: Founding ($99/mo), Standard ($149/mo)
2. Note the base URLs (format: `https://buy.stripe.com/XXXXX`)
3. Note the price IDs for each product (`price_xxx`)
4. Create Stripe webhook endpoint → `https://yourworker.railway.app/ingress/stripe`
   - Subscribe to events: `checkout.session.completed`, `invoice.payment_failed`, `invoice.paid`, `customer.subscription.deleted`, `customer.subscription.updated`
5. Note the webhook signing secret (`whsec_...`)
6. Add to `.env.local`:
   ```
   STRIPE_PAYMENT_LINK_FOUNDING=https://buy.stripe.com/xxx
   STRIPE_PAYMENT_LINK_STANDARD=https://buy.stripe.com/yyy
   STRIPE_PRICE_FOUNDING=price_xxx
   STRIPE_PRICE_STANDARD=price_yyy
   ```

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `worker/ingress/stripe.ts` | **REWRITE** | Stripe webhook handler: verify signature, dedup via inbound_events, process 5 event types |
| `worker/index.ts` | **MODIFY** | Replace stripe placeholder route with real handler import |
| `src/app/api/admin/businesses/route.ts` | **MODIFY** | POST response includes Payment Link URL |
| `.env.example` | **MODIFY** | Add 4 new Stripe env vars |

---

## Task 1: Stripe webhook handler

**Files:**
- Rewrite: `worker/ingress/stripe.ts`

- [ ] **Step 1: Rewrite the Stripe webhook handler**

Replace `worker/ingress/stripe.ts`:

```typescript
import type { FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';

const LOG_PREFIX = '[ingress/stripe]';

// Lazy singleton — avoid crashing if STRIPE_SECRET_KEY is not set
let stripeInstance: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

// Map Stripe price IDs to subscription tiers via env vars.
// Do NOT infer tier from product display names — those can change.
function priceTier(priceId: string): string | null {
  if (priceId === process.env.STRIPE_PRICE_FOUNDING) return 'founding';
  if (priceId === process.env.STRIPE_PRICE_STANDARD) return 'standard';
  return null;
}

export async function handleStripeWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody;
  const sig = request.headers['stripe-signature'] as string | undefined;

  if (!rawBody || !sig) {
    reply.status(401).send({ error: 'missing_signature' });
    return;
  }

  // 1. Verify webhook signature
  let event: Stripe.Event;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(`${LOG_PREFIX} STRIPE_WEBHOOK_SECRET not set`);
    reply.status(500).send({ error: 'webhook_secret_not_configured' });
    return;
  }

  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Invalid signature: ${err instanceof Error ? err.message : err}`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  const eventId = event.id;
  const eventType = event.type;
  console.log(`${LOG_PREFIX} Received ${eventType} (${eventId})`);

  // 2. Dedup via inbound_events — check existing first
  const existing = await sql`
    SELECT status FROM inbound_events WHERE external_event_key = ${eventId} LIMIT 1
  `;

  if (existing[0]?.status === 'processed') {
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  // Insert if not exists (received or failed entries get reprocessed below)
  if (!existing[0]) {
    await sql`
      INSERT INTO inbound_events (id, source, external_event_key, event_type, payload, status)
      VALUES (${uuidv7()}, 'stripe', ${eventId}, ${eventType}, ${JSON.stringify(event)}::jsonb, 'received')
      ON CONFLICT (external_event_key) DO NOTHING
    `;
  }

  // 3. Process the event
  try {
    await processStripeEvent(event);

    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${eventId}
    `;

    reply.status(200).send({ received: true });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} Failed to process ${eventType} (${eventId}): ${errorMsg}`);

    await sql`
      UPDATE inbound_events SET status = 'failed', error_message = ${errorMsg}
      WHERE external_event_key = ${eventId}
    `;

    // Return 500 so Stripe retries
    reply.status(500).send({ error: 'processing_failed' });
  }
}

async function processStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const businessId = session.client_reference_id ?? session.metadata?.business_id;
      if (!businessId) {
        console.warn(`${LOG_PREFIX} checkout.session.completed missing client_reference_id`);
        return;
      }
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

      const result = await sql`
        UPDATE businesses
        SET subscription_status = 'active',
            stripe_customer_id = ${customerId ?? null},
            stripe_subscription_id = ${subscriptionId ?? null},
            updated_at = NOW()
        WHERE id = ${businessId}
      `;
      console.log(
        `${LOG_PREFIX} checkout.session.completed: business=${businessId} ` +
        `customer=${customerId} subscription=${subscriptionId} ` +
        `updated=${result.count}`,
      );
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;

      await sql`
        UPDATE businesses SET subscription_status = 'past_due', updated_at = NOW()
        WHERE stripe_customer_id = ${customerId} AND subscription_status = 'active'
      `;
      console.log(`${LOG_PREFIX} invoice.payment_failed: customer=${customerId} → past_due`);
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;

      await sql`
        UPDATE businesses SET subscription_status = 'active', updated_at = NOW()
        WHERE stripe_customer_id = ${customerId} AND subscription_status = 'past_due'
      `;
      console.log(`${LOG_PREFIX} invoice.paid: customer=${customerId} → active (grace recovery)`);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (!customerId) return;

      await sql`
        UPDATE businesses SET subscription_status = 'cancelled', updated_at = NOW()
        WHERE stripe_customer_id = ${customerId}
      `;
      console.log(`${LOG_PREFIX} customer.subscription.deleted: customer=${customerId} → cancelled`);
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (!customerId) return;

      // Check if the price changed → update subscription_tier
      const priceId = sub.items?.data?.[0]?.price?.id;
      if (priceId) {
        const tier = priceTier(priceId);
        if (tier) {
          await sql`
            UPDATE businesses SET subscription_tier = ${tier}, updated_at = NOW()
            WHERE stripe_customer_id = ${customerId}
          `;
          console.log(`${LOG_PREFIX} customer.subscription.updated: customer=${customerId} → tier=${tier}`);
        }
      }
      break;
    }

    default:
      console.log(`${LOG_PREFIX} Unhandled event type: ${event.type}`);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add worker/ingress/stripe.ts
git commit -m "feat: implement Stripe webhook handler (5 event types, signature verification, dedup)"
```

---

## Task 2: Wire handler into worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Import and wire the handler**

In `worker/index.ts`:

1. Add import at the top (near the other ingress import):
```typescript
import { handleStripeWebhook } from './ingress/stripe';
```

2. Replace the Stripe placeholder route (lines 80-83):

Replace:
```typescript
  // Webhook ingress — Stripe placeholder (implemented in Sprint 3, Prompt 15)
  app.post('/ingress/stripe', { config: { rawBody: true } }, async (_request, reply) => {
    reply.status(200).send({ received: true });
  });
```

With:
```typescript
  // Stripe webhook ingress — real handler
  app.post('/ingress/stripe', { config: { rawBody: true } }, handleStripeWebhook);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add worker/index.ts
git commit -m "feat: wire Stripe webhook handler into worker ingress"
```

---

## Task 3: Add Payment Link URL to onboarding API response

**Files:**
- Modify: `src/app/api/admin/businesses/route.ts`

- [ ] **Step 1: Add payment link helper and update POST response**

In `src/app/api/admin/businesses/route.ts`, add a helper function (before or after the existing `splitCommaOrNewline` function):

```typescript
function buildPaymentLinkUrl(tier: string, businessId: string, ownerEmail: string): string | null {
  const links: Record<string, string | undefined> = {
    founding: process.env.STRIPE_PAYMENT_LINK_FOUNDING,
    standard: process.env.STRIPE_PAYMENT_LINK_STANDARD,
  };
  const baseUrl = links[tier];
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  url.searchParams.set('client_reference_id', businessId);
  url.searchParams.set('prefilled_email', ownerEmail);
  return url.toString();
}
```

Then update the POST success response from:
```typescript
return NextResponse.json({ id: businessId }, { status: 201 });
```

To:
```typescript
    const paymentUrl = buildPaymentLinkUrl(data.subscriptionTier, businessId, data.ownerEmail);
    return NextResponse.json({ id: businessId, paymentUrl }, { status: 201 });
```

- [ ] **Step 2: Update the onboarding form to show the payment link**

In `src/app/admin/businesses/new/page.tsx`, update the `onSubmit` function. After the successful POST, before the redirect, if `paymentUrl` is present, copy it to clipboard and show it:

Find the current success handling:
```typescript
      const { id } = await res.json();
      router.push(`/admin/businesses/${id}`);
```

Replace with:
```typescript
      const { id, paymentUrl } = await res.json();
      if (paymentUrl) {
        try { await navigator.clipboard.writeText(paymentUrl); } catch { /* ignore */ }
        alert(`Business created! Payment link copied to clipboard:\n\n${paymentUrl}`);
      }
      router.push(`/admin/businesses/${id}`);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/businesses/route.ts src/app/admin/businesses/new/page.tsx
git commit -m "feat: return Payment Link URL from onboarding API, copy to clipboard on creation"
```

---

## Task 4: Update .env.example with new Stripe vars

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add new Stripe env vars**

Add these lines after the existing `STRIPE_WEBHOOK_SECRET` line in `.env.example`:

```
STRIPE_PAYMENT_LINK_FOUNDING=https://buy.stripe.com/xxx  # Founding Member $99/mo Payment Link
STRIPE_PAYMENT_LINK_STANDARD=https://buy.stripe.com/yyy  # Standard $149/mo Payment Link
STRIPE_PRICE_FOUNDING=price_xxx                          # Stripe Price ID for Founding tier
STRIPE_PRICE_STANDARD=price_yyy                          # Stripe Price ID for Standard tier
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "chore: add Stripe Payment Link + Price ID env vars to .env.example"
```

---

## Task 5: Build + test verification

- [ ] **Step 1: TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: 189/189 tests pass.

- [ ] **Step 3: Run build**

```bash
pnpm build
```

Expected: all pages compile.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix: build fixes for Stripe integration"
```

---

## Verification Checklist

- [ ] Worker starts without errors (even if STRIPE_SECRET_KEY is not set — lazy init)
- [ ] Invalid/missing Stripe signature → 401 (not written to inbound_events)
- [ ] Valid webhook with new event → 200, event written to inbound_events as 'processed'
- [ ] Duplicate event → 200 with `duplicate: true`
- [ ] `checkout.session.completed` with `client_reference_id` → business subscription_status='active', stripe_customer_id + stripe_subscription_id set
- [ ] `invoice.payment_failed` → business moves to 'past_due'
- [ ] `invoice.paid` on past_due business → business recovers to 'active'
- [ ] `customer.subscription.deleted` → business moves to 'cancelled'
- [ ] `customer.subscription.updated` with new price → subscription_tier updated
- [ ] ReconciliationPoller picks up newly-active business in next cycle
- [ ] Onboarding POST response includes `paymentUrl` with `client_reference_id` + `prefilled_email`
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` — 189/189 tests pass
