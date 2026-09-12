// GET /api/operator/conversation — composition root. Parse, call one module
// function, map the result. Invariant #1: this file never imports the LLM
// seam, the cost guard or the worker queue registry. Invariant #15: it imports
// the `sql` singleton and passes it down; the module never does.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import {
  getConversationForOwner,
  type OwnerConversationView,
} from '@/lib/agents/operator/reads';
import { errorResponse, jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag first, before auth and before any read: off means the surface does
  // not exist.
  if (!ownerOperatorEnabled()) return errorResponse('operator_disabled', 404);

  // A READ gate, not the writable-owner gate the POST uses.
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  // No `?id` means "the actor's most recent conversation for this account",
  // which the module resolves against idx_agent_conversations_account_recent.
  // A malformed id is the same 404 a foreign one gets.
  const rawId = request.nextUrl.searchParams.get('id');
  if (rawId !== null && !z.uuid().safeParse(rawId).success) {
    return errorResponse('conversation_not_found', 404);
  }

  try {
    // `summary` is null on a conversation with no turns yet — see
    // `OwnerConversationView`; the panel has no location to scope its reads to
    // and says so rather than reporting zeros.
    const view: OwnerConversationView | null = await getConversationForOwner(sql, {
      accountId: owner.accountId,
      actorUserId: owner.user.id,
      conversationId: rawId ?? undefined,
    });
    if (!view) return errorResponse('conversation_not_found', 404);
    return jsonResponse(view);
  } catch (error) {
    // Ids only — never owner text or a rendered segment (invariant 11).
    reportCaughtError('api/operator/conversation GET', error, { conversationId: rawId });
    return errorResponse('conversation_read_failed', 500);
  }
}
