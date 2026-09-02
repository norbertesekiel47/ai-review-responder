import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNotFound, mockFlag } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockFlag: vi.fn(() => false),
}));

vi.mock('next/navigation', () => ({ notFound: mockNotFound }));
vi.mock('@/lib/auth/flags', () => ({ selfServeSignupEnabled: mockFlag }));
vi.mock('@/components/auth/CheckEmailClient', () => ({
  CheckEmailClient: () => null,
}));

const { default: CheckEmailPage } = await import('../page');
const { CheckEmailClient } = await import('@/components/auth/CheckEmailClient');

// A1: /login sends an invited owner with an unconfirmed email here
// (`useLoginSubmit` → `/signup/check-email?from=login`). Under the beta posture
// SELF_SERVE_SIGNUP_ENABLED is off, so the page must render regardless — like
// /login and /forgot-password, and unlike /signup, which mints accounts.
describe('CheckEmailPage (A1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with self-serve signup OFF instead of 404ing', () => {
    mockFlag.mockReturnValue(false);
    const element = CheckEmailPage();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(element.type).toBe(CheckEmailClient);
  });

  it('renders with self-serve signup ON', () => {
    mockFlag.mockReturnValue(true);
    const element = CheckEmailPage();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(element.type).toBe(CheckEmailClient);
  });

  it('does not consult the signup flag at all', () => {
    CheckEmailPage();
    expect(mockFlag).not.toHaveBeenCalled();
  });
});
