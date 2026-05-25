import './env'; // Must be first — loads .env.local before other modules read process.env
import './config/startup-side-effect-guard';
import { Sentry } from './sentry';

import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { Worker } from 'bullmq';
import { getRedisOptions, QUEUE_NAMES, queues } from './queues';
import { startOutboxPoller, stopOutboxPoller } from './background/pollers/OutboxPoller';
import { handleDemoGeneration } from './jobs/DemoGenerationWorker';
import { handleResponseGeneration } from './jobs/ResponseGeneratorWorker';
import { handleSendNotification } from './jobs/notification/NotificationWorker';
import { handlePublishResponse } from './jobs/publisher/ResponsePublisherWorker';
import { handlePublisherFailed } from './jobs/publisher/failed-hook';
import { handleZernioReviewIngest } from './jobs/zernio/ZernioReviewIngestWorker';
import { handleIngestFailed } from './jobs/zernio/ingest-failed-hook';
import { handleZernioBackfill } from './jobs/zernio/ZernioBackfillWorker';
import type {
  IngestZernioReviewPayload,
  StripeCheckoutReconcilePayload,
  ZernioInitialBackfillPayload,
} from '../src/lib/shared/worker-types';
import { handleAdminException } from './jobs/AdminExceptionWorker';
import { handleWeeklySummary } from './jobs/WeeklySummaryWorker';
import { handlePlaceIdValidation } from './jobs/PlaceIdValidationWorker';
import { handleResendWebhook } from './ingress/resend';
import { handleStripeWebhook } from './ingress/stripe';
import { handleTwilioStatusCallback, handleTwilioInbound } from './ingress/twilio/twilio';
import { handleTwilioWhatsAppInbound, handleTwilioWhatsAppStatus } from './ingress/twilio/twilio-whatsapp';
import { handleTelegramWebhook } from './ingress/telegram/telegram';
import { handleZernioWebhook } from './ingress/zernio/zernio';
import { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertZernioPublishingEnv } from './config/startup-assert';
import { startNotificationFailoverPoller, stopNotificationFailoverPoller } from './background/pollers/NotificationFailoverPoller';
import { startWeeklySummaryScheduler, stopWeeklySummaryScheduler } from './background/schedulers/WeeklySummaryScheduler';
import { startArchivalPoller, stopArchivalPoller } from './background/pollers/ArchivalPoller';
import { handleMonthlyImpact } from './jobs/MonthlyImpactWorker';
import { startMonthlyImpactScheduler, stopMonthlyImpactScheduler } from './background/schedulers/MonthlyImpactScheduler';
import { startEngagementMonitorPoller, stopEngagementMonitorPoller } from './background/pollers/EngagementMonitorPoller';
import { handleEngagementAlert } from './jobs/EngagementAlertWorker';
import { startRankingTrackingScheduler, stopRankingTrackingScheduler } from './background/schedulers/RankingTrackingScheduler';
import { handleTrackRanking } from './jobs/RankingTrackingWorker';
import { startOnboardingDripScheduler, stopOnboardingDripScheduler } from './background/schedulers/OnboardingDripScheduler';
import { handleOnboardingDrip } from './jobs/OnboardingDripWorker';
import { handleOwnerEmail } from './jobs/OwnerEmailWorker';
import { handleDrainOwnerConnect } from './jobs/DrainOwnerConnectWorker';
import { handleOnboardingDemo } from './jobs/OnboardingDemoWorker';
import { handleUpdateStripeOverage } from './jobs/billing/UpdateStripeOverageWorker';
import { handleStripeCheckoutReconcile } from './jobs/billing/StripeCheckoutReconcileWorker';
import { startCleanupAbandonedSignupsPoller, stopCleanupAbandonedSignupsPoller } from './background/pollers/CleanupAbandonedSignupsPoller';
import { startEmailChannelReconcilePoller, stopEmailChannelReconcilePoller } from './background/pollers/EmailChannelReconcilePoller';
import { startCancellationGracePoller, stopCancellationGracePoller } from './background/pollers/CancellationGracePoller';
import { startStripeLocationsReconcilePoller, stopStripeLocationsReconcilePoller } from './background/pollers/StripeLocationsReconcilePoller';
import { startZernioRecentReviewPoller, stopZernioRecentReviewPoller } from './background/pollers/ZernioRecentReviewPoller';
import { isMockMode } from '../src/lib/shared/mock-mode';

const PORT = parseInt(process.env.PORT || '3001', 10);

// NotificationFailoverPoller gate (Phase 0 update).
//
// Stale detection now gates on notification_deliveries.sent_at (written by
// the dispatcher on every successful send), not delivered_at — so the
// Resend delivery webhook is no longer a prerequisite. The stale branch
// alerts admin directly instead of re-dispatching, so missing delivery
// webhooks no longer cause email re-send spam.
//
// We still short-circuit in mock mode (no real sends happening) and respect
// the explicit NOTIFICATION_FAILOVER_DISABLED escape hatch for local-dev
// ergonomics. RESEND_WEBHOOK_SECRET is no longer consulted here.
//
// See docs/adding-communication-channels.md §3.5.
function shouldRunFailoverPoller(): { run: boolean; reason?: string } {
  if (process.env.NOTIFICATION_FAILOVER_DISABLED === 'true') {
    return { run: false, reason: 'NOTIFICATION_FAILOVER_DISABLED=true' };
  }
  if (isMockMode()) {
    return { run: false, reason: 'MOCK_EXTERNAL_APIS=true (no real sends)' };
  }
  return { run: true };
}

// ---------------------------------------------------------------------------
// Fastify server — health check + webhook ingress
// ---------------------------------------------------------------------------
export const app = Fastify({ logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' } });

// ---------------------------------------------------------------------------
// BullMQ workers — only create Workers for implemented handlers.
// Placeholder workers burn Redis requests polling for jobs that never arrive.
// Queue instances (in queues.ts) still exist so OutboxPoller can dispatch;
// Queues don't poll, only Workers do.
// ---------------------------------------------------------------------------
const redisOpts = getRedisOptions();

// Reduce Redis polling frequency to cut egress costs.
// Default drainDelay is 200ms (5 polls/sec/worker × 7 workers = 35 polls/sec).
// 5000ms cuts that by 25× — still picks up jobs within 5s, which is fine for our SLAs.
const workerOpts = { connection: redisOpts, drainDelay: 5_000 };

const demoWorker = new Worker(QUEUE_NAMES.GENERATE_DEMO, handleDemoGeneration, workerOpts);

// Zernio webhook-driven review ingest. Concurrency 5 — each job is short
// (one listReviews call + processReview). One outbox row per active
// connection at the firing Zernio account, fanned out by worker/ingress/zernio/zernio.ts.
const ingestZernioReviewWorker = new Worker<IngestZernioReviewPayload>(
  QUEUE_NAMES.INGEST_ZERNIO_REVIEW,
  handleZernioReviewIngest,
  workerOpts,
);

// Zernio first-connect backfill. Concurrency 1 — each backfill is heavy
// (up to 4× listAllReviews pages + up to 75 processReview calls).
const zernioBackfillWorker = new Worker<ZernioInitialBackfillPayload>(
  QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL,
  handleZernioBackfill,
  { ...workerOpts, concurrency: 1 },
);

ingestZernioReviewWorker.on('failed', handleIngestFailed);

const responseGenWorker = new Worker(QUEUE_NAMES.GENERATE_RESPONSE, handleResponseGeneration, workerOpts);

const notificationWorker = new Worker(QUEUE_NAMES.SEND_NOTIFICATION, handleSendNotification, workerOpts);

const publisherWorker = new Worker(QUEUE_NAMES.PUBLISH_RESPONSE, handlePublishResponse, workerOpts);

publisherWorker.on('failed', handlePublisherFailed);

const adminExceptionWorker = new Worker(QUEUE_NAMES.NOTIFY_ADMIN, handleAdminException, workerOpts);

const weeklySummaryWorker = new Worker(QUEUE_NAMES.WEEKLY_SUMMARY, handleWeeklySummary, workerOpts);

const placeIdValidationWorker = new Worker(QUEUE_NAMES.VALIDATE_PLACE_ID, handlePlaceIdValidation, workerOpts);

const monthlyImpactWorker = new Worker(QUEUE_NAMES.SEND_MONTHLY_IMPACT, handleMonthlyImpact, workerOpts);

const engagementAlertWorker = new Worker(QUEUE_NAMES.ENGAGEMENT_ALERT, handleEngagementAlert, workerOpts);

const rankingTrackingWorker = new Worker(QUEUE_NAMES.TRACK_RANKING, handleTrackRanking, workerOpts);

const onboardingDripWorker = new Worker(QUEUE_NAMES.ONBOARDING_DRIP, handleOnboardingDrip, workerOpts);

const ownerEmailWorker = new Worker(QUEUE_NAMES.SEND_OWNER_EMAIL, handleOwnerEmail, workerOpts);

const drainOwnerConnectWorker = new Worker(QUEUE_NAMES.DRAIN_OWNER_CONNECT, handleDrainOwnerConnect, workerOpts);

const onboardingDemoWorker = new Worker(QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE, handleOnboardingDemo, workerOpts);

const updateStripeOverageWorker = new Worker(QUEUE_NAMES.UPDATE_STRIPE_OVERAGE, handleUpdateStripeOverage, workerOpts);

const stripeCheckoutReconcileWorker = new Worker<StripeCheckoutReconcilePayload>(
  QUEUE_NAMES.STRIPE_CHECKOUT_RECONCILE,
  handleStripeCheckoutReconcile,
  workerOpts,
);

// Workers map keyed by queue name. Single source of truth for the
// graceful-shutdown loop, Sentry breadcrumb wiring, and any future
// observability hook that needs to enumerate workers without keeping a
// flat array in sync.
const workersByQueue = {
  [QUEUE_NAMES.GENERATE_DEMO]: demoWorker,
  [QUEUE_NAMES.INGEST_ZERNIO_REVIEW]: ingestZernioReviewWorker,
  [QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL]: zernioBackfillWorker,
  [QUEUE_NAMES.GENERATE_RESPONSE]: responseGenWorker,
  [QUEUE_NAMES.SEND_NOTIFICATION]: notificationWorker,
  [QUEUE_NAMES.PUBLISH_RESPONSE]: publisherWorker,
  [QUEUE_NAMES.NOTIFY_ADMIN]: adminExceptionWorker,
  [QUEUE_NAMES.WEEKLY_SUMMARY]: weeklySummaryWorker,
  [QUEUE_NAMES.VALIDATE_PLACE_ID]: placeIdValidationWorker,
  [QUEUE_NAMES.SEND_MONTHLY_IMPACT]: monthlyImpactWorker,
  [QUEUE_NAMES.ENGAGEMENT_ALERT]: engagementAlertWorker,
  [QUEUE_NAMES.TRACK_RANKING]: rankingTrackingWorker,
  [QUEUE_NAMES.ONBOARDING_DRIP]: onboardingDripWorker,
  [QUEUE_NAMES.SEND_OWNER_EMAIL]: ownerEmailWorker,
  [QUEUE_NAMES.DRAIN_OWNER_CONNECT]: drainOwnerConnectWorker,
  [QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE]: onboardingDemoWorker,
  [QUEUE_NAMES.UPDATE_STRIPE_OVERAGE]: updateStripeOverageWorker,
  [QUEUE_NAMES.STRIPE_CHECKOUT_RECONCILE]: stripeCheckoutReconcileWorker,
} as const;

const workers = Object.values(workersByQueue);

// Sentry breadcrumbs on job lifecycle
for (const worker of workers) {
  worker.on('active', (job) => {
    Sentry.addBreadcrumb({ category: 'worker', message: `Started ${job.name} (${job.id})`, level: 'info' });
  });
  worker.on('completed', (job) => {
    Sentry.addBreadcrumb({ category: 'worker', message: `Completed ${job.name} (${job.id})`, level: 'info' });
  });
  worker.on('failed', (job, err) => {
    Sentry.addBreadcrumb({ category: 'worker', message: `Failed ${job?.name} (${job?.id}): ${err.message}`, level: 'error' });
  });
}

// Re-export for use by other modules (ingress handlers, tests)
export { queues, QUEUE_NAMES } from './queues';
export { sql } from '../src/lib/db/server';
export { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertWorkerStartupEnv, assertZernioPublishingEnv } from './config/startup-assert';

// ---------------------------------------------------------------------------
// Startup — register plugins, routes, then listen
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Register raw-body plugin (per-route opt-in, not global)
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  // Fail fast on missing env vars when feature flags are enabled.
  // Log per-flag status so operators can see at a glance what's enabled.
  try {
    assertChannelsSmsEnv();
    assertChannelsTelegramEnv();
    assertChannelsWhatsAppEnv();
    assertSelfServeSignupEnv();
    assertZernioPublishingEnv();
    console.log(
      `[worker] Feature flags: ` +
        `SMS=${process.env.CHANNELS_SMS_ENABLED === 'true' ? 'on' : 'off'}, ` +
        `Telegram=${process.env.CHANNELS_TELEGRAM_ENABLED === 'true' ? 'on' : 'off'}, ` +
        `WhatsApp=${process.env.CHANNELS_WHATSAPP_ENABLED === 'true' ? 'on' : 'off'}, ` +
        `SelfServeSignup=${process.env.SELF_SERVE_SIGNUP_ENABLED === 'true' ? 'on' : 'off'}, ` +
        `ZernioPublishing=${process.env.ZERNIO_PUBLISHING_ENABLED === 'true' ? 'on' : 'off'}`,
    );
  } catch (err) {
    console.error(`[worker] Startup assertion failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Security headers on all worker responses
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  // Health check
  app.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // Stripe webhook ingress — real handler
  app.post('/ingress/stripe', { config: { rawBody: true } }, handleStripeWebhook);

  // Resend delivery webhook — real handler
  app.post('/ingress/resend', { config: { rawBody: true } }, handleResendWebhook);

  // Twilio webhooks — status callbacks + inbound SMS (STOP/START)
  app.post('/ingress/twilio/status', { config: { rawBody: true } }, handleTwilioStatusCallback);
  app.post('/ingress/twilio/inbound', { config: { rawBody: true } }, handleTwilioInbound);

  // Telegram webhook ingress
  app.post('/ingress/telegram', { config: { rawBody: true } }, handleTelegramWebhook);

  // Twilio webhooks — status callbacks + inbound WhatsApp
  app.post('/ingress/twilio/whatsapp-inbound', { config: { rawBody: true } }, handleTwilioWhatsAppInbound);
  app.post('/ingress/twilio/whatsapp-status', { config: { rawBody: true } }, handleTwilioWhatsAppStatus);

  // Zernio webhook ingress — flag-gated inside the handler
  app.post('/ingress/zernio', { config: { rawBody: true } }, handleZernioWebhook);

  await app.listen({ port: PORT, host: '0.0.0.0' });
  startOutboxPoller();
  const failoverDecision = shouldRunFailoverPoller();
  if (failoverDecision.run) {
    startNotificationFailoverPoller();
  } else {
    console.log(`[NotificationFailover] Skipped — ${failoverDecision.reason}`);
  }
  startWeeklySummaryScheduler();
  startArchivalPoller();
  startMonthlyImpactScheduler();
  startEngagementMonitorPoller();
  startRankingTrackingScheduler();
  startOnboardingDripScheduler();
  startCleanupAbandonedSignupsPoller();
  startEmailChannelReconcilePoller();
  startCancellationGracePoller();
  startStripeLocationsReconcilePoller();
  startZernioRecentReviewPoller();
  console.log(`Worker service running on port ${PORT}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown — close poller, workers, queues, server, DB
// ---------------------------------------------------------------------------
async function shutdown(): Promise<void> {
  console.log('Shutting down worker...');
  stopOutboxPoller();
  stopNotificationFailoverPoller();
  stopWeeklySummaryScheduler();
  stopArchivalPoller();
  stopMonthlyImpactScheduler();
  stopEngagementMonitorPoller();
  stopRankingTrackingScheduler();
  stopOnboardingDripScheduler();
  stopCleanupAbandonedSignupsPoller();
  stopEmailChannelReconcilePoller();
  stopCancellationGracePoller();
  stopStripeLocationsReconcilePoller();
  stopZernioRecentReviewPoller();
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await app.close();

  const { shutdownAnalytics } = await import('../src/lib/analytics/posthog');
  try {
    await shutdownAnalytics();
  } catch (err) {
    // Best-effort flush — never let analytics block the DB teardown below.
    console.error('shutdownAnalytics failed during worker shutdown', err);
  }

  const { sql } = await import('../src/lib/db/server');
  await sql.end();

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
