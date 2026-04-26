// worker/ingress/twilio-whatsapp.ts
//
// Twilio WhatsApp webhook ingress — sibling file to worker/ingress/twilio.ts.
// Two Fastify handlers registered at different routes:
//
//   POST /ingress/twilio/whatsapp-status  — delivery status callbacks
//   POST /ingress/twilio/whatsapp-inbound — inbound messages (enrollment + button taps + STOP)
//
// Separation from SMS handlers is deliberate — SMS handler logic in
// worker/ingress/twilio.ts is untouched aside from the twilio-intent import.
// SMS route tests remain the regression safety net.

export { redactWhatsAppPayload } from './whatsapp-shared';
export { handleTwilioWhatsAppStatus } from './twilio-whatsapp-status';
export { handleTwilioWhatsAppInbound } from './twilio-whatsapp-inbound';
