import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';

// ---------------------------------------------------------------------------
// Redis connection options for BullMQ
// Supports:
//   redis://localhost:6379/1       — local Docker / WSL Redis (development)
//   rediss://default:pw@host:6379  — Railway / TLS-enabled Redis (production)
//   https://host.upstash.io        — Upstash REST URL (legacy, needs REDIS_QUEUE_TOKEN)
// ---------------------------------------------------------------------------
export function getRedisOptions(): RedisOptions {
  const url = process.env.REDIS_QUEUE_URL!;
  const token = process.env.REDIS_QUEUE_TOKEN;

  // Upstash REST URL → extract host and use Redis protocol over TLS
  if (url.startsWith('https://')) {
    return {
      host: new URL(url).hostname,
      port: 6379,
      password: token,
      tls: {},
      maxRetriesPerRequest: null, // Required by BullMQ
    };
  }

  // Standard redis:// or rediss:// URL (local, Railway, or any Redis)
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || token || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

// ---------------------------------------------------------------------------
// Queue names — each maps 1:1 to a job_outbox.topic value
// ---------------------------------------------------------------------------
export const QUEUE_NAMES = {
  SYNC_REVIEWS: 'sync_reviews',
  GENERATE_RESPONSE: 'generate_response',
  SEND_NOTIFICATION: 'send_notification',
  PUBLISH_RESPONSE: 'publish_response',
  GENERATE_DEMO: 'generate_demo',
  WEEKLY_SUMMARY: 'weekly_summary',
  NOTIFY_ADMIN: 'notify_admin_review_exception',
  VALIDATE_PLACE_ID: 'validate_place_id',
  SEND_MONTHLY_IMPACT: 'send_monthly_impact',
  ENGAGEMENT_ALERT: 'engagement_alert',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---------------------------------------------------------------------------
// Queue instances — one per topic
// BullMQ creates its own Redis connections from the options
// ---------------------------------------------------------------------------
const opts = getRedisOptions();

// Default job options: 3 retry attempts with exponential backoff starting at 5s.
// This ensures transient failures (network errors, rate limits) are retried
// automatically instead of relying on the 1-hour OutboxPoller watchdog.
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
};

export const queues = {
  syncReviews: new Queue(QUEUE_NAMES.SYNC_REVIEWS, { connection: opts, defaultJobOptions }),
  generateResponse: new Queue(QUEUE_NAMES.GENERATE_RESPONSE, { connection: opts, defaultJobOptions }),
  sendNotification: new Queue(QUEUE_NAMES.SEND_NOTIFICATION, { connection: opts, defaultJobOptions }),
  publishResponse: new Queue(QUEUE_NAMES.PUBLISH_RESPONSE, { connection: opts, defaultJobOptions }),
  generateDemo: new Queue(QUEUE_NAMES.GENERATE_DEMO, { connection: opts, defaultJobOptions }),
  weeklySummary: new Queue(QUEUE_NAMES.WEEKLY_SUMMARY, { connection: opts, defaultJobOptions }),
  notifyAdmin: new Queue(QUEUE_NAMES.NOTIFY_ADMIN, { connection: opts, defaultJobOptions }),
  validatePlaceId: new Queue(QUEUE_NAMES.VALIDATE_PLACE_ID, { connection: opts, defaultJobOptions }),
  sendMonthlyImpact: new Queue(QUEUE_NAMES.SEND_MONTHLY_IMPACT, { connection: opts, defaultJobOptions }),
  engagementAlert: new Queue(QUEUE_NAMES.ENGAGEMENT_ALERT, { connection: opts, defaultJobOptions }),
} as const;

// Lookup table: outbox topic string → Queue instance
export const topicToQueue: Record<string, Queue> = {
  [QUEUE_NAMES.SYNC_REVIEWS]: queues.syncReviews,
  [QUEUE_NAMES.GENERATE_RESPONSE]: queues.generateResponse,
  [QUEUE_NAMES.SEND_NOTIFICATION]: queues.sendNotification,
  [QUEUE_NAMES.PUBLISH_RESPONSE]: queues.publishResponse,
  [QUEUE_NAMES.GENERATE_DEMO]: queues.generateDemo,
  [QUEUE_NAMES.WEEKLY_SUMMARY]: queues.weeklySummary,
  [QUEUE_NAMES.NOTIFY_ADMIN]: queues.notifyAdmin,
  [QUEUE_NAMES.VALIDATE_PLACE_ID]: queues.validatePlaceId,
  [QUEUE_NAMES.SEND_MONTHLY_IMPACT]: queues.sendMonthlyImpact,
  [QUEUE_NAMES.ENGAGEMENT_ALERT]: queues.engagementAlert,
};
