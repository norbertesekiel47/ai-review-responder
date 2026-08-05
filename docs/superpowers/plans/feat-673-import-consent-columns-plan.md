# Migration 100: Import-Consent Columns + Backfill Counter Collapse (ADD half) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migration 100 ADDs the import-consent state (`import_decision`, `import_decision_at`, `import_offer_expires_at`) on `businesses` and the collapsed backfill counters (`imported_count`, `skipped_count`) on `zernio_backfill_runs`, with `ZernioBackfillWorker` dual-writing both counter sets and the tenant-scope allowlist re-pinned.

**Architecture:** Pure additive schema change (spec §8a R4 — the DROP half is #680) plus a two-column widening of one existing UPDATE statement. No new interfaces, no new seams. The eval task lands the executable spec first: a migration-shape suite (099 precedent — asserts via `assertSchemaReady`, never applies migration SQL, #573) and red worker dual-write assertions.

**Tech Stack:** Postgres (Supabase), Postgres.js, vitest (mocked-sql worker suite + serialized live-DB integration project).

**Intake:** `docs/superpowers/plans/feat-673-import-consent-columns-intake.json` (committed copy). Design of record: ADR 0015 + `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §4, §8a R1/R3/R4. Ticket: #673 (epic map #667). Deviations so far: D1–D4 in `docs/superpowers/plans/feat-673-import-consent-columns-deviations.md`.

**Plan review:** codex session `019fd32f-a72d-7822-9f41-b64fde239087`, three rounds. Round 1 → REVISE (13 findings; 12 accepted, finding 13 rejected — D4). Round 2 → REVISE (6 residuals on eval strength; all accepted). Round 3 → REVISE on two mechanical residuals (statement allowlist not pinning exact column names; CHECK predicate regex not end-anchored) — both ACCEPTED and applied below; per the round protocol no round 4 ran, and since the orchestrator agreed with both findings there was no disagreement to escalate (orchestrator call, 2026-08-05). All other round-3 rows verified addressed.

---

## Locked decisions (do not re-litigate in tasks)

1. **Dual-write in this PR** (owner, 2026-08-05): the counters UPDATE writes the four legacy columns AND `imported_count = gapProcessed + historicalProcessed`, `skipped_count = gapSkipped + historicalSkipped`, in the same statement, until #680 drops the legacy set.
2. **Enum CHECK only** (owner, 2026-08-05): no cross-column CHECK between `import_decision` and the timestamps — #677/#679 own those semantics.
3. `NOT NULL DEFAULT 'pending'` is exact (#668 / §8a R3). No backfill clause, no backdating.
4. No index (#679 adds one if its sweep needs it). No feature flag (ADR 0015 R1).
5. Both worker INSERT branches stay untouched — `DEFAULT 0` covers the new counters; the dual-write test asserts neither INSERT template names them.

## Task graph

- **Task 1 (eval)** — runs ALONE first (enforcement spot check). The surface amendment it needs (schema-ready.ts) is ALREADY applied to both intake copies (D1) — do not re-apply.
- **Task 2 (migration + log)** and **Task 3 (worker + allowlist)** — mutually independent (disjoint files, no blocking edges between them); parallel dispatch allowed after Task 1.

---

### Task 1: Eval task — executable spec, committed red

**Files:**
- Modify: `src/lib/shared/__tests__/helpers/schema-ready.ts` (append after `MIGRATION_099_SOLICITATION_POSTAL_ADDRESS`, before `assertSchemaReady`)
- Create: `src/lib/shared/__tests__/migration-100-import-consent.integration.test.ts`
- Modify: `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`

**Precedents (read before writing):** `src/lib/shared/__tests__/migration-099-solicitation-postal-address.integration.test.ts` (suite skeleton: `describeWithDb`, `acquireLiveDbLock`, `resolveTestDatabaseUrl`, rolled-back probes, `stripSqlLineComments`-style executable-SQL filtering, and its businesses fixture INSERT — note `seedTenantAccount` returns ONLY `{ userId, accountId, ownerEmail }`; the suite must create its own `businesses` row the way 099's does); `src/lib/shared/__tests__/helpers/schema-ready.ts` (entry shape).

- [ ] **Step 1: Add the schema-ready entry**

```ts
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
```

- [ ] **Step 2: Create the shape suite** — skeleton copied from the 099 suite (same imports plus `existsSync`/`readFileSync`/`resolve`, same `describeWithDb` + lock hooks, same rolled-back-probe discipline; no migration SQL is ever EXECUTED — test 4 only READS the file as text). The suite seeds a tenant account and creates its own fixture `businesses` row (copy 099's fixture INSERT; do NOT name `import_decision` in it — the default is the subject). Four tests, titles VERBATIM from the intake:

```ts
const ENUM_VALUES = ['pending', 'accepted', 'declined', 'expired'] as const;
const INVALID_VALUES = ['', 'PENDING', 'yes', 'dismissed'] as const;
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/100_import_consent_and_backfill_counters.sql',
);
// Executable SQL only — header comments DISCUSS the operations this migration
// must not contain, so absence assertions must not read them (099 precedent).
const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf-8') : '';
const executableSql = rawSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

it("businesses.import_decision defaults to 'pending' and rejects values outside the four-state enum", async () => {
  // Catalog-level pin — the DEFAULT and type live in the catalog, not in a
  // fixture's luck: a trigger or seeded value could also read back 'pending'.
  const [decisionCol] = await sql()`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'businesses'
      AND column_name = 'import_decision'
  `;
  expect(decisionCol.data_type).toBe('text');
  expect(decisionCol.is_nullable).toBe('NO');
  expect(decisionCol.column_default).toBe("'pending'::text");

  // The predicate itself, not just the constraint's existence: a broader
  // CHECK (e.g. `IN (…) OR length(x) = 1`) admits unseen values while
  // containing all four literals and passing every sampled probe below. Pin
  // the pg-normalized rendering: `= ANY (ARRAY[exactly these four])`, in
  // order, with no other branch.
  const [check] = await sql()`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.businesses'::regclass
      AND conname = 'businesses_import_decision_check'
  `;
  const def = check.def.replace(/\s+/g, ' ');
  // FULL-definition equality — start-anchored prefixes admit a pathological
  // trailing branch (round-3 finding 4). PG16-pinned rendering: if this
  // equality ever fails on parenthesization/cast variance, print the actual
  // def, eyeball that it is the four-value ANY with no extra branch, and pin
  // THAT literal — the contract is whole-definition equality, not this guess.
  expect(def).toBe(
    "CHECK ((import_decision = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text])))",
  );

  // Behavioural probes (all rolled back): fixture row took the default…
  const [row] = await sql()`
    SELECT import_decision, import_decision_at, import_offer_expires_at
    FROM businesses WHERE id = ${businessId}
  `;
  expect(row.import_decision).toBe('pending');
  expect(row.import_decision_at).toBeNull();
  expect(row.import_offer_expires_at).toBeNull();
  // …every legal value UPDATEs fine…
  for (const value of ENUM_VALUES) {
    await sql().begin(async (tx) => {
      await tx`UPDATE businesses SET import_decision = ${value} WHERE id = ${businessId}`;
      throw new Error('rollback');
    }).catch((err) => { if (err.message !== 'rollback') throw err; });
  }
  // …every illegal value hits the CHECK (23514), and NULL hits NOT NULL
  // (23502) — the CHECK-passes-NULL trap from the new-migration checklist.
  for (const value of INVALID_VALUES) {
    await expect(
      sql()`UPDATE businesses SET import_decision = ${value} WHERE id = ${businessId}`,
    ).rejects.toMatchObject({ code: '23514' });
  }
  await expect(
    sql()`UPDATE businesses SET import_decision = NULL WHERE id = ${businessId}`,
  ).rejects.toMatchObject({ code: '23502' });
});

it('import_decision_at and import_offer_expires_at are nullable timestamptz with no cross-column constraint', async () => {
  const cols = await sql()`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'businesses'
      AND column_name IN ('import_decision_at', 'import_offer_expires_at')
    ORDER BY column_name
  `;
  expect(cols).toHaveLength(2);
  for (const col of cols) {
    expect(col.data_type).toBe('timestamp with time zone');
    expect(col.is_nullable).toBe('YES');
  }
  // Absence proof by introspection, not by one lucky accepted combination:
  // NO CHECK on businesses references either timestamp column. #677/#679 own
  // any tightening (owner decision 2026-08-05).
  const coupled = await sql()`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.businesses'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) LIKE '%import_decision_at%'
        OR pg_get_constraintdef(oid) LIKE '%import_offer_expires_at%')
  `;
  expect(coupled).toHaveLength(0);
  // Behavioural corroboration (rolled back): non-pending decision with both
  // timestamps NULL is accepted.
  await sql().begin(async (tx) => {
    await tx`
      UPDATE businesses
      SET import_decision = 'expired', import_decision_at = NULL, import_offer_expires_at = NULL
      WHERE id = ${businessId}
    `;
    throw new Error('rollback');
  }).catch((err) => { if (err.message !== 'rollback') throw err; });
});

it('zernio_backfill_runs.imported_count and skipped_count are NOT NULL DEFAULT 0 alongside the four legacy counters', async () => {
  const cols = await sql()`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'zernio_backfill_runs'
      AND column_name IN (
        'imported_count', 'skipped_count',
        'gap_processed_count', 'historical_processed_count',
        'gap_skipped_count', 'historical_skipped_count',
        'oldest_skipped_create_time'
      )
  `;
  // 2 new + 4 legacy + the untouched oldest_skipped_create_time = 7. The
  // legacy four being PRESENT is the §8a R4 assertion — their DROP is #680.
  expect(cols).toHaveLength(7);
  for (const name of ['imported_count', 'skipped_count']) {
    const col = cols.find((c) => c.column_name === name);
    expect(col?.data_type).toBe('integer');
    expect(col?.is_nullable).toBe('NO');
    expect(col?.column_default).toBe('0');
  }
  // Behavioural default probe (rolled back): INSERT without naming the new
  // counters → both read back 0.
  await sql().begin(async (tx) => {
    const [inserted] = await tx`
      INSERT INTO zernio_backfill_runs (
        id, business_id, zernio_account_id, zernio_location_id,
        subscription_tier, subscription_activated_at, run_reason
      ) VALUES (
        ${crypto.randomUUID()}, ${businessId}, 'za-shape', 'zl-shape',
        'copilot', NOW(), 'initial'
      )
      RETURNING imported_count, skipped_count
    `;
    expect(inserted.imported_count).toBe(0);
    expect(inserted.skipped_count).toBe(0);
    throw new Error('rollback');
  }).catch((err) => { if (err.message !== 'rollback') throw err; });
});

it('migration 100 executable SQL is additive-only — no data rewrite, no DROP COLUMN, no ALTER COLUMN, no CREATE INDEX', () => {
  // Shape introspection cannot see what the file DID on the way to the final
  // shape (a backdating UPDATE, TRUNCATE, drop-and-recreate, a trigger, a
  // stray index). Deny-listing verbs is leaky, so this is an ALLOWLIST over
  // every executable statement: anything not in the exact permitted set —
  // lock_timeout, additive ADD COLUMN on the two named tables, the named
  // CHECK's idempotent drop/add pair, COMMENT ON COLUMN — fails with the
  // offending statement in the message. Splitting on ';' is safe because the
  // migration's COMMENT literals deliberately contain no semicolons (a Task 2
  // authoring constraint, noted in the migration header).
  expect(executableSql.length).toBeGreaterThan(0);
  const statements = executableSql
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  expect(statements.length).toBeGreaterThanOrEqual(5);

  // Exact table→column pinning (round-3 finding 2): a stray column, a
  // counter on the wrong table, or a foreign lock_timeout all fail.
  const BUSINESSES_ADDS = [
    "ADD COLUMN IF NOT EXISTS import_decision TEXT NOT NULL DEFAULT 'pending'",
    'ADD COLUMN IF NOT EXISTS import_decision_at TIMESTAMPTZ',
    'ADD COLUMN IF NOT EXISTS import_offer_expires_at TIMESTAMPTZ',
  ];
  const RUNS_ADDS = [
    'ADD COLUMN IF NOT EXISTS imported_count INTEGER NOT NULL DEFAULT 0',
    'ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0',
  ];
  const COMMENTABLE =
    /^COMMENT ON COLUMN (businesses\.(import_decision|import_decision_at|import_offer_expires_at)|zernio_backfill_runs\.(imported_count|skipped_count)) IS '/;
  const isAllowed = (stmt: string): boolean => {
    if (stmt === "SET lock_timeout = '5s'") return true;
    if (COMMENTABLE.test(stmt)) return true;
    const alter = stmt.match(/^ALTER TABLE (businesses|zernio_backfill_runs) (.+)$/);
    if (!alter) return false;
    const allowedAdds = alter[1] === 'businesses' ? BUSINESSES_ADDS : RUNS_ADDS;
    const actions = alter[2]
      .split(/,(?= ?(?:ADD COLUMN|DROP CONSTRAINT|ADD CONSTRAINT))/)
      .map((a) => a.trim());
    return actions.every(
      (action) =>
        allowedAdds.includes(action) ||
        (alter[1] === 'businesses' &&
          (action === 'DROP CONSTRAINT IF EXISTS businesses_import_decision_check' ||
            action ===
              "ADD CONSTRAINT businesses_import_decision_check CHECK (import_decision IN ('pending', 'accepted', 'declined', 'expired'))")),
    );
  };
  for (const stmt of statements) {
    expect(isAllowed(stmt), `statement outside the additive-only allowlist: ${stmt}`).toBe(true);
  }
});
```

(The subagent adapts hook plumbing and `sql()`/`businessId` accessors from the 099 suite — probe bodies and titles above are the contract. NOTE for test 4: it runs before the migration exists and must fail red on `executableSql.length` — that is the intended red state. If the `zernio_backfill_runs` INSERT needs more NOT NULL columns than shown, copy the minimal column set from the worker's own initial-INSERT.)

- [ ] **Step 3: Add the red worker assertions** — in `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`:

**Shared helpers** (module scope, next to the existing test helpers). The exact-template pin is the load-bearing assertion: a second UPDATE, an extra clause, or a widened WHERE (`id = ? OR TRUE`) all fail equality; bindings cannot map to wrong columns because the template fixes the column order:

```ts
// #673 dual-write contract: the ONE counts UPDATE, exactly this shape, until
// #680 drops the legacy set. Normalized against Task 3 Step 1's statement.
const DUAL_WRITE_TEMPLATE =
  'UPDATE zernio_backfill_runs SET gap_processed_count = ?, historical_processed_count = ?, ' +
  'gap_skipped_count = ?, historical_skipped_count = ?, imported_count = ?, skipped_count = ?, ' +
  'oldest_skipped_create_time = ?, updated_at = NOW() WHERE id = ?';

function normalizeTemplate(template: readonly string[]): string {
  return template.join('?').replace(/\s+/g, ' ').trim();
}

function findCountsCalls(): any[][] {
  return mockSql.mock.calls.filter((call: any[]) => {
    const template = call[0];
    return Array.isArray(template) && template.some((s: string) => s.includes('gap_processed_count'));
  });
}
```

**3a — new dual-write test, TWO asymmetric distributions.** Both have all four legacy values distinct and different non-zero skipped sums, so a formula specialized to one distribution (or to the legacy zero-skip cases) cannot stay green:

```ts
  // #673 dual-write transition (spec §8a R4): the collapsed counters ride the
  // same UPDATE as the legacy four until #680 drops the legacy set.
  it.each([
    { gapTotal: 28, histTotal: 52, expected: [25, 50, 3, 2, 75, 5] },
    { gapTotal: 27, histTotal: 51, expected: [25, 50, 2, 1, 75, 3] },
  ])(
    'counters UPDATE dual-writes imported_count and skipped_count as sums of the gap and historical counters (gap=$gapTotal hist=$histTotal)',
    async ({ gapTotal, histTotal, expected }) => {
      pushStandardSqlSetup();
      pushCountsUpdate();
      pushCompletedUpdate();

      // gapTotal gap reviews (after activation; GAP_CAP=25) + histTotal
      // historical (before activation; HISTORICAL_CAP=50).
      const reviews = [
        ...Array.from({ length: gapTotal }, (_, i) => makeReview(`rev-gap-${i}`, ACTIVATED_MS + (i + 1) * 60_000)),
        ...Array.from({ length: histTotal }, (_, i) => makeReview(`rev-hist-${i}`, ACTIVATED_MS - (i + 1) * 3_600_000)),
      ];
      mockListAllReviews.mockResolvedValueOnce(reviews);

      await handleZernioBackfill(sqlArg, makeJob({ subscription_tier: 'autopilot' }));

      // Exactly ONE counts UPDATE, exactly the contract template.
      const countsCalls = findCountsCalls();
      expect(countsCalls).toHaveLength(1);
      expect(normalizeTemplate(countsCalls[0][0])).toBe(DUAL_WRITE_TEMPLATE);
      // Positional: legacy four, collapsed sums, oldestSkipped, runId.
      expect(countsCalls[0].slice(1)).toEqual([...expected, expect.anything(), 'run-1']);

      // Locked decision 5 (initial branch): the INSERT does not name the
      // collapsed counters — DEFAULT 0 owns initialization.
      const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
        const template = call[0];
        return Array.isArray(template) &&
          template.some((s: string) => s.includes('INSERT INTO zernio_backfill_runs'));
      });
      expect(insertCalls.length).toBeGreaterThan(0);
      for (const call of insertCalls) {
        const insertJoined = (call[0] as string[]).join('?');
        expect(insertJoined).not.toContain('imported_count');
        expect(insertJoined).not.toContain('skipped_count');
      }
    },
  );
```

**3b — extend the existing reconcile-failure test** (the one asserting a counts UPDATE still happens when reconciliation fails and `completed_at` is NOT stamped) — the dual-write must ride the pre-throw UPDATE with BOTH sums self-consistent, so retries never persist legacy-only counts:

```ts
    // #673: the dual-write rides the partial-counts UPDATE that precedes the
    // reconcile-failure throw — retries must never persist legacy-only counts.
    const [reconcileCounts] = findCountsCalls();
    expect(reconcileCounts).toBeDefined();
    expect(normalizeTemplate(reconcileCounts[0])).toBe(DUAL_WRITE_TEMPLATE);
    const v = reconcileCounts.slice(1) as number[];
    expect(v[4]).toBe(v[0] + v[1]); // imported = gap + historical processed
    expect(v[5]).toBe(v[2] + v[3]); // skipped = gap + historical skipped
```

**3c — extend the existing reactivation test** (the one inserting with `run_reason = 'reactivation'` / the `rev-reactivated` fixture): the reactivation INSERT branch must not name the collapsed counters either (3a only exercises the initial branch):

```ts
    // #673 locked decision 5 (reactivation branch): DEFAULT 0 owns the
    // collapsed counters — the explicit-zero column list stays legacy-only.
    const reactivationInsert = mockSql.mock.calls.find((call: any[]) => {
      const template = call[0];
      return Array.isArray(template) &&
        template.some((s: string) => s.includes('INSERT INTO zernio_backfill_runs'));
    });
    expect(reactivationInsert).toBeDefined();
    const reactivationJoined = (reactivationInsert![0] as string[]).join('?');
    expect(reactivationJoined).not.toContain('imported_count');
    expect(reactivationJoined).not.toContain('skipped_count');
```

- [ ] **Step 4: Run both red**

Run: `cd <worktree> && npx vitest run worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts 2>&1 | tail -20`
Expected: FAIL — both 3a cases and 3b fail on `normalizeTemplate(...) !== DUAL_WRITE_TEMPLATE` (the current UPDATE lacks the collapsed columns); 3c passes already (it pins existing behavior); all other pre-existing tests still PASS.

Run: `cd <worktree> && npx vitest run src/lib/shared/__tests__/migration-100-import-consent.integration.test.ts 2>&1 | tail -20`
(The gate resolves TEST_DATABASE_POOL_URL itself; locally export it or rely on the `.env.local` fallback.)
Expected: FAIL — `assertSchemaReady` reports missing objects for `100_import_consent_and_backfill_counters` with the `pnpm test:db:setup` message (DB at head 099); test 4 fails on empty `executableSql`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(#673): eval task — migration-100 shape suite + red dual-write worker assertions"
```

---

### Task 2: Migration 100 + migrations-log entry

**Files:**
- Create: `supabase/migrations/100_import_consent_and_backfill_counters.sql`
- Modify: `.claude/reference/migrations-log.md` (head line + new entry above 099's)

Step order is deliberate (round-1 finding 11): provision and prove the SQL BEFORE bumping the migrations-log head, so a defect found while provisioning can still be fixed in place without fighting any immutability guard that keys off the recorded head.

- [ ] **Step 1: Author the migration** (099 is the style precedent — header design notes, COMMENT ON COLUMN, named CHECK, lock_timeout, rollback note):

```sql
-- 100_import_consent_and_backfill_counters.sql
-- Consented Review Import (#673, epic map #667): the per-location import-offer
-- state on `businesses`, plus the ADD half of the locked backfill-counter
-- collapse on `zernio_backfill_runs`.
-- Design of record: ADR 0015
-- (docs/adr/0015-consented-import-unflagged-replacement.md) + spec
-- docs/superpowers/specs/2026-08-05-consented-review-import-design.md §4
-- (data model) and §8a R1/R3/R4 (rollout posture, locked at #668).
--
-- Design notes:
-- * Consent lives as columns on `businesses`, not a side table — owner
--   decision at charting (#673): a location has exactly one import offer, and
--   099/089 set the precedent that 1:1 per-location config lives here.
-- * `import_decision` is NOT NULL DEFAULT 'pending' — EXACT per #668. Both
--   environments hold zero `businesses` rows at migration time (prod always
--   empty; staging fully reset 2026-08-05), so there is no existing
--   population, no backfill clause, and no backdating: writing 'accepted' for
--   rows that never answered records a consent that was never given, and was
--   explicitly rejected (§8a R3).
-- * The CHECK pairs with NOT NULL — a CHECK alone passes NULL (checklist).
-- * Deliberately NO cross-column CHECK tying the timestamps to the decision:
--   the writers land later (#677 decision API, #679 expiry sweep) and the
--   'expired' stamping semantics are theirs to lock (owner decision,
--   2026-08-05). A wrong CHECK here costs a migration 101 to undo.
-- * NO index for the expiry sweep — #679 adds a partial index if its scan
--   needs one (099 precedent: no speculative indexes).
-- * The counter ADD is deliberately HALF of the locked collapse (map #667):
--   imported_count = gap + historical processed, skipped_count = gap +
--   historical skipped. ADD here; the DROP of the four legacy
--   gap_*/historical_* counters is a separate cleanup migration (#680) after
--   the epic proves on staging — so `git revert` of any epic PR never leaves
--   the deployed worker writing to a dropped column (§8a R4; the 42703 class
--   flagged at 099). ZernioBackfillWorker dual-writes BOTH sets from the PR
--   that carries this migration.
-- * RLS: existing `businesses` / `zernio_backfill_runs` policies cover the
--   new columns unchanged. No new relation → no retention-policy row.
-- * Additive-only: no backfill, no CONCURRENTLY; one transaction.
-- * COMMENT literals contain NO semicolons — the shape suite splits the
--   executable SQL on ';' to allowlist every statement.
-- Rollback: revert the app deploy (the worker dual-write is the only code
-- touching any of these columns); the columns are inert with code reverted —
-- DEFAULT 'pending' / DEFAULT 0 need no writer. No down migration (099
-- precedent).

SET lock_timeout = '5s';

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS import_decision          TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS import_decision_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS import_offer_expires_at  TIMESTAMPTZ;

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_import_decision_check;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_import_decision_check
  CHECK (import_decision IN ('pending', 'accepted', 'declined', 'expired'));

COMMENT ON COLUMN businesses.import_decision IS
  'Consented Review Import offer state for this location (#673, spec 2026-08-05 §4): pending = not yet answered, accepted/declined = owner answered, expired = offer lapsed unanswered (#679). DEFAULT pending is exact — zero rows existed at migration time (§8a R3), and backdating to accepted was rejected.';
COMMENT ON COLUMN businesses.import_decision_at IS
  'When the owner answered the import offer. NULL while pending. Whether the #679 expiry sweep stamps this for expired rows is that ticket''s decision — deliberately unconstrained here.';
COMMENT ON COLUMN businesses.import_offer_expires_at IS
  'Import-offer deadline: prompt creation + 7 days (#677 writes it). NULL until the offer is first shown.';

ALTER TABLE zernio_backfill_runs
  ADD COLUMN IF NOT EXISTS imported_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count  INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN zernio_backfill_runs.imported_count IS
  'Collapsed successor of gap_processed_count + historical_processed_count (map #667). ADD half of the two-migration collapse (§8a R4) — the legacy four DROP in #680. Dual-written by ZernioBackfillWorker until then.';
COMMENT ON COLUMN zernio_backfill_runs.skipped_count IS
  'Collapsed successor of gap_skipped_count + historical_skipped_count (map #667). Same two-migration collapse as imported_count; oldest_skipped_create_time is unchanged.';
```

- [ ] **Step 2: Provision + run the shape suite green** (BEFORE touching the migrations-log)

Run: `cd <worktree> && pnpm test:db:setup 2>&1 | tail -3`
Expected: provisions through 100 without error.

Run: `cd <worktree> && npx vitest run src/lib/shared/__tests__/migration-100-import-consent.integration.test.ts 2>&1 | tail -8`
Expected: PASS — all 4 shape tests green.

- [ ] **Step 3: Update `.claude/reference/migrations-log.md`** — line 4 becomes `Current head: **100** — next migration is **101**`, and a new `- **100** — …` entry goes ABOVE the 099 entry, carrying **LOCAL-ONLY**:

```markdown
- **100** — `import_consent_and_backfill_counters`: **Consented Review Import**
  schema (#673, epic #667; ADR 0015 + spec
  `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §4,
  §8a R3/R4). Three additive columns on `businesses` — `import_decision` TEXT
  `NOT NULL DEFAULT 'pending'` under the named CHECK
  `businesses_import_decision_check` (`pending|accepted|declined|expired`),
  plus nullable TIMESTAMPTZ `import_decision_at` / `import_offer_expires_at`.
  Deliberately NO cross-column CHECK (the #677 decision API and #679 expiry
  sweep own those semantics — owner decision 2026-08-05) and NO index (#679
  adds one if its sweep needs it). Plus the ADD half of the locked counter
  collapse on `zernio_backfill_runs`: `imported_count` + `skipped_count`
  INTEGER `NOT NULL DEFAULT 0`; the four legacy `gap_*`/`historical_*`
  counters stay until the #680 cleanup migration so `git revert` of any epic
  PR never leaves the worker writing to a dropped column (§8a R4).
  `ZernioBackfillWorker` dual-writes both sets from this PR (imported = gap +
  historical processed; skipped = gap + historical skipped); tenant-scope
  allowlist re-pinned. DEFAULT `'pending'` is exact: both environments held
  zero `businesses` rows (§8a R3) — backdating was rejected. No new relation →
  no retention-policy row, no RLS change. `SET lock_timeout = '5s'` (099
  precedent). Shape suite
  `src/lib/shared/__tests__/migration-100-import-consent.integration.test.ts`;
  schema-ready entry `MIGRATION_100_IMPORT_CONSENT`. **LOCAL-ONLY**
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/100_import_consent_and_backfill_counters.sql .claude/reference/migrations-log.md
git commit -m "feat(#673): migration 100 — import-consent columns + collapsed backfill counters (ADD half)"
```

---

### Task 3: Worker dual-write + allowlist re-pin

**Files:**
- Modify: `worker/jobs/zernio/ZernioBackfillWorker.ts:255-265` (the counts UPDATE)
- Modify: `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts:309` (the pinned positional assertion)
- Modify: `scripts/ci/tenant-scope-allowlist.ts:2223` (the pinned sqlSnippet)

- [ ] **Step 1: Dual-write the counts UPDATE** — replace the statement at line 256-265 with:

```ts
  // Always update partial counts so ops can audit even on retry.
  // Dual-write transition (#673, spec §8a R4): the collapsed counters ride
  // the same UPDATE as the legacy four until the #680 cleanup migration
  // drops the legacy set. Mapping locked at map #667:
  // imported = gap + historical processed; skipped = gap + historical skipped.
  const importedCount = gapProcessed + historicalProcessed;
  const skippedCount = gapSkipped + historicalSkipped;
  await sql`
    UPDATE zernio_backfill_runs
    SET gap_processed_count = ${gapProcessed},
        historical_processed_count = ${historicalProcessed},
        gap_skipped_count = ${gapSkipped},
        historical_skipped_count = ${historicalSkipped},
        imported_count = ${importedCount},
        skipped_count = ${skippedCount},
        oldest_skipped_create_time = ${oldestSkipped},
        updated_at = NOW()
    WHERE id = ${run.id}
  `;
```

- [ ] **Step 2: Update the pinned positional assertion** — the existing `'Copilot processes historical reviews up to the historical cap'` test asserts `expect(countsCallStrings!.slice(1)).toEqual([0, 3, 0, 0, null, 'run-1'])`; two values join the array (order matches Step 1's SQL: legacy four, then collapsed two, then oldest, then id):

```ts
    expect(countsCallStrings!.slice(1)).toEqual([0, 3, 0, 0, 3, 0, null, 'run-1']);
```

- [ ] **Step 3: Re-pin the tenant-scope allowlist** — replace the `sqlSnippet` of the counts-UPDATE entry (`scripts/ci/tenant-scope-allowlist.ts:2223`) with:

```ts
    sqlSnippet: "UPDATE zernio_backfill_runs SET gap_processed_count = ${gapProcessed}, historical_processed_count = ${historicalProcessed}, gap_skipped_count = ${gapSkipped}, historical_skipped_count = ${historicalSkipped}, imported_count = ${importedCount}, skipped_count = ${skippedCount}, oldest_skipped_create_time = ${oldestSkipped}, updated_at = NOW() WHERE id = ${run.id}",
```

(Keep `file`, `table`, `category`, `reason` unchanged. If `pnpm ci:tenant-scope` reports a snippet mismatch, copy the EXACT extracted snippet from the audit's error output — the audit's normalizer, not this plan, owns the byte-for-byte form.)

- [ ] **Step 4: Run green**

Run: `cd <worktree> && npx vitest run worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts 2>&1 | tail -8`
Expected: PASS — all tests, including Task 1's dual-write test and the extended reconcile-failure assertion.

Run: `cd <worktree> && pnpm ci:tenant-scope 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/zernio/ZernioBackfillWorker.ts worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(#673): ZernioBackfillWorker dual-writes collapsed counters; re-pin tenant-scope allowlist"
```

---

## Self-review notes

- Spec coverage: §4 data model → Task 2; §8a R3 (exact DEFAULT, no backfill) → Task 2 header + shape test 1 (catalog default); §8a R4 (additive-only, legacy counters present) → Task 2 + shape tests 3 and 4; ticket's allowlist instruction → Task 3; dual-write decision → Task 3; INSERT branches untouched → shape test 3's default probe + worker test 3a's INSERT-absence assertions; retry path → 3b's reconcile-failure extension.
- Type consistency: `importedCount`/`skippedCount` locals named identically in worker code (Task 3 Step 1) and allowlist snippet (Task 3 Step 3). `MIGRATION_100_IMPORT_CONSENT` named identically in Task 1 Steps 1–2. Constraint name `businesses_import_decision_check` identical in migration, schema-ready entry, and suite. Positional arrays in 3a ([25,50,3,2,75,5,…]) and Task 3 Step 2 ([0,3,0,0,3,0,…]) both follow Step 1's SQL interpolation order.
- The gate (step 5 of /feature) owns full lint/typecheck/test/audit runs; task steps only run the targeted files.
