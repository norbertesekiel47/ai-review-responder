// src/lib/notifications/email/templates/internal.ts
//
// Generic internal admin email — used for exception alerts, partner
// engagement alerts, and any other operator-facing message. The body is
// rendered by other templates and passed in as `bodyHtml`; this function
// handles only the Resend send + headers.
import { randomUUID } from 'node:crypto';
import { getServerConfig } from '@/lib/config/server';
import { isMockMode } from '@/lib/shared/mock-mode';
import { sendEmail } from '../send-email';
import { getEmailHeaders, getEmailTags, type EmailCategory } from '../headers';
import { LOG_PREFIX } from './shared';

/**
 * Prefix stamped on the synthetic message ID an **Idempotent replay** returns.
 *
 * A replay has no Resend message ID — Resend refused the request rather than
 * accepting a second email — but `recordNotificationDelivery` requires a string,
 * so the delivery row carries `idempotent-replay:<key>` instead. That makes a
 * suppressed duplicate separable in SQL from a genuine send:
 *
 *   SELECT count(*) FROM notification_deliveries
 *   WHERE external_message_id LIKE 'idempotent-replay:%';
 *
 * The literal is an operator-facing wire format, so change it only with that
 * query. Tests assert the literal, not this constant, for the same reason.
 */
export const IDEMPOTENT_REPLAY_PREFIX = 'idempotent-replay:';

/** Result of an internal send: a Resend message ID, or an **Idempotent replay**. */
export interface InternalEmailResult {
  /** Resend's message ID, or `idempotent-replay:<key>` when `idempotentReplay`. */
  messageId: string;
  /**
   * True when Resend refused this request because the same **Send idempotency
   * key** already carried a different body — which proves the FIRST attempt was
   * accepted. The email is delivered; this attempt simply did not send it.
   * Callers must still write every downstream fact (sent markers, delivery rows,
   * outbox completion) exactly as they would after a fresh send.
   */
  idempotentReplay?: boolean;
}

export interface InternalEmailParams {
  to: string;
  subject: string;
  bodyHtml: string;
  /**
   * Deterministic provider idempotency key for retryable transactional sends.
   * Resend applies this key at the API layer to prevent duplicate accepted
   * emails when a worker retries after losing the local DB update.
   */
  idempotencyKey?: string;
  /**
   * Sender address. Defaults to `getServerConfig().RESEND_FROM_EMAIL`. Callers
   * that own a sender-fallback policy (e.g. the public contact/demo/lead routes,
   * which historically default to the company no-reply mailbox) pass it
   * explicitly so a missing env var doesn't silently drop delivery.
   */
  from?: string;
  /**
   * Email category for headers + Resend tags. Defaults to 'internal'
   * (admin-facing, no List-Unsubscribe). Use 'marketing' for owner-
   * directed recurring emails (weekly reports, drips, nudges).
   */
  category?: EmailCategory;
}

export async function sendInternalEmail(
  params: InternalEmailParams,
): Promise<InternalEmailResult> {
  const from = params.from ?? getServerConfig().RESEND_FROM_EMAIL;
  if (!from) throw new Error('RESEND_FROM_EMAIL not configured');

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Internal email to=${params.to} subject="${params.subject}" category=${params.category ?? 'internal'} messageId=${mockId}`);
    return { messageId: mockId };
  }

  const category: EmailCategory = params.category ?? 'internal';
  const headers = getEmailHeaders(category);

  const { data, error } = await sendEmail(
    {
      from,
      to: params.to,
      subject: params.subject,
      html: params.bodyHtml,
      tags: getEmailTags(category),
      // Only pass headers when non-empty — empty object still adds no value
      // but avoids passing an unused property to Resend's JSON body.
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
    { idempotencyKey: params.idempotencyKey },
  );

  if (error) {
    // ── Idempotent replay (#1363) ──────────────────────────────────────
    // Resend answers 409 `invalid_idempotent_request` when the SAME
    // Idempotency-Key arrives with a DIFFERENT body. That can only happen
    // after Resend accepted a first request under this key, so the email IS
    // delivered and this attempt must not be treated as a failure — retrying
    // it would either loop until the outbox row terminalizes, or (once the
    // 24h key window lapses) actually send the duplicate this guards against.
    //
    // It is the NORMAL retry path for the day_7 drip and the owner nudge:
    // `createApprovalLink` mints a fresh token per attempt, so their bodies
    // differ every time.
    //
    // The two neighbouring codes deliberately fall through to the throw:
    //   `concurrent_idempotent_requests` — the first request is still in
    //     flight, which is NOT proof of acceptance. Resend documents it as
    //     retryable, and swallowing it would drop a real email.
    //   `invalid_idempotency_key` — the key WE built is malformed. That is a
    //     programming error, not a delivery outcome.
    // The `idempotencyKey` guard is deliberate too: without a key this code is
    // unreachable, so seeing it means a provider or plumbing fault that a
    // fabricated success would hide.
    if (error.name === 'invalid_idempotent_request' && params.idempotencyKey) {
      console.log(`${LOG_PREFIX} Idempotent replay to=${params.to} key=${params.idempotencyKey}`);
      return {
        messageId: `${IDEMPOTENT_REPLAY_PREFIX}${params.idempotencyKey}`,
        idempotentReplay: true,
      };
    }
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
