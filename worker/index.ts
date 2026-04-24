import './env'; // Must be first — loads .env.local before other modules read process.env

import * as Sentry from '@sentry/node';

/** Recursively scrub sensitive keys from any object */
function scrubObject(obj: Record<string, unknown>): void {
  const sensitiveKeys = /key|secret|token|password|authorization/i;
  for (const key of Object.keys(obj)) {
    if (sensitiveKeys.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (Array.isArray(obj[key])) {
      for (const item of obj[key] as unknown[]) {
        if (item && typeof item === 'object') {
          scrubObject(item as Record<string, unknown>);
        }
      }
    } else if (obj[key] && typeof obj[key] === 'object') {
      scrubObject(obj[key] as Record<string, unknown>);
    }
  }
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV ?? 'development',
  beforeSend(event) {
    if (event.extra) scrubObject(event.extra as Record<string, unknown>);
    if (event.request?.headers) scrubObject(event.request.headers as Record<string, unknown>);
    if (event.request?.data && typeof event.request.data === 'object') {
      scrubObject(event.request.data as Record<string, unknown>);
    }
    return event;
  },
});

export { Sentry };

import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { Worker } from 'bullmq';
import { getRedisOptions, QUEUE_NAMES, queues } from './queues';
import { startOutboxPoller, stopOutboxPoller } from './jobs/OutboxPoller';
import { startReconciliationPoller, stopReconciliationPoller } from './jobs/ReconciliationPoller';
import { handleDemoGeneration } from './jobs/DemoGenerationWorker';
import { handleReviewSync } from './jobs/ReviewSyncWorker';
import { handleResponseGeneration } from './jobs/ResponseGeneratorWorker';
import { handleSendNotification } from './jobs/NotificationWorker';
import { handlePublishResponse } from './jobs/ResponsePublisherWorker';
import { handleAdminException } from './jobs/AdminExceptionWorker';
import { handleWeeklySummary } from './jobs/WeeklySummaryWorker';
import { handlePlaceIdValidation } from './jobs/PlaceIdValidationWorker';
import { handleResendWebhook } from './ingress/resend';
import { handleStripeWebhook } from './ingress/stripe';
import { handleTwilioStatusCallback, handleTwilioInbound } from './ingress/twilio';
import { handleTwilioWhatsAppInbound, handleTwilioWhatsAppStatus } from './ingress/twilio-whatsapp';
import { handleTelegramWebhook } from './ingress/telegram';
import { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv } from './startup-assert';
import { startNotificationFailoverPoller, stopNotificationFailoverPoller } from './jobs/NotificationFailoverPoller';
import { startWeeklySummaryScheduler, stopWeeklySummaryScheduler } from './jobs/WeeklySummaryScheduler';
import { startArchivalPoller, stopArchivalPoller } from './jobs/ArchivalPoller';
import { handleMonthlyImpact } from './jobs/MonthlyImpactWorker';
import { startMonthlyImpactScheduler, stopMonthlyImpactScheduler } from './jobs/MonthlyImpactScheduler';
import { startEngagementMonitorPoller, stopEngagementMonitorPoller } from './jobs/EngagementMonitorPoller';
import { handleEngagementAlert } from './jobs/EngagementAlertWorker';
import { startRankingTrackingScheduler, stopRankingTrackingScheduler } from './jobs/RankingTrackingScheduler';
import { handleTrackRanking } from './jobs/RankingTrackingWorker';
import { startOnboardingDripScheduler, stopOnboardingDripScheduler } from './jobs/OnboardingDripScheduler';
import { handleOnboardingDrip } from './jobs/OnboardingDripWorker';
import { startCleanupAbandonedSignupsPoller, stopCleanupAbandonedSignupsPoller } from './jobs/CleanupAbandonedSignupsPoller';
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

const reviewSyncWorker = new Worker(QUEUE_NAMES.SYNC_REVIEWS, handleReviewSync, workerOpts);

const responseGenWorker = new Worker(QUEUE_NAMES.GENERATE_RESPONSE, handleResponseGeneration, workerOpts);

const notificationWorker = new Worker(QUEUE_NAMES.SEND_NOTIFICATION, handleSendNotification, workerOpts);

const publisherWorker = new Worker(QUEUE_NAMES.PUBLISH_RESPONSE, handlePublishResponse, workerOpts);

const adminExceptionWorker = new Worker(QUEUE_NAMES.NOTIFY_ADMIN, handleAdminException, workerOpts);

const weeklySummaryWorker = new Worker(QUEUE_NAMES.WEEKLY_SUMMARY, handleWeeklySummary, workerOpts);

const placeIdValidationWorker = new Worker(QUEUE_NAMES.VALIDATE_PLACE_ID, handlePlaceIdValidation, workerOpts);

const monthlyImpactWorker = new Worker(QUEUE_NAMES.SEND_MONTHLY_IMPACT, handleMonthlyImpact, workerOpts);

const engagementAlertWorker = new Worker(QUEUE_NAMES.ENGAGEMENT_ALERT, handleEngagementAlert, workerOpts);

const rankingTrackingWorker = new Worker(QUEUE_NAMES.TRACK_RANKING, handleTrackRanking, workerOpts);

const onboardingDripWorker = new Worker(QUEUE_NAMES.ONBOARDING_DRIP, handleOnboardingDrip, workerOpts);

const workers = [demoWorker, reviewSyncWorker, responseGenWorker, notificationWorker, publisherWorker, adminExceptionWorker, weeklySummaryWorker, placeIdValidationWorker, monthlyImpactWorker, engagementAlertWorker, rankingTrackingWorker, onboardingDripWorker];

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
export { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv } from './startup-assert';

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

  // Fail fast on missing Twilio config when SMS/WhatsApp channels are enabled.
  try {
    assertChannelsSmsEnv();
    assertChannelsTelegramEnv();
    assertChannelsWhatsAppEnv();
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

  await app.listen({ port: PORT, host: '0.0.0.0' });
  startOutboxPoller();
  startReconciliationPoller();
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
  console.log(`Worker service running on port ${PORT}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown — close poller, workers, queues, server, DB
// ---------------------------------------------------------------------------
async function shutdown(): Promise<void> {
  console.log('Shutting down worker...');
  stopOutboxPoller();
  stopReconciliationPoller();
  stopNotificationFailoverPoller();
  stopWeeklySummaryScheduler();
  stopArchivalPoller();
  stopMonthlyImpactScheduler();
  stopEngagementMonitorPoller();
  stopRankingTrackingScheduler();
  stopOnboardingDripScheduler();
  stopCleanupAbandonedSignupsPoller();
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await app.close();

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
