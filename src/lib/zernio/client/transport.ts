import {
  ZernioAuthError,
  ZernioValidationError,
  ZernioTransientError,
  ZernioPermanentError,
  ZernioReviewNotFoundError,
  ZernioReplyAlreadyExistsError,
} from '../errors';
import { getServerConfig } from '@/lib/config/server';
import type { EndpointKind } from '../types';
import { classifyAndParse } from './error-classifier';

type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface RequestOptions {
  method: HttpMethod;
  path: string;
  endpointKind: EndpointKind;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface ZernioTransportOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface ZernioTransport {
  request<T>(opts: RequestOptions): Promise<T>;
}

export function createZernioTransport(options: ZernioTransportOptions = {}): ZernioTransport {
  return {
    request: (opts) => requestWithOptions(opts, options),
  };
}

export async function request<T>(opts: RequestOptions): Promise<T> {
  return requestWithOptions<T>(opts);
}

// Per-endpoint request dispatcher: the cyclomatic count is the Zernio
// endpoint/error vocabulary, not tangled logic. Pre-existing; PR F did not grow it.
// fallow-ignore-next-line complexity
async function requestWithOptions<T>(
  opts: RequestOptions,
  options: ZernioTransportOptions = {},
): Promise<T> {
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

  // MOCK_EXTERNAL_APIS is still read per-call directly (above, exempt env
  // indicator #2) so toggling works. ZERNIO_API_BASE / ZERNIO_API_KEY now come
  // from the memoized getServerConfig() (Stage-3 zernio-transport batch): env is
  // immutable in prod, so memoized == per-call; per-test overrides reset the memo
  // (resetServerConfigForTests) per Stage-3 convention #6. options.X still wins,
  // and the '' / 'https://zernio.com/api' fallbacks are preserved byte-for-byte.
  const cfg = getServerConfig();
  const apiBase = options.baseUrl ?? cfg.ZERNIO_API_BASE ?? 'https://zernio.com/api';
  const apiKey = options.apiKey ?? cfg.ZERNIO_API_KEY ?? '';

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...opts.headers,
  };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const res = await fetchImpl(`${apiBase}${opts.path}`, {
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

interface MockLocation {
  id: string;
  name: string;
  address: string;
}

// Deterministic mock locations for E2E/local mock mode. Count is driven by
// MOCK_ZERNIO_LOCATION_COUNT so the full ingest→publish loop can be exercised
// against two (or more) locations without a real Google Business Profile.
// Defaults to 1 (preserves single-location mock behavior); any non-numeric or
// sub-1 value is clamped to 1, and the ceiling guards against a typo'd count
// (Number('1e8') is a valid integer) building a giant array in-process.
const MAX_MOCK_LOCATIONS = 50;

function mockLocations(): MockLocation[] {
  const raw = Number(process.env.MOCK_ZERNIO_LOCATION_COUNT ?? 1);
  const count = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, MAX_MOCK_LOCATIONS) : 1;
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      id: `mock-loc-${n}`,
      name: `Mock Location ${n}`,
      address: `123 Mock St #${n}`,
    };
  });
}

// One-case-per-endpoint mock switch; the count is the endpoint vocabulary.
// PR F simplified the list_locations branch (inline array → mockLocations()).
// fallow-ignore-next-line complexity
async function mockResponse<T>(opts: RequestOptions): Promise<T> {
  switch (opts.endpointKind) {
    case 'create_profile':
      return { profileId: `mock-profile-${Date.now()}` } as unknown as T;
    case 'start_connect':
      return {
        authUrl: 'http://localhost:3000/__mock_oauth_complete',
      } as unknown as T;
    case 'list_locations':
      return { locations: mockLocations() } as unknown as T;
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
    case 'delete_reply':
      return undefined as unknown as T;
    default:
      throw new Error(`Unknown endpointKind: ${String(opts.endpointKind)}`);
  }
}
