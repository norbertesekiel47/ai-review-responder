// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLoginSubmit } from '../hooks/useLoginSubmit';

const { push, refresh, assign, aal } = vi.hoisted(() => ({
  push: vi.fn(), refresh: vi.fn(), assign: vi.fn(), aal: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      signInWithPassword: async () => ({ data: { user: { id: 'fixture-admin' } }, error: null }),
      signOut: vi.fn(),
      mfa: { getAuthenticatorAssuranceLevel: aal },
    },
    from: () => ({ select: () => ({ eq: () => ({ limit: () => ({
      maybeSingle: async () => ({ data: { role: 'admin' }, error: null }),
    }) }) }) }),
  }),
}));
const adminHome = 'https://admin.example.com';
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  const originalWindow = window;
  vi.stubGlobal('window', new Proxy(originalWindow, {
    get: (target, key) => key === 'location'
      ? { href: 'http://localhost/', origin: 'http://localhost', assign }
      : Reflect.get(target, key, target),
  }));
  aal.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null });
});
afterEach(() => vi.unstubAllGlobals());

async function signIn(from: string) {
  const { result } = renderHook(() => useLoginSubmit({ portal: 'admin', allowedRoles: ['admin'], defaultRoute: adminHome }));
  await act(() => result.current.submit('fixture@example.invalid', 'fixture-password', from));
  return result.current;
}

describe('trusted Admin home login navigation', () => {
  it.each(['', 'https://evil.example', '//evil.example', '/dashboard'])('uses the trusted default for rejected or absent from=%s', async (from) => {
    await signIn(from);
    expect(assign).toHaveBeenCalledExactlyOnceWith(adminHome);
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('retains a local impersonation destination', async () => {
    await signIn('/admin/impersonate');
    expect(push).toHaveBeenCalledExactlyOnceWith('/admin/impersonate');
    expect(refresh).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
  });
  it.each([
    ['', '/mfa/challenge?next=%2Fadmin'],
    ['/admin/impersonate', '/mfa/challenge?next=%2Fadmin%2Fimpersonate'],
  ])('keeps the MFA return local for from=%s', async (from, expected) => {
    aal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null });
    await signIn(from);
    expect(push).toHaveBeenCalledExactlyOnceWith(expected);
    expect(assign).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('does not navigate when the AAL check fails', async () => {
    aal.mockResolvedValue({ data: null, error: { message: 'fixture unavailable' } });
    const result = await signIn('');
    expect(result.error).toContain('Could not verify');
    expect(assign).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
