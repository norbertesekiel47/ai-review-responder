import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEmailHeaders, getEmailTags } from '../../notifications/email';

describe('getEmailHeaders', () => {
  const originalListUnsub = process.env.LIST_UNSUBSCRIBE_EMAIL;
  const originalFromEmail = process.env.RESEND_FROM_EMAIL;

  beforeEach(() => {
    delete process.env.LIST_UNSUBSCRIBE_EMAIL;
    process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@repworth.example>';
  });

  afterEach(() => {
    if (originalListUnsub !== undefined) process.env.LIST_UNSUBSCRIBE_EMAIL = originalListUnsub;
    if (originalFromEmail !== undefined) process.env.RESEND_FROM_EMAIL = originalFromEmail;
  });

  it('returns List-Unsubscribe headers for marketing emails', () => {
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBeDefined();
    expect(headers['List-Unsubscribe']).toMatch(/^<mailto:/);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('returns empty headers for transactional emails (approval links are not marketing)', () => {
    const headers = getEmailHeaders('transactional');
    expect(headers).toEqual({});
  });

  it('returns empty headers for internal emails (admin-facing, not customer-directed)', () => {
    const headers = getEmailHeaders('internal');
    expect(headers).toEqual({});
  });

  it('uses LIST_UNSUBSCRIBE_EMAIL when set', () => {
    process.env.LIST_UNSUBSCRIBE_EMAIL = 'unsubscribe@repworth.example';
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsubscribe@repworth.example>');
  });

  it('derives unsubscribe mailbox from RESEND_FROM_EMAIL when LIST_UNSUBSCRIBE_EMAIL missing', () => {
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:notifications@repworth.example>');
  });

  it('derives unsubscribe mailbox from bare RESEND_FROM_EMAIL (no display name)', () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.example';
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:notifications@repworth.example>');
  });

  it('falls back to generic unsubscribe when neither env var is set', () => {
    delete process.env.RESEND_FROM_EMAIL;
    const headers = getEmailHeaders('marketing');
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsubscribe@repworth.example.com>');
  });
});

describe('getEmailTags', () => {
  it('returns a single Resend tag with the category name', () => {
    expect(getEmailTags('transactional')).toEqual([{ name: 'category', value: 'transactional' }]);
    expect(getEmailTags('marketing')).toEqual([{ name: 'category', value: 'marketing' }]);
    expect(getEmailTags('internal')).toEqual([{ name: 'category', value: 'internal' }]);
  });
});
