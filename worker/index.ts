import './env'; // Must be first — loads .env.local before other modules read process.env
import './config/startup-side-effect-guard';
import { Sentry } from './sentry';

import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { registerIngressContentTypeParsers } from './config/content-type-parsers';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { getRedisOptions, QUEUE_NAMES, queues, topicToQueue } from './queues';
import { createQueueHealthHandler, QUEUE_HEALTH_JOB_STATES } from './internal/queue-health';
import { withJobLogContext } from './job-log-context';
import { createGracefulShutdown } from './shutdown';
import { startOutboxPoller, stopOutboxPoller } from './background/pollers/OutboxPoller';
import { handleDemoGeneration } from './jobs/DemoGenerationWorker';
import { handleResponseGeneration } from './jobs/ResponseGeneratorWorker';
import { handleSendNotification } from './jobs/notification/NotificationWorker';
import { handleAutoPostNotice } from './jobs/auto-post-notice/AutoPostNoticeWorker';
import { handleEscalationNotice } from './jobs/escalation-notice/EscalationNoticeWorker';
import { handlePendingPostNotice } from './jobs/pending-post-notice/PendingPostNoticeWorker';
import { handleAutonomySuspendedNotice } from './jobs/autonomy-suspended-notice/AutonomySuspendedNoticeWorker';
import { handleAutonomyAdminAlert } from './jobs/AutonomyAdminAlertWorker';
import { handleJudgeVerdict } from './jobs/judge/JudgeWorker';
import { handleJudgeFailed } from './jobs/judge/failed-hook';
import { handlePublishResponse } from './jobs/publisher/ResponsePublisherWorker';
import { handlePublisherFailed } from './jobs/publisher/failed-hook';
import { handleZernioReviewIngest } from './jobs/zernio/ZernioReviewIngestWorker';
import { handleIngestFailed } from './jobs/zernio/ingest-failed-hook';
import { handleZernioBackfill } from './jobs/zernio/ZernioBackfillWorker';
import type {
  IngestZernioReviewPayload,
  AccountOffboardingBillingSchedulePayload,
  AccountOffboardingEmailPayload,
  AccountOffboardingPurgePayload,
  AccountOffboardingReactivationPayload,
  AccountOffboardingTeardownPayload,
  StripeCheckoutReconcilePayload,
  ZernioInitialBackfillPayload,
  SendNotificationPayload,
  AutoPostNoticePayload,
  EscalationNoticePayload,
  PendingPostNoticePayload,
  AutonomySuspendedNoticePayload,
  AutonomyAdminAlertPayload,
  JudgeVerdictPayload,
  PublishResponsePayload,
} from '../src/lib/shared/worker-types';
import { handleAdminException } from './jobs/AdminExceptionWorker';
import { handleWeeklySummary } from './jobs/WeeklySummaryWorker';
import { handlePlaceIdValidation } from './jobs/PlaceIdValidationWorker';
import { handleResendWebhook } from './ingress/resend';
import { handleStripeWebhook } from './ingress/stripe';
import { handleTwilioWhatsAppInbound, handleTwilioWhatsAppStatus } from './ingress/twilio/twilio-whatsapp';
import { handleTelegramWebhook } from './ingress/telegram/telegram';
import { handleZernioWebhook } from './ingress/zernio/zernio';
import { enforceIngressRateLimit } from './ingress/rate-limit';
import { assertAccountOffboardingEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertSingleConcurrencyWorker, assertZernioPublishingEnv, warnMissingProductionEnv } from './config/startup-assert';
import { assertWorkerConfig, getWorkerConfig } from '../src/lib/config/worker';
import { selfServeSignupEnabled } from '../src/lib/auth/flags';
import { channelsTelegramEnabled, channelsWhatsappEnabled } from '../src/lib/notifications/channels/flags';
import { notificationFailoverDisabled } from '../src/lib/notifications/flags';
import { zernioPublishingEnabled } from '../src/lib/publishing/flags';
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
import { handleUpdateStripeOverage, type UpdateStripeOveragePayload } from './jobs/billing/UpdateStripeOverageWorker';
import { handleStripeCheckoutReconcile } from './jobs/billing/StripeCheckoutReconcileWorker';
import { handleAccountOffboardingBillingSchedule } from './jobs/account-offboarding/BillingScheduleWorker';
import { handleAccountOffboardingEmail } from './jobs/account-offboarding/AccountOffboardingEmailWorker';
import { handleAccountOffboardingReactivation } from './jobs/account-offboarding/ReactivationWorker';
import { handleAccountOffboardingTeardown } from './jobs/account-offboarding/TeardownWorker';
import { handleAccountOffboardingPurge } from './jobs/account-offboarding/PurgeWorker';
import { startCleanupAbandonedSignupsPoller, stopCleanupAbandonedSignupsPoller } from './background/pollers/CleanupAbandonedSignupsPoller';
import { startEmailChannelReconcilePoller, stopEmailChannelReconcilePoller } from './background/pollers/EmailChannelReconcilePoller';
import { startCancellationGracePoller, stopCancellationGracePoller } from './background/pollers/CancellationGracePoller';
import { startStripeLocationsReconcilePoller, stopStripeLocationsReconcilePoller } from './background/pollers/StripeLocationsReconcilePoller';
import { startZernioRecentReviewPoller, stopZernioRecentReviewPoller } from './background/pollers/ZernioRecentReviewPoller';
import { startAnalyticsDispatchPoller, stopAnalyticsDispatchPoller } from './background/pollers/AnalyticsDispatchPoller';
import { startHealthAlertPoller, stopHealthAlertPoller } from './background/pollers/HealthAlertPoller';
import { startJudgeSweepPoller, stopJudgeSweepPoller } from './background/pollers/JudgeSweepPoller';
import {
  startAutonomyGovernorScheduler,
  stopAutonomyGovernorScheduler,
} from './background/schedulers/AutonomyGovernorScheduler';
import { startAccountOffboardingAccessEndPoller, stopAccountOffboardingAccessEndPoller } from './background/pollers/AccountOffboardingAccessEndPoller';
import { startAccountOffboardingPurgePoller, stopAccountOffboardingPurgePoller } from './background/pollers/AccountOffboardingPurgePoller';
import { startAccountOffboardingPurgeReminderPoller, stopAccountOffboardingPurgeReminderPoller } from './background/pollers/AccountOffboardingPurgeReminderPoller';
import { startAccountOffboardingReactivationResetPoller, stopAccountOffboardingReactivationResetPoller } from './background/pollers/AccountOffboardingReactivationResetPoller';
import { startAccountOffboardingTeardownRetryPoller, stopAccountOffboardingTeardownRetryPoller } from './background/pollers/AccountOffboardingTeardownRetryPoller';
import { isMockMode } from '../src/lib/shared/mock-mode';
import { createWorkerLogger } from '../src/lib/shared/logger';
import { runReadinessProbes } from '../src/lib/shared/readiness';
import { sql, supabaseServer } from '../src/lib/db/server';
import { getCacheRedis } from '../src/lib/db/redis-cache';
import { isCrashNetRecoverableDbError } from '../src/lib/db/transient-error';
import { errorStringProperty } from '../src/lib/payments/stripe-error-inspect';
import { createTransientRejectionGovernor } from './transient-rejection-governor';

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
// See docs/plans/adding-communication-channels.md §3.5.
function shouldRunFailoverPoller(): { run: boolean; reason?: string } {
  if (notificationFailoverDisabled()) {
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
  withJobLogContext<IngestZernioReviewPayload>((job) => handleZernioReviewIngest(sql, job)),
  workerOpts,
);

// Zernio first-connect backfill. Concurrency 1 — each backfill is heavy
// (up to 4× listAllReviews pages + up to 75 processReview calls).
const zernioBackfillWorker = new Worker<ZernioInitialBackfillPayload>(
  QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL,
  (job) => handleZernioBackfill(sql, job),
  { ...workerOpts, concurrency: 1 },
);

ingestZernioReviewWorker.on('failed', (job, err) => handleIngestFailed(sql, job, err));

const responseGenWorker = new Worker(QUEUE_NAMES.GENERATE_RESPONSE, withJobLogContext(handleResponseGeneration), workerOpts);

const notificationWorker = new Worker(QUEUE_NAMES.SEND_NOTIFICATION, withJobLogContext<SendNotificationPayload>((job) => handleSendNotification(sql, job)), workerOpts);

const publisherWorker = new Worker(QUEUE_NAMES.PUBLISH_RESPONSE, withJobLogContext<PublishResponsePayload>((job) => handlePublishResponse(sql, job)), workerOpts);

publisherWorker.on('failed', (job, err) => handlePublisherFailed(sql, job, err));

const autoPostNoticeWorker = new Worker(QUEUE_NAMES.AUTO_POST_NOTICE, withJobLogContext<AutoPostNoticePayload>((job) => handleAutoPostNotice(sql, job)), workerOpts);

const escalationNoticeWorker = new Worker(QUEUE_NAMES.ESCALATION_NOTICE, withJobLogContext<EscalationNoticePayload>((job) => handleEscalationNotice(sql, job)), workerOpts);

const pendingPostNoticeWorker = new Worker(QUEUE_NAMES.PENDING_POST_NOTICE, withJobLogContext<PendingPostNoticePayload>((job) => handlePendingPostNotice(sql, job)), workerOpts);

const autonomySuspendedNoticeWorker = new Worker(
  QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE,
  withJobLogContext<AutonomySuspendedNoticePayload>((job) => handleAutonomySuspendedNotice(sql, job)),
  workerOpts,
);

const autonomyAdminAlertWorker = new Worker(
  QUEUE_NAMES.AUTONOMY_ADMIN_ALERT,
  withJobLogContext<AutonomyAdminAlertPayload>((job) => handleAutonomyAdminAlert(sql, job)),
  workerOpts,
);

const judgeVerdictWorker = new Worker<JudgeVerdictPayload>(
  QUEUE_NAMES.JUDGE_VERDICT,
  withJobLogContext<JudgeVerdictPayload>((job) => handleJudgeVerdict(sql, job)),
  workerOpts,
);

judgeVerdictWorker.on('failed', (job, err) => handleJudgeFailed(sql, job, err));

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

const updateStripeOverageWorker = new Worker<UpdateStripeOveragePayload>(
  QUEUE_NAMES.UPDATE_STRIPE_OVERAGE,
  (job) => handleUpdateStripeOverage(sql, job),
  { ...workerOpts, concurrency: 1 },
);

// Single-consumer invariant: the operation-scoped Stripe idempotency keys
// (overage-sync.ts) assume no two overage jobs for the same account run
// concurrently. The explicit concurrency:1 literal above plus a single
// Railway worker instance guarantees this — keep both. The boot guard reads
// the EFFECTIVE worker options, so any future edit of the options object that
// drops concurrency:1 fails the boot instead of silently double-running jobs.
assertSingleConcurrencyWorker(QUEUE_NAMES.UPDATE_STRIPE_OVERAGE, updateStripeOverageWorker.opts);

const stripeCheckoutReconcileWorker = new Worker<StripeCheckoutReconcilePayload>(
  QUEUE_NAMES.STRIPE_CHECKOUT_RECONCILE,
  (job) => handleStripeCheckoutReconcile(sql, job),
  workerOpts,
);

const accountOffboardingBillingScheduleWorker = new Worker<AccountOffboardingBillingSchedulePayload>(
  QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE,
  withJobLogContext<AccountOffboardingBillingSchedulePayload>((job) => handleAccountOffboardingBillingSchedule(sql, job)),
  workerOpts,
);

const accountOffboardingEmailWorker = new Worker<AccountOffboardingEmailPayload>(
  QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL,
  withJobLogContext<AccountOffboardingEmailPayload>((job) => handleAccountOffboardingEmail(sql, job)),
  workerOpts,
);

const accountOffboardingReactivationWorker = new Worker<AccountOffboardingReactivationPayload>(
  QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION,
  withJobLogContext<AccountOffboardingReactivationPayload>((job) => handleAccountOffboardingReactivation(sql, job)),
  workerOpts,
);

const accountOffboardingTeardownWorker = new Worker<AccountOffboardingTeardownPayload>(
  QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN,
  withJobLogContext<AccountOffboardingTeardownPayload>((job) => handleAccountOffboardingTeardown(sql, job)),
  workerOpts,
);

const accountOffboardingPurgeWorker = new Worker<AccountOffboardingPurgePayload>(
  QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE,
  withJobLogContext<AccountOffboardingPurgePayload>((job) => handleAccountOffboardingPurge(sql, supabaseServer, job)),
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
  [QUEUE_NAMES.AUTO_POST_NOTICE]: autoPostNoticeWorker,
  [QUEUE_NAMES.ESCALATION_NOTICE]: escalationNoticeWorker,
  [QUEUE_NAMES.PENDING_POST_NOTICE]: pendingPostNoticeWorker,
  [QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE]: autonomySuspendedNoticeWorker,
  [QUEUE_NAMES.AUTONOMY_ADMIN_ALERT]: autonomyAdminAlertWorker,
  [QUEUE_NAMES.JUDGE_VERDICT]: judgeVerdictWorker,
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
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE]: accountOffboardingBillingScheduleWorker,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL]: accountOffboardingEmailWorker,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION]: accountOffboardingReactivationWorker,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN]: accountOffboardingTeardownWorker,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE]: accountOffboardingPurgeWorker,
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
export { assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertWorkerStartupEnv, assertZernioPublishingEnv } from './config/startup-assert';

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

  // Accept Twilio's application/x-www-form-urlencoded webhooks. Without a parser
  // for this content type Fastify 415s the Twilio ingress routes at the
  // content-type gate, before the handler (and its rawBody) ever run.
  registerIngressContentTypeParsers(app);

  // Per-IP DoS/abuse backstop on every /ingress/* route (F-21). onRequest runs
  // before body parsing + signature verification; a 429 short-circuits the
  // lifecycle so the handler never runs. checkRateLimit fails open.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/ingress/')) return;
    await enforceIngressRateLimit(request, reply);
  });

  // Fail fast on missing env vars when feature flags are enabled.
  // Log per-flag status so operators can see at a glance what's enabled.
  try {
    // Config-lane core-infra gate (Stage 2). Additive: asserts the same four
    // CORE_INFRA_REQUIRED_ENV vars (with the same non-prod-mock carve-out) that
    // startup-side-effect-guard already asserts via assertCoreInfraEnv, so it
    // cannot fail an env that boots today. Belt-and-suspenders for Stage 3 when
    // worker reads migrate onto getWorkerConfig().
    assertWorkerConfig();
    assertChannelsTelegramEnv();
    assertChannelsWhatsAppEnv();
    assertSelfServeSignupEnv();
    assertZernioPublishingEnv();
    assertAccountOffboardingEnv();
    warnMissingProductionEnv();
    console.log(
      `[worker] Feature flags: ` +
        `Telegram=${channelsTelegramEnabled() ? 'on' : 'off'}, ` +
        `WhatsApp=${channelsWhatsappEnabled() ? 'on' : 'off'}, ` +
        `SelfServeSignup=${selfServeSignupEnabled() ? 'on' : 'off'}, ` +
        `ZernioPublishing=${zernioPublishingEnabled() ? 'on' : 'off'}`,
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

  // Health check — dependency-light (no DB / queue / external calls).
  // Used by external synthetic checks; do not add blocking dependency probes here.
  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'worker',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
  }));

  // Readiness (deep-scan §2.5) — verifies the worker can actually serve:
  // Postgres + BOTH Redis instances (queue = Railway Redis via the same
  // connection options BullMQ uses — incl. the IPv6 `family` hint — on a
  // dedicated lazy probe client, since BullMQ's typings don't expose ping;
  // cache = Upstash). 2s timeout per probe; 503 when any dep is down.
  let queueProbeRedis: Redis | null = null;
  const getQueueProbeRedis = (): Redis => {
    queueProbeRedis ??= new Redis(getRedisOptions());
    return queueProbeRedis;
  };
  app.get('/ready', async (_request, reply) => {
    const result = await runReadinessProbes([
      { name: 'postgres', probe: () => sql`SELECT 1` },
      { name: 'queue_redis', probe: () => getQueueProbeRedis().ping() },
      { name: 'cache_redis', probe: () => getCacheRedis().ping() },
    ]);
    return reply
      .code(result.ready ? 200 : 503)
      .header('Cache-Control', 'no-store')
      .send({
        status: result.ready ? 'ready' : 'unready',
        service: 'worker',
        checks: result.checks,
        timestamp: new Date().toISOString(),
      });
  });

  // Internal queue-health (#408) — bearer-authed per-queue depth for the Vercel
  // admin panel, which can't reach Railway Redis directly (invariant #1). The
  // module owns auth + iteration + response shape; this entry point only wires the
  // BullMQ/Redis deps (invariant #12). Disabled (503) when WORKER_INTERNAL_SECRET
  // is unset, so absence never opens an unauthenticated surface.
  app.get(
    '/internal/queue-health',
    createQueueHealthHandler({
      getSecret: () => getWorkerConfig().WORKER_INTERNAL_SECRET,
      getQueueCounts: (name) => {
        const queue = topicToQueue[name];
        if (!queue) throw new Error(`No queue registered for ${name}`);
        return queue.getJobCounts(...QUEUE_HEALTH_JOB_STATES);
      },
    }),
  );

  // Stripe webhook ingress — real handler
  app.post('/ingress/stripe', { config: { rawBody: true } }, handleStripeWebhook);

  // Resend delivery webhook — real handler
  app.post('/ingress/resend', { config: { rawBody: true } }, handleResendWebhook);

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
  startAnalyticsDispatchPoller();
  startAccountOffboardingAccessEndPoller();
  startAccountOffboardingPurgePoller();
  startAccountOffboardingPurgeReminderPoller();
  startAccountOffboardingReactivationResetPoller();
  startAccountOffboardingTeardownRetryPoller();
  startHealthAlertPoller();
  startJudgeSweepPoller();
  startAutonomyGovernorScheduler();
  console.log(`Worker service running on port ${PORT}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown + last-resort crash net (deep-scan §5.4 + §2.7)
//
// `fatalExitInProgress` is declared FIRST so it is mutually safe with the
// graceful shutdown handler: shutdown bails if a fatal exit is already taking
// the process down (a crash owns the exit), while fatalExit keeps its own guard
// and never bails on a graceful shutdown (it must still be able to force exit(1)
// if shutdown itself wedges). The shutdown orchestration lives in ./shutdown.ts
// (testable with injected fakes); this entry point only wires real deps.
// ---------------------------------------------------------------------------
let fatalExitInProgress = false;

// Watchdog grace window before a wedged shutdown is force-exited. Sized inside
// the Railway SIGTERM→SIGKILL window (default 25s); env-tunable per env-vars.md.
const SHUTDOWN_GRACE_MS = ((): number => {
  const raw = Number(process.env.WORKER_SHUTDOWN_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
})();

const shutdown = createGracefulShutdown({
  graceMs: SHUTDOWN_GRACE_MS,
  isFatalExitInProgress: () => fatalExitInProgress,
  stopBackgroundLoops: () => {
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
    stopAccountOffboardingAccessEndPoller();
    stopAccountOffboardingPurgePoller();
    stopAccountOffboardingPurgeReminderPoller();
    stopAccountOffboardingReactivationResetPoller();
    stopAccountOffboardingTeardownRetryPoller();
    stopHealthAlertPoller();
    stopJudgeSweepPoller();
    stopAutonomyGovernorScheduler();
  },
  // Drain the DB-backed analytics dispatch before the DB pool closes, so we
  // never mark rows completed (or call PostHog) after sql.end().
  drainAnalyticsDispatch: () => stopAnalyticsDispatchPoller(),
  flushAnalytics: async () => {
    const { flushAnalytics } = await import('../src/lib/analytics/posthog');
    await flushAnalytics();
  },
  flushSentry: async () => {
    await Sentry.flush(2_000);
  },
  closeWorkers: async () => {
    await Promise.all(workers.map((w) => w.close()));
  },
  closeQueues: async () => {
    await Promise.all(Object.values(queues).map((q) => q.close()));
  },
  closeServer: () => app.close(),
  shutdownAnalytics: async () => {
    const { shutdownAnalytics } = await import('../src/lib/analytics/posthog');
    await shutdownAnalytics();
  },
  closeDb: async () => {
    const { sql } = await import('../src/lib/db/server');
    await sql.end();
  },
  exit: (code) => process.exit(code),
  armWatchdog: (onTimeout, ms) => {
    const timer = setTimeout(onTimeout, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
  log: (message) => console.log(message),
  logError: (message, err) => (err === undefined ? console.error(message) : console.error(message, err)),
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Last-resort crash net (deep-scan §2.7). BullMQ wraps job-handler rejections,
// but a stray un-awaited promise in a poller/scheduler would otherwise be lost.
// Deliberately minimal — capture to Sentry, one structured log line, exit(1)
// after a short flush so Railway restarts the process. Does NOT call the
// graceful shutdown() above: the process state is unknown after an uncaught
// error. shutdown() reads fatalExitInProgress and no-ops if a crash is already
// in flight, so the two paths never both tear down.
function fatalExit(crashKind: 'unhandledRejection' | 'uncaughtException', err: unknown): void {
  if (fatalExitInProgress) return;
  fatalExitInProgress = true;
  const error = err instanceof Error ? err : new Error(String(err));
  Sentry.captureException(error, { tags: { crash_kind: crashKind } });
  createWorkerLogger('[worker]').error('Fatal process-level error - exiting', { crash_kind: crashKind }, error);
  void Sentry.flush(2_000).then(
    () => process.exit(1),
    () => process.exit(1),
  );
}

// A recoverable infra rejection — a transient Postgres statement-timeout /
// connection drop that surfaced as an un-awaited promise (e.g. postgres.js'
// connection layer rejecting during a boot-burst statement timeout, which
// escapes a poller's OWN try/catch) — is NOT a programmer bug. Crashing the
// whole worker (every in-flight job across all queues) over one transient DB
// blip is the wrong blast radius (Release It! "fail inside boundaries that
// prevent wider collapse"): capture for visibility and let the loop recover on
// its next cycle. A SUSTAINED storm (a path that always fails) still escalates
// to a fatal crash via the governor, so a permanently-broken worker restarts +
// pages instead of running alive-but-broken behind a `SELECT 1` /ready probe.
// Everything else fails fast, and uncaughtException ALWAYS crashes — the stack
// unwound, so process state is genuinely unknown.
const transientRejectionGovernor = createTransientRejectionGovernor();
process.on('unhandledRejection', (reason) => {
  if (isCrashNetRecoverableDbError(reason)) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (transientRejectionGovernor.record(Date.now())) {
      createWorkerLogger('[worker]').error(
        'Transient-DB rejection storm exceeded governor threshold — escalating to crash',
        { code: errorStringProperty(reason, 'code') },
      );
      fatalExit('unhandledRejection', error);
      return;
    }
    Sentry.captureException(error, {
      level: 'warning',
      tags: { crash_kind: 'unhandledRejection', recovered: 'transient_db' },
    });
    createWorkerLogger('[worker]').warn(
      'Recoverable transient-DB rejection — captured, not crashing',
      { code: errorStringProperty(reason, 'code') },
      error,
    );
    return;
  }
  fatalExit('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => fatalExit('uncaughtException', err));

main().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
