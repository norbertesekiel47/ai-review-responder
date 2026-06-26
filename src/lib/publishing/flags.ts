/**
 * Single authoritative owner for the Zernio publishing / external-reply feature
 * flags. Mirrors the `<feature>/flags.ts` convention (see `auto-approval/flags.ts`),
 * each a one-line wrapper over the shared `readFlag` primitive
 * (byte-for-byte `process.env[name] === 'true'`).
 *
 *   - zernioPublishingEnabled():        the Zernio publishing subsystem (connect
 *     flow + webhook ingress + backfill/recent-review polling) is on.
 *   - externalReplyImportEnabled():      import unseen external (Google-direct)
 *     replies as posted responses during ingest reconciliation.
 *   - zernioRecentReviewPollDisabled():  the ZERNIO_RECENT_REVIEW_POLL_DISABLED
 *     kill-switch — its `*_DISABLED` name encodes the meaning; call sites still
 *     read it as `=== 'true'` (true ⇒ the recent-review poller does not start).
 *
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
import { readFlag } from '@/lib/config/flags';

export function zernioPublishingEnabled(): boolean {
  return readFlag('ZERNIO_PUBLISHING_ENABLED');
}

export function externalReplyImportEnabled(): boolean {
  return readFlag('EXTERNAL_REPLY_IMPORT_ENABLED');
}

export function zernioRecentReviewPollDisabled(): boolean {
  return readFlag('ZERNIO_RECENT_REVIEW_POLL_DISABLED');
}
