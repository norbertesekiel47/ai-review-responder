// src/lib/config/admin-origins.ts
//
// The authoritative answer to "may this Origin talk to the Admin API?".
//
// `src/proxy.ts` owns the CORS headers; this module owns the DECISION behind
// them (ADR 0026 D1/D2/D4, and invariant #12 — the decision branch is a named
// module with focused tests, not an inline block in the proxy).
//
// It lives in src/lib/config/ because `ADMIN_APP_ORIGINS` has to be read here:
// `scripts/ci/process-env-baseline.ts` allowlists this prefix as the only
// sanctioned `process.env` home. It is its own file rather than part of
// flags.ts (boolean *_ENABLED flags) or deployment-lane.ts (lane resolution) —
// an origin allowlist is neither.
//
// Three rules decide, in this order, and the order is the security property:
//
//   1. This app's own origin is always allowed. The comparison is NOT re-spelt
//      here — `isSelfOrigin` in src/lib/shared/csrf.ts is its single owner
//      (ADR 0026 D4), so CORS and CSRF can never disagree about what "self" is.
//   2. Loopback is decided by CODE ALONE and TERMINALLY: allowed outside the
//      production lane, refused inside it, whether or not it appears in the
//      list. ADR 0026 D2 calls loopback "a separate code rule, not a list
//      entry" — if a listed `http://localhost` entry could fall through to
//      step 3, the production lane's inertness would be bypassable from a
//      dashboard.
//   3. Only then, the configured allowlist.
//
// Edge-safe by construction: reached from `src/proxy.ts`, which sits outside
// every ESLint invariant #1 zone, so the import graph carries no runtime
// builtin, DB client or provider SDK. Pinned by a source scan in
// `__tests__/admin-origins.test.ts` § "Edge safety".
//
// THROWING IS ASYMMETRIC AND DELIBERATE. Bad *config* throws — loudly, on
// every `/api/admin/**` request, so a misconfiguration is an Admin-app outage
// and never a silent weakening (ADR 0026 Consequences). A bad *request* Origin
// never throws: it is simply not allowed, and the proxy refuses it 403.

import { isSelfOrigin } from '@/lib/shared/csrf';

import { isProductionEnvironment } from './flags';

/** A malformed or unsafe `ADMIN_APP_ORIGINS` value. Config-only — the
 *  request-side predicates are total and never throw this. */
export class AdminOriginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminOriginConfigError';
  }
}

const ALLOWED_SCHEMES = ['http:', 'https:'];

/** Hosts the loopback code rule covers. `https://localhost` and `http://[::1]`
 *  are deliberately NOT here: ADR 0024 D7 wrote `http://localhost:*`, and a
 *  developer needing either adds an explicit non-production list entry. */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1'];

/**
 * `new URL(value)` or null. The catch is the whole point — a value that does
 * not parse is not an origin, and every caller here wants that as a verdict
 * rather than an exception.
 */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Validate ONE comma-list entry and return the origin it authorizes.
 *
 * Rejects far more than the `*` ADR 0026 D2 mandates, because `new URL()` is
 * permissive in ways that silently widen an entry: `file:`/`data:` serialize to
 * the origin `"null"`, `blob:https://admin.example/id` rewrites to
 * `https://admin.example`, and userinfo/path/query/fragment would make an entry
 * that LOOKS URL-scoped grant authority over the entire origin.
 */
function parseAllowlistEntry(entry: string): string {
  if (entry.includes('*')) {
    throw new AdminOriginConfigError(
      `ADMIN_APP_ORIGINS entry "${entry}" contains a wildcard — the Admin API never answers a wildcard origin`,
    );
  }

  const url = parseUrl(entry);
  if (!url) {
    throw new AdminOriginConfigError(
      `ADMIN_APP_ORIGINS entry "${entry}" is not a parseable absolute origin`,
    );
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) {
    throw new AdminOriginConfigError(
      `ADMIN_APP_ORIGINS entry "${entry}" must use http: or https:, not ${url.protocol}`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AdminOriginConfigError(
      `ADMIN_APP_ORIGINS entry "${entry}" must be a bare origin — no userinfo, query or fragment`,
    );
  }
  // A bare trailing slash is the one non-origin component accepted: it carries
  // no scoping intent and normalizes away.
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new AdminOriginConfigError(
      `ADMIN_APP_ORIGINS entry "${entry}" must be a bare origin — no path component`,
    );
  }

  return url.origin;
}

/**
 * The configured Admin app origins. The ONLY reader of `ADMIN_APP_ORIGINS`.
 *
 * Unset, empty or comma-only is `[]` and is NOT an error — that is the correct
 * state of every environment before the Admin app exists, and it leaves only
 * self-origin and (outside production) loopback admitted.
 *
 * NOT memoized, following the flags.ts precedent: an Edge request parses a
 * one- or two-entry comma list, and a memo would force a reset dance in tests.
 */
export function readAdminAppOrigins(): readonly string[] {
  const raw = process.env.ADMIN_APP_ORIGINS;
  if (!raw) return [];

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseAllowlistEntry);
}

/**
 * Canonical `scheme://host[:port]` for an http(s) origin, else null.
 *
 * Total by design. Null covers absent, empty, the literal `'null'` (the opaque
 * origin a sandboxed iframe or a redirected cross-origin POST sends), a
 * malformed or multi-valued header, and any non-http(s) scheme.
 *
 * The proxy echoes THIS value in `Access-Control-Allow-Origin`, never the raw
 * header, so the header written is always exactly the origin that was decided
 * about — a canonical-output rule, not an injection defence, and a browser's own
 * serialization is already identical to it. Rationale:
 * `docs/superpowers/plans/feat-1186-admin-api-cors-plan.md` §2 and §5 delta D-14.
 * (ADR 0026 itself has only D1–D8 and states no canonical-output decision.)
 */
export function normalizeOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;

  const url = parseUrl(origin);
  if (!url) return null;
  if (!ALLOWED_SCHEMES.includes(url.protocol)) return null;

  return url.origin;
}

/**
 * `http://localhost:<any>` / `http://127.0.0.1:<any>` — the exact set ADR 0024
 * D7 wrote. Internal: it is one clause of `isAllowedAdminOrigin`'s verdict, not
 * a question any caller outside this file asks.
 */
function isLoopbackOrigin(origin: string): boolean {
  const url = parseUrl(origin);
  if (!url) return false;

  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.includes(url.hostname);
}

/**
 * May this request Origin reach the Admin API?
 *
 * Total — a malformed, empty, opaque or multi-valued Origin is a `false`
 * verdict (the proxy answers 403), never a throw. `allowlist` is passed in
 * rather than read, so the decision is pure of the environment except for the
 * self-origin and production-lane rules it is defined by.
 */
export function isAllowedAdminOrigin(origin: string, allowlist: readonly string[]): boolean {
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return false;

  if (isSelfOrigin(normalized)) return true;

  // TERMINAL: loopback never falls through to the list. See the header — this
  // return is what keeps a listed `http://localhost` from re-admitting loopback
  // in production.
  if (isLoopbackOrigin(normalized)) return !isProductionEnvironment();

  return allowlist.includes(normalized);
}
