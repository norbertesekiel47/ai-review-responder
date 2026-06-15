import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../src/lib/shared/queue-names';
import { getRedisOptions } from './redis-connection';

// Re-export for existing callers (worker entry points, tests). `getRedisOptions`
// lives in the side-effect-free `redis-connection` module so it can be
// unit-tested without instantiating the Queues below.
export { QUEUE_NAMES, getRedisOptions };

// ---------------------------------------------------------------------------
// Queue names — each maps 1:1 to a job_outbox.topic value. The canonical
// registry lives in src/lib/shared/queue-names.ts (imported above) so the
// admin API can read it without pulling in BullMQ/ioredis module-scope
// side effects. Do NOT redeclare here.
// ---------------------------------------------------------------------------
// Queue instances — one per topic
// BullMQ creates its own Redis connections from the options
// ---------------------------------------------------------------------------
const opts = getRedisOptions();

// Default job options: 3 retry attempts with jittered exponential backoff
// starting at 5s. This ensures transient failures (network errors, rate limits)
// are retried automatically instead of relying on the 1-hour OutboxPoller watchdog.
//
// deep-scan §5.3:
//   - jitter: 0.5 — BullMQ (≥5) randomizes each retry delay into
//     [maxDelay·(1-jitter), maxDelay], i.e. ~[2.5s,5s]→[5s,10s]→[10s,20s]. A
//     provider outage hitting many jobs no longer retries in lockstep
//     (thundering herd against the recovering dependency). Jitter only pulls
//     delays EARLIER than the pure-exponential ceiling, never later — no SLA
//     regression vs the previous fixed 5s/10s/20s schedule.
//   - removeOnComplete/removeOnFail — evict finished job records so BullMQ
//     doesn't retain every finished job forever on the fixed-size **Railway**
//     Redis (the BullMQ queue lives on Railway Redis via REDIS_QUEUE_URL, NOT
//     Upstash). Completed: 24h or last 1000; failed: 7d or last 5000 (the count
//     cap bounds a sustained-outage failed-job pile on the fixed instance).
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000, jitter: 0.5 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800, count: 5_000 },
};

export const queues = {
  ingestZernioReview: new Queue(QUEUE_NAMES.INGEST_ZERNIO_REVIEW, { connection: opts, defaultJobOptions }),
  zernioInitialBackfill: new Queue(QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL, { connection: opts, defaultJobOptions }),
  generateResponse: new Queue(QUEUE_NAMES.GENERATE_RESPONSE, { connection: opts, defaultJobOptions }),
  sendNotification: new Queue(QUEUE_NAMES.SEND_NOTIFICATION, { connection: opts, defaultJobOptions }),
  publishResponse: new Queue(QUEUE_NAMES.PUBLISH_RESPONSE, { connection: opts, defaultJobOptions }),
  generateDemo: new Queue(QUEUE_NAMES.GENERATE_DEMO, { connection: opts, defaultJobOptions }),
  weeklySummary: new Queue(QUEUE_NAMES.WEEKLY_SUMMARY, { connection: opts, defaultJobOptions }),
  notifyAdmin: new Queue(QUEUE_NAMES.NOTIFY_ADMIN, { connection: opts, defaultJobOptions }),
  validatePlaceId: new Queue(QUEUE_NAMES.VALIDATE_PLACE_ID, { connection: opts, defaultJobOptions }),
  sendMonthlyImpact: new Queue(QUEUE_NAMES.SEND_MONTHLY_IMPACT, { connection: opts, defaultJobOptions }),
  engagementAlert: new Queue(QUEUE_NAMES.ENGAGEMENT_ALERT, { connection: opts, defaultJobOptions }),
  trackRanking: new Queue(QUEUE_NAMES.TRACK_RANKING, { connection: opts, defaultJobOptions }),
  onboardingDrip: new Queue(QUEUE_NAMES.ONBOARDING_DRIP, { connection: opts, defaultJobOptions }),
  drainOwnerConnect: new Queue(QUEUE_NAMES.DRAIN_OWNER_CONNECT, { connection: opts, defaultJobOptions }),
  sendOwnerEmail: new Queue(QUEUE_NAMES.SEND_OWNER_EMAIL, { connection: opts, defaultJobOptions }),
  onboardingDemoResponse: new Queue(QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE, { connection: opts, defaultJobOptions }),
  updateStripeOverage: new Queue(QUEUE_NAMES.UPDATE_STRIPE_OVERAGE, { connection: opts, defaultJobOptions }),
  stripeCheckoutReconcile: new Queue(QUEUE_NAMES.STRIPE_CHECKOUT_RECONCILE, { connection: opts, defaultJobOptions }),
  accountOffboardingBillingSchedule: new Queue(QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE, { connection: opts, defaultJobOptions }),
  accountOffboardingEmail: new Queue(QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL, { connection: opts, defaultJobOptions }),
  accountOffboardingReactivation: new Queue(QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION, { connection: opts, defaultJobOptions }),
  accountOffboardingTeardown: new Queue(QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN, { connection: opts, defaultJobOptions }),
  accountOffboardingPurge: new Queue(QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE, { connection: opts, defaultJobOptions }),
  autoPostNotice: new Queue(QUEUE_NAMES.AUTO_POST_NOTICE, { connection: opts, defaultJobOptions }),
} as const;

// Lookup table: outbox topic string → Queue instance
export const topicToQueue: Record<string, Queue> = {
  [QUEUE_NAMES.INGEST_ZERNIO_REVIEW]: queues.ingestZernioReview,
  [QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL]: queues.zernioInitialBackfill,
  [QUEUE_NAMES.GENERATE_RESPONSE]: queues.generateResponse,
  [QUEUE_NAMES.SEND_NOTIFICATION]: queues.sendNotification,
  [QUEUE_NAMES.PUBLISH_RESPONSE]: queues.publishResponse,
  [QUEUE_NAMES.GENERATE_DEMO]: queues.generateDemo,
  [QUEUE_NAMES.WEEKLY_SUMMARY]: queues.weeklySummary,
  [QUEUE_NAMES.NOTIFY_ADMIN]: queues.notifyAdmin,
  [QUEUE_NAMES.VALIDATE_PLACE_ID]: queues.validatePlaceId,
  [QUEUE_NAMES.SEND_MONTHLY_IMPACT]: queues.sendMonthlyImpact,
  [QUEUE_NAMES.ENGAGEMENT_ALERT]: queues.engagementAlert,
  [QUEUE_NAMES.TRACK_RANKING]: queues.trackRanking,
  [QUEUE_NAMES.ONBOARDING_DRIP]: queues.onboardingDrip,
  [QUEUE_NAMES.DRAIN_OWNER_CONNECT]: queues.drainOwnerConnect,
  // Canonical queue-name mapping kept alongside the legacy topic-string
  // aliases so any future writer that uses QUEUE_NAMES.SEND_OWNER_EMAIL
  // as the topic value still routes correctly. The topic-string aliases
  // below remain because that's what the existing outbox writers emit.
  [QUEUE_NAMES.SEND_OWNER_EMAIL]: queues.sendOwnerEmail,
  ['notify_owner_reconnect']: queues.sendOwnerEmail,
  ['notify_owner_connection_lost']: queues.sendOwnerEmail,
  [QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE]: queues.onboardingDemoResponse,
  [QUEUE_NAMES.UPDATE_STRIPE_OVERAGE]: queues.updateStripeOverage,
  [QUEUE_NAMES.STRIPE_CHECKOUT_RECONCILE]: queues.stripeCheckoutReconcile,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE]: queues.accountOffboardingBillingSchedule,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL]: queues.accountOffboardingEmail,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION]: queues.accountOffboardingReactivation,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN]: queues.accountOffboardingTeardown,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE]: queues.accountOffboardingPurge,
  [QUEUE_NAMES.AUTO_POST_NOTICE]: queues.autoPostNotice,
};
