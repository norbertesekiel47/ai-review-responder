type ScrubbableSentryEvent = {
  extra?: unknown;
  transaction?: unknown;
  breadcrumbs?: unknown;
  exception?: {
    values?: unknown;
  };
  message?: unknown;
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

// Approval tokens are one path segment and the surrounding contracts depend on
// it: `/api/approve/<token>/edit` must keep `/edit`, and the console-message
// form `GET /approve/tok 200` must keep the status. Segment-bounded, and it
// stays that way.
const APPROVE_TOKEN_PATH_RE = /(\/approve\/)[^/?#\s]+/gi;

// Unsubscribe tokens get their own rule because they must be redacted ACROSS
// `/`: a token carrying `%2F` decodes into a second path segment, which a
// segment-bounded rule would leave half-exposed. Longest prefix first so
// `/api/u/` matches as a whole rather than via the `/u/` alternative. Still
// stops at `?`, `#` and whitespace, preserving the console-message contract.
const UNSUBSCRIBE_TOKEN_PATH_RE = /(\/ingress\/unsubscribe\/|\/api\/u\/|\/u\/)[^?#\s]+/gi;

/**
 * Mask sensitive values inside a URL string before it reaches Sentry or the
 * Fastify request logger. The key-based object scrubber can't reach these
 * because they are VALUES, not keys:
 *   - the path segment after `/approve/` (single-use approval tokens),
 *   - everything after an unsubscribe prefix (#644 Unsubscribe tokens,
 *     invariant #5), and
 *   - query-param values whose key looks sensitive (token/code/otp/…).
 *
 * Pure + total: never throws (no `new URL()`, which rejects relative inputs),
 * handles absolute and relative URLs, and returns non-matching input unchanged.
 *
 * The input MUST be URL-SHAPED. Everything after the first `?` is treated as a
 * query string, so over free prose this mangles the message: `"Zernio ingest
 * failed? code=X batch=7"` loses `batch=7`. Use `redactSensitiveTokenPaths`
 * below for prose — `msg`, `err.message`, `err.stack`. Callers that hold a real
 * URL (`request.url`, `event.transaction`, breadcrumb URLs) want this one.
 */
export function redactSensitivePathsAndQueries(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;

  const hashIdx = url.indexOf('#');
  const fragment = hashIdx === -1 ? '' : url.slice(hashIdx);
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);

  const qIdx = beforeHash.indexOf('?');
  const path = qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);
  const query = qIdx === -1 ? '' : beforeHash.slice(qIdx + 1);

  const redactedQuery = query ? `?${redactQueryString(query)}` : '';

  return `${redactTokenPaths(path)}${redactedQuery}${redactTokenPaths(fragment)}`;
}

/**
 * The PROSE-SAFE half: token paths only, no query-string handling at all.
 *
 * Written for the Fastify ingress logger's pino censor, which feeds it `msg`,
 * `err.message` and `err.stack` — free text from Stripe, Resend, Telegram,
 * Twilio and Zernio, not URLs. `redactSensitivePathsAndQueries` treats
 * everything after the first `?` as a query string, so on a message like
 * `"Zernio ingest failed? code=REVIEW_CREATED batch=7"` it deleted `batch=7`,
 * and one `key=` inside a stack frame deleted every frame after it. Invariant #5
 * needs only PATH redaction there: the token is a path segment and is never a
 * query parameter on either surface.
 *
 * No span-splitting is needed because both token regexes already stop at `?`,
 * `#` and whitespace — so a `?` in prose bounds the match rather than
 * reinterpreting the remainder. Total: never throws, returns non-matching input
 * byte-for-byte unchanged.
 *
 * Sentry keeps the full URL+query treatment; do NOT swap this in there, or
 * `?api_key=SECRET` starts reaching the event.
 */
export function redactSensitiveTokenPaths(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return redactTokenPaths(text);
}

/**
 * Both token rules over one span. Applying it to the fragment as well as the
 * path is purely additive: a real URL fragment never reaches a server, so it
 * cannot carry a live token, and neither shipped fragment contract
 * (`/approve/tok#section`, `/u/tok#done`) contains a redactable prefix.
 */
function redactTokenPaths(span: string): string {
  if (span.length === 0) return span;
  return redactUnsubscribeToken(span.replace(APPROVE_TOKEN_PATH_RE, '$1[REDACTED]'));
}

/**
 * An encoded prefix (`/ingress/%75nsubscribe/…`) routes correctly but misses a
 * literal regex, so the raw spelling alone is not enough. Matching on a decoded
 * copy and redacting the raw string would be wrong — the offsets don't
 * correspond — so the decoded form is what gets returned when only it matches.
 * That is safe precisely because the token is replaced in the same step.
 *
 * The decode pass is single-depth by design: a doubly-encoded prefix
 * (`/ingress/%2575nsubscribe/…`) cannot route, so no genuine token can arrive
 * in that shape.
 */
function redactUnsubscribeToken(path: string): string {
  const redacted = path.replace(UNSUBSCRIBE_TOKEN_PATH_RE, '$1[REDACTED]');
  if (redacted !== path) return redacted;

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return path; // malformed percent-encoding — nothing more we can match on
  }

  const decodedRedacted = decoded.replace(UNSUBSCRIBE_TOKEN_PATH_RE, '$1[REDACTED]');
  return decodedRedacted === decoded ? path : decodedRedacted;
}

// Array-of-[key,value]-pairs form of query_string: rebuild with the value masked
// where the key looks sensitive. Non-mutating on purpose — a frozen input from
// the SDK would make in-place assignment throw inside beforeSend (dropping the
// whole event) or, if swallowed, leak the unredacted value.
function redactQueryPairs(pairs: unknown[]): unknown[] {
  return pairs.map((pair) =>
    Array.isArray(pair) &&
    pair.length >= 2 &&
    typeof pair[0] === 'string' &&
    SENSITIVE_QUERY_KEY_RE.test(pair[0])
      ? [pair[0], '[REDACTED]', ...pair.slice(2)]
      : pair,
  );
}

// Object-map form of query_string: rebuild with values masked where the key
// looks sensitive. Non-mutating for the same frozen-input safety as above.
function redactQueryObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = SENSITIVE_QUERY_KEY_RE.test(key) ? '[REDACTED]' : obj[key];
  }
  return result;
}

/**
 * Scrub Sentry's request.query_string, which carries the query SEPARATELY from
 * request.url and varies by SDK/runtime: a raw string, an object map, or an
 * array of [key, value] pairs. All three can leak ?code=/?token= even after the
 * URL is scrubbed. Returns a redacted copy (never mutates the input); total
 * (never throws), so it is safe in beforeSend even on a frozen event.
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
  // The exception message and the top-level `message` are the LOUDEST channel on
  // the event and were the only unscrubbed one until #719.
  //
  // `captureException(err)` puts the raw `err.message` in
  // `exception.values[].value`, so provider text — Stripe, Resend, Telegram,
  // Twilio, Zernio, and Postgres driver errors that can embed contact handles —
  // reached Sentry verbatim from every queue. This was invisible for as long as
  // it was because the worker previously reported job failures as *breadcrumbs*,
  // which ARE scrubbed above; #719 promoted them to real issues and moved the
  // same text onto the one path with no redaction on it.
  //
  // Uses the URL+query redactor, matching `transaction` and breadcrumb messages
  // rather than the prose-safe `redactSensitiveTokenPaths`. That is the
  // deliberate trade this module already documents: on the Sentry surface a
  // `?api_key=SECRET` must not survive, and the cost is that prose after a bare
  // `?` is truncated.
  if (event.exception && typeof event.exception === 'object') {
    const { values } = event.exception;
    if (Array.isArray(values)) {
      for (const value of values) {
        if (!value || typeof value !== 'object') continue;
        const entry = value as { value?: unknown };
        if (typeof entry.value === 'string') {
          entry.value = redactSensitivePathsAndQueries(entry.value);
        }
      }
    }
  }
  if (typeof event.message === 'string') {
    event.message = redactSensitivePathsAndQueries(event.message);
  }

  return event;
}
