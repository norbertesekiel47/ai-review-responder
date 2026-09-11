// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockListFactors, routerPush, routerRefresh, search } = vi.hoisted(() => ({
  mockListFactors: vi.fn(),
  routerPush: vi.fn(),
  routerRefresh: vi.fn(),
  search: { value: '' },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({
    push: routerPush,
    replace: () => {},
    refresh: routerRefresh,
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

// `fetch` is mocked with plain `vi.fn()` (matches the rest of the repo's
// fetch-mocking style, e.g. ResetPasswordFormClient.test.tsx), so
// `mock.calls[n]` is untyped — narrow just enough to read the JSON body
// without asserting `any` ourselves.
function parseBody(call: readonly unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function renderWithVerifiedFactor() {
  mockListFactors.mockResolvedValue({
    data: {
      totp: [{ id: 'f1', status: 'verified', friendly_name: 'Authy' }],
      all: [],
    },
    error: null,
  });
  render(createElement(MfaChallengeForm));
  return screen.findByLabelText('Authenticator code');
}

async function submitCode(code: string) {
  const input = await screen.findByLabelText('Authenticator code');
  fireEvent.change(input, { target: { value: code } });
  fireEvent.submit(input.closest('form')!);
}

describe('MfaChallengeForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    search.value = '';
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
    expect(alert).toHaveTextContent(/couldn't load your authenticator options/i);
  });

  describe('submit flow', () => {
    it.each([
      ['/admin', '/admin'],
      ['https://evil.example/admin', '/dashboard'],
      ['//evil.example/admin', '/dashboard'],
    ])('keeps the post-verification destination %s inside the existing local allowlist', async (next, expected) => {
      search.value = new URLSearchParams({ next }).toString();
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }));
      await renderWithVerifiedFactor();
      await submitCode('123456');
      await waitFor(() => expect(routerPush).toHaveBeenCalledWith(expected));
      expect(routerRefresh).toHaveBeenCalledOnce();
    });

    it('happy path: posts challenge then verify, then navigates', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      await renderWithVerifiedFactor();
      await submitCode('123456');

      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));
      expect(routerRefresh).toHaveBeenCalledTimes(1);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/auth/mfa/challenge');
      expect(parseBody(fetchMock.mock.calls[0]!)).toEqual({ action: 'challenge', factorId: 'f1' });
      expect(fetchMock.mock.calls[1]![0]).toBe('/api/auth/mfa/challenge');
      expect(parseBody(fetchMock.mock.calls[1]!)).toEqual({
        action: 'verify',
        factorId: 'f1',
        challengeId: 'chal-1',
        code: '123456',
      });
    });

    it('caches the challengeId across a failed verify, then requests a fresh one on the next submit', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-2' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      await renderWithVerifiedFactor();
      await submitCode('111111');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/wasn't accepted/i);

      await submitCode('222222');
      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));

      expect(fetchMock).toHaveBeenCalledTimes(4);
      // The second submit re-requested a challenge instead of reusing chal-1 —
      // proof the failed-verify path cleared the cached challengeId.
      expect(parseBody(fetchMock.mock.calls[2]!)).toEqual({ action: 'challenge', factorId: 'f1' });
      expect(parseBody(fetchMock.mock.calls[3]!)).toEqual({
        action: 'verify',
        factorId: 'f1',
        challengeId: 'chal-2',
        code: '222222',
      });
    });

    it('429 on the challenge leg shows the rate-limit copy and never calls verify', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      await renderWithVerifiedFactor();
      await submitCode('123456');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/too many code attempts/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(routerPush).not.toHaveBeenCalled();
    });

    it('429 on the verify leg shows the rate-limit copy and clears the cached challengeId', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
        .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-2' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      await renderWithVerifiedFactor();
      await submitCode('123456');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/too many code attempts/i);

      await submitCode('654321');
      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));

      // Fresh challenge request on the next submit proves the 429 cleared it.
      expect(parseBody(fetchMock.mock.calls[2]!)).toEqual({ action: 'challenge', factorId: 'f1' });
    });

    it('a non-ok verify shows "not accepted" copy and clears the cached challengeId', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-2' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      await renderWithVerifiedFactor();
      await submitCode('123456');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/that code wasn't accepted\. enter the current code from your authenticator app\./i);

      await submitCode('654321');
      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));

      expect(parseBody(fetchMock.mock.calls[2]!)).toEqual({ action: 'challenge', factorId: 'f1' });
    });

    it('a network failure on the challenge leg shows the connection-error copy and never calls verify', async () => {
      const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline'));
      vi.stubGlobal('fetch', fetchMock);

      await renderWithVerifiedFactor();
      await submitCode('123456');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/couldn't start the security check\. check your connection/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(routerPush).not.toHaveBeenCalled();
    });

    it('a network failure on the verify leg shows the connection-error copy and clears the cached challengeId', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-2' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      await renderWithVerifiedFactor();
      await submitCode('123456');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/couldn't check your code\. check your connection/i);

      await submitCode('654321');
      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/dashboard'));

      expect(parseBody(fetchMock.mock.calls[2]!)).toEqual({ action: 'challenge', factorId: 'f1' });
    });

    it('a malformed challenge response (ok, no string challengeId) shows the challenge-failed copy and never calls verify', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      await renderWithVerifiedFactor();
      await submitCode('123456');

      const alert = await screen.findByRole('alert');
      // Deliberately does NOT match the "Check your connection" copy from the
      // network-failure case above — this is the ok-but-malformed branch.
      expect(alert).toHaveTextContent(/^Couldn't start the security check\. Please try again\.$/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(routerPush).not.toHaveBeenCalled();
    });

    it('a rejected code clears the digits, returns focus to the field, and disables Verify until a new code is typed (A23)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const input = await renderWithVerifiedFactor();
      await submitCode('111111');
      await screen.findByRole('alert');

      expect(input).toHaveValue('');
      expect(document.activeElement).toBe(input);
      expect(screen.getByRole('button', { name: /^verify$/i })).toBeDisabled();
    });

    it('a 429 on the verify leg also clears the digits and refocuses (A23)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
        .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const input = await renderWithVerifiedFactor();
      await submitCode('111111');
      await screen.findByRole('alert');

      expect(input).toHaveValue('');
      expect(document.activeElement).toBe(input);
    });
  });

  describe('owner-facing language and tokens (A2, A7, A23)', () => {
    const INTERNAL_NOUNS = /\b(MFA|factor|challenge|TOTP)\b/i;

    it('never names MFA, factors, or challenges in a rejection banner', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ challengeId: 'chal-1' }) })
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      await renderWithVerifiedFactor();
      await submitCode('111111');
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).not.toMatch(INTERNAL_NOUNS);
    });

    it('never names MFA or factors when the authenticator list fails to load', async () => {
      mockListFactors.mockResolvedValue({ data: null, error: { message: 'boom' } });
      render(createElement(MfaChallengeForm));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).not.toMatch(INTERNAL_NOUNS);
    });

    it('renders the alert with rw-error tokens, not raw red utilities', async () => {
      mockListFactors.mockResolvedValue({ data: null, error: { message: 'boom' } });
      render(createElement(MfaChallengeForm));
      const alert = await screen.findByRole('alert');
      expect(alert.className).toContain('text-rw-error');
      expect(alert.className).toContain('border-rw-error/30');
      expect(alert.className).not.toMatch(/\b(text|bg|border)-red-\d+/);
    });

    it('fills the Verify button and colours links with rw-teal-strong (ADR 0004), never rw-teal', async () => {
      await renderWithVerifiedFactor();
      const button = screen.getByRole('button', { name: /^verify$/i });
      expect(button.className).toContain('bg-rw-teal-strong');
      expect(button.className).not.toMatch(/(?:^|\s)bg-rw-teal(?=\s|$)/);
      const support = screen.getByRole('link', { name: /contact support/i });
      expect(support.className).toContain('text-rw-teal-strong');
      expect(support.className).not.toMatch(/(?:^|\s)text-rw-teal(?=\s|$)/);
    });
  });
});
