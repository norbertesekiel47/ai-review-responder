# Branch review round 1 — consolidated triage (#674)

**Round:** 1 of 3 (`branchReviewRounds=1` in `.feature/state.json`)
**Gate at review time:** GREEN at `b6d841f8`, 23/23
**Axes:** spec & correctness · standards & maintainability · adversarial approach (RISK = high ⇒ three axes)

Reports: `branch-round-1-spec.md` · `branch-round-1-standards.md` · `branch-round-1-adversarial.md`

## Verdicts

| # | Axis | Sev | Finding | Verdict |
|---|---|---|---|---|
| A1 | adversarial | high | Import suppresses live drafting with **no race** — broader than D4 | **ACCEPT** as a characterization defect · **REJECT** as a code change |
| A2 | adversarial | medium | Completed `review_handler` run misreports unhandled inventory | **ESCALATED → owner decided: ship as-is, carry to #675** |
| S1 | standards | medium | Integration suite's 4 `it` blocks share state; one alone throws `TypeError` | **REJECT** — deliberate, plan-locked |
| S2 | standards | low | No `assertSchemaReady` call | **ACCEPT — FIXED** |
| S3 | standards | low | Test file crosses 1k lines | **REJECT** — waivable; noted for #675 |
| S4 | standards | low | `insertNewReviewRow` returns `Promise<number>`, leaking the row-count mechanism | **REJECT** — plan-locked signature |
| S5 | standards | low | `docs/directory.md` stale | **DEFERRED** — out of edit surface |
| — | spec | — | No findings at ≥80% confidence | — |

## Reasoning

### A1 — ACCEPT the correction, REJECT the code change

Verified independently, not taken on assertion: `processExistingReview:266`
returns `'unchanged'` on a hash match with no enqueue, and
`ZernioBackfillWorker.ts:237` routes through the same `processReview`. So the
general property is *any imported review is never drafted*, and the race D4
describes is only its simultaneous instance.

No code change in #674: `importReview` is correct against its locked contract,
ships callerless, and the fix belongs in `processReview`'s existing-row branch —
the behaviour change this ticket forbids. Nothing defective ships.

The documentation was materially wrong and **is now corrected** in three places:
deviations D4 (with the verification trace), the plan's Hazards section, and the
`importReview` JSDoc. The ship-time #675 comment must carry the corrected
statement — the original framing would send an implementer after a narrow
concurrency guard and leave the real gap open.

### A2 — ESCALATED → owner decision: ship as-is, carry to #675

Genuine design tension with D3, and the two adversarial findings compound: the
completed run is what hides the never-drafted review. Every alternative costs
something (see `branch-round-1-adversarial.md` for the option table), and the
reviewer's preferred fix — a distinct run kind — requires an `AGENT_RUN_KINDS`
migration that is explicitly out of scope. Owner's call, not the orchestrator's.

**Owner decision (2026-08-05): ship as-is.** Reasoning recorded so #675 inherits
it rather than re-deriving it:

- Nothing is misreported **today** — `importReview` has zero callers, so no
  imported review exists to be misrepresented in any timeline.
- The reviewer's own preferred representation is *"through the import batch
  record"*, and that record belongs to **#675**. Fixing it here would mean
  inventing a spine representation for a batch concept this ticket cannot see.
- A1 and A2 are one problem, not two: the completed run is only misleading
  *because* the review is never drafted. Splitting them across two tickets would
  half-fix the symptom in #674 and leave the cause in #675.
- The signature is already documented and derivable — the intake's
  `observability` section names *"a completed `review_handler` run carrying a
  `review_ingested` step, with no `responses` row"* as the import's fingerprint.

Recorded as deviation **D16**. Both A1 and A2 go on #675 at ship time as a single
coherent problem statement.

### S1 — REJECT

The plan locks this explicitly: *"the four `it` blocks run in file order and
share state deliberately… Do not add `beforeEach` isolation — the shared fixture
**is** the scenario."* The four tests are one narrative (import → observe → observe
→ re-import to prove dedup). Hoisting the import into `beforeAll` would make
test #1 — *"stores the review against the live schema and returns new"* — assert
on state produced outside itself, which trades one smell for another. The
diagnostic cost the reviewer names (running one test alone throws rather than
failing meaningfully) is real but confined to interactive debugging of a 4-test
suite. Noted for #675 if the suite grows.

### S2 — ACCEPT, fixed

Verified as a real convention gap, and the reviewer's evidence understated it:
`describeWithDb` does **not** assert schema (it only gates on the env var), so
the plan's claim that it "handles the schema assertion" is simply false. 32
suites call `assertSchemaReady`, and `MIGRATION_071_RUN_SPINE` covers exactly the
`agent_runs`/`agent_run_steps` this suite reads. Added to `beforeAll`. A
behind-head container now fails loudly by name instead of surfacing as
`relation "agent_runs" does not exist` inside `afterAll` cleanup.

(The cited precedent `read.integration.test.ts` also omits it — so the precedent
is the outlier, not the rule.)

### S3 — REJECT

The reviewer flags it as waivable itself. The obvious split trades 12 duplicated
lines for 33, and the duplication is deliberate regression evidence (see the
plan's "Deliberate non-DRY" note). Should not be re-waived silently at #675.

### S4 — REJECT

`Promise<string | null>` is genuinely narrower, and the reviewer is right on the
principle. But the signature is plan-locked, survived three plan-review rounds,
and changing it ripples into the canonical-order binding test — which exists
precisely to catch positional drift in this INSERT. Not worth that churn
post-gate for a LOW design nicety. Recorded for #675.

### S5 — DEFERRED, and it may not be fixed here

`docs/directory.md` is **not** in `allowed_edit_surface`. Adding it would be the
**third** surface amendment, which per deviations D8 MUST trigger the step-5
abort path. Correct handling is step 8's `document-feature` sweep, not a quiet
fourth amendment.

## Carried to #675 (ship-time comments)

1. The **corrected** D4 statement — no race required.
2. Imported reviews (`status='new'`, no `responses` row) count as unanswered in
   `MonthlyImpactWorker.ts:168` and the `src/lib/kpi/*` response rate — same
   class as the D3 stalled-run catch, out of scope here. *(spec axis appendix)*
3. `CONTEXT.md` has no **Origin lane** entry, which map #667's reuse note #2
   cites and #678 depends on. *(carried from the pre-existing handoff)*
