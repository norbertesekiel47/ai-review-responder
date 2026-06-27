import { NextRequest, NextResponse } from 'next/server';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- invariant #1 carve-out: admin-only queue-health READ. Instantiates a BullMQ Queue solely to call getJobCounts(), then closes it in a finally — not a publish path. TODO: file a follow-up issue to relocate queue-health to the Railway worker (also fixes the likely-broken Vercel→Railway-Redis call) and drop this disable.
import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { ALL_QUEUE_NAMES } from '@/lib/shared/queue-names';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getServerConfig } from '@/lib/config/server';

// Queue names come from the shared registry (src/lib/shared/queue-names.ts)
// so this list cannot drift behind worker/queues.ts. Importing worker/queues.ts
// directly is unsafe from a Next.js route because it instantiates BullMQ
// Queues at module scope and would crash if REDIS_QUEUE_URL is missing.
const QUEUE_NAMES = ALL_QUEUE_NAMES;

export const dynamic = 'force-dynamic';

interface OutboxSummaryRow {
  pending: number;
  // `dispatching` is the intermediate two-phase-claim state OutboxPoller
  // transitions rows through (pending → dispatching → dispatched). Stale
  // dispatching rows (>2 min) are recovered by the poller's watchdog, but
  // before 20e they were invisible in this summary, which hid stuck claims.
  dispatching: number;
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

interface JobsData {
  outbox: {
    pending: number;
    dispatching: number;
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
  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const rawLimit = request.nextUrl.searchParams.get('limit');
    const rawOffset = request.nextUrl.searchParams.get('offset');
    const limit = Math.min(Math.max(parseInt(rawLimit ?? '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(rawOffset ?? '0', 10) || 0, 0);

    const [summaryRows, failedRows, countRows] = await Promise.all([
      sql<OutboxSummaryRow[]>`
        SELECT
          COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending,
          COUNT(CASE WHEN status = 'dispatching' THEN 1 END)::int AS dispatching,
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

    const summary = summaryRows[0] ?? { pending: 0, dispatching: 0, dispatched: 0, failed: 0, completed_today: 0 };
    const failedTotal = countRows[0]?.total ?? 0;

    let queueHealth: Record<string, Record<string, number>> | { unavailable: true };
    const redisUrl = getServerConfig().REDIS_QUEUE_URL;
    if (!redisUrl) {
      queueHealth = { unavailable: true };
    } else {
      try {
        const redisOpts = parseRedisUrl(redisUrl);
        const counts: Record<string, Record<string, number>> = {};
        for (const name of QUEUE_NAMES) {
          const queue = new Queue(name, { connection: redisOpts });
          try {
            const jobCounts = await queue.getJobCounts(
              'waiting',
              'active',
              'delayed',
              'failed',
              'completed',
              'paused',
            );
            counts[name] = jobCounts;
          } finally {
            await queue.close();
          }
        }
        queueHealth = counts;
      } catch (redisError) {
        console.warn('[api/admin/jobs] Redis unavailable for queue health:', redisError);
        queueHealth = { unavailable: true };
      }
    }

    const data: JobsData = {
      outbox: {
        pending: summary.pending,
        dispatching: summary.dispatching,
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
    reportCaughtError('api/admin/jobs', error);
    return NextResponse.json({ error: 'Failed to fetch job data' }, { status: 500 });
  }
}

/** Parse a Redis URL into ioredis options with a short connect timeout. */
function parseRedisUrl(url: string): RedisOptions {
  const cfg = getServerConfig();
  if (url.startsWith('https://')) {
    return {
      host: new URL(url).hostname,
      port: 6379,
      password: cfg.REDIS_QUEUE_TOKEN,
      tls: {},
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
    };
  }
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || cfg.REDIS_QUEUE_TOKEN || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  };
}
