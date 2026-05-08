// src/app/api/admin/channels/whatsapp/start/route.ts
//
// POST /api/admin/channels/whatsapp/start — admin generates a one-time WhatsApp
// verification deep link + QR for owner scan via wa.me click-to-chat.
//
// Handler order: flag → env → auth → businessId → subscription → advisory lock → state-machine upsert.
//
// State machine (§2.4 of Phase 3 design spec):
//   no row                → INSERT pending_verification, fresh hash + 1h expiry
//   pending_verification  → UPDATE — overwrite hash + expiry, reset updated_at
//   unsubscribed          → UPDATE to pending_verification; clear unsubscribed fields; clear handle; fresh hash + expiry
//   disabled              → same as unsubscribed — reset to pending_verification with fresh token
//   verified              → reject 409 "already_verified" — admin must disable first
//
// Subscription gate: strict 'active' status. Inherited from Phase 2 Telegram.
// Dispatcher honors past_due grace at send time; admin enrollment mutations
// during grace require explicit active status.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { classifyEnrollmentError, MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  try {
    await requireRole(req, 'admin', 'sales_partner');
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  // After migration 034, subscription_status source of truth is accounts.
  const [accountRow] = await sql<{ id: string; subscription_status: string }[]>`
    SELECT a.id, a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${businessId}
  `;
  if (!accountRow) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (accountRow.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }
  const accountId = accountRow.id;

  // Advisory lock + enrollment state machine run in a single transaction so
  // the lock is held across the SELECT + UPDATE/INSERT. pg_advisory_xact_lock
  // releases at tx end; a bare call outside sql.begin would release immediately
  // and leave the state machine unprotected against concurrent starts.
  // Uses the shared mobile_enroll key so SMS verify + WhatsApp start are
  // mutually exclusive per business (same lock as SMS withMobileEnrollmentLock
  // and Telegram start routes).
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  let result: { kind: 'ok' } | { kind: 'already_verified' } | undefined;
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${businessId}`}, 0))`;

      const existing = await tx<{ id: string; status: string }[]>`
        SELECT id, status FROM channel_enrollments
        WHERE business_id = ${businessId} AND channel = 'whatsapp' AND archived_at IS NULL
        FOR UPDATE
      `;
      const existingRow = existing[0];

      if (existingRow?.status === 'verified') {
        return { kind: 'already_verified' as const };
      }

      try {
        if (existingRow) {
          await tx`
            UPDATE channel_enrollments
            SET status                        = 'pending_verification',
                handle                        = NULL,
                verification_token_hash       = ${tokenHash},
                verification_token_expires_at = ${expiresAt},
                disabled_at                   = NULL,
                unsubscribed_at               = NULL,
                unsubscribed_reason           = NULL,
                updated_at                    = NOW()
            WHERE id = ${existingRow.id}
          `;
        } else {
          await tx`
            INSERT INTO channel_enrollments
              (id, account_id, business_id, channel, status, verification_token_hash, verification_token_expires_at)
            VALUES
              (${uuidv7()}, ${accountId}, ${businessId}, 'whatsapp', 'pending_verification', ${tokenHash}, ${expiresAt})
          `;
        }
      } catch (err) {
        classifyEnrollmentError(err); // always throws
      }

      return { kind: 'ok' as const };
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: { 'Cache-Control': 'no-store, private' } });
    }
    if (err instanceof EnrollmentDatabaseError) {
      console.error('[whatsapp/start] enrollment db error', err);
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: { 'Cache-Control': 'no-store, private' } });
    }
    throw err;
  }

  // The response body carries the raw verification token via deepLink + qrDataUrl.
  // Set no-store so no intermediate proxy or browser cache retains the secret.
  // The token has a 1h TTL in the DB, but cache layers can be longer-lived.
  const noStore = { 'Cache-Control': 'no-store, private' };

  if (result?.kind === 'already_verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409, headers: noStore });
  }

  // wa.me requires digits only (no +, no whatsapp:) per https://faq.whatsapp.com/5246659compatibly
  const digits = process.env.TWILIO_WHATSAPP_NUMBER!.replace(/^whatsapp:\+?/, '');
  const prefilled = encodeURIComponent(`start-${rawToken}`);
  const deepLink = `https://wa.me/${digits}?text=${prefilled}`;
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: noStore },
  );
}
