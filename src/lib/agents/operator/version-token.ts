// The voice-scope **Version token**: one owner for its shape, its JSONB parse
// site and its equality.
//
// Two callers — `apply.ts` (the stored token and the locked row's token) and
// the apply route's body schema (the client's `expectedVersionToken`). Before
// this module the rule lived in a comment on the voice writer and in the
// literal `{ businessId, updatedAt }` object `buildProposalRows` writes; a
// third spelling in Apply is how the three drift.
//
// TEXT END TO END, and that is the entire design. `readVoiceConfig` and
// `updateVoiceConfig` both return `updated_at::text` verbatim
// (src/lib/responses/voice-settings.ts:85, :152) because postgres.js decodes
// `timestamptz` into a JS `Date`, which holds milliseconds and silently
// truncates the MICROSECONDS Postgres stores (CLAUDE.md's timestamptz gotcha).
// A token built from a round-tripped Date compares EQUAL to a row that was
// written up to a microsecond later — a stale proposal that reads as fresh,
// which is precisely the check this token exists to make. So nothing here
// parses, normalizes or reformats the timestamp: it is an opaque string that
// is compared with `===`.
import { z } from 'zod';

/** The voice scope's freshness stamp, as stored on `prepared_version_token`. */
export interface VoiceVersionToken {
  businessId: string;
  /** `businesses.updated_at::text`, VERBATIM. Never an ISO string, never a Date. */
  updatedAt: string;
}

/**
 * `.strict()`: an unknown key means the row carries an auto-approval-scope
 * token (spec §6.2 gives those a different shape), or something no writer
 * produces. Either way Apply must refuse rather than compare two of the three
 * fields and call it a match.
 */
export const VoiceVersionTokenSchema = z.object({
  businessId: z.uuid(),
  updatedAt: z.string().min(1),
}).strict();

/** The token for a location whose `updated_at::text` has just been read. */
export function computeVoiceVersionToken(input: {
  businessId: string;
  updatedAt: string;
}): VoiceVersionToken {
  return { businessId: input.businessId, updatedAt: input.updatedAt };
}

/**
 * `agent_proposals.prepared_version_token` → a token. A PgBouncer JSONB parse
 * site (lab-notes/postgres.md allowlist): guard `typeof x === 'string'`, narrow
 * with zod, throw on a shape no writer produces — never widen to `any`.
 */
export function parseVersionToken(value: unknown): VoiceVersionToken {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const validated = VoiceVersionTokenSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      'agents/operator: agent_proposals.prepared_version_token holds a shape no writer produces',
    );
  }
  return validated.data;
}

/**
 * Equality, TEXT TO TEXT on both fields. No `Date` anywhere in this function,
 * and no normalization: two spellings of one instant are two different tokens,
 * because the only producers both emit `updated_at::text`.
 */
export function versionTokensEqual(a: VoiceVersionToken, b: VoiceVersionToken): boolean {
  return a.businessId === b.businessId && a.updatedAt === b.updatedAt;
}
