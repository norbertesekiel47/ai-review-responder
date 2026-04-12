import './env'; // Must be first — loads .env.local before other modules read process.env

import * as Sentry from '@sentry/node';

/** Recursively scrub sensitive keys from any object */
function scrubObject(obj: Record<string, unknown>): void {
  const sensitiveKeys = /key|secret|token|password|authorization/i;
  for (const key of Object.keys(obj)) {
    if (sensitiveKeys.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
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
import { handleResendWebhook } from './ingress/resend';
import { handleStripeWebhook } from './ingress/stripe';

const PORT = parseInt(process.env.PORT || '3001', 10);

// ---------------------------------------------------------------------------
// Fastify server — health check + webhook ingress
// ---------------------------------------------------------------------------
export const app = Fastify({ logger: true });

// ---------------------------------------------------------------------------
// BullMQ workers — only create Workers for implemented handlers.
// Placeholder workers burn Redis requests polling for jobs that never arrive.
// Queue instances (in queues.ts) still exist so OutboxPoller can dispatch;
// Queues don't poll, only Workers do.
// ---------------------------------------------------------------------------
const redisOpts = getRedisOptions();

const demoWorker = new Worker(QUEUE_NAMES.GENERATE_DEMO, handleDemoGeneration, {
  connection: redisOpts,
});

const reviewSyncWorker = new Worker(QUEUE_NAMES.SYNC_REVIEWS, handleReviewSync, {
  connection: redisOpts,
});

const responseGenWorker = new Worker(QUEUE_NAMES.GENERATE_RESPONSE, handleResponseGeneration, {
  connection: redisOpts,
});

const notificationWorker = new Worker(QUEUE_NAMES.SEND_NOTIFICATION, handleSendNotification, {
  connection: redisOpts,
});

const publisherWorker = new Worker(QUEUE_NAMES.PUBLISH_RESPONSE, handlePublishResponse, {
  connection: redisOpts,
});

const adminExceptionWorker = new Worker(QUEUE_NAMES.NOTIFY_ADMIN, handleAdminException, {
  connection: redisOpts,
});

const workers = [demoWorker, reviewSyncWorker, responseGenWorker, notificationWorker, publisherWorker, adminExceptionWorker];

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

  await app.listen({ port: PORT, host: '0.0.0.0' });
  startOutboxPoller();
  startReconciliationPoller();
  console.log(`Worker service running on port ${PORT}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown — close poller, workers, queues, server, DB
// ---------------------------------------------------------------------------
async function shutdown(): Promise<void> {
  console.log('Shutting down worker...');
  stopOutboxPoller();
  stopReconciliationPoller();
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
