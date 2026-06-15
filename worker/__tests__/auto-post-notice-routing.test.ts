import { describe, it, expect, vi } from 'vitest';

// Boot queues.ts without a real BullMQ/Redis connection so we can assert the
// outbox topic → queue routing for auto_post_notice (Codex B2 topic-routing test).
vi.mock('../redis-connection', () => ({ getRedisOptions: () => ({}) }));
vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  },
}));

import { QUEUE_NAMES, ALL_QUEUE_NAMES } from '../../src/lib/shared/queue-names';
import { topicToQueue, queues } from '../queues';

describe('auto_post_notice topic routing', () => {
  it('registers the topic constant and enumerates it in ALL_QUEUE_NAMES', () => {
    expect(QUEUE_NAMES.AUTO_POST_NOTICE).toBe('auto_post_notice');
    expect(ALL_QUEUE_NAMES).toContain('auto_post_notice');
  });

  it('routes the auto_post_notice outbox topic to its own queue', () => {
    const q = topicToQueue['auto_post_notice'];
    expect(q).toBeDefined();
    expect(q).toBe(queues.autoPostNotice);
    expect((q as unknown as { name: string }).name).toBe('auto_post_notice');
  });
});
