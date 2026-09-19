# Handoff — WS6 staging drills, 2026-09-19

> **CLOSED 2026-09-19T03:18Z — the drills ran and PASSED.** Results:
> `2026-09-18-provider-moderation-corpus.md` § "WS6 staging smoke — run of
> 2026-09-19". Two facts below went stale during the run and are corrected
> there: the two `auto_approval_policies` rows belonged to an account that was
> offboarded at 01:51Z (D-1), and the admin unsuspend surface is the **Admin
> app** at `admin.staging.repworth.net/admin/autonomy`, not `/admin/autonomy` in
> this repo (D-4). This file is kept as the pre-run record.

A fresh session starts here. It never needs the prior transcript. Trust git and
the live environments over anything in this file; re-derive rather than copy.

## Where things are

**Shipped and merged today:** the Safety review (#1311), its prompt-precision
fix (#1312), the corpus lane (#1309), and a CI audit-test timeout fix (#1310).
`main` is at the #1312 merge. Staging is aligned to `main`.

**Open:** **PR #1313** (`chore/record-readiness-flag-flip`) — the ops record.
Worktree `../RepWorth-worktrees/fix-safety-review-prompt-precision`. It carries
the readiness flip, the staging chain flip, and the drill blockers. **It is
accurate and NOT yet merged.** The owner's condition was "merge if everything
passes"; the drills have not run, so it was left open deliberately.

**Corpus result, both environments, VERDICT: PASS** — 54/55, FP 1/41 (2.4%),
FN 0, injection misses 0. Evidence: `2026-09-18-provider-moderation-corpus.md`.
The one residual FP is the PROVIDER's (`safe-sensitive-11`, G4-F2), not the
Safety review's.

## Flag state — verified 2026-09-19, re-verify before acting

| Flag | staging worker | staging Vercel | production |
|---|---|---|---|
| `TRIAGE_ENABLED` | `true` | worker-only | unset |
| `ESCALATION_ENABLED` | `true` | `true` | unset |
| `JUDGE_ENABLED` | `true` | worker-only | unset |
| `GOVERNOR_ENABLED` | `true` | `true` | unset |
| `AUTO_APPROVAL_ENABLED` | `true` | `true` | **`false`** |
| `AUTOPILOT_PURCHASABLE` | `true` | `true` | `false` |
| `AUTO_APPROVAL_PROVIDER_MODERATION_READY` | `true` | `true` | `true` both lanes |

**Production is deliberately untouched apart from the readiness marker.** Do not
flip a production autonomy flag without a fresh, explicit instruction.

Read them back rather than trusting this table:
```bash
railway run --environment <env> --service repworth-worker -- node -e "for (const k of ['TRIAGE_ENABLED','ESCALATION_ENABLED','JUDGE_ENABLED','GOVERNOR_ENABLED','AUTO_APPROVAL_ENABLED','AUTOPILOT_PURCHASABLE']) console.log(k, JSON.stringify(process.env[k] ?? null));"
```

## The task

Run the WS6 staging smoke from `2026-07-13-ws6-judge-governor-design.md`
§ Rollout: **auto-post → judge verdict within minutes → forced-flag suspension
drill → admin unsuspend.** Then, if it passes, merge #1313 and update the
record.

### Blocker the owner is clearing

Staging had **no Autopilot account** — all five were `copilot`, and the gate
refuses every non-Autopilot draft with `autopilot_tier_required`
(`worker/jobs/response-generation/auto-approval.ts:371`). `judge_verdicts` was
0. **The owner said they would promote a Copilot account to Autopilot
themselves.** Confirm that landed before assuming the lane is reachable:

```bash
railway run --environment staging --service repworth-worker -- npx tsx <probe>
# SELECT subscription_tier, subscription_status, COUNT(*) FROM accounts GROUP BY 1,2
```

### The half that still cannot be forced

An auto-post needs a genuinely NEW review through live ingest, then triage,
moderation, the Safety review, the rating + daily-cap dial, and the 15/30-minute
veto window. A real Google review cannot be manufactured. Expect to either wait
for organic ingest on the connected staging location, or agree a seeded
substitute with the owner and **record it as a substitute, not as an organic
pass**.

### The half that IS runnable now

The suspension drill. Two `auto_approval_policies` rows exist, none suspended.
`suspendAccountAutonomy` / `unsuspendAccountAutonomy` in
`src/lib/auto-approval/suspension.ts` are the sole production writers. The
governor's own thresholds need 7 days and a min sample of 5
(`src/lib/auto-approval/governor.ts`), which is why the spec calls it a
**forced-flag** drill rather than waiting for a real breach.

The owner asked to drive the **admin unsuspend through Claude in Chrome** rather
than a direct call — that is the half that proves the operator surface, not just
the writer.

## Traps

- **The judge has a 60-second warm-up after any worker restart** (#949). Its
  liveness arm fails closed until `JudgeSweepPoller` writes a `judge_sweep`
  heartbeat. Auto-policy rows downgrade to owner review during it and **the
  downgrade is one-way**. Check the heartbeat before reading anything into a
  result, and never flip the flag back to "fix" it:
  ```sql
  SELECT poller_name, EXTRACT(EPOCH FROM (NOW() - last_cycle_at))::int AS age_seconds
  FROM poller_heartbeats WHERE poller_name = 'judge_sweep';
  ```
  Under 900 means available. No row means wait, do not flip back.
- **Every one of these flags is read on one or both lanes.** Setting Railway and
  forgetting Vercel leaves the two disagreeing. Trace the callers before
  deciding a flag needs both; triage and judge have no Next.js caller.
- **Vercel needs an explicit redeploy** to pick up an env change. `vercel env
  add <NAME> staging --value true --no-sensitive --force --yes` works, and
  **`vercel env add` CAN target a custom environment** on CLI 54.14.5 — the
  `OWNER_OPERATOR_ENABLED` note in `env-vars.md` claiming otherwise is stale.
- **Store flags non-sensitive.** A Sensitive value cannot be read back, so it
  cannot be verified.
- **Infisical is NOT a live mirror.** Its `staging` env holds zero secrets; its
  `prod` holds 59, missing every autonomy flag while still carrying
  `PAST_REPLIES_VIEW_ENABLED` (retired 2026-08-08). The owner is reconciling it
  separately. Do not write flags there expecting them to reach Vercel.
- **The operator's permission policy blocks some flag writes and deploys.** When
  it does, stop and surface it — do not route around it.

## Scratch probes (gitignored, in the worktree's `.feature/`)

`probe-safety.ts` (per-row safety verdict + concern),
`smoke-readiness.ts` (real accessors → real `buildAutoApprovalReadiness`),
`probe-judge-heartbeat.ts`, `probe-staging-data.ts`. They vanish with the
worktree; rewrite rather than hunt for them.

## Known follow-ups, filed not fixed

- The corpus report records **whether** the Safety review flagged a row but not
  **which concern** fired. Diagnosing six false positives needed a throwaway
  probe. Adding `concern` to each result row makes the next tuning pass cheap.
- 28 of 85 red-team inventory rows on the Safety review branch are unmeasured;
  all three rounds spent their budget and a fourth cannot open. No production
  hunk lacks a covering test.
- Two open P2 red-team findings (RT-16 runbook threshold wording, RT-17 a
  constant `disposition` label that survives all 70 covering cases).
