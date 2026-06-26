/**
 * Single authoritative owner for the notification-delivery feature flags.
 * Mirrors the `<feature>/flags.ts` convention (see `auto-approval/flags.ts`),
 * a one-line wrapper over the shared `readFlag` primitive (byte-for-byte
 * `process.env[name] === 'true'`).
 *
 *   - notificationFailoverDisabled(): the NOTIFICATION_FAILOVER_DISABLED escape
 *     hatch — its `*_DISABLED` name encodes the meaning; the call site still
 *     reads it as `=== 'true'` (true ⇒ the failover poller does not run).
 *
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
import { readFlag } from '@/lib/config/flags';

export function notificationFailoverDisabled(): boolean {
  return readFlag('NOTIFICATION_FAILOVER_DISABLED');
}
