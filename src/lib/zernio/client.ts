import {
  ZernioAuthError,
  ZernioValidationError,
  ZernioTransientError,
  ZernioPermanentError,
  ZernioReviewNotFoundError,
  ZernioReplyAlreadyExistsError,
} from './errors';
import type { EndpointKind, ZernioReview, ZernioLocationOption } from './types';

// Endpoints that don't return a JSON body (DELETE, etc.) — round-17 fix.
// res.json() on an empty body throws SyntaxError; without this gate it would
// get caught by request()'s outer catch and wrapped as
// ZernioTransientError('network_error'), erroneously triggering retry +
// graceful-degradation disconnect on a successful no-content response.
const NO_BODY_ENDPOINTS = new Set<EndpointKind>(['delete_profile', 'delete_account']);

// Strict allowlist of documented pre-mutation reject codes for select_location.
// Maintenance rule (spec §4.7): any addition requires either (a) explicit
// confirmation in Zernio's published docs that the code is returned pre-commit,
// or (b) the corresponding error documented as outcome-unknown in the launch
// runbook. Default-deny prevents the round-14 unsafe-revert bug.
const PRE_MUTATION_400_CODES = new Set<string>([
  'invalid_connect_token',
  'unknown_location_id',
  'profile_not_found',
  'missing_required_field',
]);

export async function classifyAndParse<T>(res: Response, endpointKind: EndpointKind): Promise<T> {
  if (res.ok) {
    if (res.status === 204 || NO_BODY_ENDPOINTS.has(endpointKind)) {
      return undefined as unknown as T;
    }
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // 200 OK with malformed JSON — Zernio bug or proxy mangling. Treat as
      // transient (retry-able) since we don't know if the action took.
      throw new ZernioTransientError('malformed_response_body', {
        path: res.url,
        status: res.status,
        bodyPreview: text.slice(0, 200),
      });
    }
  }

  if (res.status === 401 || res.status === 403) {
    throw new ZernioAuthError(res.status, await res.text().catch(() => ''));
  }

  if (res.status === 409 && endpointKind === 'publish_reply') {
    throw new ZernioReplyAlreadyExistsError(await res.json().catch(() => ({})));
  }

  if (res.status === 404 && endpointKind === 'publish_reply') {
    throw new ZernioReviewNotFoundError(await res.json().catch(() => ({})));
  }

  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (endpointKind === 'select_location') {
      if (body?.code && PRE_MUTATION_400_CODES.has(body.code)) {
        throw new ZernioValidationError(body.code, body);
      }
      throw new ZernioTransientError('unknown_4xx_unknown_outcome', { status: 400, body });
    }
    // Non-select_location endpoints: ALL 400s are permanent client errors.
    throw new ZernioPermanentError('http_400', { status: 400, body, endpointKind });
  }

  // 5xx / 429 / other status → transient.
  throw new ZernioTransientError(`http_${res.status}`, {
    status: res.status,
    body: await res.text().catch(() => ''),
  });
}

type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface RequestOptions {
  method: HttpMethod;
  path: string;
  endpointKind: EndpointKind;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export async function request<T>(opts: RequestOptions): Promise<T> {
  // Spec §6.5 — mock mode short-circuits all Zernio calls so local dev works
  // without sandbox credentials. Must run BEFORE AbortController setup so we
  // make zero fetch calls.
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    return await mockResponse<T>(opts);
  }

  // Round-16: extract timeoutMs BEFORE setTimeout so it's visible in catch.
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Read env on every call (NOT module-level) so MOCK_EXTERNAL_APIS toggling
  // and per-test env overrides work correctly.
  const apiBase = process.env.ZERNIO_API_BASE ?? 'https://zernio.com/api';
  const apiKey = process.env.ZERNIO_API_KEY ?? '';

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...opts.headers,
  };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch(`${apiBase}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    return await classifyAndParse<T>(res, opts.endpointKind);
  } catch (err) {
    // Preserve already-classified Zernio errors so we don't re-wrap them.
    if (err instanceof ZernioAuthError) throw err;
    if (err instanceof ZernioValidationError) throw err;
    if (err instanceof ZernioReplyAlreadyExistsError) throw err;
    if (err instanceof ZernioReviewNotFoundError) throw err;
    if (err instanceof ZernioPermanentError) throw err;
    if (err instanceof ZernioTransientError) throw err;

    if (err instanceof Error && err.name === 'AbortError') {
      throw new ZernioTransientError('request_timeout', {
        path: opts.path,
        method: opts.method,
        endpointKind: opts.endpointKind,
        timeoutMs,
      });
    }
    throw new ZernioTransientError('network_error', {
      path: opts.path,
      method: opts.method,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function mockResponse<T>(opts: RequestOptions): Promise<T> {
  switch (opts.endpointKind) {
    case 'create_profile':
      return { profileId: `mock-profile-${Date.now()}` } as unknown as T;
    case 'start_connect':
      return {
        authUrl: 'http://localhost:3000/__mock_oauth_complete',
      } as unknown as T;
    case 'list_locations':
      return {
        locations: [{ id: 'mock-loc-1', name: 'Mock Location', address: '123 Mock St' }],
      } as unknown as T;
    case 'select_location':
      return { accountId: `mock-account-${Date.now()}` } as unknown as T;
    case 'list_reviews':
      return { reviews: [], nextPageToken: undefined } as unknown as T;
    case 'publish_reply':
      return {
        comment: 'mock reply',
        updateTime: new Date().toISOString(),
      } as unknown as T;
    case 'delete_account':
    case 'delete_profile':
      return undefined as unknown as T;
  }
}

export const zernioClient = {
  createProfile: (input: { name: string }) =>
    request<{ profileId: string }>({
      method: 'POST',
      path: '/v1/profiles',
      endpointKind: 'create_profile',
      body: input,
      timeoutMs: 10_000,
    }),

  startConnect: (input: { profileId: string; state: string; redirectUrl: string }) =>
    request<{ authUrl: string }>({
      method: 'GET',
      path: `/v1/connect/google-business?profileId=${encodeURIComponent(input.profileId)}&headless=true&redirectUrl=${encodeURIComponent(input.redirectUrl)}&state=${encodeURIComponent(input.state)}`,
      endpointKind: 'start_connect',
      timeoutMs: 10_000,
    }),

  listLocations: (input: { connectToken: string }) =>
    request<{ locations: ZernioLocationOption[] }>({
      method: 'GET',
      path: '/v1/connect/google-business/list-locations',
      endpointKind: 'list_locations',
      timeoutMs: 10_000,
      headers: { 'X-Connect-Token': input.connectToken },
    }),

  selectLocation: (input: { connectToken: string; locationId: string }) =>
    request<{ accountId: string }>({
      method: 'POST',
      path: '/v1/connect/google-business/select-location',
      endpointKind: 'select_location',
      timeoutMs: 15_000,
      headers: { 'X-Connect-Token': input.connectToken },
      body: { locationId: input.locationId },
    }),

  listReviews: (
    accountId: string,
    input: { pageSize?: number; pageToken?: string },
  ) =>
    request<{ reviews: ZernioReview[]; nextPageToken?: string }>({
      method: 'GET',
      path: `/v1/accounts/${encodeURIComponent(accountId)}/gmb-reviews?pageSize=${input.pageSize ?? 50}${input.pageToken ? `&pageToken=${encodeURIComponent(input.pageToken)}` : ''}`,
      endpointKind: 'list_reviews',
      timeoutMs: 15_000,
    }),

  listAllReviews: async (
    accountId: string,
    opts: { pageSize: number; maxPages: number },
  ): Promise<ZernioReview[]> => {
    const all: ZernioReview[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < opts.maxPages; i++) {
      const page = await zernioClient.listReviews(accountId, {
        pageSize: opts.pageSize,
        pageToken,
      });
      all.push(...page.reviews);
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return all;
  },

  postReply: (accountId: string, reviewId: string, input: { comment: string }) =>
    request<{ comment: string; updateTime: string }>({
      method: 'POST',
      path: `/v1/accounts/${encodeURIComponent(accountId)}/gmb-reviews/${encodeURIComponent(reviewId)}/reply`,
      endpointKind: 'publish_reply',
      timeoutMs: 15_000,
      body: { comment: input.comment },
    }),

  deleteAccount: (accountId: string) =>
    request<void>({
      method: 'DELETE',
      path: `/v1/accounts/${encodeURIComponent(accountId)}`,
      endpointKind: 'delete_account',
      timeoutMs: 10_000,
    }),

  deleteProfile: (profileId: string) =>
    request<void>({
      method: 'DELETE',
      path: `/v1/profiles/${encodeURIComponent(profileId)}`,
      endpointKind: 'delete_profile',
      timeoutMs: 10_000,
    }),
};
