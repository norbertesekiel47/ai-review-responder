# #679 — Import consent worker guard + Import offer analytics

**Branch:** `feat-679-import-consent-worker-guard`
**Intake:** `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json`
**Spec:** `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.1, §5.3
**ADR:** `docs/adr/0015-consented-import-unflagged-replacement.md` §2 (ordering
replaces the flag) and §3 (zero surviving businesses in either environment — the
acceptance that lets this hole stay open until now).

> **Citation correction (round-1 miss 1).** Earlier drafts, the #679 ticket
> comments, and `.claude/CLAUDE.md` all cite "ADR 0015 R2" for this ticket. The ADR
> has numbered sections 1–4 and **no R2**. The real R2 is spec §8a:301 and governs
> #677-landing-before-#676, not the worker hole. Fix `.claude/CLAUDE.md` in the
> post-merge sweep.
**Risk:** high (worker + migration) · **Surface:** mixed · **DB-touching:** yes

---

## 1. What this ticket is

Two slices, both deferred here by earlier tickets in map #667:

1. **The fail-closed Import consent gate in `ZernioBackfillWorker`** (spec §5.3).
   The four enqueue producers are all consent-gated as of #677, but the worker is
   not — a hand-inserted `zernio_initial_backfill` outbox row still imports
   without consent. ADR 0015 §3 accepts that only while production holds zero
   customers. This is the last consent hole in the epic.
2. **The two Import offer analytics events** (#677 deviation D7).
   `import_offer_created` / `import_decision_recorded` need the
   `analytics_events.event_name` CHECK extended, which #677's non-goals forbade.

They ship together because both touch `src/lib/reviews/import-consent.ts` and
because the analytics half needs the one-migration-in-flight slot, which #680
also wants.

## 2. Design — modules and seams

Consulted `codebase-design`. **No new interface is introduced and no seam moves.**

| Module | Change | Depth verdict |
|---|---|---|
| `src/lib/reviews/import-consent.ts` | +2 `enqueueAnalyticsEvent` calls, inside the two writers | **Deepening.** Signatures and return types unchanged; callers learn nothing new. Moving the emissions to callers would repeat the event key, the properties, and the "only when actually written" condition at 3 `createImportOffer` sites — the deletion test says the complexity reappears ×3. Precedent: `recordSuppression`. |
| `worker/jobs/zernio/job-eligibility.ts` | +`guardImportConsent` | **Deepening an existing module**, not a new one — this file already owns "the shared pre-flight guard sequence for the Zernio job workers". The new function hides the fragment import, the `b`-alias contract, the fail-closed classification, the outbox completion, and the log line behind the same `(sql, input) => { kind }` idiom `guardZernioJobEligibility` already uses. |
| `worker/jobs/zernio/ZernioBackfillWorker.ts` | call site, ~8 lines | No interface change. |
| `src/lib/analytics/events.ts` | +2 array entries | No design question. |
| `src/app/admin/runbook/page.tsx` | A5 entry text | Data-only. |

**Why `guardImportConsent` is a separate function and not a `jobKind === 'backfill'`
branch inside `guardZernioJobEligibility`** (spec §5.3, re-derived here in design
terms): a merged guard would have two callers, one of which must never reach the
consent code. Splitting makes live-ingest independence **structural** — the ingest
worker never learns the interface — instead of a runtime branch a future edit can
flip. One caller, one interface.

**One interface fact genuinely changes** and must be written into the
`import-consent.ts` header: both writers now require that the database's
`analytics_events_event_name_check` admits the two names. That precondition is
exactly why T1 must land before T2, and why migration 102 must be applied to a
Supabase project before the emitting code reaches it.

**The guard is transactional, and that is a correctness requirement, not tidiness**
(round-1 blocking finding). Without serialization this interleaving loses an import
permanently:

1. Worker reads `pending` from an in-flight hand-inserted row.
2. Owner accepts. `recordImportDecisionAndEnqueue` locks the business row, writes
   `accepted`, and calls `enqueueInitialImport` — whose
   `NOT EXISTS (… status IN ('pending','dispatching','dispatched'))`
   (`import-consent.ts:467-472`) sees the worker's row still in flight and inserts
   **no replacement**.
3. Worker completes the old row as a consent skip.

Final state: `import_decision = 'accepted'`, no completed initial run, **no runnable
outbox row** — spec §5.1's accepted-but-incomplete retryability violated by silent
permanent data loss, for a customer who said yes. Nothing retries it; the banner
polls `importing` forever (the A4 class #677 fixed).

The fix is serialization, not a wider read: `guardImportConsent` runs inside
`sql.begin`, takes `SELECT … FOR UPDATE` on the `businesses` row, and issues its
`markOutboxCompleted` **in that same transaction** — the same business-before-outbox
lock order `recordImportDecisionAndEnqueue` already uses, so no deadlock. Either
order then resolves correctly: guard-first completes the row and acceptance inserts
a fresh runnable one; acceptance-first means the guard reads `accepted` and proceeds.
`SELECT … FOR UPDATE` outside `sql.begin()` is a **no-op** under Supabase's
transaction pooling (CLAUDE.md gotcha), so the transaction is load-bearing, not
decorative. `markOutboxCompleted` already takes `SqlExecutor`
(`src/lib/shared/outbox.ts:86-90`), so it accepts the `tx` handle unchanged, and
`worker/__tests__/helpers/mock-sql.ts` already supports `sql.begin` with
`inTransaction` tracking on `sqlCalls` — so this is unit-testable without a live DB.

**Tenant scope.** `guardImportConsent` binds `b.id` alone, with no `account_id` —
the backfill payload carries no account id. This matches `guardZernioJobEligibility`
(`job-eligibility.ts:60-65`), which does the same and passes `ci:tenant-scope`
today because `businesses.id` *is* the tenant key. No allowlist entry.

## 3. Tickets

Blocking edges and file sets are declared so step 4 can dispatch the independent
ones in parallel.

### T0 — Eval task (runs alone; enforcement spot check)

Author every `tests_to_add` title as a **failing** test, committed before any
implementation. No `.todo` markers needed — every slice is specifiable now.

Files:
- `worker/jobs/zernio/__tests__/job-eligibility.test.ts` *(new — the module has no
  unit suite today; it is covered only through the two worker suites)*
- `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` *(extend)*
- `worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts` *(extend — one
  test: ingest does not call the consent guard)*
- `src/lib/reviews/__tests__/import-consent.integration.test.ts` *(extend)*
- `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts` *(extend
  — the restored #677 self-heal title)*
- `src/lib/shared/__tests__/migration-102-import-consent-analytics-events.integration.test.ts` *(new)*
- `src/app/admin/__tests__/runbook-import-consent.test.ts` *(new)*

**Fixture change is central, not per-test.** The backfill suite holds **35** tests
with **30** `pushImportSqlSetup` call sites, all reaching past the guards through
that one helper (`ZernioBackfillWorker.test.ts:170-184`), which queues four results
in order: run INSERT → run SELECT → eligibility account row → connection row. The
consent guard runs **first**, so the fixture gains **one** push at the front
(`[{ state: 'accepted' }]`) plus an `importDecision` option. One edit, 30 call
sites unaffected.

> The ticket's own comments say "27 existing backfill tests" — that was true at
> `main@349c8c57`, before #675 and #677 landed. Counted fresh against this
> branch's base (`main@2f369582`). Do not re-inherit the stale number.

**Three tests hand-queue SQL outside the helper and each needs a consent result
prepended** (round-1 finding 6 — the central fixture change is necessary but not
sufficient):

| Test | Lines | Action |
|---|---|---|
| archived-location | 307–334 | prepend consent result |
| missing-business | 339–355 | **rewrite, see below** |
| already-completed | 965–978 | prepend consent result |

**The missing-business test must be rewritten, not patched.** Once the consent
guard runs first, a missing `businesses` row is intercepted by the guard and emits
the consent-block line — so `guardZernioJobEligibility`'s backfill-only
`subscription_status=missing` log becomes **unreachable for the backfill worker**.
That is deliberate (the fail-closed reason is the more accurate one), but the test
must assert the new authority, and both guard-ordering JSDoc blocks
(`ZernioBackfillWorker.ts:198-205`, `job-eligibility.ts:34-49`) must stop claiming
a branch that can no longer fire. Covered by the title
*"handleZernioBackfill blocks a missing business row before the subscription_status=missing skip line"*.

The race test (*"an acceptance racing a pending-job consent skip leaves one runnable
zernio_initial_backfill job"*) goes in a **new**
`worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts` — it must force
the interleaving against real Postgres, because the whole defect is a lock
interaction a mock cannot model. Live-DB conventions apply: `*.integration.test.ts`
naming, `assertSchemaReady`, no migration SQL at run time.

Use `sqlCalls` from `worker/__tests__/helpers/mock-sql.ts` — the executed,
fragment-flattened accessor — not `mockSql.mock.calls`, which does not flatten the
`importConsentStateSql` fragment.

### T1 — Migration 102 + registration (blocking: none)

Invoke `new-migration` before the first line of SQL. Head is **101**, next is
**102** (re-confirm against `.claude/reference/migrations-log.md` at execution
time).

- `supabase/migrations/102_import_consent_analytics_events.sql` — the
  `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` swap under `SET lock_timeout = '5s'`,
  copying 097's 23-name list **verbatim and in order** and appending the two new
  names. Header carries the rollback note and the deploy-ordering hazard.
- `src/lib/analytics/events.ts` — both names appended to `ANALYTICS_EVENT_NAMES`
  (**not** `CLIENT_ENQUEUEABLE_EVENT_NAMES` — these are durable server facts).
- `docs/analytics/events.md` — two entries in the full house block (`### \`name\`` +
  `**Status:** live` + Description / Owner / Source / Distinct ID / Event key /
  Required / Optional / Privacy notes).
  **Correction (round-1 miss 4):** `ci:analytics-events` parses only the heading and
  the `**Status:**` line (`scripts/ci/analytics-events-audit.ts:13-22`) — the other
  fields are house style enforced by review, not by CI. Write them anyway; do **not**
  add a parser test to enforce them (rejected as scope creep — the taxonomy is a doc
  convention, not this ticket's definition of done).
- `src/lib/shared/__tests__/migration-097-suppression-analytics-events.integration.test.ts`
  — **re-pin to its own historical 23-name list** and hand the live drift guard to
  102's suite. This is the 089 → 094 → 097 precedent, stated explicitly in 097's
  own migrations-log entry; the latest constraint-replacing migration owns the
  guard.
- `.claude/reference/migrations-log.md` — the 102 entry. **Constraint-only: no
  `SchemaRequirement` export and no `assertSchemaReady` entry**, exactly as 094 and
  097 record, because a presence check on a constraint name that has existed since
  046 proves nothing.

**The suite is text-shape PLUS a live rejection assertion.** 097's suite is pure SQL
text; 102's keeps those five text assertions and adds one live-DB test for the
restored locked title *"migration 102 still rejects an unregistered event name"* —
insert a bogus `event_name` inside a rolled-back `sql.begin` and assert SQLSTATE
`23514`. Round-1 finding 2 is right that superset-plus-subset does not prove
rejection: it permits a CHECK carrying extra DB-only names. Reject was a locked
definition-of-done title and is restored rather than deviated away.

Turns green: the seven migration titles.

### T2 — Analytics emissions (blocking: T1)

`src/lib/reviews/import-consent.ts`:
- `createImportOffer` — emit `import_offer_created` when and only when the UPDATE
  returned a row (i.e. the `'created'` branch). `'unchanged'` emits nothing, or
  every dashboard mount re-mints.
- `recordImportDecisionAndEnqueue` — emit `import_decision_recorded` inside
  `sql.begin`, only on the `'recorded'` path. Rejections emit nothing.
- Replace the header's "NO ANALYTICS EVENTS IN THIS MODULE (deviations D7)" block
  with the shipped contract, **including the CHECK precondition** from §2 above.

Event keys are business-scoped — `import_offer_created_<businessId>`,
`import_decision_recorded_<businessId>` — so a replay drops on
`ON CONFLICT (event_key) DO NOTHING` rather than double-counting. Both are
at-most-once per business by construction (the offer write requires a NULL
deadline; the decision write requires `pending`), so the key never needs a
discriminator.

`distinctId` is the account id, matching every other account-scoped event.
Properties: `{ window_days }` and `{ decision }` respectively. No handles, no
review text.

**The emission must use `tx`, never the outer `sql`** (round-1 finding 3).
`recordImportDecisionAndEnqueue` has both in scope, and
`enqueueAnalyticsEvent(sql, …)` from inside the callback would pass every
happy-path test while letting the analytics row **commit independently of a
decision that later rolls back** — a recorded decision that never happened. Pinned
behaviourally, not by executor identity: force the transaction to abort and assert
no `analytics_events` row survives. Precedent:
`src/lib/solicitation/__tests__/suppression.integration.test.ts:365-406`.

Turns green: the nine analytics titles.

### T3 — `guardImportConsent` (blocking: none — parallel with T1, T5)

`worker/jobs/zernio/job-eligibility.ts`:

```ts
export type ImportConsentGate = { kind: 'proceed' } | { kind: 'skipped' };

export async function guardImportConsent(sql: Sql, input: {
  businessId: string;
  outboxId: string;
  attempt: number | undefined;
  logger: WorkerLogger;
}): Promise<ImportConsentGate>
```

**The whole body runs inside `sql.begin`** (§2's race). Shape:

```ts
return sql.begin(async (tx) => {
  const [row] = await tx`
    SELECT ${importConsentStateSql(tx)} AS state
    FROM businesses b
    WHERE b.id = ${businessId}::uuid
    FOR UPDATE
  `;
  if (row?.state === 'accepted') return { kind: 'proceed' };
  logger.log('import consent blocked — skipping backfill', {
    reason: /* the blocked state, or 'missing' */,
    business_id: businessId,
  });
  await markOutboxCompleted(tx, outboxId, attempt);   // SAME tx — load-bearing
  return { kind: 'skipped' };
});
```

Reads the derived state via `importConsentStateSql(tx)` — imported, never
re-spelled — aliasing `businesses` as `b` per that fragment's fixed contract.
Proceeds **only** on `'accepted'`. Every other value, and a missing row, completes
the outbox row and returns `{ kind: 'skipped' }` with a structured log line
carrying the blocked state and `business_id` (intake `observability` item 1),
shaped like the existing `SKIP_REASON_ARCHIVED_LOCATION` line.

Deliberately returns no `account` payload, so it does not reuse
`ZernioJobEligibility` (whose `'proceed'` arm carries one).

Two properties the tests must pin beyond the state matrix (round-1 findings 1, 4),
because all nine state tests pass against an unscoped or unserialized query that
merely returns the queued row: the SELECT is scoped to the **input** `businessId`
(assert flattened SQL text *and* the bound value via `sqlCalls`), and the
`markOutboxCompleted` call is `inTransaction`.

Turns green: the eleven `guardImportConsent` titles.

### T4 — Wire into the backfill worker (blocking: T3)

`worker/jobs/zernio/ZernioBackfillWorker.ts` — call `guardImportConsent`
**immediately after `extractOutboxHandle` (line 138) and before the
`zernio_backfill_runs` INSERTs** (the `isReactivationBackfill` branch opens at 148;
the two INSERT statements themselves start at 150 and 163 — round-1 miss 3 corrected
the earlier "line 148" citation). Owner decision, 2026-08-07: this deviates from
spec §5.3's literal "joins the existing pre-flight guards" placement so that a
refused run leaves **no durable trace at all**. Record it in the deviations file.

**Malformed-payload carve-out — stated explicitly, as round-1 finding 5 requires.**
`isSubscriptionTier` throws at lines 135–137, *before* `extractOutboxHandle` and
therefore before the consent guard. **That ordering stays.** An unparseable tier is
an impossible state to assert on (CLAUDE.md: assert impossible states, don't branch
around them), and no import happens on either path — only the outbox disposition
differs (throw/retry rather than skip-complete), so the consent promise is intact.
The existing test at lines 259–273 remains the authority and is not weakened. The
new title *"handleZernioBackfill throws on an unsupported tier before reaching the
consent guard"* pins the carve-out so a later reorder is a red test rather than a
silent behaviour change. The reviewer's alternative — moving consent ahead of tier
validation — is **rejected**: it would trade a loud bug signal for a silent skip.

Applies to both `backfill_reason` values — the reactivation producer
(`archive-location-tx.ts:539-545`) already requires `accepted`, and an answered
decision outranks its deadline, so a post-expiry reactivation catch-up still
passes.

Also update the guard-ordering JSDoc block at `ZernioBackfillWorker.ts:198-205`
and `job-eligibility.ts:34-49` so the documented order matches the code.

Turns green: the seven worker-wiring titles.

### T5 — Runbook + stale JSDoc (blocking: none — parallel with T1, T3)

- `src/app/admin/runbook/page.tsx` A5 `fix` — the re-enqueue instruction becomes
  conditional on `businesses.import_decision = 'accepted'` **and** no completed
  initial run, and states that declined or expired is permanent (D8), admin path
  included. A5 `firstCheck` gains `import_decision` / `import_offer_expires_at` so
  ops can tell a consent block from an outage.
- `src/lib/shared/worker-types.ts:225-227` — the `ZernioInitialBackfillPayload`
  JSDoc still says "emitted by the connect-callback … and by reactivation
  catch-up", which has been wrong since #677 added the acceptance transaction and
  the Stripe activation producer. Correct it to name all four producers.

Turns green: the runbook title.

## 4. Dispatch order

```
T0  (alone — enforcement spot check)
 ├─ T1 ─── T2
 ├─ T3 ─── T4
 └─ T5
```

Wave 1: T0. Wave 2: T1, T3, T5 in parallel (disjoint file sets, no edges).
Wave 3: T2, T4 in parallel.

## 5. Deviations recorded at plan time

- **D1 — `tests_to_add` EXPANDED for the migration slice (3 → 7 titles).**
  *Superseded by round 1.* The first draft deleted the locked title "migration 102
  still rejects an unregistered event name" on the grounds that 097's pure-SQL-text
  precedent could not express it. That was wrong: the constraint is testable live
  (insert a bogus name in a rolled-back transaction, assert SQLSTATE `23514`), and
  superset-plus-subset does **not** prove rejection — it permits extra DB-only
  names. The title is **restored** and the four precedent assertions are added
  alongside it. Nothing was deleted.
- **D2 — runbook test placed at `src/app/admin/__tests__/`**, not at
  `src/__tests__/runbook-empty-polish.test.ts`'s location. The existing file is a
  cross-page polish suite; a page-specific assertion belongs beside the page, and
  `src/app/admin/__tests__/page-chrome.test.ts` is the local precedent. No surface
  amendment needed — the chosen path is already in `allowed_edit_surface`.
- **D3 — `guardImportConsent` is transactional.** Round-1 blocking finding: an
  unserialized guard loses an accepted import permanently. Guard now wraps
  `sql.begin` + `FOR UPDATE` + in-transaction `markOutboxCompleted`. Deepens the
  implementation; interface unchanged.
- **D4 — six test titles added** (`tests_to_add` 28 → 38, incl. D1's four): the race
  test, the `b.id` scoping test, the in-transaction completion test, the
  transaction-rollback analytics test, the tier carve-out test, and the rewritten
  missing-business test. Additions, not retitles — nothing locked was dropped.
- **D5 — `estimated_test_lines` 560 → 700, `estimated_prod_lines` 210 → 230.**
  Honest restatement after review expanded the eval; recorded here so step 5's
  `reclassify` row is checked against a real estimate rather than a flattering one.
- **D6 — the malformed-tier ordering carve-out** is now explicit in the intake's
  `edge_cases` and in T4, with the reviewer's proposed reorder rejected and the
  reasoning stated.
- **D7 — three intake facts corrected** (round-1 misses 1, 4, 5): the ADR "R2"
  citation, the claim that `ci:analytics-events` validates the full doc block, and
  the claim that the 097 suite holds `acquireLiveDbLock`. All were intake-field
  corrections, not surface amendments.
- **D8 — spec §5/§5.3 drift noted, not fixed here.** The design of record still says
  *three* enqueue paths; source has four (three `enqueueInitialImport` callers plus
  the accepted-only reactivation enqueue). `docs/superpowers/specs/**` is outside
  `allowed_edit_surface`; the correction rides the post-merge sweep.

**Abort budget: 0 of 2 surface amendments used.** Every entry above is a
deviations-file record or an intake-field correction; `allowed_edit_surface` is
unchanged since setup.

## 6. Deploy sequence (RISK = high lane)

1. Apply migration 102 to the **staging** Supabase project.
2. Push the branch to `staging`; full stack auto-deploys.
3. Smoke: a `pending` business's hand-inserted `zernio_initial_backfill` row
   no-op-completes with the block log line and mints no `zernio_backfill_runs`
   row; an `accepted` business still imports; the two events land in
   `analytics_events`.
4. PR to `main`, all CI green, **pause for owner merge approval**.
5. Apply migration 102 to **prod** Supabase in lockstep at promotion, before the
   emitting code goes live.

### Why the ordering survives the savepoint (round-2 correction)

Both analytics emissions are wrapped in a postgres.js SAVEPOINT
(`emitConsentEvent`, `src/lib/reviews/import-consent.ts`, commit `bfac89d4`), so
an unapplied 102 rolls back only the failed insert. **The cost is a lost metric
plus a `warn` line — not a lost owner decision, and not a failed connect.**

Round 1 found the pre-savepoint radius was materially worse than the plan had
described: `createImportOffer` rides `finalizeConnectionTx`, and
`select-location/route.ts` rethrows anything that is not `23505`, so an
unapplied 102 broke **Google Business Profile connect entirely**. The spec and
adversarial axes converged on it independently.

**Step ordering above is unchanged and still load-bearing.** The savepoint
contains the blast radius; it does not make the ordering optional. A deploy that
leads the migration silently drops every `import_offer_created` and
`import_decision_recorded` until 102 lands, and the only signal is a stdout
`warn` with no durable or paged sink — tracked as **#697**.
