# Pathfinder 2026-08-22 — handoff prompts

> ## ⚠ LINE NUMBERS IN THIS FILE ARE PINNED TO `74aee92a`
>
> Four PRs have landed since (#932 `1014aaa6`, #933 `9929c3c7`, #934 `e53302d6`,
> #935 `2f386c52`). **#933 moved `canonicalBatchId` out of `approval.ts`, which
> shrank it 1,352 → 1,333 — every `approval.ts` line below is stale by −19.**
> `outreach.ts` grew +34.
>
> **Re-derive every line number against HEAD before acting on it.** A 2026-08-23
> session did exactly that and caught the drift; copying these numbers forward
> would re-create the staleness class this pass exists to document (§P4).
> The findings are sound; the coordinates are not.

Phase 4. Per the owner's instruction (2026-08-22), **this is ONE ranked backlog**
— the seven re-verified 2026-08-18 handoffs and this pass's new findings merged
and ranked against a single criterion, not two independent lists.

## Ranking criterion, stated

**Expected cost of NOT doing it before the next window:**

```
(live-defect severity × reachability)
  + (rate at which the window is adding new instances)
  + (work it unblocks)
  − (implementation cost)
```

A maintainability risk outranks a live defect only when the window is actively
multiplying it. Ties break toward the cheaper item.

## The merged backlog

| # | Item | Source | Why here | Cost |
|---|---|---|---|---|
| **1** | **H8 — the send-path integrity tests** | NEW (guard integrity G6, G2b, G2a) | **Three silent failure modes with zero tests anywhere in the repo.** `bytes_changed_under_gate`, `cas_lost` and `in_flight_elsewhere` return **no test-file references** in all of `src`+`worker`. The lane genuinely sends since #912. Failure modes: moderating one artifact and sending another; a value-ledger row with no join key; a double send. **The window created all three.** | 3 live-DB tests |
| **2** | **#896 (H7)** — `ci:merge-ledger` + the Stop-hook sentinel | re-verified DRIFTED / STILL VALID | The only item that changes the **rate** at which everything else accumulates. Premise now confirmed in the repo's own words; four merges missed in one window; hand-corrected for the third recorded time. **Part 2 is an active safety hole whose mechanically obvious remedy deletes a posting precondition (invariant #3) — and it exists in TWO hook copies, not one.** Part 2 is ~10 lines and should not wait for Part 1. | P2 trivial; P1 one script + wiring |
| **3** | **H9 — `canonicalBatchId` at `ask-generation.ts`'s two entry points** | NEW (X18) | **Two lines.** A live silent bug: `settleGenerationExhaustion` binds the same id cast-and-case-insensitive at `:1590` and raw-TEXT at `:1637`, so it locks the batch and misses its run parent, writing `agentRunId: null` on every filled hole. **The canonicaliser exists precisely because this already shipped once** (`approval.ts:135-152`). | 2 lines |
| **4** | **#893 (H4)** — bound the admin fan-out + replace the pins with a rule | re-verified STILL VALID | The only **live production defect** in the old set: two concurrent statements against a pool of three, with the counter-instruction written in code one directory away. Part 2 now has **two** proven misses (`lookupSuppressions`, and `getAdminNotifications` at fan-out 3). Ship Parts 1 and 2 together. | P1 two lines; P2 one AST audit |
| **5** | **H10 — the two CI gate holes** | NEW (F3 Q8, F3 Q6) | **(a)** `ci:admin-aal2`'s P2 parity anchors on a sibling route that does not exist for `/admin/solicitation`, so **flipping `aal2: true` → `false` on a page that reads `solicitation_send_breaker` directly via `sql` would pass CI.** **(b)** `REQUIRED_RLS_TABLES = TENANT_TABLES`, so `ci:rls-audit` guards neither `solicitation_send_breaker` nor four older platform-scoped tables. | one `siblingRouteFile` fallback + one ~25-line live-DB test |
| **6** | **H11 — S6a: split `readSendBreaker` into `assertSendAllowed` + `readSendBreakerState`** | NEW (F3 Q1) | Converts **three prose statements into one type-level fact**, retires the "is there a second label-only read yet?" question permanently, and makes **two of the four stale `docs/directory.md` rows impossible to write wrongly**. Seed 8 is refuted — there are already three catching reads and two predate the merge that documented the carve-out as novel. | two exports, one private body, 5 call sites |
| **7** | **S1 — the send lane's state vocabulary** | NEW (X13 + X14), **supersedes #890 + #891** | Fixes a wire defect: `!== 'not_settled'` reports `closed: true` for a reachable `no_send_parent`. **Both old ticket texts are wrong and must be corrected before anyone works them.** #886 proposes to extract exactly the code that reads the bad field. | one leaf + one function + 7 call sites |
| **8** | **S2 — the worker failure-handling layer** | NEW (X15 + X16 + X19) | **The item the window made worst: three copies to five in one window.** Plus a security-posture divergence where the threat model is written at the site that does not defend against it. Plus a dead disjunct in the shared catch-form helper. | one file move + 4 rewrites + 1 line |
| **9** | **S5 — `publicSignupPosture()`** | NEW (X23) | Ten spellings, one with reversed operands, and **a tenth surface that is wrong today**: `demo/[slug]/not-found.tsx` renders "Create account" while every other public surface renders "Start free trial". Exact in-repo precedent (`isTrialEligible`) that already burned on this bug. | one function + 10 call sites |
| **10** | **S6b — X10's two cheapest applications** | NEW (F8 Q3, amended by Phase 2) | `TENANT_TABLES` + `PLATFORM_TABLES` completeness test (**would have failed at migration-110 merge time**) and the two-line `linkedColumnPattern` widening. **Phase 2 raised the second item's rank** — it is the input every purge-side derivation inherits its blind spot from. Overlaps item 5(b); ship together. | ~25 lines + 2 lines |
| **11** | **S3 (X17 half) — `utcDayStartSql` + its pin test** | NEW | Four byte-identical spellings across two lanes, and **the tests provably cannot catch the drift** — the fixture re-spells the production expression. **Ship the pin test with the fragment or this is a rename, not a fix.** | one leaf + 4 sites + 1 test |
| **12** | **S4 — the Daylight primitive layer** | NEW (X20 + X21 + X22) | Real and well-evidenced: a declared seam at `island.css:1276`, 15 open-coded reveals, two hand-built FAQ controllers, and one capability gain (removing a whole class of compensating CSS rule). **⚠ A concurrent session began implementing exactly this at ~22:10 on 2026-08-22, including a staged `git mv`. Re-anchor before acting.** | file split + 2 components + ~18 call sites |
| **13** | **#895 (H6)** — **re-scope to FIVE items; (b) is done** | re-verified DRIFTED | (b) was delivered by #920 and its docstring cites the issue by number — **the tracker and the source disagree about whether it is done.** That removes the bundle's own "if it has to shrink, keep (b)" rationale, so **split it**: (a) has a newly live trigger (`platform_halt` landed); (c) now misstates by four writers; (d)(e)(f) are one-liners. | five independent 1–5 line edits |
| **14** | **#892 (H3)** — **edit the issue BEFORE working it** | re-verified DRIFTED | One of two truth claims is **refuted** — `tracked_keywords` is `NOT NULL` (`014:116-121`), so `<>` cannot go three-valued. Removes the "bug" framing and the severity argument; **retag `enhancement`**. The duplication and the 27-vs-28 doc error are real. Nothing has moved these files since #882. | one leaf + 7 substitutions |
| **15** | **#894 (H5)** — **pull Step 1's two-line fix forward; defer the rest** | re-verified STILL VALID | Zero new adopters, so nothing is compounding, and the issue's own measurement says the naive fix buys nothing. **But `src/lib/dashboard/pending-count.ts:29-30` states a FALSE reason for correct scoping** — two lines, worth folding into whatever ships next. | Step 1: N comments |

**Ship-together constraints.** Items 5(b) and 10 overlap — one live-DB completeness
test serves both. Items 1 and 8 both touch `worker/jobs/solicitation-send/failed-hook.ts`.
Items 2, 4 and 10 each add a `ci:*` script touching `ci.yml` + `lefthook.yml` +
`ci-audit-wiring.test.ts` — **sequence them or expect a conflict.** Item 7 lands
before or with **#886**.

---

## H8 — The send-path integrity tests  *(rank 1)*

```
/make-plan

Write three live-DB tests for src/lib/solicitation/dispatch.ts. All three guards
were measured UNPINNED by mutation on 2026-08-22 — deleting each left the whole
solicitation lane green (46–52 files, 713–812 tests). Evidence:
docs/reviews/PATHFINDER-2026-08-22/06-guard-integrity.md.

These are the ONLY mechanical protection for three silent failure modes, and a
whole-repo grep of src + worker returns ZERO test-file references for their
outcome discriminants.

TEST 1 — the A4 bytes-identity check (dispatch.ts:1520-1529). HIGHEST VALUE.
Let gatherSlowGateEvidence compute its verdict, then UPDATE
solicitation_outreach SET rendered_body = <different> before the locked re-read.
Assert: dispatchOutreach returns { kind: 'bytes_changed_under_gate' }; the
messaging adapter is never called; delivery_status stays 'queued'; only the
outbox attempt is completed. It is a DEFER, not a withhold.
Why it matters: this is the sole mechanical check that the bytes moderated are
the bytes sent. ADR 0020's immutability is enforced in a domain module, not in
the schema. Deleting the block today is invisible.

TEST 2 — the terminal CAS (dispatch.ts:1125, `AND delivery_status = 'sending'`).
Terminalize the row to 'failed' between tx1 and commitSendTerminal (the #900
D12d sweep is the realistic path). Assert all four consequences the docstring at
:1131-1139 already states and none of which is asserted anywhere:
delivery_status still 'failed'; provider_message_id still NULL; NO
agent_outcomes 'solicitation_sent' row; no 'completed' child step.

TEST 3 — the queued CAS (dispatch.ts:1723, `AND delivery_status = 'queued'`).
Open a dispatch transaction against a row already in 'sending'. Assert
{ kind: 'in_flight_elsewhere', detector: 'cas_lost' }; no provider send; no
sending_at write; no updated_at re-stamp.

ANTI-PATTERN GUARDS
- Do NOT test these by asserting the SQL text. Assert the OBSERVABLE outcome —
  a query-shape pin would pass with the predicate deleted, which is the exact
  failure being fixed.
- Do NOT collapse tests 2 and 3 into one. They guard opposite transitions
  (into 'sending' vs out of it) and have different discriminants.
- These are live-DB tests, so the file must be named *.integration.test.ts and
  must execute NO run-time DDL (ci:live-db-suites).
- Export TEST_DATABASE_POOL_URL and DATABASE_POOL_URL, or the suites silently
  skip and you will report a false pass.

VERIFY: re-run each mutation from 06-guard-integrity.md and confirm your new
test goes RED, then restore. A test that does not go red under the mutation it
was written for is not a test.
```

## H9 — `canonicalBatchId` at the two `ask-generation.ts` entry points  *(rank 3)*

```
/make-plan

Two lines, plus one export. Fix a live silent bug in
src/lib/solicitation/ask-generation.ts.

THE BUG. settleGenerationExhaustion binds the SAME input.batchId two ways in ONE
transaction:
  :1590  WHERE id = ${input.batchId}::uuid        -- uuid cast, case-insensitive
  :1637  AND subject_id = ${input.batchId}        -- raw TEXT compare
agent_runs.subject_id is TEXT (migration 071), so a mixed-case id finds the batch,
takes the lock, and MISSES its send parent. :1656 then writes
`agentRunId: parent?.id ?? null` on every filled hole and the generation steps are
silently skipped. Forty lines later closeBatchIfSettled lowercases internally
(outreach.ts:334) and DOES find the parent — two readers of one key, in one
transaction, disagreeing.

regenerateAsk has the same raw binding at :1434.

THIS ALREADY SHIPPED ONCE. src/lib/solicitation/approval.ts:135-152
canonicalBatchId exists because of it — read its docstring; it names approveBatch
throwing a 500 and haltBatch silently dropping its batch_halted step.
ask-generation.ts contains ZERO canonicalBatchId calls and zero .toLowerCase().
It is safe today only because loadBatchContext:200-210 round-trips the id through
Postgres — a two-hop accident, and settleGenerationExhaustion does not use ctx.

DO: export canonicalBatchId from a leaf both files can import; call it at
regenerateAsk and settleGenerationExhaustion entry.

ANTI-PATTERN GUARDS
- Do NOT lowercase at the two SQL sites. Canonicalise ONCE at the entry point —
  approval.ts:140-146 says why, and per-site lowercasing is how this recurs.
- Do NOT unify the send-parent QUERY. run-spine.ts:486 asks "is there an ACTIVE
  parent" (status='running'); the other six ask "the LATEST parent" (ORDER BY
  started_at DESC LIMIT 1). Different questions. See the DO-NOT-UNIFY register in
  02-duplication-report.md.
- If canonicalBatchId moves out of approval.ts, a docs/directory.md row ships in
  the same PR (ci:directory-map).

TEST: an integration case that calls settleGenerationExhaustion with an
UPPERCASED batch id and asserts the generation steps land on the send parent —
today it writes agentRunId: null and passes silently.

Evidence: docs/reviews/PATHFINDER-2026-08-22/02-duplication-report.md X18.
```

## H10 — The two CI gate holes  *(rank 5)*

```
/make-plan

Two independent holes in gates that are believed to be closed. Evidence:
docs/reviews/PATHFINDER-2026-08-22/01-flowcharts/F3-send-breaker.md Q6 and Q8.

HOLE A — ci:admin-aal2's P2 parity misses /admin/solicitation.
scripts/ci/admin-aal2-audit.ts:529-532 anchors siblingRouteFile() on
`src/app/api` + <page path> + `/route.ts`. For /admin/solicitation that resolves
to src/app/api/admin/solicitation/route.ts, WHICH DOES NOT EXIST — the routes sit
one segment deeper (breaker/route.ts, batch/halt/route.ts). So the page falls into
the audit's own "RECORDED LIMITATION (P2)" bucket at :130-136 — and that list
names five pages and does not include it. All 21 pages were enumerated: the
P1-only set is SIX.

Why it is live, not bookkeeping: admin/solicitation/page.tsx:41 reads
solicitation_send_breaker DIRECTLY via sql — the exact "parallel read path around
the API" P2 exists to close (:117-121). Flipping aal2:true -> false at :52 would
PASS CI while breaker/route.ts:20 stays AAL2.

FIX: extend siblingRouteFile to fall back on the deepest single route.ts under the
page's API subtree. Do NOT just add /admin/solicitation to the limitation list —
that is bookkeeping, not a restored guarantee.

HOLE B — ci:rls-audit guards no platform-scoped table.
scripts/ci/rls-audit.ts:12 is `REQUIRED_RLS_TABLES = TENANT_TABLES`.
solicitation_send_breaker (migration 110, deny-all RLS, its own audit record) is
not a TENANT_TABLES member, so NEITHER the live relrowsecurity check NOR the
DB-free migration-coverage check guards it. Its RLS is proved by exactly one
hand-written integration test someone chose to write.

Four older tables have the same hole: sms_sender_opt_outs (022),
sms_sender_opt_out_events (022), owner_leads (033), poller_cursors (081).

FIX: add a PLATFORM_TABLES export carrying a one-line reason per entry, and make
REQUIRED_RLS_TABLES the union. scripts/ci/tenant-tables.ts:76-83 already does
exactly this for inbound_events / prospect_demos / google_connections and says
why — follow that precedent verbatim.

ANTI-PATTERN GUARDS
- Do NOT add solicitation_send_breaker to TENANT_TABLES. It has no account_id;
  ci:tenant-scope would then demand a tenant predicate on every statement
  touching it, and there is no correct one. PLATFORM_TABLES is the right list.
- Hole B overlaps handoff item 10 (X10's completeness test). Ship them together:
  one live-DB test over information_schema serves both.
- A changed ci:* script must stay wired in ci.yml AND lefthook.yml or
  src/__tests__/ci-audit-wiring.test.ts fails — which is correct.
```

## H11 — Split `readSendBreaker` into a gate and a state read  *(rank 6)*

```
/make-plan

Replace one export with two in src/lib/solicitation/send-breaker.ts, sharing one
private query body.

  assertSendAllowed(sql): Promise<void>
    Throws on an open trip AND on a DB failure. The ONLY function the release
    phase may call. Wrapping it in try/catch becomes visibly absurd at the site.

  readSendBreakerState(sql): Promise<SendBreakerState>
    For the label read and the two display reads, which may catch freely.

WHY. SCOPE.md seed 8 asked "is there a SECOND label-only read yet?" The answer is
that the premise was already wrong: there are FIVE call sites and THREE catch —
release.ts:945 (label), admin/solicitation/page.tsx:41 and
api/admin/solicitation/breaker/route.ts:24 (display). git log -S puts the two
admin catches in b873a9a5 (#904, 2026-08-21); 2c7bb615 (#926, 2026-08-22) is the
THIRD, and it documented the carve-out as novel. The docstring's criterion —
"wraps this in try/catch AND PROCEEDS TO SEND" — is not machine-checkable, and
4 of 5 sites now sit on its permissive side.

CALL SITES TO REWRITE
  release.ts:1341                                  -> assertSendAllowed (drop nothing; it already has no catch)
  release.ts:945  (resolveWindowHaltReason)        -> readSendBreakerState, keeps its catch
  api/admin/solicitation/breaker/route.ts:24       -> readSendBreakerState
  app/admin/solicitation/page.tsx:41               -> readSendBreakerState
  send-breaker.ts:112 (inside evaluateSendBreaker) -> readSendBreakerState

FIX THE CODE MAP IN THE SAME PR. Both rows are false today:
  docs/directory.md:919  "readSendBreaker gets no try/catch — the throw IS the halt"
  docs/directory.md:934  "readSendBreaker has no try/catch and no unknown verdict"
After the split both become writable correctly and un-writable wrongly.

ANTI-PATTERN GUARDS
- Do NOT build a CI audit for this instead. A structural split is cheaper and
  cannot drift; an audit is a fifth prose statement with a runner.
- Do NOT give either function a boolean parameter. Two names IS the contract.
- Do NOT change the fail-closed semantics of the gate. Guard integrity measured
  it PINNED three ways (release.integration.test.ts:1620, :2024, :2043) — those
  three tests must stay green, retargeted at assertSendAllowed.

Evidence: 01-flowcharts/F3-send-breaker.md Q1; 02-duplication-report.md X26.
```

## H12 — S1: the send lane's state vocabulary  *(rank 7 — supersedes #890 and #891)*

```
/make-plan

CORRECT #890 AND #891 BEFORE STARTING. Both ticket texts are now wrong:
- #890 prescribes ONE constant. Three are needed — the window added a seventh
  spelling (failed-hook.ts:90, `queued || sending`) that answers a THIRD question.
- #891 prescribes one predicate for five sites. The right shape is one predicate
  for FOUR plus an explicit non-adoption note for release.ts:465.

BUILD
  src/lib/solicitation/delivery-status.ts   (new leaf, dependency-free)
    CANCELLABLE_DELIVERY_STATUSES  'rendered'|'queued'   -- may an owner cancel it?
    LIVE_DELIVERY_STATUSES         + 'sending'           -- is anything still live?
    DISPATCHED_ARRIVAL_STATUSES    'queued'|'sending'    -- what did a dead job leave?
    isCancellableDeliveryStatus(s), isTerminalizableArrival(s)

  src/lib/solicitation/outreach.ts, beside the union it discriminates:
    batchDidClose(close) = close.status === 'closed'
                        || close.status === 'closed_without_parent'
                        || close.status === 'already_closed'

THE WIRE DEFECT batchDidClose FIXES. 'no_send_parent' !== 'not_settled' is true,
so halting an all-withheld `built` batch makes BOTH halt routes report
closed: true while send_closed_at IS NULL. Reachability verified:
approveBatch:322-325 documents parentless built batches; haltBatch:675 permits
halting `built`; latchHalt:608 passes no failure; closeBatchIfSettled:392 returns
no_send_parent. A POSITIVE enumeration makes that fall out correctly; the current
negative proxy does not.

REWRITE
  approval.ts:1185, ApprovalPanel.tsx:980, AskList.tsx:306  -> isCancellableDeliveryStatus
  failed-hook.ts:90                                          -> isTerminalizableArrival
  halt/route.ts:45, admin/.../halt:91, withdraw/route.ts:43  -> batchDidClose
  approve/route.ts:60                                        -> batchDidClose (drop approval.ts:466's ternary)

LEAVE BYTE-FOR-BYTE
  approval.ts:569, approval.ts:1300, batch-view.ts:957 — the SQL IN lists.
  approval.ts:1289-1290 says why: the status literals are PARAMETERS so the
  query-shape pins can assert them by value. Two tests depend on that spelling.
  release.ts:465 — a TALLY, not a receipt. Add one comment saying so.

ANTI-PATTERN GUARDS
- Do NOT derive any subset as the complement of TERMINAL_DELIVERY_STATUSES
  (outreach.ts:149-156, module-private on purpose). Its complement is the LIVE
  set. failed-hook.ts:84-88 gives a domain reason `rendered` must be excluded
  from ARRIVAL that no set algebra expresses.
- Do NOT put the constants in outreach.ts or approval.ts — both client consumers
  import from @/lib/solicitation/* TYPE-ONLY today (invariant #1), and both those
  modules runtime-import the run spine.
- Do NOT fold release.ts:465 into batchDidClose. See the DO-NOT-UNIFY register.
- New file => a docs/directory.md row in the same PR.

ADD ONE TEST: assert each of the three SQL query texts contains the IN-list
rendered from the corresponding constant. Today the coupling is prose on three
sides and mechanical on none.

ORDERING: land before or with #886.
Evidence: 02-duplication-report.md X13, X14; 07-handoff-reverification.md.
```

## H13 — S2: the worker failure-handling layer  *(rank 8)*

```
/make-plan

Move worker/jobs/solicitation-batch/failed-hook-shared.ts to
worker/job-failure-helpers.ts (worker root, beside job-failure-sink.ts — one of
its four consumers). No new directory; the root already holds emitter-errors.ts,
job-failure-sink.ts, sentry.ts.

THE FINDING. F2 reported "three deliberately non-unified copies". There are FIVE
of the 'failed'-EVENT form, byte-identical:
  worker/jobs/solicitation-batch/failed-hook-shared.ts:22-28  isExhaustedJob  (EXPORTED)
  worker/jobs/judge/failed-hook.ts:44-57                      isJudgeAttemptExhausted
  worker/jobs/solicitation-send/failed-hook.ts:93-106         isSendAttemptExhausted
  worker/job-failure-sink.ts:38-44                            isFailedEventTerminal
plus the catch form at src/lib/shared/outbox.ts:211-216 and three ad-hoc spellings
with three different attempt defaults (?? 3, ?? 5, ?? 1).

The two middle copies carry a VERBATIM eight-line comment, identical down to the
phrase "do not unify them" — and every copy obeyed it correctly. That instruction
is about EVENT-form vs CATCH-form. It never says where the event form lives, so
each hook re-implemented it.

Decisive: solicitation-send/failed-hook.ts:49 ALREADY imports boundedErrorClass
from '../solicitation-batch/failed-hook-shared' — the same module, the same import
statement — and re-implements isExhaustedJob 44 lines later. And
job-failure-sink.ts:24-26 records that it was directed to reuse the shared helper
and declined, correctly, because it was pointed at isTerminalAttempt (the catch
form). Nobody pointed it at isExhaustedJob. The right owner existed and was
invisible.

ALSO UNIFY boundedErrorClass — there are TWO BODIES with TWO SECURITY POSTURES.
  Body A  err.name.slice(0,100), no shape validation:
          csv-ingest/failed-hook.ts:94-97, judge/failed-hook.ts:39-42,
          job-failure-sink.ts:59-62
  Body B  err.constructor.name + /^[A-Za-z][A-Za-z0-9_$]{0,99}$/:
          failed-hook-shared.ts:36-41
They compute different things (err.name is writable; constructor.name is the
class), so four sites logging under one identifier produce two values for one
error. And job-failure-sink.ts:55-56 STATES the threat — "Error.name is
attacker-influenceable on a custom class" — then does nothing about it, while the
hardened version sits three directories away. CLAUDE.md: string log args are
logged verbatim. Adopt Body B everywhere.

ALSO: src/lib/shared/outbox.ts:215 is
  return job.attemptsMade >= maxAttempts || job.attemptsMade + 1 >= maxAttempts;
`a >= m` implies `a+1 >= m`, so the FIRST DISJUNCT IS DEAD. Delete it. The
disjunction is what makes the function look like it handles both contexts — the
exact misreading job-failure-sink.ts:24 needed six lines of prose to escape.

ANTI-PATTERN GUARDS
- The catch-form / event-form distinction STAYS. isTerminalAttempt is untouched.
  Do not add a parameter switching between them. See the DO-NOT-UNIFY register.
- Do NOT unify the three ad-hoc spellings' attempt DEFAULTS (?? 3 / ?? 5 / ?? 1).
  Those are per-queue configuration, not one fact.
- Moved + new files each need a docs/directory.md row in the same PR.

Evidence: 02-duplication-report.md X15, X16, X19.
```

## H14 — S5: `publicSignupPosture()`  *(rank 9)*

```
/make-plan

Add ONE exported server function to src/lib/payments/flags.ts, beside
trialEnabled():

  publicSignupPosture(): {
    selfServeEnabled: boolean;
    trialEnabled: boolean;
    signupCtaLabel: string | null;
  }

It reads its own flags — do NOT take them as arguments. The precedent says why:
src/lib/payments/plan-activation.ts:146-148, "they are server-authoritative
(invariant #13) and this function is the policy, not a pure mapping over
caller-supplied config."

THE PRECEDENT ALREADY BURNED ON THIS EXACT BUG. plan-activation.ts:150-160
isTrialEligible is the SINGLE OWNER of trial eligibility and its docstring
(:120-149) records: "The two checkout entry points … spelled this independently
and DISAGREED: the funnel's copy carried only the first and last term." Its first
two conjuncts are trialEnabled() && selfServeSignupEnabled() — the same
conjunction the marketing chrome now spells nine times.

REWRITE these ten, replacing two flag reads plus a conjunction with one call:
  legal/LegalPage.tsx:31 · help/contact/page.tsx:14 · security/page.tsx:17
  book-a-demo/page.tsx:13 · demo/[slug]/page.tsx:49 · how-it-works/page.tsx:14
  features/page.tsx:14 · pricing/page.tsx:19 (object property)
  (public)/page.tsx:19  (OPERANDS REVERSED — semantically identical, and proof
                         nobody owns the rule)
  (public)/demo/[slug]/not-found.tsx:4-6  <-- WRONG TODAY

not-found.tsx reads selfServeSignupEnabled() and computes NO conjunction, so
DemoStatusIsland.tsx:52's `trialEnabled = false` default forwards through to
SiteNav at :56. With the trial on, an expired demo link renders "Create account"
while every other public surface renders "Start free trial" — same component,
same route segment, two answers. Its sibling page.tsx:49 does compute it.

ANTI-PATTERN GUARDS
- Do NOT hoist the chrome RENDER into (public)/layout.tsx. An App-Router layout
  receives children as an already-materialised node across the RSC boundary — no
  props injection, no server-side context — and the ten surfaces use THREE
  different islands (SiteShell / PageShell / the landing page's own), two of
  which render no footer. (public)/layout.tsx:9-16 documents this deliberately.
  Hoist the READ; leave the RENDER.
- Do NOT add a NEXT_PUBLIC_* companion. ci:static-policy allowlists exactly six
  and fails on any new one.
- Zero render changes. If a JSX tree moves, the scope has grown.

ADD ONE TEST: assert every public composition root that renders SiteNav obtains
its trialEnabled from publicSignupPosture(). Today nothing walks the call sites,
which is how not-found.tsx got missed and how an eleventh surface would.

Evidence: 02-duplication-report.md X23; 01-flowcharts/F5-marketing-chrome.md Q1-Q2.
```

## Prompts not written out

Items 2, 4, 13, 14 and 15 are existing GitHub issues (**#896, #893, #895, #892,
#894**) whose bodies already carry implementable prompts. **Do not re-derive them
from the issue text** — `07-handoff-reverification.md` records exactly which lines
moved, which claims are refuted, and which counts are wrong. In particular:

- **#895:** drop item (b) — it is done, and its docstring cites the issue by
  number. Re-scope to five.
- **#892:** correct the `tracked_keywords` nullability claim and retag
  `enhancement` **before** anyone works it.
- **#894:** pull `pending-count.ts:29-30` forward; defer Steps 2–3.

Items 10, 11 and 12 (S6b, S3's fragment half, S4) are specified in
`03-unified-proposal.md` at implementation detail and do not need a second copy
here. **S4 must be re-anchored against the working tree first** — a concurrent
session began implementing it during this pass.
