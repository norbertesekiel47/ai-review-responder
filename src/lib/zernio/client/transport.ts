import {
  ZernioAuthError,
  ZernioValidationError,
  ZernioTransientError,
  ZernioPermanentError,
  ZernioReviewNotFoundError,
  ZernioReplyAlreadyExistsError,
} from '../errors';
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

  // Read env on every call (NOT module-level) so MOCK_EXTERNAL_APIS toggling
  // and per-test env overrides work correctly.
  const apiBase = options.baseUrl ?? process.env.ZERNIO_API_BASE ?? 'https://zernio.com/api';
  const apiKey = options.apiKey ?? process.env.ZERNIO_API_KEY ?? '';

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
    default:
      throw new Error(`Unknown endpointKind: ${String(opts.endpointKind)}`);
  }
}
