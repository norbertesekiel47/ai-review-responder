// src/app/api/admin/channels/telegram/start/route.ts
//
// POST /api/admin/channels/telegram/start — admin generates a one-time Telegram
// verification deep link + QR for owner scan.
//
// Handler order: flag → env → auth → businessId → subscription → advisory lock → state-machine upsert.
//
// State machine (§2.3 of Phase 2 design spec):
//   no row                → INSERT pending_verification, fresh hash + 1h expiry
//   pending_verification  → UPDATE — overwrite hash + expiry, reset updated_at
//   unsubscribed          → UPDATE to pending_verification; clear unsubscribed fields; clear handle; fresh hash + expiry
//   disabled              → same as unsubscribed — reset to pending_verification with fresh token
//   verified              → reject 409 "already_verified" — admin must disable first
//
// The raw token is NEVER persisted. Only the SHA-256 hash is stored.
// The widget must capture and display the QR/link immediately.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
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

  const businessRows = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status FROM businesses WHERE id = ${businessId}
  `;
  const business = businessRows[0];
  if (!business) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (business.subscription_status !== 'active') {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  // Advisory lock + enrollment state machine run in a single transaction so
  // the lock is held across the SELECT + UPDATE/INSERT. pg_advisory_xact_lock
  // releases at tx end; a bare call outside sql.begin would release immediately
  // and leave the state machine unprotected against concurrent starts.
  const lockKey = createHash('sha256')
    .update(`telegram_enroll:${businessId}`)
    .digest()
    .readBigInt64BE(0)
    .toString();
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  const result = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

    const existing = await tx<{ id: string; status: string }[]>`
      SELECT id, status FROM channel_enrollments
      WHERE business_id = ${businessId} AND channel = 'telegram' AND archived_at IS NULL
    `;
    const existingRow = existing[0];

    if (existingRow?.status === 'verified') {
      return { kind: 'already_verified' as const };
    }

    if (existingRow) {
      // Reset any non-verified state to pending_verification with a fresh token.
      // Clears handle (Telegram handle isn't known until owner taps /start),
      // unsubscribed fields, and disabled_at so the enrollment starts clean.
      await tx`
        UPDATE channel_enrollments
        SET status                       = 'pending_verification',
            handle                       = NULL,
            verification_token_hash      = ${tokenHash},
            verification_token_expires_at = ${expiresAt},
            disabled_at                  = NULL,
            unsubscribed_at              = NULL,
            unsubscribed_reason          = NULL,
            updated_at                   = NOW()
        WHERE id = ${existingRow.id}
      `;
    } else {
      await tx`
        INSERT INTO channel_enrollments
          (id, business_id, channel, status, verification_token_hash, verification_token_expires_at)
        VALUES
          (${uuidv7()}, ${businessId}, 'telegram', 'pending_verification', ${tokenHash}, ${expiresAt})
      `;
    }

    return { kind: 'ok' as const };
  });

  // M6: the response body carries the raw verification token via deepLink +
  // qrDataUrl. Set no-store so no intermediate proxy or browser cache retains
  // the secret. The token has a 1h TTL in the DB, but cache layers can be
  // longer-lived.
  const noStore = { 'Cache-Control': 'no-store, private' };

  if (result.kind === 'already_verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409, headers: noStore });
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? 'RepWorthBot';
  const deepLink = `https://t.me/${botUsername}?start=${rawToken}`;
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: noStore },
  );
}
