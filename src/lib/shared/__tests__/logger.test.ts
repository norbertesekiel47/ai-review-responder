import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorkerLogger } from '../logger';
import { withLogContext } from '../log-context';

function lastLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error('console was not called');
  return JSON.parse(call[0] as string) as Record<string, unknown>;
}

describe('createWorkerLogger (JSON)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits one parseable JSON object with required base fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[ResponseGeneratorWorker]').log('processing review');
    const rec = lastLine(spy);
    expect(rec.level).toBe('info');
    expect(rec.service).toBe('worker');
    expect(rec.logger).toBe('ResponseGeneratorWorker');
    expect(rec.message).toBe('processing review');
    expect(typeof rec.timestamp).toBe('string');
    expect(() => new Date(rec.timestamp as string).toISOString()).not.toThrow();
  });

  it('includes correlation_id passed to the factory', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[W]', 'corr-abc').log('hi');
    expect(lastLine(spy).correlation_id).toBe('corr-abc');
  });

  it('merges bound context IDs from withLogContext', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    withLogContext({ business_id: 'biz-7', review_id: 'rev-3' }, () => {
      createWorkerLogger('[W]').log('working');
    });
    const rec = lastLine(spy);
    expect(rec.business_id).toBe('biz-7');
    expect(rec.review_id).toBe('rev-3');
  });

  it('maps warn() to level warn on console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createWorkerLogger('[W]').warn('careful');
    expect(lastLine(spy).level).toBe('warn');
  });

  it('maps error() to level error on console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createWorkerLogger('[W]').error('broke');
    expect(lastLine(spy).level).toBe('error');
  });

  it('serializes Error arguments into error_name / error_message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createWorkerLogger('[W]').error('failed to post', new Error('boom'));
    const rec = lastLine(spy);
    expect(rec.message).toBe('failed to post');
    expect(rec.error_name).toBe('Error');
    expect(rec.error_message).toBe('boom');
  });

  it('drops blocked keys from object args under data', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[W]').log('ctx', { reviewId: 'r1', access_token: 'SECRET', count: 3 });
    const data = lastLine(spy).data as Record<string, unknown>;
    expect(data.reviewId).toBe('r1');
    expect(data.count).toBe(3);
    expect(data.access_token).toBeUndefined();
  });

  it('joins multiple string args into message', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[W]').log('review', 'abc-123');
    expect(lastLine(spy).message).toBe('review abc-123');
  });
});
