import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRestoreProposal, type RestoreResult } from '@/lib/agents/operator/restore';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { requireOperatorProposalWriter } from '@/app/api/operator/gate';

export const dynamic = 'force-dynamic';
const RestoreBodySchema = z.strictObject({});

async function postRestore(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const gate = await requireOperatorProposalWriter(sql, request, context);
  if (!gate.ok) return gate.response;
  let body: unknown;
  try { body = await request.json(); } catch { return errorResponse('invalid_body', 400); }
  if (!RestoreBodySchema.safeParse(body).success) return errorResponse('invalid_body', 400);

  try {
    const result = await createRestoreProposal(sql, {
      accountId: gate.owner.accountId,
      actorUserId: gate.owner.user.id,
      sourceProposalId: gate.proposalId,
    });
    return restoreResultResponse(result);
  } catch (error) {
    reportCaughtError('api/operator/proposals/[id]/restore POST', error, { proposalId: gate.proposalId });
    return errorResponse('restore_failed', 500);
  }
}

function restoreResultResponse(result: RestoreResult): NextResponse {
  switch (result.kind) {
    case 'prepared': return jsonResponse({ proposal: result.proposal, repeated: result.repeated });
    case 'not_found': return errorResponse('proposal_not_found', 404);
    case 'not_applied': return errorResponse('restore_not_applied', 409);
    case 'invalid_source': return errorResponse('restore_invalid_source', 409);
    case 'unauthorized': return errorResponse('unauthorized', 403);
    case 'location_not_found': return errorResponse('location_not_found', 404);
    case 'no_history': return errorResponse('restore_no_history', 409);
    default: {
      const _never: never = result;
      return errorResponse('restore_failed', 500);
    }
  }
}

export const POST = withSameOrigin()(postRestore);
