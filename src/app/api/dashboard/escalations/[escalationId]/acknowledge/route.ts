import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { runEscalationTransitionRoute } from '@/lib/escalations/http-routes';
import { acknowledgeEscalation } from '@/lib/escalations/transitions';
import { withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

async function acknowledge(
  request: NextRequest,
  { params }: { params: Promise<{ escalationId: string }> },
): Promise<NextResponse> {
  return runEscalationTransitionRoute(sql, request, params, acknowledgeEscalation, 'Escalation is already resolved');
}

export const POST = withSameOrigin()(acknowledge);
