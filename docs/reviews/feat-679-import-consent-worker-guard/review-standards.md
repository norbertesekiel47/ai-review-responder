# #679 — standards & maintainability review (round 1)

Branch `feat-679-import-consent-worker-guard`, diff `2f369582..HEAD`.
Axis: repo standards, deep-module discipline, Fowler smells, glossary, test quality.
Method: `thermo-nuclear-code-quality-review` skill applied to the branch diff, plus the
RepWorth-specific checks in the brief.

Production surface is 342 lines across 7 files; tests are 1673 across 11. `pnpm typecheck`
is clean. No `any`, no `@ts-expect-error`, no `eslint-disable`, no silent catch in
production code. Invariants #2, #12, #13, #15 hold on the changed surface
(`guardImportConsent` takes `sql: Sql` as a parameter; the analytics writes go through
`enqueueAnalyticsEvent`, not a raw INSERT; the worker handler orchestrates and the guard
owns its own failure behaviour).

The defects below are concentrated in the test lane, which is where the brief predicted
they would be.

---

## 1. Findings (≥80% confidence)

| Severity | file:line | Finding |
|---|---|---|
| **High** | `src/lib/reviews/__tests__/import-consent.integration.test.ts:969-979` | Run-time DDL (`ALTER TABLE job_outbox ADD/DROP CONSTRAINT tmp_block_import_topic_analytics`) inside a non-migration-shape live-DB suite. Violates the CLAUDE.md live-DB gotcha and `ci:live-db-suites` R2's stated intent; on timeout the constraint strands on the shared container and breaks every sibling suite (14 spurious failures already observed, D20). The file header at `:17-19` advertises the opposite ("NEVER applies migration SQL"). Non-DDL replacement in §2. |
| **High** | `scripts/ci/live-db-suites-audit.ts:117` | R2's DDL detector is `text.includes('supabase/migrations') && text.includes('.unsafe(')`. It keys on an incidental marker, not on DDL, so it misses every DDL site whose file does not name a migration path — three in-repo today (`import-consent.integration.test.ts:969`, `route.integration.test.ts:150` (pre-existing), `NotificationFailoverPoller.integration.test.ts:173` (pre-existing, plain template)). Same defect class this audit's own header describes for #573. One-line fix in §3. |
| **Medium** | `src/lib/reviews/__tests__/import-consent.integration.test.ts` (790 → **1039** lines) | The PR pushes a file from under 1000 lines to over it by appending a distinct feature slice — the six #679 analytics titles at `:834-1038`, with their own fixture block at `:178-219`. The branch already proved it is willing to open a new file for a #679 slice (`migration-102-…integration.test.ts`), so the decomposition is available and in-convention. Extracting it also shrinks the blast radius of finding 1. |
| **Medium** | `src/lib/reviews/__tests__/import-consent.integration.test.ts:236` | `assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT])` is unchanged, but T2 put the analytics emission *inside* `recordImportDecisionAndEnqueue`, adding a migration-102 precondition to roughly ten **pre-existing** #677 titles that never had one. On a DB at 101 they now fail with an opaque SQLSTATE 23514 rather than the loud, named "DB is behind head" the `assertSchemaReady` convention exists to give. Migration 102 deliberately exports no `SchemaRequirement` (correctly — a presence check on a constraint name that has existed since 046 proves nothing), so the gap is structural and needs an explicit assertion. |
| **Low** | `worker/jobs/zernio/__tests__/job-eligibility.test.ts:307` | `expect(completionCalls[0]!.exec).toBe(mockSql)` cannot fail for the property it names: `mock-sql.ts:99-103` documents that `sql.begin(cb)` invokes `cb` with *the same mock*, so this passes identically whether the implementation passes `tx` or the outer client. The comment beside it concedes this. An assertion that cannot fail should be deleted, not annotated — annotated, it still reads as coverage in a diff review. |
| **Low** | `worker/jobs/zernio/__tests__/job-eligibility.test.ts:188-200` | *"…whose offer deadline is NULL"* arranges the identical `pushConsentState('pending')` fixture as *"…whose offer has not expired"* at `:168-176`. The guard consumes the **derived** state, so this seam structurally cannot distinguish a NULL deadline from a live offer; the title advertises a scenario the test does not construct. The one assertion that differs (`text` contains `import_offer_expires_at IS NOT NULL`) is about the shared fragment, not about the NULL case. |
| **Low** | `src/app/admin/__tests__/runbook-import-consent.test.ts:31-37` | `scenarioBlock(source, 'A5')` is unbounded: A5 is the last entry in `SCENARIOS` (`page.tsx:95`), so `rest.search(/id: 'A\d+'/)` returns `-1` and `block` is the entire remainder of the file. Every `expect(block).toContain(…)` and `expect(fix).toContain(…)` is a whole-file-tail scan, so the assertions would survive the A5 text being deleted and the same strings appearing anywhere below. |

---

## 2. The known defect — confirmed, scoped, and a concrete replacement

### Confirmed

`src/lib/reviews/__tests__/import-consent.integration.test.ts:954-986`, the title
*"recordImportDecisionAndEnqueue rolls back import_decision_recorded when the decision
transaction aborts"*, forces its abort with:

```
await sql().unsafe(`ALTER TABLE job_outbox ADD CONSTRAINT tmp_block_import_topic_analytics
  CHECK (topic <> 'zernio_initial_backfill') NOT VALID`);
try { … } finally {
  await sql().unsafe('ALTER TABLE job_outbox DROP CONSTRAINT tmp_block_import_topic_analytics');
}
```

The test itself is load-bearing — D20's mutation run proves it — but the mechanism is not
sound. Three separate problems, in descending order:

1. **A `finally` does not run on a vitest timeout.** The 30s timeout aborts the test; the
   `DROP CONSTRAINT` never issues; `tmp_block_import_topic_analytics` survives on the
   shared `repworth-testdb` container and every subsequent suite that enqueues
   `zernio_initial_backfill` fails. That is not hypothetical — D20 records 14 failures
   across three suites from exactly this. And the timeout is not an unlikely path: it is
   the failure mode of the very mutation this test exists to catch (the outer-`sql`
   emission blocks on `analytics_events_business_id_fkey`'s `FOR KEY SHARE` against the
   `FOR UPDATE` the acceptance transaction holds on another pooled connection — an
   application-level deadlock Postgres cannot detect).

2. **It breaks a named repo convention.** The CLAUDE.md gotcha is explicit: *"A live-DB
   suite … must NOT apply migration SQL … Migration-**shape** suites are the sanctioned
   exception (must hold `acquireLiveDbLock` …)"*. This suite is not migration-shape, is
   not in `MIGRATION_SHAPE_SUITES`, and does not hold the lock. The `ALTER TABLE` takes
   ACCESS EXCLUSIVE on `job_outbox` — the single most contended relation in the live-DB
   test set — against suites in *other* vitest processes that nothing serializes it
   against. This is the #573 deadlock recipe, unlocked.

3. **The file's own header lies about it** (`:17-19`). A reader auditing live-DB
   conventions reads the header and stops.

### Scope

The pattern was **not invented here**. `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:150-159`
carries the identical construct (`tmp_block_import_topic`) at the fork point; #679 copied
it into a second file under a longer name. A third pre-existing site,
`worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts:173`,
runs `ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS` through a plain template.

So the correct scope is: fix this branch's site, and fix the detector so the other two
surface (§3). Converting `route.integration.test.ts` is a natural follow-up once a shared
helper exists, but is not this ticket's obligation.

### Replacement: abort the writer's own transaction from the executor it was handed

`recordImportDecisionAndEnqueue(sql, …)` touches its `sql` argument in exactly one way —
`sql.begin(cb)`. That is the injection point, and it needs no schema change, no shared
state, and no privileged operation.

```ts
/** Thrown to abort a writer's transaction after its work has landed. Never escapes. */
class ForcedAbort extends Error {
  override readonly name = 'ForcedAbort';
}

/**
 * A `Sql` that lets a writer run its whole transaction and then rolls it back.
 *
 * Non-DDL by construction: it holds no schema, takes no ACCESS EXCLUSIVE lock, and
 * leaves nothing behind on the shared container whether the test passes, fails, or
 * times out. The abort lands INSIDE `recordImportDecisionAndEnqueue`'s own
 * `sql.begin`, after the emission and the enqueue, so the property under test is
 * unchanged: an event written against the OUTER handle commits on a different
 * connection and survives; one written against `tx` dies with the decision.
 */
function abortingExecutor(base: postgresType.Sql): postgresType.Sql {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== 'begin') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const cb = args[args.length - 1] as (tx: postgresType.TransactionSql) => Promise<unknown>;
        return target.begin(async (tx) => {
          await cb(tx);
          throw new ForcedAbort('forced rollback after the writer completed');
        });
      };
    },
  });
}
```

The test body then becomes, with **every existing assertion kept verbatim**:

```ts
await expect(
  recordImportDecisionAndEnqueue(abortingExecutor(sql()), businessId, tenant!.accountId, 'accepted'),
).rejects.toThrow(ForcedAbort);          // ← was `.rejects.toThrow()`

expect(await readAnalytics('import_decision_recorded')).toHaveLength(0);
expect((await readRaw()).import_decision).toBe('pending');
expect(await outboxCount()).toBe(0);
```

**Why it still cannot pass trivially.** Under the `tx` → `sql` mutation the emission
commits on a second pooled connection, independent of the rollback, so
`readAnalytics(…)` returns 1 row and the test is RED on the assertion that names the bug.
The abort is real — postgres.js issues `ROLLBACK` when the callback rejects — and it lands
after both the emission and the enqueue, so it is *more* robust than the DDL version: it
survives a refactor that moves the emission, and it exercises the `declined` path
identically (the DDL version cannot, because `declined` never reaches the enqueue).

**Two details that matter and are easy to get wrong:**

- **Do not use a bare object cast** (`{ begin } as unknown as Sql`). That is D22's failure
  class in a third costume — it would typecheck the test against a local restatement of
  `Sql`. The `Proxy` over a real `Sql` keeps the type honest and forwards the
  tagged-template call form untouched (a `get`-only trap does not intercept `apply`).

- **Optional, and it must be paired with the sentinel assertion.** To turn the mutation's
  FK-deadlock hang into a fast named failure, build a dedicated client for this one test
  with `postgres(url, { max: 2, connection: { lock_timeout: '2s' } })` and close it in a
  `finally`. `max: 2` (not 1) so the mutated outer-`sql` emission actually gets a second
  connection rather than queueing on the pool forever. **This is only safe together with
  `rejects.toThrow(ForcedAbort)`** — with a bare `rejects.toThrow()` the lock-timeout
  error would satisfy the rejection and the mutation would go green. If that pairing feels
  fragile, skip the `lock_timeout` entirely: a 30s timeout is an acceptable mutation
  signal precisely because, with the DDL gone, a timeout strands nothing.

Either way the `sql().unsafe(…)` pair disappears, the header at `:17-19` becomes true, and
`ci:live-db-suites` R2 (once §3 lands) stays green honestly rather than by oversight.

---

## 3. Detector fix for finding 2

`scripts/ci/live-db-suites-audit.ts:117`:

```ts
const appliesDdl = text.includes(MIGRATION_DIR_MARKER) && text.includes(RAW_SQL_MARKER);
```

The `MIGRATION_DIR_MARKER` conjunction is what lets `import-consent.integration.test.ts`
through: it executes `ALTER TABLE` but never names a path under `supabase/migrations`.
Replace the marker with the thing itself:

```ts
const DDL_VERB = /\b(?:ALTER|CREATE|DROP)\s+(?:TABLE|INDEX|TYPE|SCHEMA|POLICY|CONSTRAINT)\b/i;
const appliesDdl = DDL_VERB.test(text) && text.includes(RAW_SQL_MARKER);
```

Verified against the current tree: this flags `import-consent.integration.test.ts` and
`route.integration.test.ts`, leaves all five allowlisted migration-shape suites correctly
routed to the lock check, and produces **no** false positive on the constraint-text
suites (094 / 097 / 102 match the verb inside regex literals but contain no `.unsafe(`).

Keeping `RAW_SQL_MARKER` in the conjunction means `NotificationFailoverPoller.integration.test.ts:173`
(plain-template `ALTER TABLE … ADD COLUMN IF NOT EXISTS`) still slips through. Dropping
`.unsafe(` too would catch it, at the cost of needing an allowlist entry for the shape
suites' regex literals — a judgement call for whoever picks this up, and out of scope for
#679 either way. Worth an issue.

---

## 4. Scaffold check (brief's explicit ask)

**No third scaffold survives.** Verified mechanically:

- D10 (`consentGuardShipped`): gone from all source. `rg consentGuardShipped` hits only a
  comment in `job-eligibility.test.ts:91` explaining why it must not come back, plus the
  deviations doc. The fixture `pushImportConsentState` queues unconditionally
  (`ZernioBackfillWorker.test.ts:174-176`).
- D11/D22 (widened namespace cast): gone. Both suites use real named imports —
  `job-eligibility.test.ts:82`, `job-eligibility.integration.test.ts:93` — of
  `guardImportConsent` and the exported `ImportConsentGate`.
- Swept for the same failure class elsewhere: every remaining `as unknown as` in the
  changed test files is either the repo's established mock-`sql` idiom
  (`mockSql as unknown as Sql`, three files, pre-existing) or a deliberate
  invalid-input construction (`'retired_tier' as unknown as SubscriptionTierValue`).
  Neither decouples a test from a shipped signature.
- `ZernioReviewIngestWorker.test.ts:530` asserts `typeof actual.guardImportConsent ===
  'function'`. This *reads* like a feature detect but is the opposite of one: it fails
  loudly if the export is renamed, which is exactly what keeps `expect(mockGuardImportConsent)
  .not.toHaveBeenCalled()` from going vacuous. Correct as written.

---

## 5. Glossary

**Clean.** The five locked `CONTEXT.md` terms — Review import, Import consent, Import
offer, Import window, Live-ingest cutoff — are used correctly throughout, including in
`docs/analytics/events.md`, migration 102's header, and the migrations-log entry. No
invented synonym: swept for "backfill consent", "import gate", "import prompt", "backfill
offer", "backfill window", "historical sync", "review sync" — zero hits.

Two things checked and cleared rather than flagged:

- `backfill` survives only as identifier/mechanism vocabulary (`zernio_initial_backfill`,
  `zernio_backfill_runs`, `ZernioBackfillWorker`, `backfill_reason`), which the **Review
  import** entry explicitly preserves ("the mechanism keeps its existing names").
- "consent gate" / "the fail-closed Import consent gate" is a mechanism noun attached to
  the locked term, not a competing name for it. The one spot that comes closest to the
  Import-consent entry's *"avoid bare consent (ambiguous with solicitation)"* is the
  operator-facing log string `'import consent blocked — skipping backfill'`
  (`job-eligibility.ts:191`) — the term is spelled in full and the antecedent is
  unambiguous. Not a finding.

New event names (`import_offer_created`, `import_decision_recorded`) read straight off the
glossary.

---

## 6. Deep-module discipline — checked, no finding

- **The new seam is justified, and by structure rather than by a hypothetical second
  adapter.** `guardImportConsent` is a separate exported function rather than a
  `jobKind === 'backfill'` branch inside `guardZernioJobEligibility`. The JSDoc's argument
  is right and the payoff is real: the ingest worker never learns the interface, so
  live-ingest independence is a property of the module graph, not of a runtime branch a
  future edit could flip — and `ZernioReviewIngestWorker.test.ts:522-556` observes that
  rather than assuming it.
- **No interface was widened where an implementation should have deepened.** The
  derived-expiry predicate stayed in its single owner (`importConsentStateSql`) and the
  guard *composes* it rather than reading `import_offer_expires_at` into JS — which is
  what keeps the postgres.js microsecond-truncation class away from this boundary. That is
  the deep move, and it was taken.
- **`ImportConsentGate` as a two-arm union rather than a boolean** is a marginal call, but
  it matches the sibling `ZernioJobEligibility` shape one function above it, and the JSDoc
  states why it is deliberately *not* that type (no `account` payload this guard has no
  business loading). Consistency wins; not worth changing.
- **The analytics emissions live in the writers, not the call sites.** With three
  `createImportOffer` producers, that is the correct ownership boundary and it has an
  in-repo precedent (`recordSuppression`). It also makes the "only when actually written"
  condition unrepeatable-by-accident.

Fowler-smell sweep on the changed production code found nothing at reporting threshold: no
new long method, no feature envy, no shotgun surgery, no duplicated conditional. The
handler's added code is 8 lines and one early return.

---

## 7. Low-confidence appendix (explicitly NOT findings)

Judgement calls I would not stake 80% on, recorded so the next round does not re-derive
them.

- **The forced-interleaving harness is private to one file.**
  `job-eligibility.integration.test.ts:198-310` is ~120 lines of domain-free concurrency
  machinery (`connectAs`, `blockedBy`, `waitUntil`, `track`, `holdOutboxRowLock`). The
  branch's own D21 establishes — with mutation evidence — that the `Promise.all`-over-a-pool
  race idiom cannot fail, and at least three such tests still stand in the same feature area
  (`import-consent.integration.test.ts:453`, `:636`;
  `route.integration.test.ts` "createImportOffer under concurrency"). The machinery has a
  natural home beside `schema-ready.ts` / `live-db-lock.ts`. **Why I am not flagging it:**
  the repo rule "no abstractions for a single caller" cuts directly against extracting it
  today, and rewriting three pre-existing tests is outside #679's surface. My actual
  recommendation is narrower — make sure D21's lesson reaches
  `.claude/reference/lab-notes.md` in the post-merge sweep, since the deviations file is
  episodic by the CLAUDE.md hierarchy and this is exactly the "non-obvious root cause"
  that rule says to promote.

- **Rationale prose is duplicated across owners.** The `tx`-not-outer-`sql` argument is
  spelled at `import-consent.ts:55-60` (module header) and again nearly verbatim inline at
  both emission sites (`:251-258`, `:348-355`); the "one transaction, and that is a
  correctness requirement" argument appears in `job-eligibility.ts:151-171`,
  `job-eligibility.test.ts:14-22` and `job-eligibility.integration.test.ts:6-32`. Four
  copies drift. Against: the house style here is genuinely explanatory-comment-heavy and
  consistent with the surrounding code, and each copy is addressed at a different reader.
  Not worth a round trip.

- **`ZernioBackfillWorker.test.ts` grew 1077 → 1271 lines.** It was already past 1k before
  this PR, so the skill's threshold rule does not bite. The added
  `describe('import consent gate (#679)')` block (`:1147-1271`) is self-contained and would
  file cleanly on its own, but splitting a suite that already shares `pushImportSqlSetup`
  and `resetHarnessForNextRun` is a bigger change than the gain justifies right now.

- **`'missing'` as a bare skip-reason literal** (`job-eligibility.ts:110`, re-spelled in
  two test files) sits beside the archived guard's exported
  `SKIP_REASON_ARCHIVED_LOCATION` constant. The asymmetry is visible, but the repo's
  no-string-literals rule enumerates subscription status / tier IDs / job names / review
  status and does not reach here, and the failure mode of a rename is a red test. Leaving it.

- **`runbook-import-consent.test.ts` asserts `lowered.toContain('admin')`** — weak enough
  that a coincidental "admin" elsewhere in the fix string would satisfy it. Real but
  trivial; folded into the Low finding about the unbounded block, which is the fix that
  matters.

---

## Verdict

Not a blocker on the production surface — that half is careful, correctly layered, and
better-argued than most. The High findings are both in the test/CI lane: one live-DB suite
that can poison the shared container, and the audit that should have caught it and
structurally cannot. Both have concrete, small fixes above.

---

## Orchestrator triage — 2026-08-07 (branch review round 1)

| Finding | Verdict | Disposition |
|---|---|---|
| High — run-time DDL in `import-consent.integration.test.ts:969-979` | **ACCEPT** | Already independently identified during the step-6 deviations read-back and deliberately deferred to this axis rather than patched under time pressure. Replaced with the non-DDL abort injection proposed in §2. The file header's "NEVER applies migration SQL" claim is corrected in the same change. |
| High — `ci:live-db-suites` R2 detector keys on an incidental marker (`scripts/ci/live-db-suites-audit.ts:117`) | **ACCEPT, deferred** → issue **#694** | The finding is correct and the one-line fix is real, but `scripts/ci/**` is outside `allowed_edit_surface`, and tightening the detector turns **two pre-existing** suites red (`route.integration.test.ts:150`, `NotificationFailoverPoller.integration.test.ts:173`) — unrelated to this ticket. Fixing our own violation here and the detector separately keeps both diffs honest. Amending the surface for it would have been the first amendment of the run, spent on someone else's debt. |
| Medium — file crosses 1000 lines by appending a distinct slice | **ACCEPT** | The #679 analytics titles and their fixtures move to their own suite. The branch already set the precedent by opening a separate file for the migration-102 slice, and the extraction shrinks the blast radius of the High above. |
| Medium — `assertSchemaReady` misses the migration-102 precondition (`:236`) | **ACCEPT** | Sharp catch. Putting the emission inside `recordImportDecisionAndEnqueue` silently added a 102 precondition to ~10 **pre-existing #677** titles that never had one; on a DB at 101 they fail with an opaque `23514` instead of the named behind-head error the convention promises. Needs an explicit assertion because 102 correctly exports no `SchemaRequirement`. |
| Low — assertion that cannot fail (`job-eligibility.test.ts:307`) | **ACCEPT** | Deleted, not annotated — an annotated dead assertion still reads as coverage. The locked title is re-backed by the `inTransaction` property and mutation-verified. |
| Low — NULL-deadline title not constructed (`:188-200`) | **ACCEPT** | The title is locked, so the test is fixed rather than renamed: it must assert at a seam that can actually distinguish a NULL deadline from a live offer, or construct it live. |
| Low — `scenarioBlock('A5')` unbounded (`runbook-import-consent.test.ts:31-37`) | **ACCEPT** | A5 is the last `SCENARIOS` entry, so the slice ran to end-of-file and the assertions would survive A5 being deleted. Bounded and mutation-verified. |

**Net: 7 of 7 accepted** — 6 fixed on this branch, 1 filed as #694. Nothing rejected.

Worth recording: three of these seven are *tests that do not test what they claim* — the same
class as the eval's own live race test (D16/D21) and the two eval scaffolds (D10, D22). On a
branch whose test bucket ran 5:1 against production code, the dominant defect mode was not
broken behaviour but **false coverage**.
