import { describe, expect, it } from 'vitest';
import { scrubSentryEvent, redactSensitivePathsAndQueries } from '../sentry-scrub';

describe('scrubSentryEvent', () => {
  it('redacts sensitive keys recursively from extra and request headers', () => {
    const event = {
      extra: {
        apiToken: 'secret',
        nested: { password: 'pw', safe: 'ok' },
      },
      request: {
        headers: {
          authorization: 'Bearer abc',
          accept: 'application/json',
        },
      },
    };

    expect(scrubSentryEvent(event)).toBe(event);
    expect(event.extra.apiToken).toBe('[REDACTED]');
    expect(event.extra.nested.password).toBe('[REDACTED]');
    expect(event.extra.nested.safe).toBe('ok');
    expect(event.request.headers.authorization).toBe('[REDACTED]');
    expect(event.request.headers.accept).toBe('application/json');
  });

  it('only scrubs request data when explicitly enabled', () => {
    const clientEvent = {
      request: {
        data: { token: 'client-token' },
      },
    };
    scrubSentryEvent(clientEvent);
    expect(clientEvent.request.data.token).toBe('client-token');

    const serverEvent = {
      request: {
        data: { token: 'server-token' },
      },
    };
    scrubSentryEvent(serverEvent, { scrubRequestData: true });
    expect(serverEvent.request.data.token).toBe('[REDACTED]');
  });

  it('scrubs sensitive keys inside arrays of objects', () => {
    const event = {
      extra: {
        batch: [
          { apiToken: 'a', label: 'first' },
          { authorization: 'Bearer x', label: 'second' },
        ],
      },
    };
    scrubSentryEvent(event);
    expect(event.extra.batch[0]!.apiToken).toBe('[REDACTED]');
    expect(event.extra.batch[0]!.label).toBe('first');
    expect(event.extra.batch[1]!.authorization).toBe('[REDACTED]');
    expect(event.extra.batch[1]!.label).toBe('second');
  });

  it('does not crash on null items inside arrays', () => {
    const event = { extra: { items: [null, { secret: 'x' }] } };
    expect(() => scrubSentryEvent(event)).not.toThrow();
    expect((event.extra.items[1] as Record<string, unknown>).secret).toBe('[REDACTED]');
  });
});

describe('redactSensitivePathsAndQueries', () => {
  it('masks the path segment after /approve/', () => {
    expect(redactSensitivePathsAndQueries('/approve/abc.def.ghi')).toBe('/approve/[REDACTED]');
  });

  it('masks the token in /api/approve/<token>/edit and keeps the trailing segment', () => {
    expect(redactSensitivePathsAndQueries('/api/approve/abc123/edit')).toBe(
      '/api/approve/[REDACTED]/edit',
    );
  });

  it('masks the token in an absolute URL and preserves the origin', () => {
    expect(redactSensitivePathsAndQueries('https://app.example.com/approve/secrettoken')).toBe(
      'https://app.example.com/approve/[REDACTED]',
    );
  });

  it('masks sensitive query param VALUES, keeps non-sensitive ones', () => {
    expect(redactSensitivePathsAndQueries('/cb?code=xyz&token=t&page=2')).toBe(
      '/cb?code=[REDACTED]&token=[REDACTED]&page=2',
    );
  });

  it('leaves a plain path unchanged', () => {
    expect(redactSensitivePathsAndQueries('/dashboard/reviews')).toBe('/dashboard/reviews');
  });

  it('preserves a #fragment', () => {
    expect(redactSensitivePathsAndQueries('/approve/tok#section')).toBe('/approve/[REDACTED]#section');
  });

  it('stops redaction at whitespace (console-message form)', () => {
    expect(redactSensitivePathsAndQueries('GET /approve/tok 200')).toBe('GET /approve/[REDACTED] 200');
  });

  it('returns non-string / empty input unchanged', () => {
    expect(redactSensitivePathsAndQueries('')).toBe('');
    expect(redactSensitivePathsAndQueries(undefined as unknown as string)).toBe(undefined);
  });
});
