import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { runEscalationTransitionRoute } from '@/lib/escalations/http-routes';
import { resolveEscalation } from '@/lib/escalations/transitions';
import { withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

async function resolve(
  request: NextRequest,
  { params }: { params: Promise<{ escalationId: string }> },
): Promise<NextResponse> {
  return runEscalationTransitionRoute(sql, request, params, resolveEscalation, 'Invalid escalation state');
}

export const POST = withSameOrigin()(resolve);
