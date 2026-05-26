import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthogMock = vi.hoisted(() => {
  type MockPostHogInstance = {
    apiKey: string;
    options: { host: string };
    capture: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  };

  const instances: MockPostHogInstance[] = [];

  const PostHog = vi.fn(function (
    this: MockPostHogInstance,
    apiKey: string,
    options: { host: string },
  ) {
    this.apiKey = apiKey;
    this.options = options;
    this.capture = vi.fn();
    this.flush = vi.fn(async () => {});
    this.shutdown = vi.fn(async () => {});
    instances.push(this);
  });

  return { instances, PostHog };
});

vi.mock('posthog-node', () => ({
  PostHog: posthogMock.PostHog,
}));

import {
  captureAnalyticsEvent,
  flushAnalytics,
  isAnalyticsConfigured,
  shutdownAnalytics,
} from '../posthog';

describe('PostHog analytics wrapper', () => {
  beforeEach(async () => {
    await shutdownAnalytics();
    vi.unstubAllEnvs();
    posthogMock.PostHog.mockClear();
    posthogMock.instances.length = 0;
  });

  afterEach(async () => {
    await shutdownAnalytics();
    vi.unstubAllEnvs();
  });

  it('no-ops when POSTHOG_API_KEY is unset', () => {
    vi.stubEnv('POSTHOG_API_KEY', '');

    const captured = captureAnalyticsEvent({
      event: 'review_published',
      distinctId: 'business_123',
      properties: { source: 'publisher' },
    });

    expect(captured).toBe(false);
    expect(posthogMock.PostHog).not.toHaveBeenCalled();
    expect(posthogMock.instances).toHaveLength(0);
  });

  it('captures configured events with the configured PostHog host', () => {
    vi.stubEnv('POSTHOG_API_KEY', 'ph_test_key');
    vi.stubEnv('POSTHOG_HOST', 'https://eu.i.posthog.com');

    const captured = captureAnalyticsEvent({
      event: 'review_published',
      distinctId: 'business_123',
      properties: { accountId: 'account_456' },
    });

    expect(captured).toBe(true);
    expect(posthogMock.PostHog).toHaveBeenCalledWith('ph_test_key', {
      host: 'https://eu.i.posthog.com',
    });
    expect(posthogMock.instances[0]?.capture).toHaveBeenCalledWith({
      event: 'review_published',
      distinctId: 'business_123',
      properties: { accountId: 'account_456' },
    });
  });

  it('reports configuration state from POSTHOG_API_KEY presence', () => {
    vi.stubEnv('POSTHOG_API_KEY', '');
    expect(isAnalyticsConfigured()).toBe(false);

    vi.stubEnv('POSTHOG_API_KEY', 'ph_test_key');
    expect(isAnalyticsConfigured()).toBe(true);
  });

  it('flushAnalytics forwards to the client flush when configured', async () => {
    vi.stubEnv('POSTHOG_API_KEY', 'ph_test_key');

    captureAnalyticsEvent({ event: 'first_response_drafted', distinctId: 'acct_1' });
    await flushAnalytics();

    expect(posthogMock.instances[0]?.flush).toHaveBeenCalledTimes(1);
  });

  it('flushAnalytics is a no-op and creates no client when unconfigured', async () => {
    vi.stubEnv('POSTHOG_API_KEY', '');

    await flushAnalytics();

    expect(posthogMock.PostHog).not.toHaveBeenCalled();
    expect(posthogMock.instances).toHaveLength(0);
  });

  it('awaits shutdown and resets lazy state for the next capture', async () => {
    vi.stubEnv('POSTHOG_API_KEY', 'ph_test_key');
    vi.stubEnv('POSTHOG_HOST', 'https://us.i.posthog.com');

    expect(
      captureAnalyticsEvent({
        event: 'first_event',
        distinctId: 'business_123',
      }),
    ).toBe(true);

    const firstClient = posthogMock.instances[0];
    await shutdownAnalytics();

    expect(firstClient?.shutdown).toHaveBeenCalledTimes(1);

    expect(
      captureAnalyticsEvent({
        event: 'second_event',
        distinctId: 'business_123',
      }),
    ).toBe(true);

    expect(posthogMock.PostHog).toHaveBeenCalledTimes(2);
    expect(posthogMock.instances[1]).not.toBe(firstClient);
    expect(posthogMock.instances[1]?.capture).toHaveBeenCalledWith({
      event: 'second_event',
      distinctId: 'business_123',
      properties: undefined,
    });
  });
});
