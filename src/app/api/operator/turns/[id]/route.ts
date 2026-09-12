// GET /api/operator/turns/:id — composition root. Parse, call one module
// function, map the result. Invariant #1: this file never imports the LLM
// seam, the cost guard or the worker queue registry. Invariant #15: it imports
// the `sql` singleton and passes it down; the module never does.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { getTurnForOwner, type OwnerTurnView } from '@/lib/agents/operator/reads';
import { errorResponse, jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Flag first, before auth and before any read: off means the surface does
  // not exist.
  if (!ownerOperatorEnabled()) return errorResponse('operator_disabled', 404);

  // A READ gate, not the writable-owner gate the POST uses: a past-due or
  // offboarding account may still read what it already said.
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  const { id } = await context.params;
  // A malformed id is a 404, not a 400: it is the same answer another
  // account's turn gets, so the shape of the id tells the caller nothing.
  if (!z.uuid().safeParse(id).success) return errorResponse('turn_not_found', 404);

  try {
    const turn: OwnerTurnView | null = await getTurnForOwner(sql, {
      turnId: id,
      accountId: owner.accountId,
    });
    if (!turn) return errorResponse('turn_not_found', 404);
    return jsonResponse({
      id: turn.id,
      status: turn.status,
      failureReason: turn.failureReason,
      segments: turn.segments,
      // Two kinds, two keys: a renderer can never grow Apply onto an
      // unsupported row by iterating one list.
      proposals: turn.proposals,
      unsupported: turn.unsupported,
    });
  } catch (error) {
    // Ids only — never owner text or a rendered segment (invariant 11).
    reportCaughtError('api/operator/turns/[id] GET', error, { turnId: id });
    return errorResponse('turn_read_failed', 500);
  }
}
