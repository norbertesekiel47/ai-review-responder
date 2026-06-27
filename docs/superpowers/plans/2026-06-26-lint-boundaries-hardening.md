# Lint & Pre-push Hardening Implementation Plan (#234, #269, #374)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make three bug classes structurally impossible at author-time — UI/route code runtime-importing worker-only modules (#234), unlinted Railway code + surviving dead imports (#269), and false-green pushes that skip file-reading guard tests (#374) — via two config files and one new guard test, in one combined PR.

**Architecture:** Three coordinated changes to `eslint.config.mjs`, `package.json`, and `lefthook.yml`, plus a new ESLint-Node-API guard test. Sequenced B → A → C so each phase lands green on `pnpm lint && pnpm typecheck && pnpm test`. The flat-config `no-restricted-imports` no-merge footgun is mitigated by extracting reusable ban-pattern constants and proving the resolved bans with a TDD guard test.

**Tech Stack:** ESLint 10 flat config, `eslint-config-next/core-web-vitals`, `@typescript-eslint/no-restricted-imports` (+ `no-unused-vars`) — both already resolve via the next flat config (no new dependency), Vitest 4, lefthook 2, pnpm.

---

## Worktree discipline (read before any edit)

- **All work happens in the sibling worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374`.
- Branch `chore/lint-boundaries-234-269-374` (off `origin/main`).
- Every Write/Edit path MUST be absolute under that worktree root. Editing the main checkout (`/Users/norbertesekiel/Developer/startups/RepWorth/...`) silently lands in `main`'s tree — never do that.
- The shell cwd resets to the main repo between Bash calls. Begin EVERY bash command with:
  `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && …`

## Verification gate (run from the worktree root after every phase)

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
  pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit
```

`pnpm lint` is the gate that changes meaning mid-plan: it is `eslint src` until Task B1 widens it to `eslint .`.

## Ground-truth findings (verified 2026-06-26; re-verify the count in B1)

- `@typescript-eslint/no-unused-vars` and `@typescript-eslint/no-restricted-imports` both resolve through `eslint-config-next` — **no new dependency**. Confirmed by injecting each via `eslint --rule` against the real config.
- Enabling `@typescript-eslint/no-unused-vars` (`^_` ignores) surfaces **126** violations: **src 100, worker 23, e2e 3, scripts 0**.
- Widening to `eslint .` also surfaces **6 pre-existing "Unused eslint-disable directive" warnings** (severity = warning, do NOT fail the gate) in worker test files — hidden today only because `eslint src` never lints `worker/`. Locations: `worker/__tests__/correlation-chain.test.ts:32`, `worker/ingress/__tests__/resend-webhook-bounce.test.ts:30`, `worker/jobs/__tests__/DemoGenerationWorker.test.ts:52` & `:96`, `worker/jobs/__tests__/PlaceIdValidationWorker.test.ts:19` & `:26`. Removed in B2 for hygiene.
- #234 surface in `src/app`/`src/components` is exactly three lines: `src/app/api/onboarding/start/route.ts:16` and `src/app/api/settings/route.ts:3` use `import type postgres from 'postgres'` (type-only → must stay allowed via `allowTypeImports: true`); `src/app/api/admin/jobs/route.ts:2` does `import { Queue } from 'bullmq'` at runtime (the one genuine case → scoped disable + follow-up issue).
- `src/instrumentation.ts` exists (runs on Vercel); `src/middleware.ts` does NOT. instrumentation imports only `@sentry/nextjs` + `@/lib/*` — safe to put under the ban zone.
- `src/lib/**` is shared (worker + Vercel) and legitimately imports `postgres`/`bullmq`/`openai` — the #234 ban must NEVER touch `src/lib/**`.

## The flat-config no-merge footgun (per-task hazard for Phase A)

`no-restricted-imports` (and its `@typescript-eslint` twin) does **NOT merge `patterns` across flat-config objects**: for a given file the **LAST** matching object that sets the rule wins, and its `patterns` array fully replaces any earlier one. Rule **on/off** and *different* rule IDs still merge last-wins independently. Consequences this plan must honour:

- Every new/edited zone must **restate** every inherited ban it still wants (parent-traversal, `@/app`), or that ban silently disappears for files that zone is the last matcher of.
- `@/app` ban must apply to `src/components/**` but **must NOT apply to `src/app/**`** (app co-located siblings legitimately import each other — preserved today by zone 2 ignoring `app/**`). → app and components need **separate** entry-surface zones.
- SDK bans must reach `src/app/**` + `src/components/**` + `src/instrumentation.ts` but **never** `src/lib/**` → the bans cannot live on zone 2 (which also matches `src/lib/**`).
- Mitigation: (1) extract the patterns into named constants (one authoritative definition each); (2) the Phase-A guard test proves the *resolved* bans fire and don't over-fire — it is the regression guard against a future zone edit dropping a ban.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `package.json` | `lint` script: `eslint src` → `eslint .` | B1 |
| `eslint.config.mjs` | enable `no-unused-vars`; add invariant-#1 SDK ban zones via reusable constants | B1, A |
| (repo-wide source) | mechanical removal/`_`-prefix of the 126 unused bindings + 6 dead disable directives | B2 |
| `src/app/api/admin/jobs/route.ts` | scoped `eslint-disable` + rationale on the runtime `bullmq` import | A |
| `src/__tests__/eslint-boundaries.test.ts` | **NEW** — ESLint-Node-API guard test for the resolved bans (TDD) | A |
| `.claude/CLAUDE.md` | one-line note that invariant #1 is now ESLint-enforced | A |
| `lefthook.yml` | unconditional `guards: pnpm vitest run src/__tests__` pre-push step + comment | C |

---

## Phase B1 — Widen lint scope + enable the unused-vars rule (surfaces the 126)

**Goal:** Turn on the two missing protections so the 126 become visible. This phase intentionally ends **red** on `pnpm lint` (126 errors) — that is the expected handoff into B2. Run `pnpm typecheck && pnpm test` to confirm B1 changed nothing else.

**Files:**
- Modify: `package.json` (the `lint` script, line 16)
- Modify: `eslint.config.mjs` (add one rules object after the `...nextCoreWebVitals` spread)

- [ ] **Step 1: Re-measure the current violation count (authoritative list for B2)**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
pnpm exec eslint . --rule '{"@typescript-eslint/no-unused-vars":["error",{"argsIgnorePattern":"^_","varsIgnorePattern":"^_","caughtErrorsIgnorePattern":"^_"}]}' -f json 2>/dev/null > /tmp/unused-baseline.json; \
node -e 'const d=JSON.parse(require("fs").readFileSync("/tmp/unused-baseline.json","utf8"));const byDir={};let t=0;const cwd=process.cwd();for(const f of d)for(const m of f.messages)if(m.ruleId==="@typescript-eslint/no-unused-vars"){t++;const k=f.filePath.replace(cwd+"/","").split("/")[0];byDir[k]=(byDir[k]||0)+1}console.log("TOTAL",t);console.log(byDir)'
```
Expected: ≈ `TOTAL 126` and `{ src: 100, worker: 23, e2e: 3 }` (numbers may drift slightly — this run is the source of truth for B2). Keep `/tmp/unused-baseline.json`.

- [ ] **Step 2: Widen the `lint` script to `eslint .`**

In `package.json`, change:
```json
    "lint": "eslint src",
```
to:
```json
    "lint": "eslint .",
```
Rationale: `eslint .` covers `worker/`, `scripts/`, `e2e/` and any future top-level dir; build artifacts (`.next/out/build/coverage`, `**/*.mjs`) are already in the `ignores` of `eslint.config.mjs`, and `node_modules` is ESLint-ignored by default. The lefthook `lint` step calls `pnpm lint`, so it inherits this with no edit.

- [ ] **Step 3: Enable `@typescript-eslint/no-unused-vars` globally**

In `eslint.config.mjs`, immediately after the `...nextCoreWebVitals,` line (line 20), insert a new flat-config object with **no `files` key** (so it applies to every linted file across `src/`, `worker/`, `scripts/`, `e2e/`):
```js
  {
    // #269: dead imports/vars survived CI because no unused rule existed
    // anywhere (only react/jsx-no-undef). Enable the @typescript-eslint rule
    // (resolves via eslint-config-next — no new dependency). `^_` opts a binding
    // out (args, locals, caught errors) when it is intentionally unused.
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
```
(Different rule ID from `no-restricted-imports`, so later boundary zones do not clobber it; placement after the next spread keeps it ahead of nothing that re-disables it.)

- [ ] **Step 4: Confirm the rule is live and the scope widened (expected RED)**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && pnpm lint 2>&1 | tail -5
```
Expected: FAIL — ends with roughly `✖ 126 … (126 errors, 6 warnings)` (the 6 warnings are the pre-existing unused-disable directives; the 126 errors are the unused vars). This red state is the intended B1→B2 handoff. Do NOT commit B1 alone if your flow requires every commit green — instead fold B1 + B2 into one commit (B1 + the cleanup), OR commit B1 with `--no-verify` understanding B2 immediately follows. **Recommended: do not commit until B2 is green** (treat B1+B2 as one landing).

- [ ] **Step 5: Confirm B1 changed nothing else**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && pnpm typecheck && pnpm test 2>&1 | tail -5
```
Expected: typecheck PASS, tests PASS (B1 only flipped lint config + scope).

**Rollback/abort (B1):** `git checkout -- package.json eslint.config.mjs` fully reverts B1 (it touches only those two files).

---

## Phase B2 — Mechanical cleanup of the 126 (+ 6 dead directives) to green

**Goal:** Resolve every `no-unused-vars` error and remove the 6 now-surfaced dead disable directives, with **zero behavior change**. Categorise each finding, fix, and prove green with `pnpm lint && pnpm typecheck && pnpm test`. `tsc` is the safety net: removing a binding that is actually used (e.g. a type-only import the rule mis-judged — it will not, but tsc guarantees it) breaks typecheck, so run it after each batch.

**Files:** repo-wide — wherever Step 1's list points (`src/**`, `worker/**`, `e2e/**`). This is mechanical, not TDD.

- [ ] **Step 1: Regenerate the authoritative finding list**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
pnpm lint -f json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const cwd=process.cwd();for(const f of d)for(const m of f.messages)if(m.ruleId==="@typescript-eslint/no-unused-vars")console.log(`${f.filePath.replace(cwd+"/","")}:${m.line}:${m.column}  ${m.message}`)'
```
This prints every finding as `path:line:col  message`. Work top-to-bottom. (Fix bottom-of-file findings before top-of-file ones within a file so line numbers don't shift under you, or just re-run the list after each file.)

- [ ] **Step 2: Fix each finding by category (no behavior change)**

Three categories, in priority order:

1. **Genuinely dead** (unused import, unused local, unused destructured name) → **delete** it. Example — an import that nothing references:
   ```ts
   // before
   import { foo, bar } from '@/lib/x'; // `bar` flagged unused
   // after
   import { foo } from '@/lib/x';
   ```
2. **Intentionally unused** (a function arg you must keep for signature/position, a caught error you ignore, a destructure-to-drop) → **prefix with `_`** so the `^_` ignore opts it out. Examples:
   ```ts
   // unused positional arg kept for signature
   function handler(_req: NextRequest, res: NextResponse) { /* uses res */ }
   // caught error not inspected
   try { /* … */ } catch (_err) { return fallback; }
   // drop a field via rest
   const { secret: _secret, ...safe } = payload;
   ```
3. **Rare legitimate keep that cannot be `_`-prefixed** (e.g. a named import required for a side-effect type-augmentation, or a binding a test framework reflects on) → **scoped disable with a stated reason**:
   ```ts
   // eslint-disable-next-line @typescript-eslint/no-unused-vars -- <one-line why this binding must stay>
   ```
   Use this sparingly; prefer delete or `_`-prefix. Every disable MUST carry a `--` rationale.

Batch edits per file (avoid 100 one-line commits). Do not change runtime behavior — if a removal would alter behavior, it was not actually dead; re-examine.

- [ ] **Step 3: Remove the 6 now-surfaced dead `eslint-disable` directives**

Delete the unused `// eslint-disable* … @typescript-eslint/no-explicit-any` directive lines at (re-confirm exact lines via `pnpm lint` warnings — they may shift):
- `worker/__tests__/correlation-chain.test.ts`
- `worker/ingress/__tests__/resend-webhook-bounce.test.ts`
- `worker/jobs/__tests__/DemoGenerationWorker.test.ts` (two)
- `worker/jobs/__tests__/PlaceIdValidationWorker.test.ts` (two)

These report "no problems were reported from '@typescript-eslint/no-explicit-any'" — the rule finds nothing there, so the directive is dead. Removing a dead directive cannot introduce an error. This keeps `eslint .` warning-clean.

- [ ] **Step 4: Verify green**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && pnpm lint 2>&1 | tail -3 && pnpm typecheck && pnpm test 2>&1 | tail -5
```
Expected: `pnpm lint` exits 0 with **0 errors, 0 warnings**; typecheck PASS; tests PASS.

- [ ] **Step 5: Commit B1 + B2 together**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
git add -A && git commit -m "chore(lint): widen to eslint . + enable no-unused-vars; clear 126 dead bindings (#269)"
```

**Rollback/abort (B2):** cleanup is working-tree edits only — `git checkout -- <file>` reverts a bad file; committing per-batch (optional) gives finer-grained `git revert`. If `tsc` fails after a batch, a removal was not actually dead — restore that binding.

---

## Phase A — #234: `Vercel = UI only` as an ESLint boundary (TDD)

**Goal:** Forbid runtime imports of `openai`, `@anthropic-ai/sdk`, `bullmq`, `postgres`, the response generator, and the worker queue registry from `src/app/**` + `src/components/**` + `src/instrumentation.ts` (type-only imports allowed); scope-disable the one genuine case; prove it all with an ESLint-Node-API guard test written test-first; note the enforcement in CLAUDE.md.

**Hazard (whole phase):** the flat-config no-merge footgun (see top section). Mitigation: named ban constants + the guard test below is the arbiter — write it first, watch it fail, then tune `eslint.config.mjs` until it passes.

**Files:**
- Create: `src/__tests__/eslint-boundaries.test.ts`
- Modify: `eslint.config.mjs` (extract constants; modify the `components/ui` zone; add app-surface + components-surface zones)
- Modify: `src/app/api/admin/jobs/route.ts` (line 2 — scoped disable + rationale)
- Modify: `.claude/CLAUDE.md` (invariant #1 note)

### Task A1: Guard test (test-first)

- [ ] **Step 1: Write the failing guard test**

Create `src/__tests__/eslint-boundaries.test.ts`:
```ts
import { ESLint } from 'eslint';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Drives the resolved flat config over in-memory fixtures via the ESLint Node
// API. This is the permanent regression guard for the no-restricted-imports
// no-merge footgun: a future zone edit that silently drops a ban fails here.
const RESTRICTED_RULE_IDS = new Set([
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
]);

let eslint: ESLint;
beforeAll(() => {
  // Default flat-config discovery from cwd (the worktree/repo root).
  eslint = new ESLint();
});

// Returns only restricted-import messages so unrelated config noise can't
// flip an assertion. `filePath` is virtual — used solely for config matching.
async function restrictedMessages(code: string, relPath: string) {
  const filePath = path.join(process.cwd(), relPath);
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return result.messages.filter(
    (m) => m.ruleId != null && RESTRICTED_RULE_IDS.has(m.ruleId),
  );
}

const FORBIDDEN_RUNTIME = [
  ["import OpenAI from 'openai';", 'openai'],
  ["import Anthropic from '@anthropic-ai/sdk';", '@anthropic-ai/sdk'],
  ["import { Queue } from 'bullmq';", 'bullmq'],
  ["import postgres from 'postgres';", 'postgres'],
  ["import { generateResponse } from '@/lib/responses/generator';", 'generator'],
] as const;

describe('invariant #1 — Vercel UI surface may not runtime-import worker-only modules', () => {
  it.each(FORBIDDEN_RUNTIME)('app route importing %s errors', async (code) => {
    const msgs = await restrictedMessages(
      `${code}\nexport function GET() { return new Response('ok'); }\n`,
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('app route importing worker/queues errors', async () => {
    const msgs = await restrictedMessages(
      "import { reviewQueue } from '../../../../worker/queues';\nexport function GET() { return new Response('ok'); }\n",
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('components/ui primitive importing openai errors (ui zone not clobbered)', async () => {
    const msgs = await restrictedMessages(
      "import OpenAI from 'openai';\nexport const X = () => null;\n",
      'src/components/ui/_fixture.tsx',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('shared src/lib importing openai does NOT error (shared boundary intact)', async () => {
    const msgs = await restrictedMessages(
      "import OpenAI from 'openai';\nexport const x = OpenAI;\n",
      'src/lib/_fixture.ts',
    );
    expect(msgs).toHaveLength(0);
  });

  it('app route type-only postgres import is allowed', async () => {
    const msgs = await restrictedMessages(
      "import type postgres from 'postgres';\nexport type Sql = postgres.Sql;\nexport function GET() { return new Response('ok'); }\n",
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs).toHaveLength(0);
  });

  it('app route parent-traversal import still errors (inherited ban kept)', async () => {
    const msgs = await restrictedMessages(
      "import { x } from '../../foo';\nexport function GET() { return new Response(String(x)); }\n",
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('components (non-ui) importing @/app still errors (inherited @/app ban kept)', async () => {
    const msgs = await restrictedMessages(
      "import { handler } from '@/app/api/x/route';\nexport const C = () => handler;\n",
      'src/components/dashboard/_fixture.tsx',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test — expect RED**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && pnpm vitest run src/__tests__/eslint-boundaries.test.ts 2>&1 | tail -25
```
Expected: FAIL — the SDK/generator/queues/ui assertions fail (no bans exist yet); the parent-traversal and `@/app` assertions already pass (existing zones), and the `src/lib` + type-only assertions pass (no ban yet). At least the 5 forbidden-runtime + queues + ui assertions are red.

**Hazard:** if a fixture produces a fatal parse error (ruleId `null` — would mean the next config is type-aware on virtual files), the `restrictedMessages` filter drops it, so it cannot false-pass; but a forbidden case could then false-FAIL. The config is not type-aware (verified: `eslint .` produced zero fatal parse errors on real files), so this should not occur. If it does, point fixture `filePath`s at an existing dir (e.g. a real route folder) so config resolves identically — the imports are still virtual text.

### Task A2: Implement the boundary zones (make A1 green)

- [ ] **Step 3: Extract reusable ban constants + add the SDK ban zones**

Edit `eslint.config.mjs`. At the top of the file (after the import, before `const config = [`), add the single-source-of-truth constants:
```js
// --- Reusable no-restricted-imports patterns (single source of truth) -------
// no-restricted-imports does NOT merge `patterns` across flat-config objects;
// each zone restates the bans it wants. Defining the patterns once here keeps
// the restatements honest. The guard test (src/__tests__/eslint-boundaries.test.ts)
// proves the *resolved* bans fire and don't over-fire.
const PARENT_TRAVERSAL_BAN = {
  regex: '^\\.\\./\\.\\.(?!.*/(worker|scripts)/)',
  message: 'No ../.. parent-traversal for src-internal imports — use @/ path aliases.',
};

const APP_LEAF_IMPORT_BAN = {
  group: ['@/app/*', '@/app/**'],
  message:
    'Route leaves (app/**) are terminal — non-route code must not import from app/. ' +
    'Move shared code into components/<domain> or lib/<domain>.',
};

// Invariant #1 (Vercel = UI only): the entry surface (app/**, components/**,
// instrumentation) must never RUNTIME-import worker-only modules. `import type`
// stays allowed (allowTypeImports) so shared DTOs are unaffected.
const invariantOne = (subject) =>
  `Invariant #1 (Vercel = UI only): ${subject} is worker-only — Next.js routes/` +
  'components must not runtime-import it. Move LLM/queue/DB work to a Railway ' +
  'worker; a type-only `import type` is allowed. See .claude/CLAUDE.md invariant #1.';

const VERCEL_FORBIDDEN_RUNTIME_IMPORTS = [
  { group: ['openai', 'openai/*'], allowTypeImports: true, message: invariantOne('the OpenAI SDK') },
  { group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'], allowTypeImports: true, message: invariantOne('the Anthropic SDK') },
  { group: ['bullmq', 'bullmq/*'], allowTypeImports: true, message: invariantOne('BullMQ') },
  { group: ['postgres', 'postgres/*'], allowTypeImports: true, message: invariantOne('the Postgres.js client') },
  {
    group: ['**/responses/generator', '**/responses/generator*', '@/lib/responses/generator', '@/lib/responses/generator*'],
    allowTypeImports: true,
    message: invariantOne('the LLM response generator'),
  },
  { group: ['**/worker/queues', '**/worker/queues*'], allowTypeImports: true, message: invariantOne('the worker queue registry') },
];
```

- [ ] **Step 4: Rewrite the `components/ui/**` zone to use `@typescript-eslint/no-restricted-imports` + SDK bans**

Replace the existing `components/ui/**` zone (currently lines ~95–125, the object with `files: ['src/components/ui/**/*.{ts,tsx}']`) with:
```js
  {
    // components/ui/** are domain-agnostic primitives: no lib/<domain>, no app/**,
    // no domain components — AND (invariant #1) no worker-only runtime imports.
    // Switched to @typescript-eslint/no-restricted-imports for allowTypeImports;
    // base rule turned off here so there is exactly one restricted-imports rule
    // for these files. Restates inherited bans (no-merge footgun).
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [
          PARENT_TRAVERSAL_BAN,
          {
            regex: '^@/lib/(?!ui/|shared/)',
            message:
              'components/ui must stay domain-agnostic — no imports from lib/<domain>. ' +
              '(lib/ui and lib/shared utilities like cn() are allowed.)',
          },
          { regex: '^@/app/', message: 'components/ui must not import from app/** (route leaves are terminal).' },
          {
            regex: '^@/components/(?!ui/)',
            message: 'components/ui must not import domain components — only other components/ui primitives.',
          },
          ...VERCEL_FORBIDDEN_RUNTIME_IMPORTS,
        ],
      }],
    },
  },
```

- [ ] **Step 5: Add the app-surface and components-surface zones (AFTER the ui zone)**

Append two new zones at the end of the `config` array (after the ui zone, before the closing `]`):
```js
  {
    // Invariant #1 entry surface — app routes + instrumentation (run on Vercel).
    // No @/app ban here: app/** siblings may import each other (preserved from
    // the non-route zone, which ignores app/**). Base rule off; restate the
    // parent-traversal ban (no-merge footgun) so it is not dropped.
    files: ['src/app/**/*.{ts,tsx}', 'src/instrumentation.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [PARENT_TRAVERSAL_BAN, ...VERCEL_FORBIDDEN_RUNTIME_IMPORTS],
      }],
    },
  },
  {
    // Invariant #1 entry surface — domain components (ui handled by its own zone
    // above, so excluded here). Restates parent-traversal + @/app bans (the
    // non-route zone is no longer the last matcher for these files) plus the
    // worker-only runtime bans. The dynamic-import @/app ban (no-restricted-syntax)
    // is a different rule and is NOT clobbered — it persists from the non-route zone.
    files: ['src/components/**/*.{ts,tsx}'],
    ignores: ['src/components/ui/**'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [PARENT_TRAVERSAL_BAN, APP_LEAF_IMPORT_BAN, ...VERCEL_FORBIDDEN_RUNTIME_IMPORTS],
      }],
    },
  },
```

- [ ] **Step 6: Run the guard test — expect GREEN**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && pnpm vitest run src/__tests__/eslint-boundaries.test.ts 2>&1 | tail -15
```
Expected: PASS (all assertions). If a forbidden-runtime case is still green-failing, check the glob in `VERCEL_FORBIDDEN_RUNTIME_IMPORTS` (the test is the arbiter — tune the `group` patterns, not the test). If `src/lib` or type-only assertions fail, a zone is over-matching `src/lib` or `allowTypeImports` was dropped.

### Task A3: Scope-disable the one genuine runtime case

- [ ] **Step 7: Add scoped disable + rationale on the admin/jobs bullmq import**

In `src/app/api/admin/jobs/route.ts`, the runtime `import { Queue } from 'bullmq';` (line 2) now errors. Add a scoped disable directly above it. Replace:
```ts
import { Queue } from 'bullmq';
```
with:
```ts
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- invariant #1 carve-out: admin-only queue-health READ. Instantiates a BullMQ Queue solely to call getJobCounts(), then closes it in a finally. Not a publish path. TODO(#<follow-up>): relocate queue-health to the Railway worker and drop this disable.
import { Queue } from 'bullmq';
```
(Replace `#<follow-up>` with the issue number from Step 8.)

- [ ] **Step 8: File the follow-up issue and back-reference it**

Run (during execution, not planning):
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
gh issue create --title "Relocate admin queue-health read off Vercel to the Railway worker" \
  --body "$(cat <<'EOF'
`src/app/api/admin/jobs/route.ts` instantiates a BullMQ `Queue` at runtime inside a Next.js route to read `getJobCounts()` for the admin jobs panel. This is the one invariant-#1 (Vercel = UI only) carve-out, currently held by a scoped `eslint-disable` (see #234 lint-boundary work). It is an admin READ (not a publish), but it likely also makes a Vercel→Railway-Redis call that may be broken on the private network. Move queue-health collection to the Railway worker and have the route read a persisted snapshot, then remove the eslint-disable.
EOF
)"
```
Capture the printed issue number and substitute it into the Step 7 disable comment.

- [ ] **Step 9: Verify lint is fully green with the new bans**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && pnpm lint 2>&1 | tail -3
```
Expected: 0 errors, 0 warnings. (admin/jobs is the only file the new bans would have flagged — Step 7 handles it; the two type-only `postgres` imports pass via `allowTypeImports`.)

### Task A4: Document the enforcement

- [ ] **Step 10: Add the one-line note to CLAUDE.md invariant #1**

In `.claude/CLAUDE.md`, find invariant #1 (begins "**Vercel = UI only.**"). Append at the end of that bullet (after "…stay on Railway."):
```
   ESLint-enforced: `src/app/**`, `src/components/**`, and `src/instrumentation.ts` may not runtime-import `openai`/`@anthropic-ai/sdk`/`bullmq`/`postgres`/the response generator/the worker queue registry (type-only `import type` allowed); guarded by `src/__tests__/eslint-boundaries.test.ts`.
```

- [ ] **Step 11: Run the full verification gate, then commit Phase A**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
  pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit
```
Expected: all green.
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
git add -A && git commit -m "feat(lint): enforce invariant #1 (Vercel UI-only) as ESLint boundary + guard test (#234)"
```

**Rollback/abort (A):** the boundary zones are additive — reverting the Phase-A commit restores prior lint behavior and removes the guard test; no other code depends on them. If A1 cannot go green due to an ESLint Node-API quirk, apply the Step-6/A1 hazard mitigations before reverting.

---

## Phase C — #374: Close the pre-push guard-test gap

**Goal:** Run the file-reading guard tests unconditionally on pre-push (they are invisible to `vitest --changed`), and encode why in a comment. No CI change.

**Files:**
- Modify: `lefthook.yml`

- [ ] **Step 1: Add the unconditional `guards` pre-push command**

In `lefthook.yml`, under `pre-push.commands`, add a `guards` command alongside `test-changed`:
```yaml
    # Import-graph blind spot: `vitest --changed` (test-changed below) only runs
    # tests reachable from changed files' MODULE graph. The src/__tests__/* guard
    # tests read files via readFileSync / the ESLint Node API instead of importing
    # the code they check, so they are in NO import graph and `--changed` silently
    # skips them — a config/source change can break a guard with a false-green
    # push. Run them unconditionally; they are fast file reads. CI's full
    # `pnpm test` still backstops everything else.
    guards:
      run: pnpm vitest run src/__tests__
```
(Place it before or after `test-changed`; `parallel: true` is already set, so ordering is cosmetic.)

- [ ] **Step 2: Verify the guard command runs and passes**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && pnpm vitest run src/__tests__ 2>&1 | tail -8
```
Expected: PASS — includes `eslint-boundaries.test.ts` plus the existing `src/__tests__/*` guards (`domain-canonical`, `tenant-isolation`, etc.). Confirms the new pre-push step is green.

- [ ] **Step 3: Optionally dry-run the hook**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && pnpm exec lefthook run pre-push 2>&1 | tail -20
```
Expected: all commands (lint, typecheck, audits, test-changed, guards) green.

- [ ] **Step 4: Commit Phase C**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
git add lefthook.yml && git commit -m "chore(hooks): run src/__tests__ guards unconditionally on pre-push (#374)"
```

**Rollback/abort (C):** `git checkout -- lefthook.yml` reverts; the hook change is isolated.

---

## Final verification + PR

- [ ] **Step 1: Full gate from the worktree root**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
  pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit && \
  pnpm ci:analytics-events && pnpm ci:static-policy
```
Expected: all green (the four lefthook audits + lint/typecheck/test).

- [ ] **Step 2: Push and open the combined PR**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && \
git push -u origin chore/lint-boundaries-234-269-374 && \
gh pr create --base main --title "chore(lint): enforce Vercel-UI-only boundary, lint all dirs, close pre-push guard gap (#234, #269, #374)" --body "<summary referencing #234, #269, #374, the follow-up issue, and the acceptance criteria>"
```

- [ ] **Step 3: Confirm the 4 CI checks green + React Doctor**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/chore-lint-boundaries-234-269-374 && gh pr checks --watch
```

---

## Acceptance criteria (from the spec)

- [ ] A `src/app`/`src/components` file importing any forbidden module fails `pnpm lint` with an invariant-#1 message; `import type` and `src/lib` imports unaffected.
- [ ] Guard test asserts the bans fire (and don't over-fire) via the ESLint Node API.
- [ ] `pnpm lint` covers `worker/`, `scripts/`, `e2e/` (via `eslint .`); `@typescript-eslint/no-unused-vars` is `error`; all ~126 violations resolved.
- [ ] Pre-push runs `src/__tests__` guards unconditionally; comment explains why.
- [ ] One-line note in CLAUDE.md that invariant #1 is ESLint-enforced.
- [ ] All 4 GitHub CI checks green; React Doctor 100/100.

## Self-review notes

- **Spec coverage:** Part A → Phase A (zones + guard test + scoped disable + CLAUDE.md note + follow-up issue). Part B → Phases B1 (widen + enable) and B2 (cleanup, incl. the 6 dead directives). Part C → Phase C (lefthook). Sequencing B→A→C matches the spec.
- **No-merge footgun:** handled by separate app/components zones (so `@/app` doesn't wrongly hit `src/app/**`), SDK bans never on the `src/lib`-matching zone 2, base rule turned off in `@typescript-eslint`-rule zones to avoid double-reporting, and the guard test as the arbiter.
- **Type consistency:** constant names used identically across zones — `PARENT_TRAVERSAL_BAN`, `APP_LEAF_IMPORT_BAN`, `VERCEL_FORBIDDEN_RUNTIME_IMPORTS`, `invariantOne`. Guard-test helper `restrictedMessages` / set `RESTRICTED_RULE_IDS` used consistently.
- **Verified, not assumed:** `@typescript-eslint/no-restricted-imports` + `allowTypeImports` confirmed working against the real config; 126 count + per-dir breakdown measured; admin/jobs confirmed as the sole runtime case; `src/instrumentation.ts` present and clean.
