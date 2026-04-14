import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';

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
  const secret = process.env.RESEND_WEBHOOK_SECRET;
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

  // Deduplicate via inbound_events
  const inserted = await sql`
    INSERT INTO inbound_events (id, source, external_event_key, event_type, payload, status)
    VALUES (${uuidv7()}, 'resend', ${svixId}, ${eventType}, ${JSON.stringify(body)}::jsonb, 'received')
    ON CONFLICT (external_event_key) DO NOTHING
  `;

  if (inserted.count === 0) {
    // Already processed — return 200 so Resend doesn't retry
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }

  // Process the event
  try {
    if (emailId) {
      switch (eventType) {
        case 'email.delivered':
          await sql`
            UPDATE notification_deliveries SET delivered_at = NOW()
            WHERE external_message_id = ${emailId}
          `;
          break;

        case 'email.bounced':
        case 'email.complained': {
          const reason = eventType === 'email.bounced' ? 'bounced' : 'complained';
          await sql`
            UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = ${reason}
            WHERE external_message_id = ${emailId}
          `;
          break;
        }
      }
    }

    await sql`
      UPDATE inbound_events SET status = 'processed', processed_at = NOW()
      WHERE external_event_key = ${svixId}
    `;
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to process event ${svixId}: ${err instanceof Error ? err.message : err}`);
    await sql`
      UPDATE inbound_events SET status = 'failed', error_message = ${err instanceof Error ? err.message : String(err)}
      WHERE external_event_key = ${svixId}
    `;
  }

  // Always return 200 — Resend expects 2xx
  reply.status(200).send({ received: true });
}
