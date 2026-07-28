// scripts/merge-coverage.ts — merge istanbul-shaped coverage-final.json files.
//
// `scripts/verify-gate.sh` runs each changed *.integration.test.ts as its own
// vitest process. Each writes a COMPLETE coverage-final.json, so pointing them
// all at one directory makes the last writer win and silently discard every
// other row's coverage (#563 item 2). Each therefore writes to its own
// directory and this merges them into the base report before diff-coverage
// reads it.
//
// Hand-rolled rather than pulling in nyc/istanbul-lib-coverage: the merge is a
// counter sum over a well-specified shape, and the repo has no istanbul
// dependency to reuse (repworth.md — prefer fewer packages).
//
// Usage: tsx scripts/merge-coverage.ts <base.json> <extra-dir> [extra-dir...]
// The base file is REWRITTEN in place. Missing inputs are skipped, not fatal —
// a gate run with no changed integration suites merges nothing and must still
// leave the base report intact.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One file's istanbul entry. Counter maps are id -> hits (branches: id -> hits[]). */
interface FileCoverage {
  path: string;
  statementMap: Record<string, unknown>;
  fnMap: Record<string, unknown>;
  branchMap: Record<string, unknown>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

type CoverageMap = Record<string, FileCoverage>;

function readCoverage(path: string): CoverageMap | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CoverageMap;
  } catch (error) {
    // A truncated report is a real problem (the producing run died mid-write);
    // say which file rather than letting a downstream consumer report a vague
    // parse failure.
    throw new Error(`merge-coverage: ${path} is not valid JSON: ${String(error)}`);
  }
}

function sumCounters(into: Record<string, number>, from: Record<string, number>): void {
  for (const [id, hits] of Object.entries(from)) {
    into[id] = (into[id] ?? 0) + hits;
  }
}

function sumBranchCounters(
  into: Record<string, number[]>,
  from: Record<string, number[]>,
): void {
  for (const [id, hits] of Object.entries(from)) {
    const existing = into[id];
    if (!existing) {
      into[id] = [...hits];
      continue;
    }
    // Same branch id with a different arm count means the two runs saw
    // different source. Keep the longer arm list rather than truncating.
    const merged = existing.length >= hits.length ? [...existing] : [...hits];
    for (let i = 0; i < Math.min(existing.length, hits.length); i += 1) {
      merged[i] = (existing[i] ?? 0) + (hits[i] ?? 0);
    }
    into[id] = merged;
  }
}

function mergeInto(base: CoverageMap, extra: CoverageMap): void {
  for (const [file, incoming] of Object.entries(extra)) {
    const existing = base[file];
    if (!existing) {
      base[file] = incoming;
      continue;
    }
    // Structural maps are identical for identical source, so the base's copy
    // stands; only the hit counters accumulate.
    sumCounters(existing.s, incoming.s);
    sumCounters(existing.f, incoming.f);
    sumBranchCounters(existing.b, incoming.b);
  }
}

export function mergeCoverageReports(basePath: string, extraDirs: string[]): number {
  const base = readCoverage(basePath);
  if (!base) {
    throw new Error(`merge-coverage: base report ${basePath} not found`);
  }

  let merged = 0;
  for (const dir of extraDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const candidate = join(dir, entry, 'coverage-final.json');
      const extra = readCoverage(candidate);
      if (!extra) continue;
      mergeInto(base, extra);
      merged += 1;
    }
  }

  writeFileSync(basePath, JSON.stringify(base), 'utf8');
  return merged;
}

if (process.argv[1] && process.argv[1].endsWith('merge-coverage.ts')) {
  const [basePath, ...extraDirs] = process.argv.slice(2);
  if (!basePath) {
    console.error('usage: tsx scripts/merge-coverage.ts <base.json> <extra-dir>...');
    process.exit(2);
  }
  const count = mergeCoverageReports(basePath, extraDirs);
  console.log(`[merge-coverage] merged ${count} additional report(s) into ${basePath}`);
}
