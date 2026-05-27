import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { withJobLogContext, extractJobLogContext } from '../job-log-context';
import { createWorkerLogger } from '../../src/lib/shared/logger';

function fakeJob(data: Record<string, unknown>, id = 'job-1'): Job {
  return { id, data } as unknown as Job;
}

describe('job log context', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts known IDs and assigns a request_id', () => {
    const ctx = extractJobLogContext(fakeJob({ business_id: 'biz-7', review_id: 'rev-3' }));
    expect(ctx.business_id).toBe('biz-7');
    expect(ctx.review_id).toBe('rev-3');
    expect(ctx.worker_job_id).toBe('job-1');
    expect(typeof ctx.request_id).toBe('string');
  });

  it('ignores non-string id fields', () => {
    const ctx = extractJobLogContext(fakeJob({ business_id: 123 as unknown as string }));
    expect(ctx.business_id).toBeUndefined();
  });

  it('propagates bound IDs into logger output inside the wrapped handler', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const wrapped = withJobLogContext(async () => {
      createWorkerLogger('[ResponseGeneratorWorker]').log('working');
    });
    await wrapped(fakeJob({ correlation_id: 'corr-9', business_id: 'biz-7', review_id: 'rev-3' }));
    const rec = JSON.parse(spy.mock.calls.at(-1)![0] as string) as Record<string, unknown>;
    expect(rec.correlation_id).toBe('corr-9');
    expect(rec.business_id).toBe('biz-7');
    expect(rec.review_id).toBe('rev-3');
    expect(rec.worker_job_id).toBe('job-1');
  });
});
