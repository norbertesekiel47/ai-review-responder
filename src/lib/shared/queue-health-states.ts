// The BullMQ job-count states surfaced by the worker queue-health endpoint
// (worker/internal/queue-health.ts getJobCounts call). Same no-side-effect contract as
// queue-names.ts: this module must never import bullmq/ioredis.
export const QUEUE_HEALTH_JOB_STATES = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'paused',
] as const;

export type QueueHealthJobState = (typeof QUEUE_HEALTH_JOB_STATES)[number];
