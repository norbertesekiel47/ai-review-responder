type ScrubbableSentryEvent = {
  extra?: unknown;
  transaction?: unknown;
  breadcrumbs?: unknown;
  request?: {
    url?: unknown;
    query_string?: unknown;
    headers?: unknown;
    data?: unknown;
  };
};

interface ScrubSentryEventOptions {
  scrubRequestData?: boolean;
}

// Object-key scrubber: matches the NAME of a property in extra/headers/data.
const SENSITIVE_KEY_RE = /key|secret|token|password|authorization/i;

// Query-param-name scrubber: a deliberate SUPERSET of SENSITIVE_KEY_RE — URLs
// also carry OAuth/OTP secrets as query values (?code=, ?otp=, ?signature=,
// ?access_token=). Keep it broader than the object-key set; edit both if the
// shared terms (token/secret/key/password/authorization) ever change.
const SENSITIVE_QUERY_KEY_RE =
  /token|secret|key|password|authorization|code|otp|signature|access_token/i;

/**
 * Mask sensitive VALUES in a bare query string (`a=1&code=x`, with or without a
 * leading `?`). Shared by the URL scrubber and the request.query_string scrubber.
 * Total: never throws; preserves the leading `?` if present.
 */
function redactQueryString(query: string): string {
  const leading = query.startsWith('?') ? '?' : '';
  const body = leading ? query.slice(1) : query;
  if (body.length === 0) return query;

  const redacted = body
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      let decodedKey = rawKey;
      try {
        decodedKey = decodeURIComponent(rawKey);
      } catch {
        // malformed percent-encoding — match against the raw key instead
      }
      return SENSITIVE_QUERY_KEY_RE.test(decodedKey) ? `${rawKey}=[REDACTED]` : pair;
    })
    .join('&');

  return `${leading}${redacted}`;
}

/**
 * Mask sensitive values inside a URL string before it reaches Sentry. The
 * key-based object scrubber can't reach these because they are VALUES, not keys:
 *   - the path segment after `/approve/` (single-use approval tokens), and
 *   - query-param values whose key looks sensitive (token/code/otp/…).
 *
 * Pure + total: never throws (no `new URL()`, which rejects relative inputs),
 * handles absolute and relative URLs, and returns non-matching input unchanged.
 */
export function redactSensitivePathsAndQueries(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;

  const hashIdx = url.indexOf('#');
  const fragment = hashIdx === -1 ? '' : url.slice(hashIdx);
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);

  const qIdx = beforeHash.indexOf('?');
  const path = qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);
  const query = qIdx === -1 ? '' : beforeHash.slice(qIdx + 1);

  const redactedPath = path.replace(/(\/approve\/)[^/?#\s]+/gi, '$1[REDACTED]');
  const redactedQuery = query ? `?${redactQueryString(query)}` : '';

  return `${redactedPath}${redactedQuery}${fragment}`;
}

// Array-of-[key,value]-pairs form of query_string: mask the value where the key
// looks sensitive. Mutates pairs in place.
function redactQueryPairs(pairs: unknown[]): unknown[] {
  for (const pair of pairs) {
    if (
      Array.isArray(pair) &&
      pair.length >= 2 &&
      typeof pair[0] === 'string' &&
      SENSITIVE_QUERY_KEY_RE.test(pair[0])
    ) {
      pair[1] = '[REDACTED]';
    }
  }
  return pairs;
}

// Object-map form of query_string: mask values whose key looks sensitive.
function redactQueryObject(obj: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_QUERY_KEY_RE.test(key)) obj[key] = '[REDACTED]';
  }
  return obj;
}

/**
 * Scrub Sentry's request.query_string, which carries the query SEPARATELY from
 * request.url and varies by SDK/runtime: a raw string, an object map, or an
 * array of [key, value] pairs. All three can leak ?code=/?token= even after the
 * URL is scrubbed. Mutates structured forms in place; total (never throws).
 */
function redactRequestQueryString(value: unknown): unknown {
  if (typeof value === 'string') return redactQueryString(value);
  if (Array.isArray(value)) return redactQueryPairs(value);
  if (value && typeof value === 'object') {
    return redactQueryObject(value as Record<string, unknown>);
  }
  return value;
}

function scrubObject(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (SENSITIVE_KEY_RE.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          scrubObject(item as Record<string, unknown>);
        }
      }
    } else if (value && typeof value === 'object') {
      scrubObject(value as Record<string, unknown>);
    }
  }
}

// Navigation breadcrumbs carry URLs in data.from / data.to; fetch/xhr in
// data.url; otel/http instrumentation in data['http.url'] (+ data['http.query']
// for the bare query string, handled separately below).
const BREADCRUMB_URL_FIELDS = ['url', 'from', 'to', 'http.url'] as const;

function scrubBreadcrumb(breadcrumb: Record<string, unknown>): void {
  const data = breadcrumb.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const dataObj = data as Record<string, unknown>;
    scrubObject(dataObj); // key-based redaction (e.g. an `authorization` field)
    for (const field of BREADCRUMB_URL_FIELDS) {
      const value = dataObj[field];
      if (typeof value === 'string') {
        dataObj[field] = redactSensitivePathsAndQueries(value);
      }
    }
    const httpQuery = dataObj['http.query'];
    if (typeof httpQuery === 'string') {
      dataObj['http.query'] = redactQueryString(httpQuery);
    }
  }
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = redactSensitivePathsAndQueries(breadcrumb.message);
  }
}

type ScrubbableRequest = NonNullable<ScrubbableSentryEvent['request']>;

function scrubRequest(request: ScrubbableRequest, scrubRequestData: boolean): void {
  if (request.headers) {
    scrubObject(request.headers as Record<string, unknown>);
  }
  // request.data is the request BODY — gated to the server runtimes only.
  if (scrubRequestData && request.data && typeof request.data === 'object') {
    scrubObject(request.data as Record<string, unknown>);
  }
  // url + query_string are URL-equivalent and carry the same secrets the
  // key-scrub can't reach (values, not keys); scrub them in every runtime.
  if (typeof request.url === 'string') {
    request.url = redactSensitivePathsAndQueries(request.url);
  }
  if (request.query_string !== undefined) {
    request.query_string = redactRequestQueryString(request.query_string);
  }
}

export function scrubSentryEvent<T extends ScrubbableSentryEvent>(
  event: T,
  options: ScrubSentryEventOptions = {},
): T {
  if (event.extra) {
    scrubObject(event.extra as Record<string, unknown>);
  }
  if (event.request && typeof event.request === 'object') {
    scrubRequest(event.request, options.scrubRequestData ?? false);
  }
  if (typeof event.transaction === 'string') {
    event.transaction = redactSensitivePathsAndQueries(event.transaction);
  }
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      if (crumb && typeof crumb === 'object') {
        scrubBreadcrumb(crumb as Record<string, unknown>);
      }
    }
  }

  return event;
}
