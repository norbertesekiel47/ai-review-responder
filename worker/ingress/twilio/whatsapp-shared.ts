// worker/ingress/twilio/whatsapp-shared.ts
//
// Provider-specific shared helpers for the Twilio WhatsApp ingress handlers
// (status callbacks + inbound messages). Extracted from twilio-whatsapp.ts so
// the status and inbound handlers can live in their own focused modules
// without duplicating these helpers.

import type { FastifyRequest } from 'fastify';
import { getWorkerPublicUrl } from '@/lib/shared/worker-public-url';

export function fullUrl(request: FastifyRequest): string {
  return `${getWorkerPublicUrl()}${request.url}`;
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

// Delivery-status callbacks carry To/From phone numbers but no message body or
// button payload. On top of the base WhatsApp-param redaction, drop the phone
// numbers — the delivery row is keyed by MessageSid (not phone), so they add
// nothing to the audit copy. Inbound deliberately KEEPS From as a forensic
// field (see redactWhatsAppPayload); this is the status-only delta.
export function redactDeliveryStatusPayload(
  params: Record<string, string>,
): Record<string, string> {
  const out = redactWhatsAppPayload(params);
  delete out.To;
  delete out.From;
  return out;
}

// Payload grammar (`a:`/`r:` + approval-link UUID) is shared with Telegram
// callback buttons — one parser owns the contract (worker/ingress/shared.ts),
// including the UUID-shape validation that keeps malformed strings off the DB.
export { parseApprovalActionPayload as parseButtonPayload } from '../shared';
