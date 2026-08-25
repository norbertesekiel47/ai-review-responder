# Plan review round 1 — triage

**Reviewer:** codex, thread `01a0353b-3877-78d3-858a-c36c8fc5b35a` (read-only)
**Verdict:** `REVISE`
**Full report:** `plan-round1-codex.md`
**Round counter:** `planReviewRounds=1`

A strong review. It found five defects the orchestrator had not, and it
independently re-derived the enqueue-guard defect the orchestrator found while
the review ran. Its "mandatory artifact resolution" section is accepted in full
and confirms the four corrections already applied to the plan (D3, D4, D5, and
the `'r.'` prefix).

Three claims were verified against the code before accepting:

- `markOutboxCompleted` / `markOutboxCompletedIfOwned` in `src/lib/shared/outbox.ts:70-114` — **confirmed**, the plan's worker never completes its row.
- `processReview` is at `src/lib/reviews/process-review.ts:36`; `importReview` is at `:515` — **confirmed**, the plan's "both entry points" instruction would have wired the excluded backfill lane.
- `assertSchemaReady` lives in `@/lib/shared/__tests__/helpers/schema-ready`; the live precedent suite is `approval-system-halt.integration.test.ts`, not `batch-view.integration.test.ts` — **confirmed**.

---

## ACCEPTED — code and schema defects

| # | Finding | Fix |
|---|---|---|
| A1 | The worker never completes its `job_outbox` row; the watchdog redispatches it until failure. | Call `markOutboxCompletedIfOwned(tx, outboxId, attempt)` INSIDE `attributeReview`'s transaction, before the domain write, using `extractOutboxHandle(job.data, job.id)`. A `false` return means a stale attempt lost the race — perform no mutation. |
| A2 | The enqueue is wired into `importReview`, which the intake's non-goals exclude. | `processReview` (line 36) **only**. `importReview` (line 515) gets nothing. Add the negative test. |
| A3 | Deleting an attributed review makes the Outreach row a candidate again, and the next match overwrites retained provenance. | The "already attributed" marker becomes **`attributed_at`**, never `attributed_review_id` — `attributed_at` is never nulled by the FK. Change the candidate predicate, the guard, and the partial index predicate together. |
| A4 | `(business_id, attributed_review_id)` lets one review attribute once **per business**. | Unique index on `(attributed_review_id)` alone. Review ids are globally unique. |
| A5 | The exact 14-day boundary is excluded; the intake excludes only "**more than** 14 days". | `sent_at >= anchor - interval` (was `>`). Add the boundary test. |
| A6 | `listAttributedReviews` joins `reviews` by id alone, so a schema-valid cross-business link would leak foreign review text. | Add `AND r.business_id = o.business_id` to the join. |
| A7 | `TIMESTAMPTZ` columns typed as `string`; Postgres.js decodes them to `Date`. | Type the row shapes as `Date`, or select `::text`. Pick one and hold it across the module. |
| A8 | The vitest command for `job-outbox-helpers.test.ts` selects the `integration` project; that suite is a mocked unit suite. | Split the command: unit run for the mocked helper suite, integration run for the live guard behaviour. |
| A9 | Cited index name `job_outbox_solicitation_veto_notice_inflight` does not exist. | Real name is `idx_jo_solicitation_veto_notice_inflight`. Fix the citation. |
| A10 | Cited fixture precedent `batch-view.integration.test.ts` has no `assertSchemaReady` and exports no fixtures. | Cite `approval-system-halt.integration.test.ts` and `@/lib/shared/__tests__/helpers/schema-ready`. |

## ACCEPTED — the eval task is the real problem

| # | Finding | Fix |
|---|---|---|
| A11 | 18 of 26 titles are `.todo`. Vitest reports success; `promised-tests` only greps title text. Task 0's gate is vacuous. | Add an **eval-contract test** that reads the suite files and fails if ANY promised title is still `.todo`, `.skip` or `.fails`. It stays red until the last task lands, which is exactly its job. |
| A12 | Property 1 is a circular oracle — it calls `matchAttribution` to decide what should have matched, and passes vacuously whenever the multi-candidate call abstains. | Replace with a test-side oracle that computes expected hits without calling the production matcher or normalizer. |
| A13 | Idempotency is tested only as two sequential `attributeReview` calls. | Add: concurrent handler replay, duplicate enqueue leaves one in-flight row, outcome-write failure rolls back the columns. |
| A14 | Nothing pins that the review INSERT and the outbox row commit together, nor that a matcher failure cannot roll back a committed review. | Two tests at the real call site. |
| A15 | Nothing pins tenant isolation across crossed account/business/review/outreach ids. | One crossed-id test over the helper, the matcher and the read model. |
| A16 | Nothing pins the outcome onto the terminal **Lazy child** rather than the parent. | Seed both runs; assert the exact `agent_run_id`, persona and `unit_count`. |
| A17 | Nothing pins "no billing": no `api_costs`, no Stripe, no metered usage. | Snapshot billing tables and mocks around a successful attribution. |
| A18 | Nothing pins worker registration, the PII-free log line, `enabled: false` rendering nothing, one-star parity in the UI, the 30-day negative control, the route's gate ordering, or `RequestsClient` actually mounting the section. | Seven tests, one per gap. |
| A19 | The migration shape test checks names only, not definitions, and omits the new outbox index. | Assert index definitions and predicates, including `job_outbox_solicitation_attribution_inflight`. |

## ACCEPTED — contract drift

| # | Finding | Fix |
|---|---|---|
| A20 | `src/lib/shared/worker-types.ts` is outside `allowed_edit_surface`. | **Surface amendment #1.** One file inside `src/lib/shared/`, a tree the surface already covers via `queue-names.ts` and `job-outbox-helpers.ts` — auto-approved under step 2's rule. Update BOTH intake copies. **A second amendment triggers re-classification.** |
| A21 | `rollback_plan` names `attribution_score` and two indexes; the plan builds `attribution_rule` and three. | Correct the intake's `rollback_plan`. Intake-field correction, not an amendment. |

## ACCEPTED WITH A CHANGED EXPECTATION

| # | Finding | Resolution |
|---|---|---|
| A22 | The guard over-enqueues when a business's only sent rows are outside the review's anchor-relative window, contrary to intake edge case 9. | The finding is correct; the intake's wording was. A guard cannot be both **lossless** and **exactly window-scoped** without duplicating the anchor logic in shared code. Losslessness wins: a missed attribution is a wrong metric, a wasted job is a no-op that logs `no_candidates`. Edge case 9 is reworded to what the guard actually promises — *"the business has never sent an ask → no outbox row"*. Codex's test is added with the **corrected** expectation: out-of-window-only **does** enqueue and resolves `no_candidates`. |

## REJECTED

| # | Finding | Reason |
|---|---|---|
| R1 | "Required skills `subagent-driven-development` and `executing-plans` are not present in the repository or installed skill catalog." | Both are present in the orchestrating harness's skill catalog. Codex cannot enumerate that catalog from a read-only repo checkout, so this is a false negative about the environment, not about the plan. No change. |
| R2 | (Implicit in A4/A6) Bind review and outreach businesses with a composite FK. | `reviews` carries no `(id, business_id)` unique constraint, so a composite FK would require adding one to a core table for a shadow metric. The scoped join predicate (A6) closes the read path at zero schema cost. Recorded rather than silently dropped. |

---

## Consequence for classification

The accepted findings add roughly **24 tests** to the 26 promised, and no
material production lines. Re-estimating honestly: production stays near
**1,050**; tests move from **2,400** toward **3,800–4,200**.

That is ~1.7× the test estimate — under step 5's 2× per-bucket trigger, but not
by much, and one surface amendment is already spent. The orchestrator does NOT
revise `estimated_test_lines` upward to buy headroom: moving the estimate after
seeing the work is how the trigger gets defeated. The original numbers stand,
and step 5's `reclassify` row decides on the real diff.
