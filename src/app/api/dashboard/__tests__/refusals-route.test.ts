// `GET /api/dashboard/refusals` — route eval (#1014 T1, RED).
//
// Titles 23-31, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// All `it.todo` at T1: `src/app/api/dashboard/refusals/route.ts` does not exist
// yet, and a named import of an absent module fails the whole file at
// collection. Task 5 adds the route, the import and these bodies.
//
// THREE OF THESE NINE ARE REDACTION TESTS, and they are deliberately not one
// test. ADR 0023 makes `all_refusal_codes` and moderation prose non-owner-facing,
// and RLS filters ROWS, not columns — so the exclusion is application-side and
// unenforced by the database. The success body, the ERROR arm and the LOGS are
// three separate sinks; a leak on any one of them is a leak. A single "omits
// all_refusal_codes" test proves the sink it happens to exercise.
//
// The impersonation title exists because mocking `requireRole` proves the route
// calls a mock. Task 5 drives that path through the real gate.

import { describe, it } from 'vitest';

describe('GET /api/dashboard/refusals', () => {
  // --- The two scopes ---
  it.todo('GET /api/dashboard/refusals returns the window and the log for an account scope');
  it.todo('GET /api/dashboard/refusals returns the window and the log for a location scope');

  // --- Tenant boundary (invariant #8) ---
  it.todo("GET /api/dashboard/refusals rejects a request for a location outside the caller's account");
  it.todo('GET /api/dashboard/refusals exercises the impersonation path without mocking requireRole');

  // --- Redaction, once per sink (ADR 0023) ---
  it.todo('GET /api/dashboard/refusals omits all_refusal_codes from the body at any depth');
  it.todo('GET /api/dashboard/refusals omits all_refusal_codes and moderation prose from the error arm');
  it.todo('GET /api/dashboard/refusals omits all_refusal_codes and moderation prose from its logs');

  // --- The one server-read flag the payload carries (invariant #13) ---
  it.todo('GET /api/dashboard/refusals reports autoApprovalEnabled as a payload boolean');

  // --- Subscription guard (invariant #11) ---
  it.todo('GET /api/dashboard/refusals serves an owner whose subscription is past_due');
});
