import { describe, it, expect } from 'vitest';
import { maskChannelHandle } from '../mask-handle';

describe('maskChannelHandle', () => {
  describe('email — passthrough', () => {
    it('returns the email address unchanged', () => {
      expect(maskChannelHandle('email', 'owner@example.com')).toBe('owner@example.com');
    });

    it('returns a short email unchanged', () => {
      expect(maskChannelHandle('email', 'a@b.c')).toBe('a@b.c');
    });
  });

  describe('whatsapp — phone masking', () => {
    it('masks a standard E.164 number', () => {
      // +15551234567 → +15•••••4567
      expect(maskChannelHandle('whatsapp', '+15551234567')).toBe('+15•••••4567');
    });

    it('clamps to zero-width mask for handles of exactly 7 chars', () => {
      // 7 chars: hidden = max(0, 7-7) = 0 → first 3 + no dots + last 4
      // "1234567".slice(0,3) = "123", "1234567".slice(-4) = "4567"
      expect(maskChannelHandle('whatsapp', '1234567')).toBe('123' + '4567');
    });

    it('clamps to zero-width mask for handles shorter than 7 but longer than 4', () => {
      // 5 chars: hidden = max(0, 5-7) = 0 → no dots
      expect(() => maskChannelHandle('whatsapp', '12345')).not.toThrow();
      expect(maskChannelHandle('whatsapp', '12345')).toBe('123' + '2345');
    });

    it('returns handle unchanged when length <= 4', () => {
      expect(maskChannelHandle('whatsapp', '+123')).toBe('+123');
      expect(maskChannelHandle('whatsapp', '1234')).toBe('1234');
    });
  });

  describe('telegram — last-4 masking', () => {
    it('masks a numeric chat_id to last 4 digits', () => {
      expect(maskChannelHandle('telegram', '123456789')).toBe('••• 6789');
    });

    it('returns handle unchanged when length <= 4', () => {
      expect(maskChannelHandle('telegram', '1234')).toBe('1234');
    });
  });

  describe('unknown/stale channel — masked like phone, not returned raw', () => {
    it('masks a stale sms handle like whatsapp (phone masking)', () => {
      expect(maskChannelHandle('sms', '+15551234567')).toBe('+15•••••4567');
    });

    it('does not return a stale channel handle raw', () => {
      const result = maskChannelHandle('sms', '+15551234567');
      expect(result).not.toBe('+15551234567');
    });

    it('returns short stale handles unchanged (clamp applies)', () => {
      expect(maskChannelHandle('sms', '+123')).toBe('+123');
    });
  });
});
