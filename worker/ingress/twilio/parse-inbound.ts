export interface TwilioWhatsAppInboundEvent {
  from: string;
  body: string;
  messageSid: string;
}

export function parseTwilioWhatsAppInbound(
  input: Record<string, unknown>,
): TwilioWhatsAppInboundEvent {
  const from = typeof input.From === 'string' ? input.From : '';
  const body = typeof input.Body === 'string' ? input.Body : '';
  const messageSid = typeof input.MessageSid === 'string' ? input.MessageSid : '';

  return { from, body, messageSid };
}
