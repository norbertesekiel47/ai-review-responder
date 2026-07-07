import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getWorkerConfig } from '../../src/lib/config/worker';
import { sql } from '../../src/lib/db/server';
import {
  claimInboundEvent,
  markInboundEventFailed,
  markInboundEventProcessed,
} from './shared';
import { sendInternalEmail } from '../../src/lib/notifications/email';
import { escapeHtml } from '../../src/lib/shared/html';

const LOG_PREFIX = '[ingress/resend]';

interface ResendWebhookBody {
  type: string;
  data: {
    email_id?: string;
    [key: string]: unknown;
  };
}

/**
 * Verify Resend webhook signature (svix-based).
 * Resend uses Svix for webhook delivery. Headers:
 *   svix-id, svix-timestamp, svix-signature
 * Signature = base64(HMAC-SHA256(secret, "${svixId}.${svixTimestamp}.${body}"))
 */
function verifySignature(rawBody: string, headers: Record<string, string | undefined>): boolean {
  const secret = getWorkerConfig().RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Fail open ONLY in mock mode (local dev). In production, reject unsigned payloads.
    if (process.env.MOCK_EXTERNAL_APIS === 'true') {
      console.warn(`${LOG_PREFIX} RESEND_WEBHOOK_SECRET not set, allowing in mock mode`);
      return true;
    }
    console.error(`${LOG_PREFIX} RESEND_WEBHOOK_SECRET not set — rejecting request (fail closed)`);
    return false;
  }

  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return false;
  }

  // Reject stale timestamps to prevent replay attacks after archival
  const timestampSeconds = parseInt(svixTimestamp, 10);
  if (Number.isNaN(timestampSeconds)) {
    return false;
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - timestampSeconds;
  if (ageSeconds > 300 || ageSeconds < -60) {
    console.warn(`${LOG_PREFIX} Stale svix-timestamp: age=${ageSeconds}s — rejecting`);
    return false;
  }

  // Svix secrets are prefixed with "whsec_" and base64-encoded after the prefix
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  // svix-signature can contain multiple signatures separated by spaces (v1,xxx v1,yyy)
  const signatures = svixSignature.split(' ').map((s) => s.split(',')[1] ?? '');
  return signatures.some((sig) => {
    try {
      return timingSafeEqual(Buffer.from(sig, 'base64'), Buffer.from(expected, 'base64'));
    } catch {
      return false;
    }
  });
}

/**
 * Extracts the bounce type string from a Resend email.bounced payload.
 * Supports multiple payload shapes defensively:
 *   - data.bounce.type     (Resend documented shape)
 *   - data.reason          (legacy/alternate)
 *   - data.status          (legacy/alternate)
 * Returns lowercase string, or 'unknown' if nothing matches.
 */
function extractBounceType(data: unknown): string {
  if (!isRecord(data)) return 'unknown';

  const bounceType = isRecord(data.bounce)
    ? lowerNonEmptyString(data.bounce.type)
    : null;

  return bounceType
    ?? lowerNonEmptyString(data.reason)
    ?? lowerNonEmptyString(data.status)
    ?? 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function lowerNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0
    ? value.toLowerCase()
    : null;
}

/**
 * Returns true if the bounce type indicates a hard/permanent failure.
 * 'unknown' is treated as soft to avoid flagging businesses on ambiguity.
 *
 * Matches: permanent, hard, hardbounce, hard_bounce, permanent_failure,
 * or any string containing "permanent" (e.g. smtp_permanent_failure).
 *
 * NOTE: The admin overview SQL in src/app/api/admin/overview/route.ts
 * MUST filter on the normalized prefix 'bounced:hard:' so its red-state
 * metrics match this function's decision. See `classifyBounce()` below.
 */
function isHardBounceType(type: string): boolean {
  const t = type.toLowerCase();
  return (
    t === 'permanent' ||
    t === 'hard' ||
    t === 'hardbounce' ||
    t === 'hard_bounce' ||
    t === 'permanent_failure' ||
    t.includes('permanent')
  );
}

/**
 * Owner-directed notification_deliveries.template values. Only these
 * templates go to the business owner's email — so only hard bounces
 * on these templates should flag `businesses.owner_email_bounced`.
 *
 * Admin/partner templates (admin_exception, partner_engagement_alert, etc.)
 * also have a business_id on the
 * delivery row but their recipient is ADMIN_NOTIFICATION_EMAIL —
 * a bounce there means the ADMIN's email is bad, not the owner's.
 */
const OWNER_DIRECTED_TEMPLATES = new Set([
  'approval_request',
  'weekly_value_report',
  'monthly_impact',
  'owner_nudge',
  'owner_reconnect_required',
  'owner_connection_lost',
  // Auto-approved post FYI (Workstream B) — owner-directed, so a hard bounce
  // flags businesses.owner_email_bounced like any other owner email.
  'auto_post_notice',
  // Guardian escalation notice (WS3) — owner-directed, so a hard bounce flags
  // businesses.owner_email_bounced like any other owner email.
  'escalation_notice',
]);

/**
 * True if the delivery row's template is owner-directed.
 * Covers both exact matches and the onboarding_drip_* family
 * (onboarding_drip_day_1, onboarding_drip_day_7, onboarding_drip_day_30).
 */
function isOwnerDirectedTemplate(template: string | null | undefined): boolean {
  if (!template) return false;
  if (OWNER_DIRECTED_TEMPLATES.has(template)) return true;
  if (template.startsWith('onboarding_drip_')) return true;
  return false;
}

/**
 * Normalizes a raw Resend bounce type into one of two stored kinds:
 *   bounced:hard:<raw>   — flags the business, counts in admin red state
 *   bounced:soft:<raw>   — transient/unknown, logged but no flag
 * Centralizing the classification here guarantees the webhook and the
 * admin red-state query never disagree.
 */
function classifyBounce(rawType: string): { reason: string; isHard: boolean } {
  const isHard = isHardBounceType(rawType);
  const kind = isHard ? 'hard' : 'soft';
  return {
    reason: `bounced:${kind}:${rawType}`,
    isHard,
  };
}

export async function handleResendWebhook(
  request: FastifyRequest<{ Body: ResendWebhookBody }>,
  reply: FastifyReply,
): Promise<void> {
  const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
  const headers = request.headers as Record<string, string | undefined>;

  if (!verifySignature(rawBody, headers)) {
    console.warn(`${LOG_PREFIX} Invalid webhook signature`);
    reply.status(401).send({ error: 'invalid_signature' });
    return;
  }

  const body = request.body;
  const eventType = body.type;
  const emailId = body.data?.email_id;
  const svixId = headers['svix-id'] ?? `resend-${Date.now()}`;

  const claim = await claimInboundEvent('resend', svixId, eventType, body);
  if (claim === 'duplicate') {
    // claimInboundEvent folds two cases into 'duplicate': the row is either
    // settled (processed) or held by another invocation under a fresh lease.
    // Surface the latter as in_flight for observability — both still ack 200.
    const [existing] = await sql<{ status: string }[]>`
      SELECT status FROM inbound_events WHERE external_event_key = ${svixId} LIMIT 1
    `;
    const inFlight = existing !== undefined && existing.status !== 'processed';
    reply
      .status(200)
      .send({ received: true, ...(inFlight ? { in_flight: true } : { duplicate: true }) });
    return;
  }

  // Process the event
  let processingFailed = false;
  try {
    await processResendEvent(eventType, emailId, body);
    await markInboundEventProcessed(svixId);
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to process event ${svixId}: ${err instanceof Error ? err.message : err}`);
    await markInboundEventFailed(svixId, err instanceof Error ? err.message : String(err));
    processingFailed = true;
  }

  if (processingFailed) {
    // Return 5xx so Resend retries delivery. The replay branch above will
    // see status='failed', reclaim the row, and retry processing.
    // Without this, transient DB failures would permanently drop bounce
    // and delivery updates.
    reply.status(503).send({ received: true, retry: true });
    return;
  }

  // Always return 200 on success — Resend expects 2xx
  reply.status(200).send({ received: true });
}

async function processResendEvent(
  eventType: string,
  emailId: string | undefined,
  body: ResendWebhookBody,
): Promise<void> {
  if (!emailId) {
    return;
  }

  switch (eventType) {
    case 'email.delivered':
      await sql`
        UPDATE notification_deliveries SET delivered_at = NOW()
        WHERE external_message_id = ${emailId}
      `;
      break;
    case 'email.complained':
      await sql`
        UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = 'complained'
        WHERE external_message_id = ${emailId}
      `;
      break;
    case 'email.bounced':
      await handleEmailBounced(emailId, body.data);
      break;
  }
}

async function handleEmailBounced(
  emailId: string,
  data: ResendWebhookBody['data'],
): Promise<void> {
  // Defensively extract bounce type from multiple possible payload shapes,
  // then classify into normalized 'bounced:hard:<raw>' or
  // 'bounced:soft:<raw>'. Storing the normalized kind guarantees the admin
  // red-state SQL cannot disagree with the webhook's flagging decision.
  const bounceType = extractBounceType(data);
  const { reason, isHard } = classifyBounce(bounceType);

  // Load business_id AND template from the delivery row so we can decide
  // whether to flag businesses.owner_email_bounced and alert admin.
  const [delivery] = await sql<{ business_id: string; template: string | null }[]>`
    SELECT business_id, template FROM notification_deliveries
    WHERE external_message_id = ${emailId}
    LIMIT 1
  `;

  await sql`
    UPDATE notification_deliveries
    SET failed_at = NOW(), failure_reason = ${reason}
    WHERE external_message_id = ${emailId}
  `;

  if (!isHard || !delivery?.business_id) {
    return;
  }

  if (!isOwnerDirectedTemplate(delivery.template)) {
    // Hard bounce on an admin/partner-directed template. The owner's email is
    // NOT at fault, so do not flag the business owner.
    console.warn(
      `${LOG_PREFIX} Hard bounce on admin/partner template '${delivery.template ?? 'null'}' for business ${delivery.business_id} — NOT flagging owner`,
    );
    return;
  }

  // Transition guard: only mark the row as changed and alert admin when the
  // flag actually flips from FALSE to TRUE. Concurrent bounce webhooks for the
  // same already-flagged business do not spam the admin.
  const transitioned = await sql<{ id: string }[]>`
    UPDATE businesses
    SET owner_email_bounced = TRUE, updated_at = NOW()
    WHERE id = ${delivery.business_id}
      AND owner_email_bounced IS DISTINCT FROM TRUE
    RETURNING id
  `;

  if (transitioned.length > 0) {
    await sendHardBounceAlert(delivery.business_id, delivery.template, bounceType);
  }
}

async function sendHardBounceAlert(
  businessId: string,
  template: string | null,
  bounceType: string,
): Promise<void> {
  const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    return;
  }

  try {
    await sendInternalEmail({
      to: adminEmail,
      subject: 'Hard bounce detected — business flagged',
      bodyHtml: `<p>A hard bounce (type: <code>${escapeHtml(bounceType)}</code>) was reported by Resend for business ID <code>${escapeHtml(businessId)}</code> on template <code>${escapeHtml(template ?? 'unknown')}</code>.</p><p>The business has been flagged (<code>owner_email_bounced=true</code>) and owner-directed emails (approval, weekly, monthly, drips, nudges) will be skipped until an admin verifies/updates the address and clears the flag.</p><p>Partner/admin alerts are unaffected.</p>`,
      category: 'internal',
    });
  } catch (alertErr) {
    console.error(`${LOG_PREFIX} Failed to send admin hard-bounce alert:`, alertErr);
  }
}
