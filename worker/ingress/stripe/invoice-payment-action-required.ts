// worker/ingress/stripe/invoice-payment-action-required.ts
//
// Stripe fires invoice.payment_action_required when a charge needs SCA / 3DS
// authentication the customer has not completed — at a trial-end charge this
// means the first paid invoice is unpaid pending authentication. For RepWorth
// the entitlement outcome is identical to a payment failure: move the account to
// past_due with the 7-day grace window (active→past_due inline; trialing→past_due
// through the applier, which clears trial_ends_at and emits trial_payment_failed).
// Delegate to the single past_due transition rather than duplicating it.

import type Stripe from 'stripe';
import { processInvoicePaymentFailed } from './invoice-payment-failed';

export async function processInvoicePaymentActionRequired(invoice: Stripe.Invoice): Promise<void> {
  await processInvoicePaymentFailed(invoice);
}
