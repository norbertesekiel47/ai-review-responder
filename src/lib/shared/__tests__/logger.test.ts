import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkerLogger } from '../logger';

describe('createWorkerLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prepends prefix and correlation ID to log()', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', 'corr-abc-123');
    logger.log('processing review');
    expect(spy).toHaveBeenCalledWith('[TestWorker] [corr-abc-123]', 'processing review');
  });

  it('prepends prefix only when no correlation ID', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]');
    logger.log('processing review');
    expect(spy).toHaveBeenCalledWith('[TestWorker]', 'processing review');
  });

  it('prepends prefix and correlation ID to warn()', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', 'corr-xyz');
    logger.warn('something suspicious');
    expect(spy).toHaveBeenCalledWith('[TestWorker] [corr-xyz]', 'something suspicious');
  });

  it('prepends prefix and correlation ID to error()', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', 'corr-xyz');
    logger.error('something broke');
    expect(spy).toHaveBeenCalledWith('[TestWorker] [corr-xyz]', 'something broke');
  });

  it('treats undefined correlation ID same as omitted', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', undefined);
    logger.log('test');
    expect(spy).toHaveBeenCalledWith('[TestWorker]', 'test');
  });

  it('passes through multiple arguments', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createWorkerLogger('[TestWorker]', 'corr-1');
    logger.log('review', 'abc-123', { count: 5 });
    expect(spy).toHaveBeenCalledWith('[TestWorker] [corr-1]', 'review', 'abc-123', { count: 5 });
  });
});
