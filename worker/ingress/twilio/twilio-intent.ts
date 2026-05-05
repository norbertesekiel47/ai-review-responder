// worker/ingress/twilio/twilio-intent.ts
//
// STOP/START keyword classification extracted from worker/ingress/twilio/twilio.ts so
// both SMS and WhatsApp ingress handlers can share the logic. Pure function,
// no I/O. Keyword sets cover Twilio-native EN + ES per parent spec.
//
// Behavior unchanged — this is a mechanical move. See
// docs/superpowers/specs/2026-04-23-whatsapp-phase-3-design.md §2.1.

/**
 * STOP keyword set: Twilio's built-in keywords plus common English synonyms
 * and Spanish equivalents (Twilio natively handles ES STOP keywords on
 * Messaging Services in ES locale; we mirror them here so the handler works
 * identically if OptOutType is absent, e.g. some regional carrier routes).
 */
export const STOP_KEYWORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT',
  'PARE', 'PARAR', 'PARARLO', 'CANCELAR', 'DESUSCRIBIR', 'DETENER',
]);

export const START_KEYWORDS = new Set(['START', 'UNSTOP', 'YES', 'ARRANCAR']);

export type InboundIntent = 'stop' | 'start' | 'none';
export type IntentSource = 'twilio_optouttype' | 'twilio_inbound_keyword' | '';

export function classifyIntent(
  params: Record<string, string>,
): { intent: InboundIntent; source: IntentSource } {
  const optOutType = params.OptOutType;
  if (optOutType === 'STOP') return { intent: 'stop', source: 'twilio_optouttype' };
  if (optOutType === 'START' || optOutType === 'UNSTOP') {
    return { intent: 'start', source: 'twilio_optouttype' };
  }

  // Strip leading/trailing non-letters to handle punctuation like "STOP!" or
  // "  stop.", then take the first whitespace-delimited token.
  const body = (params.Body ?? '').trim().toUpperCase().replace(/^[^A-Z]+|[^A-Z]+$/g, '');
  const first = body.split(/\s+/)[0] ?? '';
  if (STOP_KEYWORDS.has(first)) return { intent: 'stop', source: 'twilio_inbound_keyword' };
  if (START_KEYWORDS.has(first)) return { intent: 'start', source: 'twilio_inbound_keyword' };
  return { intent: 'none', source: '' };
}
