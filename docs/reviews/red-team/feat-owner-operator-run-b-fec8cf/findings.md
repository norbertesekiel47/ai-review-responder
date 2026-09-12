# Red team — feat/owner-operator-run-b (round 1)

**Status: OPEN_P0** · mode `feature` · risk `high` · generated 2026-09-12T17:15:45.963Z

| | |
|---|---|
| Branch | `feat/owner-operator-run-b` |
| Fork ref (`origin/main`) | `6edacd0b094e47a1f72008ce75b126a4eead87ed` |
| Merge base | `6edacd0b094e47a1f72008ce75b126a4eead87ed` |
| Head | `dba7af671f8dcba589dc482e0a3ba86d8324fb07` |
| Intake SHA-256 | `44996c450670c1ba2a7f2bf6019091ff4d3ece1372ab17b45ebf48657780456c` |
| Round | 1 of 2 |
| Mutation runs used | 29 of 30 (3 baselines + 26 mutants) |

Counts: **62 candidates** — 18 killed, 0 confirmed survivors, 0 equivalent, 4 inconclusive, 37 skipped-budget, 3 excluded.
Findings: 11 — 1 open P0, 6 open P1, 4 open P2.

Everything below is evidence produced in this pass. The claimed gate
(`.feature/gate-status.json`) was NOT re-derived here — the final gate re-run is
the root's last serialized step.

## Findings

| id | sev | duty | at | disposition | finding |
|---|---|---|---|---|---|
| RT-01 | **P0** | 3 | `docs/runbooks/beta-launch-alerting.md:416` | open | The runbook and the roadmap record Sentry rule 11 as BUILT in both projects; it exists in neither, and the rule ids are literal placeholders |
| RT-02 | **P1** | 2 | `src/lib/agents/operator/__tests__/version-token.test.ts:83` | open | The version-token fast-check property cannot distinguish a versionTokensEqual that ignores businessId |
| RT-03 | **P1** | 1 | `src/lib/agents/operator/proposals.ts:448` | open | markSiblingProposalsStale's `AND status = 'pending'` guard is unverified — deleting it kills no test |
| RT-04 | **P1** | 2 | `src/lib/agents/operator/apply.ts:127` | open | `archived_at IS NULL` in the Apply businesses lock is pinned only by a SQL-text toContain, not by behaviour |
| RT-05 | **P1** | 1 | `src/lib/agents/operator/catalog.ts:174` | open | catalog.ts writerFields is covered for set_tone only; the other three proposables have no test |
| RT-06 | **P1** | 1 | `src/lib/agents/operator/reads.ts:268` | open | The durable per-turn Requested-capability wiring added to the conversation read has no vitest coverage |
| RT-07 | **P1** | 1 | `src/lib/agents/operator/reads.ts:424` | open | readConnectionStatus is covered only for the never-connected (null) case |
| RT-08 | **P2** | 1 | `src/lib/agents/operator/reads.ts:407` | open | activeLocationId's `archived_at IS NULL` is unverified |
| RT-09 | **P2** | 4 | `src/app/(authenticated)/settings/auto-approval/page.tsx:16` | open | A third impersonation-presence spelling survives the H1-B consolidation |
| RT-10 | **P2** | 1 | `src/lib/agents/operator/proposals.ts:446` | open | markSiblingProposalsStale's account_id predicate is behaviourally redundant (kept for ci:tenant-scope) |
| RT-11 | **P2** | 3 | `docs/superpowers/plans/feat-owner-operator-run-b-handoff.md:19` | open | prevalidate-plan.py reports two stale commits in the handoff; both are fragments of a Codex session UUID |

### RT-01 — P0 — The runbook and the roadmap record Sentry rule 11 as BUILT in both projects; it exists in neither, and the rule ids are literal placeholders

- **Where:** `docs/runbooks/beta-launch-alerting.md:416`
- **Duty:** 3
- **Disposition:** open

The diff rewrites the rule 11 row from "REQUIRED BEFORE OWNER_OPERATOR_ENABLED GOES ON; NOT CONFIGURED BY THIS CHANGE" to "**BUILT 2026-09-12, staging rule `<staging-rule-id>`, production rule `<prod-rule-id>`**" — the row asserts BUILT while carrying unfilled placeholders where the file’s own convention (rule 9: "BUILT 2026-09-04, rule `3946648`") records a real id. docs/roadmap/2026-09-11-owner-operator/README.md:649 states BullMQ retry exhaustion "reaches Sentry ... under runbook **rule 11**, which Run B built in both Sentry projects before the staging flip", and README:697 says the decision was "closed as logs-only with rule 11 built in both Sentry projects". Read back from the Sentry API on 2026-09-12 (org repworth-nv): repworth-staging holds exactly two issue alert rules (3927243 solicitation-unattributed-suppression, 3608329 high-priority default) and repworth-production exactly four (3946648, 3927261, 3925256, 3920752). No rule matching agent-turn-exhausted, and no rule filtering subsystem:worker_job AND queue:agent_turn, exists in either project. The emitting half of the path IS present and correct (worker/job-failure-sink.ts:74 tags {subsystem:"worker_job", queue: queueName}; QUEUE_NAMES.AGENT_TURN === "agent_turn"), so this is the receiving half missing while three documents say it is in place — the intake names this exact alert as a go-live precondition ("First flip of OWNER_OPERATOR_ENABLED anywhere ... the Sentry rule-11 alert must exist before it") and .claude/CLAUDE.md carries the same owed item. Remedy: either build both rules and record their real ids, or revert all three claims to the REQUIRED/NOT CONFIGURED wording. Note that env-vars.md and eservices-variables.md state the precondition correctly, so the three claims above are the only false ones.

### RT-02 — P1 — The version-token fast-check property cannot distinguish a versionTokensEqual that ignores businessId

- **Where:** `src/lib/agents/operator/__tests__/version-token.test.ts:83`
- **Duty:** 2
- **Disposition:** open

The property is titled "equal version tokens are exactly those with equal businessId and equal updatedAt text" and computes `expected = a.businessId === b.businessId && a.updatedAt === b.updatedAt`, but its generator draws updatedAt from fc.string({minLength:1,maxLength:40}). Two independently generated free strings are never equal in the default 100 runs, so the only pair that separates the real function from one comparing updatedAt alone — different businessId, SAME updatedAt — is never generated. Mutation M06 (drop the businessId comparison) passed the property. The example test at line 22 does cover the case, so production behaviour is pinned; the property is what is weak. Behavioural replacement: draw updatedAt from a small fc.constantFrom of two or three fixed timestamp strings (as businessId already is), so the cross product actually reaches equal-timestamp/different-row.

### RT-03 — P1 — markSiblingProposalsStale's `AND status = 'pending'` guard is unverified — deleting it kills no test

- **Where:** `src/lib/agents/operator/proposals.ts:448`
- **Duty:** 1
- **Disposition:** open

Mutation M11 removed the pending predicate from the sibling sweep and the live-DB case that exists for this sweep still passed. The fixture creates one pending sibling on the location, one pending proposal on a second location, and the proposal being applied — no ALREADY-TERMINAL sibling on the applied location, which is the only state the predicate decides. Without it, a previously APPLIED proposal on the same location is rewritten to status `stale` with failure_reason `version_mismatch` on the next Apply of that location, overwriting the applied record whose Receipt is still stored beside it — the state the intake’s Receipt invariant exists to prevent. Remedy: add one fixture row to the existing case — a second proposal on the applied location that is already `applied` (or `rejected`) — and assert its status and failure_reason are untouched after the sweep.

### RT-04 — P1 — `archived_at IS NULL` in the Apply businesses lock is pinned only by a SQL-text toContain, not by behaviour

- **Where:** `src/lib/agents/operator/apply.ts:127`
- **Duty:** 2
- **Disposition:** open

Mutation M04 deleted the predicate and "applyProposal rejects the proposal location_not_found when the location was archived after preparation" still passed: that case primes an EMPTY lock result from the mock, so it proves the !locked branch, not the predicate that produces it. The only thing that catches the deletion is `expect(sqlCalls[1]!.text).toContain('archived_at IS NULL')` at apply.test.ts:174 — a string proxy for a behaviour, which passes for any query that merely mentions the phrase and would fail on an equivalent rewrite. The live-DB suite’s archival case applies FIRST and archives afterwards, so it exercises the repeat-Apply path, never pending-plus-archived. Behavioural replacement: one live-DB case that seeds a pending voice proposal, archives the location with the production helper, then applies — asserting rejected/location_not_found and that businesses is unchanged.

### RT-05 — P1 — catalog.ts writerFields is covered for set_tone only; the other three proposables have no test

- **Where:** `src/lib/agents/operator/catalog.ts:174`
- **Duty:** 1
- **Disposition:** open

`writerFields` is the new mechanism behind decision D10 ("only this operation’s own fields reach the shared voice writer"). catalog.test.ts never references it, and every Apply fixture — unit and live-DB — uses set_tone. set_products_services, set_avoid_facts and set_highlight_facts therefore have no test at all: swapping avoidFacts for highlightFacts in one closure, or returning {}, would write the wrong voice column or none, and the whole suite stays green. Remedy: a table-driven catalog case asserting, for each of the four proposables, that writerFields(parsed) returns exactly the operation’s own key with the parsed value.

### RT-06 — P1 — The durable per-turn Requested-capability wiring added to the conversation read has no vitest coverage

- **Where:** `src/lib/agents/operator/reads.ts:268`
- **Duty:** 1
- **Disposition:** open

RB-07 added `unsupported` to OwnerConversationTurn and a batched listUnsupportedForTurns. Reverse import search finds no vitest test that seeds an agent_unsupported_requests row and reads it back through getConversationForOwner: reads.integration.test.ts only DELETEs the table in cleanup, and the client test renders the field from a mocked fetch. The batched map’s keying, its account predicate, and the `?? []` default are unmeasured; only e2e/operator.spec.ts (local-only, self-skips in CI) touches the path. Remedy: extend the existing live-DB transcript case to insert one unsupported row on one turn and assert it lands on that turn and no other, and that a turn with none carries [].

### RT-07 — P1 — readConnectionStatus is covered only for the never-connected (null) case

- **Where:** `src/lib/agents/operator/reads.ts:424`
- **Duty:** 1
- **Disposition:** open

The only server-side assertion is `expect(summary.connectionStatus).toBeNull()` (reads.integration.test.ts:608). No vitest test seeds a zernio_connections row, so the latest-row rule (ORDER BY created_at DESC LIMIT 1, which is what makes a soft-deleted disconnect read as the current state), the JOIN businesses tenant scoping that stands in for the missing account_id column, the three accepted values and the "value no writer produces" throw are all unexercised. SummaryPanel.test.tsx covers the CLIENT rendering of the three values, which is a different question. Remedy: seed two connection rows for one location (an older `active`, a newer `disconnected`) and assert `disconnected`, plus one row on another account’s location asserting it is not read.

### RT-08 — P2 — activeLocationId's `archived_at IS NULL` is unverified

- **Where:** `src/lib/agents/operator/reads.ts:407`
- **Duty:** 1
- **Disposition:** open

Mutation M15 deleted the predicate and the first-time-owner case still passed — it probes a foreign location (which M14 proved is caught by the account predicate) but never an archived one. Effect if the predicate were lost: an owner could scope the empty-screen summary panel to their own archived location. Read-only and same-tenant, hence P2. Remedy: one extra probe in the same case against an archived location of the same account, asserting null.

### RT-09 — P2 — A third impersonation-presence spelling survives the H1-B consolidation

- **Where:** `src/app/(authenticated)/settings/auto-approval/page.tsx:16`
- **Duty:** 4
- **Disposition:** open

Duty-4 sibling search. Patterns searched: `rw_impersonation`, `IMPERSONATION_COOKIE_NAME`, `hasImpersonationCookie` across src/ and worker/, excluding __tests__ and e2e/. Scope: every match, 26 hits. Result: the two byte-identical private copies the diff folded into the shared helper are gone, and all four operator/settings ROUTES now call it. One presence check remains hand-rolled — `Boolean(cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value)` on the auto-approval server PAGE. It is not a defect: the shared helper takes a NextRequest and a server component has only `cookies()`, so the helper does not fit; recorded so the next consolidation does not report it as newly discovered. The remaining hits (admin/layout.tsx, admin/impersonate/[sessionId]/view/page.tsx, the impersonation start/end routes) read or set the raw value for verification, not as a presence gate, and are correctly untouched. Second pattern searched: nav arms below a `/dashboard` catch-all — `startsWith('/dashboard/')` across src/components and src/lib; two hits, active-nav.ts (the module the diff fixes) and protected-routes.ts (a flat allowlist with no fall-through order). ZERO siblings for that pattern.

### RT-10 — P2 — markSiblingProposalsStale's account_id predicate is behaviourally redundant (kept for ci:tenant-scope)

- **Where:** `src/lib/agents/operator/proposals.ts:446`
- **Duty:** 1
- **Disposition:** open

Mutation M13 removed the predicate and the live-DB sibling case passed. This is a provable non-defect rather than a coverage gap: businesses.id is globally unique, and every agent_proposals row has its account_id and location_id written together in buildProposalRows from one already-validated turn, so `location_id = L` already selects rows of exactly one account and adding `account_id = A` removes none and adds none. The predicate must stay — ci:tenant-scope requires it and it is the guard if a writer ever diverges — but no test can be written that would fail without it while the writer discipline holds. Recorded so it is not re-reported as an uncovered guard next round. No action.

### RT-11 — P2 — prevalidate-plan.py reports two stale commits in the handoff; both are fragments of a Codex session UUID

- **Where:** `docs/superpowers/plans/feat-owner-operator-run-b-handoff.md:19`
- **Duty:** 3
- **Disposition:** open

Duty 3 re-resolution. prevalidate-plan.py PASSES on the plan (97 citations, 16 fixtures, 1 commit), the deviations file (6 citations), the evidence file, the roadmap README and the runbook. It reports 2 issues on the handoff: `01a0960d` and `e1d2f82c8a0c` "do not resolve to a commit in this repo". Both are hex runs inside the Codex session id `01a0960d-4387-7f72-be06-e1d2f82c8a0c`, not commit references — a tool false positive, not a false claim. Recorded rather than silently dropped so the next pass does not re-investigate. No action.

## Environment

```
mutation-runner.mjs round-start
mutation-runner.mjs env          --tmp-home <mktemp -d> --test-db <localhost:5499 test db>
mutation-runner.mjs dotenv-swap  --test-db <same>
```

Allowlist only: `PATH`, a temporary `HOME`, `TMPDIR`, `NODE_ENV=test`, `CI=true`,
`MOCK_EXTERNAL_APIS=true`, and `TEST_DATABASE_POOL_URL`/`DATABASE_POOL_URL` after the
runner validated the URL as localhost (docker container `repworth-testdb`,
`localhost:5499`). `.env.local` was swapped for a scrubbed copy for the whole
mutation phase. `watchers` reported none serving this worktree; the tracked tree
was clean at `dba7af671f8dcba589dc482e0a3ba86d8324fb07` before the first mutation.

**Baselines, both fully green at HEAD:**

- all 14 non-live-DB candidate files in one launch → **174 passed, 0 failed**
- the two live-DB suites in one launch → **15 passed, 0 failed, 0 skipped**

## Deviations from the skill, disclosed

- **D1 — file-level green baselines.** The runner counts every `run` launch
  against the 30-per-round cap, so one launch per candidate (56 candidates × 2)
  was impossible. Baselines were taken as two file-level launches and each
  candidate's individual pass was read out of the vitest JSON report. Every
  mutant re-run was still a single-test launch verified with `assert-one-test`.
- **D2 — one launch wasted.** Launch 2 of 30 omitted `--test-db` on `run` (it had
  been passed to `env` and `dotenv-swap` only), so the live-DB suites
  self-skipped. Re-taken correctly as launch 3. No measurement was drawn from it.
- **D3 — three mutations on one test.** Inventory row `I02` (the sibling-sweep
  live-DB case) received M11, M12 and M13, exceeding the documented cap of two
  mutations per test. Over-measurement, not under; findings RT-03 and RT-10 come
  from it.
- **D4 — per-mutation restore.** `finalize` belongs to the invoking root, so each
  mutation was reverted by rewriting the pristine bytes captured before `mutate`,
  then verified with `git status --porcelain -- <path>` (empty every time). Every
  journal entry's working blob now equals its recorded `originalOid`, which is
  the state `finalize` accepts and closes.

## Duty 2 — fragile assertions

- **RT-04** (P1): `expect(sqlCalls[1]!.text).toContain('archived_at IS NULL')` is
  the only thing pinning that predicate — a string proxy for a behaviour, proven
  fragile by mutation M04.
- **RT-02** (P1): a fast-check property whose generator cannot reach the input
  that would falsify it.
- Reviewed and NOT findings: the exact `.mtab` counts in `MobileTabBar.test.tsx`
  (the count IS the claim — a 390px width budget — and it is paired with a
  role-based link assertion); the positional `VALUE_INDEX` assertions in
  `proposals.test.ts` (a positional INSERT is exactly what they guard); the
  `<= 15` poll-count bound in `OperatorClient.test.tsx` (a bound, not an exact
  count, and mutation M20 proved it discriminates); the line-anchored
  `/^\s*UPDATE\s/m` write filter, which these suites adopted specifically because
  `includes('UPDATE')` also matches every `FOR UPDATE` lock read.
- No absence-of-tag proxies, and no order assertions without an ordering
  contract, were found in the changed tests.

## Duty 3 — docs vs reality

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py <doc> --repo .`
was run against every changed doc that carries citations:

| doc | result |
|---|---|
| `feat-owner-operator-run-b-plan.md` | PASS — 97 citations, 16 fixtures, 1 commit |
| `feat-owner-operator-run-b-deviations.md` | PASS — 6 citations |
| `feat-owner-operator-run-b-handoff.md` | 2 "stale commits" — both false positives (RT-11) |
| `docs/reviews/feat-owner-operator-run-b/evidence.md` | PASS |
| `docs/roadmap/2026-09-11-owner-operator/README.md` | PASS on citations; **RT-01** on a claim the script cannot check |
| `docs/runbooks/beta-launch-alerting.md` | PASS on citations; **RT-01** on the rule 11 row |
| `docs/context/owner-operator.md` | PASS |

Hand-checked beyond the script:

- `evidence.md` claims `e2e/operator.spec.ts` captures seven of the eighteen
  screenshots — verified: seven `page.screenshot` calls with names matching the
  table.
- `lab-notes/postgres.md` raises the JSONB parse-site count 23 → 25 and the Owner
  Operator bullet 4 → 6. The enumerated bullets sum to 25, and both added sites
  (`prepared_version_token` via `parseVersionToken`, `receipt` via `parseReceipt`)
  exist and are both reached from `mapStored`. Consistent.
- `lib-owner-operator.md` states `parseVoiceState` "is not a second JSONB parse
  site" — correct: it narrows an object `parseJsonbObject` already produced.
- `env-vars.md` and `eservices-variables.md` state the rule-11 precondition in the
  future tense and are NOT part of RT-01.

## Duty 4 — missed sibling cases

Recorded in full on **RT-09**: the patterns, scope and exclusions for the
impersonation-cookie consolidation (26 hits, one explained non-defect remaining)
and for the nav-arm ordering fix (2 hits, **zero siblings**). Both searches were
sound; neither invented a sibling.

## Duty 5 — operational completeness

One operator-actionable terminal path is added: BullMQ retry exhaustion on the
`agent_turn` queue. Static six-facet comparison of runbook rule 11 against the
emitted signal and the live Sentry configuration:

| facet | runbook row | emitted / configured | verdict |
|---|---|---|---|
| signal identity | `subsystem` = `worker_job` AND `queue` = `agent_turn` | `worker/job-failure-sink.ts:74` tags `{subsystem:'worker_job', queue: queueName, topic: job.name}`; `QUEUE_NAMES.AGENT_TURN === 'agent_turn'` | match |
| filter | the same two tags | — | match |
| level | `error` (the `captureException` default) | `Sentry.captureException` | match |
| grouping title | not specified | default | n/a |
| threshold / cadence | "every event" | — | no rule to compare against |
| destination action | Discord | — | **no rule exists in either project** |

The receiving half is absent in both Sentry projects while three documents say it
is built → **RT-01 (P0)**. The six DOMAIN terminal reasons are logs-only by
recorded decision (spec §14, D6) and correctly carry no rule row, so they are not
a finding. No other terminal or swallowed path in this diff is
operator-actionable: every route failure answers the owner and is reported
through the existing `reportCaughtError` seam with ids only, and the Apply
executor's deterministic refusal commits a readable `failure_reason` on the row.

## Inventory

62 candidates. Direction A is every added or modified Vitest case on the changed
test surface; Direction B adds three production hunks whose reverse import search
found no covering vitest test. Playwright is excluded by the skill.

| id | file | test / hunk | outcome | evidence |
|---|---|---|---|---|
| `A01` | apply.test.ts | applyProposal locks the businesses row before the proposal row and writes only the operation's own fields through updateVoiceConfig | `killed` | M03 swapped the businesses/proposal lock order → failed. M09 widened the writer bag to the full previewed state → failed on Object.keys(fields) === ["tone"]. Two mutations, both killed. |
| `A02` | apply.test.ts | applyProposal on an applied proposal returns the stored receipt and executes nothing | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `A03` | apply.test.ts | applyProposal marks the proposal stale without mutation when the current token differs from the prepared token | `killed` | M08 dropped the versionTokensEqual(current, prepared) arm of the three-way compare → failed. |
| `A04` | apply.test.ts | applyProposal marks the proposal stale without mutation when the client's expected token differs from the prepared token | `killed` | M07 dropped the versionTokensEqual(prepared, expected) arm of the three-way compare → failed. |
| `A05` | apply.test.ts | applyProposal rejects a proposal whose contract_version is not the catalog's with contract_changed before any lock | `killed` | M02 removed recordTerminal's `AND status = 'pending'` predicate → failed on the bound-value assertion and on the lost-race re-read. |
| `A06` | apply.test.ts | applyProposal returns proposal_not_found for a proposal of another account | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `A07` | apply.test.ts | applyProposal answers proposal_not_pending for a stale, rejected, superseded or failed proposal | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `A08` | apply.test.ts | applyProposal rejects the proposal unauthorized when the actor is no longer a writable owner | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `A09` | apply.test.ts | applyProposal rejects the proposal location_not_found when the location was archived after preparation | `killed` | M04 (delete `AND archived_at IS NULL` from the businesses lock) SURVIVED — this case primes an empty lock result, so it never reaches the state the predicate decides (finding RT-04). M05, on the branch this case does execute (wrong failure reason on the still-pending arm), was killed, which resolves this row. |
| `A10` | apply.test.ts | invariants: from any non-pending status applyProposal never writes businesses | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `V01` | version-token.test.ts | version token equality is text-to-text on both fields and a one-microsecond difference is not equal | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `V02` | version-token.test.ts | version token parser rejects a stored token missing businessId or updatedAt | `killed` | M01 removed `.strict()` from VoiceVersionTokenSchema → the unknown-key case stopped throwing → failed. |
| `V03` | version-token.test.ts | invariants: equal version tokens are exactly those with equal businessId and equal updatedAt text | `inconclusive` (oracle) | M06 dropped the businessId comparison from versionTokensEqual and the property PASSED. The generator pairs fc.constantFrom(two uuids) with fc.string({minLength:1,maxLength:40}); two independently generated free strings are never equal, so the discriminating input (different businessId, SAME updatedAt) is never produced and the mutant is unobservable to this oracle. Not equivalent (behaviour differs) and not an unexecuted branch, but unobservable under this property’s input distribution — an ORACLE claim. Finding RT-02. |
| `P01` | proposals.test.ts | declineProposal sets status rejected and decided_by_user_id with no reason and is idempotent | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `P02` | proposals.test.ts | declineProposal answers proposal_not_pending for an applied proposal | `killed` | M10 dropped the `failureReason === null` half of the owner-decline signature → a server-rejected row answered `rejected/repeated` instead of `not_pending` → failed. |
| `P03` | proposals.test.ts | proposal view carries receipt, prepared version token, applied_at and failure_reason | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `I01` | apply.integration.test.ts | applyProposal writes the receipt, status applied and decided_by_user_id in the same transaction as the voice write | `killed` | M22 (stop dropping the stored `updatedAt` in parseVoiceState) SURVIVED — this case’s hand-built before/after carry only the five fields, so the drop never fires; the same mutant is killed by I06, which goes through buildProposalRows. M26 (drop `decided_by_user_id` from the applied UPDATE) was killed, which resolves this row. |
| `I02` | apply.integration.test.ts | applyProposal marks sibling pending proposals on the same location stale in the same transaction and leaves other locations alone | `killed` | M12 (drop `location_id` from markSiblingProposalsStale) → failed. M11 (drop `AND status = 'pending'`) SURVIVED: no non-pending sibling exists on the location in this fixture (finding RT-03). M13 (drop `account_id`) also survived and is provably behaviour-preserving — businesses.id is globally unique and every row’s (account_id, location_id) pair is written together from one validated turn, so the extra predicate removes no row (finding RT-10). THREE mutations on one test: over the 2-per-test cap, disclosed as deviation D3. |
| `I03` | apply.integration.test.ts | applyProposal receipt after equals the committed voice state and flags a difference from the stored after | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `I04` | apply.integration.test.ts | applyProposal rolls back the receipt when the voice write throws | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `I05` | apply.integration.test.ts | two concurrent applies on one proposal produce one voice write and both return the same receipt | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `I06` | apply.integration.test.ts | worker-produced proposals render and apply successfully | `killed` | M25 (stop dropping the stored `updatedAt` in parseVoiceState) → failed on `expect(receipt.before).not.toHaveProperty("updatedAt")`. This is the case that pins the six-key stored shape Run A actually writes. |
| `I07` | apply.integration.test.ts | repeat Apply after location archival returns the original receipt without writes | `killed` | M24 disabled the applied-status arm inside the `!locked` branch (RB-10 ordering) → the repeat Apply answered not_pending instead of returning the stored Receipt → failed. |
| `R01` | reads.integration.test.ts | first-time owner receives a scoped summary and connection CTA before sending | `killed` | M14 (drop `account_id` from activeLocationId) → the foreign-location probe stopped returning null → failed. M15 (drop `archived_at IS NULL`) SURVIVED — no archived location exists in this fixture (finding RT-08). |
| `AR1` | apply-route.test.ts | POST apply returns 404 operator_disabled before auth when the flag is off | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `AR2` | apply-route.test.ts | POST apply rejects a missing or mismatched Origin before any read | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `AR3` | apply-route.test.ts | POST apply rejects an impersonated session with 409 impersonation_not_allowed | `killed` | M18 deleted the hasImpersonationCookie gate from the apply route → 200 instead of 409 → failed. The fixture cookie carries an invalid signature, so this also pins presence-not-validity. |
| `AR4` | apply-route.test.ts | POST apply maps applied to 200 with the receipt, stale to 409 proposal_stale, contract_changed to 409, not_found to 404 and not_pending to 409 | `killed` | M23 removed `.strict()` from ApplyBodySchema → an unknown body key stopped being a 400 → failed. |
| `DR1` | decline-route.test.ts | POST decline returns 404 operator_disabled before auth when the flag is off and rejects a mismatched Origin | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `DR2` | decline-route.test.ts | POST decline returns 200 with the rejected proposal and 404 for another account's proposal | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `CR1` | conversation-route.test.ts | GET conversation returns the actor's most recent conversation and the summary reads with timestamps | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `CR2` | conversation-route.test.ts | GET conversation scopes the summary to ?locationId= when the conversation has no turns | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `PR1` | protected-routes.test.ts | isProtectedOwnerApiRoute returns true for /api/operator, /api/operator/turns, /api/operator/conversation and both proposal routes | `killed` | M16 removed the exact `normalized === '/api/operator'` arm, keeping only the prefix → failed. |
| `AN1` | active-nav.test.ts | folds /dashboard/operator into the operator section | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `AN2` | active-nav.test.ts | keeps the operator arm above the /dashboard catch-all | `killed` | M17 moved the operator arm below the catch-all → `/dashboard/operator` folded into `dashboard` → failed. |
| `MT1` | MobileTabBar.test.tsx | stays five tabs wide either way with the Operator off | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `MT2` | MobileTabBar.test.tsx | adds a sixth Operator tab when the server says the flag is on | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `MT3` | MobileTabBar.test.tsx | marks Operator active on /dashboard/operator without lighting up Home | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `SB1` | Sidebar.test.tsx | shows the Operator row only when the server-authoritative prop is true | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `OC01` | OperatorClient.test.tsx | operator screen posts a turn with the stored location, shows Preparing your plan and resumes the same turn from URL state after a reload | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `OC02` | OperatorClient.test.tsx | operator screen backs off polling and shows the timeout notice with Start a new conversation after four minutes | `killed` | M19 widened POLL_DEADLINE_MS from 4 to 40 minutes → the timeout notice never rendered → failed. M20 removed the backoff ternary (always POLL_FAST_MS) → the poll-count bound (<= 15) failed at 30. Two mutations, both killed. |
| `OC03` | OperatorClient.test.tsx | operator times out while a poll request remains unresolved | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `OC04` | OperatorClient.test.tsx | operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `OC05` | OperatorClient.test.tsx | operator screen disables the composer under All locations and enables it once a location is chosen | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `OC06` | OperatorClient.test.tsx | retry after a lost POST response resumes the original turn | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `OC07` | OperatorClient.test.tsx | operator renders every stored segment kind in order | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `OC08` | OperatorClient.test.tsx | terminal failures and requested capabilities survive reload and subsequent turns | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `OC09` | OperatorClient.test.tsx | loaded conversations retain identity and starting over stays empty | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `OC10` | OperatorClient.test.tsx | a delayed conversation response never replaces a newly submitted turn | `killed` | M21 dropped the `activeTurnIdRef.current === null` half of the resume guard → the stale conversation response adopted the older turn and rewrote the URL → failed. |
| `OC11` | OperatorClient.test.tsx | Refresh plan preserves the original instruction and location after scope changes | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `PC1` | ProposalCard.test.tsx | proposal card renders the target from the stored location and shows Prepared for the location when the selector moved | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `PC2` | ProposalCard.test.tsx | proposal card shows the receipt after Apply and the stale wording with Refresh plan after a version mismatch | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `PC3` | ProposalCard.test.tsx | proposal previews expose exact fact replacements before approval | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `PC4` | ProposalCard.test.tsx | requested capability card has no Apply button | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `SP1` | SummaryPanel.test.tsx | summary panel renders the three blocks with as-of timestamps and the connect call to action when the connection is missing | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `PG1` | page.test.tsx | operator page calls notFound when the flag is off and the nav omits the entry | `skipped-budget` | not executed — the 30-run per-round cap was reached (29 launches: 3 baselines + 26 mutants) against a 62-row inventory |
| `B01` | reads.ts | (no covering vitest test) reads.ts per-turn `unsupported` + proposals.ts listUnsupportedForTurns | `inconclusive` (oracle) | Reverse import search found no vitest test that exercises the durable Requested-capability wiring added at reads.ts:268 / reads.ts:121. reads.integration.test.ts only DELETEs from agent_unsupported_requests in cleanup and never seeds one; OperatorClient.test.tsx renders the field from a mocked fetch, so it cannot observe the server wiring. Only the local-only Playwright spec touches it. P1 uncovered change — finding RT-06. |
| `B02` | reads.ts | (no covering vitest test) reads.ts readConnectionStatus non-null branches and the invalid-value throw | `inconclusive` (oracle) | reads.integration.test.ts:608 asserts only `connectionStatus === null` (a location with no zernio_connections row). No vitest test seeds a zernio_connections row, so the ORDER BY created_at DESC LIMIT 1 latest-row rule, the JOIN businesses tenant scoping, the three accepted values and the throw are all unexercised server-side. SummaryPanel.test.tsx covers the CLIENT rendering only. P1 uncovered change — finding RT-07. |
| `B03` | catalog.ts | (no covering vitest test) catalog.ts writerFields for set_products_services, set_avoid_facts, set_highlight_facts | `inconclusive` (oracle) | catalog.test.ts does not mention writerFields at all; apply.test.ts and every live-DB Apply fixture use set_tone only. A wrong field name in any of the other three writerFields closures would write the wrong voice column (or none) with no test failing — the D10 "only this operation’s own fields" rule is pinned for one operation of four. P1 uncovered change — finding RT-05. |
| `E01` | operator.spec.ts | unauthenticated /dashboard/operator redirects to the owner login | `excluded` | Playwright/E2E spec — out of scope for mutation by the skill (fragile-assertion review only); the two authenticated cases additionally self-skip without the local auth harness |
| `E02` | operator.spec.ts | e2e: owner sends a turn, applies the tone proposal and sees the receipt at 390 and 1440 | `excluded` | Playwright/E2E spec — out of scope for mutation by the skill (fragile-assertion review only); the two authenticated cases additionally self-skip without the local auth harness |
| `E03` | operator.spec.ts | e2e: a settings write between proposal and Apply produces a stale card with Refresh plan | `excluded` | Playwright/E2E spec — out of scope for mutation by the skill (fragile-assertion review only); the two authenticated cases additionally self-skip without the local auth harness |

## Authorizations

None. No finding on this run is accepted-risk.
