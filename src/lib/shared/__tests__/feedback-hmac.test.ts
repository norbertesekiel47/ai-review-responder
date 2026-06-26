import { describe, it, expect, beforeEach, vi } from 'vitest';

// feedback-hmac now reads CSRF_SECRET via getServerConfig() (memoized). Set the
// env, reset modules, then dynamically import so the config memo re-parses the
// freshly-set value (Stage-3 convention #6). Every assertion below is unchanged.
async function freshHmac() {
  vi.resetModules();
  return import('../feedback-hmac');
}

describe('feedback-hmac', () => {
  beforeEach(() => {
    process.env.CSRF_SECRET = 'test-secret-32chars-minimum-length';
  });

  const businessId = '01900000-0000-7000-8000-000000000001';
  const rating = 'great';
  const weekStartDate = '2026-04-13';

  describe('signFeedback', () => {
    it('returns consistent hex string for same inputs', async () => {
      const { signFeedback } = await freshHmac();
      const sig1 = signFeedback(businessId, rating, weekStartDate);
      const sig2 = signFeedback(businessId, rating, weekStartDate);
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns different hex for different rating', async () => {
      const { signFeedback } = await freshHmac();
      const sigGreat = signFeedback(businessId, 'great', weekStartDate);
      const sigOk = signFeedback(businessId, 'ok', weekStartDate);
      expect(sigGreat).not.toBe(sigOk);
    });
  });

  describe('verifyFeedback', () => {
    it('returns true for valid sig', async () => {
      const { signFeedback, verifyFeedback } = await freshHmac();
      const sig = signFeedback(businessId, rating, weekStartDate);
      expect(verifyFeedback(businessId, rating, weekStartDate, sig)).toBe(true);
    });

    it('returns false for tampered rating', async () => {
      const { signFeedback, verifyFeedback } = await freshHmac();
      const sig = signFeedback(businessId, rating, weekStartDate);
      expect(verifyFeedback(businessId, 'ok', weekStartDate, sig)).toBe(false);
    });

    it('returns false for tampered business_id', async () => {
      const { signFeedback, verifyFeedback } = await freshHmac();
      const sig = signFeedback(businessId, rating, weekStartDate);
      expect(verifyFeedback('01900000-0000-7000-8000-000000000099', rating, weekStartDate, sig)).toBe(false);
    });

    it('returns false for tampered week', async () => {
      const { signFeedback, verifyFeedback } = await freshHmac();
      const sig = signFeedback(businessId, rating, weekStartDate);
      expect(verifyFeedback(businessId, rating, '2026-04-20', sig)).toBe(false);
    });

    it('returns false for completely wrong sig', async () => {
      const { verifyFeedback } = await freshHmac();
      expect(verifyFeedback(businessId, rating, weekStartDate, 'deadbeef'.repeat(8))).toBe(false);
    });
  });

  describe('buildFeedbackUrl', () => {
    it('produces URL with all params and valid sig that verifyFeedback accepts', async () => {
      const { buildFeedbackUrl, verifyFeedback } = await freshHmac();
      const url = buildFeedbackUrl('https://app.repworth.com', businessId, 'great', weekStartDate);
      const parsed = new URL(url);

      expect(parsed.pathname).toBe('/api/feedback');
      expect(parsed.searchParams.get('business_id')).toBe(businessId);
      expect(parsed.searchParams.get('rating')).toBe('great');
      expect(parsed.searchParams.get('week')).toBe(weekStartDate);

      const sig = parsed.searchParams.get('sig')!;
      expect(sig).toBeTruthy();
      expect(verifyFeedback(businessId, 'great', weekStartDate, sig)).toBe(true);
    });
  });
});
