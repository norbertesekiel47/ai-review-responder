/**
 * Single authoritative owner for the Past Replies / reply-editing feature flags.
 * Mirrors the `<feature>/flags.ts` convention (see `auto-approval/flags.ts`).
 *
 * Three distinct facts — do not conflate them:
 *   - pastRepliesViewEnabled():   the read-only archive view is on.
 *   - replyEditingFlagEnabled():  the RAW `EDIT_REPLIES_ENABLED` flag. The worker
 *     stale-marking path gates on this alone — the view flag is a UI concern
 *     there. Owners flip both together in rollout, so EDIT ⇒ VIEW in practice.
 *   - editRepliesEnabled():       editing posted replies is FULLY enabled — the
 *     user-facing routes require BOTH flags (view + edit).
 *
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
export function pastRepliesViewEnabled(): boolean {
  return process.env.PAST_REPLIES_VIEW_ENABLED === 'true';
}

export function replyEditingFlagEnabled(): boolean {
  return process.env.EDIT_REPLIES_ENABLED === 'true';
}

export function editRepliesEnabled(): boolean {
  return pastRepliesViewEnabled() && replyEditingFlagEnabled();
}
