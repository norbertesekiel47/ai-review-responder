// src/app/api/admin/channels/whatsapp/_shared.ts
//
// Shared helpers for the three admin WhatsApp routes (start, cancel, disable).
// Mirrors the Telegram + SMS patterns at ../telegram/_shared.ts and ../sms/_shared.ts.

import { NextResponse } from 'next/server';

export function isWhatsAppEnabled(): boolean {
  return process.env.CHANNELS_WHATSAPP_ENABLED === 'true';
}

export function flagOff(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

/**
 * Returns a 503 NextResponse if CHANNELS_WHATSAPP_ENABLED=true but required
 * env vars are missing. Returns null if env is ready (route should proceed).
 * Mirrors the worker-side startup assertion pattern.
 *
 * MOCK_EXTERNAL_APIS=true bypasses this check (local dev).
 */
export function assertWhatsAppEnvReady(): NextResponse | null {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return null;
  const required = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_NUMBER',
    'WHATSAPP_APPROVAL_TEMPLATE_SID',
    'WHATSAPP_APPROVAL_URL_BASE',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length === 0) return null;
  console.error(`[whatsapp-admin] CHANNELS_WHATSAPP_ENABLED=true but missing env vars: ${missing.join(', ')}`);
  return NextResponse.json({ ok: false, reason: 'whatsapp_env_not_ready', missing }, { status: 503 });
}
