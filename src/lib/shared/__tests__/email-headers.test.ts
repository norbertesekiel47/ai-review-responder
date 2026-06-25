import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// getEmailHeaders now reads LIST_UNSUBSCRIBE_*/RESEND_FROM_EMAIL through the
// memoized getServerConfig() accessor (Stage-3 email migration). Each case sets
// the env it needs, then `vi.resetModules()` + a fresh dynamic import re-parses
// the live env (Stage-3 convention #6). Only the env-setup MECHANISM changed —
// every scenario and assertion below is identical to the pre-migration test.
async function freshGetEmailHeaders() {
  vi.resetModules();
  return (await import('@/lib/notifications/email')).getEmailHeaders;
}

describe('getEmailHeaders', () => {
  const originalListUnsub = process.env.LIST_UNSUBSCRIBE_EMAIL;
  const originalListUnsubUrl = process.env.LIST_UNSUBSCRIBE_URL;
  const originalFromEmail = process.env.RESEND_FROM_EMAIL;

  beforeEach(() => {
    delete process.env.LIST_UNSUBSCRIBE_EMAIL;
    delete process.env.LIST_UNSUBSCRIBE_URL;
    process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@repworth.example>';
  });

  afterEach(() => {
    if (originalListUnsub !== undefined) process.env.LIST_UNSUBSCRIBE_EMAIL = originalListUnsub;
    else delete process.env.LIST_UNSUBSCRIBE_EMAIL;
    if (originalListUnsubUrl !== undefined) process.env.LIST_UNSUBSCRIBE_URL = originalListUnsubUrl;
    else delete process.env.LIST_UNSUBSCRIBE_URL;
    if (originalFromEmail !== undefined) process.env.RESEND_FROM_EMAIL = originalFromEmail;
    vi.resetModules();
  });

  it('returns mailto-only List-Unsubscribe for marketing when no URL is configured (no One-Click Post header)', async () => {
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBeDefined();
    expect(headers['List-Unsubscribe']).toMatch(/^<mailto:/);
    // Per RFC 8058, One-Click Post requires an HTTPS URL — emitting the Post
    // header with only a mailto is non-functional and misleading.
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('returns both forms + One-Click Post header when LIST_UNSUBSCRIBE_URL is configured', async () => {
    process.env.LIST_UNSUBSCRIBE_URL = 'https://repworth.example/api/unsubscribe?token=abc';
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/repworth\.example\/api\/unsubscribe\?token=abc>,\s*<mailto:/,
    );
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('rejects non-http(s) LIST_UNSUBSCRIBE_URL and falls back to mailto-only', async () => {
    process.env.LIST_UNSUBSCRIBE_URL = 'javascript:alert(1)';
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toMatch(/^<mailto:/);
    expect(headers['List-Unsubscribe']).not.toContain('javascript');
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('rejects malformed LIST_UNSUBSCRIBE_URL and falls back to mailto-only', async () => {
    process.env.LIST_UNSUBSCRIBE_URL = 'not a url';
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toMatch(/^<mailto:/);
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('rejects http: LIST_UNSUBSCRIBE_URL (RFC 8058 §3 requires HTTPS for one-click) and falls back to mailto-only', async () => {
    process.env.LIST_UNSUBSCRIBE_URL = 'http://repworth.example/api/unsubscribe?token=abc';
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toMatch(/^<mailto:/);
    expect(headers['List-Unsubscribe']).not.toContain('http://');
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('returns empty headers for transactional emails (approval links are not marketing)', async () => {
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('transactional');
    expect(headers).toEqual({});
  });

  it('returns empty headers for internal emails (admin-facing, not customer-directed)', async () => {
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('internal');
    expect(headers).toEqual({});
  });

  it('uses LIST_UNSUBSCRIBE_EMAIL when set', async () => {
    process.env.LIST_UNSUBSCRIBE_EMAIL = 'unsubscribe@repworth.example';
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsubscribe@repworth.example>');
  });

  it('derives unsubscribe mailbox from RESEND_FROM_EMAIL when LIST_UNSUBSCRIBE_EMAIL missing', async () => {
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:notifications@repworth.example>');
  });

  it('derives unsubscribe mailbox from bare RESEND_FROM_EMAIL (no display name)', async () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.example';
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:notifications@repworth.example>');
  });

  it('falls back to generic unsubscribe when neither env var is set', async () => {
    delete process.env.RESEND_FROM_EMAIL;
    const getEmailHeaders = await freshGetEmailHeaders();
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsubscribe@repworth.example.com>');
  });
});

describe('getEmailTags', () => {
  it('returns a single Resend tag with the category name', async () => {
    vi.resetModules();
    const { getEmailTags } = await import('@/lib/notifications/email');
    expect(getEmailTags('transactional')).toEqual([{ name: 'category', value: 'transactional' }]);
    expect(getEmailTags('marketing')).toEqual([{ name: 'category', value: 'marketing' }]);
    expect(getEmailTags('internal')).toEqual([{ name: 'category', value: 'internal' }]);
  });
});
