// The single write gate for the Operator mutation routes. Not a route file —
// the precedent for a shared non-route module beside routes is
// `src/app/api/dashboard/policy.ts`.
//
// Invariant #1: no LLM seam, cost guard or worker queue registry here.
// Invariant #15: `sql` arrives as a parameter — this module never imports
// `@/lib/db/server`; the route composition roots pass the singleton down.
import { type NextRequest, type NextResponse } from 'next/server';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { hasImpersonationCookie } from '@/lib/admin/impersonation/cookie';
import {
  errorResponse,
  requireWritableOwner,
  type WritableOwnerResult,
} from '@/lib/auth/route-helpers';

/** The success half of `requireWritableOwner` — the owner user + their accountId. */
export type OperatorWriter = Extract<WritableOwnerResult, { ok: true }>;

export type OperatorWriterResult =
  | { ok: true; owner: OperatorWriter }
  | { ok: false; response: NextResponse };

/**
 * The cheap refusals every Operator write shares, in the one order that is
 * correct — `POST /api/operator/turns`, `…/proposals/:id/apply` and
 * `…/proposals/:id/decline` each ran a byte-identical copy before this module
 * existed:
 *
 *   withSameOrigin (the wrapper, outside the handler, still on each route)
 *     → flag          — off means the surface does not exist, so it answers
 *                       BEFORE auth and before any read
 *     → writable owner
 *     → impersonation — an admin may LOOK, never act: the same 409 token
 *                       `PATCH /api/settings/auto-approval` uses, and it runs
 *                       before any parse and before any write, because an
 *                       Operator write is the owner's own words recorded under
 *                       the owner's actor id
 *
 * It deliberately stops there. Id and body parsing differ per route and stay in
 * the handlers.
 *
 * These are the cheap refusals, not the authority: `applyProposal` revalidates
 * every check inside its transaction with the rows locked.
 */
export async function requireOperatorWriter(
  sql: Sql,
  request: NextRequest,
): Promise<OperatorWriterResult> {
  if (!ownerOperatorEnabled()) {
    return { ok: false, response: errorResponse('operator_disabled', 404) };
  }

  const owner = await requireWritableOwner(sql, request);
  if (!owner.ok) return { ok: false, response: owner.response };

  if (hasImpersonationCookie(request)) {
    return { ok: false, response: errorResponse('impersonation_not_allowed', 409) };
  }

  return { ok: true, owner };
}

export type OperatorProposalWriterResult =
  | { ok: true; owner: OperatorWriter; proposalId: string }
  | { ok: false; response: NextResponse };

/**
 * `requireOperatorWriter` plus the proposal-id resolution the two
 * `proposals/:id/*` routes share. A malformed id is a 404, not a 400: it is
 * the same answer another account's proposal gets, so the shape of the id
 * tells the caller nothing.
 *
 * Bodies are NOT parsed here — apply takes `{ expectedVersionToken }` and
 * decline takes none, so each handler still owns its own schema.
 */
export async function requireOperatorProposalWriter(
  sql: Sql,
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<OperatorProposalWriterResult> {
  const gate = await requireOperatorWriter(sql, request);
  if (!gate.ok) return gate;

  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) {
    return { ok: false, response: errorResponse('proposal_not_found', 404) };
  }

  return { ok: true, owner: gate.owner, proposalId: id };
}
