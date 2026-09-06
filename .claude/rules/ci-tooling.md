---
paths:
  - ".github/workflows/**"
  - "lefthook.yml"
  - "scripts/ci/**"
  - "package.json"
---

# CI and tooling rules

## Read first

- `.claude/CLAUDE.md` § Dev commands (the `ci:*` entries in `package.json` are the authoritative list) and § CI & repo (PR-only CI, required checks, runner routing, draft PRs run no CI, lefthook mirrors the `lint` job).
- `src/__tests__/ci-audit-wiring.test.ts` (#590) keeps `package.json`, the workflows, and `lefthook.yml` from drifting apart; runbook `docs/runbooks/self-hosted-ci-runner.md` § Routing.
- Lab notes: `.claude/reference/lab-notes/ci-tooling.md` (nested-worktree poisoning, `MOCK_EXTERNAL_APIS=false` in CI, tenant-scope allowlist drift, test-DB provisioning), `.claude/reference/lab-notes/false-coverage-mutation.md`.
- File map: `docs/directory/repo-surfaces.md` § `scripts/`.
- Rule tooling: `pnpm agent:rules <path>` (`scripts/agent-rules.ts`) lists the `.claude/rules/*.md` files whose `paths:` match; `ci:agent-config` audits the rules directory. Layout: `docs/agents/context-layout.md`.

## Traps

- No trap clauses were moved from `.claude/CLAUDE.md` for this area; the live-DB test gotchas (`pnpm test` is the gate, fallow coverage, `TEST_DATABASE_POOL_URL` fallback) are in `.claude/rules/live-db-tests.md`.
- Do NOT add a `ci:*` script without wiring it into the `lint` job AND `lefthook.yml` — `ci-audit-wiring.test.ts` fails otherwise; `ci:fallow:coverage` is the one sanctioned lefthook exemption (`CI_ONLY_BY_DESIGN`).

## Rules

- Nothing was moved from `.claude/CLAUDE.md`.
