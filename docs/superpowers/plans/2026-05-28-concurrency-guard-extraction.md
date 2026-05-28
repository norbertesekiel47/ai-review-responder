# Concurrency-Guard Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the concurrency-slot sub-system out of `src/lib/costs/tracker.ts` into a focused `src/lib/costs/concurrency-guard.ts`, with zero runtime behavior change.

**Architecture:** Pure code-move. The new module owns `acquireConcurrencySlot`/`releaseConcurrencySlot`, its Lua script, key helper, constants, and `ConcurrencyLimitExceededError`. `tracker.ts` keeps the coupled cost-reservation phase machine + regen budget and adds a one-line compat re-export so external consumers (`ResponseGeneratorWorker.ts`, edited in parallel) resolve unchanged. Only `cost-guard.ts` (owned here) is repointed at the new module.

**Tech Stack:** TypeScript (strict), Vitest, Postgres.js / ioredis (mocked in tests), pnpm.

**Note — this is a refactor, not new behavior.** The tests already exist in `tracker.test.ts`. "TDD" here means moving the characterization tests first, then moving the code under them, and verifying they stay green at every step.

**Note — nested-worktree gotcha.** This worktree lives under `.claude/worktrees/`. Per CLAUDE.md, local `lint`/`test` module resolution can leak into the parent repo. Local `vitest` runs below are best-effort signal; the **PR's CI runner is the authoritative gate**.

---

### Task 1: Create `concurrency-guard.ts` and its test

**Files:**
- Create: `src/lib/costs/concurrency-guard.ts`
- Test: `src/lib/costs/__tests__/concurrency-guard.test.ts`

- [ ] **Step 1: Write the test file (moved from `tracker.test.ts`, importing the not-yet-existing module)**

Create `src/lib/costs/__tests__/concurrency-guard.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Set env vars BEFORE any concurrency-guard import triggers getCacheRedisOptions()
beforeAll(() => {
  process.env.REDIS_CACHE_URL = 'redis://localhost:6379';
  process.env.REDIS_CACHE_TOKEN = 'test-token';
});

// ── Mock Redis ───────────────────────────────────────────────────────

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  incr: vi.fn(),
  decr: vi.fn(),
  expire: vi.fn(),
  eval: vi.fn(),
};

vi.mock('ioredis', () => ({
  default: class MockRedis {
    get = mockRedis.get;
    set = mockRedis.set;
    incr = mockRedis.incr;
    decr = mockRedis.decr;
    expire = mockRedis.expire;
    eval = mockRedis.eval;
  },
}));

// ── Tests ────────────────────────────────────────────────────────────

describe('acquireConcurrencySlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquires slot when under limit', async () => {
    mockRedis.eval.mockResolvedValueOnce(['ok', 1]);

    const { acquireConcurrencySlot } = await import('../concurrency-guard');
    await expect(acquireConcurrencySlot('biz-001')).resolves.toBeUndefined();
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('throws ConcurrencyLimitExceededError at max+1 and releases', async () => {
    // Lua script has already rolled back (DECR'd) when it returns 'exceeded'.
    mockRedis.eval.mockResolvedValueOnce(['exceeded', 4]);

    const { acquireConcurrencySlot, ConcurrencyLimitExceededError } =
      await import('../concurrency-guard');
    await expect(acquireConcurrencySlot('biz-001')).rejects.toThrow(
      ConcurrencyLimitExceededError,
    );
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });
});

describe('releaseConcurrencySlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decrements and floors at 0', async () => {
    mockRedis.decr.mockResolvedValueOnce(-1);
    mockRedis.set.mockResolvedValueOnce('OK');

    const { releaseConcurrencySlot } = await import('../concurrency-guard');
    await releaseConcurrencySlot('biz-001');

    expect(mockRedis.decr).toHaveBeenCalled();
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('gen:active:biz-001'),
      '0',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/lib/costs/__tests__/concurrency-guard.test.ts`
Expected: FAIL — `Failed to load url ../concurrency-guard` / "Cannot find module".

- [ ] **Step 3: Create the new module**

Create `src/lib/costs/concurrency-guard.ts`. The comment is rewritten to be self-contained (the original referenced `RESERVE_COST_LUA`, which stays in `tracker.ts`):

```ts
import { getCacheRedis } from '@/lib/db/redis-cache';

/**
 * Per-business generation concurrency semaphore, backed by a Redis counter
 * with a TTL safety net. Acquire/release are paired by the caller; the TTL
 * guarantees a slot is reclaimed even if a release is lost to a crash.
 */

export class ConcurrencyLimitExceededError extends Error {
  constructor(public readonly businessId: string) {
    super(`Concurrency limit exceeded for business ${businessId}`);
    this.name = 'ConcurrencyLimitExceededError';
  }
}

const MAX_CONCURRENCY_PER_BUSINESS = 3;
const CONCURRENCY_TTL_SECONDS = 300; // 5-minute safety net

function concurrencyKey(businessId: string): string {
  return `gen:active:${businessId}`;
}

// INCR + limit check + TTL + rollback collapsed into one atomic Lua script so a
// mid-sequence crash cannot leave a concurrency-slot key without its TTL.
const ACQUIRE_CONCURRENCY_LUA = `
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local cur = redis.call('INCR', KEYS[1])
if cur > limit then
  redis.call('DECR', KEYS[1])
  return {'exceeded', cur}
end
redis.call('EXPIRE', KEYS[1], ttl)
return {'ok', cur}
`;

export async function acquireConcurrencySlot(
  businessId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const key = concurrencyKey(businessId);

  const raw = (await redis.eval(
    ACQUIRE_CONCURRENCY_LUA,
    1,
    key,
    String(MAX_CONCURRENCY_PER_BUSINESS),
    String(CONCURRENCY_TTL_SECONDS),
  )) as [string, number];

  if (raw[0] === 'exceeded') {
    throw new ConcurrencyLimitExceededError(businessId);
  }
}

export async function releaseConcurrencySlot(
  businessId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const result = await redis.decr(concurrencyKey(businessId));
  if (result < 0) {
    await redis.set(concurrencyKey(businessId), '0');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/lib/costs/__tests__/concurrency-guard.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/costs/concurrency-guard.ts src/lib/costs/__tests__/concurrency-guard.test.ts
git commit -m "refactor(costs): add concurrency-guard module + tests"
```

At this point `tracker.ts` still contains the (now duplicated) concurrency code — that is fixed in Task 2. Both test files pass.

---

### Task 2: Slim `tracker.ts` and remove the moved test blocks

**Files:**
- Modify: `src/lib/costs/tracker.ts`
- Modify: `src/lib/costs/__tests__/tracker.test.ts`

- [ ] **Step 1: Remove the concurrency code from `tracker.ts` and add the compat re-export**

Delete these exact blocks from `src/lib/costs/tracker.ts`:

1. The error class (and its trailing blank line):
```ts
export class ConcurrencyLimitExceededError extends Error {
  constructor(public readonly businessId: string) {
    super(`Concurrency limit exceeded for business ${businessId}`);
    this.name = 'ConcurrencyLimitExceededError';
  }
}
```

2. The two constants (in the Constants block):
```ts
const MAX_CONCURRENCY_PER_BUSINESS = 3;
```
```ts
const CONCURRENCY_TTL_SECONDS = 300; // 5-minute safety net
```

3. The key helper:
```ts
function concurrencyKey(businessId: string): string {
  return `gen:active:${businessId}`;
}
```

4. The Lua script with its comment:
```ts
// INCR + limit check + TTL + rollback collapsed into one atomic Lua script.
// Same rationale as RESERVE_COST_LUA — prevents concurrency-slot keys
// from leaking past their TTL window after a mid-sequence crash.
const ACQUIRE_CONCURRENCY_LUA = `
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local cur = redis.call('INCR', KEYS[1])
if cur > limit then
  redis.call('DECR', KEYS[1])
  return {'exceeded', cur}
end
redis.call('EXPIRE', KEYS[1], ttl)
return {'ok', cur}
`;
```

5. `acquireConcurrencySlot`:
```ts
export async function acquireConcurrencySlot(
  businessId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const key = concurrencyKey(businessId);

  const raw = (await redis.eval(
    ACQUIRE_CONCURRENCY_LUA,
    1,
    key,
    String(MAX_CONCURRENCY_PER_BUSINESS),
    String(CONCURRENCY_TTL_SECONDS),
  )) as [string, number];

  if (raw[0] === 'exceeded') {
    throw new ConcurrencyLimitExceededError(businessId);
  }
}
```

6. `releaseConcurrencySlot`:
```ts
export async function releaseConcurrencySlot(
  businessId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const result = await redis.decr(concurrencyKey(businessId));
  if (result < 0) {
    await redis.set(concurrencyKey(businessId), '0');
  }
}
```

Then add, immediately after the `import { getCacheRedis } ...` line at the top of `tracker.ts`:

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

- [ ] **Step 2: Remove the now-relocated `describe` blocks from `tracker.test.ts`**

In `src/lib/costs/__tests__/tracker.test.ts`, delete the entire `describe('acquireConcurrencySlot', ...)` block and the entire `describe('releaseConcurrencySlot', ...)` block (they now live in `concurrency-guard.test.ts`). Leave every other block untouched (`reserveCost`, `finalizeCost`, `releaseCost`, `checkRegenBudget`, `checkIdempotentCache`, and the `../audit` blocks `calculateCostUsd` / `recordApiCost`).

- [ ] **Step 3: Run the costs test files to verify they pass**

Run: `pnpm exec vitest run src/lib/costs/__tests__/tracker.test.ts src/lib/costs/__tests__/concurrency-guard.test.ts src/lib/costs/__tests__/cost-guard.test.ts`
Expected: PASS. `cost-guard` still imports the concurrency fns from `./tracker`, which now resolves them via the re-export.

- [ ] **Step 4: Commit**

```bash
git add src/lib/costs/tracker.ts src/lib/costs/__tests__/tracker.test.ts
git commit -m "refactor(costs): remove concurrency from tracker, re-export from guard"
```

---

### Task 3: Repoint `cost-guard.ts` at the new module

**Files:**
- Modify: `src/lib/costs/cost-guard.ts:1-7`

- [ ] **Step 1: Split the import**

Replace the existing import block at the top of `src/lib/costs/cost-guard.ts`:

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

No other change to the file.

- [ ] **Step 2: Run the cost-guard test to verify it passes**

Run: `pnpm exec vitest run src/lib/costs/__tests__/cost-guard.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/costs/cost-guard.ts
git commit -m "refactor(costs): import concurrency fns from concurrency-guard in cost-guard"
```

---

### Task 4: Full verification and PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full costs + downstream consumer tests locally (best-effort signal)**

Run:
```bash
pnpm exec vitest run src/lib/costs src/lib/responses/__tests__/generator.test.ts worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
```
Expected: PASS. (These exercise the consumers that import via `@/lib/costs/tracker`.)

- [ ] **Step 2: Push the branch**

```bash
git push -u origin worktree-refactor+costs-concurrency-guard
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "refactor(costs): extract concurrency-guard from tracker.ts (Tier-2)" \
  --body "Extracts the concurrency-slot sub-system into src/lib/costs/concurrency-guard.ts per docs/modular-requirement.md. Pure code-move + compat re-export; ResponseGeneratorWorker untouched (parallel-work safe). Spec: docs/superpowers/specs/2026-05-28-concurrency-guard-extraction-design.md"
```

- [ ] **Step 4: Read the CI runner — the authoritative gate**

Wait for and read the four CI checks (`lint`, `typecheck`, `test`, `build`). All must be green before declaring done. If any fail, debug from the runner logs (not local nested-worktree runs).

---

## Self-Review

**1. Spec coverage:**
- New `concurrency-guard.ts` with 3 public exports + private internals → Task 1. ✓
- `tracker.ts` slimmed + compat re-export → Task 2 Step 1. ✓
- `cost-guard.ts` repointed → Task 3. ✓
- `ResponseGeneratorWorker.ts` untouched → never edited in any task. ✓
- New `concurrency-guard.test.ts` + blocks removed from `tracker.test.ts` → Task 1 Step 1, Task 2 Step 2. ✓
- CI as authoritative gate → Task 4 Step 4. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code blocks are complete and copy-pasteable.

**3. Type/name consistency:** `acquireConcurrencySlot`, `releaseConcurrencySlot`, `ConcurrencyLimitExceededError`, `concurrencyKey`, `ACQUIRE_CONCURRENCY_LUA`, `MAX_CONCURRENCY_PER_BUSINESS`, `CONCURRENCY_TTL_SECONDS` — identical strings across the create (Task 1), delete (Task 2), and re-export (Task 2) steps. Redis key prefix `gen:active:` matches the `releaseConcurrencySlot` test assertion. ✓
