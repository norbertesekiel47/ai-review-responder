import { PostHog } from 'posthog-node';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

type PostHogClient = InstanceType<typeof PostHog>;

export type CaptureAnalyticsEventInput = {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
};

let client: PostHogClient | null | undefined;

function getPostHogClient(): PostHogClient | null {
  if (client !== undefined) {
    return client;
  }

  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    client = null;
    return client;
  }

  client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
  });
  return client;
}

export function isAnalyticsConfigured(): boolean {
  return Boolean(process.env.POSTHOG_API_KEY);
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
