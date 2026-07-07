// scripts/ci/normalize-v8-coverage.ts
//
// Repairs the istanbul `coverage/coverage-final.json` that `vitest run
// --coverage` (v8 provider) emits so `fallow audit --coverage` can consume it.
//
// WHY: vitest 4's v8 coverage provider (`@vitest/coverage-v8`) can write a
// branch hit-count of `-1` into the istanbul `b` (branch) map (observed for one
// branch of src/lib/shared/writable-subscription.ts). `-1` is out of range —
// istanbul hit counts and positions are unsigned — and fallow's coverage
// deserializer rejects the ENTIRE report with `invalid value: integer -1,
// expected u32` at every fallow version tested (2.86.0, 2.88.2, 3.2.0).
// Clamping negatives to `0` yields spec-valid istanbul coverage. istanbul
// coverage has no legitimately-negative field (counts and line/column
// positions are all ≥ 0), so a blanket clamp is safe and repairs the sentinel
// wherever it appears.
//
// M3 (nuance): v8's `-1` typically marks an UNMAPPABLE ("unknown") branch — a
// location the provider could not resolve back to source, not a genuinely-taken
// branch. Clamping to `0` therefore reads it as "never taken": a conservative
// approximation that biases toward "uncovered", never toward "covered".
// Harmless for the current new-only complexity/duplication gate.
//
// M1 (alternative weighed): switching vitest's `coverage.provider` to `istanbul`
// would eliminate the `-1` at the source and let this script be deleted, but v8
// is kept (faster, vitest's default) — swapping providers also changes repo-wide
// coverage semantics for the text/lcov/html reporters, a wider blast radius than
// this narrow clamp.
//
// M2 (revisit / delete): the ROOT CAUSE is upstream — `@vitest/coverage-v8`
// (vitest 4) emitting a negative branch hit-count. Delete this script once that
// provider stops emitting negative counts. (No canonical upstream issue URL
// identified at time of writing — track as an unfixed vitest-4 v8 quirk.)
//
// Runs as the first half of the `ci:fallow:coverage` script so the coverage
// gate self-heals its own input identically in local runs and CI. Missing
// report → exit 0 (delegates the missing-coverage error to fallow's own
// `--coverage` check), so it composes cleanly.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const COVERAGE_FILE = resolve(process.cwd(), 'coverage/coverage-final.json');

/**
 * Parse istanbul coverage JSON, clamping every negative number to 0 (repairing
 * vitest-v8's out-of-range `-1` branch sentinel), and re-serialize.
 *
 * Pure: no filesystem, no `process` — the JSON text is the whole contract.
 * Returns the re-serialized text plus how many negatives were clamped. When
 * `clamped === 0` the returned `text` is the exact input, so the caller can
 * skip the write.
 */
export function clampNegativeCounts(jsonText: string): { text: string; clamped: number } {
  let clamped = 0;
  const coverage: unknown = JSON.parse(jsonText, (_key, value) => {
    if (typeof value === 'number' && value < 0) {
      clamped += 1;
      return 0;
    }
    return value;
  });

  if (clamped === 0) {
    return { text: jsonText, clamped: 0 };
  }

  return { text: JSON.stringify(coverage), clamped };
}

function main(): void {
  if (!existsSync(COVERAGE_FILE)) {
    console.log(`[normalize-v8-coverage] ${COVERAGE_FILE} not found — nothing to normalize.`);
    return;
  }

  const { text, clamped } = clampNegativeCounts(readFileSync(COVERAGE_FILE, 'utf8'));

  if (clamped === 0) {
    console.log('[normalize-v8-coverage] no negative hit counts found — coverage left unchanged.');
    return;
  }

  writeFileSync(COVERAGE_FILE, text);
  console.log(`[normalize-v8-coverage] clamped ${clamped} out-of-range value(s) to 0.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
