// The contract for every live-DB suite: the shared test database is migrated
// to head ONCE, out of band (`pnpm test:db:setup`), and suites ASSERT the
// schema they depend on instead of re-applying migration SQL at run time.
//
// Why assert rather than apply (#573): a migration re-apply takes
// ACCESS EXCLUSIVE locks on the tables it touches. Another suite holding
// ordinary row locks on those same tables in the opposite order deadlocks
// against it (40P01), and the victim is whichever transaction Postgres picks —
// so the failure lands in an unrelated suite and looks like flake. vitest's
// `integration` project serializes suites WITHIN one process, but nothing in
// vitest spans processes, and `scripts/verify-gate.sh` runs the intake's
// verification_commands as separate concurrent vitest processes. Removing the
// run-time DDL removes the ACCESS EXCLUSIVE lock, which is the only ingredient
// of that deadlock a test suite actually controls.
//
// Test-helper only — never imported by production code.

import type postgres from 'postgres';

const SETUP_COMMAND = 'pnpm test:db:setup';

export interface SchemaRequirement {
  /** Migration that introduces these objects. Named in the failure message. */
  migration: string;
  /** Relations that must exist in the `public` schema. */
  tables?: readonly string[];
  /** `table.column` pairs that must exist. */
  columns?: readonly string[];
  /** Index names that must exist in the `public` schema. */
  indexes?: readonly string[];
  /**
   * Named table constraints that must exist — the only proof available for a
   * migration that adds no relation, column or index (090 adds one CHECK).
   */
  constraints?: readonly { table: string; name: string }[];
  /**
   * `table.column` pairs whose `information_schema` data_type must match —
   * for migrations that only WIDEN an existing column (085 → NUMERIC), where
   * presence alone proves nothing.
   */
  columnTypes?: readonly { column: string; dataType: string }[];
}

interface MissingObject {
  migration: string;
  description: string;
}

async function findMissingTables(
  db: postgres.Sql,
  requirement: SchemaRequirement,
): Promise<MissingObject[]> {
  const tables = requirement.tables ?? [];
  if (tables.length === 0) return [];

  const present = await db<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ${db(tables)}
  `;
  const found = new Set(present.map((row) => row.table_name));
  return tables
    .filter((table) => !found.has(table))
    .map((table) => ({ migration: requirement.migration, description: `table ${table}` }));
}

async function findMissingColumns(
  db: postgres.Sql,
  requirement: SchemaRequirement,
): Promise<MissingObject[]> {
  const columns = requirement.columns ?? [];
  if (columns.length === 0) return [];

  const pairs = columns.map((qualified) => {
    const [table, column] = qualified.split('.');
    if (!table || !column) {
      throw new Error(`schema requirement column must be "table.column", got "${qualified}"`);
    }
    return { qualified, table, column };
  });

  const present = await db<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ${db(pairs.map((pair) => pair.table))}
      AND column_name IN ${db(pairs.map((pair) => pair.column))}
  `;
  const found = new Set(present.map((row) => `${row.table_name}.${row.column_name}`));
  return pairs
    .filter((pair) => !found.has(pair.qualified))
    .map((pair) => ({
      migration: requirement.migration,
      description: `column ${pair.qualified}`,
    }));
}

async function findMissingIndexes(
  db: postgres.Sql,
  requirement: SchemaRequirement,
): Promise<MissingObject[]> {
  const indexes = requirement.indexes ?? [];
  if (indexes.length === 0) return [];

  const present = await db<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname IN ${db(indexes)}
  `;
  const found = new Set(present.map((row) => row.indexname));
  return indexes
    .filter((index) => !found.has(index))
    .map((index) => ({ migration: requirement.migration, description: `index ${index}` }));
}

async function findMissingConstraints(
  db: postgres.Sql,
  requirement: SchemaRequirement,
): Promise<MissingObject[]> {
  const constraints = requirement.constraints ?? [];
  if (constraints.length === 0) return [];

  const missing: MissingObject[] = [];
  for (const constraint of constraints) {
    // `convalidated` matters: a constraint added NOT VALID and never validated
    // constrains new writes but proves nothing about the rows already there.
    const [found] = await db<{ convalidated: boolean }[]>`
      SELECT convalidated FROM pg_constraint
      WHERE conrelid = to_regclass(${`public.${constraint.table}`})
        AND conname = ${constraint.name}
    `;
    if (found === undefined) {
      missing.push({
        migration: requirement.migration,
        description: `constraint ${constraint.table}.${constraint.name}`,
      });
    } else if (!found.convalidated) {
      missing.push({
        migration: requirement.migration,
        description: `constraint ${constraint.table}.${constraint.name} exists but is NOT VALID`,
      });
    }
  }
  return missing;
}

async function findMismatchedColumnTypes(
  db: postgres.Sql,
  requirement: SchemaRequirement,
): Promise<MissingObject[]> {
  const expectations = requirement.columnTypes ?? [];
  if (expectations.length === 0) return [];

  const mismatched: MissingObject[] = [];
  for (const expectation of expectations) {
    const [table, column] = expectation.column.split('.');
    if (!table || !column) {
      throw new Error(
        `schema requirement columnType must be "table.column", got "${expectation.column}"`,
      );
    }
    const [actual] = await db<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    `;
    if (actual?.data_type !== expectation.dataType) {
      mismatched.push({
        migration: requirement.migration,
        description: `column ${expectation.column} is ${actual?.data_type ?? 'absent'}, expected ${expectation.dataType}`,
      });
    }
  }
  return mismatched;
}

/**
 * The migration → objects mapping, owned in ONE place so a suite declares the
 * migration it depends on rather than re-deriving which objects prove it.
 */
export const MIGRATION_071_RUN_SPINE: SchemaRequirement = {
  migration: '071_agent_run_spine',
  tables: ['agent_runs', 'agent_run_steps', 'agent_outcomes'],
};

export const MIGRATION_072_REVIEW_TRIAGE: SchemaRequirement = {
  migration: '072_review_triage',
  columns: ['reviews.triage_severity', 'reviews.triaged_at', 'reviews.triage_content_hash'],
};

export const MIGRATION_073_REVIEW_ESCALATIONS: SchemaRequirement = {
  migration: '073_review_escalations',
  tables: ['review_escalations'],
  columns: ['notification_deliveries.escalation_id'],
};

export const MIGRATION_074_TRUST_DIAL_VETO_WINDOW: SchemaRequirement = {
  migration: '074_trust_dial_veto_window',
  // The migration's LAST statement, so its presence implies the whole file.
  indexes: ['notification_deliveries_pending_post_notice_claim'],
};

/**
 * 083 adds one nullable TEXT column to `job_outbox` and nothing else — no
 * index, no constraint — so the column is the only presence proof available.
 */
export const MIGRATION_083_OUTBOX_OWNER_UNREACHABLE: SchemaRequirement = {
  migration: '083_outbox_owner_unreachable',
  columns: ['job_outbox.completion_reason'],
};

export const MIGRATION_085_COMPETITOR_RATING_NUMERIC: SchemaRequirement = {
  migration: '085_competitor_rating_numeric',
  columnTypes: [{ column: 'competitor_snapshots.rating', dataType: 'numeric' }],
};

export const MIGRATION_088_SOLICITATION_BATCH_EXECUTOR: SchemaRequirement = {
  migration: '088_solicitation_batch_executor',
  tables: ['solicitation_batches', 'solicitation_asks'],
  columns: ['agent_runs.parent_run_id'],
};

export const MIGRATION_090_SOLICITATION_ASK_EVIDENCE: SchemaRequirement = {
  migration: '090_solicitation_ask_evidence_check',
  // Constraint-only migration — no relation, column or index to point at.
  constraints: [
    { table: 'solicitation_asks', name: 'solicitation_asks_evidence_matches_columns' },
  ],
};

export const MIGRATION_089_COMPETITOR_RIVAL_PICK: SchemaRequirement = {
  migration: '089_competitor_rival_pick',
  columns: [
    'businesses.rival_picked_at',
    'businesses.rival_place_id',
    'businesses.rival_title_snapshot',
  ],
};

export const MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE: SchemaRequirement = {
  migration: '091_send_mode_spine_lifecycle',
  tables: ['solicitation_outreach'],
  columns: [
    'solicitation_batches.approved_at',
    'solicitation_batches.approval_method',
    'solicitation_batches.approved_by_user_id',
    'solicitation_batches.veto_deadline_at',
    'solicitation_batches.sending_started_at',
    'solicitation_batches.send_closed_at',
    'solicitation_batches.halted_at',
    'solicitation_batches.halt_reason',
    'solicitation_batches.halted_by',
    'auto_approval_policies.daily_send_cap',
  ],
  indexes: [
    'solicitation_outreach_one_live_per_ask',
    'solicitation_batches_one_active_send_per_business',
    'job_outbox_solicitation_send_inflight',
    'job_outbox_generate_solicitation_asks_inflight',
  ],
  // The two constraints 091 REPLACES rather than adds — presence of a widened
  // column proves nothing about them, so name them explicitly. The asks unique
  // is the one the outreach ask FK is built on, so a DB missing it fails at
  // table-creation time rather than mysteriously later.
  constraints: [
    { table: 'solicitation_asks', name: 'solicitation_asks_account_business_id_uniq' },
    { table: 'solicitation_outreach', name: 'solicitation_outreach_status_reason_consistency' },
    { table: 'auto_approval_policies', name: 'auto_approval_policies_persona_consistency' },
  ],
};

/**
 * 092 adds one index and REPLACES one 091 constraint with a wider one. The
 * constraint entry proves only that the name exists — which 091 already
 * guarantees — so the index is what actually distinguishes a 092 database from
 * a 091 one, and suites asserting the wider redaction rule must name this
 * requirement rather than MIGRATION_091 alone.
 */
export const MIGRATION_092_TERMINAL_OUTREACH_BODY_REDACTION: SchemaRequirement = {
  migration: '092_terminal_outreach_body_redaction',
  indexes: ['idx_solicitation_outreach_unsent_terminal_redaction_sweep'],
  constraints: [
    { table: 'solicitation_outreach', name: 'solicitation_outreach_body_presence' },
  ],
};

/**
 * 093 creates the consent ledger. The scope unique is what the §4.2 guarded
 * upsert conflicts on, and the source-upload index is the migration's LAST
 * object — its presence implies the whole file ran.
 */
export const MIGRATION_093_SOLICITATION_CONSENT: SchemaRequirement = {
  migration: '093_solicitation_consent',
  tables: ['solicitation_consent'],
  indexes: ['solicitation_consent_scope_uniq', 'idx_solicitation_consent_source_upload'],
};

/**
 * 095 adds the business-leading compliance-delete index. 093's scope unique
 * leads with channel, so the purge/offboarding DELETEs and the contact-delete
 * sweep (both filtering by business_id + normalized_handle) would otherwise
 * full-scan a no-TTL table — PG16 has no skip scan. The index is the
 * migration's only object, so its presence is what distinguishes a 095
 * database from a 094 one.
 */
export const MIGRATION_095_CONSENT_BUSINESS_INDEX: SchemaRequirement = {
  migration: '095_consent_business_index',
  indexes: ['idx_solicitation_consent_business_handle'],
};

/**
 * 096 creates the Suppression ledger and the Unsubscribe token table. The two
 * PARTIAL uniques are what every first-write-wins `ON CONFLICT` infers
 * byte-for-byte, so a database missing one turns the writer's DO NOTHING into a
 * duplicate-key error rather than a no-op; the account-leading index is the
 * migration's LAST object, so its presence implies the whole file ran.
 *
 * 097 (the analytics CHECK swap) gets no requirement of its own: it adds no
 * relation, column or index, and its constraint NAME has existed since 046 —
 * presence would prove nothing. Its suite inspects the migration SQL text
 * instead, exactly as 094's does.
 */
export const MIGRATION_096_SOLICITATION_SUPPRESSIONS: SchemaRequirement = {
  migration: '096_solicitation_suppressions',
  tables: ['solicitation_suppressions', 'solicitation_unsubscribe_tokens'],
  indexes: [
    'solicitation_suppressions_global_uniq',
    'solicitation_suppressions_account_uniq',
    'idx_solicitation_suppressions_account',
    'solicitation_unsubscribe_tokens_outreach_uniq',
    'idx_solicitation_unsubscribe_tokens_account',
  ],
};

/**
 * 098 creates the Correction path's audit sink. The handle-leading index is the
 * migration's last object before the RLS switch, so its presence implies the
 * whole file ran.
 *
 * The three evidence columns are named EXPLICITLY even though that rule would
 * normally cover them: 098 was edited in place while still LOCAL-ONLY (D-A11),
 * so a container provisioned before that edit has both the table and the index
 * and is still missing these. "The last object exists" proves the file ran
 * ONCE, not that it ran in its current form — and without this the symptom is
 * `correctSuppression` throwing an undefined-column error rather than the
 * actionable `pnpm test:db:setup` message.
 */
export const MIGRATION_098_SUPPRESSION_CORRECTIONS: SchemaRequirement = {
  migration: '098_solicitation_suppression_corrections',
  tables: ['solicitation_suppression_corrections'],
  columns: [
    'solicitation_suppression_corrections.account_id',
    'solicitation_suppression_corrections.created_by_user_id',
    'solicitation_suppression_corrections.note',
  ],
  indexes: ['idx_solicitation_suppression_corrections_handle'],
};

/**
 * 099 adds the Attested postal address to `businesses` — five nullable columns
 * under two CHECKs. It creates no relation and no index, so the columns are the
 * presence proof.
 *
 * Both CHECKs are named EXPLICITLY alongside them, and the digest one is the
 * reason: the columns can exist without it (any container provisioned from a
 * draft of this migration that stopped at the ALTER), and in that state the
 * attestation is complete-but-uncovered — the exact defect the feature exists
 * to prevent. Column presence proves the ALTER ran, not that the file ran to
 * the end, so without these a behind-head container fails as
 * "expected the UPDATE to be rejected, it was accepted" instead of the
 * actionable `pnpm test:db:setup` message. Same lesson as 098's D-A11 entry
 * above.
 */
export const MIGRATION_099_SOLICITATION_POSTAL_ADDRESS: SchemaRequirement = {
  migration: '099_solicitation_postal_address',
  tables: ['businesses'],
  columns: [
    'businesses.solicitation_postal_address',
    'businesses.solicitation_postal_address_attested_at',
    'businesses.solicitation_postal_address_attested_by_user_id',
    'businesses.solicitation_postal_address_attestation_version',
    'businesses.solicitation_postal_address_attested_digest',
  ],
  indexes: [],
  constraints: [
    { table: 'businesses', name: 'businesses_solicitation_postal_address_attested' },
    { table: 'businesses', name: 'businesses_solicitation_postal_address_digest' },
  ],
};

/**
 * 100 adds the Consented Review Import state to `businesses` and the ADD half
 * of the backfill-counter collapse to `zernio_backfill_runs` (#673, epic
 * #667; spec 2026-08-05-consented-review-import-design.md §4, §8a R4). It
 * creates no relation and no index, so the five columns are the presence
 * proof. The enum CHECK is named explicitly: `import_decision` can exist
 * without it (a container provisioned from a draft that stopped at the
 * ALTER), and in that state an invalid decision INSERTs fine — the shape
 * suite's rejection probes would then fail as "expected 23514, got success"
 * instead of the actionable `pnpm test:db:setup` message (099's lesson).
 */
export const MIGRATION_100_IMPORT_CONSENT: SchemaRequirement = {
  migration: '100_import_consent_and_backfill_counters',
  tables: ['businesses', 'zernio_backfill_runs'],
  columns: [
    'businesses.import_decision',
    'businesses.import_decision_at',
    'businesses.import_offer_expires_at',
    'zernio_backfill_runs.imported_count',
    'zernio_backfill_runs.skipped_count',
  ],
  indexes: [],
  constraints: [{ table: 'businesses', name: 'businesses_import_decision_check' }],
};

/**
 * 104 adds the scheduler-side Drip staleness cap skip record (#738). The two
 * CHECKs are named because the columns can exist without them (a container
 * provisioned from a draft that stopped at the ALTER), and the suites assert
 * behavior the constraints enforce.
 */
export const MIGRATION_104_DRIP_LOG_SKIP_RECORD: SchemaRequirement = {
  migration: '104_drip_log_skip_record',
  columns: ['onboarding_drip_log.skipped_at', 'onboarding_drip_log.skip_reason'],
  constraints: [
    { table: 'onboarding_drip_log', name: 'onboarding_drip_log_skip_pairing' },
    { table: 'onboarding_drip_log', name: 'onboarding_drip_log_skip_send_exclusive' },
  ],
};

/**
 * The precondition a `SchemaRequirement` structurally cannot carry.
 *
 * `analytics_events_event_name_check` has existed under that NAME since 046,
 * and 094 / 097 / 102 each REPLACE it with a wider list. Presence therefore
 * proves nothing, which is why none of the three exports a requirement — the
 * only proof available is the constraint's DEFINITION.
 *
 * A suite that ASSERTS an analytics row exists depends on that definition:
 * every emission runs inside its caller's transaction, and an unregistered name
 * is a `23514` at statement time. Where the emitter savepoints (Import consent
 * does, `import-consent.ts`), the rejection is swallowed and the suite fails as
 * "expected length 1, received 0"; where it does not, the caller's whole
 * transaction dies. Neither names the actual problem, which is that the
 * database is behind head — the loud, named failure `assertSchemaReady` exists
 * to give (#679 review round 1).
 */
export interface AnalyticsEventNameRequirement {
  /** Migration that registered these names. Named in the failure message. */
  migration: string;
  /** Event names the live CHECK must admit. */
  eventNames: readonly string[];
}

/** #679 T1 — the two Import offer events. */
export const MIGRATION_102_IMPORT_CONSENT_EVENTS: AnalyticsEventNameRequirement = {
  migration: '102_import_consent_analytics_events',
  eventNames: ['import_offer_created', 'import_decision_recorded'],
};

/**
 * Throws unless the live `analytics_events_event_name_check` ADMITS every name.
 *
 * Read-only (`pg_get_constraintdef` over `pg_constraint`), so like
 * `assertSchemaReady` it can never be the blocking side of a deadlock.
 */
export async function assertAnalyticsEventNamesRegistered(
  db: postgres.Sql,
  requirement: AnalyticsEventNameRequirement,
): Promise<void> {
  const [row] = await db<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = 'analytics_events_event_name_check'
      AND conrelid = 'analytics_events'::regclass
  `;

  const missing = row
    ? requirement.eventNames.filter((name) => !row.definition.includes(`'${name}'`))
    : [...requirement.eventNames];
  if (missing.length === 0) return;

  throw new Error(
    `test database is behind head — analytics_events_event_name_check ` +
      `${row ? `does not admit ${missing.join(', ')}` : 'is absent from analytics_events'}\n` +
      `  ${requirement.migration}\n` +
      `Re-provision it with \`${SETUP_COMMAND}\`. Suites assert schema; they no ` +
      `longer apply migrations at run time (#573).`,
  );
}

/**
 * Throws unless every requirement is already present on the connected
 * database. Read-only: it takes no lock stronger than ACCESS SHARE, so it can
 * never be the blocking side of a deadlock.
 *
 * The failure is deliberately loud and actionable — a missing object means the
 * test DB is behind head, which is a setup problem, not a test problem.
 */
export async function assertSchemaReady(
  db: postgres.Sql,
  requirements: readonly SchemaRequirement[],
): Promise<void> {
  const missing: MissingObject[] = [];
  for (const requirement of requirements) {
    missing.push(
      ...(await findMissingTables(db, requirement)),
      ...(await findMissingColumns(db, requirement)),
      ...(await findMissingIndexes(db, requirement)),
      ...(await findMissingConstraints(db, requirement)),
      ...(await findMismatchedColumnTypes(db, requirement)),
    );
  }

  if (missing.length === 0) return;

  const byMigration = new Map<string, string[]>();
  for (const item of missing) {
    const bucket = byMigration.get(item.migration) ?? [];
    bucket.push(item.description);
    byMigration.set(item.migration, bucket);
  }
  const detail = [...byMigration.entries()]
    .map(([migration, descriptions]) => `  ${migration}: ${descriptions.join(', ')}`)
    .join('\n');

  throw new Error(
    `test database is behind head — missing schema objects:\n${detail}\n` +
      `Re-provision it with \`${SETUP_COMMAND}\`. Suites assert schema; they no ` +
      `longer apply migrations at run time (#573).`,
  );
}
