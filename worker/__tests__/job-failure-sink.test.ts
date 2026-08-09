// Unit suite for the Job-failure sink (#719, eval task).
//
// Before #719 the only worker-level reporting on a BullMQ `'failed'` event was a
// Sentry BREADCRUMB, which attaches to some later unrelated event or to nothing
// at all. A handler that threw on every attempt therefore raised no issue, and
// the onboarding drip crashed deterministically for three months behind that
// gap. These cases pin the four things the sink has to get right — terminal-only
// capture, a bounded (PII-free) log line, tolerance of an undefined job — plus
// the one that no amount of sink correctness can substitute for: that boot
// actually attaches it.
//
// Deliberately NOT a live-DB suite. The sink writes nothing to `job_outbox`: the
// Watchdog owns that status machine AND overwrites `last_error` unconditionally
// when it terminalizes, so a write here would be destroyed by the exact generic
// message it was meant to replace.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { QUEUE_NAMES } from '../../src/lib/shared/queue-names';

const sentryStub = vi.hoisted(() => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@sentry/node', () => sentryStub);

const loggerStub = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/lib/shared/logger', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/shared/logger')>();
  return { ...actual, createWorkerLogger: () => loggerStub };
});

/**
 * Task 5's module. It does not exist yet, so the specifier is held in a variable
 * — the import then fails at RUN time with a missing-module error (which is what
 * these cases must report today) instead of breaking `pnpm typecheck` for every
 * task running in parallel with this one.
 */
const JOB_FAILURE_SINK_MODULE = '../job-failure-sink';

interface WorkerLike {
  on: (event: 'failed', listener: (job: Job | undefined, err: Error) => void) => unknown;
}

interface JobFailureSinkModule {
  reportJobFailure?: (queueName: string, job: Job | undefined, err: Error) => void;
  attachJobFailureSink?: (worker: WorkerLike, queueName: string) => void;
}

async function loadReportJobFailure(): Promise<
  (queueName: string, job: Job | undefined, err: Error) => void
> {
  const sink = (await import(JOB_FAILURE_SINK_MODULE)) as JobFailureSinkModule;
  if (!sink.reportJobFailure) {
    throw new Error('worker/job-failure-sink.ts does not export reportJobFailure yet (#719 Task 5)');
  }
  return sink.reportJobFailure;
}

interface JobShape {
  attemptsMade: number;
  attempts: number;
  id?: string;
  name?: string;
  outboxId?: string;
}

function makeJob(shape: JobShape): Job {
  return {
    id: shape.id ?? 'bull-job-1',
    name: shape.name ?? QUEUE_NAMES.ONBOARDING_DRIP,
    data: { outbox_id: shape.outboxId ?? 'outbox-1' },
    attemptsMade: shape.attemptsMade,
    opts: { attempts: shape.attempts },
  } as unknown as Job;
}

describe('job-failure sink', () => {
  beforeEach(() => {
    sentryStub.captureException.mockClear();
    sentryStub.addBreadcrumb.mockClear();
    loggerStub.log.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
  });

  it('the job-failure sink captures to Sentry only on the terminal BullMQ attempt', async () => {
    const reportJobFailure = await loadReportJobFailure();

    reportJobFailure(
      QUEUE_NAMES.ONBOARDING_DRIP,
      makeJob({ attemptsMade: 5, attempts: 5 }),
      new Error('column "business_id" does not exist'),
    );

    expect(sentryStub.captureException).toHaveBeenCalledTimes(1);
    const [, context] = sentryStub.captureException.mock.calls[0]!;
    expect((context as { tags?: Record<string, string> }).tags).toMatchObject({
      subsystem: 'worker_job',
      queue: QUEUE_NAMES.ONBOARDING_DRIP,
    });
  });

  it('the job-failure sink does not capture when an intermediate attempt fails and a retry remains', async () => {
    const reportJobFailure = await loadReportJobFailure();

    reportJobFailure(
      QUEUE_NAMES.ONBOARDING_DRIP,
      makeJob({ attemptsMade: 1, attempts: 5 }),
      new Error('transient connection reset'),
    );

    // Capturing every attempt would bury the terminal one under four retries.
    expect(sentryStub.captureException).not.toHaveBeenCalled();
  });

  it('the job-failure sink logs a bounded error class and never the raw message', async () => {
    // csv-ingest's failed hook states the contract: only the bounded error CLASS
    // may be persisted or logged, because a driver message can embed contact
    // handles — and STRING logger arguments bypass the object sanitizer. The
    // full error still reaches Sentry, which has its own scrubber.
    const reportJobFailure = await loadReportJobFailure();
    const secret = 'secret-handle@example.com';

    reportJobFailure(
      QUEUE_NAMES.SEND_NOTIFICATION,
      makeJob({ attemptsMade: 3, attempts: 3 }),
      new Error(`delivery rejected for ${secret}`),
    );

    const loggedArguments = [
      ...loggerStub.error.mock.calls,
      ...loggerStub.warn.mock.calls,
      ...loggerStub.log.mock.calls,
    ].flat();
    expect(JSON.stringify(loggedArguments)).not.toContain(secret);

    const classified = loggerStub.error.mock.calls.find((call) =>
      call.some(
        (argument) =>
          typeof argument === 'object' &&
          argument !== null &&
          'error_class' in (argument as Record<string, unknown>),
      ),
    );
    expect(classified, 'no logger.error call carried an error_class field').toBeDefined();
  });

  it('the job-failure sink ignores a failed event with an undefined job', async () => {
    // BullMQ emits `'failed'` with `job === undefined` when the job could not be
    // rehydrated; the sink must not become a second failure on top of the first.
    const reportJobFailure = await loadReportJobFailure();

    expect(() =>
      reportJobFailure(QUEUE_NAMES.PUBLISH_RESPONSE, undefined, new Error('lost job')),
    ).not.toThrow();
    expect(sentryStub.captureException).not.toHaveBeenCalled();
  });

  it('worker boot attaches the failure sink to every registered worker', () => {
    // A perfect sink that is never wired passes every case above. The
    // registration loop is the only place that can attach it once per queue, so
    // the assertion is that the attachment lives INSIDE that loop and that the
    // breadcrumb-only listener it replaces is gone.
    const source = readFileSync(resolve(process.cwd(), 'worker/index.ts'), 'utf8');

    expect(source).toContain("from './job-failure-sink'");

    const loopStart = source.indexOf(
      'for (const [queueName, worker] of Object.entries(workersByQueue))',
    );
    expect(loopStart, 'the per-queue worker registration loop moved').toBeGreaterThan(-1);
    const loopEnd = source.indexOf('\n}', loopStart);
    expect(loopEnd, 'the per-queue worker registration loop is unterminated').toBeGreaterThan(
      loopStart,
    );
    const loopBody = source.slice(loopStart, loopEnd);

    expect(loopBody.match(/attachJobFailureSink\(worker, queueName\)/g) ?? []).toHaveLength(1);
    expect(loopBody).not.toContain("worker.on('failed'");
  });
});
