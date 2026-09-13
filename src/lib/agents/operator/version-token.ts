// The **Version token** (spec §6.2): one owner for its shapes — the voice scope
// and the two auto-approval scopes — its JSONB parse site and its equality.
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
 * One `auto_approval_policies` row's identity and existence, as read under the
 * lock. A present row is `{ id, updatedAt }`, with `updatedAt` the row's
 * `updated_at::text` VERBATIM (same text-end-to-end rule as the voice token). A
 * missing row is exactly `{ id: 'absent' }`.
 *
 * Each arm is `.strict()`, so `{ id: 'absent', updatedAt }` and `{ id: <uuid> }`
 * are both refused: "absent" never carries a stamp and a present row never
 * loses one. A token that records `'absent'` matches only while the row is
 * still absent — creating the first row changes the token.
 */
const PolicyRowVersionSchema = z.union([
  z.object({ id: z.uuid(), updatedAt: z.string().min(1) }).strict(),
  z.object({ id: z.literal('absent') }).strict(),
]);
export type PolicyRowVersion = z.infer<typeof PolicyRowVersionSchema>;

/** Account scope: only the account-default row governs the account's dials. */
const AccountAutoApprovalVersionTokenSchema = z.object({
  accountDefaultRow: PolicyRowVersionSchema,
}).strict();
type AccountAutoApprovalVersionToken = z.infer<typeof AccountAutoApprovalVersionTokenSchema>;

/**
 * Location scope: BOTH rows, always — even when the location has its own
 * override row. A created override inherits the parent's dials, so a proposal
 * prepared against a location goes stale when the parent moves.
 */
const LocationAutoApprovalVersionTokenSchema = z.object({
  locationRow: PolicyRowVersionSchema,
  accountDefaultRow: PolicyRowVersionSchema,
}).strict();
type LocationAutoApprovalVersionToken = z.infer<typeof LocationAutoApprovalVersionTokenSchema>;

/**
 * The two arms are disjoint by construction: both are strict and only the
 * location arm admits `locationRow`. Arm order never decides a match.
 */
export const AutoApprovalVersionTokenSchema = z.union([
  LocationAutoApprovalVersionTokenSchema,
  AccountAutoApprovalVersionTokenSchema,
]);
export type AutoApprovalVersionToken = z.infer<typeof AutoApprovalVersionTokenSchema>;

/** Every token shape a writer produces. The voice and auto-approval arms share no key. */
export const VersionTokenSchema = z.union([VoiceVersionTokenSchema, AutoApprovalVersionTokenSchema]);
export type VersionToken = z.infer<typeof VersionTokenSchema>;

function copyRowVersion(row: PolicyRowVersion | undefined): unknown {
  if (row === undefined) return undefined;
  return 'updatedAt' in row ? { id: row.id, updatedAt: row.updatedAt } : { id: row.id };
}

/**
 * The token for the policy rows just read under the lock. The PROPERTY decides
 * the scope: no `locationRow` property → account token; `locationRow:
 * { id: 'absent' }` → a location token for a targeted location with no
 * override row yet. Rows are copied field by field, so a caller's extra
 * columns never reach the stored JSONB. The result is validated, so a token no
 * parser accepts is never written.
 */
export function computeAutoApprovalVersionToken(input: {
  accountDefaultRow: PolicyRowVersion;
  locationRow: PolicyRowVersion;
}): LocationAutoApprovalVersionToken;
export function computeAutoApprovalVersionToken(input: {
  accountDefaultRow: PolicyRowVersion;
}): AccountAutoApprovalVersionToken;
export function computeAutoApprovalVersionToken(input: {
  accountDefaultRow: PolicyRowVersion;
  locationRow?: PolicyRowVersion;
}): AutoApprovalVersionToken;
export function computeAutoApprovalVersionToken(input: {
  accountDefaultRow: PolicyRowVersion;
  locationRow?: PolicyRowVersion;
}): AutoApprovalVersionToken {
  const candidate = 'locationRow' in input
    ? {
      locationRow: copyRowVersion(input.locationRow),
      accountDefaultRow: copyRowVersion(input.accountDefaultRow),
    }
    : { accountDefaultRow: copyRowVersion(input.accountDefaultRow) };
  const validated = AutoApprovalVersionTokenSchema.safeParse(candidate);
  if (!validated.success) {
    throw new Error(
      'agents/operator: computeAutoApprovalVersionToken received a policy row version no writer may store',
    );
  }
  return validated.data;
}

/**
 * `agent_proposals.prepared_version_token` → a token of any scope. A PgBouncer
 * JSONB parse site (lab-notes/postgres.md allowlist): guard `typeof x ===
 * 'string'`, narrow with zod, throw on a shape no writer produces — never widen
 * to `any`.
 */
export function parseVersionToken(value: unknown): VersionToken {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const validated = VersionTokenSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      'agents/operator: agent_proposals.prepared_version_token holds a shape no writer produces',
    );
  }
  return validated.data;
}

/** Row identity, text to text: same id, and the same stamp or both absent. */
function rowVersionsEqual(a: PolicyRowVersion, b: PolicyRowVersion): boolean {
  if (a.id !== b.id) return false;
  const aStamp = 'updatedAt' in a ? a.updatedAt : undefined;
  const bStamp = 'updatedAt' in b ? b.updatedAt : undefined;
  return aStamp === bStamp;
}

/**
 * Equality, TEXT TO TEXT on every field. No `Date` anywhere in this function,
 * no normalization and no serialization: two spellings of one instant are two
 * different tokens, because every producer emits `updated_at::text`. Scopes
 * never cross — a voice token never equals an auto-approval token, and an
 * account token never equals a location token, even when every row is absent.
 */
export function versionTokensEqual(a: VersionToken, b: VersionToken): boolean {
  if ('businessId' in a) {
    return 'businessId' in b && a.businessId === b.businessId && a.updatedAt === b.updatedAt;
  }
  if ('businessId' in b) return false;
  if ('locationRow' in a) {
    return 'locationRow' in b
      && rowVersionsEqual(a.locationRow, b.locationRow)
      && rowVersionsEqual(a.accountDefaultRow, b.accountDefaultRow);
  }
  if ('locationRow' in b) return false;
  return rowVersionsEqual(a.accountDefaultRow, b.accountDefaultRow);
}
