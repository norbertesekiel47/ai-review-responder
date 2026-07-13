// POST /api/approve/[token]/veto — owner cancel of a scheduled auto-post
// (WS4 spec §2.6). Thin composition root cloned from the approve sibling:
// same wrapper machinery (rate limit, CSRF, device binding, lockValidLink +
// verifyDevice, one tx, audit context, standard token-error mapping), but the
// action is vetoAutoPost — NOT lockPendingResponse — because a veto targets an
// APPROVED response (see the header of src/lib/approval/veto.ts).
//
// Outcome mapping: 'cancelled' and 'already_cancelled' both commit and return
// 200 (idempotent-success posture — a double-tap is not an error); 'too_late'
// throws VetoTooLateError so the tx rolls back and maps to a truthful 409.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { VetoTooLateError } from '@/lib/approval/errors';
import { vetoAutoPost, type VetoAutoPostResult } from '@/lib/approval/veto';

export const dynamic = 'force-dynamic';

type TokenRouteContext = {
  params: Promise<{ token: string }>;
};

async function vetoHandler(
  request: NextRequest,
  { params }: TokenRouteContext,
): Promise<NextResponse> {
  const { token } = await params;

  // Decided inside the tx; read by the success-body thunk after commit.
  let result: Exclude<VetoAutoPostResult, 'too_late'> = 'cancelled';

  return runTokenApprovalAction(
    sql,
    request,
    token,
    'veto',
    () => ({ result }),
    async ({ tx, link, audit, correlationId }) => {
      const outcome = await vetoAutoPost(tx, link, audit, correlationId);
      if (outcome === 'too_late') {
        throw new VetoTooLateError();
      }
      result = outcome;
    },
  );
}

export const POST = withSameOrigin()(vetoHandler);
