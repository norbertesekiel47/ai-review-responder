# Handoff — feat-678-reviews-list-generate

**Resume with:** `/feature-resume feat-678-reviews-list-generate`

Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-678-reviews-list-generate`
Branch: `feat-678-reviews-list-generate` (base `main` @ `13212b55`)

## Where we are

Step 3 (PLAN) — **round 1 complete: `VERDICT: REVISE`, 9 findings, all accepted and all revisions applied.** Plan, review report, and deviations file are committed.

**Next action: dispatch plan review round 2 (verification-only).** Run `bash scripts/feature-state.sh incr-round plan` FIRST (counter is at 1; it survives session resumes, and an uncounted round is how #628 reached round 5 under a "max 3" cap). Round 2 re-submits ONLY the findings-and-fixes delta — the reviewer verifies each of F1–F9 landed and may flag a defect a FIX introduced, but may NOT open new fronts against unchanged plan sections. Then set phase `plan_approved` and go to step 4.

### Dispatching codex — two traps that cost this session ~35 minutes

1. **Close stdin.** `codex exec --json "$(cat brief.md)"` hangs on `Reading additional input from stdin...` and burns the whole timeout. Always append `< /dev/null`, and run it with `run_in_background: true`.
2. **The JSONL schema is `{"type":"item.completed","item":{"type":"agent_message","text":…}}`** — NOT `.msg.type`. A `jq 'select(.msg.type=="agent_message")'` filter returns empty against a *finished* run and reads as "still running". Extract with:
   `python3 -c "import json,sys;[print(o['item']['text']) for o in map(json.loads,open(sys.argv[1])) if o.get('item',{}).get('type')=='agent_message']" <file>`
3. Codex may claim it ran `verify-gate.sh`. It did not — its sandbox declined the call (correctly; the gate drops the test DB schema). Never take that as gate evidence.

## Read these, in this order — never the prior transcript

| # | Artifact | Why |
|---|---|---|
| 1 | `.feature/intake.json` | The locked contract. Owner-signed. `allowed_edit_surface`, the **50** `tests_to_add` titles (verbatim — the gate matches literally), invariants, edge cases. |
| 2 | `docs/superpowers/plans/2026-08-08-feat-678-reviews-list-generate.md` | The plan. Tasks T1–T8, the task graph, and **"Design decisions taken during planning" D-A…D-H** — these are contract, not suggestion. |
| 3 | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §6.3a, §6.3b, §6.4 | Design of record. S1–S7 (surface), C1–C4 (cost policy). Locked by #671 / #672. |
| 4 | `CONTEXT.md` → **Reviews list**, **On-demand generation** | Glossary. Use these terms verbatim in code, commits, and tickets. |
| 5 | `docs/reviews/feat-678-reviews-list-generate/plan-round1.md` | Round-1 findings table + triage verdicts. |
| 5b | `docs/superpowers/plans/feat-678-reviews-list-generate-deviations.md` | D1–D5. **Read before step 6** — D1 carries a scope fence on `process-review.ts`. |
| 6 | `gh issue view 678` | Ticket + the four unblocking comments (#669 reuse map, #671 surface lock, #672 cost policy). |

## Ticket context

Leaf of wayfinder map #667, the **last implementation ticket** before the closing cleanup (#680). All four blockers (#675, #669, #671, #672) are resolved, so intent was locked at map level — this session grilled only the deltas.

## Classification

`RISK=high` · `SURFACE=mixed` · `db_touching=true` (no migration; set so the gate provisions the test DB for the live-schema suite).

High because: a new LLM-spend door adjacent to invariant #3, a new `generate_response` **Origin lane** consumed by `worker/jobs/response-generation/persist.ts`, and a feature-flag retirement.

**Ship lane: staging first, then PR to `main`, then PAUSE for explicit merge approval.**

## Deltas resolved in this session's grilling (owner-adjudicated)

All eight are written up as D-A…D-H in the plan. The ones most likely to be second-guessed:

- **D-C** — Generate polls a NEW `GET reviews/[reviewId]/draft-status`, not `past-replies/draft-status`. The existing one 503s when `EDIT_REPLIES_ENABLED` is off and keys on `outbox_id`, which a refresh loses; the locked "`Generating…` survives a refresh" behavior requires a `reviewId` key.
- **D-E** — the provenance badge is **four**-valued, not S3's three. `Replied on Google` covers an externally-answered review dated after activation. Owner-approved widening.
- **Budget affordance is IN scope** — owner chose to build `N of 3 today` on the Regenerate button, against the recommendation to defer it. One batched MGET (`peekRegenBudgetBatch`), answered rows only, fail-open to no counter.

## Corrections already applied to the plan — do not re-introduce

0. **The orphan query is GONE as a separate query** (F3). Under `LEFT JOIN` its `NOT EXISTS` disjointness guarantee is false, so every orphan review would render twice — once `generate`, once `recover` — and its un-offset `LIMIT 50` would merge into every page. The main query is now the single row source with the orphan data as a third LATERAL. The plan originally asserted the opposite; do not restore it.
0b. **`ORDER BY` carries `, r.id DESC`.** Without a total order, equal `review_date` values at an OFFSET boundary duplicate or drop rows across pages.
0c. **Moderation-held drafts never surface** as `ready` (poller) or `draft_ready` (list) — invariant #4. Use `hasOpenFlag`.
1. **Version is `COALESCE(MAX(version),0)+1`, never hardcoded `1`.** Verified: discard sets `status='superseded'` and RETAINS the row, so `MAX(version)` climbs and C1's per-review budget self-arms. Hardcoding `1` creates an unbounded free-regeneration loop.
2. **No separate offboarding check in the Generate route.** `assertWritableSubscriptionForAccount` already resolves offboarding in the same query and returns `403 account_offboarding_blocked`. A second `getOffboardingState` call is a duplicate round trip and a second spelling of a one-owner guard. (Found during this session's own cited-artifact check, before codex reported.)

## Cited-artifact check — verified on disk this session

`persist.ts:86-90` `isAutoApprovalCandidate` ✓ (exact predicate) · `job-outbox-status.ts` ✓ · `statusArraySql` ✓ · `APPROVAL_METHOD.{OWNER,AUTO_POLICY}` ✓ · `assertWritableSubscriptionForAccount` ✓ · `getOffboardingState`/`isProcessingBlocked` ✓ · `enqueueGenerateResponse(tx, input)` ✓ · `QUEUE_NAMES.GENERATE_RESPONSE` ✓ · no `origin_lane` CHECK in `supabase/migrations/` ✓ · cache client is `ioredis` so `.mget()` is available ✓.

## Next steps

1. `bash scripts/feature-state.sh incr-round plan`, then dispatch round 2 (verification-only) against the "Round-1 revisions" section at the foot of the plan. Brief it to confirm F1–F9 landed and to flag only defects a FIX introduced.
2. On `APPROVED`: `bash scripts/feature-state.sh set-phase plan_approved`, then step 4. Hard stop after round 3 — surface the remaining disagreement to the owner; their call substitutes for APPROVED.
3. Step 4 dispatch order: **T1 alone** (mandatory first-task enforcement spot check — diff `git status --porcelain` against `allowed_edit_surface`; any out-of-surface file means STOP), then **T2 / T4 / T6 in parallel** (disjoint files, no edges), then T3 and T5, then T7, then T8.
4. Step 5 gate: `scripts/verify-gate.sh`, and `--review` for the last run before step 7. **`TEST_DATABASE_POOL_URL` must be set** — a SKIP row on the integration suite makes the gate non-review-ready for this DB-touching branch.

## Budgets

- Plan review rounds: **1 of 3 used**.
- `allowed_edit_surface` amendments: **1 of 2 USED** (deviations D1 — the flags.ts collapse needed 6 out-of-surface files). **A second amendment trips the abort criteria** — there is no slack left. Test-title changes and `verification_commands` fixes are deviations-file entries, NOT amendments.
- Gate-fail rounds: 0 of 3.
- `tests_to_add`: **37 → 50 titles** (D3). Both intake copies updated and verified byte-identical.
- Estimates deliberately NOT re-padded despite the scope growth (D4) — 900 prod / 1100 test stand. If the trigger fires, that is the control working.

## Watch items for step 7

- `worker/jobs/response-generation/**` **production** files are outside the surface — only `__tests__/**`. If a reviewer argues `persist.ts` needs a change, that is an amendment, and it contradicts the ticket's "do NOT add a second auto-approval guard".
- The in-flight status literal `('pending','dispatching','dispatched')` is re-spelled by hand in two new places (the route guard, the list LATERAL). `ci:outbox-status` checks members **and order**.
- The new live-DB suite must be `*.integration.test.ts`, must NOT apply migration SQL, and must call `assertSchemaReady` (`ci:live-db-suites`).
- C4 (`DAILY_COST_LIMIT_CENTS_COPILOT` / `_AUTOPILOT` still unset) is a non-goal here but must be carried into the PR body so the ticket does not close believing the ceiling question is settled operationally.
