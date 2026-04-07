import './env'; // Must be first — loads .env.local before other modules read process.env

import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { Worker, type Job } from 'bullmq';
import { getRedisOptions, QUEUE_NAMES, queues } from './queues';
import { startOutboxPoller, stopOutboxPoller } from './jobs/OutboxPoller';

const PORT = parseInt(process.env.PORT || '3001', 10);

// ---------------------------------------------------------------------------
// Fastify server — health check + webhook ingress
// ---------------------------------------------------------------------------
export const app = Fastify({ logger: true });

// ---------------------------------------------------------------------------
// BullMQ workers — placeholder handlers that log job data
// Each worker gets its own Redis connection via getRedisOptions()
// ---------------------------------------------------------------------------
const redisOpts = getRedisOptions();

function createPlaceholderHandler(queueName: string) {
  return async (job: Job) => {
    console.log(`[${queueName}] Processing job ${job.id}`, JSON.stringify(job.data));
  };
}

const workers = Object.values(QUEUE_NAMES).map(
  (name) => new Worker(name, createPlaceholderHandler(name), { connection: redisOpts }),
);

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

  // Health check
  app.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // Webhook placeholders — implemented in Prompts 10 (Stripe) and 14 (Resend)
  app.post('/ingress/stripe', { config: { rawBody: true } }, async (_request, reply) => {
    reply.status(200).send({ received: true });
  });

  app.post('/ingress/resend', { config: { rawBody: true } }, async (_request, reply) => {
    reply.status(200).send({ received: true });
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  startOutboxPoller();
  console.log(`Worker service running on port ${PORT}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown — close poller, workers, queues, server, DB
// ---------------------------------------------------------------------------
async function shutdown(): Promise<void> {
  console.log('Shutting down worker...');
  stopOutboxPoller();
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
