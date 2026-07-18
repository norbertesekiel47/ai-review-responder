import { describe, it, expect, vi } from 'vitest';
import {
  createQueueHealthHandler,
  isAuthorizedQueueHealthRequest,
  QUEUE_HEALTH_JOB_STATES,
  BACKLOG_ENDPOINT_TIMEOUT_MS,
} from '../queue-health';
import { ALL_QUEUE_NAMES } from '../../../src/lib/shared/queue-names';

const SECRET = 'a'.repeat(64);

function makeReq(headers: Record<string, string | undefined> = {}): any {
  return { headers };
}

function makeReply() {
  const captured: { status?: number; body?: unknown } = {};
  const reply = {
    code: (code: number) => {
      captured.status = code;
      return reply;
    },
    send: (body: unknown) => {
      captured.body = body;
      return reply;
    },
  } as unknown as import('fastify').FastifyReply;
  return { reply, captured };
}

describe('isAuthorizedQueueHealthRequest', () => {
  it('accepts a correct Bearer secret', () => {
    expect(isAuthorizedQueueHealthRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(isAuthorizedQueueHealthRequest(undefined, SECRET)).toBe(false);
  });

  it('rejects a non-Bearer scheme', () => {
    expect(isAuthorizedQueueHealthRequest(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedQueueHealthRequest(`Basic ${SECRET}`, SECRET)).toBe(false);
  });

  it('rejects a wrong secret of equal length', () => {
    expect(isAuthorizedQueueHealthRequest(`Bearer ${'b'.repeat(64)}`, SECRET)).toBe(false);
  });

  it('rejects a wrong secret of different length', () => {
    expect(isAuthorizedQueueHealthRequest('Bearer short', SECRET)).toBe(false);
  });
});

describe('createQueueHealthHandler', () => {
  const counts = { waiting: 1, active: 2, delayed: 0, failed: 0, completed: 5, paused: 0 };
  const backlog = { job_outbox: 7, analytics_events: 3 };

  it('returns 503 {disabled:true} when the secret is unset', async () => {
    const getQueueCounts = vi.fn().mockResolvedValue(counts);
    const getBacklogDepth = vi.fn().mockResolvedValue(backlog);
    const handler = createQueueHealthHandler({
      getSecret: () => undefined,
      getQueueCounts,
      getBacklogDepth,
    });
    const { reply, captured } = makeReply();

    await handler(makeReq({ authorization: `Bearer ${SECRET}` }), reply);

    expect(captured.status).toBe(503);
    expect(captured.body).toEqual({ disabled: true });
    expect(getQueueCounts).not.toHaveBeenCalled();
    expect(getBacklogDepth).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const getQueueCounts = vi.fn().mockResolvedValue(counts);
    const getBacklogDepth = vi.fn().mockResolvedValue(backlog);
    const handler = createQueueHealthHandler({
      getSecret: () => SECRET,
      getQueueCounts,
      getBacklogDepth,
    });
    const { reply, captured } = makeReply();

    await handler(makeReq(), reply);

    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthorized' });
    expect(getQueueCounts).not.toHaveBeenCalled();
    expect(getBacklogDepth).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer secret is wrong', async () => {
    const getQueueCounts = vi.fn().mockResolvedValue(counts);
    const getBacklogDepth = vi.fn().mockResolvedValue(backlog);
    const handler = createQueueHealthHandler({
      getSecret: () => SECRET,
      getQueueCounts,
      getBacklogDepth,
    });
    const { reply, captured } = makeReply();

    await handler(makeReq({ authorization: `Bearer ${'z'.repeat(64)}` }), reply);

    expect(captured.status).toBe(401);
    expect(getQueueCounts).not.toHaveBeenCalled();
    expect(getBacklogDepth).not.toHaveBeenCalled();
  });

  it('returns 200 {queues, backlog} for every queue with a good secret', async () => {
    const getQueueCounts = vi.fn().mockResolvedValue(counts);
    const getBacklogDepth = vi.fn().mockResolvedValue(backlog);
    const handler = createQueueHealthHandler({
      getSecret: () => SECRET,
      getQueueCounts,
      getBacklogDepth,
    });
    const { reply, captured } = makeReply();

    await handler(makeReq({ authorization: `Bearer ${SECRET}` }), reply);

    expect(captured.status).toBe(200);
    const body = captured.body as {
      queues: Record<string, Record<string, number>>;
      backlog: { job_outbox: number; analytics_events: number } | null;
    };
    expect(Object.keys(body.queues).sort()).toEqual([...ALL_QUEUE_NAMES].sort());
    for (const name of ALL_QUEUE_NAMES) {
      expect(body.queues[name]).toEqual(counts);
    }
    expect(getQueueCounts).toHaveBeenCalledTimes(ALL_QUEUE_NAMES.length);
    expect(body.backlog).toEqual(backlog);
  });

  it('degrades to backlog:null when getBacklogDepth rejects, still returning queues', async () => {
    const getQueueCounts = vi.fn().mockResolvedValue(counts);
    const getBacklogDepth = vi.fn().mockRejectedValue(new Error('db down'));
    const handler = createQueueHealthHandler({
      getSecret: () => SECRET,
      getQueueCounts,
      getBacklogDepth,
    });
    const { reply, captured } = makeReply();

    await handler(makeReq({ authorization: `Bearer ${SECRET}` }), reply);

    expect(captured.status).toBe(200);
    const body = captured.body as {
      queues: Record<string, Record<string, number>>;
      backlog: unknown;
    };
    expect(body.backlog).toBeNull();
    expect(Object.keys(body.queues).sort()).toEqual([...ALL_QUEUE_NAMES].sort());
    for (const name of ALL_QUEUE_NAMES) {
      expect(body.queues[name]).toEqual(counts);
    }
  });

  it('degrades to backlog:null when getBacklogDepth hangs past the 4000ms deadline', async () => {
    vi.useFakeTimers();
    try {
      const getQueueCounts = vi.fn().mockResolvedValue(counts);
      // Never resolves — only the withTimeout clock can settle the backlog.
      const getBacklogDepth = vi.fn().mockReturnValue(new Promise<never>(() => {}));
      const handler = createQueueHealthHandler({
        getSecret: () => SECRET,
        getQueueCounts,
        getBacklogDepth,
      });
      const { reply, captured } = makeReply();

      const done = handler(makeReq({ authorization: `Bearer ${SECRET}` }), reply);
      // Advance past the deadline: the timer overlapped queue collection, so the
      // backlog settles to null without adding to the endpoint's latency.
      await vi.advanceTimersByTimeAsync(BACKLOG_ENDPOINT_TIMEOUT_MS);
      await done;

      expect(captured.status).toBe(200);
      const body = captured.body as {
        queues: Record<string, Record<string, number>>;
        backlog: unknown;
      };
      expect(body.backlog).toBeNull();
      expect(Object.keys(body.queues).sort()).toEqual([...ALL_QUEUE_NAMES].sort());
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the backlog read BEFORE the first getQueueCounts await settles', async () => {
    const callOrder: string[] = [];
    const getQueueCounts = vi.fn().mockImplementation(async (name: string) => {
      callOrder.push(`queue:${name}`);
      return counts;
    });
    const getBacklogDepth = vi.fn().mockImplementation(async () => {
      callOrder.push('backlog');
      return backlog;
    });
    const handler = createQueueHealthHandler({
      getSecret: () => SECRET,
      getQueueCounts,
      getBacklogDepth,
    });
    const { reply, captured } = makeReply();

    await handler(makeReq({ authorization: `Bearer ${SECRET}` }), reply);

    expect(captured.status).toBe(200);
    // getBacklogDepth is created before the loop, so it is invoked first.
    expect(callOrder[0]).toBe('backlog');
  });

  it('requests the same job-count states the admin panel expects', () => {
    expect([...QUEUE_HEALTH_JOB_STATES]).toEqual([
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
      'paused',
    ]);
  });
});
