// The Refusal Log eval — route half (T0, red-first).
//
// Titles are VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches them as fixed strings.
//
// `src/app/api/dashboard/refusals/route.ts` does not exist at this commit — T5
// creates it, copied almost verbatim from `agent-team/route.ts`
// (`withDashboardOwnerRead` → `resolveDashboardRequest` → one call →
// `resolveDashboardLocation` for the location branch). Every case is `it.todo`:
// a static import of a missing route module fails the whole FILE at collection.
//
// Mocking level, when the bodies land: mock the auth PRIMITIVES
// (`@/lib/db/auth`), `@/lib/db/server` and `@/lib/refusals/read`, the way
// `./scope-route.test.ts` does — not the dashboard policy helpers. ESM internal
// calls do not go through a mocked export, so a stub on a composed helper stops
// intercepting the moment the route calls a sibling in that module.
//
// THREE OF THESE ARE REDACTION CASES, not shape cases. S1 is deny-all RLS read
// through the RLS-bypassing `postgres` role, so application redaction is the
// whole security story (plan §7 risk 1): assert the ABSENCE of any
// `flagged_responses.reason` value from the serialized body at ANY depth, from
// the error path, and from the logger — never merely that a label looks right.

import { describe, it } from 'vitest';

describe('GET /api/dashboard/refusals redaction', () => {
  it.todo('the refusals route serializes no flagged reason at any depth');

  it.todo('the refusals route returns no flagged reason on an error path');

  it.todo('the refusals route logs no flagged reason');
});

describe('GET /api/dashboard/refusals', () => {
  // Invariant #12: parse input, call one module function, return output.
  it.todo('the refusals route resolves scope, calls getRefusalLog once, and contains no source query logic');

  it.todo('the refusals route rejects an unauthenticated caller');

  // `resolveDashboardLocation` with `exposure: 'uniform-not-found'` — a location
  // the caller does not own is indistinguishable from one that does not exist.
  it.todo('the refusals route returns the uniform not-found response for a location the caller does not own');

  it.todo('the refusals route clamps an invalid window to the default');

  it.todo('the refusals route reads only the impersonated account');
});
