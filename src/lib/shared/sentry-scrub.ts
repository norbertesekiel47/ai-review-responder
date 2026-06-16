type ScrubbableSentryEvent = {
  extra?: unknown;
  transaction?: unknown;
  breadcrumbs?: unknown;
  request?: {
    url?: unknown;
    headers?: unknown;
    data?: unknown;
  };
};

interface ScrubSentryEventOptions {
  scrubRequestData?: boolean;
}

const SENSITIVE_KEY_RE = /key|secret|token|password|authorization/i;

const SENSITIVE_QUERY_KEY_RE =
  /token|secret|key|password|authorization|code|otp|signature|access_token/i;

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

  let redactedQuery = '';
  if (query) {
    redactedQuery =
      '?' +
      query
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
          return SENSITIVE_QUERY_KEY_RE.test(decodedKey)
            ? `${rawKey}=[REDACTED]`
            : pair;
        })
        .join('&');
  }

  return `${redactedPath}${redactedQuery}${fragment}`;
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

// Navigation breadcrumbs carry URLs in data.from / data.to; fetch/xhr in data.url.
const BREADCRUMB_URL_FIELDS = ['url', 'from', 'to'] as const;

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
  }
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = redactSensitivePathsAndQueries(breadcrumb.message);
  }
}

export function scrubSentryEvent<T extends ScrubbableSentryEvent>(
  event: T,
  options: ScrubSentryEventOptions = {},
): T {
  if (event.extra) {
    scrubObject(event.extra as Record<string, unknown>);
  }
  if (event.request?.headers) {
    scrubObject(event.request.headers as Record<string, unknown>);
  }
  if (
    options.scrubRequestData &&
    event.request?.data &&
    typeof event.request.data === 'object'
  ) {
    scrubObject(event.request.data as Record<string, unknown>);
  }

  // F-7: redact sensitive VALUES the key-scrub can't reach. Sentry omits these
  // on many events, so every read is defensive.
  if (event.request && typeof event.request.url === 'string') {
    event.request.url = redactSensitivePathsAndQueries(event.request.url);
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
