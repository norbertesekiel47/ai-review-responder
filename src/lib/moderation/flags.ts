/**
 * Single authoritative owner for the moderation-provider feature flag, as used
 * by the inline moderation path (`moderate.ts`). Mirrors the `<feature>/flags.ts`
 * convention (see `auto-approval/flags.ts`), a one-line wrapper over the shared
 * `readFlag` primitive (byte-for-byte `process.env[name] === 'true'`).
 *
 *   - openaiModerationEnabled(): the OpenAI Moderation API is called in addition
 *     to the always-on local filter.
 *
 * Note: auto-approval's `providerModerationEnabled()` reads the SAME flag for a
 * DIFFERENT feature gate (the auto-approval moderation gate). Two named accessors
 * over one flag for two feature gates is intentional — both route through
 * `readFlag`.
 *
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
import { readFlag } from '@/lib/config/flags';

export function openaiModerationEnabled(): boolean {
  return readFlag('OPENAI_MODERATION_ENABLED');
}
