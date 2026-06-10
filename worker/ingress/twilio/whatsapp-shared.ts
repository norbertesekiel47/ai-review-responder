// worker/ingress/twilio/whatsapp-shared.ts
//
// Provider-specific shared helpers for the Twilio WhatsApp ingress handlers
// (status callbacks + inbound messages). Extracted from twilio-whatsapp.ts so
// the status and inbound handlers can live in their own focused modules
// without duplicating these helpers.

import type { FastifyRequest } from 'fastify';

export function fullUrl(request: FastifyRequest): string {
  return `${process.env.WORKER_PUBLIC_URL}${request.url}`;
}

// Redaction helper used by both status callback and inbound handlers, and
// re-exported through the twilio-whatsapp barrel for unit tests.
export function redactWhatsAppPayload(params: Record<string, string>): Record<string, string> {
  const out = { ...params };
  if ('Body' in out) out.Body = '[redacted]';
  if ('ButtonPayload' in out) out.ButtonPayload = '[redacted]';
  delete out.ProfileName;
  delete out.WaId;
  return out;
}

// Payload grammar (`a:`/`r:` + approval-link UUID) is shared with Telegram
// callback buttons — one parser owns the contract (worker/ingress/shared.ts),
// including the UUID-shape validation that keeps malformed strings off the DB.
export { parseApprovalActionPayload as parseButtonPayload } from '../shared';
