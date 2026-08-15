// src/lib/notifications/channels/telegram-env.ts
//
// Telegram enrollment env-readiness gate. Lives beside flags.ts — the flag it
// pairs with (CHANNELS_TELEGRAM_ENABLED, read via channelsTelegramEnabled) is
// already owned there. It was previously api/admin/channels/telegram/_shared.ts,
// which forced every owner surface — including the settings PAGE — to import
// from an admin route folder.
//
// Server-only: reads process.env and returns a NextResponse. Never imported by
// a client component (invariant #13 — flag state stays server-authoritative).

import { NextResponse } from 'next/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

const TELEGRAM_REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'] as const;

/**
 * Returns a 503 NextResponse if CHANNELS_TELEGRAM_ENABLED=true but the required
 * Telegram env vars are missing. Returns null if env is ready (caller should
 * proceed). Mirrors the worker-side startup assertion pattern.
 *
 * MOCK_EXTERNAL_APIS=true bypasses this check (local dev).
 */
export function assertTelegramEnvReady(): NextResponse | null {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return null;
  const missing = TELEGRAM_REQUIRED_ENV.filter(
    (k) => !process.env[k] || process.env[k]!.trim().length === 0,
  );
  if (missing.length === 0) return null;
  reportCaughtError(
    'telegram-admin',
    new Error('CHANNELS_TELEGRAM_ENABLED=true but required env vars are missing'),
    { missingEnvVars: missing },
  );
  return NextResponse.json({ ok: false, reason: 'telegram_env_not_ready', missing }, { status: 503 });
}
