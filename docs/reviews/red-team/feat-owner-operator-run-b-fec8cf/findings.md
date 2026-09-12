# Red team — feat/owner-operator-run-b (round 3)

**Status: INCOMPLETE_ORACLE** · mode `feature` · risk `high` · generated 2026-09-12T19:12:03.709235Z

| | |
|---|---|
| Branch | `feat/owner-operator-run-b` |
| Fork ref (`origin/main`) | `6edacd0b094e47a1f72008ce75b126a4eead87ed` |
| Merge base | `6edacd0b094e47a1f72008ce75b126a4eead87ed` |
| Head (round 3) | `ef9b3a7cab29ee4e31f0b54f24cf5df65d512574` |
| Head (round 2) | `619461e60418986e095e1018d12ed631a97349a3` |
| Head (round 1) | `dba7af671f8dcba589dc482e0a3ba86d8324fb07` |
| Intake SHA-256 | `44996c450670c1ba2a7f2bf6019091ff4d3ece1372ab17b45ebf48657780456c` |
| Round | 3 of 3 — opened on owner authorization `AUTH-2` |
| Mutation runs used (round 3) | 11 of 30 (5 HEAD baselines + 6 single-test mutants) |

Counts: **69 candidates** — 22 killed, 0 confirmed survivors, 1 equivalent, 1 inconclusive, 42 skipped-budget, 3 excluded.
Findings: 17 — 13 fixed, 2 rejected, 0 open P0, 1 open P1, 1 open P2.

Round 3's mandate, set by the owner's `AUTH-2` (rendered verbatim under Authorizations):
verify the six round-2 fixes — RT-11, RT-12, RT-13, RT-15, RT-16, RT-17 — and report
only inside those fix hunks. The exact delta is `git diff 77d121f48..be03c88c2`
(one docs file, three test files, one production file: `wording.ts`). No front was
opened against unchanged code, and RT-14 was deliberately left unmeasured because the
authorization does not name it. Round-1 and round-2 evidence is preserved verbatim at
the head of each finding's narrative, with this round's re-derivation appended under a
ROUND 3 marker.

The claimed gate was NOT re-derived here — the final gate re-run is the root's last
serialized step, and `finalize` is the root's to run.

## Round 3 — method and result

Preconditions, all checked before any measurement: the worktree was clean at a committed
SHA (`ef9b3a7ca`); `mutation-runner.mjs watchers` reported none serving this worktree;
`round-start` opened round 3 and reset the budget — it accepted the round only because
`AUTH-2` already carried the owner's verbatim text naming a third round. The environment
was the runner's allowlist with a temporary `HOME` and a validated **localhost** test
database, and `.env.local` was swapped for the scrubbed replacement for every mutation
phase. Every mutation went through `mutate` (journaled original blob OID before the
write), every run through the paused supervisor with `assert-one-test`, and `finalize`
restored the tree between the three mutation cycles and again at the end. After the last
`finalize`: `git status --porcelain` empty, no dotenv backup, no unrestored journal entry.

**Result: five of six fixed, one still open.** RT-11, RT-13, RT-15, RT-16 and RT-17 are
`fixed`, each with a mutation that now kills (or, for RT-11, a re-derived tool run).
RT-12 stays `open`: the fix added a real behavioural case that passes at HEAD, but both
halves of N08 still survive it, so the row stays `inconclusive` (class `oracle`) and the
status stays `INCOMPLETE_ORACLE`. No kill was invented, and no survivor was promoted to
`equivalent` without a proof.

| finding | mutation applied this round | result |
|---|---|---|
| RT-11 | none (duty 3) — `prevalidate-plan.py` re-run at HEAD, and against the pre-fix file for comparison | **fixed** — `COMMITS: 1 checked, 0 stale`, `PREVALIDATE: PASS` (pre-fix: 3 checked, 2 stale); citations and fixtures unchanged at 0 |
| RT-12 | N08a — delete `conversationLoadRef.current?.abort()` from `adoptAcceptedTurn` (`useOperatorConversation.ts:275`) | **survived** → `inconclusive` (oracle) |
| RT-12 | N08b — delete the same call from `startFresh` (`useOperatorConversation.ts:315`) | **survived** → same row |
| RT-13 | N16 — `turn.proposals.filter((p) => !placed.has(p.id)).map(card)` → `turn.proposals.map(card)` (`TurnBody.tsx:124`) | **killed** at `OperatorClient.test.tsx:577` |
| RT-15 | drop `WHERE id = ${accountId}::uuid` from `readSummaryEntitlement` (`reads.ts:495`) | **killed** at `reads.integration.test.ts:848` |
| RT-16 | `ReceiptView.tsx:69` `{describe}` → `{receipt.operation}` (print the catalog id) | **killed** at `ProposalCard.test.tsx:173` — the new scoped assertion |
| RT-17 | N10b — delete `unauthorized: ACTOR_UNAUTHORIZED,` from `ROUTE_ERROR_WORDING` (`wording.ts:188`) | **killed**; duplication separately confirmed gone by code read |

Two honest caveats are recorded on the rows themselves rather than smoothed over.
**RT-12:** the mutants survive because the read effect's cleanup — `return () =>
controller.abort();` at `useOperatorConversation.ts:261` — aborts the same controller on
the next commit, and both commands change that effect's dependencies. That mechanism was
read from the code, not measured: the two-mutations-per-test cap was spent on N08a and
N08b, so no third mutation removed the cleanup to prove which path supplies the abort.
The explicit calls are still not redundant in general — they are synchronous, the cleanup
is deferred to the commit, and the read's four early arms run before the epoch guard in
exactly that window. **RT-17:** the killing case asserts against
`ROUTE_ERROR_WORDING.unauthorized` read from the module, so the kill pins the key's
presence, not the sentence's text; the single-spelling claim rests on the code read
(both maps now reference `ACTOR_UNAUTHORIZED` / `ACCOUNT_OFFBOARDING`), not on a mutation.

## Dispositions

| id | sev | duty | at | disposition | finding |
|---|---|---|---|---|---|
| RT-01 | **P0** | 3 | `docs/runbooks/beta-launch-alerting.md:416` | **fixed** | The runbook and the roadmap record Sentry rule 11 as BUILT in both projects; it exists in neither, and the rule ids are literal placeholders |
| RT-02 | P1 | 2 | `src/lib/agents/operator/__tests__/version-token.test.ts:83` | **fixed** | The version-token fast-check property cannot distinguish a versionTokensEqual that ignores businessId |
| RT-03 | P1 | 1 | `src/lib/agents/operator/proposals.ts:448` | **fixed** | markSiblingProposalsStale's `AND status = 'pending'` guard is unverified — deleting it kills no test |
| RT-04 | P1 | 2 | `src/lib/agents/operator/apply.ts:127` | **fixed** | `archived_at IS NULL` in the Apply businesses lock is pinned only by a SQL-text toContain, not by behaviour |
| RT-05 | P1 | 1 | `src/lib/agents/operator/catalog.ts:174` | **fixed** | catalog.ts writerFields is covered for set_tone only; the other three proposables have no test |
| RT-06 | P1 | 1 | `src/lib/agents/operator/reads.ts:268` | **fixed** | The durable per-turn Requested-capability wiring added to the conversation read has no vitest coverage |
| RT-07 | P1 | 1 | `src/lib/agents/operator/reads.ts:424` | **fixed** | readConnectionStatus is covered only for the never-connected (null) case |
| RT-08 | P2 | 1 | `src/lib/agents/operator/reads.ts:407` | **fixed** | activeLocationId's `archived_at IS NULL` is unverified |
| RT-09 | P2 | 4 | `src/app/(authenticated)/settings/auto-approval/page.tsx:16` | **rejected** | A third impersonation-presence spelling survives the H1-B consolidation |
| RT-10 | P2 | 1 | `src/lib/agents/operator/proposals.ts:446` | **rejected** | markSiblingProposalsStale's account_id predicate is behaviourally redundant (kept for ci:tenant-scope) |
| RT-11 | P2 | 3 | `docs/superpowers/plans/feat-owner-operator-run-b-handoff.md:19` | **fixed** | prevalidate-plan.py reports two stale commits in the handoff; both are fragments of a Codex session UUID |
| RT-12 | P1 | 1 | `src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts:275` | **open** | The abort of the in-flight conversation read on an accepted POST (and on Start over) is unmeasured, and it is load-bearing beyond the epoch guard |
| RT-13 | P1 | 1 | `src/app/(authenticated)/dashboard/operator/TurnBody.tsx:124` | **fixed** | TurnBody's `placed` de-duplication is unverified — a proposal rendered at its segment and appended again kills no test |
| RT-14 | P2 | 1 | `src/lib/agents/operator/reads.ts:469` | **open** | readConnectionStatus's `b.account_id` JOIN predicate is behaviourally redundant (kept for ci:tenant-scope) — the new case's "account-scoped" half cannot fail |
| RT-15 | P1 | 1 | `src/lib/agents/operator/reads.ts:488` | **fixed** | readSummaryEntitlement has no covering vitest test — the entitlement read itself is unmeasured |
| RT-16 | P1 | 2 | `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:167` | **fixed** | Fragile assertion: an exact rendered-string count stands in for "the receipt names the change in plain words" |
| RT-17 | P2 | 4 | `src/app/(authenticated)/dashboard/operator/wording.ts:174` | **fixed** | wording.ts now spells two owner sentences twice, byte for byte, in the module whose own new header says a shared sentence lives here once |

## Findings

### RT-01 — P0 — The runbook and the roadmap record Sentry rule 11 as BUILT in both projects; it exists in neither, and the rule ids are literal placeholders

- **Where:** `docs/runbooks/beta-launch-alerting.md:416`
- **Duty:** 3
- **Disposition:** fixed

The diff rewrites the rule 11 row from "REQUIRED BEFORE OWNER_OPERATOR_ENABLED GOES ON; NOT CONFIGURED BY THIS CHANGE" to "**BUILT 2026-09-12, staging rule `<staging-rule-id>`, production rule `<prod-rule-id>`**" — the row asserts BUILT while carrying unfilled placeholders where the file’s own convention (rule 9: "BUILT 2026-09-04, rule `3946648`") records a real id. docs/roadmap/2026-09-11-owner-operator/README.md:649 states BullMQ retry exhaustion "reaches Sentry ... under runbook **rule 11**, which Run B built in both Sentry projects before the staging flip", and README:697 says the decision was "closed as logs-only with rule 11 built in both Sentry projects". Read back from the Sentry API on 2026-09-12 (org repworth-nv): repworth-staging holds exactly two issue alert rules (3927243 solicitation-unattributed-suppression, 3608329 high-priority default) and repworth-production exactly four (3946648, 3927261, 3925256, 3920752). No rule matching agent-turn-exhausted, and no rule filtering subsystem:worker_job AND queue:agent_turn, exists in either project. The emitting half of the path IS present and correct (worker/job-failure-sink.ts:74 tags {subsystem:"worker_job", queue: queueName}; QUEUE_NAMES.AGENT_TURN === "agent_turn"), so this is the receiving half missing while three documents say it is in place — the intake names this exact alert as a go-live precondition ("First flip of OWNER_OPERATOR_ENABLED anywhere ... the Sentry rule-11 alert must exist before it") and .claude/CLAUDE.md carries the same owed item. Remedy: either build both rules and record their real ids, or revert all three claims to the REQUIRED/NOT CONFIGURED wording. Note that env-vars.md and eservices-variables.md state the precondition correctly, so the three claims above are the only false ones.

ROUND 2 (head 619461e6). FIXED. `git show HEAD:docs/runbooks/beta-launch-alerting.md` row 11 now reads "REQUIRED BEFORE `OWNER_OPERATOR_ENABLED` GOES ON; NOT BUILT AS OF 2026-09-12" and records why the build failed (the org token in the env has no `alerts:write` scope) and what closes it; the placeholder ids are gone. README §14's D6 bullet now says the event fires but "the Sentry → Discord rule is NOT BUILT as of Run B's merge", and §15's review-log line was rewritten to "rule 11 stays NOT BUILT until a scoped Sentry token exists". Sentry re-read at HEAD on 2026-09-12 (read-only `find_alert_rules`, org repworth-nv, kind=issue): repworth-staging still holds exactly two issue rules (3927243, 3608329) and repworth-production exactly four (3946648, 3927261, 3925256, 3920752) — no agent-turn-exhausted rule and no rule filtering subsystem:worker_job AND queue:agent_turn in either project. The documents and the world now agree, and the go-live precondition is stated in all three places.

### RT-02 — P1 — The version-token fast-check property cannot distinguish a versionTokensEqual that ignores businessId

- **Where:** `src/lib/agents/operator/__tests__/version-token.test.ts:83`
- **Duty:** 2
- **Disposition:** fixed

The property is titled "equal version tokens are exactly those with equal businessId and equal updatedAt text" and computes `expected = a.businessId === b.businessId && a.updatedAt === b.updatedAt`, but its generator draws updatedAt from fc.string({minLength:1,maxLength:40}). Two independently generated free strings are never equal in the default 100 runs, so the only pair that separates the real function from one comparing updatedAt alone — different businessId, SAME updatedAt — is never generated. Mutation M06 (drop the businessId comparison) passed the property. The example test at line 22 does cover the case, so production behaviour is pinned; the property is what is weak. Behavioural replacement: draw updatedAt from a small fc.constantFrom of two or three fixed timestamp strings (as businessId already is), so the cross product actually reaches equal-timestamp/different-row.

ROUND 2. FIXED, measured. Mutation M06b re-applied the ORIGINAL round-1 mutation (drop the businessId conjunct from versionTokensEqual) and the property FAILED. The generator now draws updatedAt from fc.constantFrom of three fixed timestamps against two business ids, numRuns is 200, and the case asserts all four (sameBusinessId, sameUpdatedAt) combinations were actually generated — so the discriminating pair is in the distribution by construction, not by luck.

### RT-03 — P1 — markSiblingProposalsStale's `AND status = 'pending'` guard is unverified — deleting it kills no test

- **Where:** `src/lib/agents/operator/proposals.ts:448`
- **Duty:** 1
- **Disposition:** fixed

Mutation M11 removed the pending predicate from the sibling sweep and the live-DB case that exists for this sweep still passed. The fixture creates one pending sibling on the location, one pending proposal on a second location, and the proposal being applied — no ALREADY-TERMINAL sibling on the applied location, which is the only state the predicate decides. Without it, a previously APPLIED proposal on the same location is rewritten to status `stale` with failure_reason `version_mismatch` on the next Apply of that location, overwriting the applied record whose Receipt is still stored beside it — the state the intake’s Receipt invariant exists to prevent. Remedy: add one fixture row to the existing case — a second proposal on the applied location that is already `applied` (or `rejected`) — and assert its status and failure_reason are untouched after the sweep.

ROUND 2. FIXED, measured. Mutation M11b re-applied the ORIGINAL round-1 mutation (delete `AND status = 'pending'` from markSiblingProposalsStale) and the live-DB sibling case FAILED. The fixture now seeds a second proposal on the APPLIED location, drives it to `applied`, and asserts after the sweep that it is still applied with a null failure_reason and a set applied_at.

### RT-04 — P1 — `archived_at IS NULL` in the Apply businesses lock is pinned only by a SQL-text toContain, not by behaviour

- **Where:** `src/lib/agents/operator/apply.ts:127`
- **Duty:** 2
- **Disposition:** fixed

Mutation M04 deleted the predicate and "applyProposal rejects the proposal location_not_found when the location was archived after preparation" still passed: that case primes an EMPTY lock result from the mock, so it proves the !locked branch, not the predicate that produces it. The only thing that catches the deletion is `expect(sqlCalls[1]!.text).toContain('archived_at IS NULL')` at apply.test.ts:174 — a string proxy for a behaviour, which passes for any query that merely mentions the phrase and would fail on an equivalent rewrite. The live-DB suite’s archival case applies FIRST and archives afterwards, so it exercises the repeat-Apply path, never pending-plus-archived. Behavioural replacement: one live-DB case that seeds a pending voice proposal, archives the location with the production helper, then applies — asserting rejected/location_not_found and that businesses is unchanged.

ROUND 2. FIXED, measured. Mutation M04b re-applied the ORIGINAL round-1 mutation (delete `AND archived_at IS NULL` from the Apply businesses lock, apply.ts:127) and the NEW live-DB case `applyProposal rejects a pending proposal whose location was archived after preparation` FAILED. The case seeds a pending proposal, archives the location with a real UPDATE, applies, asserts rejected/location_not_found with no receipt and no voice write (read after un-archiving), and asserts the refusal committed. The SQL-text `toContain` is no longer the only thing pinning the predicate.

### RT-05 — P1 — catalog.ts writerFields is covered for set_tone only; the other three proposables have no test

- **Where:** `src/lib/agents/operator/catalog.ts:174`
- **Duty:** 1
- **Disposition:** fixed

`writerFields` is the new mechanism behind decision D10 ("only this operation’s own fields reach the shared voice writer"). catalog.test.ts never references it, and every Apply fixture — unit and live-DB — uses set_tone. set_products_services, set_avoid_facts and set_highlight_facts therefore have no test at all: swapping avoidFacts for highlightFacts in one closure, or returning {}, would write the wrong voice column or none, and the whole suite stays green. Remedy: a table-driven catalog case asserting, for each of the four proposables, that writerFields(parsed) returns exactly the operation’s own key with the parsed value.

ROUND 2. FIXED, measured, two mutations. M27 swapped set_avoid_facts' writerFields to write `highlightFacts` → FAILED; N14 dropped the writerFields spread from `preview` → FAILED. The new catalog case is table-driven over all four proposables against an independently spelled OWN_FIELDS map (so it cannot pass by asking the implementation what it writes), and it also pins that preview.after is exactly the current state with that bag laid over it — the single-spelling change the fix made in defineProposable.

### RT-06 — P1 — The durable per-turn Requested-capability wiring added to the conversation read has no vitest coverage

- **Where:** `src/lib/agents/operator/reads.ts:268`
- **Duty:** 1
- **Disposition:** fixed

RB-07 added `unsupported` to OwnerConversationTurn and a batched listUnsupportedForTurns. Reverse import search finds no vitest test that seeds an agent_unsupported_requests row and reads it back through getConversationForOwner: reads.integration.test.ts only DELETEs the table in cleanup, and the client test renders the field from a mocked fetch. The batched map’s keying, its account predicate, and the `?? []` default are unmeasured; only e2e/operator.spec.ts (local-only, self-skips in CI) touches the path. Remedy: extend the existing live-DB transcript case to insert one unsupported row on one turn and assert it lands on that turn and no other, and that a turn with none carries [].

ROUND 2. FIXED, measured. Mutation M28 replaced the per-turn lookup with a flatten of every turn's rows and the new live-DB case FAILED. reads.integration now inserts an agent_unsupported_requests row on one turn and one on another account's turn, asserts the first turn carries exactly its own row, the second carries [], and the per-turn read agrees.

### RT-07 — P1 — readConnectionStatus is covered only for the never-connected (null) case

- **Where:** `src/lib/agents/operator/reads.ts:424`
- **Duty:** 1
- **Disposition:** fixed

The only server-side assertion is `expect(summary.connectionStatus).toBeNull()` (reads.integration.test.ts:608). No vitest test seeds a zernio_connections row, so the latest-row rule (ORDER BY created_at DESC LIMIT 1, which is what makes a soft-deleted disconnect read as the current state), the JOIN businesses tenant scoping that stands in for the missing account_id column, the three accepted values and the "value no writer produces" throw are all unexercised. SummaryPanel.test.tsx covers the CLIENT rendering of the three values, which is a different question. Remedy: seed two connection rows for one location (an older `active`, a newer `disconnected`) and assert `disconnected`, plus one row on another account’s location asserting it is not read.

ROUND 2. FIXED, measured. Mutation M29 flipped `ORDER BY zc.created_at DESC` to ASC and the new live-DB case FAILED, so the latest-row rule is behavioural. The invalid-value throw is separately pinned by the new `a zernio status outside the migration 026 vocabulary is refused, not widened` case (N19 widened asConnectionStatus' member list → FAILED); the fix lifted the inline chain into an exported `asConnectionStatus` in schema.ts precisely so that CHECK-unreachable branch can be called directly. The third half the finding named — the JOIN's account scoping — is measured on inventory row R2-66 and is provably redundant; see RT-14.

### RT-08 — P2 — activeLocationId's `archived_at IS NULL` is unverified

- **Where:** `src/lib/agents/operator/reads.ts:407`
- **Duty:** 1
- **Disposition:** fixed

Mutation M15 deleted the predicate and the first-time-owner case still passed — it probes a foreign location (which M14 proved is caught by the account predicate) but never an archived one. Effect if the predicate were lost: an owner could scope the empty-screen summary panel to their own archived location. Read-only and same-tenant, hence P2. Remedy: one extra probe in the same case against an archived location of the same account, asserting null.

ROUND 2. FIXED, measured. Mutation M30 re-applied the ORIGINAL round-1 mutation (delete `AND archived_at IS NULL` from activeLocationId, reads.ts:443) and the new `an unusable ?locationId= answers location_not_found in both branches` case FAILED. The fix folded the archived probe into a live-DB case that archives a real second location and asserts both the no-conversation and the conversation-exists branches answer location_not_found.

### RT-09 — P2 — A third impersonation-presence spelling survives the H1-B consolidation

- **Where:** `src/app/(authenticated)/settings/auto-approval/page.tsx:16`
- **Duty:** 4
- **Disposition:** rejected

Duty-4 sibling search. Patterns searched: `rw_impersonation`, `IMPERSONATION_COOKIE_NAME`, `hasImpersonationCookie` across src/ and worker/, excluding __tests__ and e2e/. Scope: every match, 26 hits. Result: the two byte-identical private copies the diff folded into the shared helper are gone, and all four operator/settings ROUTES now call it. One presence check remains hand-rolled — `Boolean(cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value)` on the auto-approval server PAGE. It is not a defect: the shared helper takes a NextRequest and a server component has only `cookies()`, so the helper does not fit; recorded so the next consolidation does not report it as newly discovered. The remaining hits (admin/layout.tsx, admin/impersonate/[sessionId]/view/page.tsx, the impersonation start/end routes) read or set the raw value for verification, not as a presence gate, and are correctly untouched. Second pattern searched: nav arms below a `/dashboard` catch-all — `startsWith('/dashboard/')` across src/components and src/lib; two hits, active-nav.ts (the module the diff fixes) and protected-routes.ts (a flat allowlist with no fall-through order). ZERO siblings for that pattern.

ROOT VERDICT (docs/reviews/feat-owner-operator-run-b/review-round-1.md, Red team table, verbatim): "REJECT — the finding itself says it is not a defect: the page has `cookies()`, not a `NextRequest`, so the helper cannot fit. Recorded". Re-resolved at HEAD: src/app/(authenticated)/settings/auto-approval/page.tsx:16 still reads `Boolean(cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value)`; the shared helper's signature is a NextRequest, which a server component has no access to. Unchanged by the fix wave and correctly so.

### RT-10 — P2 — markSiblingProposalsStale's account_id predicate is behaviourally redundant (kept for ci:tenant-scope)

- **Where:** `src/lib/agents/operator/proposals.ts:446`
- **Duty:** 1
- **Disposition:** rejected

Mutation M13 removed the predicate and the live-DB sibling case passed. This is a provable non-defect rather than a coverage gap: businesses.id is globally unique, and every agent_proposals row has its account_id and location_id written together in buildProposalRows from one already-validated turn, so `location_id = L` already selects rows of exactly one account and adding `account_id = A` removes none and adds none. The predicate must stay — ci:tenant-scope requires it and it is the guard if a writer ever diverges — but no test can be written that would fail without it while the writer discipline holds. Recorded so it is not re-reported as an uncovered guard next round. No action.

ROOT VERDICT (docs/reviews/feat-owner-operator-run-b/review-round-1.md, Red team table, verbatim): "REJECT — kept on purpose: `ci:tenant-scope` and invariant #9 require the predicate on every statement over a tenant table; redundancy is the point". Re-resolved at HEAD: src/lib/agents/operator/proposals.ts:479 still carries `WHERE account_id = ${input.accountId}::uuid` on the sibling sweep, unchanged by the fix wave. Round 2 found the same shape a second time on readConnectionStatus — recorded as RT-14 rather than re-opening this one.

### RT-11 — P2 — prevalidate-plan.py reports two stale commits in the handoff; both are fragments of a Codex session UUID

- **Where:** `docs/superpowers/plans/feat-owner-operator-run-b-handoff.md:19`
- **Duty:** 3
- **Disposition:** fixed

Duty 3 re-resolution. prevalidate-plan.py PASSES on the plan (97 citations, 16 fixtures, 1 commit), the deviations file (6 citations), the evidence file, the roadmap README and the runbook. It reports 2 issues on the handoff: `01a0960d` and `e1d2f82c8a0c` "do not resolve to a commit in this repo". Both are hex runs inside the Codex session id `01a0960d-4387-7f72-be06-e1d2f82c8a0c`, not commit references — a tool false positive, not a false claim. Recorded rather than silently dropped so the next pass does not re-investigate. No action.

ROUND 2. STILL OPEN — the fix does not clear the tool. The handoff now labels the id (`Codex thread id, not a commit: \u0060thread 01a0960d-4387-7f72-be06-e1d2f82c8a0c\u0060`), but `python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/superpowers/plans/feat-owner-operator-run-b-handoff.md --repo .` re-run at HEAD still reports the SAME two: `COMMITS: 3 checked, 2 stale` — `01a0960d` and `e1d2f82c8a0c`. Root cause, read out of the script: check_commits only considers lines matching COMMIT_CONTEXT_RE = `commit|head|sha|rev|merge-base|branch` (prevalidate-plan.py:62,178), and this line contains the substring `rev` inside "revised" (twice) and "round 3 resumed REVISE", so the line is scanned for hex runs no matter what label the id carries. A "thread" word cannot suppress it. Still a tool false positive and still not a false claim, so the severity stays P2 and nothing is owed to the reader — but the stated remedy did not work, and the honest options are to split the session id onto its own line with no `rev`/`head`/`branch` token, or to accept the two known false positives in writing.

ROUND 3 (head ef9b3a7c). FIXED, re-derived. `python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py docs/superpowers/plans/feat-owner-operator-run-b-handoff.md --repo "$(git rev-parse --show-toplevel)"` now reports `CITATIONS: 0 checked, 0 unresolved / FIXTURES: 0 checked, 0 gitignored / COMMITS: 1 checked, 0 stale / PREVALIDATE: PASS` (exit 0). The same script run against the PRE-FIX file (`git show 77d121f48:...handoff.md`, same --repo) reports `COMMITS: 3 checked, 2 stale` with `01a0960d` and `e1d2f82c8a0c` — so the two false positives are gone and nothing else moved: citations stayed 0 and fixtures stayed 0 across the fix, i.e. no citation was dropped to buy the pass. The fix took the option round 2 named: the session id was lifted out of the prose sentence onto a line of its own (`- Codex thread: 01a0960d-4387-7f72-be06-e1d2f82c8a0c`) that carries no `commit|head|sha|rev|merge-base|branch` token, so COMMIT_CONTEXT_RE (prevalidate-plan.py:62,178) never selects the line for hex scanning; the explanatory line below it carries the git-object words but no hex run.

### RT-12 — P1 — The abort of the in-flight conversation read on an accepted POST (and on Start over) is unmeasured, and it is load-bearing beyond the epoch guard

- **Where:** `src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts:275`
- **Duty:** 1
- **Disposition:** open

**Arbiter confirmation.** ROUND 3. Both halves of N08 re-applied through the runner and BOTH SURVIVED (N08a adoptAcceptedTurn:275, N08b startFresh:315), against a green HEAD baseline of the new case that reads `signal.aborted` off the real AbortSignal. The survivors are on branches the case DOES execute, so neither is an unexecuted-branch survivor. Neither is recorded `equivalent`: that disposition requires a PROOF that the mutant preserves behaviour, and no such proof exists. The effect cleanup `return () => controller.abort();` (useOperatorConversation.ts:261) does abort the same controller on the next commit — both commands change that effect's dependencies — which is why the mutants survive at this oracle's observation point (after React flushes passive effects). But the explicit abort is SYNCHRONOUS inside the command and the cleanup abort is DEFERRED to the commit, and the four early arms of the read's result handling (`disabled`, `aborted`, `unreachable`, `error`) run BEFORE the epoch guard at line 217 — so the deferral is a real semantic difference inside a real window. "I cannot see how a test would catch this" is plausible, not proven; per the skill that stays `inconclusive` (class oracle) and it blocks. Recorded as measured; no kill was invented. NOTE: the mechanism above is a CODE READ, not a measurement — the two-mutations-per-test cap was spent on N08a and N08b, so no third mutation removed the cleanup to prove which path supplies the abort.

The client split moved the conversation read into useOperatorConversation. Two of its commands abort the in-flight read — adoptAcceptedTurn ("the submission wins") and startFresh. Mutation N08 removed the adoptAcceptedTurn abort: the single-test run against `a delayed conversation response never replaces a newly submitted turn` PASSED, and a whole-file probe of OperatorClient.test.tsx (13 tests) also passed, so NOTHING in the client suite observes it. It matters because the four early arms of the read's result handling — `disabled` (onDisabled), `aborted`, `unreachable` (onNotice) and `error` (setLocationUnavailable + onNotice, or onNotice) — all run BEFORE the `issuedAt !== loadEpochRef.current` staleness guard at line 217. Without the abort, a read the owner has already superseded can still disable the screen, raise a notice, or flip locationUnavailable on the basis of an answer about the world before their submission. The code at HEAD is correct; the measurement is missing. Behavioural replacement: extend the existing race case's conversation mock to reject on `signal.abort` and assert the abort fired, or add a case where the superseded read answers 404 location_not_found after an accepted POST and assert no notice is shown and polling continues.

ROUND 3 (head ef9b3a7c). STILL OPEN, and the fixer's disclosure is confirmed rather than contradicted. The fix DID add the behavioural case the finding asked for — `a successful submission aborts the conversation read that was already in flight` (OperatorClient.test.tsx:733) keeps each conversation read's `AbortSignal`, asserts `onMount.aborted` flips to true after an accepted POST, asserts the late answer changes neither the turn nor the URL, and covers the `startFresh` half as well — and it passes at HEAD. But it does not KILL either mutant: N08a (delete the abort in `adoptAcceptedTurn`) PASSED and N08b (delete it in `startFresh`) PASSED, because React's effect cleanup aborts the same controller on the next commit and the assertions sit after that flush. The code at HEAD remains correct and the case is a genuine improvement on round 2's oracle; what is still unmeasured is the only thing the explicit abort buys — abandoning the request SYNCHRONOUSLY, before the commit, so a superseded read cannot run its four pre-epoch arms in the interval. An oracle that could kill these mutants must place the read's answer inside that window (for example resolve the held conversation promise from within the same task as the accepted POST, before advancing timers, and assert no notice / no `locationUnavailable` / no `onDisabled`), or assert the abort synchronously at the moment the command runs rather than after `waitFor`. Severity stays P1 and the disposition stays `open`: it is a measurement gap, not a defect, and it is the root's or the owner's call to adjudicate — a verifier does not close it and did not invent a kill to do so.

### RT-13 — P1 — TurnBody's `placed` de-duplication is unverified — a proposal rendered at its segment and appended again kills no test

- **Where:** `src/app/(authenticated)/dashboard/operator/TurnBody.tsx:124`
- **Duty:** 1
- **Disposition:** fixed

**Arbiter confirmation.** The fixture of `operator renders every stored segment kind in order` has exactly one proposal referenced by a `proposal` segment, so the mutated line IS executed with a non-empty filter input. The mutant renders that card twice, which is a real rendered difference, so it is not provably equivalent. It survives because the case's ordering assertions use findIndex (first occurrence) and no assertion counts cards — an ORACLE claim.

The client split extracted turn rendering into a new TurnBody module. Its contract is two-sided: a proposal referenced by a `proposal` segment is rendered AT that position, and any proposal no segment references is appended afterwards rather than being lost (RB-06). Only the first half is pinned. Mutation N16 replaced `turn.proposals.filter((proposal) => !placed.has(proposal.id)).map(card)` with `turn.proposals.map(card)` — every referenced card renders a second time at the bottom of the turn — and the single test PASSED; a whole-file probe of OperatorClient.test.tsx + ProposalCard.test.tsx (17 tests) also passed. An owner would see the same Apply card twice, with two live buttons for one proposal. Behavioural replacement: in that same case assert `screen.getAllByRole('button', { name: APPLY })` has length 1 (or that the describer appears exactly once inside the turn's article), and add a proposal with no referencing segment to pin the append half in the same fixture.

ROUND 3 (head ef9b3a7c). FIXED, measured. N16 re-applied through the runner (`turn.proposals.filter((proposal) => !placed.has(proposal.id)).map(card)` -> `turn.proposals.map(card)`, TurnBody.tsx:124) against a green HEAD baseline, and the extended case `operator renders every stored segment kind in order` FAILED at OperatorClient.test.tsx:577 with `expected [ <section ...>, ...(1) ] to have a length of 1 but got 2`. The fix implemented both halves the finding asked for: a second proposal that no segment references (pinning the RB-06 append half, asserted to land after every segment) and counting assertions that findIndex could not make — one `getAllByRole('region', { name: describe })` per card plus `getAllByRole('button', { name: APPLY })).toHaveLength(2)`.

### RT-14 — P2 — readConnectionStatus's `b.account_id` JOIN predicate is behaviourally redundant (kept for ci:tenant-scope) — the new case's "account-scoped" half cannot fail

- **Where:** `src/lib/agents/operator/reads.ts:469`
- **Duty:** 1
- **Disposition:** open

Mutation M29b deleted `AND b.account_id = ${input.accountId}::uuid` and the new `the summary reports the latest zernio connection for the location, account-scoped` case PASSED. This is a PROVABLE non-defect, the readConnectionStatus twin of round 1's RT-10: the statement already filters `zc.business_id = ${input.locationId}`, businesses.id is globally unique, and readSummary is reachable only with a locationId that is either the latest turn's (a turn of this account's own conversation) or the output of activeLocationId(accountId, ...), which enforces membership and archival. No row can be admitted by dropping the predicate, so the third seeded row (a connection on another account's location) is decided by its business_id, not by the account scoping. The predicate MUST stay — ci:tenant-scope and invariant #9 require it on every statement over a tenant table, and it is the guard if a caller ever hands in an unvalidated id. No action; recorded so the next pass does not re-derive it, and so the case's title is read as the tenant INTENT rather than as a measured claim.

ROUND 3. NOT RE-MEASURED — deliberately. The owner's AUTH-2 scopes round 3 to the six round-2 findings RT-11, RT-12, RT-13, RT-15, RT-16 and RT-17; RT-14 is not among them and its fix hunk was not touched by commit be03c88c2. Disposition unchanged (`open`, P2, no action), carried forward verbatim rather than silently re-dispositioned.

### RT-15 — P1 — readSummaryEntitlement has no covering vitest test — the entitlement read itself is unmeasured

- **Where:** `src/lib/agents/operator/reads.ts:488`
- **Duty:** 1
- **Disposition:** fixed

The fix added an exported read that answers the ONE entitlement question the conversation route asks. Reverse import search finds exactly one importer, src/app/api/operator/conversation/route.ts:10, and the route's own suite replaces it with a mock (conversation-route.test.ts:22), so its statement is executed by no vitest test: not the column (`subscription_status`), not the table (`accounts`), not the `WHERE id = ${accountId}::uuid` predicate, not the `row?.subscription_status ?? null` default. reads.integration.test.ts, the live-DB suite for this module, never calls it. The route's DECISION is well pinned (a wrong-status account gets summary null, past_due still reads, and the call is asserted to receive the owner's accountId), so the risk is confined to the read returning the wrong account's status or the wrong column — but the gate in front of customer KPI data is exactly the place that should not be inferred. Remedy: one live-DB case in reads.integration that seeds two accounts with different subscription_status values and asserts each id reads back its own.

ROUND 3 (head ef9b3a7c). FIXED, measured against the live database. The fix added `readSummaryEntitlement returns the account's subscription status and null for an unknown account` to reads.integration.test.ts:819, run with `--project integration` against the validated localhost test DB. Green baseline, then the predicate mutation — drop `WHERE id = ${accountId}::uuid` from reads.ts:495, leaving `SELECT subscription_status FROM accounts` -> FAILED at reads.integration.test.ts:848, `expected 'past_due' to be 'cancelled'`: the second account read back the first account's status, exactly the wrong-account risk the finding named. The case seeds two accounts with different statuses, re-reads one after changing it, and asserts an unknown uuid answers `null`, so the column, the table, the predicate and the `?? null` default are all executed.

### RT-16 — P1 — Fragile assertion: an exact rendered-string count stands in for "the receipt names the change in plain words"

- **Where:** `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx:167`
- **Duty:** 2
- **Disposition:** fixed

`expect(screen.getAllByText(DESCRIBE)).toHaveLength(2)` is an exact string count on rendered output — the skill's named fragile class. The behavioural claim is that the Receipt's "What" line prints the describer rather than the catalog id (the fix replaced `screen.getByText('set_tone')` with it), but the oracle is a global document-wide count of two: it breaks on any layout change that repeats the sentence (a visually-hidden copy, an aria-label, a heading that gains a tooltip) and it passes if the heading renders it twice while the receipt renders it not at all. Behavioural replacement: scope the query to the receipt region — `within(screen.getByText('Applied at').closest('section')!).getByText(DESCRIBE)` or an equivalent region query — and keep the paired `expect(screen.queryByText('set_tone')).not.toBeInTheDocument()`, whose claim genuinely IS absence.

ROUND 3 (head ef9b3a7c). FIXED, measured. The exact document-wide count is gone: ProposalCard.test.tsx:172-173 now reads `const facts = screen.getByText('Applied at').closest('dl')!;` then `expect(within(facts).getByText('Change').nextElementSibling!.textContent).toBe(DESCRIBE)`. The scoping is real, not cosmetic — ReceiptView.tsx:67-89 puts `Change` and `Applied at` in the same `op-kv op-facts` `dl`, and the assertion reads that row's own `dd`. Green baseline, then the behavioural mutation the finding implies — ReceiptView.tsx:69 `{describe}` -> `{receipt.operation}`, i.e. print the catalog id instead of the describer -> FAILED at ProposalCard.test.tsx:173, `expected 'set_tone' to be 'Set the reply tone to "warm and brief"'`. The kill lands on the NEW scoped assertion, and the paired `expect(screen.queryByText('set_tone')).not.toBeInTheDocument()` was correctly kept as the genuine absence claim.

### RT-17 — P2 — wording.ts now spells two owner sentences twice, byte for byte, in the module whose own new header says a shared sentence lives here once

- **Where:** `src/app/(authenticated)/dashboard/operator/wording.ts:174`
- **Duty:** 4
- **Disposition:** fixed

Duty-4 sibling search inside the fix hunk. The fix added `unauthorized` and `account_offboarding` to ROUTE_ERROR_WORDING (lines 174-175) with strings identical to PROPOSAL_FAILURE_WORDING's own entries (lines 145-146): 'Your account can no longer make this change. Nothing was applied.' and 'This account is closing, so changes are not accepted. Nothing was applied.'. The file already has the in-module idiom for exactly this — PROPOSAL_STALE and NOT_AVAILABLE are named constants both maps reference — and the fix's own new header says what lives here is "what more than one renderer has to agree on". Two renderers now have to agree on these two sentences and nothing makes them. Mutation evidence that the duplication is real and load-bearing: N10, which deleted BOTH copies of `unauthorized`, and N10b, which deleted only the ROUTE_ERROR_WORDING copy, both killed the same test. Scope searched: every key of PROPOSAL_FAILURE_WORDING against every key of ROUTE_ERROR_WORDING and TURN_FAILURE_WORDING. Result: three duplicate sentences — `unauthorized` and `account_offboarding` (added by this fix) and `contract_changed` (pre-existing, lines 144 and 177, out of scope for round 2 and named only so the next pass does not report it as new). Remedy: hoist the two new ones to named constants the way PROPOSAL_STALE already is. No owner-visible defect today.

ROUND 3 (head ef9b3a7c). FIXED — the duplication is gone. wording.ts now declares `ACTOR_UNAUTHORIZED` (line 149) and `ACCOUNT_OFFBOARDING` (line 151) as named constants with a header saying why, and BOTH maps reference them instead of respelling the sentences: `PROPOSAL_FAILURE_WORDING` at 157-158 and `ROUTE_ERROR_WORDING` at 188-189. That is the in-module idiom `PROPOSAL_STALE` already used, which is what the finding asked for, and the two sentences now have exactly one spelling each. Mutation, for the record: N10b re-applied (delete line 188, `unauthorized: ACTOR_UNAUTHORIZED,`, from ROUTE_ERROR_WORDING only) -> the case `a refusal the server answered offers no retry and an unusable location says so` FAILED, so the entry is still measured. Stated honestly: that case asserts against `ROUTE_ERROR_WORDING.unauthorized` read from the module, so the kill pins the KEY's presence rather than the sentence's text — mutating the constant's VALUE would move expectation and actual together and could not fail. The single-spelling claim therefore rests on the code read above, not on a mutation. The pre-existing third duplicate named in round 2, `contract_changed` (wording.ts:144 and 177), is untouched by the fix and remains out of scope. P2, no owner-visible defect at any point.

## Red-team findings rejected

The rejection protocol: a one-line verdict plus `file:line` evidence here, mirrored in
`findings.json`, and listed in the PR description.

| id | sev | `file:line` at HEAD | root's one-line verdict (verbatim from `docs/reviews/feat-owner-operator-run-b/review-round-1.md`) |
|---|---|---|---|
| RT-09 | P2 | `src/app/(authenticated)/settings/auto-approval/page.tsx:16` | REJECT — the finding itself says it is not a defect: the page has `cookies()`, not a `NextRequest`, so the helper cannot fit. Recorded |
| RT-10 | P2 | `src/lib/agents/operator/proposals.ts:479` | REJECT — kept on purpose: `ci:tenant-scope` and invariant #9 require the predicate on every statement over a tenant table; redundancy is the point |

Both were re-resolved against HEAD `619461e60` in this pass and both hold: the
auto-approval page still hand-rolls the presence check because a server component has
`cookies()` and not a `NextRequest`, and the sibling sweep still carries its
`account_id` predicate. Round 2 met the same redundancy shape a second time, on
`readConnectionStatus`, and recorded it as RT-14 rather than re-opening RT-10.

## Environment

```
mutation-runner.mjs round-start          # round 2 open, 30 runs available
mutation-runner.mjs env          --tmp-home <mktemp -d> --test-db <localhost:5499 test db>
mutation-runner.mjs dotenv-swap  --test-db <same>
```

Allowlist only: `PATH`, a temporary `HOME`, `TMPDIR`, `NODE_ENV=test`, `CI=true`,
`MOCK_EXTERNAL_APIS=true`, and `TEST_DATABASE_POOL_URL`/`DATABASE_POOL_URL` after the
runner validated the URL as localhost (docker container `repworth-testdb`,
`localhost:5499`, database `test_ws4`). `.env.local` was swapped for a scrubbed copy
for the whole mutation phase and is still swapped — the root's `finalize` restores it.
`watchers` reported none serving this worktree; the tracked tree was clean at
`619461e60418986e095e1018d12ed631a97349a3` before the first mutation and is clean
again now (`git status --porcelain` empty on every path).

**Baselines, both fully green at HEAD:**

- the 8 non-live-DB changed test files in one launch → **43 passed, 0 failed**
- the 2 live-DB suites (`--project integration`) in one launch → **20 passed, 0 failed, 0 skipped**

## Deviations from the skill, disclosed

- **D1 — file-level green baselines** (as in round 1). The runner counts every `run`
  launch against the 30-per-round cap, so one baseline launch per candidate was
  impossible. Baselines were taken as two file-level launches; every mutant re-run was
  a single-test launch verified with `assert-one-test`, except D2 below.
- **D2 — two whole-file survivor probes.** Runs 25 and 26 re-ran an entire test file
  (not one test) under a surviving mutant, to answer "does ANY test in the client
  surface catch this?" rather than "does this one test". `assert-one-test` was
  therefore not applied to them. They only strengthened two `inconclusive` rows
  (R2-51, R2-64); no kill was drawn from either.
- **D3 — per-mutation restore** (as in round 1). `finalize` belongs to the invoking
  root, so each mutation was reverted by rewriting the pristine bytes captured before
  `mutate`, then verified with `git status --porcelain -- <path>` (empty every time).
  All 28 journal entries' working blobs now equal their recorded `originalOid`, which
  is the state `finalize` accepts and closes.
- **D4 — three mutations on two tests.** Inventory rows R2-04, R2-32 and R2-50 each
  received two mutations (within the cap); no row exceeded two. Round 1's D3 overrun
  was not repeated.
- **D5 — one broader-than-intended mutant.** N18 (row R2-34) was applied with a `sed`
  that matched four identically indented `locationId: input.locationId,` lines inside
  `readSummary` rather than the single return field. It is still one semantic change
  and the kill is genuine; recorded so the evidence is not read as narrower than it is.

## Duty 2 — fragile assertions (changed tests only)

- **RT-16** (P1): `expect(screen.getAllByText(DESCRIBE)).toHaveLength(2)` — an exact
  string count on rendered output standing in for "the receipt names the change in
  plain words". Behavioural replacement in the finding.
- Reviewed and NOT findings:
  - `expect(JSON.stringify(body)).not.toContain('"pendingCount"')`
    (conversation-route.test.ts:548) LOOKS like an absence proxy, but it is a
    supplementary leak check: the primary oracle `expect(body.summary).toBeNull()`
    is asserted two lines above it, and the case additionally pins `past_due` reads
    and `cancelled` does not.
  - `expect(screen.queryByText('Applied')).not.toBeInTheDocument()` and
    `expect(screen.queryByText('set_tone')).not.toBeInTheDocument()` — here the claim
    genuinely IS absence (the bare participle and the catalog id must be gone), so the
    assertion shape matches the contract.
  - `expect(proposables.length).toBe(4)` (catalog.test.ts) — the count IS the claim
    (four proposable operations), and it is paired with a per-operation sweep.
  - `expect([...seen].sort()).toEqual([...])` (version-token.test.ts) — a generator
    COVERAGE assertion, which is exactly the behavioural replacement RT-02 asked for,
    not an incidental-structure assertion.
- No absence-of-tag proxy and no order assertion without an ordering contract was
  found in the fix hunks' tests.

## Duty 3 — docs vs reality (at HEAD `619461e60`)

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py <doc> --repo .`
was run against every doc the fix delta changed:

| doc | result |
|---|---|
| `docs/runbooks/beta-launch-alerting.md` | PASS — and row 11's BUILT claim is gone (**RT-01 fixed**) |
| `docs/roadmap/2026-09-11-owner-operator/README.md` | PASS — §14 D6 and §15 both corrected to NOT BUILT (**RT-01 fixed**) |
| `docs/superpowers/plans/feat-owner-operator-run-b-handoff.md` | 2 "stale commits" — the SAME two as round 1, unchanged (**RT-11 still open**) |
| `docs/superpowers/plans/feat-owner-operator-run-b-deviations.md` | PASS — 6 citations |
| `docs/directory/app-authenticated.md` | PASS |
| `docs/reviews/feat-owner-operator-run-b/blast-radius.md` | PASS — 24 fixtures |
| `docs/reviews/feat-owner-operator-run-b/review-round-1.md` | 3 "stale commits" — all three (`065351da`, `01a0968b`, `532becd3ffe3`) are hex runs inside Codex session ids on lines 3 and 5; same false-positive class as RT-11, no false claim |
| `docs/reviews/feat-owner-operator-run-b/codex-adversarial.md` | 2 "stale commits" (fragments of the session id on line 3) + 1 partial-path miss (`connect/page.tsx:54`); no false claim |
| `docs/reviews/feat-owner-operator-run-b/spec-correctness.md` | 4 issues, all resolver artefacts — see below |
| `docs/reviews/feat-owner-operator-run-b/standards-maintainability.md` | 12 issues, all resolver artefacts — see below |

**The two review-axis reports are NOT findings, and the reason is on their own first
lines.** Both pin `Head reviewed: dba7af671f8dcba589dc482e0a3ba86d8324fb07` and state
the read method as `git show dba7af671:<path>`, so their `path:line` citations are
declared against that SHA, not against HEAD. The prevalidator resolves every citation
against HEAD, which is why `OperatorClient.tsx:523 / :662 / :708` report "only 472
lines" — the client split shrank that file in the very commits those reports caused.
The remaining misses (`decline/route.ts:23`, `turns/route.ts:35`, `apply/route.ts:6`,
`admin/business-detail/queries.ts:144`, `dashboard/service.ts:367`,
`connect/page.tsx:54`) are partial paths the longest-match resolver cannot bind: the
real files carry a dynamic segment (`src/app/api/operator/proposals/[id]/decline/route.ts`)
or live under a differently spelled root. Hand-checked: every one of those files exists
at HEAD. A stale line number in a SHA-pinned review artefact is not a stale claim.

Hand-checked beyond the script, at HEAD:

- `docs/runbooks/beta-launch-alerting.md:416` row 11 vs the live Sentry configuration —
  read-only `find_alert_rules` (org `repworth-nv`, `kind=issue`) on both projects. The
  runbook says NOT BUILT; Sentry has no such rule. They agree. See RT-01.
- `docs/roadmap/…/README.md` §14 D6 and §15's review-log entry — both now state the
  precondition in the same terms as `env-vars.md` and `eservices-variables.md`, which
  were correct all along.

## Duty 4 — missed sibling cases

Three searches, all inside the fix hunks. Patterns, scope and exclusions:

1. **A fourth hand-built Version token literal.** Pattern: `computeVoiceVersionToken`
   across `src/` and `worker/`, excluding `__tests__`. Result: the helper is declared
   once (`version-token.ts:41`) and called from exactly three places —
   `proposals.ts:99` (the site the fix converted from a literal), `apply.ts:223` and
   `apply.ts:325`. **ZERO remaining `{ businessId, updatedAt }` literals** in
   production. The fix's claim of "never a fourth literal" holds.
2. **An `agent_proposals` read that skipped the shared projection.** Pattern:
   `FROM agent_proposals` across `src/` and `worker/`, excluding `__tests__`. Seven
   hits: the five reads in `proposals.ts` (278, 303, 322, 423, 442) ALL compose
   `proposalColumns`, and the two others are not projections
   (`purge-verification.ts:650` counts, `purge-stages.ts:470` deletes). **ZERO
   siblings.** Mutation N01 proves the fragment is load-bearing.
3. **Duplicate owner sentences inside `wording.ts`.** Pattern: every key of
   `PROPOSAL_FAILURE_WORDING` against every key of `ROUTE_ERROR_WORDING` and
   `TURN_FAILURE_WORDING`. Three byte-identical duplicates: `unauthorized` and
   `account_offboarding` (both ADDED by this fix) and `contract_changed`
   (pre-existing). Recorded as **RT-17**.

One further search recorded as a sound zero: `/dashboard/connect` link construction
across `src/`. Three sibling links pass a location — `ReviewQrClient.tsx:36` and
`LocationsPanel.tsx:443` (both `encodeURIComponent`) and the new
`SummaryPanel.tsx:62` (raw interpolation) — and three deliberately pass none
(`DraftConflictPanel.tsx:80`, `ConnectGoogleBanner.tsx:46`, the wizard's no-id arm).
The raw interpolation is NOT a finding: the value is a `businesses.id` uuid read from
Postgres and typed `string` off the server DTO, so there is no character to encode.
Recorded so the next consolidation does not report it as newly discovered.

## Duty 5 — operational completeness

The fix delta adds no new operator-actionable terminal or swallowed failure path. The
one path round 1 examined — BullMQ retry exhaustion on the `agent_turn` queue — is
unchanged on the EMITTING side (`worker/job-failure-sink.ts:74`, untouched by the
delta); what changed is the documentation of the receiving side, which is RT-01 and is
now honest. Re-running the static six-facet comparison at HEAD:

| facet | runbook row 11 | emitted / configured | verdict |
|---|---|---|---|
| signal identity | `subsystem` = `worker_job` AND `queue` = `agent_turn` | `worker/job-failure-sink.ts:74`; `QUEUE_NAMES.AGENT_TURN === 'agent_turn'` | match |
| filter | the same two tags | — | match |
| level | `error` (the `captureException` default) | `Sentry.captureException` | match |
| grouping title | not specified | default | n/a |
| threshold / cadence | "every event" | — | no rule to compare against |
| destination action | Discord | — | no rule exists in either project, **and the row now says so** |

The two new swallowed-ish paths the fix introduces are not operator-actionable and
correctly carry no rule row: the entitlement gate answers 200 with `summary: null`
(a product decision the owner sees as a missing panel, identical to `/api/dashboard`'s
own refusal), and `location_not_found` answers the owner with a sentence. Both are
handled inside the request and neither is a terminal the operator must act on.

## Inventory

69 candidates, carried forward from round 2 and renumbered `R3-` at this
head. Direction A is every Vitest case in the test files the fix deltas touched (a changed
fixture or helper can neutralise a case whose body did not move). Direction B adds the
production hunks whose reverse import search found no covering vitest test, plus predicates
measured separately from their own test's row. Playwright is excluded by the skill. Rows
this round re-executed carry a ROUND 3 marker in their evidence; the 42 `skipped-budget`
rows were not re-opened, because the owner's authorization scopes round 3 to the six
findings above.

| id | file | test / hunk | outcome | evidence |
|---|---|---|---|---|
| R3-01 | `src/lib/agents/operator/__tests__/version-token.test.ts` | invariants: equal version tokens are exactly those with equal businessId and equal updatedAt text | **killed** | RT-02 re-verification. M06b re-applied the ORIGINAL round-1 mutation (drop the `a.businessId === b.businessId` conjunct from versionTokensEqual) against the rewritten generator → FAILED. The fix draws updatedAt from fc.constantFrom of three fixed timestamps, raises numRuns to 200, and asserts all four combinations of (same/different businessId) x (same/different updatedAt) were actually generated, so the discriminating pair now exists in the distribution. |
| R3-02 | `src/lib/agents/operator/__tests__/version-token.test.ts` | version token equality is text-to-text on both fields and a one-microsecond difference is not equal | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-03 | `src/lib/agents/operator/__tests__/version-token.test.ts` | version token parser rejects a stored token missing businessId or updatedAt | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-04 | `src/lib/agents/operator/__tests__/catalog.test.ts` | every proposable writes exactly the field its operation names, and its preview is that write laid over the current state | **killed** | RT-05 re-verification, two mutations, both killed. M27 swapped set_avoid_facts' writerFields to write `highlightFacts` → FAILED on the Object.keys(fields) equality for that operation. N14 dropped the writerFields spread from `preview` (`after: { ...voice }`) → FAILED on `preview.after[field] !== VOICE[field]`. The new case is table-driven over all four proposables with an independently spelled OWN_FIELDS map, so it no longer covers set_tone alone. |
| R3-05 | `src/lib/agents/operator/__tests__/catalog.test.ts` | catalog separates read, proposable, and capture kinds by type and exposes only model-visible operations to the prompt | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-06 | `src/lib/agents/operator/__tests__/catalog.test.ts` | invariants: every catalog operation declares a contract version and a describer | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-07 | `src/lib/agents/operator/__tests__/proposals.test.ts` | proposal view carries receipt, prepared version token, applied_at and failure_reason | **killed** | N05 removed `.default(null)` from ReceiptSchema.actorName → the fifteen-key legacy Receipt fixture stopped parsing → FAILED. This is the backward-compatibility half of the new sixteenth Receipt field. |
| R3-08 | `src/lib/agents/operator/__tests__/proposals.test.ts` | insertProposals writes one row per proposal with contract_version and prepared_version_token | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-09 | `src/lib/agents/operator/__tests__/proposals.test.ts` | declineProposal sets status rejected and decided_by_user_id with no reason and is idempotent | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-10 | `src/lib/agents/operator/__tests__/proposals.test.ts` | declineProposal answers proposal_not_pending for an applied proposal | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-11 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal writes the actor's name on the receipt, falling back to the email | **killed** | N04 dropped the `?? actor.email` arm of the Receipt's actorName fallback → FAILED. The new `SELECT id, name, email` rides the gate's own actor read rather than a second query. |
| R3-12 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal locks the businesses row before the proposal row and writes only the operation's own fields through updateVoiceConfig | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-13 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal on an applied proposal returns the stored receipt and executes nothing | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-14 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal marks the proposal stale without mutation when the current token differs from the prepared token | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-15 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal marks the proposal stale without mutation when the client's expected token differs from the prepared token | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-16 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal rejects a proposal whose contract_version is not the catalog's with contract_changed before any lock | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-17 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal returns proposal_not_found for a proposal of another account | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-18 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal answers proposal_not_pending for a stale, rejected, superseded or failed proposal | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-19 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal rejects the proposal unauthorized when the actor is no longer a writable owner | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-20 | `src/lib/agents/operator/__tests__/apply.test.ts` | applyProposal rejects the proposal location_not_found when the location was archived after preparation | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-21 | `src/lib/agents/operator/__tests__/apply.test.ts` | invariants: from any non-pending status applyProposal never writes businesses | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-22 | `src/lib/agents/operator/__tests__/apply.integration.test.ts` | applyProposal marks sibling pending proposals on the same location stale in the same transaction and leaves other locations alone | **killed** | RT-03 re-verification. M11b re-applied the ORIGINAL round-1 mutation (delete `AND status = ${PROPOSAL_STATUS.PENDING}` from markSiblingProposalsStale) → FAILED. The fix seeds a second proposal on the SAME location, drives it to `applied`, and asserts after the sweep that its status is still applied, its failure_reason null and its applied_at set — the terminal-sibling state the predicate exists to protect. |
| R3-23 | `src/lib/agents/operator/__tests__/apply.integration.test.ts` | applyProposal rejects a pending proposal whose location was archived after preparation | **killed** | RT-04 re-verification. M04b re-applied the ORIGINAL round-1 mutation (delete `AND archived_at IS NULL` from the Apply businesses lock, apply.ts:127) → FAILED. The new live-DB case seeds a PENDING proposal, archives the location with a real UPDATE, applies, and asserts rejected/location_not_found, no receipt, no voice write (read after un-archiving) and a committed terminal failure_reason. The round-1 SQL-text `toContain` is no longer the only thing pinning the predicate. |
| R3-24 | `src/lib/agents/operator/__tests__/apply.integration.test.ts` | applyProposal writes the receipt, status applied and decided_by_user_id in the same transaction as the voice write | **killed** | New-hunk probe of the `proposalColumns` fragment. N01 dropped `receipt` from the shared fifteen-column projection → FAILED. All five agent_proposals SELECTs in proposals.ts now compose the fragment (lines 278, 303, 322, 423, 442) and none re-spells the list. The case also pins the new Receipt field: actorName === 'Operator Apply Owner'. |
| R3-25 | `src/lib/agents/operator/__tests__/apply.integration.test.ts` | applyProposal receipt after equals the committed voice state and flags a difference from the stored after | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-26 | `src/lib/agents/operator/__tests__/apply.integration.test.ts` | applyProposal rolls back the receipt when the voice write throws | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-27 | `src/lib/agents/operator/__tests__/apply.integration.test.ts` | two concurrent applies on one proposal produce one voice write and both return the same receipt | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-28 | `src/lib/agents/operator/__tests__/apply.integration.test.ts` | worker-produced proposals render and apply successfully | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-29 | `src/lib/agents/operator/__tests__/apply.integration.test.ts` | repeat Apply after location archival returns the original receipt without writes | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-30 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | each turn carries its own unsupported requests and no other turn's | **killed** | RT-06 re-verification. M28 replaced the per-turn lookup `unsupportedByTurn.get(turn.id) ?? []` with `[...unsupportedByTurn.values()].flat()`, so every turn carries every row → FAILED. The new case inserts one agent_unsupported_requests row on turn one and one on another account's turn, asserts turn one carries exactly its own, turn two carries [], and the per-turn read agrees. |
| R3-31 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | the summary reports the latest zernio connection for the location, account-scoped | **killed** | RT-07 re-verification. M29 flipped `ORDER BY zc.created_at DESC` to ASC → FAILED, so the latest-row rule (what makes a soft-deleted disconnect read as the current state) is now behavioural, not merely present. The case seeds an older `active` and a newer `disconnected` on the location plus a row on another account's location. The account-scoping half of the same case is measured separately on row R2-66. |
| R3-32 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | an unusable ?locationId= answers location_not_found in both branches | **killed** | RT-08 and the new S7 union, two mutations, both killed. M30 deleted `AND archived_at IS NULL` from activeLocationId (reads.ts:443) → FAILED. N03 deleted the outright `return { kind: 'location_not_found' }` on the conversation-EXISTS branch (reads.ts:341), degrading it back to a silent null summary → FAILED. Both branches of the three-way OwnerConversationResult are therefore pinned. |
| R3-33 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | a zernio status outside the migration 026 vocabulary is refused, not widened | **killed** | N19 widened asConnectionStatus' member list with 'revoked' → the direct-call expectation stopped throwing → FAILED. The narrowing is exported from schema.ts precisely so the CHECK-unreachable branch can be called directly. |
| R3-34 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | first-time owner receives a scoped summary and connection CTA before sending | **killed** | N18 replaced `locationId: input.locationId` with `input.accountId` in readSummary's return → FAILED on `summary.locationId`. Caveat recorded: the sed matched four identically indented `locationId: input.locationId,` occurrences inside readSummary rather than the single return field, so the mutant is broader than intended; it is still a single semantic change (the summary and its sub-reads name the wrong row) and the kill is genuine. |
| R3-35 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | getTurnForOwner returns null for a turn id that belongs to another account | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-36 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | createTurn refuses a conversation id that already exists under another account and writes no turn | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-37 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | getConversationForOwner scopes the most-recent read to the actor and honours an explicit id | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-38 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | getConversationForOwner reports the location override and its dials, per location | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-39 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | getConversationForOwner carries each turn its own stored proposals, and none of another account's | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-40 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | getConversationForOwner returns a null summary for a conversation with no turns | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-41 | `src/lib/agents/operator/__tests__/reads.integration.test.ts` | getConversationForOwner bounds the transcript to the most recent turns | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-42 | `src/app/api/operator/__tests__/conversation-route.test.ts` | GET conversation omits the summary for an account that may not read dashboard data | **killed** | New-hunk probe of the C1 entitlement rule. N02 reduced the gate to `if (status === null)`, dropping the subscriptionAllowsDashboardRead half → FAILED. The case pins all three arms: pending_payment and cancelled answer 200 with summary null while the transcript survives, past_due still reads. |
| R3-43 | `src/app/api/operator/__tests__/conversation-route.test.ts` | GET conversation answers 404 location_not_found for an unusable location, with or without a conversation | **killed** | New-hunk probe of the 404 map. N15 returned the code `conversation_not_found` for the `location_not_found` result kind → FAILED. The two outcomes share a status and differ only in the body code, which is what lets the screen say which thing went wrong. |
| R3-44 | `src/app/api/operator/__tests__/conversation-route.test.ts` | GET conversation returns the actor's most recent conversation and the summary reads with timestamps | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-45 | `src/app/api/operator/__tests__/conversation-route.test.ts` | GET conversation scopes the summary to ?locationId= when the conversation has no turns | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-46 | `src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx` | summary panel renders the three blocks with as-of timestamps and the connect call to action when the connection is missing | **killed** | New-hunk probe of C3. N11 dropped `?locationId=${locationId}` from the Connect Google Business link → FAILED. The panel now names the scoped location through the injected locationLabel and carries it out to /dashboard/connect. |
| R3-47 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | operator times out while a poll request remains unresolved | **killed** | New-hunk probe that the client split preserved the INDEPENDENT deadline. N06 deleted useTurnPoll's standalone `setTimeout(..., POLL_DEADLINE_MS)` and replaced it with an elapsed check at the top of poll() — the exact regression the split could reintroduce — → FAILED: with the in-flight fetch never settling, no further tick is scheduled, nothing aborts the controller, and the case's `expect(aborted).toBe(true)` and the timeout notice never arrive. |
| R3-48 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | a delayed conversation response never replaces a newly submitted turn | **killed** | New-hunk probe of the activeTurnIdRef guard after the split. N07 dropped the `&& activeTurnId === null` half of `resuming` → FAILED: the stale response adopted the older turn A and rewrote the URL. The SECOND half of this hunk — the abort of the in-flight conversation read — survived and is recorded on row R2-64. |
| R3-49 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | a POST that never settles releases the composer and offers the same retry | **killed** | New-hunk probe of the 30 s POST deadline. N09 widened POST_DEADLINE_MS from 30_000 to 300_000 → FAILED. The case holds the POST open, advances the clock and asserts the abort fired, the composer is usable again and the retry offered is the same one the unreachable-POST case gets. |
| R3-50 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | a refusal the server answered offers no retry and an unusable location says so | **killed** | Two mutations on the new wording and halt hunks, both killed. N10b deleted the `unauthorized` entry from ROUTE_ERROR_WORDING only (line 174, leaving the identical PROPOSAL_FAILURE_WORDING entry intact) → FAILED, so the kill is isolated to the map the fix added it to. N17 reduced useTurnPoll's `halted` to `disabled`, dropping `\|\| conversation.locationUnavailable` → FAILED, so the screen no longer polls against a location the account cannot use. ROUND 3 (head ef9b3a7c). Re-measured for RT-17. The fix hoisted the two duplicated sentences into named constants — `ACTOR_UNAUTHORIZED` (wording.ts:149) and `ACCOUNT_OFFBOARDING` (wording.ts:151) — and BOTH maps now reference them rather than respelling them: `PROPOSAL_FAILURE_WORDING` at 157-158 and `ROUTE_ERROR_WORDING` at 188-189. The byte-for-byte duplication the finding named is gone, verified by reading the file at HEAD. N10b was then re-applied through the runner (delete line 188, `unauthorized: ACTOR_UNAUTHORIZED,`, from ROUTE_ERROR_WORDING only) and this case FAILED (`It looks like undefined was passed instead of a matcher`), so the entry is still measured. Recorded honestly: because the case asserts against `ROUTE_ERROR_WORDING.unauthorized` READ FROM THE MODULE, that kill pins the KEY's presence, not the sentence's text — a mutation of the constant's value would change expectation and actual together. The single-spelling claim is settled by the code read above, not by this mutation. |
| R3-51 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | operator renders every stored segment kind in order | **killed** | N16 deleted the `placed` de-duplication from the new TurnBody module (`turn.proposals.filter((p) => !placed.has(p.id)).map(card)` → `turn.proposals.map(card)`), so a proposal already rendered at its `proposal` segment is ALSO appended after the segments. The single-test run PASSED, and a whole-file probe (OperatorClient.test.tsx + ProposalCard.test.tsx, 17 tests) also passed under the same mutant. The branch IS executed by this case (its fixture has one proposal referenced by a `proposal` segment) and the mutant is not provably behaviour-preserving — the card renders twice — so this is an ORACLE claim, not an equivalent mutant: the case's ordering assertions use findIndex, which reads the FIRST occurrence, and nothing counts cards. Finding RT-13. ROUND 3 (head ef9b3a7c). KILLED — the oracle gap is closed. N16 was re-applied through the runner exactly as in round 2 (`turn.proposals.filter((proposal) => !placed.has(proposal.id)).map(card)` -> `turn.proposals.map(card)`, TurnBody.tsx:124) and the extended case FAILED at OperatorClient.test.tsx:577: `expected [ <section ...>, ...(1) ] to have a length of 1 but got 2`. Green baseline at HEAD first. The fix added a SECOND proposal that no `proposal` segment references, an assertion that it is appended after every segment (the RB-06 half that was unpinned), and three counting assertions — one `getAllByRole('region')` per describer plus `getAllByRole('button', { name: APPLY })).toHaveLength(2)` — so duplication is now COUNTED rather than read through findIndex, which only ever saw the first occurrence. |
| R3-52 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | operator screen posts a turn with the stored location, shows Preparing your plan and resumes the same turn from URL state after a reload | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-53 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | operator screen backs off polling and shows the timeout notice with Start a new conversation after four minutes | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-54 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-55 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | operator screen disables the composer under All locations and enables it once a location is chosen | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-56 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | retry after a lost POST response resumes the original turn | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-57 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | terminal failures and requested capabilities survive reload and subsequent turns | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-58 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | loaded conversations retain identity and starting over stays empty | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-59 | `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` | Refresh plan preserves the original instruction and location after scope changes | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-60 | `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx` | proposal card shows the receipt after Apply and the stale wording with Refresh plan after a version mismatch | **killed** | ROUND 3 (head ef9b3a7c). KILLED — executed this round, and the fragile oracle is gone. The exact document-wide count `expect(screen.getAllByText(DESCRIBE)).toHaveLength(2)` was replaced by a query SCOPED to the Receipt's own record: `const facts = screen.getByText('Applied at').closest('dl')!;` then `expect(within(facts).getByText('Change').nextElementSibling!.textContent).toBe(DESCRIBE)` (ProposalCard.test.tsx:172-173). The scoping is real, confirmed against ReceiptView.tsx:67-89: `Change` and `Applied at` are `dt`s of the same `op-kv op-facts` `dl`, and the assertion reads that row's own `dd`. Green baseline at HEAD, then the mutation ReceiptView.tsx:69 `<dd className="op-diff-value">{describe}</dd>` -> `{receipt.operation}` (print the catalog id instead of the describer, the exact defect the finding names) -> FAILED at ProposalCard.test.tsx:173, `expected 'set_tone' to be 'Set the reply tone to "warm and brief"'`. The kill lands on the NEW scoped assertion, not on the paired `queryByText('set_tone')` absence check, which is the point. |
| R3-61 | `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx` | proposal card renders the target from the stored location and shows Prepared for the location when the selector moved | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-62 | `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx` | proposal previews expose exact fact replacements before approval | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-63 | `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx` | requested capability card has no Apply button | **skipped-budget** | not executed — the 30-run per-round cap was spent on the eleven round-1 re-verifications and the fix-hunk probes; the runner refuses run 31 |
| R3-64 | `src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts` | a successful submission aborts the conversation read that was already in flight | **inconclusive (oracle)** | ROUND 3 (head ef9b3a7c). STILL INCONCLUSIVE (oracle) — measured, not assumed, and reported against the fixer's own disclosure. The fix added the case `a successful submission aborts the conversation read that was already in flight`, which keeps the `AbortSignal` each conversation read carries and asserts `signal.aborted` directly; it passes at HEAD (green baseline). BOTH halves of N08 were then re-applied through the runner, each as a single-line deletion, and BOTH SURVIVED: N08a deleted `conversationLoadRef.current?.abort()` from `adoptAcceptedTurn` (useOperatorConversation.ts:275) -> the case PASSED; N08b deleted the same call from `startFresh` (line 315) -> the case PASSED. ARBITER: these survivors are NOT recorded as `equivalent`, because equivalence is a claim about the mutant and it cannot be proven here. Mechanism, READ FROM THE CODE rather than measured — the two-mutations-per-test cap was spent on N08a and N08b, so no third mutation probed it: the read effect ends `return () => controller.abort();` (useOperatorConversation.ts:261), and BOTH commands mutate that effect's dependency list (`adoptAcceptedTurn` bumps `reloadEpoch` and sets `conversationId`/`fresh`; `startFresh` sets `fresh` and `conversationId`), so React runs the previous cleanup and aborts the SAME controller on the next commit. The explicit calls are therefore redundant AT THIS ORACLE'S OBSERVATION POINT, which is after React has flushed passive effects. They are NOT redundant in general: the explicit abort is synchronous inside the command while the cleanup abort is deferred to the commit, and that window is precisely where the superseded read's four early arms — `disabled`, `aborted`, `unreachable`, `error` — run BEFORE the `issuedAt !== loadEpochRef.current` guard at line 217. Nothing in a jsdom suite that awaits React's own flush can place an answer inside that window, so the claim is about the ORACLE and it blocks. Finding RT-12. |
| R3-65 | `src/lib/agents/operator/reads.ts` | readSummaryEntitlement returns the account's subscription status and null for an unknown account | **killed** | ROUND 3 (head ef9b3a7c). KILLED — the read is now measured. The fix added the live-DB case `readSummaryEntitlement returns the account's subscription status and null for an unknown account` to reads.integration.test.ts, executed with `--project integration` against the validated localhost test database (the runner's `--test-db` allowlist entry; `REPWORTH_DISABLE_LIVE_DB_SUITES` was therefore NOT set). Green baseline at HEAD. Mutation: dropped `WHERE id = ${accountId}::uuid` from readSummaryEntitlement (reads.ts:495), leaving `SELECT subscription_status FROM accounts` -> FAILED at reads.integration.test.ts:848, `expected 'past_due' to be 'cancelled'` — the second account read back the FIRST account's status, which is the exact defect the finding named. The case seeds two accounts with different statuses, re-reads the same id after changing its status, and asserts a random uuid answers `null`, so the column, the table and the predicate are all covered. |
| R3-66 | `src/lib/agents/operator/reads.ts` | readConnectionStatus's `AND b.account_id = ${input.accountId}::uuid` JOIN predicate | **equivalent** | M29b deleted the predicate and the account-scoped case PASSED. PROVEN behaviour-preserving for every reachable input, not merely unobserved: the statement already filters `zc.business_id = ${input.locationId}`, businesses.id is globally unique, and readSummary is reachable only with a locationId that is either the latest turn's (a turn of this account's own conversation) or the output of activeLocationId(accountId, ...), which enforces membership. No row can therefore be admitted by dropping the predicate. It must stay — ci:tenant-scope and invariant #9 require it — but the case's `account-scoped` half cannot fail. Recorded as RT-14 (P2, no action), the readConnectionStatus twin of round 1's RT-10. |
| R3-67 | `e2e/operator.spec.ts` | unauthenticated /dashboard/operator redirects to the owner login | **excluded** | Playwright/E2E spec — out of scope for mutation by the skill (fragile-assertion review only). Re-reviewed at HEAD for fragile assertions after the client split: no absence-of-tag proxy, no exact string count and no order assertion without an ordering contract was found; the two authenticated cases still self-skip without the local auth harness. |
| R3-68 | `e2e/operator.spec.ts` | e2e: owner sends a turn, applies the tone proposal and sees the receipt at 390 and 1440 | **excluded** | Playwright/E2E spec — out of scope for mutation by the skill (fragile-assertion review only). Re-reviewed at HEAD for fragile assertions after the client split: no absence-of-tag proxy, no exact string count and no order assertion without an ordering contract was found; the two authenticated cases still self-skip without the local auth harness. |
| R3-69 | `e2e/operator.spec.ts` | e2e: a settings write between proposal and Apply produces a stale card with Refresh plan | **excluded** | Playwright/E2E spec — out of scope for mutation by the skill (fragile-assertion review only). Re-reviewed at HEAD for fragile assertions after the client split: no absence-of-tag proxy, no exact string count and no order assertion without an ordering contract was found; the two authenticated cases still self-skip without the local auth harness. |

## Authorizations

Rendered from `findings.json` → `authorizations`, which is the only source of truth for
this section; it is never parsed back out of this Markdown. No finding on this run is
`accepted-risk` — these entries authorize the scoped third round, not a waived finding.

### AUTH-1 — 2026-09-12

- **Findings:** RT-11, RT-12, RT-13, RT-15, RT-16, RT-17

> Fix all six, authorize a scoped round 3 — Four small tests + one constant + a handoff rewording, then a third red-team round scoped to those hunks. Your authorization is recorded verbatim in the sidecar (the runner refuses round 3 without it).

### AUTH-2 — 2026-09-12

- **Findings:** RT-11, RT-12, RT-13, RT-15, RT-16, RT-17

> I authorize a third round of the red team, scoped to the six round-2 fix hunks (RT-11, RT-12, RT-13, RT-15, RT-16, RT-17).
