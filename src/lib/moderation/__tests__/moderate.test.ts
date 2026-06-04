import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const moderationsCreate = vi.fn();
vi.mock('openai', () => ({
  default: class {
    moderations = { create: moderationsCreate };
  },
}));

import { moderateResponse } from '../moderate';

describe('moderateResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_MODERATION_ENABLED;
  });
  afterEach(() => {
    delete process.env.OPENAI_MODERATION_ENABLED;
  });

  it('returns the local decision and does not call the provider when disabled', async () => {
    const d = await moderateResponse('We will refund you in full.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.source).toBe('local_regex');
    expect(d.providerStatus).toBeNull();
    expect(moderationsCreate).not.toHaveBeenCalled();
  });

  it('returns a clean local decision for safe text when disabled', async () => {
    const d = await moderateResponse('Thanks so much for visiting!');
    expect(d.flagged).toBe(false);
    expect(d.providerStatus).toBeNull();
    expect(moderationsCreate).not.toHaveBeenCalled();
  });

  it('records provider clean status for an enabled clean local decision', async () => {
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    moderationsCreate.mockResolvedValueOnce({ results: [{ flagged: false, categories: {} }] });
    const d = await moderateResponse('Thanks so much for visiting!');
    expect(d.flagged).toBe(false);
    expect(d.providerStatus).toBe('clean');
  });

  it('calls the provider when enabled and escalates to high on a provider flag', async () => {
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    moderationsCreate.mockResolvedValueOnce({
      results: [{ flagged: true, categories: { harassment: true } }],
    });
    const d = await moderateResponse('Some text the local rules consider clean.');
    expect(moderationsCreate).toHaveBeenCalledOnce();
    // A per-request timeout must be passed so a slow provider fails fast and
    // falls back to local rules instead of stalling generation.
    expect(moderationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'Some text the local rules consider clean.' }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.source).toBe('openai_moderation');
    expect(d.providerStatus).toBeNull();
    expect(d.categories).toHaveProperty('openai_categories');
  });

  it('fails open to the local decision when the provider throws', async () => {
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    moderationsCreate.mockRejectedValueOnce(new Error('provider 500'));
    const d = await moderateResponse('Thanks for the review!');
    expect(d.flagged).toBe(false); // local says clean; provider error must not throw
    expect(d.providerStatus).toBe('error');
  });

  it('keeps a local high flag even when the provider says clean', async () => {
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    moderationsCreate.mockResolvedValueOnce({ results: [{ flagged: false, categories: {} }] });
    const d = await moderateResponse('We will give you a full refund.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.providerStatus).toBe('clean');
  });
});
