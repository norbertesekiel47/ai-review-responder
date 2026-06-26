// src/app/api/admin/channels/whatsapp/_shared.ts
//
// Shared helpers for the three admin WhatsApp routes (start, cancel, disable).
// Mirrors the Telegram pattern at ../telegram/_shared.ts.

import { NextResponse } from 'next/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';

export function isWhatsAppEnabled(): boolean {
  return channelsWhatsappEnabled();
}

export function flagOff(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

const WHATSAPP_REQUIRED_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER',
  'WHATSAPP_APPROVAL_TEMPLATE_SID',
  'WHATSAPP_APPROVAL_URL_BASE',
] as const;

/** Vars from WHATSAPP_REQUIRED_ENV that are unset/blank. */
export function missingWhatsAppEnv(): string[] {
  return WHATSAPP_REQUIRED_ENV.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
}

/**
 * Single source of truth for "is the WhatsApp send/enrollment env ready?".
 * Used by the route guard AND the UI availability checks so the UI never
 * renders a Connect button that the start route would 503.
 * MOCK_EXTERNAL_APIS=true bypasses (local dev).
 */
export function whatsappEnvReady(): boolean {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  return missingWhatsAppEnv().length === 0;
}

/**
 * Returns a 503 NextResponse if CHANNELS_WHATSAPP_ENABLED=true but required
 * env vars are missing. Returns null if env is ready (route should proceed).
 * Mirrors the worker-side startup assertion pattern.
 *
 * MOCK_EXTERNAL_APIS=true bypasses this check (local dev).
 */
export function assertWhatsAppEnvReady(): NextResponse | null {
  if (whatsappEnvReady()) return null;
  const missing = missingWhatsAppEnv();
  reportCaughtError(
    'whatsapp-admin',
    new Error('CHANNELS_WHATSAPP_ENABLED=true but required env vars are missing'),
    { missingEnvVars: missing },
  );
  return NextResponse.json({ ok: false, reason: 'whatsapp_env_not_ready', missing }, { status: 503 });
}
