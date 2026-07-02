# Modularity A+ Campaign — Stage 0 + Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the campaign's quick wins (Stage 0) and foundations (Stage 1) — 5 behavior-preserving PRs that single-source the new-regression facts, harden the local gate, and create the three conventions (db-imports ratchet, reviews-status/topic constants+guards, LLM task seam) every Stage-2 sweep builds on.

**Architecture:** Per spec `docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md`. Each PR gets its own **sibling worktree** (`pnpm worktree:new <branch> main`) and rides the full June pipeline. Stage 2–4 get their own per-batch plan docs when they start (their content depends on the ratchet baselines this stage creates).

**Tech stack:** Next.js 16 / Fastify worker / Vitest / tsx CI audit scripts (TypeScript AST via `typescript` package) / Postgres.js.

**Design refinements vs spec (surface these; do not silently deviate further):**
1. **Nav links:** the footer's Product column orders links differently from the header nav (Features/Pricing/How-it-works vs Features/How-it-works/Pricing). The single owner therefore owns the *link facts* (label+href) as a keyed record; each surface composes its own order. Zero visual change.
2. **`runLlmTask` and the cost guard:** the spec sketches reserve→finalize inside `runLlmTask`. The M3 race documented at `generator.ts:163-170` requires the idempotent-cache write to happen INSIDE the cost-guard closure (before slot release) — a generation-specific concern. To keep this PR byte-identical in behavior, `withCostGuard` **stays at the tenant** (generator) and `runLlmTask` owns provider selection + fallback + transient classification. The seam module's docstring makes the cost-guard wrap a mandatory documented contract for every future task (triage/judge/insights), per the cost-guard skill. If the owner prefers guard-inside-seam, that is a follow-up refactor with its own review — not this PR.
3. **Topic literals in `ON CONFLICT … WHERE` clauses stay literals** — a bind parameter breaks partial-unique-index inference (the predicate must match the index definition). The guard ships a pragma for exactly these.

**Pipeline (identical for every PR below — referenced as "RUN PIPELINE"):**

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] `pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy && pnpm ci:response-status && pnpm ci:admin-aal2 && pnpm ci:config-coverage && pnpm ci:process-env` (plus any guard added by an earlier merged PR of this campaign)
- [ ] Codex adversarial review: dispatch the `codex:codex-rescue` agent read-only on the branch diff; iterate until VERDICT: APPROVED (Claude is final arbiter)
- [ ] Thermo-nuclear maintainability self-review: every touched file must be net-simpler or explicitly justified
- [ ] `gh pr create` → CI green incl. React Doctor 100/100 → **worker-touching PRs only:** push branch to `staging`, verify Railway worker boots clean (`railway` logs) before merge
- [ ] Merge via PR → `git checkout staging && git merge --ff-only main && git push`
- [ ] Remove the PR's worktree

---

## PR 0a — Quick wins: single-source client facts + dead-code deletion

**Branch/worktree:** `pnpm worktree:new aplus/0a-quick-wins main`
**All paths below relative to that worktree root.**

### Task 1: Marketing link facts — one owner

**Files:**
- Create: `src/components/ui/marketing-links.ts`
- Create: `src/components/ui/__tests__/marketing-links.test.ts`
- Modify: `src/components/ui/SiteNav.tsx:16-20`
- Modify: `src/components/ui/SiteFooter.tsx:21-27` (Product column)
- Modify: `src/components/sections/landing/LandingExperience.tsx:160-164`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/ui/__tests__/marketing-links.test.ts
import { describe, it, expect } from 'vitest';
import { MARKETING_LINKS, NAV_LINKS } from '../marketing-links';

describe('marketing links single source', () => {
  it('declares each public marketing page exactly once', () => {
    expect(MARKETING_LINKS.features).toEqual({ label: 'Features', href: '/features' });
    expect(MARKETING_LINKS.howItWorks).toEqual({ label: 'How it works', href: '/how-it-works' });
    expect(MARKETING_LINKS.pricing).toEqual({ label: 'Pricing', href: '/pricing' });
  });

  it('header-nav order covers every link exactly once', () => {
    expect(NAV_LINKS).toEqual([
      MARKETING_LINKS.features,
      MARKETING_LINKS.howItWorks,
      MARKETING_LINKS.pricing,
    ]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`pnpm vitest run src/components/ui/__tests__/marketing-links.test.ts` → "Cannot find module '../marketing-links'")

- [ ] **Step 3: Create the owner module**

```ts
// src/components/ui/marketing-links.ts
//
// Single owner of the public marketing pages' link facts (label + href).
// Surfaces (SiteNav, SiteFooter's Product column, the landing nav) compose
// their OWN ordering from these entries; the label/href pair is declared once.

export const MARKETING_LINKS = {
  features: { label: 'Features', href: '/features' },
  howItWorks: { label: 'How it works', href: '/how-it-works' },
  pricing: { label: 'Pricing', href: '/pricing' },
} as const;

export type MarketingLink = (typeof MARKETING_LINKS)[keyof typeof MARKETING_LINKS];

/** Header-nav order (SiteNav + landing nav). The footer's Product column uses
 *  its own historical order — compose there, don't reorder here. */
export const NAV_LINKS: readonly MarketingLink[] = [
  MARKETING_LINKS.features,
  MARKETING_LINKS.howItWorks,
  MARKETING_LINKS.pricing,
];
```

- [ ] **Step 4: Test passes** (`pnpm vitest run src/components/ui/__tests__/marketing-links.test.ts` → PASS)

- [ ] **Step 5: Consume in SiteNav** — delete the local `NAV_LINKS` const (lines 16–20) and add `import { NAV_LINKS } from './marketing-links';`. No other change — the render code already maps `NAV_LINKS`.

- [ ] **Step 6: Consume in SiteFooter** — replace the Product column's three inline objects with (order preserved — Features, Pricing, How it works):

```ts
import { MARKETING_LINKS } from './marketing-links';
// … in FOOTER_COLUMNS:
  {
    heading: 'Product',
    links: [MARKETING_LINKS.features, MARKETING_LINKS.pricing, MARKETING_LINKS.howItWorks],
  },
```

- [ ] **Step 7: Consume in LandingExperience** — replace lines 161–163 with:

```tsx
import { NAV_LINKS } from '@/components/ui/marketing-links';
// … inside <div className="rw-le-nav-links">:
  {NAV_LINKS.map((link) => (
    <Link key={link.href} href={link.href}>{link.label}</Link>
  ))}
```

- [ ] **Step 8: Verify + commit** — `pnpm vitest run src/components && pnpm typecheck`; then `git add -A && git commit -m "refactor(marketing): single-source nav link facts (audit Q1 regression)"`

### Task 2: Star→sentiment thresholds — one owner

**Files:**
- Create: `src/components/dashboard/kpi/sentiment-tier.ts`
- Create: `src/components/dashboard/kpi/__tests__/sentiment-tier.test.ts`
- Modify: `src/components/dashboard/kpi/RecentSentimentMix.tsx:16-24` (BUCKETS)
- Modify: `src/components/dashboard/kpi/RecentRatingBreakdown.tsx:13-18` (tierClass)

- [ ] **Step 1: Failing test locking today's behavior**

```ts
// src/components/dashboard/kpi/__tests__/sentiment-tier.test.ts
import { describe, it, expect } from 'vitest';
import { tierForStars, TIER_BY_SENTIMENT } from '../sentiment-tier';

describe('sentiment tier derives from the ONE domain rule', () => {
  it('matches the previous inline thresholds exactly', () => {
    expect(tierForStars(5)).toBe('good');
    expect(tierForStars(4)).toBe('good');
    expect(tierForStars(3)).toBe('mid');
    expect(tierForStars(2)).toBe('low');
    expect(tierForStars(1)).toBe('low');
  });
  it('covers every sentiment label', () => {
    expect(Object.keys(TIER_BY_SENTIMENT).sort()).toEqual(['negative', 'neutral', 'positive']);
  });
});
```

- [ ] **Step 2: Run — FAIL** (module not found)

- [ ] **Step 3: Create the mapping module**

```ts
// src/components/dashboard/kpi/sentiment-tier.ts
//
// UI mapping from the domain sentiment rule to the dashboard's visual tier.
// The star thresholds live in EXACTLY ONE place — classifySentiment
// (src/lib/reviews/sentiment.ts). This module only names the visual tiers.
import { classifySentiment, type SentimentLabel } from '@/lib/reviews/sentiment';

export type SentimentTier = 'good' | 'mid' | 'low';

export const TIER_BY_SENTIMENT: Record<SentimentLabel, SentimentTier> = {
  positive: 'good',
  neutral: 'mid',
  negative: 'low',
};

export function tierForStars(stars: number): SentimentTier {
  return TIER_BY_SENTIMENT[classifySentiment(stars).label];
}
```

- [ ] **Step 4: Test passes.**

- [ ] **Step 5: Rewire RecentSentimentMix** — replace the `BUCKETS` block (with its `holds` closures) by:

```tsx
import { classifySentiment, type SentimentLabel } from '@/lib/reviews/sentiment';
import { TIER_BY_SENTIMENT, type SentimentTier } from './sentiment-tier';

const BUCKETS: ReadonlyArray<{ label: string; sentiment: SentimentLabel }> = [
  { label: 'Positive', sentiment: 'positive' },
  { label: 'Neutral', sentiment: 'neutral' },
  { label: 'Negative', sentiment: 'negative' },
];
```

and where the component previously called `bucket.holds(stars)`, count via
`classifySentiment(stars).label === bucket.sentiment`, rendering tier class from
`TIER_BY_SENTIMENT[bucket.sentiment]`. Keep the doc comment but replace its
threshold text with: `// Buckets derive from classifySentiment — the single owner of the star→sentiment rule.`

- [ ] **Step 6: Rewire RecentRatingBreakdown** — delete the local `tierClass` function; `import { tierForStars } from './sentiment-tier';` and replace call sites `tierClass(stars)` → `tierForStars(stars)`.

- [ ] **Step 7: Verify + commit** — existing KPI component tests must pass unchanged: `pnpm vitest run src/components/dashboard/kpi && pnpm typecheck`; commit `"refactor(kpi): derive sentiment tiers from classifySentiment (audit Q1 regression)"`

### Task 3: Queue-health job states — importable by the UI

**Files:**
- Create: `src/lib/shared/queue-health-states.ts`
- Modify: `worker/internal/queue-health.ts:26-33`
- Modify: `src/app/admin/jobs/page.tsx:157-186` (the six hardcoded state blocks)

- [ ] **Step 1: Move the constant** (verbatim, next to `queue-names.ts` — same "shared by worker + Vercel route, no side effects" contract):

```ts
// src/lib/shared/queue-health-states.ts
//
// The BullMQ job-count states surfaced to the admin panel. Single owner shared
// by the worker endpoint (worker/internal/queue-health.ts getJobCounts call)
// and the admin UI (src/app/admin/jobs). Same no-side-effect contract as
// queue-names.ts: this module must never import bullmq/ioredis.
export const QUEUE_HEALTH_JOB_STATES = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'paused',
] as const;

export type QueueHealthJobState = (typeof QUEUE_HEALTH_JOB_STATES)[number];
```

- [ ] **Step 2:** In `worker/internal/queue-health.ts` delete the local declaration and add `export { QUEUE_HEALTH_JOB_STATES } from '../../src/lib/shared/queue-health-states';` (match the file's existing relative-import style for `src/lib` — check its current imports and mirror). Existing worker imports/tests keep working via the re-export.

- [ ] **Step 3:** In `src/app/admin/jobs/page.tsx` replace the six copy-pasted state `<div>`s with a map over the shared list plus a local style map (styles are presentation, they stay here):

```tsx
import { QUEUE_HEALTH_JOB_STATES, type QueueHealthJobState } from '@/lib/shared/queue-health-states';

const STATE_STYLES: Record<QueueHealthJobState, { label: string; value: string }> = {
  waiting:   { label: 'font-medium text-gray-500',   value: 'text-gray-800' },
  active:    { label: 'font-medium text-blue-500',   value: 'text-blue-700' },
  delayed:   { label: 'font-medium text-yellow-500', value: 'text-yellow-700' },
  failed:    { label: 'font-medium text-red-500',    value: 'text-red-700' },
  completed: { label: 'font-medium text-green-500',  value: 'text-green-700' },
  paused:    { label: 'font-medium text-gray-400',   value: 'text-gray-600' },
};
// …inside the queue card:
  <div className="grid grid-cols-6 gap-2 text-center text-xs">
    {QUEUE_HEALTH_JOB_STATES.map((state) => (
      <div key={state}>
        <p className={STATE_STYLES[state].label}>{state}</p>
        <p className={`mt-0.5 text-base font-bold ${STATE_STYLES[state].value}`}>
          {counts[state] ?? 0}
        </p>
      </div>
    ))}
  </div>
```

**Before replacing, read the current six blocks and copy their exact class strings into `STATE_STYLES`** (the two shown above for `paused` must be taken from the file, not this plan — verify all six against the existing JSX so the rendered classes are byte-identical).

- [ ] **Step 4: Verify + commit** — `pnpm vitest run worker/internal src/app/admin && pnpm typecheck && pnpm build`; commit `"refactor(admin): single-source queue-health job states (audit Q1)"`

### Task 4: Dead code deletion

**Files:** Delete `src/components/sections/landing-legacy/` (7 components + `__tests__/`), delete `worker/jobs/publisher/types.ts`, edit `src/components/ui/be-ui-tilt-card.tsx:23,29`.

- [ ] **Step 1: Prove zero importers** (each must print nothing):

```bash
rg -l "landing-legacy" src --glob '!src/components/sections/landing-legacy/**'
rg -l "jobs/publisher/types|ZernioConnectionRow" worker src --glob '!worker/jobs/publisher/types.ts'
rg -l "SPRING_MOUSE|useHoverCapable" src --glob '!src/components/ui/be-ui-tilt-card.tsx'
```

If any command prints a file, STOP — investigate before deleting.

- [ ] **Step 2:** `git rm -r src/components/sections/landing-legacy && git rm worker/jobs/publisher/types.ts`
  *Sanctioned deviation from the "test count may not drop" rule: deleting dead components deletes their own tests — record the removed-test count in the PR body.*
- [ ] **Step 3:** In `be-ui-tilt-card.tsx`: if `SPRING_MOUSE` / `useHoverCapable` are referenced later in the same file, remove only the `export` keyword; if unreferenced in-file, delete the declarations.
- [ ] **Step 4: Verify + commit** — `pnpm typecheck && pnpm build && pnpm vitest run src/components`; commit `"chore: delete dormant landing-legacy + stranded publisher types (audit hygiene)"`

### Task 5: Doc-ref + pragma hygiene

- [ ] **Step 1:** `src/lib/notifications/channels/types.ts:8` — replace `See docs/adding-communication-channels.md §1 for rationale.` with `See docs/adr/0003-conversational-channel-seams.md for rationale.` (verify the ADR file exists: `ls docs/adr/`).
- [ ] **Step 2:** In each of the 3 pragma files, split the prose off the pragma line so fallow's parser sees a bare directive. Pattern (apply to all three — `worker/jobs/auto-post-notice/{dispatch.ts:42,context.ts:63,AutoPostNoticeWorker.ts:29}`), e.g. for `AutoPostNoticeWorker.ts`:

```ts
// Entry-point orchestration (invariant #12): a flat guard-and-return sequence
// (context fail/skip, eligibility ok/empty, missing app-url, null google-url,
// systemic-failure, retryable-throw); cyclomatic count is the distinct-outcome
// vocabulary, not tangled logic.
// fallow-ignore-next-line complexity
```

(Keep each file's own prose verbatim — only move it above the directive line.)
- [ ] **Step 3:** Confirm the artifact is gone: `fallow dead-code --format json --quiet --stale-suppressions 2>/dev/null | jq '.stale_suppressions | length'` → expected `0` — and that health still suppresses: `fallow health --format json --quiet 2>/dev/null | jq '[.findings[] | select(.path | contains("auto-post-notice"))] | length'` → expected `0`.
- [ ] **Step 4: Commit** `"chore: fix dangling channel doc ref + fallow pragma format"`

### Task 6: RUN PIPELINE for PR 0a
- [ ] Title: `refactor(q1): single-source client facts + dead-code deletion (A+ campaign 0a)`. Not worker-behavior-touching (the queue-health move is a re-export) → no staging ride required.

---

## PR 0b — Local gate hardening

**Branch/worktree:** `pnpm worktree:new aplus/0b-local-gate main`

### Task 1: Pre-push hook mirrors all 8 audits

**Files:** Modify `lefthook.yml` (after the `static-policy` entry).

- [ ] **Step 1:** Add four commands, mirroring the existing entries' style:

```yaml
    response-status:
      run: pnpm ci:response-status
    admin-aal2:
      run: pnpm ci:admin-aal2
    config-coverage:
      run: pnpm ci:config-coverage
    process-env:
      run: pnpm ci:process-env
```

- [ ] **Step 2:** Verify locally: `pnpm lefthook run pre-push` → all commands listed and green.
- [ ] **Step 3: Commit** `"chore(hooks): mirror all 8 CI audits in the pre-push gate (audit Q4)"`

### Task 2: Kill the silent integration skip

**Files:**
- Create: `src/__tests__/helpers/describe-with-db.ts`
- Modify: every gate site (enumerate: `rg -ln "TEST_DATABASE_POOL_URL" src tests e2e --glob '*.test.ts'` — 24 files at audit time; `e2e/` files that read it for Playwright config are NOT gate sites, skip those)

- [ ] **Step 1: Create the helper**

```ts
// src/__tests__/helpers/describe-with-db.ts
//
// DB-gated describe. Runs the suite when TEST_DATABASE_POOL_URL is set;
// otherwise registers it as skipped AND warns once on stderr, so a keyless
// run can never silently pass as green integration coverage (audit Q2).
import { describe } from 'vitest';

const HAS_DB = Boolean(process.env.TEST_DATABASE_POOL_URL);
let warned = false;

export function describeWithDb(name: string, factory: () => void): void {
  if (HAS_DB) {
    describe(name, factory);
    return;
  }
  if (!warned) {
    warned = true;
    process.stderr.write(
      '[tests] TEST_DATABASE_POOL_URL unset — DB-gated integration suites SKIPPED\n',
    );
  }
  describe.skip(name, factory);
}
```

- [ ] **Step 2: Convert one exemplar** — `src/__tests__/tenant-isolation.test.ts:7-9`:

Before:
```ts
const RUN = Boolean(process.env.TEST_DATABASE_POOL_URL);
const d = RUN ? describe : describe.skip;
```
After (and replace `d(` with `describeWithDb(` at the suite root):
```ts
import { describeWithDb } from './helpers/describe-with-db';
```

- [ ] **Step 3:** Apply the identical two-line mechanical conversion to every remaining gate file from the Step-0 enumeration (adjust the relative import depth per file). Any file whose gate ALSO keeps an always-runnable assertion (e.g. `tests/__tests__/seed-multi-location.integration.test.ts`) keeps that assertion outside the gated block unchanged.
- [ ] **Step 4: Verify** — `pnpm vitest run src/__tests__/tenant-isolation.test.ts` without the env var: suite reports *skipped* and stderr shows the warn line exactly once per run. With `TEST_DATABASE_POOL_URL` set (if available locally): runs as before.
- [ ] **Step 5: Commit** `"test: describeWithDb helper — warn instead of silent skip (audit Q2)"`

### Task 3: RUN PIPELINE for PR 0b
- [ ] Title: `chore(gate): pre-push audit mirror + loud integration skip (A+ campaign 0b)`. Not worker-touching.

---

## PR 1a — `ci:db-imports` ratchet guard

**Branch/worktree:** `pnpm worktree:new aplus/1a-db-imports-guard main`
No runtime change — this PR only makes the ambient-singleton dependency **visible and monotonically shrinking**.

### Task 1: The audit script (modeled byte-for-byte on `process-env-audit.ts`'s structure)

**Files:**
- Create: `scripts/ci/db-imports-audit.ts`
- Create: `scripts/ci/db-imports-baseline.ts` (generated in Task 2)
- Create: `scripts/ci/__tests__/db-imports-audit.test.ts` (mirror the test location used by the existing audits — check with `ls scripts/ci/__tests__/ 2>/dev/null || rg -l "process-env-audit" src scripts --glob '*.test.ts'` and put the new test beside the existing audits' tests)
- Modify: `package.json` (scripts), `.github/workflows/ci.yml:64` (after process-env), `lefthook.yml`

- [ ] **Step 1: Failing unit test for the pure detector**

```ts
import { describe, it, expect } from 'vitest';
import { fileImportsDbServer, evaluateFindings, isCompositionRoot } from '../db-imports-audit';

describe('db-imports-audit', () => {
  it('detects alias and relative imports of db/server', () => {
    expect(fileImportsDbServer(`import { sql } from '@/lib/db/server';`)).toBe(true);
    expect(fileImportsDbServer(`import { supabaseServer } from '../../db/server';`)).toBe(true);
    expect(fileImportsDbServer(`import type { Sql } from '@/lib/db/server';`)).toBe(false); // type-only OK
    expect(fileImportsDbServer(`const x = "@/lib/db/server";`)).toBe(false); // string, not import
  });
  it('exempts composition roots', () => {
    expect(isCompositionRoot('src/app/api/dashboard/kpis/route.ts')).toBe(true);
    expect(isCompositionRoot('worker/index.ts')).toBe(true);
    expect(isCompositionRoot('src/lib/kpi/service.ts')).toBe(false);
  });
  it('flags new importers and stale baseline entries', () => {
    const findings = evaluateFindings({
      importingFiles: new Set(['src/lib/new-module.ts']),
      baseline: new Set(['src/lib/gone.ts']),
    });
    expect(findings).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run — FAIL** (module not found).

- [ ] **Step 3: Write the script.** Copy `scripts/ci/process-env-audit.ts` as the skeleton and change exactly these parts (everything else — `collectFiles`, `main`, normalize, CLI guard — stays structurally identical):

```ts
// scripts/ci/db-imports-audit.ts
//
// Ratchet guard for spec §2.1 (A+ campaign): domain modules receive `sql` /
// `supabaseServer` as explicit parameters; only COMPOSITION ROOTS may import
// the singleton module src/lib/db/server. Every current non-root importer is
// in DB_IMPORTS_BASELINE; CI fails on a NEW importer or a stale entry. The
// baseline shrinks to 0 over the Stage-2 domain sweeps, then Stage 3 deletes
// the baseline and this comment's "ratchet" framing becomes a strict rule.
import ts from 'typescript';
import { DB_IMPORTS_BASELINE } from './db-imports-baseline';

const SCAN_DIRS = ['src', 'worker'] as const;
// SKIP_DIRS / SKIP_FILE / SCAN_EXT: identical to process-env-audit.ts.

/** Module specifiers that resolve to the db singleton module. */
function isDbServerSpecifier(spec: string): boolean {
  return spec === '@/lib/db/server' || /(^|\/)db\/server$/.test(spec);
}

/** Composition roots — allowed to import the singleton (spec §2.1). */
export function isCompositionRoot(file: string): boolean {
  return (
    file === 'src/lib/db/server.ts' ||
    file === 'src/instrumentation.ts' ||
    /^src\/app\/.*\/route\.ts$/.test(file) ||          // Next.js route handlers
    /^src\/app\/.*\/page\.tsx$/.test(file) ||          // server components fetching at entry
    /^worker\/(index|queues)\.ts$/.test(file) ||
    /^worker\/jobs\/[^/]+\.ts$/.test(file) ||          // top-level job handlers
    /^worker\/background\//.test(file) ||              // pollers/schedulers boot
    /^worker\/ingress\//.test(file)                    // webhook ingress handlers
  );
}

/** True when the file has a VALUE import of db/server (import type is fine —
 *  types are explicit dependencies with zero runtime ambient coupling). */
export function fileImportsDbServer(text: string): boolean {
  const source = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isDbServerSpecifier(node.moduleSpecifier.text) &&
      !(node.importClause?.isTypeOnly ?? false)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export interface EvaluateInput {
  importingFiles: ReadonlySet<string>;
  baseline?: ReadonlySet<string>;
}

export function evaluateFindings(input: EvaluateInput): string[] {
  const baseline = input.baseline ?? DB_IMPORTS_BASELINE;
  const findings: string[] = [];
  for (const file of input.importingFiles) {
    if (isCompositionRoot(file)) continue;
    if (!baseline.has(file)) {
      findings.push(
        `${file} imports @/lib/db/server but is not a composition root — accept sql/supabaseServer as an explicit parameter instead (spec §2.1)`,
      );
    }
  }
  for (const file of baseline) {
    if (!input.importingFiles.has(file)) {
      findings.push(`${file} is in DB_IMPORTS_BASELINE but no longer imports db/server — remove the stale entry`);
    }
  }
  return findings;
}
```

Plus a `--emit-baseline` branch in `main()`: when `process.argv.includes('--emit-baseline')`, print the generated `db-imports-baseline.ts` module source (header comment + `export const DB_IMPORTS_BASELINE: ReadonlySet<string> = new Set([ …sorted files… ]);`) to stdout and exit 0.

- [ ] **Step 4: Unit test passes.** `pnpm vitest run scripts/ci` (or the mirrored test location) → PASS.

### Task 2: Baseline + wiring

- [ ] **Step 1:** Generate: `pnpm tsx scripts/ci/db-imports-audit.ts --emit-baseline > scripts/ci/db-imports-baseline.ts` — expect ≈214 entries minus composition-root files (spot-check: `rg -c "'" scripts/ci/db-imports-baseline.ts`).
- [ ] **Step 2:** `package.json`: `"ci:db-imports": "tsx scripts/ci/db-imports-audit.ts"`. Run `pnpm ci:db-imports` → `db-imports-audit: passed (baseline N files importing db/server outside composition roots)`.
- [ ] **Step 3:** `.github/workflows/ci.yml`: add after the process-env step (matching step style):

```yaml
      - name: DB-imports audit
        run: pnpm ci:db-imports
```

- [ ] **Step 4:** `lefthook.yml`: add `db-imports: { run: pnpm ci:db-imports }` alongside the other audits.
- [ ] **Step 5:** Document the convention: add a short section to `.claude/reference/lab-notes.md` (or the reference file the June campaign used for the process-env convention — mirror it) stating the composition-root rule + baseline ratchet.
- [ ] **Step 6: Commit** `"ci: db-imports ratchet guard — domain modules take sql as a parameter (A+ Q4)"`

### Task 3: RUN PIPELINE for PR 1a (not worker-touching)

---

## PR 1b — Constant modules + guards (reviews-status, outbox topics, pricing, ValueSummary)

**Branch/worktree:** `pnpm worktree:new aplus/1b-constants-guards main`

### Task 1: `reviews/status.ts` + ratchet guard

**Files:**
- Create: `src/lib/reviews/status.ts`
- Create: `scripts/ci/reviews-status-audit.ts` + `scripts/ci/reviews-status-baseline.ts` + unit test beside the 1a test
- Modify: `package.json`, `.github/workflows/ci.yml`, `lefthook.yml`

- [ ] **Step 1: The constant module** (vocabulary = the schema comment at `supabase/migrations/001_initial_schema.sql:178-179` plus `'deleted'`; before writing, confirm `deleted`'s provenance with `rg -ln "deleted" supabase/migrations | head` and cite the migration number in the comment):

```ts
// src/lib/reviews/status.ts
//
// Canonical reviews.status vocabulary — the single owner (mirrors the schema
// comment in 001_initial_schema.sql, plus 'deleted' added by migration 0NN).
// Import these; never re-spell a review-status literal (guard:
// scripts/ci/reviews-status-audit.ts). This is the reviews-table sibling of
// shared/response-status.ts.
export const REVIEW_STATUS = {
  NEW: 'new',
  GENERATING: 'generating',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  AWAITING_MANUAL_POST: 'awaiting_manual_post',
  POSTED: 'posted',
  FAILED: 'failed',
  DELETED: 'deleted',
} as const;

export type ReviewStatus = (typeof REVIEW_STATUS)[keyof typeof REVIEW_STATUS];
```

- [ ] **Step 2: Failing unit test for the guard's pure scanner** (same shape as 1a's):

```ts
import { describe, it, expect } from 'vitest';
import { fileHasRawReviewStatusPredicate } from '../reviews-status-audit';

describe('reviews-status-audit', () => {
  it('flags review-status literals in reviews-table sql templates', () => {
    const src = 'await sql`UPDATE reviews SET status = \'new\' WHERE id = ${id}`;';
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });
  it('ignores the same words outside reviews-table sql', () => {
    expect(fileHasRawReviewStatusPredicate(`const label = 'new';`)).toBe(false);
    expect(fileHasRawReviewStatusPredicate('await sql`UPDATE channel_enrollments SET status = \'failed\'`;')).toBe(false);
  });
  it('honors the pragma', () => {
    const src = 'await sql`UPDATE reviews SET status = \'new\' -- review-status-ignore\n`;';
    expect(fileHasRawReviewStatusPredicate(src)).toBe(false);
  });
});
```

- [ ] **Step 3: The guard script.** Skeleton = `process-env-audit.ts` (baseline + evaluate + collect); detector = tagged-template scan borrowed from `response-status-audit.ts`'s `SQL_TAG_NAMES` approach:
  - Walk the AST for tagged templates whose tag is `sql`/`tx`.
  - A template COUNTS when its raw text matches `/\breviews\b/` (table mention — the scoping heuristic that keeps generic words like `'new'`/`'failed'` from false-firing on other tables) AND contains `status` compared to a quoted literal from the REVIEW_STATUS vocabulary (`/status\s*(?:=|<>|!=|IN|NOT IN)[^`]*?'(new|generating|pending_approval|approved|awaiting_manual_post|posted|failed|deleted)'/`).
  - Per-line escape: `-- review-status-ignore` (SQL) or `// review-status-ignore` (TS) — for write guards that must stay inline (mirrors `status-audit-ignore`).
  - Baseline: `--emit-baseline` exactly like 1a; expected initial entries include `src/lib/kpi/service.ts`, `src/lib/reviews/process-review.ts`, `src/lib/dashboard/aggregate-service.ts` (the audit's 14+ sites; Stage 2f empties this).
- [ ] **Step 4:** Unit test passes; generate baseline; wire `ci:reviews-status` into `package.json` + `ci.yml` + `lefthook.yml`; `pnpm ci:reviews-status` → passed with baseline N.
- [ ] **Step 5: Commit** `"ci(reviews): status constant module + ratchet guard (A+ Q1)"`

### Task 2: Outbox topics — adopt `QUEUE_NAMES` + strict guard

**Files:**
- Modify (adoption): `src/lib/approval/correlation.ts:35`, `worker/jobs/account-offboarding/teardown-outbox.ts:27,32-34`, `worker/background/pollers/EngagementMonitorPoller.ts:173,183`, `worker/jobs/DrainOwnerConnectWorker.ts:60,68,73`, `src/lib/locations/archive-location-tx.ts:459`, `src/lib/reviews/process-review.ts:356`, `src/lib/onboarding/create-business.ts:313`
- Create: `scripts/ci/outbox-topics-audit.ts` + unit test
- Modify: `package.json`, `ci.yml`, `lefthook.yml`

- [ ] **Step 1 — inspection rule (Design refinement #3):** For EACH site, check whether the literal sits inside an `ON CONFLICT … WHERE` clause. If yes → KEEP the literal and append `-- topic-audit-ignore`. If it's a plain `VALUES (...)`, `WHERE`, or `IN (...)` in DML → replace with the interpolated constant (Postgres.js binds it as a parameter; semantics identical). **Do NOT touch `archive-location-tx.ts:207`** — `archive_reason: 'account_offboarding_teardown'` shares the string but is a different fact (an archive-reason value, not a topic).
- [ ] **Step 2 — representative edits** (import `{ QUEUE_NAMES } from '@/lib/shared/queue-names'` or the worker-relative equivalent per file):

`correlation.ts:35`: `WHERE topic = 'generate_response'` → ``WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}``

`teardown-outbox.ts:27`:
```ts
topic IN (${QUEUE_NAMES.GENERATE_RESPONSE}, ${QUEUE_NAMES.SEND_NOTIFICATION}, ${QUEUE_NAMES.PUBLISH_RESPONSE}, ${QUEUE_NAMES.AUTO_POST_NOTICE})
```
and lines 32–34 → `${QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE}, ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION}, ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN}`

`EngagementMonitorPoller.ts:173` (INSERT VALUES) and `:183` (WHERE) → `${QUEUE_NAMES.ENGAGEMENT_ALERT}` (after the Step-1 ON CONFLICT check on :183's context).

`DrainOwnerConnectWorker.ts:60,68,73` → `${QUEUE_NAMES.PUBLISH_RESPONSE}` (line 60 is inside a SELECT literal list — same treatment).

`archive-location-tx.ts:459` → `${QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL}` · `process-review.ts:356` → `${QUEUE_NAMES.NOTIFY_ADMIN}` · `create-business.ts:313` → `${QUEUE_NAMES.VALIDATE_PLACE_ID}`

- [ ] **Step 3 — the guard** (strict, no baseline — all sites fixed in Step 2): pure scanner flags a `sql`/`tx` tagged template that mentions `job_outbox` AND contains a quoted literal equal to any value in `ALL_QUEUE_NAMES`, without a `topic-audit-ignore` pragma on that line. Unit test with the three cases (violation / pragma / non-outbox template). Wire as `ci:outbox-topics` in `package.json` + `ci.yml` + `lefthook.yml`.
- [ ] **Step 4:** Full test suite green (`pnpm test`) — these files carry heavy existing coverage (teardown/offboarding/engagement suites) which is the behavior-preservation proof.
- [ ] **Step 5: Commit** `"refactor(outbox): adopt QUEUE_NAMES at all raw topic sites + strict guard (A+ Q1)"`

### Task 3: Pricing display derives from `TIER_CONFIG`

**Files:** Modify `src/app/(public)/pricing/PricingContent.tsx:27-100`; Create `src/app/(public)/pricing/__tests__/pricing-derivation.test.ts` (mirror neighboring test dir conventions).

- [ ] **Step 1: Failing test locking today's displayed numbers:**

```ts
import { describe, it, expect } from 'vitest';
import { monthlyPriceUsd, annualPriceUsd } from '../pricing-derivation';

describe('pricing page derives from TIER_CONFIG', () => {
  it('monthly = baseCents/100', () => {
    expect(monthlyPriceUsd('founders')).toBe(19);
    expect(monthlyPriceUsd('basic')).toBe(29);
    expect(monthlyPriceUsd('standard')).toBe(79);
    expect(monthlyPriceUsd('premium')).toBe(199);
  });
  it('annual = floor(monthly × (1 − 20% discount)) — locks today’s display', () => {
    expect(annualPriceUsd('founders')).toBe(15);
    expect(annualPriceUsd('basic')).toBe(23);
    expect(annualPriceUsd('standard')).toBe(63);
    expect(annualPriceUsd('premium')).toBe(159);
  });
});
```

- [ ] **Step 2:** Create `src/app/(public)/pricing/pricing-derivation.ts`:

```ts
// Display-price derivation for the public pricing page. The billing facts live
// in TIER_CONFIG (src/lib/accounts/tier-config.ts, invariant #9a grandfathering
// applies to ACCOUNTS — this page only displays the CURRENT config). The
// annual marketing discount is a display fact owned here.
import { TIER_CONFIG } from '@/lib/accounts/tier-config';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';

export const ANNUAL_DISCOUNT = 0.2;

export function monthlyPriceUsd(tier: SubscriptionTierValue): number {
  return TIER_CONFIG[tier].baseCents / 100;
}

export function annualPriceUsd(tier: SubscriptionTierValue): number {
  return Math.floor(monthlyPriceUsd(tier) * (1 - ANNUAL_DISCOUNT));
}
```

(If `SubscriptionTierValue` is exported from a different module, import from there — check `tier-config.ts`'s own import. Also verify `tier-config.ts` is import-safe for a client component: constants only, no server-only imports — `rg "import" src/lib/accounts/tier-config.ts`.)
- [ ] **Step 3:** Tests pass. In `PricingContent.tsx`, replace each tier's `monthly: 19` / `annual: 15` literal pair with `monthly: monthlyPriceUsd('founders'), annual: annualPriceUsd('founders')` (etc. per tier id).
- [ ] **Step 4:** `pnpm build` (page renders identically — numbers are equal by test) + commit `"refactor(pricing): derive display prices from TIER_CONFIG (A+ Q1)"`

### Task 4: One `ValueSummary` type

**Files:** Modify `src/lib/dashboard/types.ts:73-78,246-251`, `src/components/dashboard/kpi/ValueKpiGrid.tsx:8-13`.

- [ ] **Step 1:** In `types.ts`, above `DashboardData`, add:

```ts
/** Owner-facing value rollup — one wire shape for BOTH dashboard scopes. */
export interface ValueSummary {
  totalReviewsHandled: number;
  totalTimeSavedMinutes: number;
  currentResponseRate: number;
  baselineResponseRate: number | null;
}
```

then replace both inline `valueSummary: { … }` object types with `valueSummary: ValueSummary;`.
- [ ] **Step 2:** In `ValueKpiGrid.tsx`, delete the local `interface ValueSummary` and `import type { ValueSummary } from '@/lib/dashboard/types';`.
- [ ] **Step 3:** `pnpm typecheck && pnpm vitest run src/components/dashboard src/lib/dashboard` → PASS. Commit `"refactor(dashboard): single ValueSummary wire type (A+ Q1)"`

### Task 5: RUN PIPELINE for PR 1b — **worker-touching** (teardown-outbox, DrainOwnerConnectWorker, EngagementMonitorPoller) → staging ride required.

---

## PR 1c — LLM task seam (`src/lib/llm/`)

**Branch/worktree:** `pnpm worktree:new aplus/1c-llm-task-seam main`
**Behavior bar:** byte-identical generation. Existing generator tests mock the `openai`/`@anthropic-ai/sdk` SDKs — they must pass **unchanged** (the providers still construct the same SDK clients). Named Codex focus: cost-guard semantics untouched (M3 cache-write-inside-slot; `onFinalizeError: 'log-and-return-value'`; #255 retry classes).

### Task 1: Types + providers (pure moves)

**Files:**
- Create: `src/lib/llm/types.ts`, `src/lib/llm/openai-provider.ts`, `src/lib/llm/anthropic-provider.ts`, `src/lib/llm/client-options.ts`
- Move: `src/lib/responses/llm-error-classifier.ts` → `src/lib/llm/error-classifier.ts`, leaving a full re-export shim at the old path (`export * from '@/lib/llm/error-classifier';`) so ZERO imports churn in this PR (the shim dies in a Stage-2 sweep).

- [ ] **Step 1: `src/lib/llm/types.ts`**

```ts
// The LLM task seam (spec §2.2). Bounded by the agentic design-of-record:
// four task kinds, per-task pinned models with fallback, structured outputs
// for classification/judge tasks. DELIBERATELY ABSENT (design-of-record
// disqualifies them): streaming, tool-calls, multi-turn loops.
//
// COST-GUARD CONTRACT: every runLlmTask call in production code MUST be
// wrapped in withCostGuard by its caller (see the cost-guard skill). The
// guard stays caller-side because generation's idempotent-cache write must
// happen inside the guarded closure (M3 race — generator.ts). Demo/eval
// callers are the sanctioned unguarded exceptions.
import type { ZodTypeAny } from 'zod';

export type LLMTaskId = 'reply_generation' | 'triage' | 'judge' | 'insights';

export type LLMProviderId = 'openai' | 'anthropic';

export interface ChatPrompt {
  system: string;
  user: string;
}

export interface LLMCallResult {
  text: string;
  provider: LLMProviderId;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface LLMRequest extends ChatPrompt {
  model: string;
  maxTokens: number;
  temperature?: number;
}

export interface LLMProvider {
  readonly id: LLMProviderId;
  complete(request: LLMRequest): Promise<LLMCallResult>;
}

export interface LLMTaskDescriptor {
  taskId: LLMTaskId;
  primary: { provider: LLMProviderId; model: string };
  fallback?: { provider: LLMProviderId; model: string };
  maxTokens: number;
  temperature?: number;
  /** Structured-output contract for classification/judge tasks. Declared in
   *  the type vocabulary now; runtime enforcement lands with the first
   *  structured task (triage) — no dead code ships before its tenant. */
  outputSchema?: ZodTypeAny;
}
```

- [ ] **Step 2: `src/lib/llm/client-options.ts`** — move `LLM_CLIENT_OPTIONS` (with its full deep-scan §5.1/§5.2 comment block from `generator.ts:38-47`) verbatim. `generator.ts` re-exports it (`export { LLM_CLIENT_OPTIONS } from '@/lib/llm/client-options';`) so `client-options.test.ts` keeps passing untouched.

- [ ] **Step 3: `src/lib/llm/openai-provider.ts`** — body from `generator.ts:293-297,342-369`, parameterized:

```ts
import OpenAI from 'openai';
import { LLM_CLIENT_OPTIONS } from './client-options';
import type { LLMProvider, LLMRequest, LLMCallResult } from './types';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI(LLM_CLIENT_OPTIONS);
  return _client;
}

export const openaiProvider: LLMProvider = {
  id: 'openai',
  async complete(request: LLMRequest): Promise<LLMCallResult> {
    const response = await getClient().chat.completions.create({
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned empty response');
    return {
      text,
      provider: 'openai',
      model: request.model,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  },
};
```

- [ ] **Step 4: `src/lib/llm/anthropic-provider.ts`** — same treatment of `generator.ts:299-303,371-402` (system → `system:` field, text-block filter + join + trim, empty-response throw, `input_tokens`/`output_tokens` mapping — copy the logic verbatim, only parameterizing model/maxTokens).

- [ ] **Step 5: The classifier move + shim.** `git mv src/lib/responses/llm-error-classifier.ts src/lib/llm/error-classifier.ts`; create the shim at the old path:

```ts
// Re-export shim: the classifier moved to the LLM seam (A+ campaign PR 1c).
// Existing imports keep working; a Stage-2 sweep retargets them and deletes this.
export * from '@/lib/llm/error-classifier';
```

- [ ] **Step 6:** `pnpm typecheck && pnpm vitest run src/lib/responses src/lib/llm` → all green (nothing consumes the new modules yet; the shim keeps every existing import path alive).
- [ ] **Step 7: Commit** `"refactor(llm): provider adapters + task types (seam foundation, no callers yet)"`

### Task 2: Registry + `runLlmTask`

**Files:**
- Create: `src/lib/llm/tasks.ts`, `src/lib/llm/run-task.ts`, `src/lib/llm/__tests__/run-task.test.ts`

- [ ] **Step 1: `src/lib/llm/tasks.ts`** — the pinned model constants MOVE here (single owner):

```ts
import type { LLMTaskDescriptor, LLMTaskId } from './types';

// Pinned snapshots — never a bare alias (silent-regression risk). Guarded by
// model-pinning.test.ts. Single owner: generator.ts re-exports for back-compat.
export const OPENAI_MODEL = 'gpt-4o-mini-2024-07-18' as const;
export const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001' as const;

/** Runtime registry. `triage` / `judge` / `insights` exist in the LLMTaskId
 *  vocabulary (types.ts) but get entries only when their feature lands —
 *  no dead task config ships before its tenant (spec §2.2). */
export const LLM_TASKS: Partial<Record<LLMTaskId, LLMTaskDescriptor>> = {
  reply_generation: {
    taskId: 'reply_generation',
    primary: { provider: 'openai', model: OPENAI_MODEL },
    fallback: { provider: 'anthropic', model: ANTHROPIC_MODEL },
    maxTokens: 300,
    temperature: 0.7,
  },
};

export function getLlmTask(taskId: LLMTaskId): LLMTaskDescriptor {
  const task = LLM_TASKS[taskId];
  if (!task) throw new Error(`LLM task not registered: ${taskId}`);
  return task;
}
```

- [ ] **Step 2: Failing tests for `runLlmTask`** — port the fallback matrix (mock both provider modules with `vi.mock`):

```ts
// src/lib/llm/__tests__/run-task.test.ts — cases:
// 1. primary succeeds → result from openai, anthropic never called
// 2. primary throws → fallback succeeds → result from anthropic
// 3. both throw, either transient → throws TransientLLMError wrapping the TRANSIENT cause
//    (3a openai transient + anthropic permanent → cause is the openai error;
//     3b openai permanent + anthropic transient → cause is the anthropic error)
// 4. both throw, both permanent → rethrows the anthropic (last) error
// 5. unregistered task id → throws "LLM task not registered"
```

Write all five as real tests (use `isTransientLLMError`-shaped fixtures: a `new OpenAI.APIConnectionError`-style transient vs an object with `status: 401` permanent — copy the fixture style from the existing generator fallback tests, found via `rg -l "falling back to Anthropic" src/lib/responses/__tests__`).

- [ ] **Step 3: `src/lib/llm/run-task.ts`** — `callLLMWithFallback` relocated (`generator.ts:314-340` verbatim logic, registry-resolved):

```ts
import { getLlmTask } from './tasks';
import { openaiProvider } from './openai-provider';
import { anthropicProvider } from './anthropic-provider';
import { isTransientLLMError, TransientLLMError, redactProviderError } from './error-classifier';
import type { ChatPrompt, LLMCallResult, LLMProvider, LLMProviderId, LLMTaskId } from './types';

const PROVIDERS: Record<LLMProviderId, LLMProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

/**
 * Execute a registered LLM task: primary provider, then fallback, with the
 * transient/terminal classification the worker retry ladder depends on.
 * COST-GUARD CONTRACT: production callers wrap this in withCostGuard — see
 * types.ts header. (Behavior relocated verbatim from generator.ts
 * callLLMWithFallback — A+ campaign PR 1c.)
 */
export async function runLlmTask(taskId: LLMTaskId, prompt: ChatPrompt): Promise<LLMCallResult> {
  const task = getLlmTask(taskId);
  const primary = PROVIDERS[task.primary.provider];
  const request = { ...prompt, maxTokens: task.maxTokens, temperature: task.temperature };
  try {
    return await primary.complete({ ...request, model: task.primary.model });
  } catch (primaryError) {
    if (!task.fallback) throw primaryError;
    console.error(
      `[llm:${taskId}] ${task.primary.provider} call failed, falling back to ${task.fallback.provider}:`,
      redactProviderError(primaryError),
    );
    try {
      return await PROVIDERS[task.fallback.provider].complete({ ...request, model: task.fallback.model });
    } catch (fallbackError) {
      // Wrap the actually-transient cause — wrapping the wrong one would let
      // the worker retry forever against a permanent failure (e.g. a 401
      // after a 503). Verbatim from generator.ts.
      const primaryTransient = isTransientLLMError(primaryError);
      const fallbackTransient = isTransientLLMError(fallbackError);
      if (primaryTransient || fallbackTransient) {
        throw new TransientLLMError(fallbackTransient ? fallbackError : primaryError);
      }
      throw fallbackError;
    }
  }
}
```

- [ ] **Step 4:** All five run-task tests pass. Commit `"feat(llm): task registry + runLlmTask executor (reply_generation first entry)"`

### Task 3: Generator becomes the first tenant

**Files:**
- Modify: `src/lib/responses/generator.ts` — delete lines 29-47 (constants move; keep re-exports), 291-402 (clients + fallback + provider calls); replace both `callLLMWithFallback(prompt.systemPrompt, prompt.userPrompt)` call sites (lines 102, 184) with `runLlmTask('reply_generation', { system: prompt.systemPrompt, user: prompt.userPrompt })`.
- Modify: `src/lib/responses/__tests__/model-pinning.test.ts` — imports retarget to `@/lib/llm/tasks`; ADD one assertion that the generator re-exports stay identical.

- [ ] **Step 1:** New generator import block + back-compat re-exports:

```ts
import { runLlmTask } from '@/lib/llm/run-task';
import { OPENAI_MODEL, ANTHROPIC_MODEL } from '@/lib/llm/tasks';

// Back-compat re-exports (consumers: costs/audit.ts pricing map, review-summary.ts,
// client-options.test.ts). Retargeted in a Stage-2 sweep.
export { OPENAI_MODEL, ANTHROPIC_MODEL };
export { LLM_CLIENT_OPTIONS } from '@/lib/llm/client-options';
export { TransientLLMError } from '@/lib/llm/error-classifier';
```

Everything else in `runDemoMode` / `runProductionMode` — cost guard placement, M3 cache write, `onFinalizeError`, `tryRecordApiCost`, prompt-policy hash — is UNTOUCHED.

- [ ] **Step 2:** `model-pinning.test.ts` — change the import to `@/lib/llm/tasks` and append:

```ts
  it('generator re-exports stay identical to the registry (back-compat)', async () => {
    const generator = await import('../generator');
    expect(generator.OPENAI_MODEL).toBe(OPENAI_MODEL);
    expect(generator.ANTHROPIC_MODEL).toBe(ANTHROPIC_MODEL);
  });
```

- [ ] **Step 3: The behavior-preservation gate:** `pnpm vitest run src/lib/responses src/lib/llm worker/jobs/response-generation` → **every pre-existing test passes unchanged** (SDK-level mocks still hit the same `new OpenAI(...)`/`new Anthropic(...)` constructions inside the providers). If any existing test needed editing beyond the model-pinning import retarget, STOP — that's a behavior deviation to investigate, not a test to fix.
- [ ] **Step 4:** `pnpm eval:llm` (offline/keyless) → green.
- [ ] **Step 5:** `pnpm test && pnpm typecheck && pnpm build`. Commit `"refactor(responses): generator rides the LLM task seam (byte-identical behavior)"`

### Task 4: RUN PIPELINE for PR 1c — **worker-touching** → staging ride mandatory: push to `staging`, watch the Railway worker boot, then generate one real staging draft end-to-end (staging smoke per `docs/runbooks/channels-staging-smoke-test.md` §draft-generation) before merge. Codex review focus: the cost-guard invariants listed in this PR's header.

---

## After Stage 0+1

- [ ] Update `docs/progresstracking.md` with the five PR entries (mirror the June campaign's format).
- [ ] Write the Stage-2 per-domain plan (`docs/superpowers/plans/2026-MM-DD-modularity-aplus-stage2.md`) — its sweep order and per-domain file lists come from the THEN-current `db-imports-baseline.ts` + `reviews-status-baseline.ts`, which is why it is not written today.

## Self-review (done at write time)

- **Spec coverage:** 0a/0b/1a/1b/1c map to spec §3 Stage 0+1 rows one-to-one; Stage 2–4 explicitly deferred with a pointer. Spec §2.1 guard = PR 1a; §2.2 seam = PR 1c (with refinement #2 surfaced in the header, not silently applied).
- **Placeholders:** the two "copy from the file" instructions (STATE_STYLES class strings; auto-post-notice pragma prose) are deliberate verbatim-preservation rules, not gaps; every other step carries complete code or exact commands.
- **Type consistency:** `LLMCallResult` field names match generator's existing `llmResult` usage (`text/provider/model/usage.promptTokens/usage.completionTokens`); `ValueSummary` matches both inline shapes; `describeWithDb(name, factory)` matches vitest's `describe` signature.
