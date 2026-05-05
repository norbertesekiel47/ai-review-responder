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

// UUID v7 rendered with `v7()` from the `uuid` package produces the canonical
// 8-4-4-4-12 hex form. Validate the suffix shape before hitting the DB — the
// approval_links.id column is UUID, and a malformed string would raise a
// Postgres "invalid input syntax for type uuid" error that escapes the
// post-claim happy path. Malformed payloads route to the same processed/200
// path as an unrecognised `a:`/`r:` prefix.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseButtonPayload(
  data: string,
): { action: 'approve' | 'regenerate'; approvalLinkId: string } | null {
  let action: 'approve' | 'regenerate' | null = null;
  let rest = '';
  if (data.startsWith('a:')) { action = 'approve'; rest = data.slice(2); }
  else if (data.startsWith('r:')) { action = 'regenerate'; rest = data.slice(2); }
  if (action === null) return null;
  if (!UUID_RE.test(rest)) return null;
  return { action, approvalLinkId: rest };
}
