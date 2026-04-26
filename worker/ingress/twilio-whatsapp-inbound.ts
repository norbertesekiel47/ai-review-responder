// worker/ingress/twilio-whatsapp-inbound.ts
//
// Twilio WhatsApp inbound message handler. Mounted by worker/index.ts at
// POST /ingress/twilio/whatsapp-inbound. Three flows distinguished by
// payload shape:
//   1. ButtonPayload present → approval/regenerate button tap
//   2. Body starts with 'start-' AND intent is 'none' → enrollment via click-to-chat
//   3. Body is a STOP keyword (or OptOutType=STOP) → UPDATE channel_enrollments
//   4. START keyword → no-op (re-enrollment must go through admin /start)
//   5. Anything else → log + mark processed

import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { sql } from '../../src/lib/db/server';
import { claimInboundEvent, markInboundEventProcessed, markInboundEventFailed } from './shared';
import { parseTwilioBody, verifyTwilioSignature } from './twilio-verify';
import { fullUrl, redactWhatsAppPayload, parseButtonPayload } from './whatsapp-shared';
import { approveViaCallback, regenerateViaCallback } from '../../src/lib/approval/service';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
  ResponseNotPendingError,
} from '../../src/lib/approval/errors';
import { WhatsAppClient } from '../../src/lib/notifications/channels/whatsapp-client';
import { stripWaPrefix, toWaRecipient } from '../../src/lib/notifications/channels/whatsapp-body';
import { classifyIntent } from './twilio-intent';

const LOG_PREFIX = '[ingress/twilio-whatsapp]';

export async function handleTwilioWhatsAppInbound(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const params = parseTwilioBody(rawBody);
  const sig = request.headers['x-twilio-signature'] as string | undefined;

  if (!verifyTwilioSignature({
    authToken: process.env.TWILIO_AUTH_TOKEN,
    signatureHeader: sig,
    fullUrl: fullUrl(request),
    params,
  })) {
    console.warn(`${LOG_PREFIX} invalid signature on inbound`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  const { MessageSid, From, ButtonPayload, Body } = params;
  if (!MessageSid || !From) {
    reply.status(400).send({ error: 'missing_fields' });
    return;
  }

  const dedupKey = MessageSid;
  const eventType = ButtonPayload ? 'whatsapp_button' : 'whatsapp_inbound';
  const claim = await claimInboundEvent('twilio', dedupKey, eventType, redactWhatsAppPayload(params));
  if (claim === 'duplicate') {
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  const senderHandle = stripWaPrefix(From);
  const client = new WhatsAppClient();

  // Post-claim work runs inside an outer try/catch. The inbound_events row is
  // already in `received` status after claimInboundEvent; if ANY post-claim
  // DB call (approval_links lookup, enrollment lookup, STOP update, enrollment
  // tx) throws before we reach a markProcessed / markFailed, the row would be
  // stuck in `received`. Twilio retries within the 2-minute reclaim window
  // would land as `duplicate` per shared.ts — effectively losing the webhook.
  // The outer catch guarantees the row always terminates in processed or
  // failed, matching the invariants in twilio.ts.
  try {
  // ── Path 1: button tap (Approve / Regenerate) ───────────────────────────
  if (ButtonPayload) {
    const parsed = parseButtonPayload(ButtonPayload);
    if (!parsed) {
      console.warn(`${LOG_PREFIX} malformed ButtonPayload`);
      await markInboundEventProcessed(dedupKey);
      reply.status(200).send({ received: true });
      return;
    }

    // Look up the approval link — must be live (not consumed/revoked/expired).
    const linkRows = await sql<{ id: string; business_id: string }[]>`
      SELECT id, business_id FROM approval_links
      WHERE id = ${parsed.approvalLinkId}
        AND channel = 'whatsapp'
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1
    `;
    const link = linkRows[0];
    if (!link) {
      await client.sendFreeform({
        to: toWaRecipient(senderHandle),
        body: 'This reply was just handled on another channel.',
      }).catch(() => {});
      await markInboundEventProcessed(dedupKey);
      reply.status(200).send({ received: true });
      return;
    }

    // Verify sender is a verified WhatsApp enrollment for this business.
    const enrollmentRows = await sql<{ handle: string }[]>`
      SELECT handle FROM channel_enrollments
      WHERE business_id = ${link.business_id}
        AND channel = 'whatsapp'
        AND status = 'verified'
        AND handle = ${senderHandle}
        AND archived_at IS NULL
      LIMIT 1
    `;
    if (enrollmentRows.length === 0) {
      await client.sendFreeform({
        to: toWaRecipient(senderHandle),
        body: 'This approval is no longer valid.',
      }).catch(() => {});
      await markInboundEventProcessed(dedupKey);
      reply.status(200).send({ received: true });
      return;
    }

    try {
      const fn = parsed.action === 'approve' ? approveViaCallback : regenerateViaCallback;
      await fn({
        approvalLinkId: link.id,
        chatHandle: senderHandle,
        viaChannel: 'whatsapp',
        audit: {
          providerEventId: MessageSid,
          ipAddress: (request as unknown as { ip?: string | null }).ip ?? null,
          twilioMessageSid: MessageSid,
        },
      });
      const body = parsed.action === 'approve'
        ? "✅ Response approved — we'll post it shortly."
        : '🔄 Regenerating — a new draft will follow shortly.';
      await client.sendFreeform({ to: toWaRecipient(senderHandle), body }).catch(() => {});
      await markInboundEventProcessed(dedupKey);
      reply.status(200).send({ received: true });
      return;
    } catch (err) {
      const e = err as Error;
      const isPermanent =
        e instanceof ConsumedLinkError
        || e instanceof RevokedLinkError
        || e instanceof ExpiredLinkError
        || e instanceof ChannelMismatchError
        || e instanceof ResponseNotPendingError;

      if (isPermanent) {
        const body = e instanceof ExpiredLinkError
          ? 'This approval link has expired — a new draft will arrive on the next review.'
          : 'This reply was just handled on another channel.';
        await client.sendFreeform({ to: toWaRecipient(senderHandle), body }).catch(() => {});
        await markInboundEventProcessed(dedupKey);
        reply.status(200).send({ received: true });
        return;
      }

      console.error(`${LOG_PREFIX} unexpected error during button tap: ${e.message}`);
      await client.sendFreeform({
        to: toWaRecipient(senderHandle),
        body: '⚠️ Something went wrong on our end. Please tap the Edit link in the approval message above to finish in browser.',
      }).catch(() => {});
      await markInboundEventFailed(dedupKey, e.message);
      reply.status(503).send({ received: true, retry: true });
      return;
    }
  }

  // ── Intent classification: STOP / START / none ──────────────────────────
  const { intent } = classifyIntent(params);

  if (intent === 'stop') {
    // Single-statement UPDATE — no need for sql.begin. Scope is intentionally
    // handle-wide across all businesses (TCPA opt-out semantics); one inbound
    // STOP unsubscribes the handle everywhere it's verified.
    await sql`
      UPDATE channel_enrollments
      SET status = 'unsubscribed',
          unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
          unsubscribed_reason = COALESCE(unsubscribed_reason, 'whatsapp_stop'),
          updated_at = NOW()
      WHERE handle = ${senderHandle}
        AND channel = 'whatsapp'
        AND archived_at IS NULL
    `;
    await markInboundEventProcessed(dedupKey);
    reply.status(200).send({ received: true });
    return;
  }

  // START is intentionally a no-op — re-enrollment must go through admin /start.
  if (intent === 'start') {
    await markInboundEventProcessed(dedupKey);
    reply.status(200).send({ received: true });
    return;
  }

  // ── Path 2: enrollment via click-to-chat (Body = 'start-<raw_token>') ───
  if (Body && Body.startsWith('start-')) {
    const rawToken = Body.slice(6).trim();
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const result = await sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM channel_enrollments
        WHERE verification_token_hash = ${tokenHash}
          AND channel = 'whatsapp'
          AND status = 'pending_verification'
          AND verification_token_expires_at > NOW()
          AND archived_at IS NULL
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return { matched: false as const };
      await tx`
        UPDATE channel_enrollments
        SET handle = ${senderHandle},
            status = 'verified',
            verified_at = NOW(),
            verification_token_hash = NULL,
            verification_token_expires_at = NULL,
            updated_at = NOW()
        WHERE id = ${row.id}
          AND archived_at IS NULL
      `;
      return { matched: true as const };
    });

    const body = result.matched
      ? "✅ You're connected to RepWorth — we'll ping you here when a review needs approval."
      : 'This link is invalid or expired.';
    // Enrollment-path confirmation is the ONLY signal the user gets that
    // verification succeeded. Log failures so they surface in oncall rather
    // than silently hiding a Twilio outage. The enrollment tx has already
    // committed — we proceed to markProcessed regardless.
    await client.sendFreeform({ to: toWaRecipient(senderHandle), body })
      .catch((err) => console.warn(`${LOG_PREFIX} enrollment confirmation send failed: ${(err as Error).message}`));
    await markInboundEventProcessed(dedupKey);
    reply.status(200).send({ received: true });
    return;
  }

  // ── Unrecognised inbound — log and ignore ────────────────────────────────
  console.log(`${LOG_PREFIX} unrecognised inbound from ${senderHandle} (MessageSid=${MessageSid})`);
  await markInboundEventProcessed(dedupKey);
  reply.status(200).send({ received: true });
  } catch (err) {
    // Post-claim safety net — see the outer try block for rationale.
    // Any DB/network throw in the pre-callback paths (link lookup, enrollment
    // lookup, STOP update, enrollment tx) lands here. Mark failed so the
    // inbound_events reclaim path picks it up on Twilio's retry instead of
    // getting a silent duplicate-200.
    const e = err as Error;
    console.error(`${LOG_PREFIX} unexpected post-claim error: ${e.message}`);
    try {
      await markInboundEventFailed(dedupKey, `post_claim_unexpected:${e.message}`);
    } catch (markErr) {
      console.error(`${LOG_PREFIX} also failed to markFailed: ${(markErr as Error).message}`);
    }
    reply.status(503).send({ received: true, retry: true });
  }
}
