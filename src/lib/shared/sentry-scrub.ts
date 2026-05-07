type ScrubbableSentryEvent = {
  extra?: unknown;
  request?: {
    headers?: unknown;
    data?: unknown;
  };
};

interface ScrubSentryEventOptions {
  scrubRequestData?: boolean;
}

const SENSITIVE_KEY_RE = /key|secret|token|password|authorization/i;

export function scrubObject(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (SENSITIVE_KEY_RE.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      scrubObject(value as Record<string, unknown>);
    }
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
  return event;
}
