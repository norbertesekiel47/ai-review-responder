// worker/ingress/twilio/twilio-whatsapp-inbound.ts
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
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql } from '../../../src/lib/db/server';
import { claimInboundEvent, markInboundEventProcessed, markInboundEventFailed } from '../shared';
import { parseTwilioBody, verifyTwilioSignature } from './twilio-verify';
import { fullUrl, redactWhatsAppPayload, parseButtonPayload } from './whatsapp-shared';
import { approveViaCallback, regenerateViaCallback } from '../../../src/lib/approval/service';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
  ResponseNotPendingError,
  ArchivedLocationError,
} from '../../../src/lib/approval/errors';
import { WhatsAppClient } from '../../../src/lib/notifications/channels/whatsapp-client';
import { stripWaPrefix, toWaRecipient } from '../../../src/lib/notifications/channels/whatsapp-body';
import { SubscriptionReadOnlyError } from '../../../src/lib/shared/writable-subscription';
import { classifyIntent } from './twilio-intent';
import { safeInvalidateChannelCache } from '../../../src/lib/notifications/resolve-channels';
import { asAccountId } from '../../../src/lib/shared/ids';
import { parseTwilioWhatsAppInbound } from './parse-inbound';
import { handleConversationalMessage } from '../conversational-seam';

const LOG_PREFIX = '[ingress/twilio-whatsapp]';

type ParsedButtonPayload = NonNullable<ReturnType<typeof parseButtonPayload>>;

interface WhatsAppInboundContext {
  reply: FastifyReply;
  params: Record<string, string>;
  messageSid: string;
  body: string;
  senderHandle: string;
  dedupKey: string;
  client: WhatsAppClient;
  buttonPayload: string | undefined;
  // Caller's IP for the approval audit trail. Resolved once at the boundary so
  // helpers never reach back into the raw Fastify request.
  ipAddress: string | null;
}

export async function handleTwilioWhatsAppInbound(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const params = parseTwilioBody(rawBody);
  const sig = request.headers['x-twilio-signature'] as string | undefined;

  if (!verifyTwilioSignature({
    authToken: getWorkerConfig().TWILIO_AUTH_TOKEN,
    signatureHeader: sig,
    fullUrl: fullUrl(request),
    params,
  })) {
    console.warn(`${LOG_PREFIX} invalid signature on inbound`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  const inbound = parseTwilioWhatsAppInbound(params);
  const messageSid = inbound.messageSid;
  const from = inbound.from;
  const body = inbound.body;
  const buttonPayload = params.ButtonPayload;
  if (!messageSid || !from) {
    reply.status(400).send({ error: 'missing_fields' });
    return;
  }

  const dedupKey = messageSid;
  const eventType = buttonPayload ? 'whatsapp_button' : 'whatsapp_inbound';
  const claim = await claimInboundEvent('twilio', dedupKey, eventType, redactWhatsAppPayload(params));
  if (claim === 'duplicate') {
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  const senderHandle = stripWaPrefix(from);
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
    await processClaimedInbound({
      reply,
      params,
      messageSid,
      body,
      senderHandle,
      dedupKey,
      client,
      buttonPayload,
      ipAddress: (request as unknown as { ip?: string | null }).ip ?? null,
    });
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

async function processClaimedInbound(ctx: WhatsAppInboundContext): Promise<void> {
  if (ctx.buttonPayload) {
    await handleButtonTap(ctx, ctx.buttonPayload);
    return;
  }

  const { intent } = classifyIntent(ctx.params);
  if (intent === 'stop') {
    await handleStopIntent(ctx);
    return;
  }

  // START is intentionally a no-op; re-enrollment must go through admin /start.
  if (intent === 'start') {
    await acknowledgeProcessed(ctx);
    return;
  }

  if (ctx.body.startsWith('start-')) {
    await handleEnrollmentStart(ctx);
    return;
  }

  await handleUnrecognizedInbound(ctx);
}

async function handleButtonTap(
  ctx: WhatsAppInboundContext,
  buttonPayload: string,
): Promise<void> {
  const parsed = parseButtonPayload(buttonPayload);
  if (!parsed) {
    console.warn(`${LOG_PREFIX} malformed ButtonPayload`);
    await acknowledgeProcessed(ctx);
    return;
  }

  const link = await findLiveApprovalLink(parsed.approvalLinkId);
  if (!link) {
    await sendFreeformBestEffort(
      ctx,
      'This reply was just handled on another channel.',
      'handled-elsewhere notice',
    );
    await acknowledgeProcessed(ctx);
    return;
  }

  if (!(await hasVerifiedWhatsAppEnrollment(link.business_id, ctx.senderHandle))) {
    await sendFreeformBestEffort(ctx, 'This approval is no longer valid.', 'enrollment-invalid notice');
    await acknowledgeProcessed(ctx);
    return;
  }

  try {
    // FP: ordering-dependent — the action must succeed before the success message + ack send; failure routes to handleButtonActionError, so these cannot run in parallel.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await runButtonAction(ctx, parsed, link.id);
    await sendFreeformBestEffort(ctx, buttonSuccessMessage(parsed.action), 'button-success confirmation');
    await acknowledgeProcessed(ctx);
  } catch (err) {
    await handleButtonActionError(ctx, err);
  }
}

async function findLiveApprovalLink(
  approvalLinkId: string,
): Promise<{ id: string; business_id: string } | undefined> {
  // Look up the approval link; it must be live (not consumed/revoked/expired).
  const linkRows = await sql<{ id: string; business_id: string }[]>`
    SELECT id, business_id FROM approval_links
    WHERE id = ${approvalLinkId}
      AND channel = 'whatsapp'
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `;
  return linkRows[0];
}

async function hasVerifiedWhatsAppEnrollment(
  businessId: string,
  senderHandle: string,
): Promise<boolean> {
  const enrollmentRows = await sql<{ handle: string }[]>`
    SELECT handle FROM channel_enrollments
    WHERE business_id = ${businessId}
      AND channel = 'whatsapp'
      AND status = 'verified'
      AND handle = ${senderHandle}
      AND archived_at IS NULL
    LIMIT 1
  `;
  return enrollmentRows.length > 0;
}

async function runButtonAction(
  ctx: WhatsAppInboundContext,
  parsed: ParsedButtonPayload,
  approvalLinkId: string,
): Promise<void> {
  const fn = parsed.action === 'approve'
    ? approveViaCallback
    : regenerateViaCallback;

  await fn({
    approvalLinkId,
    chatHandle: ctx.senderHandle,
    viaChannel: 'whatsapp',
    audit: {
      providerEventId: ctx.messageSid,
      ipAddress: ctx.ipAddress,
      twilioMessageSid: ctx.messageSid,
    },
  });
}

function buttonSuccessMessage(action: ParsedButtonPayload['action']): string {
  return action === 'approve'
    ? "✅ Response approved — we'll post it shortly."
    : '🔄 Regenerating — a new draft will follow shortly…';
}

async function handleButtonActionError(
  ctx: WhatsAppInboundContext,
  err: unknown,
): Promise<void> {
  const e = err as Error;
  if (isPermanentButtonError(e)) {
    await sendFreeformBestEffort(ctx, permanentButtonErrorMessage(e), 'permanent-error notice');
    await acknowledgeProcessed(ctx);
    return;
  }

  console.error(`${LOG_PREFIX} unexpected error during button tap: ${e.message}`);
  await sendFreeformBestEffort(
    ctx,
    '⚠️ Something went wrong on our end. Please tap the Edit link in the approval message above to finish in browser.',
    'unexpected-error notice',
  );
  await markInboundEventFailed(ctx.dedupKey, e.message);
  ctx.reply.status(503).send({ received: true, retry: true });
}

function isPermanentButtonError(err: Error): boolean {
  return err instanceof ConsumedLinkError
    || err instanceof RevokedLinkError
    || err instanceof ExpiredLinkError
    || err instanceof ChannelMismatchError
    || err instanceof ResponseNotPendingError
    || err instanceof SubscriptionReadOnlyError;
}

function permanentButtonErrorMessage(err: Error): string {
  if (err instanceof SubscriptionReadOnlyError) {
    if (err.error === 'past_due_read_only') {
      return 'Billing recovery has ended. Update billing in RepWorth before approving replies.';
    }
    if (err.error === 'account_offboarding_blocked' || err.error === 'no_business') {
      return 'This RepWorth account is being offboarded, so this approval can no longer be completed.';
    }
    return 'Billing is not active. Update billing in RepWorth before approving replies.';
  }

  if (err instanceof ExpiredLinkError) {
    return 'This approval link has expired — a new draft will arrive on the next review.';
  }

  if (err instanceof ArchivedLocationError) {
    // Subclass of ResponseNotPendingError — must match before the generic
    // fallthrough, otherwise the owner sees "handled on another channel",
    // which is false here.
    return 'This location has been archived — approval actions are no longer available for this draft.';
  }

  return 'This reply was just handled on another channel.';
}

async function handleStopIntent(ctx: WhatsAppInboundContext): Promise<void> {
  // Single-statement UPDATE; no need for sql.begin. Scope is intentionally
  // handle-wide across all businesses (TCPA opt-out semantics).
  const affectedAccounts = await sql<{ account_id: string }[]>`
    UPDATE channel_enrollments
    SET status = 'unsubscribed',
        unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
        unsubscribed_reason = COALESCE(unsubscribed_reason, 'whatsapp_stop'),
        updated_at = NOW()
    WHERE handle = ${ctx.senderHandle}
      AND channel = 'whatsapp'
      AND archived_at IS NULL
    RETURNING account_id
  `;

  // TCPA-critical: invalidate channel cache immediately so the next
  // notification dispatch does not attempt an opted-out send.
  const uniqueAccountIds = [...new Set(affectedAccounts.map((r) => r.account_id))];
  await Promise.all(
    uniqueAccountIds.map((id) =>
      safeInvalidateChannelCache(asAccountId(id), 'worker.twilio.whatsapp.stop'),
    ),
  );
  await acknowledgeProcessed(ctx);
}

async function handleEnrollmentStart(ctx: WhatsAppInboundContext): Promise<void> {
  const rawToken = ctx.body.slice(6).trim();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const result = await verifyEnrollmentToken(tokenHash, ctx.senderHandle);

  // Invalidate channel cache so the newly verified channel is immediately
  // available for notification dispatch (no 5-minute stale window).
  if (result.accountId) {
    await safeInvalidateChannelCache(
      asAccountId(result.accountId),
      'worker.twilio.whatsapp.verify',
    );
  }

  const responseBody = result.matched
    ? "✅ You're connected to RepWorth — we'll ping you here when a review needs approval."
    : 'This link is invalid or expired.';

  // Enrollment-path confirmation is the only signal the user gets that
  // verification succeeded. Log failures so they surface in oncall; the
  // enrollment tx has already committed, so still mark processed.
  await ctx.client
    .sendFreeform({ to: toWaRecipient(ctx.senderHandle), body: responseBody })
    .catch((err) => {
      console.warn(
        `${LOG_PREFIX} enrollment confirmation send failed: ${(err as Error).message}`,
      );
    });
  await acknowledgeProcessed(ctx);
}

async function verifyEnrollmentToken(
  tokenHash: string,
  senderHandle: string,
): Promise<{ matched: boolean; accountId: string | null }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; account_id: string }[]>`
      SELECT id, account_id FROM channel_enrollments
      WHERE verification_token_hash = ${tokenHash}
        AND channel = 'whatsapp'
        AND status = 'pending_verification'
        AND verification_token_expires_at > NOW()
        AND archived_at IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      return { matched: false, accountId: null };
    }

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
    return { matched: true, accountId: row.account_id as string | null };
  });
}

async function handleUnrecognizedInbound(ctx: WhatsAppInboundContext): Promise<void> {
  // Non-command, non-button free text → future-agent seam (no-op today:
  // auth-gated, no reply). The Body is already redacted in the inbound_events
  // payload by redactWhatsAppPayload.
  await handleConversationalMessage({ channel: 'whatsapp', senderHandle: ctx.senderHandle });
  await acknowledgeProcessed(ctx);
}

async function sendFreeformBestEffort(
  ctx: WhatsAppInboundContext,
  body: string,
  context: string,
): Promise<void> {
  // Best-effort confirmation/notice send. It must never poison the flow that
  // precedes it — by the time a button-success confirmation is sent the
  // approval/regenerate action has already committed — so failures are NOT
  // rethrown. But a failure here (most notably a 63016 freeform-outside-the-
  // 24h-window) must be classified + logged, not silently swallowed
  // (Codex R1 #7). Mirrors the enrollment-confirmation logging in
  // handleEnrollmentStart. The WhatsAppClient already classifies the Twilio
  // code into a typed error whose message carries the classification.
  await ctx.client
    .sendFreeform({ to: toWaRecipient(ctx.senderHandle), body })
    .catch((err) => {
      console.warn(
        `${LOG_PREFIX} best-effort freeform send failed (${context}): ${(err as Error).message}`,
      );
    });
}

async function acknowledgeProcessed(ctx: WhatsAppInboundContext): Promise<void> {
  await markInboundEventProcessed(ctx.dedupKey);
  ctx.reply.status(200).send({ received: true });
}
