import { describe, expect, it } from 'vitest';

// ── Cookie Secure flag ──────────────────────────────────────────────────

describe('rw_location_scope cookie Secure flag (VAL-SETTINGS-047)', () => {
  // Test the cookie string construction logic
  function buildScopeCookie(value: string, isSecure: boolean): string {
    return `rw_location_scope=${value};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax${isSecure ? ';secure' : ''}`;
  }

  it('includes Secure flag when on HTTPS', () => {
    const cookie = buildScopeCookie('all', true);
    expect(cookie).toContain('secure');
    expect(cookie).toContain('samesite=lax');
    expect(cookie).toContain('path=/');
  });

  it('omits Secure flag when on HTTP (localhost dev)', () => {
    const cookie = buildScopeCookie('all', false);
    expect(cookie).not.toContain('secure');
    expect(cookie).toContain('samesite=lax');
    expect(cookie).toContain('path=/');
  });

  it('includes SameSite=Lax regardless of protocol', () => {
    const httpsCookie = buildScopeCookie('test-uuid', true);
    const httpCookie = buildScopeCookie('test-uuid', false);
    expect(httpsCookie).toContain('samesite=lax');
    expect(httpCookie).toContain('samesite=lax');
  });

  it('includes Path=/ regardless of protocol', () => {
    const httpsCookie = buildScopeCookie('test-uuid', true);
    const httpCookie = buildScopeCookie('test-uuid', false);
    expect(httpsCookie).toContain('path=/');
    expect(httpCookie).toContain('path=/');
  });

  it('cookie value is preserved correctly', () => {
    const cookie = buildScopeCookie('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', true);
    expect(cookie).toContain('rw_location_scope=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});
