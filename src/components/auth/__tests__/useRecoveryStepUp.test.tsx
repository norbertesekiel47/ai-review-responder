// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { mockGetUser, mockListFactors } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockListFactors: vi.fn(),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getUser: mockGetUser,
      mfa: { listFactors: mockListFactors },
    },
  }),
}));

import { useRecoveryStepUp } from '@/components/auth/useRecoveryStepUp';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VERIFIED_FACTOR = {
  id: 'factor-1',
  friendly_name: 'Authenticator',
  status: 'verified',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  mockListFactors.mockResolvedValue({ data: { totp: [] }, error: null });
});

describe('useRecoveryStepUp — probe', () => {
  it('reports no-session when there is no recovery session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const { result } = renderHook(() => useRecoveryStepUp());

    await waitFor(() => expect(result.current.status).toBe('no-session'));
    // No point listing factors for a session that does not exist.
    expect(mockListFactors).not.toHaveBeenCalled();
  });

  it('reports no-factor when the account has no verified factor', async () => {
    const { result } = renderHook(() => useRecoveryStepUp());
    await waitFor(() => expect(result.current.status).toBe('no-factor'));
  });

  it('reports code-required when a verified factor exists', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [VERIFIED_FACTOR] },
      error: null,
    });

    const { result } = renderHook(() => useRecoveryStepUp());

    await waitFor(() => expect(result.current.status).toBe('code-required'));
    expect(result.current.factors).toEqual([
      { id: 'factor-1', label: 'Authenticator' },
    ]);
    expect(result.current.selectedFactorId).toBe('factor-1');
  });

  it('treats an unverified-only account as no-factor', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ ...VERIFIED_FACTOR, status: 'unverified' }] },
      error: null,
    });

    const { result } = renderHook(() => useRecoveryStepUp());
    await waitFor(() => expect(result.current.status).toBe('no-factor'));
  });

  it('fails toward code-required when listFactors errors', async () => {
    mockListFactors.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const { result } = renderHook(() => useRecoveryStepUp());

    // Guessing no-factor would walk the user into a submit the server refuses
    // anyway; asking for a possibly-unneeded code is the cheaper wrong answer.
    await waitFor(() => expect(result.current.status).toBe('code-required'));
    expect(result.current.selectedFactorId).toBe('');
  });

  it('treats a resolved AuthRetryableFetchError as a load failure, not an absent session', async () => {
    // getUser() surfaces network/CORS/5xx failures as a *resolved* error
    // (supabase-js does not throw AuthRetryableFetchError) — this is the real
    // shape, and must not be mistaken for "this link expired."
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { __isAuthError: true, name: 'AuthRetryableFetchError', message: 'fetch failed' },
    });

    const { result } = renderHook(() => useRecoveryStepUp());

    await waitFor(() => expect(result.current.status).toBe('code-required'));
    expect(result.current.selectedFactorId).toBe('');
  });

  it('treats a resolved non-retryable AuthError as a genuinely absent session', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { __isAuthError: true, name: 'AuthApiError', message: 'invalid refresh token' },
    });

    const { result } = renderHook(() => useRecoveryStepUp());

    await waitFor(() => expect(result.current.status).toBe('no-session'));
  });

  it('treats a thrown probe (outside the AuthError contract) as a load failure', async () => {
    // e.g. a Web Locks API timeout acquiring the session lock — not
    // identifiable as a network blip, but not proof the link expired either.
    mockGetUser.mockRejectedValue(new Error('lock timeout'));

    const { result } = renderHook(() => useRecoveryStepUp());

    await waitFor(() => expect(result.current.status).toBe('code-required'));
    expect(result.current.selectedFactorId).toBe('');
  });
});

describe('useRecoveryStepUp — verify', () => {
  async function mountWithFactor() {
    mockListFactors.mockResolvedValue({
      data: { totp: [VERIFIED_FACTOR] },
      error: null,
    });
    const { result } = renderHook(() => useRecoveryStepUp());
    await waitFor(() => expect(result.current.status).toBe('code-required'));
    return result;
  }

  it('challenges then verifies, and reports verified on success', async () => {
    const result = await mountWithFactor();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    act(() => result.current.setCode('123456'));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(true);
    expect(result.current.status).toBe('verified');
    expect(result.current.busy).toBe(false);

    const [challengeUrl, challengeInit] = fetchMock.mock.calls[0]!;
    expect(challengeUrl).toBe('/api/auth/mfa/challenge');
    expect(JSON.parse(challengeInit.body)).toEqual({
      action: 'challenge',
      factorId: 'factor-1',
    });

    const [, verifyInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(verifyInit.body)).toEqual({
      action: 'verify',
      factorId: 'factor-1',
      challengeId: 'chal-1',
      code: '123456',
    });
  });

  it('reports a rejected code without advancing to verified', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
        .mockResolvedValueOnce(jsonResponse({ error: 'verify_failed' }, 400)),
    );

    act(() => result.current.setCode('000000'));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(false);
    expect(result.current.status).toBe('code-required');
    expect(result.current.error).toBe('The verification code was not accepted.');
    expect(result.current.busy).toBe(false);
  });

  it('surfaces the rate-limit copy on 429', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429)),
    );

    act(() => result.current.setCode('123456'));
    await act(async () => {
      await result.current.verify();
    });

    expect(result.current.error).toBe(
      'Too many MFA attempts. Try again in 15 minutes.',
    );
  });

  it('treats a 401 on the challenge leg as a lapsed session, not a bad code', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401)),
    );

    act(() => result.current.setCode('123456'));
    await act(async () => {
      await result.current.verify();
    });

    expect(result.current.error).toBe('Your reset link expired. Request a new one.');
    expect(result.current.status).toBe('code-required');
  });

  it('treats a 401 on the verify leg as a lapsed session, not a bad code', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
        .mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401)),
    );

    act(() => result.current.setCode('123456'));
    await act(async () => {
      await result.current.verify();
    });

    expect(result.current.error).toBe('Your reset link expired. Request a new one.');
  });

  it('treats a 503 on the challenge leg as a temporary outage, not a bad code', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: 'rate_limit_unavailable' }, 503)),
    );

    act(() => result.current.setCode('123456'));
    await act(async () => {
      await result.current.verify();
    });

    expect(result.current.error).toBe(
      'The verification service is temporarily unavailable. Try again in a moment.',
    );
  });

  it('treats a 503 on the verify leg as a temporary outage, not a bad code', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
        .mockResolvedValueOnce(jsonResponse({ error: 'rate_limit_unavailable' }, 503)),
    );

    act(() => result.current.setCode('123456'));
    await act(async () => {
      await result.current.verify();
    });

    expect(result.current.error).toBe(
      'The verification service is temporarily unavailable. Try again in a moment.',
    );
  });

  it('refuses to verify with a blank code without spending a challenge', async () => {
    const result = await mountWithFactor();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Enter your verification code.');
  });

  it('survives a network failure without wedging', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    act(() => result.current.setCode('123456'));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(false);
    expect(result.current.status).toBe('code-required');
    expect(result.current.error).toContain('connection');
  });

  it('times out a wedged challenge fetch instead of leaving busy true forever', async () => {
    const result = await mountWithFactor();
    // Simulate fetchWithTimeout's real behavior: the request never settles on
    // its own, only when the abort signal it was given fires.
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    act(() => result.current.setCode('123456'));

    let verifyPromise!: Promise<boolean>;
    act(() => {
      verifyPromise = result.current.verify();
    });
    expect(result.current.busy).toBe(true);

    let outcome: boolean | undefined;
    await act(async () => {
      // fetchWithTimeout's default timeout.
      await vi.advanceTimersByTimeAsync(12_000);
      outcome = await verifyPromise;
    });

    vi.useRealTimers();

    expect(outcome).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toContain('connection');
  });

  it('stays verified across a later failed password write — no second code', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
        .mockResolvedValueOnce(jsonResponse({ ok: true })),
    );

    act(() => result.current.setCode('123456'));
    await act(async () => {
      await result.current.verify();
    });
    expect(result.current.status).toBe('verified');

    // The card retries the password write; verify() must be a no-op that
    // reports success rather than demanding a fresh code. This is the client
    // half of the route's deliberate choice not to signOut on updateError.
    const secondFetch = vi.fn();
    vi.stubGlobal('fetch', secondFetch);

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(true);
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it('is a no-op returning true when the account has no factor', async () => {
    const { result } = renderHook(() => useRecoveryStepUp());
    await waitFor(() => expect(result.current.status).toBe('no-factor'));

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collapses concurrent verify calls into one challenge+verify pair', async () => {
    const result = await mountWithFactor();
    let resolveChallenge!: (value: Response) => void;
    const deferredChallenge = new Promise<Response>((resolve) => {
      resolveChallenge = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => deferredChallenge)
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    act(() => result.current.setCode('123456'));

    let firstCall!: Promise<boolean>;
    let secondCall!: Promise<boolean>;
    act(() => {
      firstCall = result.current.verify();
      secondCall = result.current.verify();
    });

    // The second call observes the SAME promise the first returned rather
    // than racing its own challenge+verify attempt.
    expect(firstCall).toBe(secondCall);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);

    resolveChallenge(jsonResponse({ challengeId: 'chal-1' }));

    const outcomes = await act(async () => Promise.all([firstCall, secondCall]));

    expect(outcomes).toEqual([true, true]);
    // Two calls, one challenge and one verify — not two of each.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.busy).toBe(false);
  });

  it('accepts a corrected code on a sequential retry after a rejection', async () => {
    const result = await mountWithFactor();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'verify_failed' }, 400))
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-2' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    act(() => result.current.setCode('000000'));
    let firstOutcome: boolean | undefined;
    await act(async () => {
      firstOutcome = await result.current.verify();
    });
    expect(firstOutcome).toBe(false);
    expect(result.current.status).toBe('code-required');

    act(() => result.current.setCode('123456'));
    let secondOutcome: boolean | undefined;
    await act(async () => {
      secondOutcome = await result.current.verify();
    });

    // The `.finally()` that clears `inFlight` after the first (failed) run
    // must not leave the retry permanently collapsed into the stale promise.
    expect(secondOutcome).toBe(true);
    expect(result.current.status).toBe('verified');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('refuses to verify when the probe failed and no factor id is known', async () => {
    mockListFactors.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useRecoveryStepUp());
    await waitFor(() => expect(result.current.status).toBe('code-required'));

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.verify();
    });

    expect(outcome).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error).toContain('Reload');
  });

  it('requireStepUp resets a verified session back to code-required for a fresh code', async () => {
    const result = await mountWithFactor();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ challengeId: 'chal-1' }))
        .mockResolvedValueOnce(jsonResponse({ ok: true })),
    );

    act(() => result.current.setCode('123456'));
    await act(async () => {
      await result.current.verify();
    });
    expect(result.current.status).toBe('verified');

    // The password-write route fails closed on its own AAL re-check (403
    // mfa_required) even after a prior successful verify. The card calls
    // this to put the hook back where a fresh code can clear it again.
    act(() => result.current.requireStepUp());

    expect(result.current.status).toBe('code-required');
    expect(result.current.code).toBe('');
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});
