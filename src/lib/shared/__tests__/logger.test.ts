import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorkerLogger } from '../logger';
import { withLogContext } from '../log-context';

/**
 * @types/node declares NODE_ENV as a required, read-only property, so a literal
 * `delete process.env.NODE_ENV` / `process.env.NODE_ENV = x` is a type error. A
 * dynamic key routes through ProcessEnv's index signature — same runtime effect.
 */
function setEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function lastLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error('console was not called');
  return JSON.parse(call[0] as string) as Record<string, unknown>;
}

/** The raw string written to a console sink, unparsed. Same guard as lastLine. */
function rawLine(spy: ReturnType<typeof vi.spyOn>): string {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error('console was not called');
  return call[0] as string;
}

describe('createWorkerLogger (JSON)', () => {
  // Lane tests mutate NODE_ENV / RAILWAY_ENVIRONMENT_NAME; snapshot the whole
  // env so ambient shell state can never leak into (or out of) a verdict.
  const originalEnv = process.env;
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
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

  it('serializeError omits error_stack on the production Railway lane when NODE_ENV is unset', () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    setEnvVar('NODE_ENV', undefined);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createWorkerLogger('[W]').error('failed to post', new Error('boom'));
    const rec = lastLine(spy);
    expect(rec.error_message).toBe('boom');
    expect(rec.error_stack).toBeUndefined();
  });

  it('serializeError still includes error_stack on a local development lane', () => {
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    setEnvVar('NODE_ENV', 'development');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createWorkerLogger('[W]').error('failed to post', new Error('boom'));
    expect(lastLine(spy).error_stack).toEqual(expect.stringContaining('Error: boom'));
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

  it('fails open on a circular object arg instead of throwing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => createWorkerLogger('[W]').log('ctx', circular)).not.toThrow();
    const rec = lastLine(spy);
    expect(rec.message).toBe('ctx');
    expect((rec.data as Record<string, unknown>).unserializable).toBe(true);
  });

  // ── Characterization suite (#616) ────────────────────────────────────────
  //
  // These pin the record `emit` produces TODAY, so the complexity
  // decomposition cannot move it. They are expected to pass against the
  // pre-refactor `emit` — that is what a characterization test is, not a TDD
  // red step. One of these turning red means the refactor changed observable
  // behavior, never that the test is stale.

  it('keeps the JSON key order: base fields, then context, then error fields, then data last', () => {
    // Pin the lane: any Railway variable, or NODE_ENV=production, suppresses
    // error_stack (#611), which would change the expected key list.
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    setEnvVar('NODE_ENV', 'development');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    withLogContext({ request_id: 'req_1', account_id: 'acct_1' }, () => {
      createWorkerLogger('[W]', 'factory-corr').log('hello', new Error('boom'), { foo: 'bar' });
    });

    // Context IDs arrive in CONTEXT_FIELDS order, so request_id precedes
    // account_id. The factory correlation id is appended AFTER that loop, not
    // in its CONTEXT_FIELDS slot. `message` holds the position it was seeded
    // at, because re-assigning an existing key never moves it.
    expect(Object.keys(lastLine(spy))).toEqual([
      'timestamp',
      'level',
      'service',
      'logger',
      'message',
      'request_id',
      'account_id',
      'correlation_id',
      'error_name',
      'error_message',
      'error_stack',
      'data',
    ]);
  });

  it('lets a bound context correlation_id win over the factory correlationId', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    withLogContext({ correlation_id: 'from-context' }, () => {
      createWorkerLogger('[W]', 'from-factory').log('x');
    });
    // The factory value is applied ONLY when record.correlation_id is still
    // undefined after the context loop.
    expect(lastLine(spy).correlation_id).toBe('from-context');
  });

  it('keeps false and 0 in the message instead of dropping them', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[W]').log('flags', false, 0);
    // The arg classifier tests `typeof`, never truthiness. A truthiness check
    // would silently drop both of these.
    expect(lastLine(spy).message).toBe('flags false 0');
  });

  it('drops null and undefined args without adding a data key', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createWorkerLogger('[W]').log('only', null, undefined);
    const rec = lastLine(spy);
    expect(rec.message).toBe('only');
    // `typeof null === 'object'`, so only the leading `arg &&` keeps null out
    // of the sanitizer.
    expect('data' in rec).toBe(false);
  });

  it('omits the data key when an object arg sanitizes to nothing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Both keys are blocked by the analytics sanitizer, so `data` would be {}.
    createWorkerLogger('[W]').log('ctx', { access_token: 'SECRET', api_key: 'SECRET' });
    const rec = lastLine(spy);
    expect(rec.message).toBe('ctx');
    expect('data' in rec).toBe(false);
  });

  it('writes the fallback line when the whole record is unserializable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // An object arg can never trigger this: sanitizeAnalyticsProperties copies
    // only string/number/boolean/null, so a BigInt is dropped before it
    // reaches the record. An Error can — serializeError copies err.message
    // straight onto the record, and JSON.stringify then throws a TypeError.
    const err = new Error('boom');
    // BigInt(10), not 10n — tsconfig targets ES2017, which has no BigInt literal.
    Object.defineProperty(err, 'message', { value: BigInt(10) });

    expect(() => createWorkerLogger('[W]').error('failed', err)).not.toThrow();

    expect(lastLine(spy)).toEqual({ message: 'failed', unserializable: true });
  });

  it('lets the last Error arg overwrite the earlier error fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createWorkerLogger('[W]').error('two errors', new RangeError('first'), new TypeError('second'));
    const rec = lastLine(spy);
    expect(rec.error_name).toBe('TypeError');
    expect(rec.error_message).toBe('second');
  });

  it('writes exactly one byte-identical compact JSON line to the selected console sink', () => {
    // The only raw-string assertion in this file. Parsed-record assertions
    // cannot catch pretty-printing (same values, same Object.keys, more
    // physical lines) or a duplicate write, because `lastLine` reads only the
    // final call. This one catches both.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'));
    // NODE_ENV=production suppresses error_stack, which is the only
    // non-deterministic field in the record.
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    setEnvVar('NODE_ENV', 'production');
    setEnvVar('LOG_SERVICE', undefined);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      createWorkerLogger('[W]', 'corr-1').error('boom happened', new Error('kaput'), {
        foo: 'bar',
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(rawLine(errorSpy)).toBe(
        '{"timestamp":"2026-01-02T03:04:05.678Z","level":"error","service":"worker",' +
          '"logger":"W","message":"boom happened","correlation_id":"corr-1",' +
          '"error_name":"Error","error_message":"kaput","data":{"foo":"bar"}}',
      );
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges every object arg into data, keeping earlier keys across a sanitizer failure', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const circular: Record<string, unknown> = { ignored: 1 };
    circular.self = circular;

    createWorkerLogger('[W]').log(
      'ctx',
      { first: 1, shared: 'early' },
      circular,
      { last: 2, shared: 'late' },
    );

    // Accumulation, not replacement: each object arg spreads onto what came
    // before, and so does the sanitizer's fail-open marker. `shared` keeps its
    // FIRST insertion position while taking the LAST value — object spread
    // semantics. Replacing `data` with the newest sanitized object, or with a
    // bare { unserializable: true }, would pass every other test here.
    const data = lastLine(spy).data as Record<string, unknown>;
    expect(data).toEqual({ first: 1, shared: 'late', unserializable: true, last: 2 });
    expect(Object.keys(data)).toEqual(['first', 'shared', 'unserializable', 'last']);
  });

  it('keeps the earlier error_stack when a later Error supplies none', () => {
    // serializeError guards on `err.stack`, so an Error without one
    // contributes error_name and error_message but does NOT delete an
    // error_stack an earlier Error already wrote. Replacing the accumulated
    // error fields with the last serialization would silently drop it.
    //
    // KNOWN DEBT, preserved deliberately (#616 branch review): the record this
    // produces is internally inconsistent — error_name/error_message describe
    // the SECOND error while error_stack describes the FIRST, which can point
    // a debugger at the wrong failure site. That predates this branch and is
    // NOT fixed here, because this is a behavior-preserving refactor. The
    // assertion pins the current behavior so the decomposition cannot move it
    // by accident; it is not an endorsement. The follow-up decision is either
    // to replace the whole error group when a later Error wins, or to
    // represent multiple errors separately — filed against the logger, not
    // against #616.
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    setEnvVar('NODE_ENV', 'development');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const withStack = new Error('first');
    const withoutStack = new TypeError('second');
    delete withoutStack.stack;

    createWorkerLogger('[W]').error('two errors', withStack, withoutStack);

    const rec = lastLine(spy);
    expect(rec.error_name).toBe('TypeError');
    expect(rec.error_message).toBe('second');
    expect(rec.error_stack).toEqual(expect.stringContaining('Error: first'));
  });
});
