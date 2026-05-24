# CI Keystone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add RepWorth's first GitHub Actions CI gate and repository hygiene files without requiring production secrets, staging database credentials, or Playwright.

**Architecture:** Create a small `.github/` surface: one CI workflow with four stable jobs, plus Dependabot, PR template, and CODEOWNERS. The workflow runs existing repo commands with the pinned Node and pnpm versions, uses least-privilege permissions, cancels superseded PR runs, and keeps DB/e2e gates as documented follow-ups.

**Tech Stack:** GitHub Actions, Node `v24.15.0`, pnpm `11.0.9`, Next.js lint/build, TypeScript, Vitest, Dependabot.

---

## File Structure

- Create `.github/workflows/ci.yml`: PR and `main` push workflow with stable `lint`, `typecheck`, `test`, and `build` jobs.
- Create `.github/dependabot.yml`: weekly npm and GitHub Actions dependency update configuration.
- Create `.github/pull_request_template.md`: PR checklist with explicit CI coverage note.
- Create `.github/CODEOWNERS`: default repository owner mapping to `@norbertesekiel47`.
- Modify `docs/sass_ready/24-devops-deployment.md`: record that CI task 0 has a first secret-free slice, and list integration/e2e/branch protection as follow-ups.

## Task 1: Add GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/ci.yml` with this complete content:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  CI: 'true'
  MOCK_EXTERNAL_APIS: 'true'
  NEXT_PUBLIC_APP_URL: http://localhost:3000
  WORKER_SERVICE_URL: http://localhost:3001
  NEXT_PUBLIC_SUPABASE_URL: http://localhost:54321
  NEXT_PUBLIC_SUPABASE_ANON_KEY: dummy-anon-key-for-ci
  SUPABASE_URL: http://localhost:54321
  SUPABASE_SERVICE_KEY: dummy-service-key-for-ci
  DATABASE_URL: postgres://test:test@localhost:5432/test
  DATABASE_POOL_URL: postgres://test:test@localhost:5432/test
  REDIS_CACHE_URL: redis://localhost:6379/0
  REDIS_QUEUE_URL: redis://localhost:6379/1
  SESSION_COOKIE_SECRET: test-session-cookie-secret-32chars
  CSRF_SECRET: test-csrf-secret-32chars-minimum
  ENCRYPTION_KEY: 0000000000000000000000000000000000000000000000000000000000000000
  ENCRYPTION_KEY_VERSION: '1'
  ADMIN_API_KEY: ci-admin-api-key

jobs:
  lint:
    name: lint
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc

      - name: Enable Corepack
        run: corepack enable

      - name: Prepare pnpm
        run: corepack prepare pnpm@11.0.9 --activate

      - name: Get pnpm store path
        id: pnpm-store
        shell: bash
        run: echo "STORE_PATH=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"

      - name: Restore pnpm store
        uses: actions/cache@v4
        with:
          path: ${{ steps.pnpm-store.outputs.STORE_PATH }}
          key: ${{ runner.os }}-node-${{ hashFiles('.nvmrc') }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: |
            ${{ runner.os }}-node-${{ hashFiles('.nvmrc') }}-pnpm-

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run lint
        run: pnpm lint

  typecheck:
    name: typecheck
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc

      - name: Enable Corepack
        run: corepack enable

      - name: Prepare pnpm
        run: corepack prepare pnpm@11.0.9 --activate

      - name: Get pnpm store path
        id: pnpm-store
        shell: bash
        run: echo "STORE_PATH=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"

      - name: Restore pnpm store
        uses: actions/cache@v4
        with:
          path: ${{ steps.pnpm-store.outputs.STORE_PATH }}
          key: ${{ runner.os }}-node-${{ hashFiles('.nvmrc') }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: |
            ${{ runner.os }}-node-${{ hashFiles('.nvmrc') }}-pnpm-

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run typecheck
        run: pnpm typecheck

  test:
    name: test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc

      - name: Enable Corepack
        run: corepack enable

      - name: Prepare pnpm
        run: corepack prepare pnpm@11.0.9 --activate

      - name: Get pnpm store path
        id: pnpm-store
        shell: bash
        run: echo "STORE_PATH=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"

      - name: Restore pnpm store
        uses: actions/cache@v4
        with:
          path: ${{ steps.pnpm-store.outputs.STORE_PATH }}
          key: ${{ runner.os }}-node-${{ hashFiles('.nvmrc') }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: |
            ${{ runner.os }}-node-${{ hashFiles('.nvmrc') }}-pnpm-

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run unit tests
        run: pnpm test

  build:
    name: build
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc

      - name: Enable Corepack
        run: corepack enable

      - name: Prepare pnpm
        run: corepack prepare pnpm@11.0.9 --activate

      - name: Get pnpm store path
        id: pnpm-store
        shell: bash
        run: echo "STORE_PATH=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"

      - name: Restore pnpm store
        uses: actions/cache@v4
        with:
          path: ${{ steps.pnpm-store.outputs.STORE_PATH }}
          key: ${{ runner.os }}-node-${{ hashFiles('.nvmrc') }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: |
            ${{ runner.os }}-node-${{ hashFiles('.nvmrc') }}-pnpm-

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build app
        run: pnpm build
```

- [ ] **Step 2: Verify workflow structure is present**

Run:

```bash
rg -n "name: CI|contents: read|cancel-in-progress: true|name: lint|name: typecheck|name: test|name: build" .github/workflows/ci.yml
```

Expected: output includes all seven patterns.

- [ ] **Step 3: Verify no DB integration secret is required**

Run:

```bash
rg -n "TEST_DATABASE_POOL_URL|test:e2e|playwright" .github/workflows/ci.yml
```

Expected: no output and exit code `1`. The first CI slice must not require `TEST_DATABASE_POOL_URL` or run Playwright.

- [ ] **Step 4: Check formatting**

Run:

```bash
git diff --check -- .github/workflows/ci.yml
```

Expected: no output.

## Task 2: Add GitHub Repository Hygiene Files

**Files:**
- Create: `.github/dependabot.yml`
- Create: `.github/pull_request_template.md`
- Create: `.github/CODEOWNERS`

- [ ] **Step 1: Add Dependabot config**

Create `.github/dependabot.yml` with this complete content:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      production-dependencies:
        dependency-type: production
      development-dependencies:
        dependency-type: development

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
```

- [ ] **Step 2: Add PR template**

Create `.github/pull_request_template.md` with this complete content:

```markdown
## Summary

- 

## Verification

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`

Note: the default `test` CI check is secret-free. Database-backed integration tests may self-skip until `TEST_DATABASE_POOL_URL` is wired into CI, and Playwright is not part of the first PR gate.

## Risk / Rollout

- 

## SaaS-Readiness Spec

- 
```

- [ ] **Step 3: Add CODEOWNERS**

Create `.github/CODEOWNERS` with this complete content:

```text
* @norbertesekiel47
```

- [ ] **Step 4: Verify hygiene files**

Run:

```bash
rg -n "package-ecosystem: npm|package-ecosystem: github-actions|TEST_DATABASE_POOL_URL|@norbertesekiel47" .github/dependabot.yml .github/pull_request_template.md .github/CODEOWNERS
```

Expected: output confirms npm and GitHub Actions Dependabot ecosystems, the PR template coverage note, and the CODEOWNERS owner.

- [ ] **Step 5: Check formatting**

Run:

```bash
git diff --check -- .github/dependabot.yml .github/pull_request_template.md .github/CODEOWNERS
```

Expected: no output.

## Task 3: Update SaaS-Readiness Spec 24

**Files:**
- Modify: `docs/sass_ready/24-devops-deployment.md`

- [ ] **Step 1: Update the Current State CI bullet**

In `docs/sass_ready/24-devops-deployment.md`, replace the current CI bullet:

```markdown
- ⚠️ **No CI/CD at all** — there is **no `.github/` directory** (no Actions, no Dependabot, no PR template, no CODEOWNERS). This spec is effectively "stand up CI/CD from zero," and it's the prerequisite **~8 other specs (07/08/09/12/19/22/23/25) wait on**.
```

with:

```markdown
- ✅ **CI foundation shipped (Step 1 first slice)** — `.github/workflows/ci.yml` runs the secret-free PR gate (`lint`, `typecheck`, `test`, `build`) with stable check names, least-privilege permissions, and concurrency cancellation. `.github/dependabot.yml`, `.github/pull_request_template.md`, and `.github/CODEOWNERS` are present. ⚠️ Database-backed integration tests still self-skip without `TEST_DATABASE_POOL_URL`, Playwright is not in the PR gate yet, and branch protection still needs to be enabled after the first green GitHub run.
```

- [ ] **Step 2: Update implementation task 0**

In `docs/sass_ready/24-devops-deployment.md`, replace task 0:

```markdown
0. **Stand up GitHub Actions CI** — the `.github/workflows/ci.yml` that runs lint/type/unit/integration. This is the keystone task: ~8 other specs (07/08/09/12/19/22/23/25) are blocked on it. Create `.github/` (workflows + dependabot + PR template + CODEOWNERS) from zero.
```

with:

```markdown
0. ✅ **Stand up GitHub Actions CI — first secret-free slice shipped.** `.github/workflows/ci.yml` runs `lint`, `typecheck`, `test`, and `build` on PRs and `main` pushes; `.github/` now includes Dependabot, PR template, and CODEOWNERS. Follow-up: add `test:integration` once `TEST_DATABASE_POOL_URL` is available as a GitHub secret, add Playwright on `main`/scheduled/staging runs, then enable branch protection using the stable check names.
```

- [ ] **Step 3: Update CI acceptance criteria**

In `docs/sass_ready/24-devops-deployment.md`, replace this acceptance item:

```markdown
- [ ] GitHub Actions CI exists (`.github/workflows/ci.yml`) running lint/type/unit/integration.
```

with:

```markdown
- [x] GitHub Actions CI exists (`.github/workflows/ci.yml`) running `lint`, `typecheck`, `test`, and `build` as the first secret-free gate.
- [ ] GitHub Actions CI runs database-backed integration tests with `TEST_DATABASE_POOL_URL`.
```

- [ ] **Step 4: Update current repo implementation notes**

In `docs/sass_ready/24-devops-deployment.md`, replace this bullet:

```markdown
- **CI is genuinely greenfield** — no `.github/` at all. Start minimal: `ci.yml` running `pnpm lint && pnpm typecheck && pnpm test`, add integration (with `TEST_DATABASE_POOL_URL` secret) + e2e on `main`, then layer the security/a11y/eval gates.
```

with:

```markdown
- **CI is no longer greenfield** — the first secret-free GitHub Actions gate now runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Next CI steps are integration with `TEST_DATABASE_POOL_URL`, e2e on `main`/scheduled/staging runs, then security/a11y/eval gates.
```

- [ ] **Step 5: Verify Spec 24 no longer claims there is no `.github/` directory**

Run:

```bash
rg -n "No CI/CD at all|no `.github/`|CI is genuinely greenfield|lint/type/unit/integration" docs/sass_ready/24-devops-deployment.md
```

Expected: no output and exit code `1`.

- [ ] **Step 6: Verify Spec 24 still calls out the integration/e2e gap**

Run:

```bash
rg -n "TEST_DATABASE_POOL_URL|Playwright|branch protection" docs/sass_ready/24-devops-deployment.md
```

Expected: output includes the follow-up notes for DB-backed integration tests, Playwright, and branch protection.

## Task 4: Run Local Verification

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: `.github/dependabot.yml`
- Verify: `.github/pull_request_template.md`
- Verify: `.github/CODEOWNERS`
- Verify: `docs/sass_ready/24-devops-deployment.md`

- [ ] **Step 1: Confirm TypeScript includes worker and tests**

Run:

```bash
pnpm exec tsc --noEmit --listFilesOnly | rg "(/worker/|worker/)"
```

Expected: output includes worker TypeScript files.

Run:

```bash
pnpm exec tsc --noEmit --listFilesOnly | rg "__tests__"
```

Expected: output includes test TypeScript files.

- [ ] **Step 2: Run lint**

Run:

```bash
pnpm lint
```

Expected: exits `0`.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: exits `0`.

- [ ] **Step 4: Run unit tests**

Run:

```bash
pnpm test
```

Expected: exits `0`. If the output reports skipped tests, confirm the skipped cases are the known database-backed integration tests that require `TEST_DATABASE_POOL_URL`.

- [ ] **Step 5: Run build**

Run:

```bash
pnpm build
```

Expected: exits `0`. If it fails because a build-time env var is missing, add a non-secret dummy value to `.github/workflows/ci.yml` rather than weakening runtime assertions.

- [ ] **Step 6: Check all changed files for whitespace errors**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 7: Confirm no secrets were added**

Run:

```bash
rg -n "sk_live|rk_live|whsec_|sk-proj-|sk-ant-|re_[A-Za-z0-9]{20,}|AC[a-fA-F0-9]{32}|MG[a-fA-F0-9]{32}|VA[a-fA-F0-9]{32}" .github docs/sass_ready/24-devops-deployment.md
```

Expected: no output and exit code `1`.

## Task 5: Review and Commit

**Files:**
- Review: `.github/workflows/ci.yml`
- Review: `.github/dependabot.yml`
- Review: `.github/pull_request_template.md`
- Review: `.github/CODEOWNERS`
- Review: `docs/sass_ready/24-devops-deployment.md`

- [ ] **Step 1: Review the complete diff**

Run:

```bash
git diff -- .github docs/sass_ready/24-devops-deployment.md
```

Expected: diff only contains the CI workflow, repository hygiene files, and Spec 24 status updates.

- [ ] **Step 2: Check git status**

Run:

```bash
git status --short
```

Expected:

```text
?? .github/
 M docs/sass_ready/24-devops-deployment.md
```

If `.github/` expands in output, expect these created files:

```text
?? .github/CODEOWNERS
?? .github/dependabot.yml
?? .github/pull_request_template.md
?? .github/workflows/ci.yml
 M docs/sass_ready/24-devops-deployment.md
```

- [ ] **Step 3: Commit the implementation**

Run:

```bash
git add .github docs/sass_ready/24-devops-deployment.md
git commit -m "ci: add GitHub Actions keystone"
```

Expected: commit succeeds and includes the four `.github/` files plus the Spec 24 update.

- [ ] **Step 4: Capture final status**

Run:

```bash
git status --short
```

Expected: no output.
