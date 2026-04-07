import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';

// ---------------------------------------------------------------------------
// Redis connection options for BullMQ
// Supports both Upstash REST-style URLs (https://) and standard Redis URLs
// ---------------------------------------------------------------------------
export function getRedisOptions(): RedisOptions {
  const url = process.env.REDIS_QUEUE_URL!;
  const token = process.env.REDIS_QUEUE_TOKEN;

  // Upstash REST URL → extract host and use Redis protocol
  if (url.startsWith('https://')) {
    return {
      host: new URL(url).hostname,
      port: 6379,
      password: token,
      tls: {},
      maxRetriesPerRequest: null, // Required by BullMQ
    };
  }

  // Standard redis:// or rediss:// URL
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || token || undefined,
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
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---------------------------------------------------------------------------
// Queue instances — one per topic
// BullMQ creates its own Redis connections from the options
// ---------------------------------------------------------------------------
const opts = getRedisOptions();

export const queues = {
  syncReviews: new Queue(QUEUE_NAMES.SYNC_REVIEWS, { connection: opts }),
  generateResponse: new Queue(QUEUE_NAMES.GENERATE_RESPONSE, { connection: opts }),
  sendNotification: new Queue(QUEUE_NAMES.SEND_NOTIFICATION, { connection: opts }),
  publishResponse: new Queue(QUEUE_NAMES.PUBLISH_RESPONSE, { connection: opts }),
  generateDemo: new Queue(QUEUE_NAMES.GENERATE_DEMO, { connection: opts }),
  weeklySummary: new Queue(QUEUE_NAMES.WEEKLY_SUMMARY, { connection: opts }),
  notifyAdmin: new Queue(QUEUE_NAMES.NOTIFY_ADMIN, { connection: opts }),
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
};
