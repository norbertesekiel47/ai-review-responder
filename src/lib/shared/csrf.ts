export class SameOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SameOriginError';
  }
}

/** `new URL(value)` or null — a value that does not parse is simply not an origin. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Is `origin` this app's OWN origin?
 *
 * The single owner of that comparison, per ADR 0026 D4. Two consumers: this
 * file's `assertSameOrigin` (CSRF) and `src/lib/config/admin-origins.ts`
 * (the Admin origin allowlist's implicit self-allowance, reached from
 * `src/proxy.ts`). Two copies of this test can disagree, and a disagreement is
 * either a dead Legacy admin portal or a bypass — the same rule Admin transport
 * already states for the bearer predicate.
 *
 * Compares `URL.origin` (scheme + host + port) on BOTH sides, so a subpath
 * `NEXT_PUBLIC_APP_URL` like `https://app.example.com/prefix` still matches an
 * `Origin` header of `https://app.example.com`, and a trailing slash on either
 * side is immaterial.
 *
 * TOTAL: it answers false — never throws — for an absent, empty, opaque
 * (`'null'`), malformed or multi-valued origin, and for an unset or malformed
 * `NEXT_PUBLIC_APP_URL`. `src/proxy.ts` runs this on every `/api/admin/**`
 * request with an `Origin`, and a throw there would be a 500 on the admin
 * control plane rather than a refusal. `assertSameOrigin` keeps its own
 * explicit throws for those cases, because a CSRF failure wants to say which
 * precondition it was.
 */
export function isSelfOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return false;

  const expected = parseUrl(appUrl);
  const actual = parseUrl(origin);
  if (!expected || !actual) return false;

  return actual.origin === expected.origin;
}

export function assertSameOrigin(request: Request): void {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new SameOriginError('NEXT_PUBLIC_APP_URL not configured — cannot validate Origin header');
  }
  const secFetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite === 'cross-site') {
    throw new SameOriginError('Sec-Fetch-Site cross-site requests are forbidden');
  }
  const origin = request.headers.get('origin');
  if (!origin) {
    throw new SameOriginError('Missing Origin header');
  }
  // Malformed is a DIFFERENT refusal from mismatched, so it is tested here
  // rather than inferred from isSelfOrigin's single false. The verdict itself
  // is isSelfOrigin's — this function never re-spells the comparison.
  if (!parseUrl(appUrl) || !parseUrl(origin)) {
    throw new SameOriginError(
      `Malformed Origin or APP_URL — origin=${origin}, APP_URL=${appUrl}`,
    );
  }
  // NOTE: deliberately isSelfOrigin, NOT isAllowedAdminOrigin. The Admin origin
  // allowlist must never leak into CSRF — an allowlisted Admin app origin and a
  // loopback origin are both still cross-origin to a cookie-authenticated
  // mutation, and both are still refused here.
  if (!isSelfOrigin(origin)) {
    throw new SameOriginError(`Origin ${origin} does not match APP_URL ${appUrl}`);
  }
}
