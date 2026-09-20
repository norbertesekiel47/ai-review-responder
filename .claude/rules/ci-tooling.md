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

- A test that spawns `git` (or a script that calls git) in a throwaway repo MUST pass `env: GIT_FREE_ENV` (`process.env` minus every `GIT_*` key). Git exports `GIT_DIR` into hook processes; under lefthook `test-changed` from a worktree the test otherwise commits INTO the pushing branch and writes `core.bare=true` into the shared `.git/config` (2026-09-05, lab-notes/history/2026-09.md).
- **The local verify gate runs macOS bash 3.2; CI runs bash 5.x.** Any bash construct whose semantics changed between them is INVISIBLE locally. Concretely: bash >= 4.3 performs backslash processing on the unquoted replacement of `${var//pat/rep}`, so a replacement of `\\` collapses to `\`. Quoting the replacement is not the fix (3.2 then inserts the quotes). Use `sed` whenever a replacement contains a backslash, and assert the exact output list rather than a boolean so a collapse is visible (#1345, lab-notes/history/2026-09-19-to-30.md).
- A fixture process identity (`pid`/`pgid`) in a journal or test MUST be out of range (`Number.MAX_SAFE_INTEGER - n`), never a small number. `process.kill(-1)` signals EVERY process the user owns and `-0` the caller's own group; a `pgid: 1` fixture once SIGKILLed the whole login session from a test teardown. Any code that signals a group guards `Number.isInteger(pgid) && pgid > 1` first. History: lab-notes/history/2026-09.md "2026-09-18 — a test fixture killed the login session".

## Rules

- Nothing was moved from `.claude/CLAUDE.md`.
