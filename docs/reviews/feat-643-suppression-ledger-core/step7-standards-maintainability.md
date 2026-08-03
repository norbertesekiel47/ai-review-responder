# Step 7 — Standards & maintainability review

**Branch:** `feat-643-suppression-ledger-core`
**Diff under review:** `a3f4ddb417c9fc3f0af2994ffaa44b79009ee2b2..c12db598` (37 files, 5,283 changed lines; 435 lines production code)
**Reviewer posture:** fresh — nothing carried over from prior sessions; every claim below was re-derived from files in this worktree.
**Date:** 2026-08-02

---

## What I ran

| Step | Command / action |
|---|---|
| Skill | `thermo-nuclear-code-quality-review` (primary instruction; loaded and applied) |
| Diff inventory | `git log --oneline`, `git diff --stat`, per-file `git diff` on every production path |
| File-size delta | per-file `git show <fork>:<path> \| wc -l` vs `wc -l` for all 37 files |
| Full reads | `src/lib/solicitation/suppression.ts`, `supabase/migrations/096_*.sql`, `097_*.sql`, `src/lib/solicitation/__tests__/suppression.test.ts` |
| Targeted reads | `purge-verification.ts` (runner + new arms), `purge-stages.ts` (content stage + finalize), `table-disposition.ts`, `account-offboarding.ts` template, `batch-builder.ts` `loadCandidateWindow`, `restraint-policy.ts` candidate/evidence shapes, `handles.ts` (`normalizeEmail`), `analytics/enqueue.ts`, `primary-tracked-keyword-sql.ts` (the cited precedent) |
| Context (mandatory) | `docs/superpowers/plans/feat-643-suppression-ledger-core-deviations.md` (all 33 entries + step-6 section), `CONTEXT.md` → "Solicitation suppression & unsubscribe", `.claude/reference/migrations-log.md` 096/097 entries |
| Glossary sweep | `rg -in` over the production/docs diff for every `_Avoid_` synonym in the five glossary entries |
| CI-reality checks | `vitest.config.ts` project split, `.github/workflows/ci.yml` `test` job, `.github/actions/test-db/action.yml`, `describeWithDb`/`assertSchemaReady` gating in the new suites |
| Suppression-marker sweep | `rg -n "fallow-ignore"` across `src worker scripts supabase` |
| Verification | `pnpm typecheck` — **exit 0** |

I did not re-run the full test suite: `scripts/verify-gate.sh --review` is recorded green at `cd861e6b` and `c12db598` is documentation-only. `pnpm typecheck` was re-run because two findings below concern type contracts.

---

## Per-axis analysis

### 1. Repo standards (`repworth.md`, `engineering.md`, `production.md`, `design.md`, `CLAUDE.md` invariants)

Checked item by item against the diff:

| Rule | Verdict | Evidence |
|---|---|---|
| No `any` (sole carve-out: PgBouncer JSONB-as-string) | **PASS** | Zero `any` in the production diff. `Fragment` (`= PendingQuery<any>` inside postgres.js's own `.d.ts`) is imported, not authored. No new JSONB-as-string parse site — correct, since nothing in this diff reads a JSONB column. |
| Invariant #15 — domain modules take `sql`/`tx` explicitly, never import `@/lib/db/server` | **PASS** | `suppression.ts` takes `db: SqlExecutor` / `tx: TransactionSql`. No `@/lib/db/server` import anywhere in the diff. |
| Invariant #10 — `node:crypto` only | **PASS** | No crypto in production code. Tests use `node:crypto` `createHash`/`randomUUID`. Migration 096 now *enforces* the digest shape via `token_hash ~ '^[a-f0-9]{64}$'`. |
| Invariant #2 — transactional outbox | **PASS** | `recordSuppression` writes `analytics_events` directly in the caller's tx (correct: CLAUDE.md's analytics contract is "durable events insert server-side, `AnalyticsDispatchPoller` ships them" — an outbox row would be wrong here, and the comment says so). `retainedSuppressionCount` is snapshotted and enqueued inside `finalizePurgeInTransaction`'s single tx via the existing `enqueueAccountOffboardingEmail` helper. Verified by `PurgeWorker.test.ts` asserting `lockIdx < countIdx < receiptIdx` and `scope === 'tx'`. |
| `jsonb()` / `tx.json()` rather than `${JSON.stringify(x)}::jsonb` | **PASS** | The only JSONB write is `enqueueAnalyticsEvent`'s pre-existing `db.json(properties)`. |
| Invariant #5 — approval/unsubscribe tokens never stored raw | **PASS, improved** | The step-6 fix (`cd861e6b`) added the format CHECK. This is the right call: mirroring migration 056 rather than the older `approval_links`/`channel_enrollments` shape, lowercase-only to match `digest('hex')`, named because the suite asserts `pg_get_constraintdef()` by name. |
| Invariant #14 posture — deny-all RLS for server-owned tables | **PASS** | Both tables `ENABLE ROW LEVEL SECURITY` with zero policies; both registered in `scripts/ci/tenant-tables.ts` so `ci:rls-audit` guards them; both documented in `docs/security/rls-inventory.md`. |
| Invariant #9 / #8 — account/business scoping | **PASS with one deliberate, well-reasoned exemption** | The `global` arm of `suppressionMatchSql` is intentionally cross-account. The allowlist entry states the asymmetry plainly and correctly ("scoping it would silently resume sending to someone who opted out"). `ALLOWLIST_BASELINE` bumped 410 → 413 in the same PR, which is what the baseline exists to force. |
| No string literals for enum-ish values | **PARTIAL** — see finding **S1** and appendix A2 |
| No new top-level directory / no new file by default | **PASS** | One new production file (`suppression.ts`), which the plan's file-structure table named. Everything else extends an existing file. |
| `pnpm ci:tenant-scope` / `ci:rls-audit` for DB-touching changes | **PASS** | Recorded green at 413/413; allowlist entries carry substantive reasons, not "see ticket". |
| Docs updated in the same change | **PASS** | `migrations-log.md` (head 095 → 097, both entries, two retention-policy rows), `CONTEXT.md` glossary, `docs/analytics/events.md`, `docs/security/rls-inventory.md`, spec amendment banners. One divergence — finding **S4**. |

**Notable positive:** the two-table retention split is expressed in four independent places (purge DELETE, purge scrub UPDATE, verification arms, `TABLE_DISPOSITIONS` prose) and I checked all four for drift. They agree. See appendix A5 for why I did not flag this as duplicated knowledge.

### 2. Deep-module discipline (`codebase-design` vocabulary)

**`src/lib/solicitation/suppression.ts` is a genuinely deep module, and the fragment seam is the right call.** The alternative — an `isSuppressed(sql, handle, accountId)` function owning its own round trip — would have been a per-candidate N+1 inside `loadCandidateWindow`'s `MAX_DATA_ROWS` window. Returning a composable fragment lets the predicate be embedded in a `LEFT JOIN LATERAL` and keeps one owner of §1.2. G7's decision not to ship an `isSuppressed()` helper for a second consumer that does not exist yet is correct by `repworth.md` ("Wait for the second concrete use case before extracting"). The `primaryTrackedKeywordSql` precedent is real and the shape matches it.

**What the fragment still leaks to call sites**, and my judgement on each:

| Leak | Verdict |
|---|---|
| Caller must know to wrap it in `LEFT JOIN LATERAL (…) alias ON TRUE` | Inherent to a SQL fragment seam. Acceptable. |
| Caller must know the returned column names (`source`, `suppressed_at`) — a rename inside the fragment breaks both call sites with a runtime SQL error, not a compile error | Inherent, and documented in the interface comment ("Returns at most one row of `{ source, suppressed_at }`"). Acceptable. |
| Caller must supply an **already-normalized** handle column | **NOT acceptable as prose-only.** This is the module's one correctness precondition, it fails *open* on a compliance path, and it is cheaply enforceable in SQL. Finding **S2**. |
| Caller cannot specify a channel; the fragment hardcodes `'email'` while the writer parameterizes it | **Finding S1.** |

`RecordSuppressionInput` as a three-variant discriminated union is the standout design decision on the branch. Making `owner_manual + global` untypeable rather than only un-insertable, and using `?: never` to reject a human actor on machine sources, is exactly "define away invalid states" from `design.md`. The G14 comment is honest about the limit of what the type proves (a plain-string actor cannot establish admin identity), and that honesty is what justifies the verifier's second branch — the two decisions are coherent with each other.

`recordSuppression` returning `string | null` (row id vs. "an existing row won") is a good narrow contract: it makes the no-op path observable without exposing `ON CONFLICT` mechanics, and it is what drives the "skip the analytics event on a repeat" behaviour.

**Thin wrappers / pass-through helpers:** none found. `formatRetainedSuppressions` earns its name (it owns the singular/plural/zero decision and returns a complete `<p>` so the paragraph disappears with its value). `contactEmail()` in the batch-builder test is a two-line helper that removes a duplicated fixture format — fine.

**One shallow spot:** the two `recordSuppression` INSERT branches (finding **S5**).

### 3. Fowler smell baseline

| Smell | Finding |
|---|---|
| Long function | None. `recordSuppression` is ~50 lines with one ternary. `finalizePurgeInTransaction` grew by 31 lines, of which 25 are comment — the added code is one `SELECT` and one `??`. `runContentPurgeStage` grew by 31, of which 25 are comment. |
| Feature envy | None. `AccountOffboardingEmailWorker` deliberately reads `retained_suppression_count` off the payload and never touches `solicitation_suppressions` — asserted by a test (`sqlCalls.some(… 'solicitation_suppressions')).toBe(false)`). That is the *opposite* of feature envy and is the right seam. |
| Primitive obsession | Mild and deliberate: `suppression: { source: string; suppressedAt: string }` on the candidate keeps `source` a plain `string`. G10's reasoning holds — `restraint-policy`'s evidence is a JSONB serialization contract re-read by `parseEvidence`, so narrowing the write site to the derived union would ripple into a read model that must tolerate historical values. Correct call. |
| Shotgun surgery | Two instances, both bounded — see finding **S1** (channel) and appendix A5 (retention rule across four sites). |
| Speculative generality | `recordSuppression` ships with zero production callers, and `channel` is a single-valued parameter. See finding **S1** and appendix A1. |
| Duplicated knowledge with no single owner | Finding **S5** (INSERT column list), finding **S4** (distinct-ID contract). |

### 4. Glossary compliance (`CONTEXT.md` → "Solicitation suppression & unsubscribe")

**Clean.** I swept the production + docs diff for every forbidden synonym across all five entries — `blocklist`, `do-not-mail flag`, `opt-out table`, `suppression list`, `per-account suppression`, `tenant scope`, `suppression level`, `unsubscribe link row`, `opt-out token`, `magic link`, `unsuppress`, `re-subscribe`, `opt back in`, `restore contact`, `consent overrides`, `re-consent`, `re-permission`. Every hit was inside `CONTEXT.md`'s own `_Avoid_:` lists. Zero hits in code, identifiers, comments, migration SQL, allowlist reasons, or the migrations log.

Positive terminology use is consistent and load-bearing rather than decorative: "Suppression ledger", "Suppression scope", "Unsubscribe token", "Normalized handle" and "Correction path" appear capitalized-as-terms in the migration header, the module header, `table-disposition.ts`, `tenant-tables.ts`, `rls-inventory.md` and the migrations-log entries. The owner-facing email copy deliberately drops the jargon ("opt-out records") — correct, since the glossary governs engineering vocabulary, not customer copy, and "Suppression ledger row" in a deletion receipt would be worse.

`table-disposition.ts:395` uses "do-not-contact", which is the glossary's own phrasing for the `account` scope ("the owner's `owner_manual` do-not-contact") and is distinct from the forbidden "do-not-mail flag".

### 5. Comment quality

House style here is rationale-first and comment-dense. Judged individually:

**Comments that carry rationale the code cannot** (keep):
- `suppression.ts:11-19` — the DR2 warning that transactional email must never consult the ledger. Nothing in the code says this and a future reader would reasonably wire it in.
- `suppression.ts:118-134` — first-write-wins, *why* history belongs elsewhere, and why the ON CONFLICT predicates cannot be parameterized.
- `096:15-18`, `096:130-143` — the byte-for-byte rule and the round-2 correction of the provenance CHECK from a symmetric form to an implication. That paragraph documents a defect the branch's own first revision shipped; deleting it would let it come back.
- `purge-verification.ts:615-635` — the G13 scope note ("this verifier counts VIOLATIONS, so it structurally cannot prove RETENTION"). This is the single most valuable comment in the diff: it tells the next reader that adding a retention *runtime* check here is impossible and the guarantee is a test obligation.
- `batch-builder.ts:379-386` — "populate, do not pre-filter", with the arithmetic argument that a pre-filter buys nothing because `evaluateBatch` counts only `send` decisions.
- `schema-ready.ts:298-307` — why 097 gets no `SchemaRequirement`. Documenting an *absence* so a later reader does not "fix" it is exactly the right use of a comment.

**Comments that restate the code** (would trim, none blocking):
- `worker-types.ts:273-278` — six lines for one optional numeric field; the first sentence carries it.
- `outbox.ts:48-50` — "A count, never a handle" duplicates the same claim in `worker-types.ts` and in the template's doc comment. Three copies of one privacy assertion.

**One comment that is doing a job it cannot do:** `purge-stages.ts:757-771`. See finding **S3** — this is not a comment-quality nit; the comment is standing in for an absent mechanism.

### 6. Test quality

**Do the new suites run in CI?** Deviation-doc item 1 asked me to confirm this specifically. **They do.** Verified end to end:
- `.github/workflows/ci.yml` `test` job stands up a `postgres:16` service and sets `TEST_DATABASE_POOL_URL=postgres://test:test@localhost:5432/test`.
- `.github/actions/test-db/action.yml` applies `scripts/ci/test-db-bootstrap.sql` then every `supabase/migrations/*.sql` in `sort` order — so 096 and 097 are applied.
- The new suites gate on `describeWithDb(…, { enabled: Boolean(testDatabaseUrl) })` with `testDatabaseUrl = resolveTestDatabaseUrl()`, and call `assertLocalTestDatabaseUrl` (CI's host is `localhost`, so it passes).
- `pnpm test` runs both vitest projects; `*.integration.test.ts` lands in the serialized `integration` project.

So the #520 shape ("an existing-but-not-run suite") does **not** apply here. Note that `vitest.config.ts:11-14`'s comment still claims "the integration suites self-skip there because `TEST_DATABASE_POOL_URL` is unset" — that comment is stale relative to the current CI job. Pre-existing, outside this diff; recorded in appendix A7.

**Did unit-level coverage thin where it still had value?** No. Each relocation is individually justified and the unit layer kept the assertion it could actually make:
- T3 → `purge-verification.test.ts` still gates *arm existence* (`has explicit verification SQL for every disposition table`); only the two-branch behaviour and row survival moved, which a `vi.hoisted` fake tag genuinely cannot assert.
- T4 → `batch-builder.test.ts` gained the two new columns on its fixtures (correct: making the mock faithful rather than making `toCandidate` defensive), and the populate-not-pre-filter property is a property of SQL that no mocked tag can see.
- T5 → `email-templates.test.ts` gained three real cases (plural / singular / zero-renders-nothing) and `AccountOffboardingEmailWorker.test.ts` gained the retry-stability case, which is exactly where "renders the same number twice and never queries the ledger" belongs.

**Contract vs. implementation shape.** Mostly contract:
- `suppression.test.ts` asserts the closed enums and, via `@ts-expect-error`, that the illegal source/scope pairings do not compile. Those are real assertions — `pnpm typecheck` fails if any illegal shape starts compiling. The `derives a closed union type from each array, not a widened string` case is the one that was actually missing (nothing else pinned the arrays against widening to `string[]`).
- The 096 suite asserts every constraint twice — `pg_get_constraintdef()` semantics *and* an exhaustive tuple matrix (14 scope × source, 8 provenance nullability, 6 token-hash format cases plus one accepted real digest so the matrix cannot pass by rejecting everything). The "one accepted case" detail is the difference between a matrix and a rubber stamp.
- The retention tests are mutation-verified (documented in the deviations file and consistent with what the assertions would do): dropping `scope = 'account'` from the purge DELETE, or adding `AND suppression.source IS NULL` to `loadCandidateWindow`, each fails a named test.

**Implementation-shape coupling** appears only where it is structurally forced: `PurgeWorker.test.ts` keys on `text.includes('AS retained_count')` because its `vi.hoisted` router *is* a SQL-text matcher. A rename of the alias fails the test loudly (the router returns nothing, the count reads 0, the assertion fails) rather than silently passing — acceptable. `expect(calls[countIdx]!.text).not.toContain('solicitation_unsubscribe_tokens')` is a genuine contract assertion (tokens are mechanisms, not records) dressed as a text check.

**Fixture hygiene** is the strongest part of the test work. `sweepSuppressionFixtures` runs in both `afterEach` and `afterAll`-before-`cleanupTenantAccount`, because a ledger row hangs off no business and `account_id` is a NO-ACTION FK to a table the cleanup helper deletes directly. A leaked row would have turned teardown into an FK error. That reasoning is written down at the sweep site.

**One asymmetry worth noting** (not a finding): `batch-builder.integration.test.ts` seeds through the real `recordSuppression` — deliberately, so a fixture cannot carry a pairing the writer can never emit — while `offboarding-lifecycle.integration.test.ts:219` uses a raw `INSERT`. Both choices are defensible (the lifecycle suite needs to seed rows the writer would refuse, to prove the verifier catches them) and the lifecycle suite says so in a comment.

### 7. Preemptive-suppression sweep (deviation-doc item 4)

`rg -n "fallow-ignore" src worker scripts supabase` returns 30 markers, **all pre-existing** and all `complexity` except `src/lib/config/worker.ts:265` (`unused-export`, pre-existing). The `git diff` adds **zero** fallow markers — the plan's mandated `unused-export` suppression for `recordSuppression` was written, observed to *create* a `stale suppression` failure, and removed, with its rationale kept as a plain comment (`suppression.ts:136-140`). That is the correct resolution and the correct generalization ("a suppression written from a prediction is a defect class"). Confirmed: nothing preemptive survived.

### 8. Deviation-doc items I was asked to judge

| Item | My verdict |
|---|---|
| 1. Tests relocated to live-DB suites in T3/T4/T5 | **Concur with ACCEPT.** The suites run in CI (proven above) and unit coverage did not thin. The only residue is file size — finding **S6**. |
| 2. `retained_suppression_count` optional with reader defaulting to 0 | **Concur with ACCEPT.** This is a genuine rollout invariant, not a speculative shim: `purge_receipt` outbox rows enqueued before the deploy are in flight and must still render, and the same file already carries `recipient_email?` / `purged_at?` optional for the identical reason. It is also *behaviourally correct* — a legacy row renders no sentence rather than asserting "0 retained". Consistency with the two sibling fields is what tips this. One residue in appendix A6. |
| 3. Receipt copy diverged from the plan (singular branch added) | **Concur with ACCEPT — the deviation is an improvement.** The plan's verbatim copy renders "1 opt-out records are retained" at the single most likely non-zero count. One ternary, one test per branch, and the plural wording is unchanged from the plan. The zero case rendering *nothing* rather than "0 opt-out records" is also right: a zero disclosure invites a question with no answer behind it. |
| 4. T2's fallow reversal | **Concur with ACCEPT.** Verified no preemptive suppression survives anywhere (section 7). The replacement — resolving the `SuppressionScope` unused-type finding with *coverage* rather than a second marker — is strictly better than what the plan asked for. |

---

## Findings (≥80% confidence)

### S1 — `suppressionMatchSql` hardcodes the channel that `recordSuppression` parameterizes
**`src/lib/solicitation/suppression.ts:63`** (and `:88`, `:99`, `:109`) · **medium**

The module's header claims sole ownership of "the closed source/Suppression scope/channel enums" *and* "the §1.2 lookup predicate". Those two claims disagree about `channel`:

- The **writer** takes `channel: SuppressionChannel` in all three variants of `RecordSuppressionInput` and inserts whatever it is handed.
- The **reader** hardcodes `WHERE s.channel = 'email'` and offers no way to ask about any other channel.

Today `SUPPRESSION_CHANNELS = ['email']`, so both are trivially correct. The failure arrives with the second member — which the codebase already anticipates: `normalizePhone` exists in `handles.ts`, the glossary says the ledger is keyed "per channel", and the unit test's own title is *"exports email as the only channel — **phone handles mint no rows today**"*.

**Concrete failure scenario.** A later ticket widens the enum and the migration CHECK to `('email','sms')`. `recordSuppression` immediately accepts and stores `channel: 'sms'` rows — the type permits it, the DB permits it, no test fails. `suppressionMatchSql` continues to match only `'email'`, so `loadCandidateWindow` and #630's dispatch gate both report *not suppressed* for a handle that opted out. A recipient who unsubscribed gets contacted, and the ledger row proving they opted out is sitting in the table the whole time. Failure is silent and fails **open** on the one path the module exists to close.

**Named standards.** `engineering.md` — "Keep one authoritative representation for each piece of system knowledge"; `design.md` — "Are names precise and consistent … surprising code is complexity even when short." One module holds two contradictory owners for one dimension.

**Remedy (either direction; both are small):**
- *Preferred* — give the fragment the parameter the writer already has: `suppressionMatchSql(db, handleColumn, accountId, channel: SuppressionChannel)` with `s.channel = ${channel}`. Both call sites pass `'email'`; the enum then genuinely has one owner and widening it produces a compile error at every read site instead of silence.
- *Or* — delete `channel` from `RecordSuppressionInput` and hardcode `'email'` in both INSERTs, matching the reader. This is the `repworth.md` "wait for the second concrete use case" answer and is honest about today's scope, at the cost of a wider edit when SMS lands.

Do not leave them disagreeing.

### S2 — the fragment's one correctness precondition is prose-only, and it fails open
**`src/lib/solicitation/suppression.ts:64`** (contract stated at `:48-50`) · **medium**

`suppressionMatchSql` compares `s.normalized_handle = ${handleColumn}` and requires that `handleColumn` already holds the output of `normalizeEmail`. That requirement is enforced by a doc comment and nothing else:

- `handleColumn: Fragment` is `PendingQuery<any>` in postgres.js's own typings — the type cannot distinguish "a normalized column reference" from any other SQL expression.
- No test exercises a non-normalized input (the integration suite's `matchSuppression` probe passes an already-normalized literal).
- No runtime check exists, and none can exist on the SQL side as written.

The comment's justification ("solicitation_contacts.email already stores the output of normalizeEmail — the consent join above is the standing proof") is true *for today's single caller*. The module's own header names a second caller by ticket number: "#630's dispatch gate embeds the same fragment later." A dispatch-time re-check plausibly reads a handle from a different table, a payload, or a provider callback.

**Concrete failure scenario.** #630 embeds the fragment against a handle carrying stray whitespace or mixed case (`" Alice@Example.com"`). The equality misses, the dispatch gate reports *not suppressed*, and the send proceeds to someone who opted out. Nothing throws, nothing logs, and the `solicitation_suppressed_at_dispatch` event that exists to record the refusal is never emitted — so the failure is invisible in analytics too.

**Named standard.** `engineering.md` trigger rule: *"When hidden assumptions live only in comments, caller folklore, or tribal setup steps, move them into code, contracts, tests, scripts, or checked configuration."* Also `design.md` — "Make contracts, assumptions, invariants … explicit and close to the abstraction they protect."

**Remedy — the precondition can be deleted rather than documented.** `normalizeEmail` is `raw.trim().toLowerCase()` plus a plausibility check that only ever returns `null` (and a `null` handle is never stored). Therefore for every value that *can* be in `normalized_handle`, `lower(btrim(x))` is the identity. Changing the predicate to:

```sql
AND s.normalized_handle = lower(btrim(${handleColumn}))
```

makes the fragment correct for **any** caller, is a no-op for the current caller, and costs nothing at the index (the expression is on the outer-row side of the comparison inside a LATERAL, so the `solicitation_suppressions` partial uniques are still driven by an equality on a per-row constant). The caller obligation disappears instead of being written down — which is the `design.md` "define away invalid states" move.

If that is rejected, the minimum is a regression test in `suppression.integration.test.ts` proving a non-normalized probe misses, so the behaviour is at least pinned rather than assumed.

### S3 — a cross-ticket contract on future writers, stated in a comment inside a file its audience will never open
**`worker/jobs/account-offboarding/purge-stages.ts:757-771`** · **medium**

Fifteen lines establish an obligation on code that does not exist yet:

> *"a suppression writer MUST NOT write a `scope='account'` row for an account whose `account_offboardings.status` is any ACTIVE teardown state — `'purge_scheduled'` included … A global row written after the boundary MUST carry `accountId: null`… Unreachable today (`recordSuppression` has zero production callers, G6); #644/#645/#627 own honouring it when they land the first ones."*

The comment is right about the hazard and admirably explicit about *why* no third advisory lock is used (ABBA avoidance). But it is placed in a purge-worker file. The people who need it are the authors of `#644` (redemption), `#645` (manual paths + Correction path) and `#627` (provider webhooks), who will be working in `suppression.ts` and in ingress handlers. Nothing routes them here: no guard in `recordSuppression`, no note on `RecordSuppressionInput`, no test, no CI check, no runbook entry, no ticket-body carry-over that I can verify from this branch.

**Concrete failure scenarios**, both reachable once the writers land:

1. *Self-healing but noisy* — `#645`'s owner-manual path writes a `scope='account'` row while the account sits in `purge_scheduled`. `verifyAccountOffboardingPurge` counts it (branch (a) of the new arm), `finalizePurgeInTransaction` throws `account_offboarding_purge_verification_failed:solicitation_suppressions`, and the purge job fails. Because `handleAccountOffboardingPurge` re-runs `runContentPurgeStage` before `finalizePurgeInTransaction` on retry, the DELETE sweeps the row and the next attempt succeeds — so this one degrades to a spurious failure + alert rather than a wedge.
2. **Not self-healing** — `#645`'s admin path writes a `scope='global'`, `source='admin_manual'` row whose `created_by_user_id` is one of the purging account's users. G14's own comment concedes the type "CANNOT establish that [the actor] is an admin rather than an owner", which is precisely why branch (b) of the verifier is live. But the content-purge stage **never deletes global rows** — that is the whole retention design. So the violation persists across every retry: the account's purge fails verification forever, `account_offboardings.status` never reaches `'purged'`, and the only remediation is a manual DB edit or the not-yet-built Correction path. Neither is documented anywhere in this diff.

**Named standards.** `engineering.md` trigger — assumptions that live only in comments must move into code, contracts, tests or checked configuration. `production.md` — *"Make startup, health checks, migrations, one-time jobs, administrative controls … fail safely, auditable, authorized, observable, stoppable, and **recoverable**"*, and the trigger rule *"When reviewing an incident … identify the failure chain, missing defenses, detection gaps."*

**Remedy (pick one, cheapest first):**
- Move the contract text onto `RecordSuppressionInput` / `recordSuppression`'s doc comment in `suppression.ts` — where the three consuming tickets will actually be typing — leaving a one-line pointer in `purge-stages.ts`. Near-zero cost and fixes the audience problem.
- Better: enforce it in `recordSuppression`. It already holds the tx; a guard that refuses a `scope='account'` write when the account has an `account_offboardings` row in an active teardown state is a handful of lines and one test, and it converts a prose MUST into a typed terminal error.
- Separately, add a one-paragraph remediation note for scenario 2 to `docs/runbooks/owner-offboarding-staging-dry-run.md` (or the offboarding spec): an unrecoverable verification failure needs a documented operator path, not a discovery-at-3am path.

### S4 — documented Distinct ID contradicts the code, in the same diff
**`docs/analytics/events.md:259`** vs **`src/lib/solicitation/suppression.ts:180`** · **low**

`events.md` states `- **Distinct ID:** account ID` for `solicitation_suppressed`, matching the format of the other 22 entries (which use "account ID", "anonymous ID", "anonymous ID or account ID", or "SHA-256 pseudonymous offboarding key" — i.e. the file *does* spell out non-account identities where they exist). The code is:

```ts
distinctId: input.accountId ?? row.id,
```

`accountId` is `string | null` on both `global` variants, and the type comment calls it "Provenance only". So for any machine-authored or admin-authored suppression where the originating account is unknown — `provider_suppressed` mirroring Resend's team-wide list is the explicit case §3.3 describes, and an `admin_manual` global entry is another — the distinct ID is a **UUIDv7 suppression row id**, not an account ID.

**Why it matters beyond the doc.** `AnalyticsDispatchPoller` passes `distinct_id` straight through to `capturePostHogEvent`, so every such event mints a brand-new PostHog person that will never be seen again and can never be joined to anything. That is an unbounded one-off identity space on a durable event, and it is the kind of thing that is cheap to decide now and expensive to backfill later. `ci:analytics-events` compares the TS allowlist against this doc — it does not check distinct-ID semantics, so nothing will catch the drift.

**Named standard.** `engineering.md` — "One authoritative owner for each system fact … derive, generate, validate, or trace the rest"; `repworth.md` — "When deleting a doc or marking a checklist item done, fix its audit tick in the same change."

**Remedy.** Decide which is true and make the other match. Either document the fallback (`account ID, or the suppression row id when no originating account is known`) — matching how `offboarding_*` documents its pseudonymous key — or give the accountless case a stable non-person identity rather than a per-row UUID.

### S5 — the two `recordSuppression` INSERTs duplicate the column list and VALUES list verbatim
**`src/lib/solicitation/suppression.ts:149-172`** · **low**

The `global` and `account` branches differ in exactly two tokens (the scope literal in `VALUES`, and the `ON CONFLICT … WHERE` predicate). The eight-column list and the seven-expression `VALUES` list are byte-identical copies. Adding a column to `solicitation_suppressions` means editing both, and a reader must diff two 11-line blocks to find the two-token delta.

The comment justifies the duplication with the byte-for-byte rule — but that rule (CLAUDE.md gotcha, and migration 018's origin story) constrains the **`ON CONFLICT` predicate**, not the statement prefix. A fragment-composed head (`const head = tx\`INSERT INTO … VALUES (…)\``, then `tx\`${head} ON CONFLICT … DO NOTHING RETURNING id\``) keeps both predicates spelled out in full, literal, unparameterized text while collapsing the duplicated knowledge. Postgres.js composes fragments as raw text, so the emitted SQL is unchanged.

**Named standard.** `engineering.md` — "Keep one authoritative representation for each piece of system knowledge … When the same fact appears in multiple artifacts, choose one owner"; thermo-nuclear rule — "copy-pasted logic instead of extracted helpers."

I record the counter-argument honestly: for a *first-write-wins* writer, seeing both complete statements side by side has real reading value, and the duplication is 11 lines inside one 50-line function rather than across files. This is why it is `low` and not `medium`. But the column list is the part with no reason to be duplicated, and it is the part that will drift.

### S6 — the branch pushes a test suite from 848 to 1,483 lines
**`worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts`** · **low**

+635 lines, crossing the 1,000-line boundary. The file now carries the offboarding lifecycle, the suppression retention proofs, the token-provenance scrub, purge-verification's two new arms, and the rendered purge-receipt copy assertion — five concerns in one suite.

The T3/T5 deviation entries reason about this and land on "no new file": `repworth.md`'s stated default is "no new file", and the practical driver is that this suite already owns the fiddly `vi.hoisted` `DATABASE_POOL_URL` override plus the `runFullProductionPurge` helper, which a second suite would have to duplicate. Both are real. There is also a cost to a *second* serialized live-DB suite, since the `integration` project runs them in sequence.

I am flagging it anyway because the thermo-nuclear standard treats the crossing as a presumptive blocker requiring explicit justification, and because the natural seam is visible: the suppression-retention block (`:1197`–`:1470`, roughly 280 lines with its own fixture helpers `insertSuppression` / `sweepSuppressionFixtures` and its own `SuppressionScope`/`SuppressionSource` imports) is a coherent unit that shares only the DB bootstrap with the rest. If a `suppression-retention.integration.test.ts` can reuse the bootstrap by exporting the existing helpers rather than copying them, the split is worth taking before the next ticket adds to this file. If it cannot, the reuse argument stands and this is accepted debt — but it should be an explicit decision, recorded, not a default.

---

## Approval assessment

Against the skill's approval bar:

| Bar | Verdict |
|---|---|
| No structural regression | **Met.** The diff adds one well-scoped module and extends existing owners. Nothing became more coupled. |
| No obvious missed dramatic simplification | **One available** — S2's `lower(btrim(…))` deletes a caller obligation rather than documenting it. Small in lines, real in kind. |
| No unjustified file-size explosion | **One crossing** (S6), with a partial justification on record. |
| No spaghetti growth from special-case branching | **Met.** Both purge additions are straight-line statements inside an existing transaction; neither adds a branch to an existing flow. `toCandidate`'s one new ternary replaces a hardcoded `null` and is the whole point of the seam. |
| No hacky/magical abstraction | **Met.** The fragment seam is the established in-repo pattern with a named precedent. |
| No unnecessary wrapper / cast / optionality churn | **One optional field** (`retained_suppression_count?`), justified by a genuine in-flight-rollout invariant and consistent with two sibling fields. |
| No architecture-boundary leak / canonical-helper duplication | **Met.** The email worker is deliberately kept ignorant of the solicitation domain, and that ignorance is test-enforced. |
| No missed obvious decomposition | **S6** is the only candidate. |

**Overall: this is high-quality work.** The DB-level enforcement posture (two CHECK constraints pairing scope↔source and the provenance implication, plus the step-6 `token_hash` format CHECK), the untypeable-illegal-state input union, the mutation-verified retention tests, and the explicitly-documented limits of what the verifier can prove are all above the bar this repo normally holds. The three `medium` findings are all the same shape — an obligation that is written down where the code could carry it instead — and none of them is a defect today. S1 and S2 are the two I would want closed before the writers in #644/#645/#627 land, because both fail silently and both fail open on a compliance path.

---

## Appendix — low-confidence observations (not in the findings table)

**A1. `recordSuppression` ships with zero production callers.** Strictly, `repworth.md` says "Before adding an abstraction for a single caller, don't" and its only caller is a test. But G6's counter-argument is genuinely strong and specific to this repo: the byte-for-byte `ON CONFLICT` rule is a documented CLAUDE.md gotcha with a migration (018) named as its scar, and proving the predicates against the real partial uniques the moment those indexes exist is worth more than deferring. The deviations doc records the decision. Not re-litigating.

**A2. `scope = 'account'` / `scope = 'global'` as bare SQL literals outside the owning module** — `purge-stages.ts:329`, `:775`, `purge-verification.ts:641`, `:644`. The glossary's "never string literals at call sites" sentence is scoped to the seven *sources*, and interpolating `${SUPPRESSION_SCOPES[1]}` into SQL would be strictly less readable than the literal. Arguable either way; not worth a table row.

**A3. `handleColumn: Fragment` is `PendingQuery<any>`** — the parameter type permits any SQL expression, not just a column reference, and fragments are spliced as raw text. There is no injection path today (every construction site is a static template), and postgres.js offers no narrower type. Noted for awareness only.

**A4. Planner risk on the `OR`-ed scope predicate.** `WHERE channel='email' AND normalized_handle = X AND (scope='global' OR (scope='account' AND account_id=$1))` relies on Postgres building a BitmapOr over the two partial unique indexes. It should, and the LATERAL is bounded by `LIMIT ${MAX_DATA_ROWS}` on the outer window, so the blast radius of a bad plan is bounded. Still worth one `EXPLAIN (ANALYZE)` on staging once the table has realistic global-row volume; a `UNION ALL` of two scope-pinned lookups is the standard fallback if the planner ever declines. Not flagged because I could not measure it.

**A5. The retention rule is expressed in four independent places** — the content-stage DELETE (`scope='account'`), the finalize COUNT (`scope='global'`), the verification arm (both), and `TABLE_DISPOSITIONS`'s prose. A change to the rule is a four-site edit. I did not flag it: these are four genuinely different operations (delete / count / verify / document), a shared predicate fragment would be over-abstraction for a two-value discriminator, and all four currently agree.

**A6. `retained_suppression_count?` has no removal trigger.** The optionality is justified by the in-flight rollout window, which closes within minutes of the deploy (purge finalize enqueues, OutboxPoller dispatches). After that the `?` and the `?? 0` are permanently indistinguishable from a legitimate zero. `production.md` warns about "'temporary' branching that is likely to become permanent debt." Given the two sibling fields (`recipient_email?`, `purged_at?`) already have the same shape, tightening this one alone would be inconsistent — so this is really a note about the payload family, not this field.

**A7. `vitest.config.ts:11-14` comment is stale.** It states "the integration suites self-skip there [in CI] because `TEST_DATABASE_POOL_URL` is unset", but `ci.yml`'s `test` job now stands up a `postgres:16` service and sets exactly that variable. Pre-existing, entirely outside this diff, but it directly contradicts the CI-reality check this review had to perform — worth correcting whenever that file is next touched.

**A8. `formatRetainedSuppressions` silently renders nothing for a non-integer.** `if (!Number.isInteger(count) || count <= 0) return ''` treats a corrupt payload value identically to a legitimate zero. `repworth.md` says "Do not catch errors silently." In practice the value is typed `number`, defaulted at the worker, and originates from a `::int` COUNT, and throwing inside an email template would fail an otherwise-good send — so log-and-swallow would be the only improvement, and there is no logger in scope. Left alone.

**A9. Three copies of one privacy assertion.** "A count, never a handle" / "An aggregate only — never handles" / "never lists the handles those rows hold" appear in `outbox.ts:49`, `worker-types.ts:278`, and `account-offboarding.ts:19`. All three are correct and each is at a boundary a reader might arrive at independently, so the redundancy is defensible; but it is three places to update if the field ever changes meaning.

**A10. `solicitation_suppressions.account_id` is a NO-ACTION FK to `accounts`.** Correct for the offboarding path, where `accounts` rows are tombstoned rather than deleted. Two production paths *do* hard-delete an `accounts` row — `src/lib/onboarding/admin-onboarding-service.ts:249` (creation rollback) and `scripts/ws8-staging-smoke.ts:269` — and both would throw an FK violation if a global suppression row carried that account as provenance. Blast radius is effectively nil (both fire at account-creation time, long before any solicitation send could exist), and the test suites already discovered and handled the same FK in their teardown ordering. Recording it so a future reader who moves `accounts` to a hard delete knows this edge exists.

---

## Triage verdicts — 2026-08-02 (step 7)

Every finding verified against the code before triage. Full reasoning in
`docs/superpowers/plans/feat-643-suppression-ledger-core-deviations.md` → "Step 7 dual
review — triage verdicts".

- **ACCEPTED** — `suppressionMatchSql` hardcoded `channel = 'email'`. Fixed: `channel` is
  now a required `SuppressionChannel` parameter; both call sites pass `'email'`.
- **REJECTED** — `handleColumn` should self-normalize via `lower(btrim(…))`. The remedy is
  not equivalent to `normalizeEmail` (which also validates and returns `null`), and it
  contradicts locked intake `edge_cases[9]`; on already-normalized data it would mask an
  upstream bug rather than surface it. The prose-only precondition is a fair observation;
  this is the wrong fix for it.
- **ACCEPTED IN PART** — purge-boundary contract with no remediation path. Mechanism
  confirmed (users are tombstoned, not deleted, so the verifier subquery keeps matching).
  Rejected the "oversight" framing — that arm is a deliberate tripwire documented at
  `suppression.ts:81-86`, and failing loudly on an owner-authored global row is correct.
  Accepted the missing remediation: the operator answer is now written down and handed to
  #645, which owns the Correction path. No code change.
- **ACCEPTED** — `solicitation_suppressed` distinct-ID doc drift. Fixed the doc (the code
  path is spec-mandated); named the per-row PostHog person consequence and handed the
  stable-sentinel decision to #644/#645/#627.
- **REJECTED** — extract the duplicated INSERT head. It would put indirection between the
  reader and the two byte-for-byte `ON CONFLICT` predicates, which is the one place in
  this codebase where literal readability is load-bearing.
- **REJECTED** — 1,483-line test file. The `vi.hoisted` bootstrap-reuse justification is on
  record and the reviewer conceded it; a new file would duplicate the bootstrap to satisfy
  a line count.
