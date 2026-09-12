# Deviations — feat/owner-operator-run-b

Every entry is something the locked intake or the plan did not anticipate. The step-6 read-back gives each a **Verdict:** line (ACCEPT or RE-PLAN) before the review wave dispatches.

## Surface amendment #1 — 2026-09-12, plan review (root)

- **What:** the Operator page moves from `src/app/(authenticated)/operator/` to `src/app/(authenticated)/dashboard/operator/` (URL `/dashboard/operator`), and `src/components/dashboard/shell/__tests__/*.ts` joins the surface.
- **Why:** proxy branch 7 (`src/proxy.ts:366-385`) hardcodes `/dashboard`, `/settings`, `/account` as the owner-page prefixes that get the login redirect, the role check and the AAL2 gate, and `src/proxy.ts` is outside the surface. A top-level `/operator` would render for an AAL1 owner under MFA enforcement while every `/api/operator` call answered 403 (plan V3). Under `/dashboard/` the page rides branch 7 with no proxy change and matches every other owner feature. The `shell/__tests__` entry lets the `'operator'` `NavSection` case land in the existing `active-nav.test.ts` instead of a duplicate sibling test file (plan V4).
- **Owner decision:** "Move the page to /dashboard/operator" (AskUserQuestion, 2026-09-12). Spec §3.1's route line is corrected in T6 with the Island→Console correction.
- **Counted:** `feature-state.sh incr-amendment` (#1, auto-approved as the first).
- **Verdict:** ACCEPT

## Baseline gate on the untouched tree — 2026-09-12 (root, before T0)

- **What:** `verify-gate.sh --baseline` at `6edacd0b0` + docs is RED on two rows only: `feature-surface` (every new-file entry matches nothing yet — expected before T0 lands, per `ci:feature-surface`'s own message) and `pnpm test:e2e` (16 failures, all `e2e/admin-14b-runtime.spec.ts` / `admin-14c-runtime.spec.ts`).
- **Why the e2e row is red:** environmental, not a Run B defect. The admin login page throws `ADMIN_APP_URL must be a configured HTTP(S) origin…` (`src/lib/config/admin-app-url.ts:8`) because the local environment has no `ADMIN_APP_URL`; CI's e2e job sets `ADMIN_APP_URL: https://admin.example.invalid` (`.github/workflows/e2e.yml:44`, `:87`). The other 28 e2e cases pass; 116 self-skip (auth harness).
- **Correction (verification command, not a surface change):** every gate run in this worktree exports `ADMIN_APP_URL=https://admin.example.invalid` in the gate's environment so the Playwright web server inherits it, exactly as CI does. No repo file changes.
- **Verdict:** ACCEPT

## Codex plan round 1 — 2026-09-12 (root)

- **What:** Codex returned REVISE with 11 findings (RB-01…RB-11), all verified against source and ACCEPTED; the planner is revising the plan. Ten new `tests_to_add` titles were added to BOTH intake copies (an intake correction, not a surface change; the surface is unchanged). The findings are archived at `~/.claude/grill-codex/run-b-2026-09-12/round-1-findings.json`.
- **Runner note:** the runner marked the round `failed` because the worktree's Codex Stop hook blocked Codex's turn on the red baseline gate (feature-surface entries cannot match before T0), after which Codex emitted a final JSON with an empty findings list; the complete review was recovered from the event log (`stdout.txt`). No session id was recorded, so a verification round cannot resume — it starts fresh with the findings-and-fixes delta in its brief, and its review is recovered the same way if the hook blocks again. The hooks stay as they are.
- **Verdict:** ACCEPT
