import { describe, expect, it, vi } from 'vitest';
import { redirectAfterServerSessionCookie } from '../CheckEmailClient';

describe('redirectAfterServerSessionCookie', () => {
  it('uses a full document navigation to the verified onboarding target', () => {
    const assign = vi.fn();

    redirectAfterServerSessionCookie('/onboarding/start', assign);

    expect(assign).toHaveBeenCalledWith('/onboarding/start');
  });

  it('falls back to the paywall for unsafe or missing targets', () => {
    const assign = vi.fn();

    redirectAfterServerSessionCookie('//evil.example', assign);
    redirectAfterServerSessionCookie(undefined, assign);

    expect(assign).toHaveBeenNthCalledWith(1, '/onboarding/pay');
    expect(assign).toHaveBeenNthCalledWith(2, '/onboarding/pay');
  });
});
