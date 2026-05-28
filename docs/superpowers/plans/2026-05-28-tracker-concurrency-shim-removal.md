# Tracker Concurrency Shim Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `src/lib/costs/concurrency-guard.ts` the single import source for `acquireConcurrencySlot`, `releaseConcurrencySlot`, and `ConcurrencyLimitExceededError`, then delete the compat re-export from `tracker.ts` — with no behavior change.

**Architecture:** Two production files import concurrency symbols through the `tracker` shim; repoint them to `concurrency-guard`. Five test files mock those symbols via `tracker` (two directly, three transitively through the real `withCostGuard`/`generate-draft`); each must mock `concurrency-guard` instead in the *same* commit as its production repoint, or the real Redis path runs. Then delete the shim.

**Tech Stack:** TypeScript (strict), Vitest, Postgres.js/Upstash Redis (concurrency-guard internals — untouched here).

**Spec:** `docs/superpowers/specs/2026-05-28-tracker-concurrency-shim-removal-design.md`

---

## Verification model (read before starting)

This work happens in a worktree nested under `.claude/worktrees/` with **no own `node_modules`**. Per CLAUDE.md, local `pnpm lint`/`pnpm test` from a nested worktree are **unreliable** (module resolution leaks to the parent). Therefore:

- **Per-task local gate:** the **grep invariant** (no concurrency symbol imported from any `tracker` path beyond what each task expects). This needs no `node_modules` and is the reliable signal that the import surgery is correct.
- **Authoritative gate:** push the branch and read the GitHub CI runner (lint, typecheck, test, build). Do this in Task 5.
- Do **not** trust a green/red `pnpm test` run inside this worktree.

Branch is already cut: `worktree-refactor+tracker-concurrency-shim-removal` from `origin/main` (d614b0c9, known-green).

---

## File map

| File | Role | Task |
|---|---|---|
| `src/lib/costs/cost-guard.ts` | prod — imports slot fns | 1 |
| `src/lib/costs/__tests__/cost-guard.test.ts` | test — direct mock | 1 |
| `src/lib/responses/__tests__/generator.test.ts` | test — transitive (real cost-guard) | 1 |
| `src/lib/responses/__tests__/review-summary.test.ts` | test — transitive (real cost-guard) | 1 |
| `worker/jobs/response-generation/generate-draft.ts` | prod — imports error class | 2 |
| `worker/jobs/response-generation/__tests__/generate-draft.test.ts` | test — direct mock + import | 2 |
| `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` | test — transitive (real generate-draft) | 2 |
| `src/lib/costs/tracker.ts` | prod — the shim | 3 |
| `docs/modular-requirement.md` | docs | 4 |

`src/lib/responses/generator.ts` is **not** modified (imports only cache fns from tracker). `src/lib/costs/__tests__/concurrency-guard.test.ts` is **not** modified (already imports directly).

---

## Task 1: Repoint the cost-guard cluster

Repointing `cost-guard.ts` breaks three tests at once (one direct, two that run the real `withCostGuard`), so all four files change in one commit.

**Files:**
- Modify: `src/lib/costs/cost-guard.ts:1-7`
- Modify: `src/lib/costs/__tests__/cost-guard.test.ts:3-29`
- Modify: `src/lib/responses/__tests__/generator.test.ts` (mock factory + 5 test bodies)
- Modify: `src/lib/responses/__tests__/review-summary.test.ts:31-49`

- [ ] **Step 1: Repoint `cost-guard.ts` import**

Replace lines 1-7:

```ts
import {
  reserveCost,
  acquireConcurrencySlot,
  finalizeCost,
  releaseCost,
  releaseConcurrencySlot,
} from './tracker';
```

with:

```ts
import { reserveCost, finalizeCost, releaseCost } from './tracker';
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
} from './concurrency-guard';
```

- [ ] **Step 2: Fix `cost-guard.test.ts` — import + split the mock**

Replace the import block (lines 3-9):

```ts
import {
  reserveCost,
  acquireConcurrencySlot,
  finalizeCost,
  releaseCost,
  releaseConcurrencySlot,
} from '../tracker';
```

with:

```ts
import { reserveCost, finalizeCost, releaseCost } from '../tracker';
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
} from '../concurrency-guard';
```

Then replace the single `vi.mock('../tracker', …)` factory (lines 11-29):

```ts
vi.mock('../tracker', () => ({
  reserveCost: vi.fn(),
  acquireConcurrencySlot: vi.fn(),
  finalizeCost: vi.fn(),
  releaseCost: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
  CostLimitExceededError: class CostLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Daily cost limit exceeded for business ${businessId}`);
      this.name = 'CostLimitExceededError';
    }
  },
  ConcurrencyLimitExceededError: class ConcurrencyLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Concurrency limit exceeded for business ${businessId}`);
      this.name = 'ConcurrencyLimitExceededError';
    }
  },
}));
```

with two factories:

```ts
vi.mock('../tracker', () => ({
  reserveCost: vi.fn(),
  finalizeCost: vi.fn(),
  releaseCost: vi.fn(),
  CostLimitExceededError: class CostLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Daily cost limit exceeded for business ${businessId}`);
      this.name = 'CostLimitExceededError';
    }
  },
}));

vi.mock('../concurrency-guard', () => ({
  acquireConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
  ConcurrencyLimitExceededError: class ConcurrencyLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Concurrency limit exceeded for business ${businessId}`);
      this.name = 'ConcurrencyLimitExceededError';
    }
  },
}));
```

(The `beforeEach` `vi.mocked(acquireConcurrencySlot)`/`releaseConcurrencySlot` lines and all assertions already reference the imported bindings, which now resolve to the `concurrency-guard` mock — no body changes needed in this file.)

- [ ] **Step 3: Fix `generator.test.ts` — remove slot stubs from tracker mock, add concurrency-guard mock**

In the `vi.mock('@/lib/costs/tracker', …)` factory, **delete** these three entries:

```ts
  acquireConcurrencySlot: vi.fn().mockResolvedValue(undefined),
```
```ts
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
```
```ts
  ConcurrencyLimitExceededError: class ConcurrencyLimitExceededError extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) {
      super(`Concurrency limit exceeded for business ${businessId}`);
    }
  },
```

(Keep `checkIdempotentCache`, `reserveCost`, `finalizeCost`, `setCachedGeneration`, `releaseCost`, `CostLimitExceededError`, `GlobalCostLimitExceededError`, `RegenBudgetExceededError`.)

Immediately **after** the closing `}));` of the tracker mock, add:

```ts
vi.mock('@/lib/costs/concurrency-guard', () => ({
  acquireConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  ConcurrencyLimitExceededError: class ConcurrencyLimitExceededError extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) {
      super(`Concurrency limit exceeded for business ${businessId}`);
    }
  },
}));
```

- [ ] **Step 4: Fix `generator.test.ts` — repoint the 5 in-body slot references**

Each affected test resolves the module with `const tracker = await import('@/lib/costs/tracker');`. In each of the 5 tests below, add this line right after that `tracker` import line:

```ts
    const concurrencyGuard = await import('@/lib/costs/concurrency-guard');
```

Then apply these exact string replacements (each occurs once):

| Find | Replace |
|---|---|
| `expect(tracker.acquireConcurrencySlot).not.toHaveBeenCalled();` | `expect(concurrencyGuard.acquireConcurrencySlot).not.toHaveBeenCalled();` |
| `expect(tracker.acquireConcurrencySlot).toHaveBeenCalledWith('biz-001');` | `expect(concurrencyGuard.acquireConcurrencySlot).toHaveBeenCalledWith('biz-001');` |
| `expect(tracker.releaseConcurrencySlot).toHaveBeenCalledWith('biz-001');` *(appears in two tests — replace **both**)* | `expect(concurrencyGuard.releaseConcurrencySlot).toHaveBeenCalledWith('biz-001');` |
| `vi.mocked(tracker.acquireConcurrencySlot).mockRejectedValueOnce(` | `vi.mocked(concurrencyGuard.acquireConcurrencySlot).mockRejectedValueOnce(` |
| `expect(tracker.releaseConcurrencySlot).not.toHaveBeenCalled();` | `expect(concurrencyGuard.releaseConcurrencySlot).not.toHaveBeenCalled();` |
| `vi.mocked(tracker.releaseConcurrencySlot).mockRejectedValueOnce(` | `vi.mocked(concurrencyGuard.releaseConcurrencySlot).mockRejectedValueOnce(` |

The 5 tests are: "demo mode … skips cost guard" (has `acquireConcurrencySlot).not`), "production mode runs full cost guard lifecycle", "releases cost reservation when concurrency slot acquisition fails", "returns result even when wrapper cleanup throws", "finalizeCost error propagates … slot released". A test that does **not** reference a slot symbol does not need the `concurrencyGuard` import line — only add it where a replacement above is applied.

- [ ] **Step 5: Fix `review-summary.test.ts` — move slot stubs to concurrency-guard mock**

In the `vi.mock('@/lib/costs/tracker', …)` factory (lines 31-49), **delete** these two lines:

```ts
  acquireConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
```

Immediately **after** the closing `}));` of that tracker mock, add:

```ts
vi.mock('@/lib/costs/concurrency-guard', () => ({
  acquireConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
}));
```

(`review-summary.test.ts` never references `ConcurrencyLimitExceededError`, so it is not added here. The `cost-guard` mock at lines 51-54 stays — it still loads the real `withCostGuard`, which now reaches this `concurrency-guard` mock.)

- [ ] **Step 6: Grep invariant for the cost-guard cluster**

Run:

```bash
grep -rn "acquireConcurrencySlot\|releaseConcurrencySlot" src/lib/costs/cost-guard.ts src/lib/responses/__tests__/generator.test.ts src/lib/responses/__tests__/review-summary.test.ts src/lib/costs/__tests__/cost-guard.test.ts | grep "tracker"
```

Expected: **no output** (no slot symbol associated with a `tracker` import/mock remains in these files). Then confirm the new mocks exist:

```bash
grep -rln "vi.mock(.*concurrency-guard" src/lib/costs/__tests__/cost-guard.test.ts src/lib/responses/__tests__/generator.test.ts src/lib/responses/__tests__/review-summary.test.ts
```

Expected: all three files listed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/costs/cost-guard.ts \
  src/lib/costs/__tests__/cost-guard.test.ts \
  src/lib/responses/__tests__/generator.test.ts \
  src/lib/responses/__tests__/review-summary.test.ts
git commit -m "refactor(costs): repoint cost-guard slot imports to concurrency-guard

cost-guard.ts now imports acquire/releaseConcurrencySlot from
concurrency-guard. Direct (cost-guard) and transitive (generator,
review-summary) tests mock concurrency-guard for the slot fns so the
real Redis path is not exercised.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Repoint the generate-draft cluster

Repointing `generate-draft.ts` breaks two tests (its own direct test, plus `ResponseGeneratorWorker.test.ts` which runs the real `generate-draft` and relies on the mocked `ConcurrencyLimitExceededError` for the `instanceof` at `generate-draft.ts:83`). All three files change in one commit.

**Files:**
- Modify: `worker/jobs/response-generation/generate-draft.ts:15-22`
- Modify: `worker/jobs/response-generation/__tests__/generate-draft.test.ts:44-73`
- Modify: `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts:86-105`

- [ ] **Step 1: Repoint `generate-draft.ts` import**

Replace lines 15-22:

```ts
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
  checkRegenBudget,
  setCachedGeneration,
} from '../../../src/lib/costs/tracker';
```

with:

```ts
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  RegenBudgetExceededError,
  checkRegenBudget,
  setCachedGeneration,
} from '../../../src/lib/costs/tracker';
import { ConcurrencyLimitExceededError } from '../../../src/lib/costs/concurrency-guard';
```

- [ ] **Step 2: Fix `generate-draft.test.ts` — split the static import**

Replace the static import block (lines 68-73):

```ts
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
} from '../../../../src/lib/costs/tracker';
```

with:

```ts
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  RegenBudgetExceededError,
} from '../../../../src/lib/costs/tracker';
import { ConcurrencyLimitExceededError } from '../../../../src/lib/costs/concurrency-guard';
```

- [ ] **Step 3: Fix `generate-draft.test.ts` — move the error class to a concurrency-guard mock**

In the `vi.mock('../../../../src/lib/costs/tracker', …)` factory (lines 44-63), **delete** this entry:

```ts
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for business ${businessId}`); }
  },
```

Immediately **after** the closing `}));` of that tracker mock (line 63), add:

```ts
vi.mock('../../../../src/lib/costs/concurrency-guard', () => ({
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for business ${businessId}`); }
  },
}));
```

The `instanceof`/`new ConcurrencyLimitExceededError('biz-1')` usages at lines 131-133 now resolve to the concurrency-guard mock (same class the SUT imports), so `instanceof` holds. No body changes.

- [ ] **Step 4: Fix `ResponseGeneratorWorker.test.ts` — move the error class to a concurrency-guard mock**

In the `vi.mock('../../../src/lib/costs/tracker', …)` factory (lines 86-105), **delete** this entry:

```ts
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for business ${businessId}`); }
  },
```

Immediately **after** the closing `}));` of that tracker mock (line 105), add:

```ts
vi.mock('../../../src/lib/costs/concurrency-guard', () => ({
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for business ${businessId}`); }
  },
}));
```

(This file runs the real `generate-draft`, whose `catch` block evaluates `err instanceof ConcurrencyLimitExceededError`. The class must be a defined export of the mocked `concurrency-guard` or that expression throws "Right-hand side of instanceof is not callable".)

- [ ] **Step 5: Grep invariant for the generate-draft cluster**

Run:

```bash
grep -rn "ConcurrencyLimitExceededError" worker/jobs/response-generation/generate-draft.ts worker/jobs/response-generation/__tests__/generate-draft.test.ts worker/jobs/__tests__/ResponseGeneratorWorker.test.ts | grep "tracker"
```

Expected: **no output**. Then confirm the new mocks/imports point at concurrency-guard:

```bash
grep -rn "concurrency-guard" worker/jobs/response-generation/generate-draft.ts worker/jobs/response-generation/__tests__/generate-draft.test.ts worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
```

Expected: one import line in `generate-draft.ts` and one `vi.mock` (+ split import) in each of the two test files.

- [ ] **Step 6: Commit**

```bash
git add worker/jobs/response-generation/generate-draft.ts \
  worker/jobs/response-generation/__tests__/generate-draft.test.ts \
  worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
git commit -m "refactor(worker): repoint ConcurrencyLimitExceededError to concurrency-guard

generate-draft.ts imports the error class from concurrency-guard. Its
direct test and the ResponseGeneratorWorker test (which runs the real
generate-draft) mock concurrency-guard for the class so the instanceof
classification still holds.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Delete the shim

With both clusters repointed, nothing imports the three symbols from `tracker`. Remove the re-export.

**Files:**
- Modify: `src/lib/costs/tracker.ts:3-10` (delete)

- [ ] **Step 1: Delete the comment + re-export block**

Delete these lines from `src/lib/costs/tracker.ts` (currently lines 3-10):

```ts
// Compat shim: concurrency moved to ./concurrency-guard. Kept so external
// consumers (ResponseGeneratorWorker) resolve unchanged. Follow-up: migrate
// that import and drop this line once the parallel RGW work has landed.
export {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
  ConcurrencyLimitExceededError,
} from './concurrency-guard';
```

Leave the surrounding code intact: the `import { getCacheRedis } from '@/lib/db/redis-cache';` line above and the `// ── Error classes ───` section below.

- [ ] **Step 2: Repo-wide grep invariant — zero concurrency imports from tracker**

Run:

```bash
grep -rn "acquireConcurrencySlot\|releaseConcurrencySlot\|ConcurrencyLimitExceededError" --include="*.ts" src worker \
  | grep -iE "from .*tracker|vi\.mock\(.*tracker" \
  | grep -v "concurrency-guard"
```

Expected: **no output** — no production import, type import, or `vi.mock` of a `tracker` path references any concurrency symbol. Confirm `tracker.ts` no longer exports them:

```bash
grep -n "Concurrency" src/lib/costs/tracker.ts
```

Expected: **no output**.

- [ ] **Step 3: Commit**

```bash
git add src/lib/costs/tracker.ts
git commit -m "refactor(costs): delete tracker.ts concurrency re-export shim

All consumers now import the concurrency symbols directly from
concurrency-guard (Task 1 + Task 2). Single authoritative source;
closes the modular-requirement.md follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Update the requirement doc

**Files:**
- Modify: `docs/modular-requirement.md` (the `tracker.ts` section, ~lines 82-102)

- [ ] **Step 1: Mark the follow-up done**

In the `### \`src/lib/costs/tracker.ts\`` section, replace the **`- **Follow-up (open):**`** bullet (the multi-line paragraph beginning "once the parallel `ResponseGeneratorWorker` work has landed…") with:

```markdown
- **✅ Follow-up done — 2026-05-28.** Shim deleted. Repointed `cost-guard.ts`
  (slot fns) and `generate-draft.ts` (`ConcurrencyLimitExceededError`) to
  `./concurrency-guard`, and moved the concurrency mocks in all five consumer
  tests — `cost-guard.test.ts`, `generator.test.ts`, `review-summary.test.ts`
  (transitive via `withCostGuard`), plus `generate-draft.test.ts` and
  `ResponseGeneratorWorker.test.ts` (transitive via real `generate-draft`). The
  doc's original list named only the first three; the two worker tests were
  surfaced during implementation. `concurrency-guard.ts` is now the single
  source for the three symbols.
```

- [ ] **Step 2: Commit**

```bash
git add docs/modular-requirement.md
git commit -m "docs: mark tracker concurrency shim follow-up done

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Push, open PR, verify CI (authoritative gate)

This is where the real lint/typecheck/test/build verification happens — **not** in the nested worktree.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin worktree-refactor+tracker-concurrency-shim-removal
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main \
  --title "refactor(costs): delete tracker.ts concurrency re-export shim" \
  --body "$(cat <<'EOF'
Repoints all consumers of the concurrency symbols off the `tracker.ts`
compat re-export onto `concurrency-guard`, then deletes the shim. Pure
import-path surgery — no behavior change.

Consumers repointed: `cost-guard.ts`, `generate-draft.ts`. Test mocks moved
to `concurrency-guard`: `cost-guard.test.ts`, `generator.test.ts`,
`review-summary.test.ts`, `generate-draft.test.ts`,
`ResponseGeneratorWorker.test.ts` (the last two were missing from the
original follow-up note; surfaced during implementation).

Spec: docs/superpowers/specs/2026-05-28-tracker-concurrency-shim-removal-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for and read CI**

```bash
gh pr checks --watch
```

Expected: lint, typecheck, test, build all **pass**. If the transitive tests (`generator`, `review-summary`, `ResponseGeneratorWorker`) fail with a Redis connection / timeout error or "instanceof not callable", a concurrency-guard mock was missed — revisit Task 1 Step 5 / Task 2 Step 4 and recheck the grep invariants.

- [ ] **Step 4: Report**

Report PR URL and CI status. Done when all four checks are green.

---

## Self-review notes

- **Spec coverage:** every spec consumer maps to a task — cost-guard cluster (T1), generate-draft cluster (T2), shim deletion (T3), doc update (T4), CI gate (T5). `generator.ts` correctly has no source task (only its test, in T1). Out-of-scope (full 13-export split) is honored — `tracker.ts` keeps cost/cache/regen.
- **Type consistency:** the three symbol names (`acquireConcurrencySlot`, `releaseConcurrencySlot`, `ConcurrencyLimitExceededError`) are used identically across all tasks and match `concurrency-guard.ts`'s actual exports.
- **No placeholders:** every code step shows full before/after; the only "find" without a full file dump is the one-line in-body replacements in T1S4, which are exact strings.
- **Atomicity:** each repoint commit includes its coupled (direct + transitive) test fixes, so no commit lands a known-red suite — the invariant from lab-note 2437.
