// POST /api/operator/turns — composition root. Parse, call one module
// function, map the result. Invariant #1: this file never imports the LLM
// seam, the cost guard or the worker queue registry.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createTurn } from '@/lib/agents/operator/turns';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { requireOperatorWriter } from '@/app/api/operator/gate';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

const CreateTurnSchema = z.object({
  conversationId: z.uuid(),
  clientTurnKey: z.uuid(),
  locationId: z.uuid(),
  // NO `.trim()` transform, deliberately. `text` is stored VERBATIM as
  // `owner_text` and is one third of the idempotency payload comparison, so a
  // transform here would make two genuinely different messages compare equal:
  // a re-POST differing only in trailing whitespace would silently return the
  // first turn's ids instead of the 409 the constraint owes the caller. The
  // blank check is a refinement over the raw value, which rejects a
  // whitespace-only message without rewriting a legitimate one.
  text: z.string().min(1).max(4000).refine(
    (value) => value.trim().length > 0,
    'text must not be blank',
  ),
}).strict();

async function postTurn(request: NextRequest): Promise<NextResponse> {
  const gate = await requireOperatorWriter(sql, request);
  if (!gate.ok) return gate.response;
  const { owner } = gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_body', 400);
  }

  const parsed = CreateTurnSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: parsed.error.issues[0]?.message ?? 'invalid_body' }, 400);
  }

  try {
    const result = await createTurn(sql, {
      accountId: owner.accountId,
      actorUserId: owner.user.id,
      conversationId: parsed.data.conversationId,
      clientTurnKey: parsed.data.clientTurnKey,
      locationId: parsed.data.locationId,
      text: parsed.data.text,
    });

    switch (result.kind) {
      case 'created':
      case 'existing':
        return jsonResponse({ conversationId: result.conversationId, turnId: result.turnId });
      case 'turn_key_conflict':
        return errorResponse('turn_key_conflict', 409);
      case 'location_not_found':
        return errorResponse('location_not_found', 404);
      case 'conversation_not_found':
        return errorResponse('conversation_not_found', 404);
      default: {
        // Exhaustiveness guard: a new CreateTurnResult kind fails typecheck
        // here instead of falling out of the switch with no return.
        const _never: never = result;
        return errorResponse('turn_create_failed', 500);
      }
    }
  } catch (error) {
    // Ids only — never parsed.data.text (invariant 11).
    reportCaughtError('api/operator/turns POST', error, {
      conversationId: parsed.data.conversationId,
    });
    return errorResponse('turn_create_failed', 500);
  }
}

export const POST = withSameOrigin()(postTurn);
