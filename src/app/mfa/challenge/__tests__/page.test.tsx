// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockListFactors, routerPush } = vi.hoisted(() => ({
  mockListFactors: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: routerPush,
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: { mfa: { listFactors: mockListFactors } },
  }),
}));

// Imported after vi.mock so the mocks are in place when the module loads.
const { MfaChallengeForm } = await import('../MfaChallengeForm');

describe('MfaChallengeForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // motion/react's useReducedMotion reads window.matchMedia, which jsdom
    // does not implement. Stub it so the brand shell renders deterministically.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  });

  it('renders a numeric, [0-9]*-patterned, 16px code input for a verified factor', async () => {
    mockListFactors.mockResolvedValue({
      data: {
        totp: [{ id: 'f1', status: 'verified', friendly_name: 'Authy' }],
        all: [],
      },
      error: null,
    });

    render(createElement(MfaChallengeForm));

    const input = await screen.findByLabelText('Authenticator code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('pattern', '[0-9]*');
    // text-base == 16px in Tailwind; below 16px iOS auto-zooms on focus.
    expect(input.className).toContain('text-base');
  });

  it('offers return-to-login AND contact-support recovery when no factor exists', async () => {
    mockListFactors.mockResolvedValue({ data: { totp: [], all: [] }, error: null });

    render(createElement(MfaChallengeForm));

    const loginLink = await screen.findByRole('link', { name: /return to login/i });
    expect(loginLink).toHaveAttribute('href', '/login');

    const supportLink = screen.getByRole('link', { name: /contact support/i });
    expect(supportLink).toHaveAttribute('href', 'mailto:support@repworth.net');
  });

  it('announces a factor-load failure through an alert region', async () => {
    mockListFactors.mockResolvedValue({ data: null, error: { message: 'boom' } });

    render(createElement(MfaChallengeForm));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);
  });
});
