// src/app/api/dashboard/past-replies/_shared/edit-reply-request.ts
//
// Shared request preamble for the Edit-Replies mutation routes. Every route
// repeated the same opening chain inline; this centralizes the two reusable
// pieces:
//
//   authorizeEditReplyResponse  — the location-scoped review lookup + tier gate
//     (a tenant-isolation boundary: a response_id from another location must
//     surface as 404, never a cross-tenant read). Shared by retry,
//     restore-original, publish, and draft PATCH.
//
//   resolveEditReplyContext     — the full preamble for the `[responseId]` param
//     POST routes (retry, restore-original): feature gate → inline same-origin →
//     owner scope → responseId validation → authorize → audit context. Preserves
//     the exact inline ordering the routes had, so a cross-origin request with
//     bad auth still 403s (same-origin) before owner scope runs.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import { assertCanEditReply } from '@/lib/responses/edit-existing';
import { editRepliesEnabled } from '@/lib/past-replies/flags';
import { mapEditReplyError } from './edit-reply-errors';
import type { SessionAuditContext } from '@/lib/approval/audit';

export type EditReplyGuard<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse };

/** Route context shape for the `[responseId]` dynamic-segment handlers. */
export interface ResponseIdRouteContext {
  params: Promise<{ responseId: string }>;
}

export interface EditReplyContext {
  accountId: string;
  locationId: string;
  userId: string;
  responseId: string;
  reviewId: string;
  audit: SessionAuditContext;
}

/**
 * Feature gate + owner scope shared by the wrapper-CSRF edit-reply routes
 * (/draft POST, /publish): the PAST_REPLIES_VIEW + EDIT_REPLIES flags must both
 * be on, then resolveOwnerScope yields the owner's account/location/user. Used
 * by routes wrapped with withSameOrigin() (so same-origin runs in the wrapper,
 * not inline). Returns the inline 503/scope-error response on failure.
 */
export async function resolveEditReplyScope(
  request: NextRequest,
): Promise<EditReplyGuard<{ accountId: string; locationId: string; userId: string }>> {
  if (!editRepliesEnabled()) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'feature_disabled' }, { status: 503 }),
    };
  }

  try {
    const { accountId, locationId, userId } = await resolveOwnerScope(sql, request);
    return { ok: true, value: { accountId, locationId, userId } };
  } catch (err) {
    if (err instanceof ScopeError) {
      return {
        ok: false,
        response: NextResponse.json({ error: err.message }, { status: err.statusCode }),
      };
    }
    throw err;
  }
}

/**
 * Resolves the review_id for `responseId` scoped to `locationId`, then runs the
 * tier/ownership gate. A response from another location surfaces as 404
 * `response_not_found` (never a cross-tenant read); a tier/ownership failure is
 * mapped to its HTTP response. The non-locking SELECT runs outside any
 * transaction so `assertCanEditReply` (which queries on its own connection)
 * does not run inside a lock.
 */
export async function authorizeEditReplyResponse(
  responseId: string,
  scope: { accountId: string; locationId: string },
): Promise<EditReplyGuard<{ reviewId: string }>> {
  const responseRows = await sql<{ review_id: string }[]>`
    SELECT review_id FROM responses
    WHERE id = ${responseId} AND business_id = ${scope.locationId}
    LIMIT 1
  `;
  const responseRow = responseRows[0];
  if (!responseRow) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'response_not_found' }, { status: 404 }),
    };
  }

  try {
    await assertCanEditReply(responseRow.review_id, scope);
  } catch (err) {
    const mapped = mapEditReplyError(err);
    if (mapped) return { ok: false, response: mapped };
    throw err;
  }

  return { ok: true, value: { reviewId: responseRow.review_id } };
}

/**
 * Full preamble for the `[responseId]` param POST routes (/retry,
 * /restore-original). Returns the inline Response on any gate failure, or the
 * resolved owner scope + reviewId + session audit context on success.
 */
export async function resolveEditReplyContext(
  request: NextRequest,
  paramsPromise: Promise<{ responseId: string }>,
): Promise<EditReplyGuard<EditReplyContext>> {
  if (!editRepliesEnabled()) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'feature_disabled' }, { status: 503 }),
    };
  }

  try {
    assertSameOrigin(request);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
    }
    throw err;
  }

  let accountId: string, locationId: string, userId: string;
  try {
    ({ accountId, locationId, userId } = await resolveOwnerScope(sql, request));
  } catch (err) {
    if (err instanceof ScopeError) {
      return {
        ok: false,
        response: NextResponse.json({ error: err.message }, { status: err.statusCode }),
      };
    }
    throw err;
  }

  const { responseId } = await paramsPromise;
  if (!responseId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid_response_id' }, { status: 400 }),
    };
  }

  const authorized = await authorizeEditReplyResponse(responseId, { accountId, locationId });
  if (!authorized.ok) return authorized;

  const ip = request.headers.get('x-forwarded-for') ?? null;
  const audit: SessionAuditContext = { actorUserId: userId, ipAddress: ip };

  return {
    ok: true,
    value: {
      accountId,
      locationId,
      userId,
      responseId,
      reviewId: authorized.value.reviewId,
      audit,
    },
  };
}
