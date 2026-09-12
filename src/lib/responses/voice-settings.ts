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

type VoiceRow = {
  tone: string | null;
  products_services: string | null;
  avoid_facts: string[] | null;
  highlight_facts: string[] | null;
  sample_responses: string[] | null;
  updated_at: Date | string;
};

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

/**
 * Reads one active location's voice config plus the `updated_at` that becomes
 * the voice-scope **Version token**. Returns null when the location is not an
 * active member of the account — the same shape the route's 404 uses.
 */
export async function readVoiceConfig(
  db: DbClient,
  input: { accountId: string; locationId: string },
): Promise<(VoiceConfig & { updatedAt: string }) | null> {
  const [row] = await db<VoiceRow[]>`
    SELECT tone, products_services, avoid_facts, highlight_facts, sample_responses, updated_at
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
    updatedAt: iso(row.updated_at),
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
  const [row] = await tx<{ updated_at: Date | string }[]>`
    UPDATE businesses
    SET ${tx(updates)}, updated_at = NOW()
    WHERE id = ${input.locationId}::uuid
      AND account_id = ${input.accountId}::uuid
    RETURNING updated_at
  `;
  if (!row) return { ok: false, reason: 'location_not_found' };
  return { ok: true, updatedAt: iso(row.updated_at) };
}
