import { describe, it, expect } from 'vitest';
import { websiteUrlSchema } from '../schemas';

describe('websiteUrlSchema', () => {
  it('accepts https:// URLs', () => {
    expect(websiteUrlSchema.safeParse('https://example.com').success).toBe(true);
    expect(websiteUrlSchema.safeParse('https://example.com/path?q=1').success).toBe(true);
  });

  it('accepts http:// URLs', () => {
    // Legacy small-business sites sometimes still use HTTP.
    expect(websiteUrlSchema.safeParse('http://example.com').success).toBe(true);
  });

  it('rejects javascript: URLs (XSS vector)', () => {
    const result = websiteUrlSchema.safeParse('javascript:alert(1)');
    expect(result.success).toBe(false);
  });

  it('rejects data: URLs (XSS vector)', () => {
    const result = websiteUrlSchema.safeParse('data:text/html,<script>alert(1)</script>');
    expect(result.success).toBe(false);
  });

  it('rejects ftp:// URLs', () => {
    const result = websiteUrlSchema.safeParse('ftp://example.com');
    expect(result.success).toBe(false);
  });

  it('rejects mailto: URLs', () => {
    const result = websiteUrlSchema.safeParse('mailto:owner@example.com');
    expect(result.success).toBe(false);
  });

  it('rejects file:// URLs', () => {
    const result = websiteUrlSchema.safeParse('file:///etc/passwd');
    expect(result.success).toBe(false);
  });

  it('rejects plain strings that are not URLs', () => {
    expect(websiteUrlSchema.safeParse('not a url').success).toBe(false);
    expect(websiteUrlSchema.safeParse('example.com').success).toBe(false); // no scheme
  });

  it('rejects strings longer than 500 chars', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(500);
    const result = websiteUrlSchema.safeParse(longUrl);
    expect(result.success).toBe(false);
  });

  it('rejects empty string', () => {
    const result = websiteUrlSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('accepts unusual but legal http(s) URLs', () => {
    expect(websiteUrlSchema.safeParse('https://sub.example.co.uk:8080/path').success).toBe(true);
  });
});
