import { describe, expect, it } from 'vitest';
import { mapSignupError } from '../mapSignupError';

describe('mapSignupError', () => {
  it('prefers the server-provided message when present', () => {
    const result = mapSignupError({ error: 'rate_limited', message: 'Custom message.' }, 429);
    expect(result.message).toBe('Custom message.');
    expect(result.kind).toBe('rate_limited');
  });
  it('falls back to the KNOWN_MESSAGES copy when message is absent', () => {
    const result = mapSignupError({ error: 'rate_limited' }, 429);
    expect(result.message).toMatch(/Too many signup attempts from your network/);
  });
  it('maps account_exists with email-aware copy', () => {
    const result = mapSignupError({ error: 'account_exists' }, 409);
    expect(result.kind).toBe('account_exists');
    expect(result.message).toMatch(/already exists/);
  });
  it('maps unknown error codes to the generic copy', () => {
    const result = mapSignupError({ error: 'mystery' }, 500);
    expect(result.message).toMatch(/Something went wrong/);
    expect(result.kind).toBe('unknown');
  });
  it('handles a body with no error code', () => {
    const result = mapSignupError({}, 500);
    expect(result.message).toMatch(/Signup failed|Something went wrong/);
  });
});
