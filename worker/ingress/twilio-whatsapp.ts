// worker/ingress/twilio-whatsapp.ts
//
// Twilio WhatsApp webhook ingress — sibling file to worker/ingress/twilio.ts.
// Two Fastify handlers registered at different routes:
//
//   POST /ingress/twilio/whatsapp-status  — delivery status callbacks
//   POST /ingress/twilio/whatsapp-inbound — inbound messages (enrollment + button taps + STOP)
//                                           (added in Task 10)
//
// Separation from SMS handlers is deliberate — SMS handler logic in
// worker/ingress/twilio.ts is untouched aside from the twilio-intent import.
// SMS route tests remain the regression safety net.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { sql } from '../../src/lib/db/server';
import { claimInboundEvent } from './shared';
import { parseTwilioBody, verifyTwilioSignature } from './twilio-verify';

const LOG_PREFIX = '[ingress/twilio-whatsapp]';

function fullUrl(request: FastifyRequest): string {
  return `${process.env.WORKER_PUBLIC_URL}${request.url}`;
}

// Redaction helper (also used by the inbound handler in Task 10). Exported
// for unit tests.
export function redactWhatsAppPayload(params: Record<string, string>): Record<string, string> {
  const out = { ...params };
  if ('Body' in out) out.Body = '[redacted]';
  if ('ButtonPayload' in out) out.ButtonPayload = '[redacted]';
  delete out.ProfileName;
  delete out.WaId;
  return out;
}

/**
 * Status callback for WhatsApp template sends. Mirrors the SMS pattern at
 * worker/ingress/twilio.ts (handleTwilioStatusCallback) — signature verify,
 * dedup on `${MessageSid}:${MessageStatus}`, first-wins race guard on terminal
 * state, reclaim if delivery row hasn't been inserted yet. Only delta from
 * SMS handler: the notification_deliveries channel predicate is 'whatsapp'.
 */
export async function handleTwilioWhatsAppStatus(
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
    console.warn(`${LOG_PREFIX} invalid signature on status callback`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  const { MessageSid, MessageStatus, ErrorCode } = params;
  if (!MessageSid || !MessageStatus) {
    reply.status(400).send({ error: 'missing_fields' });
    return;
  }

  const dedupKey = `${MessageSid}:${MessageStatus}`;
  const claim = await claimInboundEvent('twilio', dedupKey, `status:${MessageStatus}`, params);
  if (claim === 'duplicate') {
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  const isTerminal =
    MessageStatus === 'delivered' || MessageStatus === 'undelivered' || MessageStatus === 'failed';
  if (!isTerminal) {
    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(200).send({ received: true });
    return;
  }

  const [row] = await sql<{ id: string; delivered_at: Date | null; failed_at: Date | null }[]>`
    SELECT id, delivered_at, failed_at FROM notification_deliveries
    WHERE external_message_id = ${MessageSid} AND channel = 'whatsapp'
    LIMIT 1
  `;
  if (!row) {
    await sql`
      UPDATE inbound_events SET status = 'failed', error_message = 'delivery_row_not_yet_present'
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(503).send({ received: true, retry: 'delivery_row_not_yet_present' });
    return;
  }
  if (row.delivered_at || row.failed_at) {
    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${dedupKey}
    `;
    reply.status(200).send({ received: true, terminal_state_preserved: true });
    return;
  }

  if (MessageStatus === 'delivered') {
    await sql`
      UPDATE notification_deliveries SET delivered_at = NOW()
      WHERE id = ${row.id} AND channel = 'whatsapp' AND delivered_at IS NULL AND failed_at IS NULL
    `;
  } else {
    await sql`
      UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = ${`twilio:${ErrorCode ?? 'unknown'}`}
      WHERE id = ${row.id} AND channel = 'whatsapp' AND delivered_at IS NULL AND failed_at IS NULL
    `;
  }
  await sql`
    UPDATE inbound_events SET status = 'processed', processed_at = NOW()
    WHERE external_event_key = ${dedupKey}
  `;
  reply.status(200).send({ received: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound handler — three flows distinguished by payload shape:
//   1. ButtonPayload present → approval/regenerate button tap
//   2. Body starts with 'start-' AND intent is 'none' → enrollment via click-to-chat
//   3. Body is a STOP keyword (or OptOutType=STOP) → UPDATE channel_enrollments
//   4. START keyword → no-op (re-enrollment via admin /start)
//   5. Anything else → log + mark processed
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
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

// UUID v7 rendered with `v7()` from the `uuid` package produces the canonical
// 8-4-4-4-12 hex form. Validate the suffix shape before hitting the DB — the
// approval_links.id column is UUID, and a malformed string would raise a
// Postgres "invalid input syntax for type uuid" error that escapes the
// post-claim happy path. Malformed payloads route to the same processed/200
// path as an unrecognised `a:`/`r:` prefix.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseButtonPayload(
  data: string,
): { action: 'approve' | 'regenerate'; approvalLinkId: string } | null {
  let action: 'approve' | 'regenerate' | null = null;
  let rest = '';
  if (data.startsWith('a:')) { action = 'approve'; rest = data.slice(2); }
  else if (data.startsWith('r:')) { action = 'regenerate'; rest = data.slice(2); }
  if (action === null) return null;
  if (!UUID_RE.test(rest)) return null;
  return { action, approvalLinkId: rest };
}

async function markProcessed(dedupKey: string): Promise<void> {
  await sql`
    UPDATE inbound_events SET status = 'processed', processed_at = NOW()
    WHERE external_event_key = ${dedupKey}
  `;
}

async function markFailed(dedupKey: string, reason: string): Promise<void> {
  await sql`
    UPDATE inbound_events SET status = 'failed', error_message = ${reason}
    WHERE external_event_key = ${dedupKey}
  `;
}

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
      await markProcessed(dedupKey);
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
      await markProcessed(dedupKey);
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
      await markProcessed(dedupKey);
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
      await markProcessed(dedupKey);
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
        await markProcessed(dedupKey);
        reply.status(200).send({ received: true });
        return;
      }

      console.error(`${LOG_PREFIX} unexpected error during button tap: ${e.message}`);
      await client.sendFreeform({
        to: toWaRecipient(senderHandle),
        body: '⚠️ Something went wrong on our end. Please tap the Edit link in the approval message above to finish in browser.',
      }).catch(() => {});
      await markFailed(dedupKey, e.message);
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
    await markProcessed(dedupKey);
    reply.status(200).send({ received: true });
    return;
  }

  // START is intentionally a no-op — re-enrollment must go through admin /start.
  if (intent === 'start') {
    await markProcessed(dedupKey);
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
    await markProcessed(dedupKey);
    reply.status(200).send({ received: true });
    return;
  }

  // ── Unrecognised inbound — log and ignore ────────────────────────────────
  console.log(`${LOG_PREFIX} unrecognised inbound from ${senderHandle} (MessageSid=${MessageSid})`);
  await markProcessed(dedupKey);
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
      await markFailed(dedupKey, `post_claim_unexpected:${e.message}`);
    } catch (markErr) {
      console.error(`${LOG_PREFIX} also failed to markFailed: ${(markErr as Error).message}`);
    }
    reply.status(503).send({ received: true, retry: true });
  }
}
