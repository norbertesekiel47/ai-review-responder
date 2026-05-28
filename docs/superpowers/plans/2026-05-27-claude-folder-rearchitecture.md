# `.claude/` Folder Re-architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-architect the `.claude/` config tree into four clean layers (orientation/facts, law, procedures, reference), state every fact once, and fix all stale/contradictory/leaked content — improving the quality of every future Claude Code session.

**Architecture:** Four layers by loading behavior: `CLAUDE.md` (auto-loaded facts + canonical invariants + a "where things live" index), `rules/*.md` (auto-loaded behavioral law that references invariants), `skills/*.md` (invoke-on-demand patterns you follow), `reference/*.md` (NEW; read-on-demand inventories). Recall-only inventories move out of `skills/` into `reference/`. Each factual claim is verified against the live codebase as it is touched.

**Tech Stack:** Markdown + YAML frontmatter only. No application code changes. Verification via `git`, `grep`, path-existence checks, and the codebase-memory graph. Branch `chore/claude-folder-rearchitecture` (already created; spec already committed there).

**Verified anchors (use these exact values; re-verify per task):**
- Next.js **16** (`^16.2.6`); React 19; Postgres.js **v3** (`^3.4.9`); zod **v4**; BullMQ 5; Fastify 5; Stripe 22; Resend 6; Twilio 6; posthog-node 5; Vitest 4.
- Migration head **052** (`052_reviews_sentiment.sql`); next is **053**.
- Tier pricing (`src/lib/accounts/tier-config.ts`, cents): basic 2900 / std 7900 / premium 19900 / founders 1900; overage 0 / 2500 / 2000 / 2500. App enum tiers: `basic|standard|premium|founders` (legacy `founding` → `founders`).
- Scripts (`package.json`): `dev`(=`next dev`), `dev:all`, `build`, `start`, `lint`(=`eslint src`), `typecheck`(=`tsc --noEmit`), `test`(=`vitest run`), `test:watch`, `test:integration`, `test:e2e`, `ci:tenant-scope`, `ci:rls-audit`, `ci:analytics-events`, `worker`, `redis`, `eval:llm`.
- Leaked key occurs at `.claude/skills/firecrawl.md:215` and `:221`.

---

## Phase 1 — Critical mechanical fixes (safe, independent)

### Task 1: Delete `firecrawl.md` (leaked key + not RepWorth-specific)

**Files:**
- Delete: `.claude/skills/firecrawl.md`

- [ ] **Step 1: Confirm the file's nature before deletion (it's a generic Firecrawl install guide, not RepWorth code)**

Run: `head -20 .claude/skills/firecrawl.md`
Expected: generic Firecrawl onboarding content; no RepWorth-specific logic.

- [ ] **Step 2: Delete the file**

Run: `git rm .claude/skills/firecrawl.md`
Expected: `rm '.claude/skills/firecrawl.md'`

- [ ] **Step 3: Verify the leaked key is gone from the working tree**

Run: `grep -rn "fc-88325f" .claude/ || echo "CLEAN"`
Expected: `CLEAN`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(claude): remove firecrawl skill (leaked key, not RepWorth-specific)"
```

> ⚠️ **USER ACTION (out of band, cannot be done here):** rotate the key `fc-88325f…` at firecrawl.dev. `git rm` does not purge it from git history — treat it as compromised.

---

### Task 2: Delete stale `scheduled_tasks.lock` and gitignore it

**Files:**
- Delete: `.claude/scheduled_tasks.lock`
- Modify: `.gitignore`

- [ ] **Step 1: Check whether the lock is tracked**

Run: `git ls-files .claude/scheduled_tasks.lock`
Expected: prints the path (tracked) — if empty, it's untracked; still delete it from disk in step 2.

- [ ] **Step 2: Remove the file**

Run: `git rm --ignore-unmatch .claude/scheduled_tasks.lock && rm -f .claude/scheduled_tasks.lock`
Expected: removed (or no-op if already gone).

- [ ] **Step 3: Add ignore rule (append under a clear comment)**

Add these two lines to `.gitignore`:
```
# Claude Code transient lock
.claude/scheduled_tasks.lock
```

- [ ] **Step 4: Verify it is now ignored**

Run: `git check-ignore -v .claude/scheduled_tasks.lock`
Expected: prints the matching `.gitignore` line.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(claude): drop stale scheduled_tasks.lock and gitignore it"
```

---

### Task 3: Prune dead Windows/`rtk` commands from `settings.local.json`

**Files:**
- Modify: `.claude/settings.local.json`

- [ ] **Step 1: Determine if the file is tracked (affects whether this lands in the PR)**

Run: `git check-ignore .claude/settings.local.json && echo "IGNORED (local-only change)" || echo "TRACKED (will be in PR)"`
Expected: either result is fine — proceed regardless; this is machine hygiene.

- [ ] **Step 2: Read current contents**

Run: `cat .claude/settings.local.json`
Expected: the permissions allowlist including Windows/`rtk`/PowerShell entries.

- [ ] **Step 3: Remove the dead entries from the `permissions.allow` array**

Delete these entries (PowerShell + `rtk` + Windows-path commands that cannot run on macOS):
`Bash(rtk git *)`, `Bash(rtk tsc *)`, `Bash(rtk lint *)`, `Bash(rtk vitest *)`, `Bash(rtk curl *)`, `Bash(rtk gh *)`, `Bash(rtk read *)`, `Bash(MOCK_EXTERNAL_APIS=true rtk vitest worker/jobs/__tests__/OnboardingDemoWorker.test.ts)`, `Bash(Start-Sleep -Seconds 20)`, `Bash(Write-Output \"done\")`, `Bash(Select-String \"onboarding|cost-guard|fallback|SetupChecklist|PaywallWith\")`, `Bash(Get-ChildItem -Path \"C:\\\\Users\\\\norbe\\\\Desktop\\\\RepWorth\\\\src\\\\app\" -Recurse -Filter \"*.tsx\")`, `Bash(Select-Object -ExpandProperty FullName)`, `Bash(Sort-Object)`, and the Windows-path brainstorming `start-server.sh` entry under `C:/Users/norbe/...`.

Keep every macOS-valid entry (the `mcp__*` permissions, `Bash(pnpm test *)`, `Bash(pnpm build *)`, `Bash(pnpm tsc *)`, `Bash(npx tsc *)`, `Bash(node *)`, `Bash(gh deployment *)`, `Bash(gh run *)`, `Bash(stripe --version)`).

- [ ] **Step 4: Verify it is still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8')); console.log('valid json')"`
Expected: `valid json`

- [ ] **Step 5: Verify no `rtk`/PowerShell residue**

Run: `grep -nE "rtk |Start-Sleep|Get-ChildItem|Select-String|Select-Object|Sort-Object|C:/Users|C:\\\\\\\\Users" .claude/settings.local.json || echo "CLEAN"`
Expected: `CLEAN`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(claude): prune dead Windows/rtk permissions from settings.local.json"
```

---

## Phase 2 — Move recall-only inventories into `reference/`

> Each move uses `git mv` to preserve history, then removes the duplicated
> "Worker file paths (as of 2026-05-05)" disclaimer block and verifies claims.

### Task 4: Move `migrations.md` → `reference/migrations-log.md`

**Files:**
- Move: `.claude/skills/migrations.md` → `.claude/reference/migrations-log.md`
- Modify: `docs/directory.md` (add the canonical class-names-stable note once)

- [ ] **Step 1: Create the reference dir and move the file (preserves history)**

```bash
mkdir -p .claude/reference
git mv .claude/skills/migrations.md .claude/reference/migrations-log.md
```
Expected: file relocated, staged as a rename.

- [ ] **Step 2: Remove the YAML frontmatter `name:`/`description:` (reference files are not skills)**

Delete the leading `---` … `---` block (lines 1–4). Replace with a plain H1 if not already present: `# RepWorth — Migration Inventory`.

- [ ] **Step 3: Remove the duplicated "Worker file paths (as of 2026-05-05)" disclaimer blockquote**

Delete the `> **Worker file paths (as of 2026-05-05):** …` blockquote (the multi-line `>` block near the top). It is consolidated into `docs/directory.md` in Step 6.

- [ ] **Step 4: Verify the migration head claim against the filesystem**

Run: `ls supabase/migrations/ | tail -1`
Expected: `052_reviews_sentiment.sql`. Confirm the file states head **052**, next **053**. Fix if drifted.

- [ ] **Step 5: Verify worker paths referenced in the file still exist**

Run:
```bash
for p in worker/jobs/notification/NotificationWorker.ts worker/jobs/publisher/ResponsePublisherWorker.ts worker/jobs/publisher/failed-hook.ts worker/jobs/zernio/ZernioBackfillWorker.ts worker/jobs/zernio/ZernioReviewIngestWorker.ts worker/jobs/zernio/ingest-failed-hook.ts; do test -e "$p" && echo "OK $p" || echo "MISS $p"; done
```
Expected: all `OK`. For any `MISS`, correct the path in the file using `docs/directory.md` as the map.

- [ ] **Step 6: Add the canonical disclaimer to `docs/directory.md` once (only if absent)**

Run: `grep -n "Class names" docs/directory.md || echo "ABSENT — add it"`
If absent, add near the top of `docs/directory.md`:
```markdown
> **Class names are stable; file paths are authoritative here.** When a worker/
> module path is referenced elsewhere (skills, reference, CLAUDE.md), this file
> is the source of truth for its current location.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(claude): move migrations skill to reference/migrations-log.md; consolidate path disclaimer into docs/directory.md"
```

---

### Task 5: Move `feature-flags.md` → `reference/env-vars.md`

**Files:**
- Move: `.claude/skills/feature-flags.md` → `.claude/reference/env-vars.md`

- [ ] **Step 1: Move the file**

Run: `git mv .claude/skills/feature-flags.md .claude/reference/env-vars.md`
Expected: relocated.

- [ ] **Step 2: Remove the YAML frontmatter block; ensure H1 `# RepWorth — Environment Variables & Feature Flags`**

- [ ] **Step 3: Remove the duplicated "Worker file paths (as of 2026-05-05)" disclaimer blockquote**

- [ ] **Step 4: Verify the tier-config table against `tier-config.ts` (this is the contradiction source)**

Run: `grep -nE "baseCents|overageCents" src/lib/accounts/tier-config.ts`
Confirm the table reads: basic $29 (incl 1, no overage) / standard $79 (incl 1, $25) / premium $199 (incl 5, $20) / founders $19 (incl 1, $25). Correct any drift. The table here MUST agree with `tier-config.ts`; note in the table that `tier-config.ts` is the source of truth.

- [ ] **Step 5: Verify the env-var names exist in startup assertions / usage**

Run:
```bash
for v in SELF_SERVE_SIGNUP_ENABLED CHANNELS_SMS_ENABLED CHANNELS_TELEGRAM_ENABLED CHANNELS_WHATSAPP_ENABLED MULTI_LOCATION_ENABLED ZERNIO_PUBLISHING_ENABLED OPENAI_MODERATION_ENABLED MFA_ENFORCEMENT_ENABLED POSTHOG_API_KEY MOCK_EXTERNAL_APIS; do grep -rqn "$v" worker/ src/ && echo "OK $v" || echo "MISS $v"; done
```
Expected: all `OK`. Investigate/correct any `MISS` (flag may have been renamed/removed).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(claude): move feature-flags skill to reference/env-vars.md; reconcile tier table with tier-config.ts"
```

---

### Task 6: Move `lab-notes.md` → `reference/lab-notes.md` and add a topic index

**Files:**
- Move: `.claude/skills/lab-notes.md` → `.claude/reference/lab-notes.md`

- [ ] **Step 1: Move the file**

Run: `git mv .claude/skills/lab-notes.md .claude/reference/lab-notes.md`
Expected: relocated.

- [ ] **Step 2: Remove the YAML frontmatter; keep H1 `# RepWorth — Lab Notes`**

- [ ] **Step 3: Remove the duplicated "Worker file paths (as of 2026-05-05)" disclaimer blockquote**

- [ ] **Step 4: Fix the stale `/docs/*` gitignore lab-note (verified stale — docs/ is tracked now)**

Find the note "`gitignore /docs/*` means runbook updates ship but docs don't" and update it to reflect current `.gitignore`:
```markdown
### [SUPERSEDED 2026-05-27] `/docs/*` is no longer gitignored
The earlier rule ignored all of `docs/`. Current `.gitignore` tracks `docs/` by
default and ignores only generated/binary noise (`docs/graphify-out/`,
`docs/superpowers/landingPageScreenshots/`, `docs/**/*.docx`, `docs/**/*.zip`).
New docs/specs/plans now commit normally.
```
Run to confirm current rule: `grep -nA3 "docs/ is tracked" .gitignore`

- [ ] **Step 5: Add a topic index after the H1 (the file is date-ordered; this makes it findable)**

Insert directly below the H1/intro:
```markdown
## Topic index

Jump to the dated entries by subsystem (search the anchors below):

- **Postgres.js / JSONB / PgBouncer** — JSONB string-wrapping, v3 double-encoding, statement_timeout, FOR UPDATE under PgBouncer
- **Indexes / migrations** — STABLE-in-predicate, ON CONFLICT byte-for-byte, column-level REVOKE, pg_constraint relation scoping
- **Zernio** — nested `account.id`, MOCK_EXTERNAL_APIS real-path tests, reviewReply normalization
- **Stripe** — inbound_events payload shape, overage idempotency, billing reconciliation from stored quota
- **Supabase auth** — implicit-flow OTP, identities:[] for existing emails, auth_id vs users.id, SMTP rate limit
- **Billing / multi-location** — stored-quota vs TIER_CONFIG, base price not grandfathered, channel account-scope desync
- **Analytics / PostHog** — unconfigured no-op retry budget, durable vs intent events, RLS on new tables
- **Moderation / logging** — fail-open moderation, logger-never-throws, AsyncLocalStorage binding
- **CI / tooling** — nested-worktree poisoning, MOCK_EXTERNAL_APIS=false in CI, tenant-scope allowlist drift
- **Testing** — vi.hoisted for shared mocks, NextRequest vs Request, relative imports under tsx
```
(Keep the existing chronological body unchanged below this index.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(claude): move lab-notes to reference/; add topic index; fix stale /docs/* gitignore note"
```

---

### Task 7: Move `review-dedup.md` → `reference/review-ingestion.md`

**Files:**
- Move: `.claude/skills/review-dedup.md` → `.claude/reference/review-ingestion.md`

- [ ] **Step 1: Move the file**

Run: `git mv .claude/skills/review-dedup.md .claude/reference/review-ingestion.md`
Expected: relocated.

- [ ] **Step 2: Remove the YAML frontmatter; keep H1 `# RepWorth — Review Deduplication & Ingestion`**

- [ ] **Step 3: Remove the duplicated "Worker file paths (as of 2026-05-05)" disclaimer blockquote**

- [ ] **Step 4: Verify referenced symbols/paths exist**

Run:
```bash
for p in src/lib/reviews/sentiment.ts worker/jobs/zernio/zernio-ingest-shared.ts src/lib/responses/voice-learning.ts src/lib/security/phi-scanner.ts; do test -e "$p" && echo "OK $p" || echo "MISS $p"; done
```
Expected: all `OK`. Correct any `MISS`.

- [ ] **Step 5: Confirm `skills/` now contains only the four patterns**

Run: `ls .claude/skills/`
Expected exactly: `approval-security.md  cost-guard.md  onboarding-demo-cost-guard.md  outbox-pattern.md`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(claude): move review-dedup to reference/review-ingestion.md"
```

---

## Phase 3 — Normalize the four kept skills (frontmatter + fixes)

### Task 8: `cost-guard.md` — add frontmatter, strip stale pricing

**Files:**
- Modify: `.claude/skills/cost-guard.md`

- [ ] **Step 1: Add YAML frontmatter at the top of the file**

```yaml
---
name: cost-guard
description: The two-phase LLM cost-accounting pattern (Redis pessimistic reserve → finalize from actual tokens). Use before adding or modifying any LLM or paid external-API call in a worker.
---
```

- [ ] **Step 2: Replace the stale "Tier-aware limits" block with a pointer to the source of truth**

Delete the lines listing `founding ($99/mo): 500`, `standard ($149/mo): 1000`, `premium ($199/mo): 2000` (wrong tier names AND prices). Replace with:
```markdown
## Tier-aware limits
Per-tier daily ceilings derive from the canonical tier config — never hard-code
prices here. Source of truth: `src/lib/accounts/tier-config.ts` (tiers
`basic|standard|premium|founders`). Full env/flag inventory:
`.claude/reference/env-vars.md`.
```

- [ ] **Step 3: Verify no stale pricing remains**

Run: `grep -nE "\\\$99|\\\$149|founding" .claude/skills/cost-guard.md || echo "CLEAN"`
Expected: `CLEAN`

- [ ] **Step 4: Verify the helper/path claims exist**

Run: `test -e src/lib/costs/cost-guard.ts && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(claude): add frontmatter + strip stale tier pricing from cost-guard skill"
```

---

### Task 9: `approval-security.md` — add frontmatter, verify claims

**Files:**
- Modify: `.claude/skills/approval-security.md`

- [ ] **Step 1: Add YAML frontmatter**

```yaml
---
name: approval-security
description: Approval-token security rules and the read-only approve-page flow (SHA-256 hashed tokens, POST-only session binding, TTL/rate limits, audit logging). Use before touching approval links, token generation/validation, or the /approve route.
---
```

- [ ] **Step 2: Verify the invariants still hold in code (token hashing + audit table)**

Run:
```bash
grep -rqn "createHash" src/ && echo "hashing OK"
grep -rqn "approval_audit_log" src/ worker/ && echo "audit table OK"
```
Expected: both `OK`. If the approve-page flow paths have moved, reconcile against the current route file locations; correct any factual drift (TTL, rate-limit numbers) found.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(claude): add frontmatter to approval-security skill"
```

---

### Task 10: `onboarding-demo-cost-guard.md` — add frontmatter, verify

**Files:**
- Modify: `.claude/skills/onboarding-demo-cost-guard.md`

- [ ] **Step 1: Add YAML frontmatter**

```yaml
---
name: onboarding-demo-cost-guard
description: Cost-guard helper for the PRE-pay onboarding demo lane (global daily ceiling, 20¢ pessimistic reserve → reconcile). Distinct from the post-pay cost-guard. Use before touching /api/onboarding/start, the onboarding demo worker, or pre-pay demo budgeting.
---
```

- [ ] **Step 2: Verify the helper path/exports exist**

Run: `grep -nE "reserveOnboardingDemoBudget|finalizeOnboardingDemoCost|withOnboardingDemoCostGuard" src/lib/costs/onboarding-demo-cost-guard.ts && echo "exports OK"`
Expected: matches printed + `exports OK`. Correct any renamed export.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(claude): add frontmatter to onboarding-demo-cost-guard skill"
```

---

### Task 11: `outbox-pattern.md` — add frontmatter, verify

**Files:**
- Modify: `.claude/skills/outbox-pattern.md`

- [ ] **Step 1: Add YAML frontmatter**

```yaml
---
name: outbox-pattern
description: The transactional outbox pattern every async workflow in RepWorth must follow (state change + job_outbox row in ONE Postgres tx; OutboxPoller dispatches to BullMQ). Use before writing any code that changes Postgres state and enqueues follow-up work.
---
```

- [ ] **Step 2: Verify the core nouns exist in code**

Run:
```bash
grep -rqn "job_outbox" src/ worker/ && echo "outbox table OK"
grep -rqn "OutboxPoller" worker/ && echo "poller OK"
```
Expected: both `OK`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(claude): add frontmatter to outbox-pattern skill"
```

---

## Phase 4 — Rewrite `CLAUDE.md` (facts + invariants + index)

### Task 12: Rewrite `CLAUDE.md`

**Files:**
- Modify: `.claude/CLAUDE.md` (full rewrite, ~267 → ~130 lines)

- [ ] **Step 1: Fix the headline stack fact**

Change "Next.js 14" → "Next.js 16" in the "What this project is" section. (Verified: `package.json` next `^16.2.6`.)

- [ ] **Step 2: Keep these sections, rewriting each rule to ONE statement and DROPPING all PR-#/Wave-#/migration-# narrative**

Retain section order: (1) What this project is; (2) Dev commands; (3) Architecture invariants; (4) Tech stack (non-obvious choices); (5) Worker layout; (6) Database; (7) Non-obvious gotchas; (8) Codebase intelligence; (9) MCP servers; (10) NEW "Where things live".

Apply these specific collapses (representative — apply the same principle throughout):
- The ~12-line `currentBillingSnapshot`/PR #51 billing-snapshot bullet → one line: *"Billing snapshot reads **stored** quota from `accounts` (point-in-time, grandfathered), not live `TIER_CONFIG`; base price is the lone un-stored exception."*
- The flagged-responses block → *"`ResponseGeneratorWorker` runs `moderateResponse`; a high-severity flag writes a `flagged_responses` row (admin-only) and skips owner notification in the SAME tx as response persistence. Owner notification re-fires only on admin `approved_for_owner_review`. See `skills/approval-security.md`."*
- The Wave-2/Wave-3 analytics + structured-logging paragraphs → the rule only: *"Browser/Next.js code never calls PostHog; client intent events POST to `/api/analytics/enqueue`, durable events insert server-side, `AnalyticsDispatchPoller` ships them. Never log raw review/response text, tokens, secrets, MFA codes — use `createWorkerLogger`."*

- [ ] **Step 3: Update "Dev commands" to match `package.json` exactly**

Ensure listed commands exist; add the verified-but-missing ones worth surfacing: `pnpm dev:all` (full stack), `pnpm ci:tenant-scope`, `pnpm ci:rls-audit`, `pnpm ci:analytics-events`. Keep `dev`, `worker`, `test`, `test:watch`, `test:e2e`, `lint`, `eval:llm`, and the `MOCK_EXTERNAL_APIS=true` note.

- [ ] **Step 4: Add the lifted rule to "Architecture invariants"**

Add: *"Feature flags are server-authoritative — browser learns state via API responses; never add a `NEXT_PUBLIC_*` companion for a flag."* (Lifted from the former feature-flags skill so nothing load-bearing is lost.)

- [ ] **Step 5: Replace the "Key patterns" + "Codebase intelligence" pointers with the NEW "Where things live" index**

Use exactly:
```markdown
## Where things live

Detailed inventories load on demand — read the matching file before the work:

| Before you… | Read |
|---|---|
| write or debug a migration / touch schema | `.claude/reference/migrations-log.md` |
| add an env var or flip a feature flag | `.claude/reference/env-vars.md` |
| touch review ingestion / add a ReviewSource | `.claude/reference/review-ingestion.md` |
| touch a named library/subsystem (Postgres.js, Zernio, Stripe, Supabase auth, …) | `.claude/reference/lab-notes.md` |

Patterns to follow (invoke as Skills): `outbox-pattern`, `approval-security`,
`cost-guard`, `onboarding-demo-cost-guard`.

Code map: `docs/directory.md` · Layout reasoning: `docs/currents.md` · ADRs via
codebase-memory `manage_adr`.
```

- [ ] **Step 6: Decide which decisions doc holds the dropped provenance — none. Confirm provenance is dropped, not relocated.**

Run: `grep -nE "PR #[0-9]+|Wave [0-9]" .claude/CLAUDE.md || echo "PROVENANCE DROPPED"`
Expected: `PROVENANCE DROPPED` (occasional unavoidable reference is acceptable, but the narrative paragraphs must be gone).

- [ ] **Step 7: Verify every reference-index target exists**

Run:
```bash
for f in .claude/reference/migrations-log.md .claude/reference/env-vars.md .claude/reference/review-ingestion.md .claude/reference/lab-notes.md docs/directory.md docs/currents.md; do test -e "$f" && echo "OK $f" || echo "MISS $f"; done
```
Expected: all `OK`. (If `docs/currents.md` is missing, drop that pointer rather than dangle it.)

- [ ] **Step 8: Verify the stack facts and length**

Run:
```bash
grep -n "Next.js 16" .claude/CLAUDE.md && echo "version OK"
grep -n "Next.js 14" .claude/CLAUDE.md && echo "STILL WRONG" || echo "no stale 14"
wc -l .claude/CLAUDE.md
```
Expected: `version OK`; `no stale 14`; line count roughly 120–150.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(claude): rewrite CLAUDE.md to facts+invariants+reference index; fix Next 14→16; drop PR/Wave provenance"
```

---

## Phase 5 — Dedupe `rules/repworth.md` against the new CLAUDE.md

### Task 13: Strip restated invariants/stack from `repworth.md`; keep behavioral law

**Files:**
- Modify: `.claude/rules/repworth.md`

- [ ] **Step 1: Remove the sections that now live solely in CLAUDE.md**

Delete from `repworth.md`: the "Stack contract" details that merely restate CLAUDE.md facts, and the "Architecture invariants" list (these are CLAUDE.md's canonical home). Replace the invariants section with a one-line pointer:
```markdown
## Architecture invariants
The canonical NEVER-violate list lives in [`../CLAUDE.md`](../CLAUDE.md)
("Architecture invariants"). This file does not restate them — it adds the
behavioral law for applying them.
```

- [ ] **Step 2: KEEP the genuinely behavioral-law sections**

Keep: "Reliability rules", "Always do", "Never do", "Approval-and-modification posture". These are *how to behave*, not *what is true* — they belong here, not in CLAUDE.md. Trim any sentence that merely repeats a CLAUDE.md fact.

- [ ] **Step 3: Verify no invariant is now stated in BOTH files**

Run:
```bash
for phrase in "Vercel = UI only" "Transactional outbox" "No auto-posting" "Approval tokens never stored raw" "node:crypto"; do
  c=$(grep -rl "$phrase" .claude/CLAUDE.md | wc -l); r=$(grep -rl "$phrase" .claude/rules/repworth.md | wc -l);
  echo "$phrase → CLAUDE:$c repworth:$r";
done
```
Expected: each invariant appears in CLAUDE.md (`CLAUDE:1`) and NOT as a restated rule in repworth (`repworth:0`), aside from the single pointer line. Reconcile any double-statement.

- [ ] **Step 4: Confirm the Next-version contradiction is resolved across both files**

Run: `grep -rn "Next.js 1[46]" .claude/CLAUDE.md .claude/rules/repworth.md`
Expected: every hit says `Next.js 16`. No `14`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(claude): dedupe rules/repworth.md — behavioral law only, reference CLAUDE.md invariants"
```

---

## Phase 6 — Final verification sweep + PR

### Task 14: Full cross-reference integrity + no-orphan check

**Files:** none (verification only)

- [ ] **Step 1: Every `.claude/reference/...` and `.claude/skills/...` path mentioned anywhere actually exists**

Run:
```bash
grep -rhoE "\.claude/(reference|skills)/[A-Za-z0-9_-]+\.md" .claude/ | sort -u | while read p; do test -e "$p" && echo "OK $p" || echo "BROKEN $p"; done
```
Expected: all `OK`, no `BROKEN`.

- [ ] **Step 2: No dangling pointer to the deleted/old skill names**

Run: `grep -rnE "skills/(migrations|feature-flags|lab-notes|review-dedup|firecrawl)\.md" .claude/ docs/ || echo "NO STALE SKILL REFS"`
Expected: `NO STALE SKILL REFS`.

- [ ] **Step 3: No leaked key anywhere in the repo working tree**

Run: `grep -rn "fc-88325f" . --exclude-dir=.git || echo "CLEAN"`
Expected: `CLEAN`.

- [ ] **Step 4: `skills/` holds exactly the four patterns; `reference/` holds exactly the four inventories**

Run: `echo "--skills--"; ls .claude/skills/; echo "--reference--"; ls .claude/reference/`
Expected skills: `approval-security.md cost-guard.md onboarding-demo-cost-guard.md outbox-pattern.md`
Expected reference: `env-vars.md lab-notes.md migrations-log.md review-ingestion.md`

- [ ] **Step 5: Every skill has frontmatter**

Run: `for f in .claude/skills/*.md; do head -1 "$f" | grep -q '^---$' && echo "OK $f" || echo "NO FRONTMATTER $f"; done`
Expected: all `OK`.

- [ ] **Step 6: Regression guard — confirm no code was affected**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all pass (no application code was touched; this confirms nothing regressed).

- [ ] **Step 7: Commit (if any reconciliation edits were needed in steps 1–5)**

```bash
git add -A
git commit -m "chore(claude): final cross-reference integrity fixes" || echo "nothing to commit"
```

---

### Task 15: Push branch and open PR

**Files:** none

- [ ] **Step 1: Review the full diff summary**

Run: `git log --oneline main..HEAD && git diff --stat main...HEAD`
Expected: ~14 commits; changes confined to `.claude/`, `docs/`, `.gitignore`.

- [ ] **Step 2: Push the branch**

Run: `git push -u origin chore/claude-folder-rearchitecture`
Expected: branch published.

- [ ] **Step 3: Open the PR (link the spec; include the key-rotation reminder)**

```bash
gh pr create --title "Re-architect .claude/ config tree (facts/law/skills/reference)" --body "$(cat <<'EOF'
Re-architects `.claude/` into four layers per the design spec
(`docs/superpowers/specs/2026-05-27-claude-folder-rearchitecture-design.md`).

## What changed
- CLAUDE.md rewritten to facts + canonical invariants + a "where things live"
  index; Next.js 14→16; PR/Wave provenance dropped to git history.
- rules/repworth.md deduped to behavioral law (references invariants).
- Recall-only inventories moved skills/ → reference/ (migrations-log, env-vars,
  lab-notes [+topic index], review-ingestion).
- Four kept skills gained YAML frontmatter; cost-guard stale pricing stripped
  (now points to tier-config.ts).
- Deleted firecrawl.md (leaked key) + scheduled_tasks.lock; pruned Windows/rtk
  permissions; consolidated the duplicated worker-path disclaimer.
- Full verification sweep: stack versions, tier pricing, migration head, env-var
  names, and all referenced paths checked against the codebase.

## ⚠️ Required follow-up (cannot be done in-repo)
Rotate the leaked Firecrawl key `fc-88325f…` at firecrawl.dev — `git rm` does not
purge it from history; treat as compromised.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR URL printed.

- [ ] **Step 4: Report the PR URL and the key-rotation reminder to the user.**

---

## Self-Review

**Spec coverage:** firecrawl/key (T1), lock (T2), settings prune (T3), four moves (T4–T7), four skill frontmatters + pricing strip (T8–T11), CLAUDE.md rewrite incl. Next 14→16 + invariant lift + reference index + provenance drop (T12), repworth dedupe (T13), disclaimer consolidation (T4 step 6 + removal in T4–T7), full verification sweep (woven into every task + T14), branch/PR per "never push to main" (T15). All spec sections map to a task.

**Placeholder scan:** every step has concrete commands, exact new content (frontmatter, index, collapses), and expected output. No TBD/TODO.

**Type/name consistency:** new filenames (`migrations-log.md`, `env-vars.md`, `lab-notes.md`, `review-ingestion.md`) used identically in the move tasks, the CLAUDE.md index (T12 S5), and the integrity checks (T14). Skill names in frontmatter (`cost-guard`, `approval-security`, `onboarding-demo-cost-guard`, `outbox-pattern`) match the CLAUDE.md "patterns to follow" list.
