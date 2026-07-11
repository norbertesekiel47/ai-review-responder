# WS7 — Eval-in-CI: path-filtered `pnpm eval:llm` gate

**Date:** 2026-07-07
**Parent:** `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §5.1 item 1;
decomposition row WS7 in `docs/superpowers/plans/2026-07-01-agentic-platform-phase1-run-spine.md`.

## Scope

Add one CI job to `.github/workflows/ci.yml` that runs the offline LLM safety
eval (`pnpm eval:llm`) whenever a PR touches prompts, policy logic, pinned model
IDs, or the eval harness itself — and blocks the PR when any eval row fails.
No changes to the harness, its thresholds, or the eval set.

## What the offline eval actually gates

`pnpm eval:llm` (`tests/llm-eval/run.ts`) in default offline mode scores each
canned candidate in `eval-set.jsonl` through the **production output filter**
(`src/lib/moderation/output-filter.ts`) and exits non-zero if any row's
decision severity exceeds `expect.maxSeverity` or a forbidden category appears.
It is deterministic and keyless (CI runs `MOCK_EXTERNAL_APIS=false`; the
offline path makes no external calls at all).

Offline, the job therefore catches regressions in **moderation/output-filter
policy logic** and **eval-set/scorer consistency**. Prompt-builder and
model-pin changes trigger the run as an early-warning consistency gate, but a
true prompt-*quality* regression only surfaces in `--live` mode — that remains
the deferred weekly external gate documented in `tests/llm-eval/README.md`.

## Path filter (derived from what the harness exercises)

| Path | Why |
|---|---|
| `tests/llm-eval/**` | Harness, scorer, loader, eval set — the gate's own truth. |
| `src/lib/moderation/**` | `runOutputFilter` is the offline scoring engine; its rules ARE the policy under test. |
| `src/lib/responses/**` | Prompt builder/generator, `prompt-policy.ts` (prompt + policy version hash), review-summary — the "prompts / policy logic" of the requirement; `live-runner.ts` imports `generator.ts`. |
| `src/lib/llm/**` | Task seam + pinned model IDs (`tasks.ts`) — the "pinned model IDs" of the requirement. |
| `.github/workflows/ci.yml` | Changes to the job itself must prove the eval still passes. |

## Job design — always-run + internal change detection

Branch protection is the "main protection" **ruleset** (required checks today:
`lint`, `typecheck`, `test`, `build`, `deploy-install`). A `paths:`-filtered
workflow that never triggers would leave a required check pending forever, so
the job instead **always runs** and no-ops fast when nothing watched changed —
making it safely addable to the ruleset:

1. Checkout with `fetch-depth: 0` on `pull_request` only (history needed for
   the merge-base diff); pushes to `main` never diff, so they keep the default
   shallow clone.
2. Detect step: on `pull_request`,
   `git diff --name-only <base.sha>...<head.sha>` (three-dot = merge-base of
   base and PR head vs PR head — exactly the files this PR changes) grepped
   against the watched-path regex. On `push` to `main`, always run — trunk
   regressions must be visible and the offline eval costs seconds.
3. If watched paths changed: `./.github/actions/setup` + `pnpm eval:llm`.
   Otherwise: skip setup entirely (no install) and exit green with a log line.

Plain `git diff` is used instead of `dorny/paths-filter` — no new third-party
action to pin, and the logic is one grep.

Blocking: any failed eval row → non-zero exit → job fails → PR blocked once
`llm-eval` is added to the ruleset's required checks. **Follow-up (post-merge,
not in this PR):** add `llm-eval` to the "main protection" ruleset — adding it
before the job exists on `main` would hang unrelated PRs on a never-reporting
check.

## Verification

- `pnpm eval:llm` offline on `main`: 8/8 pass, exit 0 (verified 2026-07-07).
- Regression simulation: temporarily poison one `candidate` in
  `eval-set.jsonl` → run exits 1 → revert.
- Detection simulation: run the detect script's diff+grep locally against a
  synthetic watched change and an unwatched change.
- `pnpm lint && pnpm typecheck` in the worktree (pre-push hook parity).
- Watch the PR's own CI run: `llm-eval` must run (this PR touches `ci.yml`,
  a watched path) and pass.

## Review amendments (2026-07-11, PR #462 external review)

- **Diff semantics:** the original two-dot `base.sha..HEAD` compared trees
  against the base-branch tip (HEAD on `pull_request` is the test merge
  commit, whose tree already contains main's tip), so a PR behind `main`
  would also see files changed *on main* since its branch point and
  over-trigger the eval on unrelated PRs. Fixed to three-dot
  `base.sha...head.sha` (merge-base semantics) against
  `github.event.pull_request.head.sha` — note that three-dot against the
  merge commit would NOT have fixed it, since `merge-base(base.sha, merge
  commit)` is `base.sha` itself.
- **Checkout cost:** `fetch-depth: 0` now applies only on `pull_request`
  events (inline ternary; quoted `'0'`/`'1'` because a bare `0` is falsy in
  workflow expressions). Pushes to `main` skip the diff entirely and use the
  default shallow clone.
