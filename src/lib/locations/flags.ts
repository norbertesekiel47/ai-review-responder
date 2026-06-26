/**
 * Single authoritative owner for the multi-location feature flag.
 * Mirrors the `<feature>/flags.ts` convention (see `auto-approval/flags.ts`),
 * a one-line wrapper over the shared `readFlag` primitive (byte-for-byte
 * `process.env[name] === 'true'`).
 *
 *   - multiLocationEnabled(): the multi-location subsystem (locations
 *     lifecycle, per-location settings/channels, add-location flow) is on.
 *
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
import { readFlag } from '@/lib/config/flags';

export function multiLocationEnabled(): boolean {
  return readFlag('MULTI_LOCATION_ENABLED');
}
