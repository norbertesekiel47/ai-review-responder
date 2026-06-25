import { describe, it, expect } from 'vitest';
import {
  AUTH_FLOWS,
  isAuthFlow,
  loginUrlForFlow,
  resetPasswordPathForFlow,
  resolveCallbackDestination,
  type CallbackResolution,
} from '../auth-flow';

describe('AUTH_FLOWS', () => {
  it('equals [owner, admin]', () => {
    expect(AUTH_FLOWS).toEqual(['owner', 'admin']);
  });
});

describe('isAuthFlow', () => {
  it('returns true for owner', () => {
    expect(isAuthFlow('owner')).toBe(true);
  });

  it('returns true for admin', () => {
    expect(isAuthFlow('admin')).toBe(true);
  });

  it('returns false for owners', () => {
    expect(isAuthFlow('owners')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isAuthFlow('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAuthFlow(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAuthFlow(undefined)).toBe(false);
  });
});

describe('loginUrlForFlow', () => {
  it('returns /admin/login for admin', () => {
    expect(loginUrlForFlow('admin')).toBe('/admin/login');
  });

  it('returns /login for owner', () => {
    expect(loginUrlForFlow('owner')).toBe('/login');
  });

  it('returns /admin/login for undefined (legacy admin default — spec §3.5)', () => {
    expect(loginUrlForFlow(undefined)).toBe('/admin/login');
  });
});

describe('resetPasswordPathForFlow', () => {
  it('returns /admin/reset-password for admin', () => {
    expect(resetPasswordPathForFlow('admin')).toBe('/admin/reset-password');
  });

  it('returns /reset-password for owner', () => {
    expect(resetPasswordPathForFlow('owner')).toBe('/reset-password');
  });
});

const resolverCases: Array<{
  name: string;
  role: string | null;
  rawNext: string;
  flow: 'owner' | 'admin' | undefined;
  expected: CallbackResolution;
}> = [
  {
    name: 'google-signup finish (owner)',
    role: null,
    rawNext: '/signup/finish',
    flow: 'owner',
    expected: { kind: 'finish', destination: '/signup/finish' },
  },
  {
    name: 'no-users-row owner non-finish next → signout',
    role: null,
    rawNext: '/dashboard',
    flow: 'owner',
    expected: { kind: 'signout-redirect', destination: '/login?error=account_incomplete' },
  },
  {
    name: 'no-users-row admin empty next → signout',
    role: null,
    rawNext: '',
    flow: 'admin',
    expected: {
      kind: 'signout-redirect',
      destination: '/admin/login?error=account_incomplete',
    },
  },
  {
    name: 'google-signup finish (admin flow, next-driven, role-agnostic)',
    role: null,
    rawNext: '/signup/finish',
    flow: 'admin',
    expected: { kind: 'finish', destination: '/signup/finish' },
  },
  {
    name: 'unsupported role (legacy sales_partner) owner flow → signout',
    role: 'sales_partner',
    rawNext: '/dashboard',
    flow: 'owner',
    expected: { kind: 'signout-redirect', destination: '/login?error=account_incomplete' },
  },
  {
    name: 'unsupported role admin flow → signout (admin login)',
    role: 'sales_partner',
    rawNext: '/admin/reset-password',
    flow: 'admin',
    expected: {
      kind: 'signout-redirect',
      destination: '/admin/login?error=account_incomplete',
    },
  },
  {
    name: 'owner reset-password passthrough',
    role: 'owner',
    rawNext: '/reset-password',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/reset-password' },
  },
  {
    name: 'admin reset-password passthrough',
    role: 'admin',
    rawNext: '/admin/reset-password',
    flow: 'admin',
    expected: { kind: 'redirect', destination: '/admin/reset-password' },
  },
  {
    name: 'owner honored owner next',
    role: 'owner',
    rawNext: '/settings/billing',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/settings/billing' },
  },
  {
    name: 'owner honored /onboarding next',
    role: 'owner',
    rawNext: '/onboarding/pay',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/onboarding/pay' },
  },
  {
    name: 'owner cross-role next rejected → /dashboard',
    role: 'owner',
    rawNext: '/admin/overview',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' },
  },
  {
    name: 'owner empty next → /dashboard',
    role: 'owner',
    rawNext: '',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' },
  },
  {
    name: 'owner stale /signup/finish (users row exists) → /dashboard',
    role: 'owner',
    rawNext: '/signup/finish',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' },
  },
  {
    name: 'admin honored admin next',
    role: 'admin',
    rawNext: '/admin/overview',
    flow: 'admin',
    expected: { kind: 'redirect', destination: '/admin/overview' },
  },
  {
    name: 'admin cross-role next rejected → /admin/overview',
    role: 'admin',
    rawNext: '/dashboard',
    flow: 'admin',
    expected: { kind: 'redirect', destination: '/admin/overview' },
  },
  {
    name: 'admin undefined flow empty next → /admin/overview',
    role: 'admin',
    rawNext: '',
    flow: undefined,
    expected: { kind: 'redirect', destination: '/admin/overview' },
  },
  {
    name: 'hostile // owner → /dashboard',
    role: 'owner',
    rawNext: '//evil.com',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' },
  },
  {
    name: 'hostile absolute https owner → /dashboard',
    role: 'owner',
    rawNext: 'https://evil.com',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' },
  },
  {
    name: 'hostile backslash owner → /dashboard',
    role: 'owner',
    rawNext: '/\\evil.com',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' },
  },
  {
    name: 'hostile encoded owner → /dashboard',
    role: 'owner',
    rawNext: '/%2F%2Fevil.com',
    flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' },
  },
  {
    name: 'hostile // admin → /admin/overview',
    role: 'admin',
    rawNext: '//evil.com',
    flow: 'admin',
    expected: { kind: 'redirect', destination: '/admin/overview' },
  },
];

describe('resolveCallbackDestination', () => {
  for (const testCase of resolverCases) {
    it(testCase.name, () => {
      expect(
        resolveCallbackDestination({
          role: testCase.role,
          rawNext: testCase.rawNext,
          flow: testCase.flow,
        }),
      ).toEqual(testCase.expected);
    });
  }

  it('never escapes same-origin for hostile next values', () => {
    const hostile = [
      '//evil.com',
      'https://evil.com',
      'http://evil.com',
      '/\\evil',
      '\\\\evil',
      '%2F%2Fevil',
      'javascript:alert(1)',
      ' /\t/evil',
      '////evil.com',
      'data:text/html,evil',
    ];
    for (const rawNext of hostile) {
      for (const role of ['owner', 'admin', null] as const) {
        for (const flow of ['owner', 'admin', undefined] as const) {
          const resolution = resolveCallbackDestination({ role, rawNext, flow });
          expect(resolution.destination.startsWith('/')).toBe(true);
          expect(resolution.destination.startsWith('//')).toBe(false);
        }
      }
    }
  });
});
