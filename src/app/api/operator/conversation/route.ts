// GET /api/operator/conversation — composition root. Parse, call one module
// function, map the result. Invariant #1: this file never imports the LLM
// seam, the cost guard or the worker queue registry. Invariant #15: it imports
// the `sql` singleton and passes it down; the module never does.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getConversationForOwner,
  readSummaryEntitlement,
  type OwnerConversationResult,
} from '@/lib/agents/operator/reads';
import { errorResponse, jsonResponse } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { subscriptionAllowsDashboardRead } from '@/lib/shared/subscription-status';
import { requireOperatorReader } from '../gate';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOperatorReader(request);
  if (!owner.ok) return owner.response;

  // No `?id` means "the actor's most recent conversation for this account",
  // which the module resolves against idx_agent_conversations_account_recent.
  // A malformed id is the same 404 a foreign one gets.
  const rawId = request.nextUrl.searchParams.get('id');
  if (rawId !== null && !z.uuid().safeParse(rawId).success) {
    return errorResponse('conversation_not_found', 404);
  }

  // D2. Optional and ADDITIVE: the module uses it only when the conversation
  // has no turns yet. A malformed value is the same 404 a foreign one gets, for
  // the same reason `?id` is — the shape of the id tells the caller nothing.
  const rawLocationId = request.nextUrl.searchParams.get('locationId');
  if (rawLocationId !== null && !z.uuid().safeParse(rawLocationId).success) {
    return errorResponse('location_not_found', 404);
  }

  try {
    // `summary` is null on a conversation with no turns yet — see
    // `OwnerConversationView`; the panel has no location to scope its reads to
    // and says so rather than reporting zeros.
    const result: OwnerConversationResult = await getConversationForOwner(sql, {
      accountId: owner.accountId,
      actorUserId: owner.user.id,
      conversationId: rawId ?? undefined,
      locationId: rawLocationId ?? undefined,
    });
    // A first-time owner is NOT a 404 (RB-09): the module answers a view whose
    // `conversation` is null, which falls through to the 200 below with an
    // empty transcript and a scoped summary. Only a `?id=` that matched
    // nothing reaches `not_found`…
    if (result.kind === 'not_found') return errorResponse('conversation_not_found', 404);
    // …and a `?locationId=` that is not an active location of the account gets
    // its OWN code, in both branches, so the screen can say which thing went
    // wrong (S7). Same 404 status: neither shape tells the caller anything.
    if (result.kind === 'location_not_found') return errorResponse('location_not_found', 404);

    // The summary is customer KPI data, so it answers to the SAME entitlement
    // `/api/dashboard` enforces: an account `subscriptionAllowsDashboardRead`
    // refuses (`pending_payment`, `cancelled`) must not read live counts here
    // through a side door. The TRANSCRIPT stays readable — Run A's read-gate
    // decision stands, and the conversation is the owner's own words.
    if (result.view.summary !== null) {
      const status = await readSummaryEntitlement(sql, owner.accountId);
      if (status === null || !subscriptionAllowsDashboardRead(status)) {
        return jsonResponse({ ...result.view, summary: null });
      }
    }
    return jsonResponse(result.view);
  } catch (error) {
    // Ids only — never owner text or a rendered segment (invariant 11).
    reportCaughtError('api/operator/conversation GET', error, { conversationId: rawId });
    return errorResponse('conversation_read_failed', 500);
  }
}
