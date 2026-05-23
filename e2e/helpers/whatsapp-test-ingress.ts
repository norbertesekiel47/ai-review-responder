// e2e/helpers/whatsapp-test-ingress.ts
//
// Synthesizes a Twilio WhatsApp inbound `start-<token>` webhook and POSTs it to
// the worker's ingress endpoint. Used by owner-channels.spec.ts to simulate the
// "owner scans the QR / taps the wa.me link" step that flips a
// pending_verification channel_enrollments row to verified.
//
// Mirrors e2e/helpers/telegram-test-ingress.ts. Where Telegram authenticates the
// webhook with the X-Telegram-Bot-Api-Secret-Token header, Twilio uses an
// X-Twilio-Signature HMAC. In the E2E harness the worker is expected to run with
// MOCK_EXTERNAL_APIS=true and no TWILIO_AUTH_TOKEN, so verifyTwilioSignature
// returns true and the placeholder signature below is accepted. If a real
// TWILIO_AUTH_TOKEN is configured in the test env, supply a precomputed
// signature via opts.signature.
//
// The body is form-urlencoded (Twilio's content type), not JSON. MessageSid is
// the dedup key the worker keys inbound_events on, so each call defaults to a
// unique monotonic SID to avoid colliding with prior CI runs.

interface SimulateOptions {
  rawToken: string;
  /** Sender phone in E.164, no `whatsapp:` prefix. Defaults to a test number. */
  fromPhone?: string;
  workerBaseUrl?: string;
  messageSid?: string;
  /** Precomputed X-Twilio-Signature; only needed when TWILIO_AUTH_TOKEN is set. */
  signature?: string;
}

let counter = 0;
function nextSid(): string {
  counter = (counter + 1) % 1_000_000;
  return `SM_e2e_${Date.now()}_${counter}`;
}

export async function simulateWhatsAppStart(opts: SimulateOptions): Promise<Response> {
  const workerBase = opts.workerBaseUrl ?? process.env.WORKER_PUBLIC_URL;
  if (!workerBase) throw new Error('WORKER_PUBLIC_URL required for whatsapp test ingress');

  const fromPhone = opts.fromPhone ?? '+15555550123';
  const messageSid = opts.messageSid ?? nextSid();

  const params = new URLSearchParams({
    MessageSid: messageSid,
    From: `whatsapp:${fromPhone}`,
    To: process.env.TWILIO_WHATSAPP_NUMBER ?? 'whatsapp:+15551230000',
    Body: `start-${opts.rawToken}`,
  });

  // Bound the request so a hung/unreachable worker can't stall the test run.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(`${workerBase.replace(/\/$/, '')}/ingress/twilio/whatsapp-inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': opts.signature ?? 'e2e-placeholder-signature',
      },
      body: params.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
