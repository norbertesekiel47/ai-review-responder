import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_EVENT_NAMES,
  isAnalyticsEventName,
  isClientEnqueueableEventName,
  makeAnalyticsEventKey,
  sanitizeAnalyticsProperties,
} from '../events';

describe('analytics events', () => {
  it('contains exactly the Wave 2 activation event names', () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual([
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
    ]);
  });

  it('rejects unknown event names', () => {
    expect(isAnalyticsEventName('signup_started')).toBe(true);
    expect(isAnalyticsEventName('freeform_event')).toBe(false);
  });

  it('only allows client-intent events to be enqueued from the browser', () => {
    // Intent events the client may post.
    for (const name of [
      'signup_started',
      'sample_demo_started',
      'sample_demo_to_signup',
      'gbp_connect_started',
      'gbp_connect_failed',
    ]) {
      expect(isClientEnqueueableEventName(name)).toBe(true);
    }
    // Durable, server/worker-owned facts must NOT be client-postable.
    for (const name of [
      'email_verified',
      'gbp_connected',
      'first_review_ingested',
      'first_response_drafted',
      'activation_completed',
    ]) {
      expect(isClientEnqueueableEventName(name)).toBe(false);
    }
  });

  it('creates deterministic idempotency keys', () => {
    expect(makeAnalyticsEventKey('first_response_drafted', ['acct-1'])).toBe('first_response_drafted:acct-1');
  });

  it('drops sensitive properties', () => {
    const result = sanitizeAnalyticsProperties({
      account_id: 'acct-1',
      response_text: 'secret response',
      approval_token: 'raw-token',
      nested: { user_agent: 'ok', review_text: 'secret review' },
    });
    expect(result).toEqual({
      account_id: 'acct-1',
      nested: { user_agent: 'ok' },
    });
  });

  it('drops nested camelCase and generic sensitive properties', () => {
    const result = sanitizeAnalyticsProperties({
      account_id: 'acct-1',
      responseText: 'secret response',
      reviewText: 'secret review',
      approvalToken: 'raw-token',
      nested: {
        user_agent: 'ok',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        apiKey: 'api-key',
        databasePassword: 'password',
        sharedSecret: 'secret',
      },
    });

    expect(result).toEqual({
      account_id: 'acct-1',
      nested: { user_agent: 'ok' },
    });
  });
});
