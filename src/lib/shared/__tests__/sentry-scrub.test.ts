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

  it('masks a token in breadcrumb http.url (path + query) + http.query (otel/http integration)', () => {
    const event = {
      breadcrumbs: [
        {
          category: 'http',
          data: { 'http.url': '/api/approve/TOK/edit?code=secret', 'http.query': 'token=abc&page=1' },
        },
      ],
    };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.data['http.url']).toBe('/api/approve/[REDACTED]/edit?code=[REDACTED]');
    expect(event.breadcrumbs[0]!.data['http.query']).toBe('token=[REDACTED]&page=1');
  });

  it('does not throw and still redacts a frozen request.query_string (object form)', () => {
    const event = { request: { query_string: Object.freeze({ code: 'xyz', page: '2' }) } };
    expect(() => scrubSentryEvent(event)).not.toThrow();
    expect((event.request.query_string as Record<string, string>).code).toBe('[REDACTED]');
    expect((event.request.query_string as Record<string, string>).page).toBe('2');
  });

  it('does not throw and still redacts a frozen request.query_string (array of frozen pairs)', () => {
    const event = { request: { query_string: Object.freeze([Object.freeze(['code', 'xyz'])]) } };
    expect(() => scrubSentryEvent(event)).not.toThrow();
    expect((event.request.query_string as string[][])[0]).toEqual(['code', '[REDACTED]']);
  });

  it('redacts the unsubscribe token from Sentry event paths', () => {
    const event = {
      request: { url: 'https://worker.example.com/ingress/unsubscribe/SECRET_TOK' },
      transaction: 'POST /ingress/unsubscribe/SECRET_TOK',
      breadcrumbs: [{ category: 'navigation', data: { to: '/u/SECRET_TOK' } }],
    };
    scrubSentryEvent(event, { scrubRequestData: true });

    expect(event.request.url).toBe('https://worker.example.com/ingress/unsubscribe/[REDACTED]');
    expect(event.transaction).toBe('POST /ingress/unsubscribe/[REDACTED]');
    expect(event.breadcrumbs[0]!.data.to).toBe('/u/[REDACTED]');
    expect(JSON.stringify(event)).not.toContain('SECRET_TOK');
  });

  it('redacts a percent-encoded unsubscribe path from Sentry', () => {
    const event = { request: { url: '/ingress/%75nsubscribe/SECRET_TOK' } };
    scrubSentryEvent(event, { scrubRequestData: true });

    expect(event.request.url).toBe('/ingress/unsubscribe/[REDACTED]');
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

  it('masks the token under each unsubscribe prefix', () => {
    expect(redactSensitivePathsAndQueries('/u/tok')).toBe('/u/[REDACTED]');
    expect(redactSensitivePathsAndQueries('/api/u/tok')).toBe('/api/u/[REDACTED]');
    expect(redactSensitivePathsAndQueries('/ingress/unsubscribe/tok')).toBe(
      '/ingress/unsubscribe/[REDACTED]',
    );
  });

  it('redacts a token containing an encoded slash to the end of the path', () => {
    // Fastify hands us the raw URL, but Next.js and any intermediary may have
    // already decoded %2F — the token then spans a second path segment, which a
    // segment-bounded rule would leave half-exposed.
    expect(redactSensitivePathsAndQueries('/u/abc%2Fdef')).toBe('/u/[REDACTED]');
    expect(redactSensitivePathsAndQueries('/u/abc/def')).toBe('/u/[REDACTED]');
    expect(redactSensitivePathsAndQueries('/ingress/unsubscribe/abc/def/ghi')).toBe(
      '/ingress/unsubscribe/[REDACTED]',
    );
  });

  it('leaves approve path redaction segment-bounded', () => {
    // The two shipped /approve/ contracts the new cross-slash rule must not
    // touch: the trailing /edit segment and the console-message status code.
    expect(redactSensitivePathsAndQueries('/api/approve/abc123/edit')).toBe(
      '/api/approve/[REDACTED]/edit',
    );
    expect(redactSensitivePathsAndQueries('GET /approve/tok 200')).toBe(
      'GET /approve/[REDACTED] 200',
    );
  });

  it('stops unsubscribe redaction at whitespace, query and fragment', () => {
    expect(redactSensitivePathsAndQueries('GET /u/tok 200')).toBe('GET /u/[REDACTED] 200');
    expect(redactSensitivePathsAndQueries('/u/tok?code=secret')).toBe(
      '/u/[REDACTED]?code=[REDACTED]',
    );
    expect(redactSensitivePathsAndQueries('/u/tok#done')).toBe('/u/[REDACTED]#done');
  });

  it('redacts a token that follows a hash in a non-url log string', () => {
    // The Fastify ingress logger feeds `msg` and `err.message` through this
    // function, and in free text a `#` is not a fragment delimiter. Redacting
    // past it must not disturb the shipped URL-fragment contract, so both are
    // asserted together.
    expect(redactSensitivePathsAndQueries('note #1 see /u/TOK')).toBe(
      'note #1 see /u/[REDACTED]',
    );
    expect(redactSensitivePathsAndQueries('Error #42 at /ingress/unsubscribe/TOK')).toBe(
      'Error #42 at /ingress/unsubscribe/[REDACTED]',
    );
    expect(redactSensitivePathsAndQueries('/approve/tok#section')).toBe(
      '/approve/[REDACTED]#section',
    );
    expect(redactSensitivePathsAndQueries('/u/tok#done')).toBe('/u/[REDACTED]#done');
  });

  it('does not treat /users/ as the /u/ unsubscribe prefix', () => {
    expect(redactSensitivePathsAndQueries('/users/123')).toBe('/users/123');
    expect(redactSensitivePathsAndQueries('/admin/users/123/detail')).toBe(
      '/admin/users/123/detail',
    );
  });

  it('returns malformed percent-encoding unchanged instead of throwing', () => {
    expect(() => redactSensitivePathsAndQueries('/dashboard/%E0%A4%A')).not.toThrow();
    expect(redactSensitivePathsAndQueries('/dashboard/%E0%A4%A')).toBe('/dashboard/%E0%A4%A');
  });
});
