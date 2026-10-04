import { describe, expect, it } from 'vitest';

// Guards the shutdown redirects in next.config.mjs: every page route that
// needs the backend RepWorth switched off goes to the static /closed notice,
// temporarily (307), while the marketing and legal pages, /closed itself and
// /api/** keep their own behavior. Asserts against the REAL exported config,
// the next-config-headers.test.ts precedent.

type Redirect = { source: string; destination: string; permanent: boolean };
type NextConfigModule = { default: { redirects: () => Promise<Redirect[]> } };

async function redirects(): Promise<Redirect[]> {
  const mod = (await import('../../next.config.mjs')) as unknown as NextConfigModule;
  return mod.default.redirects();
}

async function closedRedirects(): Promise<Redirect[]> {
  return (await redirects()).filter((rule) => rule.destination === '/closed');
}

describe('next.config.mjs shutdown redirects', () => {
  it('sends every backend-dependent page prefix to /closed', async () => {
    const sources = (await closedRedirects()).map((rule) => rule.source);
    expect(sources).toEqual([
      '/signup/:path*',
      '/login/:path*',
      '/forgot-password/:path*',
      '/reset-password/:path*',
      '/book-a-demo/:path*',
      '/demo/:path*',
      '/approve/:path*',
      '/u/:path*',
      '/onboarding/:path*',
      '/dashboard/:path*',
      '/settings/:path*',
      '/account/:path*',
      '/mfa/:path*',
      '/admin/:path*',
      '/q/:path*',
      '/r/:path*',
    ]);
  });

  it('is temporary (307), so browsers do not cache it and the site can be revived', async () => {
    for (const rule of await closedRedirects()) {
      expect(rule.permanent).toBe(false);
    }
  });

  it('runs before the older redirects, so a stale deep link takes one hop', async () => {
    const all = await redirects();
    const firstOther = all.findIndex((rule) => rule.destination !== '/closed');
    const lastClosed = all.map((rule) => rule.destination).lastIndexOf('/closed');
    expect(lastClosed).toBeLessThan(firstOther);
  });

  it('leaves the notice, the API, and the marketing and legal pages alone', async () => {
    const sources = (await closedRedirects()).map((rule) => rule.source);
    const untouched = ['/', '/closed', '/api', '/features', '/how-it-works', '/pricing', '/security', '/help', '/legal'];
    for (const path of untouched) {
      expect(sources.some((source) => source === path || source.startsWith(`${path}/`))).toBe(false);
    }
  });
});
