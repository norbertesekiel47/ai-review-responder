// worker/config/content-type-parsers.ts
//
// Fastify rejects any request whose Content-Type has no registered parser with
// 415 *before* the route handler runs. Fastify ships parsers for
// application/json and text/plain only — so JSON senders (Stripe, Telegram,
// Resend, Zernio) work out of the box, but Twilio webhooks (WhatsApp inbound +
// status callbacks) POST application/x-www-form-urlencoded and were rejected
// with 415 at the content-type gate, never reaching their handlers.
//
// The Twilio handlers read request.rawBody themselves (via fastify-raw-body)
// and parse it with parseTwilioBody, so this parser only has to make Fastify
// ACCEPT the content type. We keep the parsed string as request.body without
// further work; the string content-type match also covers the
// "; charset=UTF-8" parameter Twilio appends.

import type { FastifyInstance } from 'fastify';

export function registerIngressContentTypeParsers(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );
}
