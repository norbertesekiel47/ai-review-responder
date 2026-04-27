import {
  ZernioAuthError,
  ZernioValidationError,
  ZernioTransientError,
  ZernioPermanentError,
  ZernioReviewNotFoundError,
  ZernioReplyAlreadyExistsError,
} from './errors';
import type { EndpointKind } from './types';

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

// Placeholder — implemented in Task 9.
export const zernioClient = {};
