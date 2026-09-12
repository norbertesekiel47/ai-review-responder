// The single transactional writer for a location's voice fields, extracted
// from src/app/api/settings/voice/route.ts so the settings route and the Owner
// Operator share one lock order and one column map. Invariant #15: the caller
// passes `db`/`tx`; this module never imports @/lib/db/server.
import type postgres from 'postgres';

type DbClient = postgres.Sql | postgres.TransactionSql;

/** The voice fields the prompt builder reads. Every field is optional on write. */
export interface VoiceConfig {
  tone: string | null;
  productsServices: string | null;
  avoidFacts: string[];
  highlightFacts: string[];
  /**
   * Stored RESPONSE TEXT. It belongs to the writer because the settings route
   * has always written it — and it stops here: the Context snapshot's `facts`
   * is its own four-field `SnapshotFacts`, so this field has nowhere to land
   * in a prompt (invariant 5).
   */
  sampleResponses: string[];
}

/**
 * Camel field → `businesses` column. `highlight_facts` is included here and in
 * the route's schema from Run A on; before that the column existed and nothing
 * read or wrote it (spec §4).
 */
export const VOICE_FIELD_TO_COLUMN = {
  tone: 'tone',
  productsServices: 'products_services',
  avoidFacts: 'avoid_facts',
  highlightFacts: 'highlight_facts',
  sampleResponses: 'sample_responses',
} as const;

export type VoiceField = keyof typeof VOICE_FIELD_TO_COLUMN;

/**
 * The ONE definition of each voice field's domain, owned beside the writer.
 *
 * Two independent copies — the settings route's `VoiceConfigSchema` and the
 * operator catalog's input schemas — meant a `max(2000)` raised on the route
 * left the catalog silently stricter, and the proposal path quietly refusing
 * values the UI accepts. Both now build their zod schemas from this.
 */
export const VOICE_FIELD_LIMITS = {
  tone: { maxLength: 100 },
  productsServices: { maxLength: 2000 },
  avoidFacts: { maxItems: 20, maxLength: 500 },
  highlightFacts: { maxItems: 20, maxLength: 500 },
  sampleResponses: { maxItems: 10, maxLength: 2000 },
} as const;

type VoiceRow = {
  tone: string | null;
  products_services: string | null;
  avoid_facts: string[] | null;
  highlight_facts: string[] | null;
  sample_responses: string[] | null;
  /** `updated_at::text` — see `readVoiceConfig`. Never a JS `Date`. */
  updated_at: string;
};

/**
 * Reads one active location's voice config plus the `updated_at` that becomes
 * the voice-scope **Version token**. Returns null when the location is not an
 * active member of the account — the same shape the route's 404 uses.
 *
 * `updated_at::text`, RETURNED VERBATIM, and that is the whole point of this
 * read. postgres.js decodes `timestamptz` into a JS `Date`, which holds
 * milliseconds and silently truncates the microseconds Postgres stores
 * (CLAUDE.md's `timestamptz` gotcha). A **Version token** built from a
 * round-tripped `Date` therefore compares EQUAL to a row that was written up to
 * a microsecond later — a stale proposal that reads as fresh, which is exactly
 * the check the token exists to make. Text end-to-end: the token stores this
 * string and Run B's Apply compares text to text.
 */
export async function readVoiceConfig(
  db: DbClient,
  input: { accountId: string; locationId: string },
): Promise<(VoiceConfig & { updatedAt: string }) | null> {
  const [row] = await db<VoiceRow[]>`
    SELECT tone, products_services, avoid_facts, highlight_facts, sample_responses,
           updated_at::text AS updated_at
    FROM businesses
    WHERE id = ${input.locationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND archived_at IS NULL
  `;
  if (!row) return null;
  return {
    tone: row.tone,
    productsServices: row.products_services,
    avoidFacts: row.avoid_facts ?? [],
    highlightFacts: row.highlight_facts ?? [],
    sampleResponses: row.sample_responses ?? [],
    updatedAt: row.updated_at,
  };
}

export type UpdateVoiceConfigResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: 'location_not_found' | 'no_fields' };

/**
 * Writes the supplied voice fields under a `businesses` row lock.
 *
 * The lock is taken FIRST and is itself account-scoped and active-only, so the
 * ownership check and the write cannot be separated by a concurrent archive or
 * account move. Callers must be inside a transaction for the lock to hold —
 * outside `sql.begin()` PgBouncer drops the row lock the instant the SELECT
 * returns (CLAUDE.md, `SELECT … FOR UPDATE` gotcha).
 */
export async function updateVoiceConfig(
  tx: postgres.TransactionSql,
  input: { accountId: string; locationId: string; fields: Partial<VoiceConfig> },
): Promise<UpdateVoiceConfigResult> {
  const [locked] = await tx<{ id: string }[]>`
    SELECT id
    FROM businesses
    WHERE id = ${input.locationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND archived_at IS NULL
    FOR UPDATE
  `;
  if (!locked) return { ok: false, reason: 'location_not_found' };

  const updates: Record<string, string | string[] | null> = {};
  for (const field of Object.keys(VOICE_FIELD_TO_COLUMN) as VoiceField[]) {
    const value = input.fields[field];
    if (value === undefined) continue;
    updates[VOICE_FIELD_TO_COLUMN[field]] = value;
  }
  if (Object.keys(updates).length === 0) return { ok: false, reason: 'no_fields' };

  // Postgres.js parameterizes both the identifiers and the values through the
  // dynamic-column helper — no string interpolation.
  //
  // `updated_at::text`, THE SAME SPELLING `readVoiceConfig` uses, and returned
  // verbatim for the same reason: this value is the voice-scope **Version
  // token**, and Run B's Apply compares it TEXT TO TEXT against the read's.
  // A `new Date(...).toISOString()` here would truncate the microseconds
  // Postgres stores, so the writer's token and the reader's token for one
  // unchanged row would differ by format — every freshly written proposal
  // reading as stale, or a stale one as fresh.
  const [row] = await tx<{ updated_at: string }[]>`
    UPDATE businesses
    SET ${tx(updates)}, updated_at = NOW()
    WHERE id = ${input.locationId}::uuid
      AND account_id = ${input.accountId}::uuid
    RETURNING updated_at::text AS updated_at
  `;
  if (!row) return { ok: false, reason: 'location_not_found' };
  return { ok: true, updatedAt: row.updated_at };
}
