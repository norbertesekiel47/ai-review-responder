# E2E CI Gate + Auth Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Playwright e2e run in the PR gate (hermetic specs), give the rls-audit live check a database, implement the Supabase auth harness so the 8 hard-skipped auth specs run locally against staging, and fix the stale docs.

**Architecture:** Two PRs. **PR-A (`ci/e2e-pr-gate`)** adds a parallel `e2e` CI job reusing the existing postgres-service + bootstrap + migrations recipe (extracted into a composite action shared with the `test` job), enables Playwright's `webServer` in CI (one owner for app boot), runs chromium-only with the auth-dependent specs self-skipping via their existing env gates, moves the rls-audit live check into the `test` job, and ships the missing local-e2e runbook + doc corrections. **PR-B (`feat/e2e-auth-harness`)** adds `e2e/harness.ts` wrapping Supabase `auth.admin.*` against the staging project (creds from `.env.staging.local` via new `E2E_SUPABASE_URL`/`E2E_SUPABASE_SERVICE_KEY`), flips the 8 `test.skip(true)` specs to conditional gates, and verifies them locally.

**Tech Stack:** GitHub Actions (composite action), Playwright 1.x (chromium), Postgres 16 service container, `@supabase/supabase-js` admin API, docker (local discovery).

**Locked decisions (grilling 2026-06-11):** PR-gate job = hermetic specs only (no Supabase secrets in CI); auth harness = staging Supabase, local runs (nightly job possible later); quick wins included (rls-audit live in test job; stale-doc fix; local runbook).

**Known facts (scouted):**
- `ci.yml` `test` job already runs postgres:16 + `scripts/ci/test-db-bootstrap.sql` + all migrations + `TEST_DATABASE_POOL_URL` (line 94). Playwright is never invoked in CI.
- `playwright.config.ts`: `webServer` is `undefined` when `CI` (line 30); locally it runs `pnpm dev` with `DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL`. `retries: 2` in CI; projects chromium + mobile-chrome.
- `e2e/seed.ts` gate: `isE2eConfigured = TEST_DATABASE_POOL_URL && (NODE_ENV==='test' || ALLOW_E2E_DB_WRITES==='true')` → CI job must set `ALLOW_E2E_DB_WRITES=true`.
- Auth-dependent specs already self-gate on `E2E_OWNER_EMAIL`/`E2E_OWNER_PASSWORD` (unset in CI → they skip themselves; no spec-list maintenance needed).
- The 8 hard-skipped specs: `forgot-password.spec.ts` (4), `reset-password.spec.ts` (3), `signup-google.spec.ts` (1) — `test.skip(true, 'Harness …')`; requirements documented in `e2e/README.md`.
- In CI there is no `.env.local`; the minimal env the app needs to boot + serve the hermetic specs is UNKNOWN → Task A1 discovers it locally before any CI edit.

---

## PR-A — e2e PR gate (branch `ci/e2e-pr-gate`)

### Task A1: Discover the minimal CI env locally (no repo changes yet)

- [ ] **Step 1:** Start a disposable local postgres mirroring CI:
```bash
docker run -d --name e2e-ci-probe -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 5433:5432 postgres:16
until docker exec e2e-ci-probe pg_isready -U test -d test; do sleep 1; done
PGPASSWORD=test psql -h localhost -p 5433 -U test -d test -v ON_ERROR_STOP=1 -f scripts/ci/test-db-bootstrap.sql
for f in $(ls supabase/migrations/*.sql | sort); do PGPASSWORD=test psql -h localhost -p 5433 -U test -d test -v ON_ERROR_STOP=1 -q -f "$f"; done
```
- [ ] **Step 2:** Run the hermetic suite with a STRIPPED env (mimic CI: no `.env.local`). Temporarily rename `.env.local` → `.env.local.bak` (restore in a `finally`!), then:
```bash
env -i PATH="$PATH" HOME="$HOME" CI=1 \
  TEST_DATABASE_POOL_URL=postgres://test:test@localhost:5433/test \
  ALLOW_E2E_DB_WRITES=true \
  NEXT_PUBLIC_APP_URL=http://localhost:3000 \
  PLAYWRIGHT_BASE_URL=http://localhost:3000 \
  pnpm test:e2e --project=chromium 2>&1 | tee /tmp/e2e-probe.log
```
(This will FAIL initially — `webServer` is disabled under `CI`. Do Task A2 Step 1 first if needed, or run with `CI` unset and accept dev-server local semantics; the goal is the env-var delta, not green.)
- [ ] **Step 3:** Triage every failure in `/tmp/e2e-probe.log` into: (a) missing env var → add a dummy/real value to the minimal set; (b) spec inherently needs external Supabase auth → confirm it self-gates (if a spec FAILS instead of SKIPS without `E2E_OWNER_*`, fix its gate in PR-A); (c) genuine flake → note. Iterate until the hermetic subset is green twice consecutively. Record the final minimal env set — it becomes the CI job env in Task A3 and the runbook content in Task A5.
- [ ] **Step 4:** Restore `.env.local`; keep the docker container for later tasks.

### Task A2: Enable Playwright webServer in CI + chromium-only gate

**Files:** Modify `playwright.config.ts`

- [ ] **Step 1:** Replace the `webServer: process.env.CI ? undefined : {…}` ternary with an unconditional `webServer` block (one owner for app boot, local and CI):
```ts
  webServer: {
    command: 'pnpm dev',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    // CI cold-boots Next dev + compiles routes on first hit; allow slack.
    timeout: 180_000,
    env: { /* keep the existing TEST_DATABASE_POOL_URL / offboarding passthroughs, plus any vars Task A1 discovered the app needs */ },
  },
```
- [ ] **Step 2:** Run the Task A1 probe again WITH `CI=1` to prove webServer boots under CI semantics and the hermetic subset passes. Two consecutive green runs (retries=2 already configured).
- [ ] **Step 3:** Commit — `ci(e2e): boot the app via Playwright webServer in CI too`.

### Task A3: Composite action + e2e job in ci.yml

**Files:** Create `.github/actions/test-db/action.yml`; Modify `.github/workflows/ci.yml`

- [ ] **Step 1:** Extract the bootstrap+migrations steps (currently inline in the `test` job) into a composite action `.github/actions/test-db/action.yml` (inputs: host/port/user/db, default to the CI service values; runs the exact psql loop). Point the `test` job at it.
- [ ] **Step 2:** Add the `e2e` job — same postgres service block as `test`, env = `TEST_DATABASE_POOL_URL` + `ALLOW_E2E_DB_WRITES=true` + the Task A1 minimal set; steps: checkout (SHA-pinned, same as siblings), `./.github/actions/setup`, `./.github/actions/test-db`, `pnpm exec playwright install chromium --with-deps`, `pnpm test:e2e --project=chromium`. Upload the HTML report as artifact `on: failure()`.
- [ ] **Step 3:** Mobile-chrome stays local-only (PR-gate runtime budget); note that in the job comment.
- [ ] **Step 4:** Commit — `ci(e2e): PR-gate e2e job (hermetic specs, chromium) + shared test-db action`.

### Task A4: rls-audit live check into the test job

**Files:** Modify `.github/workflows/ci.yml`

- [ ] **Step 1:** In the `test` job, after migrations, add `- name: RLS audit (live) / run: pnpm ci:rls-audit` (env already provides `TEST_DATABASE_POOL_URL` → the live branch executes). The lint job keeps its static-only invocation.
- [ ] **Step 2:** Verify locally against the Task A1 container: `TEST_DATABASE_POOL_URL=postgres://test:test@localhost:5433/test pnpm ci:rls-audit` → live check runs and passes.
- [ ] **Step 3:** Commit — `ci(rls): run the live RLS audit where the test database exists`.

### Task A5: Runbook + stale-doc fix

**Files:** Create `docs/runbooks/e2e-local-setup.md`; Modify `docs/launch-ready-part1.md`, `.claude/reference/env-vars.md`

- [ ] **Step 1:** Write `docs/runbooks/e2e-local-setup.md`: docker postgres + bootstrap + migrations commands (from Task A1), the minimal env set, `pnpm test:e2e`, the seed-gate semantics (`ALLOW_E2E_DB_WRITES`), which specs need `E2E_OWNER_*` (staging Supabase), pointer to `e2e/README.md` for the auth harness.
- [ ] **Step 2:** `docs/launch-ready-part1.md`: correct the stale P2 line "`TEST_DATABASE_POOL_URL` not in CI" → vitest side wired earlier (postgres service in the test job); e2e PR-gate job + live rls-audit added by this PR; cite the runbook.
- [ ] **Step 3:** `env-vars.md`: document `ALLOW_E2E_DB_WRITES` and the CI e2e job's env contract.
- [ ] **Step 4:** Commit — `docs(e2e): local setup runbook + launch-doc correction`.

### Task A6: PR-A gate

- [ ] `pnpm lint && pnpm typecheck && pnpm test` green locally; push; **verify the new `e2e` job passes on the PR itself** (this PR is its own integration test); fix iteratively from the runner logs (never from a nested worktree). Merge after all checks green. NOTE: the `e2e` job is NOT in the required-checks set yet — after one week of stability, ask the user to add it to branch protection (record this as a follow-up in the PR body).

---

## PR-B — auth harness (branch `feat/e2e-auth-harness`)

### Task B1: harness module

**Files:** Create `e2e/harness.ts`; Modify `.claude/reference/env-vars.md`, `e2e/README.md`

- [ ] **Step 1:** Read `e2e/README.md` harness contract + all three skipped spec files in full (their bodies define the API they expect — match it, don't invent).
- [ ] **Step 2:** Implement `e2e/harness.ts` gated on `E2E_SUPABASE_URL` + `E2E_SUPABASE_SERVICE_KEY` (export `isAuthHarnessConfigured`). Wrap `createClient(url, serviceKey).auth.admin`: `createOwnerUser(email)` (+ users/accounts/businesses rows via `e2e/seed.ts` helpers so the app recognizes the auth identity), `getRecoveryLink(email)` (`generateLink({type:'recovery'})`), `injectSession(context, email)` (`generateLink({type:'magiclink'})` → `verifyOtp` → set sb cookies on the browser context), `deleteUser(email)` cleanup, and an email-sent proxy via `generateLink` return (no SMTP capture against staging — README documents the proxy semantics). Unique emails per run (`e2e+<runId>@…`); cleanup in `finally` blocks ALWAYS (staging is shared).
- [ ] **Step 3:** Flip the 8 specs: `test.skip(true, 'Harness …')` → `test.skip(!isAuthHarnessConfigured, 'E2E_SUPABASE_URL/E2E_SUPABASE_SERVICE_KEY not set — auth harness specs run locally against staging')`, and wire their bodies to the harness API.
- [ ] **Step 4:** Local verification: map `STAGING_NEXT_PUBLIC_SUPABASE_URL`/`STAGING_SUPABASE_SERVICE_KEY` from `.env.staging.local` into `E2E_SUPABASE_URL`/`E2E_SUPABASE_SERVICE_KEY`; run the three spec files twice; verify zero residual users on staging Auth afterwards (`auth.admin.listUsers` filtered by the e2e+ prefix).
- [ ] **Step 5:** Confirm CI behavior: without the new env vars the 8 specs SKIP (not fail) in the e2e job.
- [ ] **Step 6:** Docs: env-vars.md entries; e2e/README.md "harness implemented" rewrite; tick the part1 P2 e2e-skip line.
- [ ] **Step 7:** Full gate + PR + merge.

## Execution order
PR-A first (the e2e job must exist so PR-B can prove the skip behavior on its own PR run). Direct inline execution (infra/test work — hybrid precedent).

## Out of scope
Nightly staging-credentialed e2e workflow (possible follow-up); mobile-chrome in CI; making `e2e` a required check (user decision after stability week).
