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

// Strict allowlist of documented 409 codes that genuinely mean "reply already
// exists" on publish_reply. Maintenance rule mirrors PRE_MUTATION_400_CODES:
// extend ONLY when Zernio docs explicitly document an additional 409 code for
// this endpoint as meaning the reply was already posted. Default-deny: any
// unknown 409 (rate limit, lock contention, etc.) is treated as transient so
// we never falsely mark a response `posted` when no reply exists yet.
const REPLY_ALREADY_EXISTS_CODES = new Set<string>([
  'reply_already_exists',
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
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    if (
      body &&
      typeof body === 'object' &&
      'code' in body &&
      typeof body.code === 'string' &&
      REPLY_ALREADY_EXISTS_CODES.has(body.code)
    ) {
      throw new ZernioReplyAlreadyExistsError(body);
    }
    // Unknown 409 — could be lock contention, rate limit, or a code we haven't
    // allowlisted yet. Treat as transient so we don't falsely mark a response
    // `posted` when no reply was actually created.
    throw new ZernioTransientError('http_409_unknown_code', { endpointKind, body });
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

  // Catch-all 4xx → permanent, EXCEPT the retryable 4xx (408, 429). Placed
  // AFTER all special-case branches above (auth/409/404/400) so those keep
  // their tailored classification. Without this, e.g. 422/410/405 would fall
  // through to the transient classifier below and retry indefinitely.
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    const body = await res.json().catch(() => ({}));
    throw new ZernioPermanentError(`http_${res.status}`, { endpointKind, body });
  }

  // 5xx / 408 / 429 / other status → transient.
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

function normalizeLocations(raw: unknown): ZernioLocationOption[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const arr =
    (Array.isArray(o.locations) ? o.locations : undefined) ??
    (Array.isArray(o.data) ? o.data : undefined) ??
    (Array.isArray(o.results) ? o.results : undefined) ??
    [];
  return (arr as Array<Record<string, unknown>>).map((loc) => ({
    id:
      (typeof loc._id === 'string' ? loc._id : undefined) ??
      (typeof loc.id === 'string' ? loc.id : undefined) ??
      (typeof loc.locationId === 'string' ? loc.locationId : undefined) ??
      '',
    name:
      (typeof loc.name === 'string' ? loc.name : undefined) ??
      (typeof loc.title === 'string' ? loc.title : undefined) ??
      (typeof loc.displayName === 'string' ? loc.displayName : undefined) ??
      '<unnamed>',
    address:
      (typeof loc.address === 'string' ? loc.address : undefined) ??
      (typeof loc.formattedAddress === 'string' ? loc.formattedAddress : undefined) ??
      '',
  })).filter((l) => l.id !== '');
}

// Zernio uses MongoDB-shaped responses. POST /v1/profiles returns:
//   { message, profile: { _id, name, userId, isDefault, color, createdAt, ... } }
// The canonical profile id is at profile._id.
function extractProfileId(raw: unknown): string {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const profileObj = o.profile as Record<string, unknown> | undefined;
    const candidates = [
      profileObj?._id,
      profileObj?.id,
      o._id,
      o.profileId,
      o.id,
      o.profile_id,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
  }
  console.warn(
    `[zernio.createProfile] UNRECOGNIZED RESPONSE SHAPE: ${JSON.stringify(raw)}`,
  );
  throw new Error('zernio_createProfile_unexpected_response_shape');
}

export const zernioClient = {
  createProfile: async (input: { name: string }) => {
    const raw = await request<unknown>({
      method: 'POST',
      path: '/v1/profiles',
      endpointKind: 'create_profile',
      body: input,
      timeoutMs: 10_000,
    });
    return { profileId: extractProfileId(raw) };
  },

  startConnect: async (input: { profileId: string; state: string; redirectUrl: string }) => {
    const raw = await request<unknown>({
      method: 'GET',
      path: `/v1/connect/googlebusiness?profileId=${encodeURIComponent(input.profileId)}&headless=true&redirect_url=${encodeURIComponent(input.redirectUrl)}&state=${encodeURIComponent(input.state)}`,
      endpointKind: 'start_connect',
      timeoutMs: 10_000,
    });
    const o = (raw ?? {}) as Record<string, unknown>;
    const authUrl =
      (typeof o.authUrl === 'string' ? o.authUrl : undefined) ??
      (typeof o.url === 'string' ? o.url : undefined) ??
      (typeof o.redirectUrl === 'string' ? o.redirectUrl : undefined);
    if (!authUrl) {
      console.warn(`[zernio.startConnect] UNRECOGNIZED authUrl SHAPE: ${JSON.stringify(raw)}`);
      throw new Error('zernio_startConnect_unexpected_response_shape');
    }
    return {
      authUrl,
      state: typeof o.state === 'string' && o.state.length > 0 ? o.state : undefined,
    };
  },

  listLocations: async (input: {
    profileId: string;
    pendingDataToken: string;
    connectToken?: string;
  }) => {
    const raw = await request<unknown>({
      method: 'GET',
      path: `/v1/connect/googlebusiness/locations?profileId=${encodeURIComponent(input.profileId)}&pendingDataToken=${encodeURIComponent(input.pendingDataToken)}`,
      endpointKind: 'list_locations',
      timeoutMs: 10_000,
      headers: input.connectToken ? { 'X-Connect-Token': input.connectToken } : undefined,
    });
    const locations = normalizeLocations(raw);
    return { locations };
  },

  selectLocation: async (input: {
    profileId: string;
    pendingDataToken: string;
    connectToken?: string;
    locationId: string;
    redirectUrl?: string;
  }) => {
    const raw = await request<unknown>({
      method: 'POST',
      path: '/v1/connect/googlebusiness/select-location',
      endpointKind: 'select_location',
      timeoutMs: 15_000,
      headers: input.connectToken ? { 'X-Connect-Token': input.connectToken } : undefined,
      body: {
        profileId: input.profileId,
        locationId: input.locationId,
        pendingDataToken: input.pendingDataToken,
        ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
      },
    });
    const o = (raw ?? {}) as Record<string, unknown>;
    const acctObj = o.account as Record<string, unknown> | undefined;
    const accountId =
      (typeof o.accountId === 'string' ? o.accountId : undefined) ??
      (typeof acctObj?.accountId === 'string' ? (acctObj.accountId as string) : undefined) ??
      (typeof acctObj?._id === 'string' ? (acctObj._id as string) : undefined) ??
      (typeof acctObj?.id === 'string' ? (acctObj.id as string) : undefined) ??
      (typeof o._id === 'string' ? (o._id as string) : undefined) ??
      (typeof o.id === 'string' ? (o.id as string) : undefined);
    if (!accountId) {
      console.warn(`[zernio.selectLocation] UNRECOGNIZED accountId SHAPE: ${JSON.stringify(raw)}`);
      throw new Error('zernio_selectLocation_unexpected_response_shape');
    }
    return { accountId };
  },

  listReviews: async (
    accountId: string,
    input: { locationId: string; pageSize?: number; pageToken?: string },
  ) => {
    const raw = await request<{ reviews: ZernioReview[]; nextPageToken?: string }>({
      method: 'GET',
      path: `/v1/accounts/${encodeURIComponent(accountId)}/gmb-reviews?locationId=${encodeURIComponent(input.locationId)}&pageSize=${input.pageSize ?? 50}${input.pageToken ? `&pageToken=${encodeURIComponent(input.pageToken)}` : ''}`,
      endpointKind: 'list_reviews',
      timeoutMs: 15_000,
    });
    // Normalize reviewReply: Zernio may OMIT the field on unanswered reviews
    // rather than returning explicit null. Downstream code uses
    // `reviewReply !== null` / `=== null` strict-equality predicates which
    // would route an `undefined` reviewReply to the answered branch and then
    // crash on .comment. Force every entry to either null or an object at
    // the API chokepoint. See Code Review fix Medium 1 (2026-05-02).
    const reviews = (raw?.reviews ?? []).map((r) => ({
      ...r,
      reviewReply: r.reviewReply ?? null,
    }));
    return { reviews, nextPageToken: raw?.nextPageToken };
  },

  listAllReviews: async (
    accountId: string,
    opts: { locationId: string; pageSize: number; maxPages: number },
  ): Promise<ZernioReview[]> => {
    const all: ZernioReview[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < opts.maxPages; i++) {
      const page = await zernioClient.listReviews(accountId, {
        locationId: opts.locationId,
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
