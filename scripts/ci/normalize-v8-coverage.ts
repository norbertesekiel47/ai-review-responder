// scripts/ci/normalize-v8-coverage.ts
//
// Repairs the istanbul `coverage/coverage-final.json` that `vitest run
// --coverage` (v8 provider) emits so `fallow audit --coverage` can consume it.
//
// WHY: vitest 4's v8 coverage provider can write a branch hit-count of `-1`
// into the istanbul `b` (branch) map (observed for one branch of
// src/lib/shared/writable-subscription.ts). `-1` is out of range — istanbul
// hit counts and positions are unsigned — and fallow's coverage deserializer
// rejects the ENTIRE report with `invalid value: integer -1, expected u32` at
// every fallow version tested (2.86.0, 2.88.2, 3.2.0). Clamping negatives to
// `0` yields spec-valid istanbul coverage: `0` means "branch never taken",
// exactly what the `-1` sentinel represents here. istanbul coverage has no
// legitimately-negative field (counts and line/column positions are all ≥ 0),
// so a blanket clamp is safe and repairs the sentinel wherever it appears.
//
// Runs as the first half of the `ci:fallow:coverage` script so the coverage
// gate self-heals its own input identically in local runs and CI. No-ops
// (exit 0) when the report is absent, so it composes cleanly with fallow's own
// missing-coverage error.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COVERAGE_FILE = resolve(process.cwd(), 'coverage/coverage-final.json');

function main(): void {
  if (!existsSync(COVERAGE_FILE)) {
    console.log(`[normalize-v8-coverage] ${COVERAGE_FILE} not found — nothing to normalize.`);
    return;
  }

  let clamped = 0;
  const coverage: unknown = JSON.parse(readFileSync(COVERAGE_FILE, 'utf8'), (_key, value) => {
    if (typeof value === 'number' && value < 0) {
      clamped += 1;
      return 0;
    }
    return value;
  });

  if (clamped === 0) {
    console.log('[normalize-v8-coverage] no negative hit counts found — coverage left unchanged.');
    return;
  }

  writeFileSync(COVERAGE_FILE, JSON.stringify(coverage));
  console.log(`[normalize-v8-coverage] clamped ${clamped} out-of-range value(s) to 0.`);
}

main();
