import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyAndParse, zernioClient } from '../client';
import {
  ZernioAuthError,
  ZernioValidationError,
  ZernioTransientError,
  ZernioPermanentError,
  ZernioReviewNotFoundError,
  ZernioReplyAlreadyExistsError,
} from '../errors';

function mkRes(opts: { status: number; body?: unknown }): Response {
  return new Response(opts.body !== undefined ? JSON.stringify(opts.body) : null, {
    status: opts.status,
  });
}

describe('classifyAndParse', () => {
  describe('success paths', () => {
    it('parses 200 JSON response', async () => {
      const res = mkRes({ status: 200, body: { foo: 'bar' } });
      const result = await classifyAndParse<{ foo: string }>(res, 'list_reviews');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('returns undefined for 204 No Content', async () => {
      const res = mkRes({ status: 204 });
      const result = await classifyAndParse(res, 'delete_account');
      expect(result).toBeUndefined();
    });

    it('returns undefined for delete_account endpoint regardless of body', async () => {
      const res = mkRes({ status: 200 });
      const result = await classifyAndParse(res, 'delete_account');
      expect(result).toBeUndefined();
    });

    it('throws ZernioTransientError on malformed JSON in 200 response', async () => {
      const res = new Response('not json{', { status: 200 });
      await expect(classifyAndParse(res, 'list_reviews')).rejects.toBeInstanceOf(
        ZernioTransientError,
      );
    });
  });

  describe('error classification', () => {
    it('401 → ZernioAuthError', async () => {
      const res = mkRes({ status: 401 });
      await expect(classifyAndParse(res, 'select_location')).rejects.toBeInstanceOf(
        ZernioAuthError,
      );
    });

    it('403 → ZernioAuthError', async () => {
      const res = mkRes({ status: 403 });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(
        ZernioAuthError,
      );
    });

    it('409 on publish_reply → ZernioReplyAlreadyExistsError', async () => {
      const res = mkRes({ status: 409, body: { code: 'reply_already_exists' } });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(
        ZernioReplyAlreadyExistsError,
      );
    });

    it('409 on non-publish_reply → ZernioPermanentError (catch-all 4xx)', async () => {
      const res = mkRes({ status: 409, body: {} });
      await expect(classifyAndParse(res, 'select_location')).rejects.toMatchObject({
        name: 'ZernioPermanentError',
        kind: 'http_409',
      });
    });

    it('404 on publish_reply → ZernioReviewNotFoundError', async () => {
      const res = mkRes({ status: 404, body: {} });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(
        ZernioReviewNotFoundError,
      );
    });

    it('400 with allowlisted code on select_location → ZernioValidationError', async () => {
      const res = mkRes({ status: 400, body: { code: 'invalid_connect_token' } });
      await expect(classifyAndParse(res, 'select_location')).rejects.toBeInstanceOf(
        ZernioValidationError,
      );
    });

    it('400 with non-allowlisted code on select_location → ZernioTransientError unknown_4xx_unknown_outcome', async () => {
      const res = mkRes({ status: 400, body: { code: 'random_other' } });
      await expect(classifyAndParse(res, 'select_location')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'unknown_4xx_unknown_outcome',
      });
    });

    it('400 on publish_reply → ZernioPermanentError (NOT ValidationError, even with allowlisted code)', async () => {
      const res = mkRes({ status: 400, body: { code: 'invalid_connect_token' } });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(
        ZernioPermanentError,
      );
    });

    it('500 → ZernioTransientError http_500', async () => {
      const res = mkRes({ status: 500 });
      await expect(classifyAndParse(res, 'select_location')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_500',
      });
    });

    it('429 → ZernioTransientError http_429', async () => {
      const res = mkRes({ status: 429 });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_429',
      });
    });
  });

  describe('classifyAndParse — 409 on publish_reply: code-gated', () => {
    it('409 with code reply_already_exists → ZernioReplyAlreadyExistsError', async () => {
      const res = new Response(JSON.stringify({ code: 'reply_already_exists' }), {
        status: 409,
      });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(
        ZernioReplyAlreadyExistsError,
      );
    });

    it('409 with unknown code → ZernioTransientError http_409_unknown_code', async () => {
      const res = new Response(JSON.stringify({ code: 'rate_limited' }), { status: 409 });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_409_unknown_code',
      });
    });

    it('409 with no body → ZernioTransientError http_409_unknown_code', async () => {
      const res = new Response(null, { status: 409 });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_409_unknown_code',
      });
    });
  });

  describe('classifyAndParse — non-select_location 4xx classification', () => {
    it('422 → ZernioPermanentError', async () => {
      const res = new Response(JSON.stringify({ code: 'unprocessable' }), { status: 422 });
      await expect(classifyAndParse(res, 'list_reviews')).rejects.toMatchObject({
        name: 'ZernioPermanentError',
        kind: 'http_422',
      });
    });

    it('410 → ZernioPermanentError', async () => {
      const res = new Response(null, { status: 410 });
      await expect(classifyAndParse(res, 'list_reviews')).rejects.toMatchObject({
        name: 'ZernioPermanentError',
        kind: 'http_410',
      });
    });

    it('408 → ZernioTransientError (retryable)', async () => {
      const res = new Response(null, { status: 408 });
      await expect(classifyAndParse(res, 'list_reviews')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_408',
      });
    });

    it('429 → ZernioTransientError (already covered)', async () => {
      const res = new Response(null, { status: 429 });
      await expect(classifyAndParse(res, 'list_reviews')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_429',
      });
    });
  });
});

describe('request() timeout handling', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('AbortError → ZernioTransientError with kind=request_timeout', async () => {
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    const { request } = await import('../client');
    await expect(
      request({
        method: 'GET',
        path: '/v1/test',
        endpointKind: 'list_reviews',
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ name: 'ZernioTransientError', kind: 'request_timeout' });
  });

  it('TypeError (DNS/socket failure) → ZernioTransientError with kind=network_error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { request } = await import('../client');
    await expect(
      request({
        method: 'GET',
        path: '/v1/test',
        endpointKind: 'list_reviews',
      }),
    ).rejects.toMatchObject({ name: 'ZernioTransientError', kind: 'network_error' });
  });

  it('preserves already-classified Zernio errors (no double-wrap)', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const { request } = await import('../client');
    await expect(
      request({
        method: 'GET',
        path: '/v1/test',
        endpointKind: 'select_location',
      }),
    ).rejects.toMatchObject({ name: 'ZernioAuthError' });
  });
});

describe('zernioClient connect contract', () => {
  let originalFetch: typeof global.fetch;
  let originalApiBase: string | undefined;
  let originalApiKey: string | undefined;
  let originalMockExternalApis: string | undefined;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalApiBase = process.env.ZERNIO_API_BASE;
    originalApiKey = process.env.ZERNIO_API_KEY;
    originalMockExternalApis = process.env.MOCK_EXTERNAL_APIS;
    process.env.ZERNIO_API_BASE = 'https://zernio.test/api';
    process.env.ZERNIO_API_KEY = 'test-key';
    delete process.env.MOCK_EXTERNAL_APIS;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiBase === undefined) {
      delete process.env.ZERNIO_API_BASE;
    } else {
      process.env.ZERNIO_API_BASE = originalApiBase;
    }
    if (originalApiKey === undefined) {
      delete process.env.ZERNIO_API_KEY;
    } else {
      process.env.ZERNIO_API_KEY = originalApiKey;
    }
    if (originalMockExternalApis === undefined) {
      delete process.env.MOCK_EXTERNAL_APIS;
    } else {
      process.env.MOCK_EXTERNAL_APIS = originalMockExternalApis;
    }
  });

  it('starts Google Business headless connect with the documented platform slug and redirect_url query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          state: 'zernio-returned-state',
        }),
        {
          status: 200,
        },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await zernioClient.startConnect({
      profileId: 'prof_123',
      redirectUrl: 'https://app.example/api/zernio/connect/callback',
      state: 'state-abc',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const requestUrl = new URL(String(url));

    expect(requestUrl.pathname).toBe('/api/v1/connect/googlebusiness');
    expect(requestUrl.searchParams.get('profileId')).toBe('prof_123');
    expect(requestUrl.searchParams.get('headless')).toBe('true');
    expect(requestUrl.searchParams.get('redirect_url')).toBe(
      'https://app.example/api/zernio/connect/callback',
    );
    expect(requestUrl.searchParams.has('redirectUrl')).toBe(false);
    expect(requestUrl.searchParams.get('state')).toBe('state-abc');
    expect(init).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    });
    expect(result.state).toBe('zernio-returned-state');
  });

  it('lists Google Business locations using profileId and pendingDataToken', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          locations: [{ id: 'loc-1', name: 'Location 1', address: '1 Main St' }],
        }),
        { status: 200 },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await zernioClient.listLocations({
      profileId: 'prof_123',
      pendingDataToken: 'pdt-123',
      connectToken: 'ct_123',
    });

    const [url, init] = fetchMock.mock.calls[0];
    const requestUrl = new URL(String(url));

    expect(requestUrl.pathname).toBe('/api/v1/connect/googlebusiness/locations');
    expect(requestUrl.searchParams.get('profileId')).toBe('prof_123');
    expect(requestUrl.searchParams.get('pendingDataToken')).toBe('pdt-123');
    expect(init).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer test-key',
        'X-Connect-Token': 'ct_123',
      }),
    });
  });

  it('selects Google Business location with profileId and pendingDataToken body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          account: { accountId: 'acct-123', selectedLocationId: 'loc-1' },
        }),
        { status: 200 },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await zernioClient.selectLocation({
      profileId: 'prof_123',
      pendingDataToken: 'pdt-123',
      connectToken: 'ct_123',
      locationId: 'loc-1',
    });

    const [url, init] = fetchMock.mock.calls[0];
    const requestUrl = new URL(String(url));

    expect(result.accountId).toBe('acct-123');
    expect(requestUrl.pathname).toBe('/api/v1/connect/googlebusiness/select-location');
    expect(JSON.parse(String(init.body))).toEqual({
      profileId: 'prof_123',
      locationId: 'loc-1',
      pendingDataToken: 'pdt-123',
    });
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer test-key',
        'X-Connect-Token': 'ct_123',
      }),
    });
  });
});

describe('mock mode', () => {
  beforeEach(() => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
  });
  afterEach(() => {
    delete process.env.MOCK_EXTERNAL_APIS;
  });

  it('createProfile returns a fake profileId without hitting fetch', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const result = await zernioClient.createProfile({ name: 'test' });
    expect(result.profileId).toMatch(/^mock-profile-/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
