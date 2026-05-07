import { describe, expect, it } from 'vitest';
import { scrubSentryEvent } from '../sentry-scrub';

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
});
