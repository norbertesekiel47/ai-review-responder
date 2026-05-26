// Keep this allowlist in sync with the event_name CHECK constraint in
// supabase/migrations/046_analytics_events.sql. A drift guard in
// migration-046-analytics-events.test.ts fails the build if they diverge.
export const ANALYTICS_EVENT_NAMES = [
  'signup_started',
  'email_verified',
  'sample_demo_started',
  'sample_demo_to_signup',
  'gbp_connect_started',
  'gbp_connect_failed',
  'gbp_connected',
  'first_review_ingested',
  'first_response_drafted',
  'activation_completed',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

const EVENT_NAME_SET = new Set<string>(ANALYTICS_EVENT_NAMES);

const BLOCKED_PROPERTY_KEYS = new Set([
  'approval_token',
  'approval_token_hash',
  'raw_token',
  'connect_token',
  'access_token',
  'refresh_token',
  'response_text',
  'review_text',
  'raw_review',
  'secret',
  'api_key',
]);

const BLOCKED_NORMALIZED_PROPERTY_KEYS = new Set([
  'approvaltoken',
  'approvaltokenhash',
  'rawtoken',
  'connecttoken',
  'accesstoken',
  'refreshtoken',
  'responsetext',
  'reviewtext',
  'rawreview',
  'apikey',
]);

function isBlockedPropertyKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  const normalizedKey = lowerKey.replace(/[^a-z0-9]/g, '');
  return (
    BLOCKED_PROPERTY_KEYS.has(lowerKey) ||
    BLOCKED_NORMALIZED_PROPERTY_KEYS.has(normalizedKey) ||
    lowerKey.includes('token') ||
    lowerKey.includes('secret') ||
    lowerKey.includes('password')
  );
}

export function isAnalyticsEventName(value: string): value is AnalyticsEventName {
  return EVENT_NAME_SET.has(value);
}

export function makeAnalyticsEventKey(
  eventName: AnalyticsEventName,
  parts: Array<string | number | null | undefined>,
): string {
  const suffix = parts
    .filter((part): part is string | number => part !== null && part !== undefined && part !== '')
    .map((part) => String(part).replace(/:/g, '_'))
    .join(':');
  return `${eventName}:${suffix}`;
}

export function sanitizeAnalyticsProperties(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isBlockedPropertyKey(key)) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = sanitizeAnalyticsProperties(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) {
        output[key] = nested;
      }
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
    }
  }
  return output;
}
