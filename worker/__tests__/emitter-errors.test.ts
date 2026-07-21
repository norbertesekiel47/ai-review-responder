import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { mockCaptureMessage, mockLogger } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
  mockLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@sentry/node', () => ({ captureMessage: mockCaptureMessage }));
vi.mock('../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));

import { attachEmitterErrorLogger } from '../emitter-errors';

describe('attachEmitterErrorLogger', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('consumes error events without throwing and captures a Sentry warning', () => {
    const emitter = new EventEmitter();
    attachEmitterErrorLogger(emitter, 'queue:generate_response');
    // Without a listener this emit would throw (unhandled 'error' event).
    expect(() => emitter.emit('error', new Error('redis blip'))).not.toThrow();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'worker_emitter_error',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ source: 'queue:generate_response' }),
      }),
    );
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('never throws even if Sentry capture itself throws', () => {
    mockCaptureMessage.mockImplementationOnce(() => { throw new Error('sentry down'); });
    const emitter = new EventEmitter();
    attachEmitterErrorLogger(emitter, 'probe_redis');
    expect(() => emitter.emit('error', new Error('boom'))).not.toThrow();
  });

  it('throttles logs AND Sentry per source, surfacing the suppressed count next window', () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    attachEmitterErrorLogger(emitter, 'queue:unique_throttle_test');
    emitter.emit('error', new Error('blip 1'));
    emitter.emit('error', new Error('blip 2'));
    emitter.emit('error', new Error('blip 3'));
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1); // storm suppressed
    vi.advanceTimersByTime(61_000);
    emitter.emit('error', new Error('blip 4'));
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    expect(mockCaptureMessage).toHaveBeenLastCalledWith(
      'worker_emitter_error',
      expect.objectContaining({ extra: expect.objectContaining({ suppressed_in_prior_window: 2 }) }),
    );
    // Log suppression mirrors Sentry: one warn per reported error, none for
    // the suppressed emits.
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('2 similar suppressed in prior window'),
    );
  });

  it('throttles independently per source', () => {
    vi.useFakeTimers();
    const first = new EventEmitter();
    const second = new EventEmitter();
    attachEmitterErrorLogger(first, 'queue:per_source_a');
    attachEmitterErrorLogger(second, 'queue:per_source_b');
    first.emit('error', new Error('a1'));
    second.emit('error', new Error('b1'));
    // Two distinct sources → both first-in-window errors reported.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });
});
