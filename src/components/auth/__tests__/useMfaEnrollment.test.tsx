// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { mockEnroll, mockListFactors } = vi.hoisted(() => ({
  mockEnroll: vi.fn(),
  mockListFactors: vi.fn(),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      mfa: {
        enroll: mockEnroll,
        listFactors: mockListFactors,
      },
    },
  }),
}));

// Imported after vi.mock so the mock is in place when the module loads.
import { useMfaEnrollment } from '@/components/auth/useMfaEnrollment';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useMfaEnrollment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue({ data: { totp: [] }, error: null });
  });

  it('surfaces verified factors from the initial load', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'f1', friendly_name: 'RepWorth', factor_type: 'totp', status: 'verified' }] },
      error: null,
    });

    const { result } = renderHook(() => useMfaEnrollment());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.verifiedFactors).toHaveLength(1);
    expect(result.current.verifiedFactors[0]!.id).toBe('f1');
  });

  it('runs enroll → challenge → verify and reloads factors on success', async () => {
    mockEnroll.mockResolvedValue({
      data: { id: 'factor-123', totp: { qr_code: 'data:image/png;base64,AAA', secret: 'SECRET' } },
      error: null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'ch-1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startEnrollment();
    });
    expect(result.current.enrollment?.factorId).toBe('factor-123');
    expect(result.current.enrollment?.secret).toBe('SECRET');

    act(() => result.current.setCode('123456'));

    // The verified-factors reload after verify.
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-123', factor_type: 'totp', status: 'verified' }] },
      error: null,
    });

    await act(async () => {
      await result.current.verifyEnrollment();
    });

    const challengeCall = fetchMock.mock.calls[0]!;
    expect(challengeCall[0]).toBe('/api/auth/mfa/challenge');
    expect(JSON.parse(challengeCall[1].body)).toMatchObject({ action: 'challenge', factorId: 'factor-123' });
    const verifyCall = fetchMock.mock.calls[1]!;
    expect(JSON.parse(verifyCall[1].body)).toMatchObject({
      action: 'verify',
      factorId: 'factor-123',
      challengeId: 'ch-1',
      code: '123456',
    });

    expect(result.current.enrollment).toBeNull();
    expect(result.current.notice).toBe('MFA factor enrolled.');
    expect(result.current.verifiedFactors).toHaveLength(1);
  });

  it('enrolls a second factor under a name no existing factor holds', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'f1', friendly_name: 'RepWorth', factor_type: 'totp', status: 'verified' }] },
      error: null,
    });
    mockEnroll.mockResolvedValue({
      data: { id: 'factor-456', totp: { qr_code: 'data:image/png;base64,BBB', secret: 'SECRET2' } },
      error: null,
    });

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startEnrollment();
    });

    expect(mockEnroll).toHaveBeenCalledWith({ factorType: 'totp', friendlyName: 'RepWorth 2' });
    expect(result.current.enrollment?.factorId).toBe('factor-456');
  });

  it('re-reads the factor list before enroll so a cancelled enrollment does not reuse its name', async () => {
    mockListFactors
      .mockResolvedValueOnce({ data: { totp: [] }, error: null }) // initial load
      .mockResolvedValueOnce({ data: { totp: [] }, error: null }) // fresh read before the first startEnrollment
      .mockResolvedValueOnce({
        data: {
          totp: [{ id: 'factor-1', friendly_name: 'RepWorth', factor_type: 'totp', status: 'unverified' }],
        },
        error: null,
      }); // fresh read before the second startEnrollment — the cancelled enrollment is still on the server
    mockEnroll
      .mockResolvedValueOnce({
        data: { id: 'factor-1', totp: { qr_code: 'data:image/png;base64,AAA', secret: 'SECRET1' } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'factor-2', totp: { qr_code: 'data:image/png;base64,BBB', secret: 'SECRET2' } },
        error: null,
      });

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startEnrollment();
    });
    expect(mockEnroll).toHaveBeenNthCalledWith(1, { factorType: 'totp', friendlyName: 'RepWorth' });

    act(() => result.current.cancelEnrollment());
    expect(result.current.enrollment).toBeNull();

    await act(async () => {
      await result.current.startEnrollment();
    });
    expect(mockEnroll).toHaveBeenNthCalledWith(2, { factorType: 'totp', friendlyName: 'RepWorth 2' });
  });

  it('does not call enroll when the fresh factor list cannot be loaded', async () => {
    mockListFactors
      .mockResolvedValueOnce({ data: { totp: [] }, error: null }) // initial load succeeds
      .mockResolvedValueOnce({ data: null, error: new Error('network') }); // fresh read before startEnrollment fails

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startEnrollment();
    });

    expect(mockEnroll).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Could not load MFA factors.');
  });

  it('shows the name-conflict message when Supabase returns mfa_factor_name_conflict', async () => {
    mockEnroll.mockResolvedValue({
      data: null,
      error: { code: 'mfa_factor_name_conflict', message: 'A factor with this friendly name already exists' },
    });

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startEnrollment();
    });

    expect(result.current.error).toBe(
      'An authenticator app with this name already exists. Reload the page and try again.',
    );
  });

  it('shows the factor-limit message when Supabase returns too_many_enrolled_mfa_factors', async () => {
    mockEnroll.mockResolvedValue({
      data: null,
      error: { code: 'too_many_enrolled_mfa_factors', message: 'Too many factors' },
    });

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startEnrollment();
    });

    expect(result.current.error).toBe(
      'You have the maximum number of authenticator apps. Remove one before you add another.',
    );
  });

  it('shows the Supabase error message for an unmapped enrollment error', async () => {
    mockEnroll.mockResolvedValue({
      data: null,
      error: { code: 'weak_password', message: 'Something else broke' },
    });

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startEnrollment();
    });

    expect(result.current.error).toBe('Could not start MFA enrollment: Something else broke');
  });

  it('keeps the generic message when the enrollment error has no message', async () => {
    mockEnroll.mockResolvedValue({
      data: null,
      error: { code: 'unknown_error', message: '' },
    });

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startEnrollment();
    });

    expect(result.current.error).toBe('Could not start MFA enrollment.');
  });

  it('reports a rate-limit error without accepting the verification', async () => {
    mockEnroll.mockResolvedValue({
      data: { id: 'factor-123', totp: { qr_code: null, secret: 'SECRET' } },
      error: null,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.startEnrollment();
    });
    act(() => result.current.setCode('000000'));
    await act(async () => {
      await result.current.verifyEnrollment();
    });

    expect(result.current.error).toBe('Too many MFA attempts. Try again in a few minutes.');
    expect(result.current.enrollment).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a 403 on unenroll to the re-authenticate hint', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] },
      error: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'mfa_required' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMfaEnrollment());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.unenrollFactor('f1');
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ action: 'unenroll', factorId: 'f1' });
    expect(result.current.error).toBe('Sign in again with your authenticator before removing this factor.');
  });
});
