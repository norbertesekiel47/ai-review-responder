// src/lib/shared/__tests__/error-inspect.test.ts
//
// `boundedErrorClass` is the one definition behind every `error_class` log field
// and `<lane>_exhausted:<class>` outbox reason (#1381). Before it, four
// definitions computed two different values, so the field was not comparable
// across lanes.

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { boundedErrorClass } from '../error-inspect';

describe('boundedErrorClass', () => {
  it('reports the class of an error that assigns this.name, as our own classes do', () => {
    class DispositionError extends Error {
      constructor() {
        super('msg');
        this.name = 'DispositionError';
      }
    }
    expect(boundedErrorClass(new DispositionError())).toBe('DispositionError');
  });

  it('reports the constructor name when err.name is only the inherited "Error" (the provider-SDK shape)', () => {
    // openai / @anthropic-ai/sdk error classes never assign this.name.
    class RateLimitError extends Error {}
    const err = new RateLimitError('429');
    expect(err.name).toBe('Error');
    expect(boundedErrorClass(err)).toBe('RateLimitError');
  });

  it('does not read err.name, so a renamed plain Error is still "Error"', () => {
    const err = new Error('boom');
    err.name = 'Injected: {"structure":true}';
    expect(boundedErrorClass(err)).toBe('Error');
  });

  it('reports a non-Error value as UnknownError', () => {
    for (const value of ['string rejection', 42, null, undefined, { name: 'FakeError' }]) {
      expect(boundedErrorClass(value)).toBe('UnknownError');
    }
  });

  it('reports UnknownError for a constructor name that fails the identifier shape', () => {
    const hostile = { [' bad name\n']: class extends Error {} }[' bad name\n']!;
    expect(hostile.name).toBe(' bad name\n');
    expect(boundedErrorClass(new hostile())).toBe('UnknownError');

    const tooLong = { ['A'.repeat(101)]: class extends Error {} }['A'.repeat(101)]!;
    expect(boundedErrorClass(new tooLong())).toBe('UnknownError');

    const maxLength = { ['A'.repeat(100)]: class extends Error {} }['A'.repeat(100)]!;
    expect(boundedErrorClass(new maxLength())).toBe('A'.repeat(100));
  });

  it('never throws on an overwritten constructor property', () => {
    for (const constructor of [undefined, null, {}, { name: 42 }]) {
      const err = new Error('boom');
      Object.defineProperty(err, 'constructor', { value: constructor });
      expect(boundedErrorClass(err)).toBe('UnknownError');
    }
  });

  it('never reads the message, which may embed contact handles', () => {
    expect(boundedErrorClass(new Error('rejected for someone@example.com'))).toBe('Error');
  });

  it('has exactly one definition in production code', () => {
    // Four private copies drifted into two different values once (#1381).
    const definitions = execFileSync(
      'git',
      [
        'grep', '-n', '-F', '-e', 'function boundedErrorClass(', '-e', 'boundedErrorClass =',
        '--', 'src', 'worker', 'scripts', ':!**/__tests__/**',
      ],
      { encoding: 'utf8' },
    ).trim().split('\n');
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatch(/^src\/lib\/shared\/error-inspect\.ts:/);
  });
});
