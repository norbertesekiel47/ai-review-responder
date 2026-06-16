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

  it('masks an approval token in event.request.url', () => {
    const event = { request: { url: 'https://app.example.com/approve/SECRETTOKEN?foo=bar' } };
    scrubSentryEvent(event, { scrubRequestData: true });
    expect(event.request.url).toBe('https://app.example.com/approve/[REDACTED]?foo=bar');
  });

  it('masks an approval token in event.transaction', () => {
    const event = { transaction: 'GET /approve/SECRETTOKEN' };
    scrubSentryEvent(event);
    expect(event.transaction).toBe('GET /approve/[REDACTED]');
  });

  it('masks a navigation breadcrumb (data.from / data.to)', () => {
    const event = {
      breadcrumbs: [
        { category: 'navigation', data: { from: '/approve/TOKENA', to: '/dashboard' } },
      ],
    };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.data.from).toBe('/approve/[REDACTED]');
    expect(event.breadcrumbs[0]!.data.to).toBe('/dashboard');
  });

  it('masks an approval token in a fetch breadcrumb (data.url)', () => {
    const event = {
      breadcrumbs: [{ category: 'fetch', data: { url: '/api/approve/TOKENB/edit', method: 'POST' } }],
    };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.data.url).toBe('/api/approve/[REDACTED]/edit');
    expect(event.breadcrumbs[0]!.data.method).toBe('POST');
  });

  it('masks an approval token in a console breadcrumb message', () => {
    const event = { breadcrumbs: [{ category: 'console', message: 'GET /approve/TOKENC 200' }] };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.message).toBe('GET /approve/[REDACTED] 200');
  });

  it('redacts a sensitive KEY inside breadcrumb data (not just URLs)', () => {
    const event = { breadcrumbs: [{ category: 'fetch', data: { authorization: 'Bearer x' } }] };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.data.authorization).toBe('[REDACTED]');
  });

  it('does not crash on null / non-object breadcrumbs', () => {
    const event = { breadcrumbs: [null, { category: 'navigation' }] };
    expect(() => scrubSentryEvent(event)).not.toThrow();
  });

  it('masks sensitive values in request.query_string (string form)', () => {
    const event = { request: { query_string: 'code=xyz&token=t&page=2' } };
    scrubSentryEvent(event, { scrubRequestData: true });
    expect(event.request.query_string).toBe('code=[REDACTED]&token=[REDACTED]&page=2');
  });

  it('masks request.query_string even without scrubRequestData (URL-equivalent)', () => {
    const event = { request: { query_string: '?code=xyz' } };
    scrubSentryEvent(event);
    expect(event.request.query_string).toBe('?code=[REDACTED]');
  });

  it('masks sensitive values in request.query_string (object form)', () => {
    const event = { request: { query_string: { code: 'xyz', page: '2' } } };
    scrubSentryEvent(event);
    expect(event.request.query_string.code).toBe('[REDACTED]');
    expect(event.request.query_string.page).toBe('2');
  });

  it('masks sensitive values in request.query_string (array-of-pairs form)', () => {
    const event = { request: { query_string: [['code', 'xyz'], ['page', '2']] } };
    scrubSentryEvent(event);
    expect(event.request.query_string[0]).toEqual(['code', '[REDACTED]']);
    expect(event.request.query_string[1]).toEqual(['page', '2']);
  });

  it('masks a token in breadcrumb http.url + http.query (otel/http integration)', () => {
    const event = {
      breadcrumbs: [
        {
          category: 'http',
          data: { 'http.url': '/api/approve/TOK/edit', 'http.query': 'token=abc&page=1' },
        },
      ],
    };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.data['http.url']).toBe('/api/approve/[REDACTED]/edit');
    expect(event.breadcrumbs[0]!.data['http.query']).toBe('token=[REDACTED]&page=1');
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

  it('is idempotent — re-redacting an already-masked URL is a no-op', () => {
    const once = redactSensitivePathsAndQueries('/approve/tok?code=secret');
    expect(once).toBe('/approve/[REDACTED]?code=[REDACTED]');
    expect(redactSensitivePathsAndQueries(once)).toBe(once);
  });
});
