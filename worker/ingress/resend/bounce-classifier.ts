// Resend bounce classification, moved VERBATIM out of worker/ingress/resend.ts
// (#657 Task 6). It moved for one reason only: the Solicitation lane
// (./solicitation-lane.ts) must reuse this classifier, and exporting it from
// resend.ts would make the lane import its own parent — a cycle. A second
// classifier would be a second owner of "what counts as permanent".
//
// Behaviour is unchanged: same functions, same comments, same 'unknown' → soft
// fail-safe. `isRecord`/`lowerNonEmptyString` stay private to this file.

/**
 * Extracts the bounce type string from a Resend email.bounced payload.
 * Supports multiple payload shapes defensively:
 *   - data.bounce.type     (Resend documented shape)
 *   - data.reason          (legacy/alternate)
 *   - data.status          (legacy/alternate)
 * Returns lowercase string, or 'unknown' if nothing matches.
 */
export function extractBounceType(data: unknown): string {
  if (!isRecord(data)) return 'unknown';

  const bounceType = isRecord(data.bounce)
    ? lowerNonEmptyString(data.bounce.type)
    : null;

  return bounceType
    ?? lowerNonEmptyString(data.reason)
    ?? lowerNonEmptyString(data.status)
    ?? 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function lowerNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0
    ? value.toLowerCase()
    : null;
}

/**
 * Returns true if the bounce type indicates a hard/permanent failure.
 * 'unknown' is treated as soft to avoid flagging businesses on ambiguity.
 *
 * Matches: permanent, hard, hardbounce, hard_bounce, permanent_failure,
 * or any string containing "permanent" (e.g. smtp_permanent_failure).
 *
 * NOTE: The admin overview SQL in src/app/api/admin/overview/route.ts
 * MUST filter on the normalized prefix 'bounced:hard:' so its red-state
 * metrics match this function's decision. See `classifyBounce()` below.
 */
export function isHardBounceType(type: string): boolean {
  const t = type.toLowerCase();
  return (
    t === 'permanent' ||
    t === 'hard' ||
    t === 'hardbounce' ||
    t === 'hard_bounce' ||
    t === 'permanent_failure' ||
    t.includes('permanent')
  );
}

/**
 * Normalizes a raw Resend bounce type into one of two stored kinds:
 *   bounced:hard:<raw>   — flags the business, counts in admin red state
 *   bounced:soft:<raw>   — transient/unknown, logged but no flag
 * Centralizing the classification here guarantees the webhook and the
 * admin red-state query never disagree.
 */
export function classifyBounce(rawType: string): { reason: string; isHard: boolean } {
  const isHard = isHardBounceType(rawType);
  const kind = isHard ? 'hard' : 'soft';
  return {
    reason: `bounced:${kind}:${rawType}`,
    isHard,
  };
}
