import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { listAppliedProposals } from '@/lib/agents/operator/proposals';
import { errorResponse, jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

// Validate PostgreSQL ::text and ISO timestamps without round-tripping through
// Date, which would discard the microseconds needed for stable pagination.
const CursorTimestampSchema = z.string().max(64).refine((value) =>
  z.iso.datetime({ offset: true }).safeParse(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).success);
const TimelineQuerySchema = z.strictObject({
  locationId: z.uuid().optional(),
  cursorAppliedAt: CursorTimestampSchema.optional(),
  cursorId: z.uuid().optional(),
  limit: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
}).refine((value) => (value.cursorAppliedAt === undefined) === (value.cursorId === undefined));

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!ownerOperatorEnabled()) return errorResponse('operator_disabled', 404);
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  const params = request.nextUrl.searchParams;
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return errorResponse('invalid_query', 400);
  const parsed = TimelineQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return errorResponse('invalid_query', 400);
  const { locationId, cursorAppliedAt, cursorId, limit } = parsed.data;
  try {
    const page = await listAppliedProposals(sql, {
      accountId: owner.accountId,
      ...(locationId === undefined ? {} : { locationId }),
      ...(cursorAppliedAt === undefined || cursorId === undefined ? {} : { cursor: { appliedAt: cursorAppliedAt, id: cursorId } }),
      ...(limit === undefined ? {} : { limit }),
    });
    return jsonResponse(page);
  } catch (error) {
    reportCaughtError('api/operator/rules-timeline GET', error, { accountId: owner.accountId });
    return errorResponse('rules_timeline_failed', 500);
  }
}
