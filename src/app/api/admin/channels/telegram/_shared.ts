// src/app/api/admin/channels/telegram/_shared.ts
//
// Shared helpers for admin Telegram routes. Mirrors the SMS pattern at
// src/app/api/admin/channels/sms/_shared.ts.

import { NextResponse } from 'next/server';

export function isTelegramEnabled(): boolean {
  return process.env.CHANNELS_TELEGRAM_ENABLED === 'true';
}

export function flagOff(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

/**
 * Returns a 503 NextResponse if CHANNELS_TELEGRAM_ENABLED=true but the required
 * Telegram env vars are missing. Returns null if env is ready (route should
 * proceed). Mirrors the worker-side startup assertion pattern.
 *
 * MOCK_EXTERNAL_APIS=true bypasses this check (local dev).
 */
export function assertTelegramEnvReady(): NextResponse | null {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return null;
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length === 0) return null;
  console.error(`[telegram-admin] CHANNELS_TELEGRAM_ENABLED=true but missing env vars: ${missing.join(', ')}`);
  return NextResponse.json({ ok: false, reason: 'telegram_env_not_ready', missing }, { status: 503 });
}
