// src/lib/messaging/messaging-adapter.ts
//
// The Messaging adapter seam (#657, map decision 14). Solicitation is its first
// tenant, not its owner: a WhatsApp adapter is a SECOND adapter here, never a
// rewrite. Mirrors src/lib/publishing/review-publisher.ts exactly.
//
// HONEST SCOPE: one adapter exists today and this ticket ships zero production
// callers — #630's dispatch worker is the first. That makes this a hypothetical
// seam, accepted deliberately. The mitigation is the interface: ONE method, whose
// message type is derived from spec §7.1's locked envelope rather than invented.
// If a WhatsApp adapter wants a different shape, almost nothing is committed.

import { EmailAdapter } from './email-adapter';

/**
 * The Solicitation lane's routing discriminant (§5.2) — a CROSS-MODULE CONTRACT,
 * and this file is its single authoritative owner.
 *
 * The tag is EMITTED by `./email-adapter.ts` and READ by
 * `worker/ingress/resend/solicitation-lane.ts` (`isSolicitationLane`). The two
 * halves live in different module trees and no compiler check binds them, so a
 * rename on either side would silently route every solicitation webhook into the
 * `notification_deliveries` lane — whose UPDATEs match zero rows, ack 200, and
 * lose the bounce/complaint permanently. Import these; never re-spell them.
 * `worker/ingress/__tests__/resend-solicitation-routing.test.ts` binds the two
 * halves through these constants so a drift fails a test rather than production.
 */
export const LANE_TAG_NAME = 'lane';
export const SOLICITATION_LANE_TAG_VALUE = 'solicitation';

/**
 * One ask, ready to put on the wire. Every field is required — the adapter
 * refuses to build an envelope from a partial message rather than defaulting.
 */
export interface OutboundMessage {
  /**
   * The Outreach row id. Doubles as the provider idempotency key (amendments
   * A/B — §7.1's `solicitation-ask/<ask_id>` is superseded because it collides
   * across attempts, and a timeout-retry is a ROUTINE path here, not an edge).
   */
  outreachId: string;
  accountId: string;
  businessId: string;
  batchId: string;
  /** From display name — the business name, no 'via RepWorth' suffix (§2.3). */
  businessName: string;
  /** Reply-To — businesses.owner_email (§2.4). */
  ownerEmail: string;
  /** Exactly one recipient, always (§7.1). Never an array. */
  recipient: string;
  subject: string;
  bodyHtml: string;
  /** Plain-text alternative. Always present — HTML-only is a spam signal (§7.1). */
  bodyText: string;
  /** Per-ask one-click unsubscribe URL — the Railway ingress form (§7.3). */
  unsubscribeUrl: string;
}

export interface MessagingAdapter {
  /**
   * Put one ask on the wire.
   *
   * Returns the provider's message id, which the caller records as
   * `solicitation_outreach.provider_message_id` — the join key the Solicitation
   * lane matches webhook events on. A caller that discards it makes every later
   * bounce and complaint unattributable.
   *
   * THROWS on every failure, matching the ReviewPublisher transport-method
   * precedent and sendEmail's existing contract: a validation refusal, a Resend
   * API error, or the sendEmail timeout. #630 classifies for retry.
   */
  send(message: OutboundMessage): Promise<{ providerMessageId: string }>;
}

let cached: MessagingAdapter | null = null;

/**
 * The active messaging adapter. Lazy singleton — the factory shape IS the
 * selection seam: when a WhatsApp adapter lands it is chosen here, not at every
 * call-site.
 */
export function getMessagingAdapter(): MessagingAdapter {
  if (cached === null) cached = new EmailAdapter();
  return cached;
}
