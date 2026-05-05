// Shared utility for Twilio webhook handlers. Parses the form-urlencoded
// body and validates the X-Twilio-Signature header using Twilio's official
// validator. No DB, no external calls.

import twilio from 'twilio';

const LOG_PREFIX = '[ingress/twilio]';

export function parseTwilioBody(rawBody: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(rawBody).entries());
}

export interface VerifyParams {
  authToken: string | undefined;
  signatureHeader: string | undefined;
  fullUrl: string;
  params: Record<string, string>;
}

/**
 * Validates an X-Twilio-Signature header against the expected HMAC-SHA1
 * signature. Returns true iff valid.
 *
 * In MOCK_EXTERNAL_APIS=true, returns true when authToken is missing
 * (local dev without a real Twilio account). In all other cases a missing
 * authToken or signature fails closed.
 */
export function verifyTwilioSignature(v: VerifyParams): boolean {
  if (!v.authToken) {
    if (process.env.MOCK_EXTERNAL_APIS === 'true') {
      console.warn(`${LOG_PREFIX} TWILIO_AUTH_TOKEN not set, allowing in mock mode`);
      return true;
    }
    console.error(`${LOG_PREFIX} TWILIO_AUTH_TOKEN not set — rejecting`);
    return false;
  }
  if (!v.signatureHeader) return false;
  return twilio.validateRequest(v.authToken, v.signatureHeader, v.fullUrl, v.params);
}
