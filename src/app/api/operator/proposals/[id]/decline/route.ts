// POST /api/operator/proposals/:id/decline — composition root. Same gates and
// the same order as the apply route; "Not now" is a write, so it earns the
// same same-origin, writable-owner and impersonation refusals.
//
// NO BODY. A Decline records the actor and nothing else (plan decision D5), so
// there is nothing to parse and nothing a caller could send that this route
// would honour.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { declineProposal } from '@/lib/agents/operator/proposals';
import { hasImpersonationCookie } from '@/lib/admin/impersonation/cookie';
import { errorResponse, jsonResponse, requireWritableOwner, withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

async function postDecline(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!ownerOperatorEnabled()) return errorResponse('operator_disabled', 404);

  const owner = await requireWritableOwner(sql, request);
  if (!owner.ok) return owner.response;

  if (hasImpersonationCookie(request)) {
    return errorResponse('impersonation_not_allowed', 409);
  }

  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return errorResponse('proposal_not_found', 404);

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
