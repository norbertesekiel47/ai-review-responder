/**
 * Single authoritative owner of the `contact_csv_uploads.status` enum (#541).
 * Values must stay in lockstep with migration 086's
 * `contact_csv_uploads_status_check` CHECK constraint — the DB CHECK and this
 * const are the two ends of one contract.
 *
 * Deliberately a standalone dependency-free module (mirrors
 * `subscription-status.ts`): the client island, the domain modules, the worker
 * handler, and the failed-hook all import these constants, and the client
 * import must not drag `node:crypto`/outbox code into the browser bundle.
 */

export const UPLOAD_STATUSES = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type ContactUploadStatus =
  (typeof UPLOAD_STATUSES)[keyof typeof UPLOAD_STATUSES];

/** Terminal statuses — the only values an ingest writer may set alongside a
 *  report + NULLed raw_csv (the terminal-consistency CHECK's happy states). */
export type TerminalUploadStatus =
  | typeof UPLOAD_STATUSES.COMPLETED
  | typeof UPLOAD_STATUSES.FAILED;
