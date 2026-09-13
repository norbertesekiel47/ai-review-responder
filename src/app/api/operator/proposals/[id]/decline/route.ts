// POST /api/operator/proposals/:id/decline — composition root. Same gates and
// the same order as the apply route; "Not now" is a write, so it earns the
// same same-origin, writable-owner and impersonation refusals.
//
// NO BODY. A Decline records the actor and nothing else (plan decision D5), so
// there is nothing to parse and nothing a caller could send that this route
// would honour.
import { NextRequest, NextResponse } from 'next/server';
import { declineProposal } from '@/lib/agents/operator/proposals';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { requireOperatorProposalWriter } from '@/app/api/operator/gate';

export const dynamic = 'force-dynamic';

async function postDecline(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const gate = await requireOperatorProposalWriter(sql, request, context);
  if (!gate.ok) return gate.response;
  const { owner, proposalId: id } = gate;

  try {
    const result = await declineProposal(sql, {
      proposalId: id,
      accountId: owner.accountId,
      actorUserId: owner.user.id,
    });

    switch (result.kind) {
      case 'rejected':
        // `repeated` is not surfaced: a second "Not now" produced the same row
        // and the owner has no decision to make about which call won.
        return jsonResponse({ proposal: result.proposal });
      case 'not_pending':
        return jsonResponse({ error: 'proposal_not_pending', proposal: result.proposal }, 409);
      case 'not_found':
        return errorResponse('proposal_not_found', 404);
      default: {
        const _never: never = result;
        return errorResponse('decline_failed', 500);
      }
    }
  } catch (error) {
    reportCaughtError('api/operator/proposals/[id]/decline POST', error, { proposalId: id });
    return errorResponse('decline_failed', 500);
  }
}

export const POST = withSameOrigin()(postDecline);
