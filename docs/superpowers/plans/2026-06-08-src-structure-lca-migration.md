# `src/` Structure — LCA Placement Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `components/<domain>` mean *shared* again — move single-route UI to its route's `_components/`, place every component at the lowest common ancestor (LCA) of its consumers, and enforce the boundaries with zero-dependency ESLint rules.

**Architecture:** Three layers, unchanged in shape: `app/<area>/_components` (page-only UI) · `components/<domain>` (cross-area shared UI) · `lib/<domain>` (logic, **frozen** — co-owned by the Railway worker at 141 import sites). A small Node tool computes each component's LCA from its importer graph and executes `git mv` + alias-string rewrites. Every change is **behavior-preserving** (moves + import-path strings only) and verified by a fixed gate. Work is sliced per-domain, `dashboard` as the pilot.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, ESLint flat config (`eslint src`), `vitest run`, ripgrep 14, Node `node:test` for the migration tool. No new runtime or dev dependencies.

**Source spec:** [`docs/superpowers/specs/2026-06-08-src-structure-lca-migration-design.md`](../specs/2026-06-08-src-structure-lca-migration-design.md)

**Out of scope (separate spec):** relocating `worker/jobs/publisher/orphan-markers` → `src/lib` (worker-touching, staging-first). This plan does **not** depend on it.

---

## The Verification Gate (referenced by every move task)

This is the behavior-preserving proof. Run **all** of it; every command must pass.

```bash
pnpm typecheck   # tsc --noEmit — proves every moved import still resolves
pnpm lint        # eslint src — boundary rules + ../../ ban green
pnpm test        # vitest run — no behavior change
pnpm build       # next build — Next.js route graph still valid
pnpm ci:static-policy   # path-sensitive client-access checks didn't trip
git diff -M --stat      # confirm RENAMES; content diffs limited to import lines
```

**Red flag:** if `git diff -M` shows any non-import line changed, a move altered behavior — stop and investigate.

---

## File Structure

**Created:**
- `scripts/component-placement/lca.mjs` — pure placement logic (alias↔path, LCA, destination). One responsibility: given importers, decide where a component lives.
- `scripts/component-placement/lca.test.mjs` — `node:test` unit tests for the pure logic.
- `scripts/component-placement/propose.mjs` — builds the importer graph (ripgrep) and emits a move-map JSON for one domain. Read-only.
- `scripts/component-placement/apply.mjs` — executes an approved move-map (`git mv` + alias rewrite). The only file that mutates the tree.

**Modified:**
- `eslint.config.mjs` — add the three boundary zones (commit the two already in the working tree + the new `../../` ban).
- `docs/src-structure-preferences.md` — reconcile stale sections to the LCA rule.
- Nine `app/api/**` route files — convert `../../_shared/*` to `@/` aliases (Phase 0).
- Per-domain `components/<domain>/**` + their consumers — moves (Phases 2–3).

---

## Phase 0 — Enforcement foundation + alias cleanup + doc (PR 0)

UI/server-config only; not worker/migration/billing → normal **PR-to-`main`**.

### Task 0.1: Convert the 9 aliasable `../../` imports to `@/` aliases

**Files (modify):** the 9 route files below. Each `../../_shared/X` resolves to an `app/api/.../_shared/X` path; replace with its `@/` alias.

| File | Old import | New import |
|---|---|---|
| `src/app/api/admin/channels/telegram/cancel/route.ts` | `'../../_shared/account'` | `'@/app/api/admin/channels/_shared/account'` |
| `src/app/api/admin/channels/telegram/disable/route.ts` | `'../../_shared/account'` | `'@/app/api/admin/channels/_shared/account'` |
| `src/app/api/admin/channels/telegram/start/route.ts` | `'../../_shared/start'` | `'@/app/api/admin/channels/_shared/start'` |
| `src/app/api/admin/channels/whatsapp/cancel/route.ts` | `'../../_shared/account'` | `'@/app/api/admin/channels/_shared/account'` |
| `src/app/api/admin/channels/whatsapp/disable/route.ts` | `'../../_shared/account'` | `'@/app/api/admin/channels/_shared/account'` |
| `src/app/api/admin/channels/whatsapp/start/route.ts` | `'../../_shared/start'` | `'@/app/api/admin/channels/_shared/start'` |
| `src/app/api/zernio/connect/cancel/route.ts` | `'../../_shared/error-response'` | `'@/app/api/zernio/_shared/error-response'` |
| `src/app/api/zernio/connect/select-location/route.ts` | `'../../_shared/error-response'` | `'@/app/api/zernio/_shared/error-response'` |
| `src/app/api/zernio/connect/start/route.ts` | `'../../_shared/error-response'` | `'@/app/api/zernio/_shared/error-response'` |

- [ ] **Step 1: Apply the 9 edits** — change only the import specifier string in each file above. No other changes.

- [ ] **Step 2: Confirm no aliasable `../../` remain** (the 10 cross-tree ones into `worker/`/`scripts/` are expected to stay)

Run:
```bash
rg -n "from ['\"]\.\./\.\.[^'\"]*_shared" src
```
Expected: **no output** (all `_shared` parent-traversal converted).

- [ ] **Step 3: Typecheck — proves the new aliases resolve**

Run: `pnpm typecheck`
Expected: PASS (exit 0).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/channels src/app/api/zernio
git commit -m "refactor(imports): alias src-internal _shared imports (drop ../..)"
```

### Task 0.2: Add the three boundary zones to ESLint

**Files (modify):** `eslint.config.mjs`. The working tree already contains the `@/app` zone + `components/ui` zone from prior work; this task replaces the boundary block with the final three-zone superset structure (adds the `../../` ban).

- [ ] **Step 1: Replace everything from the `react-hooks` settings object's closing to `export default config;` with this block**

```js
      'react-hooks/refs': 'off',
    },
  },
  // ---------------------------------------------------------------------------
  // Structural boundaries — enforce docs/src-structure-preferences.md.
  // `no-restricted-imports` does NOT merge across flat-config objects: for a
  // given file the LAST matching object wins, so each more-specific zone below
  // RESTATES the bans it inherits. Order: least- to most-specific.
  // ---------------------------------------------------------------------------
  {
    // Base — all src: ban src-internal ../.. parent traversal. Cross-tree
    // imports into worker//scripts/ are exempt (they have no @/ alias).
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^\\.\\./\\.\\.(?!.*/(worker|scripts)/)',
            message:
              'No ../.. parent-traversal for src-internal imports — use @/ path aliases.',
          },
        ],
      }],
    },
  },
  {
    // Non-route code may not import @/app/** (route leaves are terminal).
    // app/** is exempt so co-located siblings can import each other.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/app/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^\\.\\./\\.\\.(?!.*/(worker|scripts)/)',
            message:
              'No ../.. parent-traversal for src-internal imports — use @/ path aliases.',
          },
          {
            group: ['@/app/*', '@/app/**'],
            message:
              'Route leaves (app/**) are terminal — non-route code must not import from app/. ' +
              'Move shared code into components/<domain> or lib/<domain>.',
          },
        ],
      }],
    },
  },
  {
    // components/ui/** are domain-agnostic primitives: no lib/<domain> (lib/ui +
    // lib/shared allowed), no app/**, no domain components. Restates the above.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^\\.\\./\\.\\.(?!.*/(worker|scripts)/)',
            message:
              'No ../.. parent-traversal for src-internal imports — use @/ path aliases.',
          },
          {
            regex: '^@/lib/(?!ui/|shared/)',
            message:
              'components/ui must stay domain-agnostic — no imports from lib/<domain>. ' +
              '(lib/ui and lib/shared utilities like cn() are allowed.)',
          },
          {
            regex: '^@/app/',
            message: 'components/ui must not import from app/** (route leaves are terminal).',
          },
          {
            regex: '^@/components/(?!ui/)',
            message:
              'components/ui must not import domain components — only other components/ui primitives.',
          },
        ],
      }],
    },
  },
];

export default config;
```

- [ ] **Step 2: Baseline must stay green** (these rules must not flag existing code)

Run: `pnpm lint`
Expected: PASS (exit 0). If anything fails, the failure is a pre-existing violation — record it and stop; do not weaken the rule.

### Task 0.3: Prove the rules fire (probe test), then remove probes

- [ ] **Step 1: Write three probe files**

```bash
cat > src/hooks/__probe_app.ts <<'EOF'
import { x } from '@/app/(public)/login/page'; // must be FLAGGED (non-route → app)
export const a = x;
EOF
cat > src/lib/__probe_parent.ts <<'EOF'
import { y } from '../../scripts/ci/tenant-tables'; // cross-tree → must NOT be flagged
export const b = y;
EOF
cat > src/components/ui/__probe_ui.ts <<'EOF'
import { z } from '@/lib/reviews/sentiment';  // must be FLAGGED (ui → lib/<domain>)
import { cn } from '@/lib/ui/cn';             // must NOT be flagged (lib/ui allowed)
export const c = { z, cn };
EOF
```

- [ ] **Step 2: Lint the probes; confirm exactly the right ones fire**

Run:
```bash
npx eslint src/hooks/__probe_app.ts src/lib/__probe_parent.ts src/components/ui/__probe_ui.ts
```
Expected: **2 errors** — `@/app/(public)/login/page` in `__probe_app.ts`, and `@/lib/reviews/sentiment` in `__probe_ui.ts`. The `scripts/ci/tenant-tables` cross-tree import and `@/lib/ui/cn` must produce **no** error.

- [ ] **Step 3: Also confirm a *src-internal* `../../` is caught** (regression guard for the ban)

```bash
cat > src/lib/__probe_internal.ts <<'EOF'
import { w } from '../../components/ui/Button'; // src-internal ../.. → must be FLAGGED
export const d = w;
EOF
npx eslint src/lib/__probe_internal.ts
```
Expected: **1 error** on the `../../components/ui/Button` import.

- [ ] **Step 4: Remove all probes**

```bash
rm -f src/hooks/__probe_app.ts src/lib/__probe_parent.ts src/components/ui/__probe_ui.ts src/lib/__probe_internal.ts
```

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs
git commit -m "ci(lint): enforce structural import boundaries (app-terminal, ui-purity, src-internal ../..)"
```

### Task 0.4: Reconcile `docs/src-structure-preferences.md`

The doc currently contains a stale "What we'd actually do (the plan)" section (work already done in PR #219) and a "placement by shared-ness (≥2 routes)" rule that the LCA rule supersedes.

- [ ] **Step 1: Replace the stale "What we'd actually do (the plan)" section** with a short "Status: completed in PR #219" note, and **replace the placement wording** with the canonical LCA rule:

```markdown
## Component placement rule (LCA)

A component lives at the **lowest route folder that contains all of its
consumers**. Find every file that imports it; place it at their lowest common
ancestor in the route tree:

- One route leaf → `app/<area>/<leaf>/_components/`
- Several leaves under one area → `app/<area>/_components/`
- Consumers span 2+ top-level areas → `components/<domain>/` (mirrors `lib/<domain>`)
- Domain-agnostic primitive → `components/ui/`

`lib/<domain>` never moves (worker-owned). Enforced by `eslint.config.mjs`
(`no-restricted-imports` zones). See the migration spec:
`docs/superpowers/specs/2026-06-08-src-structure-lca-migration-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/src-structure-preferences.md
git commit -m "docs: reconcile src-structure preferences to the LCA rule"
```

### Task 0.5: Open PR 0

- [ ] **Step 1: Run the full Verification Gate** (above). All green.

- [ ] **Step 2: Push branch and open PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "structure: enforce import boundaries + alias cleanup (PR 0)" \
  --body "Phase 0 of the LCA migration: convert 9 src-internal ../.. to @/ aliases, add the three no-restricted-imports boundary zones (app-terminal, ui-purity, src-internal ../.. ban), reconcile the preferences doc to the LCA rule. Behavior-preserving. Spec: docs/superpowers/specs/2026-06-08-src-structure-lca-migration-design.md"
```
Expected: PR created, 4 CI checks (lint, typecheck, test, build) run.

---

## Phase 1 — Build the migration tool (same PR as the pilot, or its own)

### Task 1.1: Pure placement logic + unit tests (TDD)

**Files:**
- Create: `scripts/component-placement/lca.mjs`
- Test: `scripts/component-placement/lca.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/component-placement/lca.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasFromPath, routeLeafOf, computeDestination } from './lca.mjs';

test('aliasFromPath strips src/ and extension', () => {
  assert.equal(aliasFromPath('src/components/dashboard/kpi/Kpi.tsx'), '@/components/dashboard/kpi/Kpi');
  assert.equal(aliasFromPath('src/components/dashboard/kpi/index.tsx'), '@/components/dashboard/kpi');
});

const PAGES = new Set([
  'src/app/(authenticated)/dashboard',
  'src/app/(authenticated)/dashboard/settings',
  'src/app/(authenticated)/connect',
  'src/app/admin/overview',
]);

test('routeLeafOf finds nearest ancestor page dir', () => {
  assert.equal(
    routeLeafOf('src/app/(authenticated)/dashboard/settings/SettingsForm.tsx', PAGES),
    'src/app/(authenticated)/dashboard/settings',
  );
  assert.equal(routeLeafOf('src/components/dashboard/kpi/Kpi.tsx', PAGES), null);
});

test('computeDestination: single route leaf → that leaf _components', () => {
  const d = computeDestination(['src/app/(authenticated)/dashboard/settings/page.tsx'], PAGES);
  assert.deepEqual(d, { tier: 'co-locate', dir: 'src/app/(authenticated)/dashboard/settings/_components' });
});

test('computeDestination: two leaves sharing a subtree → that subtree LCA (not area root)', () => {
  const d = computeDestination(
    ['src/app/(authenticated)/dashboard/page.tsx', 'src/app/(authenticated)/dashboard/settings/page.tsx'],
    PAGES,
  );
  assert.deepEqual(d, { tier: 'co-locate', dir: 'src/app/(authenticated)/dashboard/_components' });
});

test('computeDestination: leaves in different subtrees of one area → area-level LCA', () => {
  const d = computeDestination(
    ['src/app/(authenticated)/dashboard/page.tsx', 'src/app/(authenticated)/connect/page.tsx'],
    PAGES,
  );
  assert.deepEqual(d, { tier: 'co-locate', dir: 'src/app/(authenticated)/_components' });
});

test('computeDestination: spans areas → shared', () => {
  const d = computeDestination(
    ['src/app/(authenticated)/dashboard/page.tsx', 'src/app/admin/overview/page.tsx'],
    PAGES,
  );
  assert.equal(d.tier, 'shared');
});

test('computeDestination: a non-route importer → shared', () => {
  const d = computeDestination(['src/components/dashboard/shell/Shell.tsx'], PAGES);
  assert.equal(d.tier, 'shared');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/component-placement/lca.test.mjs`
Expected: FAIL (`Cannot find module './lca.mjs'`).

- [ ] **Step 3: Implement `lca.mjs`**

```js
// scripts/component-placement/lca.mjs
import path from 'node:path';

const SRC = 'src/';

export function aliasFromPath(repoRelPath) {
  const noSrc = repoRelPath.startsWith(SRC) ? repoRelPath.slice(SRC.length) : repoRelPath;
  const noExt = noSrc.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
  return '@/' + noExt;
}

export function routeLeafOf(importerPath, pageDirs) {
  if (!importerPath.startsWith('src/app/')) return null;
  let dir = path.posix.dirname(importerPath);
  while (dir.startsWith('src/app')) {
    if (pageDirs.has(dir)) return dir;
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function commonDirPrefix(dirs) {
  const split = dirs.map((d) => d.split('/'));
  const first = split[0];
  let i = 0;
  for (; i < first.length; i++) {
    if (!split.every((s) => s[i] === first[i])) break;
  }
  return first.slice(0, i).join('/');
}

export function computeDestination(importers, pageDirs) {
  const nonApp = importers.filter((p) => !p.startsWith('src/app/'));
  if (nonApp.length > 0) return { tier: 'shared', reason: 'non-route importer(s)' };
  if (importers.length === 0) return { tier: 'shared', reason: 'no importers found' };
  const leaves = importers.map((p) => routeLeafOf(p, pageDirs));
  if (leaves.some((l) => l === null)) return { tier: 'shared', reason: 'importer not under a route leaf' };
  // True LCA of the consuming route leaves.
  const lca = commonDirPrefix([...new Set(leaves)]);
  // The LCA must keep at least an <area> segment under src/app/ to co-locate;
  // otherwise consumers span areas → genuinely shared.
  if (!/^src\/app\/[^/]+/.test(lca)) return { tier: 'shared', reason: 'consumers span multiple areas' };
  return { tier: 'co-locate', dir: lca + '/_components' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/component-placement/lca.test.mjs`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/component-placement/lca.mjs scripts/component-placement/lca.test.mjs
git commit -m "tool(placement): pure LCA placement logic + unit tests"
```

### Task 1.2: Propose-mode (read-only move-map generator)

**Files:** Create `scripts/component-placement/propose.mjs`

- [ ] **Step 1: Implement**

```js
// scripts/component-placement/propose.mjs
// Usage: node scripts/component-placement/propose.mjs <domain>  > map.<domain>.json
import { execFileSync } from 'node:child_process';
import { aliasFromPath, computeDestination } from './lca.mjs';

function rg(args) {
  try {
    return execFileSync('rg', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // ripgrep: no matches
    throw e;
  }
}

function pageDirs() {
  const pages = rg(['--files', '-g', 'page.tsx', 'src/app']);
  return new Set(pages.map((p) => p.replace(/\/page\.tsx$/, '')));
}

function componentFiles(domain) {
  return rg(['--files', '-g', '*.tsx', '-g', '!**/__tests__/**', `src/components/${domain}`]);
}

function importersOf(alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `(from|import)\\s*\\(?['"]${escaped}['"]`;
  return rg(['-l', '-e', pattern, 'src', 'worker']);
}

const domain = process.argv[2];
if (!domain) {
  console.error('usage: node propose.mjs <domain>');
  process.exit(2);
}

const pd = pageDirs();
const map = [];
for (const file of componentFiles(domain)) {
  const alias = aliasFromPath(file);
  const importers = importersOf(alias).filter((p) => p !== file);
  const dest = computeDestination(importers, pd);
  map.push({ file, alias, importers, dest });
}
process.stdout.write(JSON.stringify(map, null, 2) + '\n');
```

- [ ] **Step 2: Smoke-test on a small domain (read-only — changes nothing)**

Run: `node scripts/component-placement/propose.mjs places`
Expected: JSON array printed; each entry has `file`, `alias`, `importers`, `dest`. No files modified (`git status` clean).

- [ ] **Step 3: Commit**

```bash
git add scripts/component-placement/propose.mjs
git commit -m "tool(placement): read-only move-map proposer (ripgrep importer graph)"
```

### Task 1.3: Apply-mode (executes an approved move-map)

**Files:** Create `scripts/component-placement/apply.mjs`

- [ ] **Step 1: Implement**

```js
// scripts/component-placement/apply.mjs
// Usage: node scripts/component-placement/apply.mjs <approved-map.json>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { aliasFromPath } from './lca.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}
function rg(args) {
  try {
    return execFileSync('rg', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}
function replaceInFile(file, from, to) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes(from)) return;
  writeFileSync(file, src.split(from).join(to));
}

const mapPath = process.argv[2];
if (!mapPath) {
  console.error('usage: node apply.mjs <approved-map.json>');
  process.exit(2);
}
const map = JSON.parse(readFileSync(mapPath, 'utf8'));

for (const entry of map) {
  if (entry.dest.tier === 'shared') continue; // stays in components/<domain>
  const oldPath = entry.file;
  const base = path.posix.basename(oldPath);
  const newPath = path.posix.join(entry.dest.dir, base);
  const oldAlias = aliasFromPath(oldPath);
  const newAlias = aliasFromPath(newPath);

  mkdirSync(entry.dest.dir, { recursive: true });
  git(['mv', oldPath, newPath]);

  // Rewrite the alias everywhere it appears (quoted = exact, prefix-safe).
  for (const f of rg(['-l', '-F', oldAlias, 'src', 'worker'])) {
    replaceInFile(f, `'${oldAlias}'`, `'${newAlias}'`);
    replaceInFile(f, `"${oldAlias}"`, `"${newAlias}"`);
  }

  // Move a co-located test if present (.test.tsx or .test.ts).
  const stem = base.replace(/\.tsx?$/, '');
  for (const ext of ['.test.tsx', '.test.ts']) {
    const testOld = path.posix.join(path.posix.dirname(oldPath), '__tests__', stem + ext);
    if (existsSync(testOld)) {
      const testDir = path.posix.join(entry.dest.dir, '__tests__');
      mkdirSync(testDir, { recursive: true });
      git(['mv', testOld, path.posix.join(testDir, stem + ext)]);
    }
  }
}
process.stdout.write('apply: done\n');
```

- [ ] **Step 2: Dry sanity check** — run against an empty map (no-op)

```bash
echo '[]' > /tmp/empty-map.json
node scripts/component-placement/apply.mjs /tmp/empty-map.json
```
Expected: prints `apply: done`; `git status` clean.

- [ ] **Step 3: Commit**

```bash
git add scripts/component-placement/apply.mjs
git commit -m "tool(placement): apply-mode (git mv + alias rewrite + test move)"
```

---

## Phase 2 — Dashboard pilot (PR 1)

This proves the tool + gate end-to-end. `components/dashboard` is ~79 `.tsx`.

### Task 2.1: Generate and human-review the move-map

- [ ] **Step 1: Generate**

```bash
node scripts/component-placement/propose.mjs dashboard > /tmp/map.dashboard.json
```

- [ ] **Step 2: Review every entry by hand.** For each, confirm `dest` is sane:
  - `tier: route-leaf`/`area` with a real `_components` dir → will move.
  - `tier: shared` → stays (genuinely cross-area, e.g. `shell/`).
  - **Watch for false "shared":** an entry showing `reason: "importer not under a route leaf"` means a consumer is itself a component (legit shared) OR the component is wired via a dynamic/string import ripgrep matched loosely — open the importer and confirm.
  - **Watch for surprises:** any `worker/...` path in `importers` is a finding (UI used by the worker) — stop and report; do not move.

- [ ] **Step 3: Edit `/tmp/map.dashboard.json` to reflect review decisions** (flip a wrong `route-leaf` to `shared`, etc.). This edited file is the approved map.

### Task 2.2: Execute the moves

- [ ] **Step 1: Apply**

```bash
node scripts/component-placement/apply.mjs /tmp/map.dashboard.json
```

- [ ] **Step 2: Confirm the diff is renames + import lines only**

Run: `git diff -M --stat` then spot-check `git diff -M` on 3 moved files.
Expected: `R` (rename) entries; content hunks touch only `import`/`from` lines.

### Task 2.3: Run the full Verification Gate

- [ ] **Step 1:** Run every command in **The Verification Gate** (top of this doc).
Expected: all green. If `pnpm typecheck` fails, an import wasn't rewritten — find the stale `@/components/dashboard/...` specifier and fix, or `git restore` and re-run with a corrected map.

- [ ] **Step 2: Confirm `components/dashboard` shrank**

```bash
find src/components/dashboard -name '*.tsx' | wc -l
```
Expected: well below 79 (only the genuinely-shared remainder, e.g. `shell/`).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "structure(dashboard): place components at consumer LCA (pilot)"
```

### Task 2.4: Open PR 1 (sub-slice if the diff is large)

- [ ] **Step 1:** If `git diff -M --stat` against `main` exceeds ~40 files, split: revert and re-run the map filtered to one sub-tree at a time (`settings`, then `kpi`, then `reviews`, …), one commit/PR each. Otherwise continue.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "structure(dashboard): LCA component placement (pilot)" \
  --body "Pilot of the LCA migration. components/dashboard single-route UI moved to route _components/. Behavior-preserving (renames + import-path rewrites only; verified by typecheck/lint/test/build + git diff -M). Spec: docs/superpowers/specs/2026-06-08-src-structure-lca-migration-design.md"
```

---

## Phase 3 — Remaining domains (PR 2…n)

Repeat the Phase 2 loop, **one PR per domain**, for each of: `admin`, `approval`, `auth`, `legal`, `places`, `sections`. (`ui` is primitives — never migrated. `__tests__` at the components root is handled as files move.)

For **each** domain `<D>`:

- [ ] **Step 1: Propose** — `node scripts/component-placement/propose.mjs <D> > /tmp/map.<D>.json`
- [ ] **Step 2: Human-review** the map (same checks as Task 2.1 Step 2).
- [ ] **Step 3: Apply** — `node scripts/component-placement/apply.mjs /tmp/map.<D>.json`
- [ ] **Step 4: Gate** — run **The Verification Gate**; confirm `git diff -M` is renames + import lines only.
- [ ] **Step 5: Commit + PR**

```bash
git add -A
git commit -m "structure(<D>): place components at consumer LCA"
git push -u origin HEAD
gh pr create --base main --title "structure(<D>): LCA component placement" \
  --body "LCA migration for components/<D>. Behavior-preserving. Spec: docs/superpowers/specs/2026-06-08-src-structure-lca-migration-design.md"
```

> Note on `sections`: these are marketing/landing sections under `(public)`. Most are single-route → they co-locate under their `(public)/<page>/_components`. Anything used by 2+ marketing pages stays in `components/sections/`. Same LCA rule, no special-casing.

---

## Phase 4 — Close-out

### Task 4.1: Resolve the `lib/kpi` naming exception

- [ ] **Step 1:** Decide per the spec §8: either `git mv src/lib/kpi src/lib/dashboard/kpi` (+ rewrite `@/lib/kpi/*` → `@/lib/dashboard/kpi/*` via the same alias-replace approach, **including worker importers**), **or** document `lib/kpi` as an explicit 1→n exception in `docs/src-structure-preferences.md`. If moving, run the full gate (it touches `lib/`, which the worker imports — treat as **staging-first**).

### Task 4.2: Final state confirmation + doc

- [ ] **Step 1: Confirm each `components/<domain>` now holds only shared UI**

```bash
for d in src/components/*/; do echo "$(find "$d" -name '*.tsx' | wc -l) $d"; done
```
Expected: each domain folder small (cross-area shared only); `ui/` unchanged.

- [ ] **Step 2: Update `docs/src-structure-preferences.md`** with a short "Migration complete" note and a pointer to the spec. Commit.

- [ ] **Step 3 (optional follow-up, do NOT do here):** open a tracking issue for (a) the `orphan-markers` → `src/lib` relocation spec (staging-first), and (b) the `eslint-plugin-import` `no-restricted-paths` rule for cross-area `_components` privacy (needs a dev dependency).

---

## Self-Review notes (for the executor)

- **Behavior-preserving is the contract.** Any task whose `git diff -M` shows non-import content changes has a bug — stop.
- **The gate is non-negotiable per slice.** `pnpm typecheck` is the strongest net; never skip it after a move.
- **`lib/<domain>` is frozen** except the optional Task 4.1 `lib/kpi` fold (which is staging-first if chosen).
- **Human review of every move-map is mandatory** — the tool proposes, it does not decide.
