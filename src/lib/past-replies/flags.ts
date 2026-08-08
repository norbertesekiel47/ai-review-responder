/**
 * Single authoritative owner for the reply-editing feature flag.
 * Mirrors the `<feature>/flags.ts` convention (see `auto-approval/flags.ts`).
 *
 * `PAST_REPLIES_VIEW_ENABLED` was retired at #678 (spec §6.3a S4): once the
 * **Reviews list** is the consented **Review import**'s only destination, the
 * flag would let `import_decision='accepted'` coexist with the imported reviews
 * landing on a `notFound()`. `EDIT_REPLIES_ENABLED` is **KEPT** — it gates the
 * live-Google mutation, a different and larger risk.
 *
 * With the view flag gone, the old composite (`view && edit`) and the old raw
 * read are the same predicate, so exactly ONE function survives: a second
 * accessor is how the six call sites would silently drift apart again.
 *
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
import { readFlag } from '@/lib/config/flags';

export function editRepliesEnabled(): boolean {
  return readFlag('EDIT_REPLIES_ENABLED');
}
