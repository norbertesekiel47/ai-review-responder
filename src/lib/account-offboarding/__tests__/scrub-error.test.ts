import { describe, expect, it } from 'vitest';

import { scrubOffboardingErrorForStorage } from '../scrub-error';

describe('scrubOffboardingErrorForStorage', () => {
  it('redacts the full secret key-value set (kv form)', () => {
    const out = scrubOffboardingErrorForStorage(
      'access_token=tok1 refresh_token=tok2 client_secret=sec3 api_key=key4 token=tok5 password=hunter2 authorization=zzz',
    );
    expect(out).toBe(
      'access_token=[REDACTED] refresh_token=[REDACTED] client_secret=[REDACTED] api_key=[REDACTED] token=[REDACTED] password=[REDACTED] authorization=[REDACTED]',
    );
  });

  it('redacts secrets in JSON (double- and single-quoted)', () => {
    expect(scrubOffboardingErrorForStorage('{"token":"abc","password":"p"}')).toBe(
      '{"token":"[REDACTED]","password":"[REDACTED]"}',
    );
    expect(scrubOffboardingErrorForStorage("{'secret':'shh'}")).toBe("{'secret':'[REDACTED]'}");
  });

  it('redacts Bearer and Basic auth headers', () => {
    expect(scrubOffboardingErrorForStorage('Authorization: Bearer abc.def.ghi')).toContain(
      'Bearer [REDACTED]',
    );
    expect(scrubOffboardingErrorForStorage('Authorization: Basic dXNlcjpwYXNz')).toContain(
      'Basic [REDACTED]',
    );
  });

  it('redacts email and phone PII (union superset behavior)', () => {
    const out = scrubOffboardingErrorForStorage('contact user@example.com or +1 415 555 0132');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).not.toContain('user@example.com');
  });

  it('never leaks the raw secret value', () => {
    const out = scrubOffboardingErrorForStorage('Stripe auth failed token=sk_live_secret');
    expect(out).not.toContain('sk_live_secret');
    expect(out).toContain('token=[REDACTED]');
  });

  it('caps stored length at 500 chars', () => {
    expect(scrubOffboardingErrorForStorage('x'.repeat(1000))).toHaveLength(500);
  });
});
