# Handoff — `feat-695-import-consent-block-reason`

**Written at the step 3→4 boundary, 2026-08-08.** A resumed session bootstraps from
this file and never needs the prior transcript.

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-695-import-consent-block-reason`
**Phase:** `plan_approved` (`.feature/state.json`) · **Plan review rounds:** 3

## Where everything lives

| Artifact | Path |
|---|---|
| Issue | GitHub #695 (`gh issue view 695`) |
| Intake contract (locked, amended once) | `docs/superpowers/plans/feat-695-import-consent-block-reason-intake.json` |
| Plan (APPROVED) | `docs/superpowers/plans/2026-08-08-import-consent-block-reason.md` |
| Deviations + triage | `docs/superpowers/plans/feat-695-import-consent-block-reason-deviations.md` |
| Plan reviews (3 rounds) | `docs/reviews/feat-695-import-consent-block-reason/plan-review-round{1,2,3}.md` |
| Spec (the locked decision being re-affirmed) | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.3 |
| Glossary terms | `CONTEXT.md` → **Import consent**, **Review import**, **Import offer** |

Read those files. This handoff deliberately does not restate them.

## State

- **Step 3 complete.** Codex plan review reached `VERDICT: APPROVED` at round 3
  (session `019fe2ec-c789-7032-9b55-3b923267404f`, resumable via
  `codex exec resume 019fe2ec-c789-7032-9b55-3b923267404f`). Rounds 1 and 2 each
  returned `REVISE`; every accepted finding is fixed in the plan and every rejected
  one is reasoned in the deviations file.
- **No implementation has started.** No production file has been touched. The only
  commits on this branch are the intake installs.
- **`allowed_edit_surface` amended once** (D1, owner-approved): added
  `worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts`.
  **A second amendment triggers the step-5 abort criteria.**

## Next action — step 4

Set the phase (`bash scripts/feature-state.sh set-phase executing`), then dispatch
per `subagent-driven-development`, following the plan's blocking edges:

```
T1 (eval, ALONE — first-task enforcement spot check)
  → T2 ∥ T4   (mutually independent: disjoint files, no edge)
       T2 → T3
  {T3, T4} → gate
```

After T1 completes, diff `git status --porcelain` against `allowed_edit_surface`
before dispatching anything else. An out-of-surface path means the guard did not
bind for subagent tool calls — STOP and report.

Every subagent prompt must carry: the `CONTEXT.md` **Import consent** excerpt, its
task slice, the `existing_patterns_to_follow` paths, and the failing test titles it
turns green. The plan's task bodies contain the actual code — do not paraphrase them.

## Three things a fresh session will otherwise get wrong

1. **`TEST_DATABASE_POOL_URL` must be set.** `db_touching: true` with **no
   migration** — `job_outbox.completion_reason` has existed since migration 083.
   The two most load-bearing tests on this branch are live-DB only (the persisted
   `owner_unreachable` value; the four persisted `import_consent_blocked`
   assertions). A gate carrying the live-DB SKIP warning is not review-ready.
2. **The branch is intentionally red between T1 and T2** and does not typecheck —
   `markOutboxCompletedWithReason` does not exist until T2. That is what the failing
   eval means here; do not "fix" it by stubbing the helper in T1.
3. **`markOutboxOwnerUnreachable` has TWO references, not one.** `NotificationWorker.ts`
   *and* the failover poller's integration suite (import at line 55, calls at 365/373,
   plus a header-comment mention at line 4). `tsconfig.json` includes `**/*.ts`, so a
   missed test-file reference breaks `pnpm typecheck` exactly as hard as a source one.
   This was round-1's blocker.

## Ship lane (step 8)

RISK = high → **staging first**, then PR to `main`, then pause for explicit merge
approval. No migration to apply in lockstep.
