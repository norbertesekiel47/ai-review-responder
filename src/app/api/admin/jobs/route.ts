import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getServerConfig } from '@/lib/config/server';
import { getWorkerPublicUrl } from '@/lib/shared/worker-public-url';

export const dynamic = 'force-dynamic';

// Vercel = UI only (invariant #1): per-queue depth lives on the Railway worker,
// which owns the BullMQ/Railway-Redis connection (Vercel can't reach the private
// IPv6-only network). This route fetches the worker's authed internal endpoint
// server-side with a short, explicit timeout and NO retry — an admin read that
// degrades to {unavailable:true} on any failure rather than blocking the panel.
const QUEUE_HEALTH_TIMEOUT_MS = 5_000;

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

// Local mirror of the worker's PoolWait shape (invariant #1: Vercel cannot
// import worker code). Kept in lockstep with the canonical owner
// src/lib/shared/pool-wait.ts (which queue-health.ts type-imports).
type PoolWaitPayload = { waitMs: number; timedOut: boolean; saturating: boolean; max: number };

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
  pool: PoolWaitPayload | null;
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

    const { queueHealth, pool } = await fetchQueueHealth();

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
      pool,
    };

    return NextResponse.json(data);
  } catch (error) {
    reportCaughtError('api/admin/jobs', error);
    return NextResponse.json({ error: 'Failed to fetch job data' }, { status: 500 });
  }
}

interface QueueHealthResult {
  queueHealth: Record<string, Record<string, number>> | { unavailable: true };
  pool: PoolWaitPayload | null;
}

/**
 * Fetch per-queue depth (+ the worker's best-effort shared-pool wait) from the
 * Railway worker's authed internal endpoint. `queueHealth` degrades to the
 * existing graceful shape `{ unavailable: true }` and `pool` to `null` on ANY
 * failure — missing config (WORKER_PUBLIC_URL / WORKER_INTERNAL_SECRET), invalid
 * worker URL, non-200, network error, or the 5s timeout — logging a warning
 * instead of throwing, so the panel always renders. Never logs the secret. The
 * worker may itself return `pool:null` (probe unavailable) even on a 200; that
 * passes through unchanged.
 */
async function fetchQueueHealth(): Promise<QueueHealthResult> {
  const unavailable: QueueHealthResult = { queueHealth: { unavailable: true }, pool: null };

  const secret = getServerConfig().WORKER_INTERNAL_SECRET;
  if (!secret) return unavailable;

  let origin: string;
  try {
    origin = getWorkerPublicUrl();
  } catch {
    // WORKER_PUBLIC_URL unset or not a valid URL — degrade silently.
    return unavailable;
  }

  try {
    const response = await fetch(`${origin}/internal/queue-health`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(QUEUE_HEALTH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) {
      console.warn(`[api/admin/jobs] worker queue-health returned ${response.status}; queue health unavailable`);
      return unavailable;
    }
    const body = (await response.json()) as {
      queues?: Record<string, Record<string, number>>;
      pool?: PoolWaitPayload | null;
    };
    if (!body.queues) {
      console.warn('[api/admin/jobs] worker queue-health response missing queues; queue health unavailable');
      return unavailable;
    }
    return { queueHealth: body.queues, pool: body.pool ?? null };
  } catch (error) {
    console.warn('[api/admin/jobs] worker queue-health fetch failed; queue health unavailable:', error);
    return unavailable;
  }
}
