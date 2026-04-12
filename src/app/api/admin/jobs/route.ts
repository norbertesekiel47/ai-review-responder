import { NextRequest, NextResponse } from 'next/server';
import { Queue } from 'bullmq';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { getRedisOptions, QUEUE_NAMES } from '../../../../../worker/queues';

export const dynamic = 'force-dynamic';

interface OutboxSummaryRow {
  pending: number;
  dispatched: number;
  failed: number;
  completed_today: number;
}

interface FailedJobRow {
  id: string;
  topic: string;
  last_error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
}

interface FailedCountRow {
  total: number;
}

export interface JobsData {
  outbox: {
    pending: number;
    dispatched: number;
    failed: number;
    completedToday: number;
  };
  failedJobs: {
    id: string;
    topic: string;
    lastError: string | null;
    attempts: number;
    maxAttempts: number;
    createdAt: string;
  }[];
  failedTotal: number;
  limit: number;
  offset: number;
  queueHealth: Record<string, Record<string, number>> | { unavailable: true };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rawLimit = request.nextUrl.searchParams.get('limit');
    const rawOffset = request.nextUrl.searchParams.get('offset');
    const limit = Math.min(Math.max(parseInt(rawLimit ?? '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(rawOffset ?? '0', 10) || 0, 0);

    const [summaryRows, failedRows, countRows] = await Promise.all([
      sql<OutboxSummaryRow[]>`
        SELECT
          COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending,
          COUNT(CASE WHEN status = 'dispatched' THEN 1 END)::int AS dispatched,
          COUNT(CASE WHEN status = 'failed' THEN 1 END)::int AS failed,
          COUNT(CASE WHEN status = 'completed' AND completed_at >= CURRENT_DATE THEN 1 END)::int AS completed_today
        FROM job_outbox
      `,
      sql<FailedJobRow[]>`
        SELECT id, topic, last_error, attempts, max_attempts, created_at
        FROM job_outbox
        WHERE status = 'failed'
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql<FailedCountRow[]>`
        SELECT COUNT(*)::int AS total FROM job_outbox WHERE status = 'failed'
      `,
    ]);

    const summary = summaryRows[0] ?? { pending: 0, dispatched: 0, failed: 0, completed_today: 0 };
    const failedTotal = countRows[0]?.total ?? 0;

    let queueHealth: Record<string, Record<string, number>> | { unavailable: true };
    try {
      const redisOpts = getRedisOptions();
      const queueNames = Object.values(QUEUE_NAMES);
      const counts: Record<string, Record<string, number>> = {};
      for (const name of queueNames) {
        const queue = new Queue(name, { connection: redisOpts });
        const jobCounts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        counts[name] = jobCounts;
        await queue.close();
      }
      queueHealth = counts;
    } catch (redisError) {
      console.warn('[api/admin/jobs] Redis unavailable for queue health:', redisError);
      queueHealth = { unavailable: true };
    }

    const data: JobsData = {
      outbox: {
        pending: summary.pending,
        dispatched: summary.dispatched,
        failed: summary.failed,
        completedToday: summary.completed_today,
      },
      failedJobs: failedRows.map((row) => ({
        id: row.id,
        topic: row.topic,
        lastError: row.last_error,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        createdAt: row.created_at,
      })),
      failedTotal,
      limit,
      offset,
      queueHealth,
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error('[api/admin/jobs] Failed to fetch job data:', error);
    return NextResponse.json({ error: 'Failed to fetch job data' }, { status: 500 });
  }
}
