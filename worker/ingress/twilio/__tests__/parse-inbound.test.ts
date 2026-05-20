import { describe, expect, it } from 'vitest';
import { parseTwilioWhatsAppInbound } from '../parse-inbound';

describe('parseTwilioWhatsAppInbound', () => {
  it('parses present Twilio fields', () => {
    expect(
      parseTwilioWhatsAppInbound({
        From: 'whatsapp:+15551234567',
        Body: 'start-token',
        MessageSid: 'SM123',
      }),
    ).toEqual({
      from: 'whatsapp:+15551234567',
      body: 'start-token',
      messageSid: 'SM123',
    });
  });

  it('returns empty strings for missing fields', () => {
    expect(parseTwilioWhatsAppInbound({})).toEqual({
      from: '',
      body: '',
      messageSid: '',
    });
  });
});
