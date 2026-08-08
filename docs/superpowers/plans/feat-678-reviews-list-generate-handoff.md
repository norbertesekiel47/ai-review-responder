# Handoff — feat-678-reviews-list-generate

**Resume with:** `/feature-resume feat-678-reviews-list-generate`

Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-678-reviews-list-generate`
Branch: `feat-678-reviews-list-generate` (base `main` @ `13212b55`)

## Where we are

Step 3 (PLAN) is **COMPLETE**. Round 3 returned `VERDICT: APPROVED` (0 findings) —
all three rounds are spent and the plan is locked. Phase: `plan_approved`.

**Next action: step 4 (EXECUTE).** Run `bash scripts/feature-state.sh set-phase executing`,
then dispatch per `subagent-driven-development` in the order under "Next steps" below.

Reports: `docs/reviews/feat-678-reviews-list-generate/plan-round{1,2,3}.md`.

### THE recurring defect on this branch — check this first, always

**Four of nine round-1 fixes never reached a checkbox.** They were written into the
`# Round-1 revisions` appendix, which reads as "addressed" at every later checkpoint
because the plan demonstrably *discusses* the fix:

- **F3** — caught by the orchestrator pre-round-2 (`6c93de6d`). Step 1's SQL had no
  orphan LATERAL and the Self-review still described the pre-fix design.
- **F5, F8, F9** — caught by round 2. Poller still returned held drafts as `ready`;
  Task 8 Step 4 grepped `docs/` and never edited the three live refs; Task 1 created
  no integration suite.

Written up as deviations **D7**, and it is a `/feature` workflow lesson, not a #678
one — **promote to lab-notes at step 8**.

**The test to apply, every time:** *if a subagent executes only the checkboxes of
the owning task, does the fixed behaviour result?* Never "does the plan say it?".

### Round-2 outcomes that change the shape of the work

- **`held` is a sixth `ReviewRowState`** (D9) — the five-state union had no correct
  configuration for a moderation-held draft: filtered → `generate` (offers an LLM
  spend the partial unique index then rejects), kept → `draft_ready` (surfaces held
  text). **Adds a user-visible state the owner-signed intake does not name** —
  ratification pending, nothing blocks on it. `Under review` is the label most open
  to owner preference.
- **`hasOpenFlag` is NOT usable on the read paths** (D6) — it is
  `(tx: TransactionSql, …)`, an in-tx post-`FOR UPDATE` release gate, and
  `held-draft.ts` is **outside the surface** (a helper there burns amendment 2 of 2
  → abort criteria). Both new sites spell the `EXISTS` inline. Do not "fix" this.
- **Orphan field mapping** (round-2 Defect A) — F3's deletion of `toOrphanCardRow`
  must carry its mapping into `toCardRow`, or `PastReplyCard:157,201` classifies a
  row `recover` and then renders no recovery affordance.

### Dispatching codex — two traps that cost this session ~35 minutes

1. **Close stdin.** `codex exec --json "$(cat brief.md)"` hangs on `Reading additional input from stdin...` and burns the whole timeout. Always append `< /dev/null`, and run it with `run_in_background: true`.
2. **The JSONL schema is `{"type":"item.completed","item":{"type":"agent_message","text":…}}`** — NOT `.msg.type`. A `jq 'select(.msg.type=="agent_message")'` filter returns empty against a *finished* run and reads as "still running". Extract with:
   `python3 -c "import json,sys;[print(o['item']['text']) for o in map(json.loads,open(sys.argv[1])) if o.get('item',{}).get('type')=='agent_message']" <file>`
3. Codex may claim it ran `verify-gate.sh`. It did not — its sandbox declined the call (correctly; the gate drops the test DB schema). Never take that as gate evidence.

## Read these, in this order — never the prior transcript

| # | Artifact | Why |
|---|---|---|
| 1 | `.feature/intake.json` | The locked contract. Owner-signed. `allowed_edit_surface`, the **52** `tests_to_add` titles (verbatim — the gate matches literally), invariants, edge cases. |
| 2 | `docs/superpowers/plans/2026-08-08-feat-678-reviews-list-generate.md` | The plan. Tasks T1–T8, the task graph, and **"Design decisions taken during planning" D-A…D-H** — these are contract, not suggestion. |
| 3 | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §6.3a, §6.3b, §6.4 | Design of record. S1–S7 (surface), C1–C4 (cost policy). Locked by #671 / #672. |
| 4 | `CONTEXT.md` → **Reviews list**, **On-demand generation** | Glossary. Use these terms verbatim in code, commits, and tickets. |
| 5 | `docs/reviews/feat-678-reviews-list-generate/plan-round1.md` | Round-1 findings table + triage verdicts. |
| 5a | `docs/reviews/feat-678-reviews-list-generate/plan-round2.md` | Round-2 table + the two fix-introduced defects. |
| 5b | `docs/superpowers/plans/feat-678-reviews-list-generate-deviations.md` | D1–D9. **Read before step 6** — D1 carries a scope fence on `process-review.ts`; D6/D9 are round-2 shape changes. |
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
0c. **Moderation-held drafts never surface** as `ready` (poller) or `draft_ready` (list) — invariant #4. They resolve to the sixth state `held` (D9). Do NOT reach for `hasOpenFlag`: it is `(tx: TransactionSql, …)` and `held-draft.ts` is out of surface — both sites spell the `EXISTS` inline (D6).
1. **Version is `COALESCE(MAX(version),0)+1`, never hardcoded `1`.** Verified: discard sets `status='superseded'` and RETAINS the row, so `MAX(version)` climbs and C1's per-review budget self-arms. Hardcoding `1` creates an unbounded free-regeneration loop.
2. **No separate offboarding check in the Generate route.** `assertWritableSubscriptionForAccount` already resolves offboarding in the same query and returns `403 account_offboarding_blocked`. A second `getOffboardingState` call is a duplicate round trip and a second spelling of a one-owner guard. (Found during this session's own cited-artifact check, before codex reported.)

## Cited-artifact check — verified on disk this session

`persist.ts:86-90` `isAutoApprovalCandidate` ✓ (exact predicate) · `job-outbox-status.ts` ✓ · `statusArraySql` ✓ · `APPROVAL_METHOD.{OWNER,AUTO_POLICY}` ✓ · `assertWritableSubscriptionForAccount` ✓ · `getOffboardingState`/`isProcessingBlocked` ✓ · `enqueueGenerateResponse(tx, input)` ✓ · `QUEUE_NAMES.GENERATE_RESPONSE` ✓ · no `origin_lane` CHECK in `supabase/migrations/` ✓ · cache client is `ioredis` so `.mget()` is available ✓.

## Next steps

1. ~~Plan review~~ — CLOSED, `APPROVED` at round 3. Next: `set-phase executing`, then dispatch T1.
2. On `APPROVED`: `bash scripts/feature-state.sh set-phase plan_approved`, then step 4. Hard stop after round 3 — surface the remaining disagreement to the owner; their call substitutes for APPROVED.
3. Step 4 dispatch order: **T1 alone** (mandatory first-task enforcement spot check — diff `git status --porcelain` against `allowed_edit_surface`; any out-of-surface file means STOP), then **T2 / T4 / T6 in parallel** (disjoint files, no edges), then T3 and T5, then T7, then T8.
4. Step 5 gate: `scripts/verify-gate.sh`, and `--review` for the last run before step 7. **`TEST_DATABASE_POOL_URL` must be set** — a SKIP row on the integration suite makes the gate non-review-ready for this DB-touching branch.

## Budgets

- Plan review rounds: **3 of 3 used — CLOSED** (REVISE, REVISE, APPROVED). No further plan review.
- `allowed_edit_surface` amendments: **1 of 2 USED** (deviations D1 — the flags.ts collapse needed 6 out-of-surface files). **A second amendment trips the abort criteria** — there is no slack left. Test-title changes and `verification_commands` fixes are deviations-file entries, NOT amendments.
- Gate-fail rounds: 0 of 3.
- `tests_to_add`: **37 → 50 (D3) → 52 (D8)**. Both intake copies verified byte-identical at each step (`989ef287…`).
- Estimates deliberately NOT re-padded despite the scope growth (D4) — 900 prod / 1100 test stand. If the trigger fires, that is the control working.

## Watch items for step 7

- `worker/jobs/response-generation/**` **production** files are outside the surface — only `__tests__/**`. If a reviewer argues `persist.ts` needs a change, that is an amendment, and it contradicts the ticket's "do NOT add a second auto-approval guard".
- The in-flight status literal `('pending','dispatching','dispatched')` is re-spelled by hand in two new places (the route guard, the list LATERAL). `ci:outbox-status` checks members **and order**.
- The new live-DB suite must be `*.integration.test.ts`, must NOT apply migration SQL, and must call `assertSchemaReady` (`ci:live-db-suites`).
- C4 (`DAILY_COST_LIMIT_CENTS_COPILOT` / `_AUTOPILOT` still unset) is a non-goal here but must be carried into the PR body so the ticket does not close believing the ceiling question is settled operationally.

## Step 7 review — round 1 dispatch record (2026-08-08)

Branch review round **1 of 3** counted in `.feature/state.json` before dispatch.
Gate green at `b0fed111` (only the owner-ruled `reclassify` WARN). Fork point
`13212b5588b96de2a5c8fcd0430cc95d70271e50`.

| Axis | Report | Notes |
|---|---|---|
| Spec & correctness | `docs/reviews/<branch>/branch-round1-spec.md` | in-session subagent |
| Standards & maintainability | `docs/reviews/<branch>/branch-round1-standards.md` | in-session subagent |
| Adversarial approach | `docs/reviews/<branch>/branch-round1-adversarial.md` | **codex background task** |

**Codex task identifiers — recorded because the companion wrapper has lost task
ids across session resumes** (that is why the workflow asks for them in writing):

- task id: `task-mskqg6zk-w7gm8q`
- thread id: `019fe2b9-f8fc-7f52-ad32-1e828d018b37`
- job state: `~/.claude/plugins/data/codex-openai-codex/state/feat-678-reviews-list-generate-6d13de13047c5472/jobs/task-mskqg6zk-w7gm8q.{json,log}`
- poll with `jq -r .status <that>.json` — `running` → `completed`

**⚠️ The wrapper granted this task `write: true`** despite a read-only brief. Tree
snapshot taken at dispatch so an unsanctioned edit is detectable rather than
silent: `HEAD=b0fed111`, `tree=4d58034fb469952f86ee7669e0a559fcb5ec2977`, working
tree clean except the untracked `blast-radius.md`. Re-check `git status
--porcelain` and the tree hash when it reports; anything else it touched must be
reverted, not reviewed-and-kept — a review agent's edits have not been through
the gate.

---

## `PAST_REPLIES_VIEW_ENABLED` — captured values (Task 8 Step 1, 2026-08-08)

Captured **before** the deletion landed, per the intake's `rollback_plan`. Copy
this table into the PR description — it is the revert precondition.

| Surface | Environment | `PAST_REPLIES_VIEW_ENABLED` | `EDIT_REPLIES_ENABLED` |
|---|---|---|---|
| Vercel | Production | `true` | **absent** |
| Vercel | Preview | **absent** | **absent** |
| Vercel | Staging (Custom Env) | `true` | `true` |
| Railway `repworth-worker` | production | **absent** | **absent** |
| Railway `repworth-worker` | staging | `true` | `true` |

### The merge is behaviour-neutral in every environment — verified, not assumed

The capture exists to answer one question the plan never asked outright: today
the worker's `replyEditingFlagEnabled()` is the **composite** `EDIT && VIEW`, and
after retirement it becomes `EDIT` alone. Any environment with `EDIT=true` and
`VIEW=false` would therefore have its publisher DELETE-then-POST edit branch —
a **live Google mutation** — switch from inert to active on merge, silently.

No environment is in that state:

- **Railway production**: both absent → composite false today, `EDIT` false after. Inert before and after.
- **Vercel production**: `VIEW=true`, `EDIT` absent → edit routes false today (composite) and false after (`EDIT` alone). The list page was already reachable, and becomes unconditionally reachable. No change.
- **Staging (both surfaces)**: both `true` → composite true today, `EDIT` true after. No change.
- **Vercel preview**: both absent → nothing gated on either.

### Two facts worth carrying into the PR

1. **The registry was stale.** `.claude/reference/env-vars.md:526` documented `PAST_REPLIES_VIEW_ENABLED` as *"Off (code-complete on `feat/past-replies-view`, 2026-05-02)"*, but Vercel Production has held `true` for ~49 days. Task 8 deletes the row, so the staleness dies with it — but it is a reminder that the registry's "current value" column drifts and is not evidence of deployed state.
2. **Revert exposure is preview-only.** Reverting this PR restores the flag *read*, and the env var must exist before the reverted build boots or the list 404s. Production and staging both carry it on both surfaces, so a revert is safe there. **Vercel Preview does not** — a revert would 404 the Reviews list on preview deploys until the var is added. Not a blocker; a note for whoever reverts.
