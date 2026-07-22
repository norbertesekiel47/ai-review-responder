import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

// Boot queues.ts without a real BullMQ/Redis connection so we can assert the
// outbox topic → queue routing (originally the Codex B2 auto_post_notice
// topic-routing test, generalized into a completeness guard in WS3 T3).
vi.mock('../redis-connection', () => ({ getRedisOptions: () => ({}) }));
vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    // queues.ts attaches a non-fatal 'error' listener at module scope (P5);
    // the mock needs an `on` for that import-time wiring to succeed.
    on(): void {}
  },
}));

import { QUEUE_NAMES, ALL_QUEUE_NAMES } from '../../src/lib/shared/queue-names';
import { topicToQueue, queues } from '../queues';

describe('outbox topic → queue routing', () => {
  it('routes EVERY registered queue name to a queue of the same name (completeness)', () => {
    // Any queue added to QUEUE_NAMES without a matching topicToQueue entry
    // (or wired to the wrong Queue) fails here — no per-queue test needed.
    for (const name of ALL_QUEUE_NAMES) {
      expect(topicToQueue[name], `topicToQueue is missing '${name}'`).toBeDefined();
      expect(
        (topicToQueue[name] as unknown as { name: string }).name,
        `topicToQueue['${name}'] routes to the wrong queue`,
      ).toBe(name);
    }
  });

  it('registers the auto_post_notice topic constant and enumerates it in ALL_QUEUE_NAMES', () => {
    expect(QUEUE_NAMES.AUTO_POST_NOTICE).toBe('auto_post_notice');
    expect(ALL_QUEUE_NAMES).toContain('auto_post_notice');
  });

  it('routes the auto_post_notice outbox topic to its own queue', () => {
    const q = topicToQueue['auto_post_notice'];
    expect(q).toBeDefined();
    expect(q).toBe(queues.autoPostNotice);
    expect((q as unknown as { name: string }).name).toBe('auto_post_notice');
  });

  it('registers the Stripe subscription mirror handler in the worker entry point', () => {
    const indexSource = readFileSync(resolve(process.cwd(), 'worker/index.ts'), 'utf8');
    expect(QUEUE_NAMES.STRIPE_SUBSCRIPTION_MIRROR_SYNC).toBe(
      'stripe_subscription_mirror_sync',
    );
    expect(indexSource).toContain('handleStripeSubscriptionMirrorSync(sql, job)');
    expect(indexSource).toContain(
      '[QUEUE_NAMES.STRIPE_SUBSCRIPTION_MIRROR_SYNC]: stripeSubscriptionMirrorSyncWorker',
    );
  });
});
