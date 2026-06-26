import { PostHog } from 'posthog-node';
import { getServerConfig } from '@/lib/config/server';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

type PostHogClient = InstanceType<typeof PostHog>;

export type CaptureAnalyticsEventInput = {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
  /** Historical event time. Omit for live events (PostHog defaults to now). */
  timestamp?: Date;
  /** Deterministic dedup id. PostHog dedupes events that share a uuid. */
  uuid?: string;
};

let client: PostHogClient | null | undefined;

function getPostHogClient(): PostHogClient | null {
  if (client !== undefined) {
    return client;
  }

  const cfg = getServerConfig();
  const apiKey = cfg.POSTHOG_API_KEY;
  if (!apiKey) {
    client = null;
    return client;
  }

  client = new PostHog(apiKey, {
    host: cfg.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
  });
  return client;
}

export function isAnalyticsConfigured(): boolean {
  return Boolean(getServerConfig().POSTHOG_API_KEY);
}

export function captureAnalyticsEvent(input: CaptureAnalyticsEventInput): boolean {
  const posthog = getPostHogClient();
  if (!posthog) {
    return false;
  }

  posthog.capture({
    event: input.event,
    distinctId: input.distinctId,
    properties: input.properties,
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    ...(input.uuid !== undefined ? { uuid: input.uuid } : {}),
  });
  return true;
}

export async function flushAnalytics(): Promise<void> {
  const posthog = getPostHogClient();
  if (posthog) {
    await posthog.flush();
  }
}

export async function shutdownAnalytics(): Promise<void> {
  const posthog = client;
  client = undefined;

  if (posthog) {
    await posthog.shutdown();
  }
}
