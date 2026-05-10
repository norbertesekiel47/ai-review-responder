/**
 * Canonical queue-name registry. Source of truth for BOTH the Railway
 * worker (`worker/queues.ts` instantiates BullMQ Queues) AND the Vercel
 * admin API (`/api/admin/jobs` queries queue health) so neither can
 * drift behind the other as Sprint 5/6 added new queues.
 *
 * This module MUST NOT import `bullmq`, `ioredis`, or anything that
 * touches `process.env.REDIS_QUEUE_URL` at module scope — the Next.js
 * admin route imports it inside a serverless function where REDIS_QUEUE_URL
 * may not be available, and any top-level side effect would crash the route.
 */
export const QUEUE_NAMES = {
  INGEST_ZERNIO_REVIEW: 'ingest_zernio_review',
  ZERNIO_INITIAL_BACKFILL: 'zernio_initial_backfill',
  GENERATE_RESPONSE: 'generate_response',
  SEND_NOTIFICATION: 'send_notification',
  PUBLISH_RESPONSE: 'publish_response',
  GENERATE_DEMO: 'generate_demo',
  WEEKLY_SUMMARY: 'weekly_summary',
  NOTIFY_ADMIN: 'notify_admin_review_exception',
  VALIDATE_PLACE_ID: 'validate_place_id',
  SEND_MONTHLY_IMPACT: 'send_monthly_impact',
  ENGAGEMENT_ALERT: 'engagement_alert',
  TRACK_RANKING: 'track_ranking',
  ONBOARDING_DRIP: 'onboarding_drip',
  DRAIN_OWNER_CONNECT: 'drain_pending_owner_connect',
  SEND_OWNER_EMAIL: 'send_owner_email',
  ONBOARDING_DEMO_RESPONSE: 'onboarding_demo_response',
  UPDATE_STRIPE_OVERAGE: 'update_stripe_overage_quantity',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Immutable list of every queue the worker operates on. */
export const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES) as readonly QueueName[];
