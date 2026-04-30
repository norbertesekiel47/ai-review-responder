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
import { handleDemoGeneration } from './jobs/DemoGenerationWorker';
import { handleResponseGeneration } from './jobs/ResponseGeneratorWorker';
import { handleSendNotification } from './jobs/NotificationWorker';
import { handlePublishResponse } from './jobs/ResponsePublisherWorker';
import {
  handleZernioReviewIngest,
  ZernioIngestReviewNotFoundError,
  ZernioIngestPaginationCapExhaustedError,
  ZernioIngestUnparseableLocationError,
} from './jobs/ZernioReviewIngestWorker';
import { handleZernioBackfill } from './jobs/ZernioBackfillWorker';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from './jobs/publisher-error-handlers';
import { applyTransientExhaustionFallback } from '../src/lib/publishing/zernio-publisher';
import { ZernioTransientError } from '../src/lib/zernio/errors';
import { extractOutboxHandle, markOutboxCompleted, markOutboxFailed } from '../src/lib/shared/outbox';
import { sql, jsonb } from '../src/lib/db/server';
import { v7 as uuidv7 } from 'uuid';
import type { IngestZernioReviewPayload, ZernioInitialBackfillPayload } from '../src/lib/shared/worker-types';
import { handleAdminException } from './jobs/AdminExceptionWorker';
import { handleWeeklySummary } from './jobs/WeeklySummaryWorker';
import { handlePlaceIdValidation } from './jobs/PlaceIdValidationWorker';
import { handleResendWebhook } from './ingress/resend';
import { handleStripeWebhook } from './ingress/stripe';
import { handleTwilioStatusCallback, handleTwilioInbound } from './ingress/twilio';
import { handleTwilioWhatsAppInbound, handleTwilioWhatsAppStatus } from './ingress/twilio-whatsapp';
import { handleTelegramWebhook } from './ingress/telegram';
import { handleZernioWebhook } from './ingress/zernio';
import { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertZernioPublishingEnv } from './startup-assert';
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
import { handleOwnerEmail } from './jobs/OwnerEmailWorker';
import { handleDrainOwnerConnect } from './jobs/DrainOwnerConnectWorker';
import { startCleanupAbandonedSignupsPoller, stopCleanupAbandonedSignupsPoller } from './jobs/CleanupAbandonedSignupsPoller';
import { startEmailChannelReconcilePoller, stopEmailChannelReconcilePoller } from './jobs/EmailChannelReconcilePoller';
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
// connection at the firing Zernio account, fanned out by worker/ingress/zernio.ts.
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

// Final-attempt exhaustion handler for ZernioReviewIngestWorker. Typed errors
// from the worker (ZernioIngestReviewNotFoundError, ZernioIngestUnparseableLocationError)
// escalate to review_exceptions after BullMQ retries are exhausted; the
// admin notify is deliberately skipped for review_not_found (high-volume
// during Zernio outages would spam admin email; ops watches the table).
ingestZernioReviewWorker.on('failed', async (job, err) => {
  if (!job) return;
  if (job.attemptsMade < (job.opts.attempts ?? 5)) return;  // not yet exhausted

  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  if (err instanceof ZernioIngestReviewNotFoundError) {
    await sql`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_review_not_found', 'open',
        ${jsonb({
          provider: 'zernio',
          provider_review_id: err.zernioReviewId,
          zernio_account_id: err.zernioAccountId,
          zernio_location_id: err.zernioLocationId,
          pages_walked: err.pagesWalked,
          reviews_seen: err.reviewsSeen,
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
    `;
    await markOutboxFailed(outboxId, 'zernio_review_not_found_after_retries', outboxAttempt);
    return;
  }

  // Indeterminate not-found — pagination cap exhausted with more pages still
  // available. Distinct review_exceptions type so ops can triage separately
  // (bump cap, manually reconcile, or accept the gap). No admin notify —
  // potentially high-volume during legitimate large-feed scenarios.
  if (err instanceof ZernioIngestPaginationCapExhaustedError) {
    await sql`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_pagination_cap_exhausted', 'open',
        ${jsonb({
          provider: 'zernio',
          provider_review_id: err.zernioReviewId,
          zernio_account_id: err.zernioAccountId,
          zernio_location_id: err.zernioLocationId,
          cap: err.cap,
          reviews_seen: err.reviewsSeen,
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
    `;
    await markOutboxFailed(outboxId, 'zernio_pagination_cap_exhausted', outboxAttempt);
    return;
  }

  if (err instanceof ZernioIngestUnparseableLocationError) {
    const [exception] = await sql<{ id: string }[]>`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_unparseable_review_name', 'open',
        ${jsonb({
          provider: 'zernio',
          provider_review_id: err.zernioReviewId,
          zernio_account_id: err.zernioAccountId,
          zernio_location_id: err.zernioLocationId,
          review_name_truncated: err.reviewName.slice(0, 500),
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
      RETURNING id
    `;

    if (exception) {
      // Unparseable shape DOES warrant admin notify — signals contract change.
      await sql`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
        VALUES (
          ${uuidv7()}, 'notify_admin_review_exception', 'business',
          ${err.businessId},
          ${jsonb({ review_exception_id: exception.id, business_id: err.businessId })},
          0, 5
        )
      `;
    }
    await markOutboxFailed(outboxId, 'zernio_unparseable_review_name', outboxAttempt);
    return;
  }

  // Anything else: bare markOutboxFailed (existing behavior).
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(outboxId, reason, outboxAttempt);
});

const responseGenWorker = new Worker(QUEUE_NAMES.GENERATE_RESPONSE, handleResponseGeneration, workerOpts);

const notificationWorker = new Worker(QUEUE_NAMES.SEND_NOTIFICATION, handleSendNotification, workerOpts);

const publisherWorker = new Worker(QUEUE_NAMES.PUBLISH_RESPONSE, handlePublishResponse, workerOpts);

// Final-attempt exhaustion handler for ResponsePublisherWorker. BullMQ retries
// transient errors automatically; only the LAST failure (attemptsMade ===
// opts.attempts) reaches this branch as exhaustion. For ZernioTransientError
// at exhaustion we run the graceful-degradation fallback (disconnect + park
// the response + notify owner). For any other unhandled error we just close
// the outbox row so it doesn't sit in `dispatched` forever.
publisherWorker.on('failed', async (job, err) => {
  // Top-level guard: any throw in extractOutboxHandle, markOutboxFailed, or
  // applyTransientExhaustionFallback bubbles into an unhandled promise
  // rejection that could crash the process. Wrap the whole body so we
  // log + Sentry-capture and never leave the outbox row in `dispatched`
  // limbo silently.
  let outboxId: string | undefined;
  let outboxAttempt: number | undefined;
  try {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // not yet exhausted
    const handle = extractOutboxHandle(job.data, job.id!);
    outboxId = handle.outboxId;
    outboxAttempt = handle.attempt;
    // ── ZernioReplyVerificationIndeterminateError (round-8/9) ──────────
    // BEFORE the transient branch — full terminal sequence on retry exhaustion.
    if (err instanceof ZernioReplyVerificationIndeterminateError) {
      await sql.begin(async (tx) => {
        const updated = await tx`
          UPDATE responses
          SET status = 'failed',
              posting_error = 'zernio_reply_verification_indeterminate',
              updated_at = NOW()
          WHERE id = ${err.meta.response_id}
            AND business_id = ${err.meta.business_id}
            AND status IN ('approved', 'edited', 'awaiting_owner_connect')
          RETURNING 1
        `;
        if (updated.count === 0) return;

        const [exception] = await tx<{ id: string }[]>`
          INSERT INTO review_exceptions (
            id, business_id, review_id, response_id, type, payload
          ) VALUES (
            ${uuidv7()}, ${err.meta.business_id}, ${err.meta.review_id},
            ${err.meta.response_id}, 'zernio_reply_verification_indeterminate',
            ${jsonb({
              reason: err.meta.reason,
              zernio_account_id: err.meta.account_id,
              zernio_location_id: err.meta.location_id,
              zernio_review_id: err.meta.zernio_review_id,
              pages_walked: err.meta.pages_walked,
              reviews_seen: err.meta.reviews_seen,
              underlying_error: err.meta.underlying_error,
              retries_exhausted_at: new Date().toISOString(),
            })}
          )
          ON CONFLICT (review_id, type) WHERE status = 'open'
          DO UPDATE SET payload = review_exceptions.payload
          RETURNING id
        `;

        if (exception) {
          await tx`
            INSERT INTO job_outbox (
              id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
            ) VALUES (
              ${uuidv7()}, 'notify_admin_review_exception', 'review',
              ${err.meta.review_id},
              ${jsonb({ review_exception_id: exception.id, business_id: err.meta.business_id })},
              0, 5
            )
          `;
        }
      });
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }

    if (err instanceof ZernioTransientError) {
      // Unwrap PublisherTransientWithContext (round-11/12) so the fallback
      // can pin the disconnect to the attempted account+location.
      const ctx = err instanceof PublisherTransientWithContext ? err.attemptContext : null;
      try {
        await applyTransientExhaustionFallback({
          response_id: ctx?.response_id ?? job.data.response_id,
          business_id: ctx?.business_id ?? job.data.business_id,
          correlation_id: job.data.correlation_id,
          account_id: ctx?.account_id,
          location_id: ctx?.location_id,
        });
        await markOutboxFailed(outboxId, 'zernio_transient_max_attempts', outboxAttempt);
      } catch (fallbackErr) {
        // Fallback itself failed — surface the reason so ops can see it,
        // and still close the outbox so the row doesn't stay `dispatched`.
        const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        console.error(`[publisherWorker] transient-exhaustion fallback failed: ${reason}`);
        Sentry.captureException(fallbackErr, {
          tags: { worker: 'publisher', kind: 'transient_exhaustion_fallback' },
        });
        await markOutboxFailed(
          outboxId,
          `zernio_transient_max_attempts_fallback_failed: ${reason}`,
          outboxAttempt,
        );
      }
      return;
    }
    // Non-transient unhandled error: just close the outbox row.
    const reason = err instanceof Error ? err.message : String(err);
    await markOutboxFailed(outboxId, reason, outboxAttempt);
  } catch (handlerErr) {
    // Last-resort: even the markOutboxFailed call (or extractOutboxHandle,
    // or anything else above) threw. Capture loudly so the row stuck in
    // `dispatched` is observable in Sentry, and attempt one more
    // best-effort markOutboxFailed in case the original throw was upstream.
    console.error('[publisherWorker.on(failed)] handler crashed:', handlerErr);
    Sentry.captureException(handlerErr, {
      tags: { worker: 'publisher', kind: 'on_failed_handler_crash' },
    });
    if (outboxId) {
      const reason = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
      await markOutboxFailed(outboxId, `on_failed_crash: ${reason}`, outboxAttempt).catch(
        (markErr) => {
          console.error('[publisherWorker.on(failed)] best-effort markOutboxFailed failed:', markErr);
        },
      );
    }
  }
});

const adminExceptionWorker = new Worker(QUEUE_NAMES.NOTIFY_ADMIN, handleAdminException, workerOpts);

const weeklySummaryWorker = new Worker(QUEUE_NAMES.WEEKLY_SUMMARY, handleWeeklySummary, workerOpts);

const placeIdValidationWorker = new Worker(QUEUE_NAMES.VALIDATE_PLACE_ID, handlePlaceIdValidation, workerOpts);

const monthlyImpactWorker = new Worker(QUEUE_NAMES.SEND_MONTHLY_IMPACT, handleMonthlyImpact, workerOpts);

const engagementAlertWorker = new Worker(QUEUE_NAMES.ENGAGEMENT_ALERT, handleEngagementAlert, workerOpts);

const rankingTrackingWorker = new Worker(QUEUE_NAMES.TRACK_RANKING, handleTrackRanking, workerOpts);

const onboardingDripWorker = new Worker(QUEUE_NAMES.ONBOARDING_DRIP, handleOnboardingDrip, workerOpts);

const ownerEmailWorker = new Worker(QUEUE_NAMES.SEND_OWNER_EMAIL, handleOwnerEmail, workerOpts);

const drainOwnerConnectWorker = new Worker(QUEUE_NAMES.DRAIN_OWNER_CONNECT, handleDrainOwnerConnect, workerOpts);

const workers = [demoWorker, ingestZernioReviewWorker, zernioBackfillWorker, responseGenWorker, notificationWorker, publisherWorker, adminExceptionWorker, weeklySummaryWorker, placeIdValidationWorker, monthlyImpactWorker, engagementAlertWorker, rankingTrackingWorker, onboardingDripWorker, ownerEmailWorker, drainOwnerConnectWorker];

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
export { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertZernioPublishingEnv } from './startup-assert';

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
