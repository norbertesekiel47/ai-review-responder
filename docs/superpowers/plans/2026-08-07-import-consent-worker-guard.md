# #679 — Import consent worker guard + Import offer analytics

**Branch:** `feat-679-import-consent-worker-guard`
**Intake:** `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json`
**Spec:** `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.1, §5.3
**ADR:** `docs/adr/0015-consented-import-unflagged-replacement.md` (R2 — this ticket closes it)
**Risk:** high (worker + migration) · **Surface:** mixed · **DB-touching:** yes

---

## 1. What this ticket is

Two slices, both deferred here by earlier tickets in map #667:

1. **The fail-closed Import consent gate in `ZernioBackfillWorker`** (spec §5.3).
   The four enqueue producers are all consent-gated as of #677, but the worker is
   not — a hand-inserted `zernio_initial_backfill` outbox row still imports
   without consent. ADR 0015 R2 accepts that only while production holds zero
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
- `docs/analytics/events.md` — two entries in the block format
  `ci:analytics-events` parses (`### \`name\`` + `**Status:** live` + Description /
  Owner / Source / Distinct ID / Event key / Required / Optional / Privacy notes).
- `src/lib/shared/__tests__/migration-097-suppression-analytics-events.integration.test.ts`
  — **re-pin to its own historical 23-name list** and hand the live drift guard to
  102's suite. This is the 089 → 094 → 097 precedent, stated explicitly in 097's
  own migrations-log entry; the latest constraint-replacing migration owns the
  guard.
- `.claude/reference/migrations-log.md` — the 102 entry. **Constraint-only: no
  `SchemaRequirement` export and no `assertSchemaReady` entry**, exactly as 094 and
  097 record, because a presence check on a constraint name that has existed since
  046 proves nothing.

Turns green: the six migration-shape titles.

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

Turns green: the eight analytics titles.

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

Reads the derived state via `importConsentStateSql(sql)` — imported, never
re-spelled — aliasing `businesses` as `b` per that fragment's fixed contract.
Proceeds **only** on `'accepted'`. Every other value, and a missing row, completes
the outbox row and returns `{ kind: 'skipped' }` with a structured log line
carrying the blocked state and `business_id` (intake `observability` item 1),
shaped like the existing `SKIP_REASON_ARCHIVED_LOCATION` line.

Deliberately returns no `account` payload, so it does not reuse
`ZernioJobEligibility` (whose `'proceed'` arm carries one).

Turns green: the nine `guardImportConsent` titles.

### T4 — Wire into the backfill worker (blocking: T3)

`worker/jobs/zernio/ZernioBackfillWorker.ts` — call `guardImportConsent`
**immediately after `extractOutboxHandle` and before the
`zernio_backfill_runs` INSERT** (currently line 148). Owner decision, 2026-08-07:
this deviates from spec §5.3's literal "joins the existing pre-flight guards"
placement so that a refused run leaves **no durable trace at all**. Record it in
the deviations file.

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

- **D1 — `tests_to_add` retitled for the migration slice (3 → 6 titles).** The
  intake's "migration 102 still rejects an unregistered event name" is not testable
  by 097's precedent suite, which is pure SQL-text and never touches a live DB.
  Replaced with the precedent's own five assertions plus the 097 re-pin. A
  `tests_to_add` retitle is a deviations entry, not a surface amendment (#643 D5) —
  the abort budget stays at **0 of 2**.
- **D2 — runbook test placed at `src/app/admin/__tests__/`**, not at
  `src/__tests__/runbook-empty-polish.test.ts`'s location. The existing file is a
  cross-page polish suite; a page-specific assertion belongs beside the page, and
  `src/app/admin/__tests__/page-chrome.test.ts` is the local precedent. No surface
  amendment needed — the chosen path is already in `allowed_edit_surface`.

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
