// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockListFactors, routerPush, routerRefresh } = vi.hoisted(() => ({
  mockListFactors: vi.fn(),
  routerPush: vi.fn(),
  routerRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
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

  describe('submit flow', () => {
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
      expect(alert).toHaveTextContent(/was not accepted/i);

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
      expect(alert).toHaveTextContent(/too many mfa attempts/i);
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
      expect(alert).toHaveTextContent(/too many mfa attempts/i);

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
      expect(alert).toHaveTextContent(/the verification code was not accepted\./i);

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
      expect(alert).toHaveTextContent(/could not start mfa challenge\. check your connection/i);
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
      expect(alert).toHaveTextContent(/could not verify the mfa code\. check your connection/i);

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
      expect(alert).toHaveTextContent(/^Could not start MFA challenge\.$/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(routerPush).not.toHaveBeenCalled();
    });
  });
});
