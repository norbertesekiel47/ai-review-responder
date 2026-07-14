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
