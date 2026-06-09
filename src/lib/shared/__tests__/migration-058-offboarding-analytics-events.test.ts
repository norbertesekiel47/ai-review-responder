import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_EVENT_NAMES } from '@/lib/analytics/events';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/058_offboarding_analytics_events.sql'),
  'utf8',
);

describe('migration 058 - owner offboarding analytics events', () => {
  it('replaces the analytics event_name check constraint idempotently', () => {
    expect(sql).toMatch(/ALTER TABLE analytics_events\s+DROP CONSTRAINT IF EXISTS analytics_events_event_name_check/i);
    expect(sql).toMatch(/ALTER TABLE analytics_events\s+ADD CONSTRAINT analytics_events_event_name_check/i);
    expect(sql).toMatch(/CHECK\s*\(\s*event_name IN\s*\(/i);
  });

  it('keeps the existing analytics event allowlist and adds only offboarding lifecycle events', () => {
    for (const eventName of [
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
      'offboarding_started',
      'offboarding_reactivated',
      'offboarding_teardown_completed',
      'offboarding_purged',
    ]) {
      expect(sql).toMatch(new RegExp(`'${eventName}'`, 'i'));
    }
    expect(sql).not.toMatch(/NEXT_PUBLIC_/i);
    expect(sql).not.toMatch(/posthog-js/i);
  });

  it('keeps the effective event_name CHECK list in sync with ANALYTICS_EVENT_NAMES', () => {
    const checkMatch = sql.match(/event_name IN\s*\(([^)]*)\)/i);
    expect(checkMatch).not.toBeNull();
    const namesInCheck = [...checkMatch![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(namesInCheck).toEqual([...ANALYTICS_EVENT_NAMES].sort());
  });
});
