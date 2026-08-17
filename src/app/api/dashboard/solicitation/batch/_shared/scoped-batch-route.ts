// src/app/api/dashboard/solicitation/batch/_shared/scoped-batch-route.ts
//
// The write preamble shared by the three POST routes under
// `/api/dashboard/solicitation/batch` — `approve` + `halt` (#629) and
// `reviewed` (#544). All three run the identical chain: flag gate → writable-
// owner auth → location scope → body parse → handler → uniform 500 mapping.
// Batch-shaped sibling of `withScopedContact`
// (`src/app/api/dashboard/contacts/location-scope.ts`), which owns the same
// policy for the `contacts/[id]` routes.
//
// Four things the code depends on and a reader should not have to rediscover:
//
//  1. `requireWriteAccess` is a bound function per route, NOT a boolean, because
//     the three routes do NOT share a gate. `approve`/`halt` bind
//     `requireSolicitationSendWriteAccess` (BOTH `SOLICITATION_WATCH_ENABLED`
//     and `SOLICITATION_SEND_ENABLED`); `reviewed` binds
//     `requireContactsWriteAccess` (watch only). Collapsing them onto one gate
//     would make the watch-mode Spoilage-report ping require the send flag —
//     and the send flag is unset in every environment today, so `reviewed`
//     would 404 for every existing customer. Config is 3 fields plus the body
//     reader; a fourth flag-shaped field means the seam is wrong.
//  2. The gate runs OUTSIDE the catch, so an auth-infrastructure failure keeps
//     `requireWritableOwner`'s rethrow contract instead of being flattened into
//     this route's 500 copy.
//  3. Location resolution is not optional: these bodies carry only a batch id,
//     so without it a three-key UPDATE has no proven `business_id`. Callers must
//     send `?scope=` — `resolveDashboardRequest` otherwise falls back to the
//     owner's default location and the write silently matches zero rows.
//  4. `withSameOrigin()` is deliberately NOT applied here: it is the outermost
//     wrapper on each exported handler, so a cross-origin POST is refused before
//     this preamble runs at all.

import type { NextRequest, NextResponse } from 'next/server';
import type { Sql } from 'postgres';
import { errorResponse, type WritableOwnerResult } from '@/lib/auth/route-helpers';
import { isValidUuid } from '@/lib/shared/ids';
import { createWorkerLogger, type WorkerLogger } from '@/lib/shared/logger';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { requireContactsLocationScope } from '@/app/api/dashboard/contacts/location-scope';

/** The request's JSON body as a plain object, or null when it is absent,
 *  unparseable, or not an object. The body may only be read once, so a route
 *  that needs more than the batch id starts here rather than calling
 *  `readBatchId` and then reaching for the stream again. */
export async function readJsonObject(
  request: NextRequest,
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  return body as Record<string, unknown>;
}

/** The `batchId`, or null when the body is absent, malformed, or not a UUID.
 *  The two routes that use this read NOTHING else: `halt`'s reason is derived
 *  server-side by `ownerHaltReason`, and `reviewed` records only that a human
 *  looked. */
export async function readBatchId(request: NextRequest): Promise<string | null> {
  const body = await readJsonObject(request);
  if (body === null) return null;
  const batchId = body.batchId;
  return typeof batchId === 'string' && isValidUuid(batchId) ? batchId : null;
}

/** Everything a batch mutation is allowed to act on, and nothing a caller could
 *  choose: the account and actor come from the authenticated owner scope, the
 *  location from the resolved scope policy, and `input` from this route's own
 *  validated body. */
export interface ScopedBatchContext<TInput> {
  accountId: string;
  locationId: string;
  actorUserId: string;
  input: TInput;
  logger: WorkerLogger;
}

export interface ScopedBatchRouteOptions<TInput> {
  /** Logger prefix AND the Sentry tag anything thrown is reported against. */
  endpoint: string;
  /** The 500 copy — the other thing that legitimately differs per route. */
  failureMessage: string;
  /** This route's flag gate + owner auth. See note 1 in the header. */
  requireWriteAccess: (sql: Sql, request: NextRequest) => Promise<WritableOwnerResult>;
  /** This route's body validator. `null` maps onto the same uniform 404 an
   *  unknown batch gets, so a malformed body reveals nothing. */
  readInput: (request: NextRequest) => Promise<TInput | null>;
}

export function withScopedBatch<TInput>(
  sql: Sql,
  options: ScopedBatchRouteOptions<TInput>,
  handler: (scoped: ScopedBatchContext<TInput>) => Promise<NextResponse>,
): (request: NextRequest) => Promise<NextResponse> {
  const logger = createWorkerLogger(options.endpoint);

  return async (request) => {
    const owner = await options.requireWriteAccess(sql, request);
    if (!owner.ok) return owner.response;
    const { user, accountId } = owner;

    try {
      const location = await requireContactsLocationScope(sql, request, {
        accountId,
        userLocationId: user.locationId,
      });
      if (!location.ok) return location.response;

      const input = await options.readInput(request);
      if (input === null) return errorResponse('Not found', 404);

      return await handler({
        accountId,
        locationId: location.locationId,
        actorUserId: user.id,
        input,
        logger,
      });
    } catch (error) {
      reportCaughtError(options.endpoint, error, { accountId });
      return errorResponse(options.failureMessage, 500);
    }
  };
}
