import { NextResponse } from 'next/server';
import type { z } from 'zod';

/**
 * The single stable 400 response for a failed `schema.safeParse(body)`
 * across every JSON API route (#1373). Deliberately carries NO Zod issue
 * data — no `issues` array, no `.flatten()` details, no field paths or
 * messages — because any of those echoes the route's internal Zod schema
 * shape (field names, enum members, refinement text) back to an
 * unauthenticated or otherwise untrusted caller. `error: 'invalid_body'` is
 * the one machine code every caller needs; every client of these routes
 * already maps it to its own curated copy (verified before migration — no
 * frontend reads `issues`/`details` off any of the 17 routes this replaced).
 *
 * `error` is accepted — like `redactPhiForLog` (`src/lib/security/phi-scanner.ts`)
 * — so the call site reads naturally as `invalidBodyResponse(parsed.error)`
 * (the `schema.safeParse` failure branch already has it in hand) and so the
 * signature does not need to change if a later PR adds safe, aggregate-only
 * telemetry (e.g. a server-only issue count) in one place. It is not
 * serialized into the response today.
 *
 * `init.headers` defaults to none, preserving each call site's own caching
 * behavior rather than choosing one for all of them: most owner/account
 * routes pass `NO_STORE_HEADERS`, a handful of public auth routes
 * historically set no headers at all on this response.
 */
export function invalidBodyResponse(
  _error: z.ZodError,
  init?: { headers?: HeadersInit },
): NextResponse {
  return NextResponse.json(
    { error: 'invalid_body' },
    init?.headers ? { status: 400, headers: init.headers } : { status: 400 },
  );
}
