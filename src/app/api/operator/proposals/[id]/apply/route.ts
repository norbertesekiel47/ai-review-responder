// POST /api/operator/proposals/:id/apply — composition root. Parse, call one
// module function, map the result. Invariant #1: this file never imports the
// LLM seam, the cost guard or the worker queue registry. Invariant #15: it
// imports the `sql` singleton and passes it down; the module never does.
//
// Gate ORDER matters and is shared with the other two Operator writes —
// `requireOperatorWriter` (`src/app/api/operator/gate.ts`) owns it:
//   withSameOrigin (the wrapper, outside the handler)
//     → requireOperatorProposalWriter (flag → writable owner → impersonation
//       → the proposal id, or 404)
//     → body parse
//     → one module call
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { applyProposal } from '@/lib/agents/operator/apply';
import { VoiceVersionTokenSchema } from '@/lib/agents/operator/version-token';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { requireOperatorProposalWriter } from '@/app/api/operator/gate';

export const dynamic = 'force-dynamic';

/**
 * `.strict()` and no `confirmationLevel`. Spec §5.1 lists an optional
 * `confirmationLevel` for the auto-approval expansion cards — those operations
 * are slice 2 and are not registered in the catalog, so accepting the field now
 * would mean silently ignoring a confirmation the caller believes was checked.
 * A 400 is the honest answer until an operation exists that reads it.
 */
const ApplyBodySchema = z.object({
  expectedVersionToken: VoiceVersionTokenSchema,
}).strict();

async function postApply(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const gate = await requireOperatorProposalWriter(sql, request, context);
  if (!gate.ok) return gate.response;
  const { owner, proposalId: id } = gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_body', 400);
  }
  const parsed = ApplyBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: parsed.error.issues[0]?.message ?? 'invalid_body' }, 400);
  }

  try {
    const result = await applyProposal(sql, {
      proposalId: id,
      accountId: owner.accountId,
      actorUserId: owner.user.id,
      expectedVersionToken: parsed.data.expectedVersionToken,
    });

    // Every non-404 body carries `proposal`, so the card re-renders from the
    // row the server actually stored rather than from the browser's reading of
    // a status code.
    switch (result.kind) {
      case 'applied':
        return jsonResponse({ proposal: result.proposal });
      case 'stale':
        return jsonResponse({ error: 'proposal_stale', proposal: result.proposal }, 409);
      case 'rejected':
        return jsonResponse({ error: result.reason, proposal: result.proposal }, 409);
      case 'not_pending':
        return jsonResponse({ error: 'proposal_not_pending', proposal: result.proposal }, 409);
      case 'failed':
        // The executor refused DETERMINISTICALLY and the refusal committed
        // (D12). 500 rather than 409: nothing the owner can change makes this
        // succeed, and the stored row says `write_failed`.
        return jsonResponse({ error: 'apply_failed', proposal: result.proposal }, 500);
      case 'not_found':
        return errorResponse('proposal_not_found', 404);
      default: {
        // Exhaustiveness guard: a new ApplyResult kind fails typecheck here
        // instead of falling out of the switch with no return.
        const _never: never = result;
        return errorResponse('apply_failed', 500);
      }
    }
  } catch (error) {
    // Ids only — never the Receipt, the owner text or the proposal body
    // (invariant 11). A THROWN executor lands here: the transaction already
    // rolled back and the proposal is still pending (D12).
    reportCaughtError('api/operator/proposals/[id]/apply POST', error, { proposalId: id });
    return errorResponse('apply_failed', 500);
  }
}

export const POST = withSameOrigin()(postApply);
