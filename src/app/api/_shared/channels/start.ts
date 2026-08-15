// src/app/api/_shared/channels/start.ts
//
// Shared mobile-channel enrollment-start handler for BOTH portals. All four
// start routes (2 portals × 2 channels) run the identical chain — flag gate →
// env gate → Channel actor resolve → token mint → deep-link build →
// advisory-locked enrollment upsert → cache invalidate → QR response —
// differing only in the resolver they bind (./resolve-actor.ts) and the channel
// they name. The deep link is built before the upsert deliberately; see the
// comment at that line.
//
// Config is deliberately 4 fields. flagOff never varied across the 12 call sites
// (called directly below); cacheLabel and the Sentry endpoint tag are derived
// from surface + channel; the deep link is derived from channel
// (@/lib/notifications/channels/deep-links). If this grows a fifth field, the
// seam is wrong — re-plan rather than widen it.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type postgres from 'postgres';
import { startMobileEnrollment, type MobileChannel } from '@/lib/channels/mobile-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
import { TOKEN_TTL_MS } from '@/lib/notifications/channels/constants';
import { buildMobileDeepLink } from '@/lib/notifications/channels/deep-links';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { errorResponse, jsonResponse } from '@/lib/auth/route-helpers';
import { asAccountId } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { flagOff } from './flag-off';
import type { ChannelActorResolver } from './resolve-actor';

export interface ChannelRouteConfig {
  channel: MobileChannel;
  isEnabled: () => boolean;
  assertEnvReady: () => NextResponse | null;
  resolveActor: ChannelActorResolver;
}

export async function runChannelStart(
  sql: postgres.Sql,
  req: NextRequest,
  config: ChannelRouteConfig,
): Promise<NextResponse> {
  if (!config.isEnabled()) return flagOff();

  const envErr = config.assertEnvReady();
  if (envErr) return envErr;

  const resolved = await config.resolveActor(sql, req);
  if (!resolved.ok) return resolved.response;
  const { businessId, accountId, surface } = resolved.actor;

  // Generate token + hash + expiresAt OUTSIDE the tx so the secret doesn't
  // depend on a possibly-rolled-back transaction.
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  // Built BEFORE the write. The link derives only from channel + rawToken, and
  // the whatsapp builder throws when TWILIO_WHATSAPP_NUMBER is unset — reachable
  // because MOCK_EXTERNAL_APIS=true bypasses the env gate above. Building it
  // after the commit would leave a pending_verification row holding the
  // migration-027 unique slot behind a 500 the owner cannot retry past.
  const deepLink = buildMobileDeepLink(config.channel, rawToken);

  let result: { kind: 'ok' } | { kind: 'already_verified' };
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
      return startMobileEnrollment(tx, config.channel, businessId, accountId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return errorResponse('multiple_mobile_channels', 409);
    }
    if (err instanceof EnrollmentDatabaseError) {
      // Never log rawToken or tokenHash — invariant #5 applied to enrollment tokens.
      reportCaughtError(`${surface}/channels/${config.channel}/start`, err, {
        failure: 'enrollment_db_error',
        channel: config.channel,
        businessId,
        accountId,
      });
      return errorResponse('internal', 500);
    }
    throw err;
  }

  if (result.kind === 'already_verified') {
    return errorResponse('already_verified', 409);
  }

  // Invalidate channel cache — the enrollment state change affects which
  // channels are available for dispatch. Best-effort: a Redis failure should not
  // block the response.
  await safeInvalidateChannelCache(asAccountId(accountId), `${surface}.${config.channel}.start`);

  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return jsonResponse({ deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() });
}
