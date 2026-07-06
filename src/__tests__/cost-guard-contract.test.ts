import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Cost-guard TRIPWIRE for the LLM task seam (A+ campaign PR 1c).
//
// Every production runLlmTask call must be wrapped in withCostGuard by its
// caller (the guard stays caller-side because generation's idempotent-cache
// write must happen inside the guarded closure — the M3 race, see
// generator.ts). This test forces HUMAN REVIEW of every new caller: adding a
// runLlmTask call site outside the allowlist fails here until the file is
// deliberately added below — the same governance as the JSONB string-guard
// carve-out allowlist in CLAUDE.md. It is NOT a proof of guard placement;
// generator.test.ts's behavioral cost-guard tests are the proof. Sanctioned
// unguarded callers (demo/eval lanes) get added here BY NAME when they appear.
//
// Lives in src/__tests__ so the lefthook `guards` command runs it
// unconditionally (readFileSync-based guard tests are in NO import graph, so
// `vitest --changed` would silently skip it elsewhere).

const CALLER_ALLOWLIST = new Set([
  'src/lib/responses/generator.ts',
  // insights tenant (review-summary) — wraps runLlmTask in withCostGuard with
  // reserve/finalize (see generateReviewSummary). A+ campaign 2f-A.
  'src/lib/responses/review-summary.ts',
]);

const SCAN_ROOTS = ['src', 'worker'];
const SKIP_DIRS = new Set(['__tests__', 'fixtures', 'node_modules']);
// A CALL site — the lookbehind excludes run-task.ts's own declaration
// (`export async function runLlmTask(`).
const CALL_SITE = /(?<!function )\brunLlmTask\s*\(/;

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkSourceFiles(join(dir, entry.name));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

function findCallSiteFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const filePath of walkSourceFiles(join(process.cwd(), root))) {
      if (CALL_SITE.test(readFileSync(filePath, 'utf-8'))) {
        files.push(relative(process.cwd(), filePath).split('\\').join('/'));
      }
    }
  }
  return files.sort();
}

describe('LLM cost-guard contract: runLlmTask callers are allowlisted', () => {
  const callSiteFiles = findCallSiteFiles();

  it('every runLlmTask call site is in the reviewed-caller allowlist', () => {
    const unreviewed = callSiteFiles.filter((file) => !CALLER_ALLOWLIST.has(file));
    expect(
      unreviewed,
      `New runLlmTask caller(s) detected: ${unreviewed.join(', ')}. ` +
        'Every production caller must wrap runLlmTask in withCostGuard (see the ' +
        'cost-guard skill and src/lib/llm/types.ts header); demo/eval lanes are ' +
        'the sanctioned unguarded exceptions. Review the call site, then add the ' +
        'file to CALLER_ALLOWLIST here.',
    ).toHaveLength(0);
  });

  it('the allowlist carries no stale entries (files without a call site)', () => {
    const found = new Set(callSiteFiles);
    const stale = [...CALLER_ALLOWLIST].filter((file) => !found.has(file));
    expect(
      stale,
      `Allowlisted file(s) no longer call runLlmTask: ${stale.join(', ')}. ` +
        'Remove them — this is an allowlist, not folklore.',
    ).toHaveLength(0);
  });
});
