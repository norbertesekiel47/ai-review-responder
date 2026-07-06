// scripts/ci/lib/ratchet-harness.ts
//
// Shared filesystem-walk + baseline-ratchet primitives for the scripts/ci
// baseline/scan audits (db-imports, process-env, reviews-status, outbox-topics,
// response-status, static-policy). Each audit still OWNS its SCAN_DIRS, its
// per-file predicate, and its evaluator — the mechanism they all re-spelled is
// what lives here once:
//   - the recursive directory walker with skip-sets (`walk`),
//   - the two-loop baseline diff (`evaluateAgainstBaseline`), and
//   - the atomic baseline emit (`assembleBaselineModule` + `emitBaselineFile`).
//
// The walk defaults (SCAN_EXT / SKIP_DIRS / SKIP_FILE) match the DB-injection
// and process-env sweeps. Callers that scan a wider surface override them per
// call: static-policy adds js/mjs/cjs to the extension set, and both
// response-status and static-policy drop __fixtures__ from the skip set.
import { readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/** Default source-file extensions scanned by the ratchet audits (walk's fallback). */
const DEFAULT_SCAN_EXT = /\.(?:ts|tsx)$/;

/** Directories never descended into during a scan. */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '__tests__',
  'dist',
  '.next',
  'coverage',
  '__fixtures__',
]);

/** Test/spec files excluded from every scan (they legitimately hold fixtures; walk's fallback). */
const DEFAULT_SKIP_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;

/** A repo-relative path with forward slashes on every platform. */
export function normalize(file: string): string {
  return file.split(sep).join('/');
}

interface ResolvedWalk {
  scanExt: RegExp;
  skipDirs: ReadonlySet<string>;
  skipFile: RegExp;
}

async function collectFiles(dir: string, root: string, out: string[], opts: ResolvedWalk): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory absent — nothing to scan
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!opts.skipDirs.has(entry.name)) await collectFiles(join(dir, entry.name), root, out, opts);
    } else if (entry.isFile() && opts.scanExt.test(entry.name) && !opts.skipFile.test(entry.name)) {
      out.push(normalize(relative(root, join(dir, entry.name))));
    }
  }
}

export interface WalkOptions {
  /** Repo-relative directories to scan (each resolved against `root`). */
  scanDirs: readonly string[];
  /** Override the default `.ts`/`.tsx` extension filter. */
  scanExt?: RegExp;
  /** Override the default skip-directory set. */
  skipDirs?: ReadonlySet<string>;
}

/**
 * Recursively collect every normalized, repo-relative source path under
 * `scanDirs`, honoring the extension / skip-dir / skip-file filters. A missing
 * scan directory is silently skipped (the walk yields nothing for it) so an
 * audit that names a not-yet-existing root doesn't crash. Order follows
 * directory traversal; callers that need determinism sort the result.
 */
export async function walk(root: string, options: WalkOptions): Promise<string[]> {
  const resolved: ResolvedWalk = {
    scanExt: options.scanExt ?? DEFAULT_SCAN_EXT,
    skipDirs: options.skipDirs ?? DEFAULT_SKIP_DIRS,
    skipFile: DEFAULT_SKIP_FILE,
  };
  const files: string[] = [];
  for (const dir of options.scanDirs) {
    await collectFiles(resolve(root, dir), root, files, resolved);
  }
  return files;
}

export interface BaselineDiff {
  /** Known offenders whose presence in the baseline exempts them today. */
  baseline: ReadonlySet<string>;
  /** Files exempt from the "new offender" check regardless of the baseline. */
  skip: (file: string) => boolean;
  /** Message for a live offender that is neither skip-exempt nor baselined. */
  onNew: (file: string) => string;
  /** Message for a baseline entry that no longer offends (stale — remove it). */
  onStale: (file: string) => string;
}

/**
 * Two-loop baseline diff shared by the db-imports and process-env ratchets: a
 * live offender that is neither skip-exempt nor in the baseline is a NEW
 * finding; a baseline entry absent from the live set is a STALE finding. The
 * baseline shrinks to 0 as offenders migrate, at which point both loops go
 * quiet. Pure — unit-tested.
 */
export function evaluateAgainstBaseline(found: ReadonlySet<string>, diff: BaselineDiff): string[] {
  const findings: string[] = [];
  for (const file of found) {
    if (diff.skip(file)) continue;
    if (!diff.baseline.has(file)) findings.push(diff.onNew(file));
  }
  for (const file of diff.baseline) {
    if (!found.has(file)) findings.push(diff.onStale(file));
  }
  return findings;
}

/**
 * Assemble a committed-baseline module's source: the given `header` lines
 * (through the opening `... = new Set([`), then the entries sorted and quoted,
 * then the closing `]);` and a trailing blank line — joined by newlines with a
 * final newline. The header carries the module's identity (path comment, regen
 * command, const name + type) so this stays generic across baselines. Pure —
 * unit-tested.
 */
export function assembleBaselineModule(header: readonly string[], entries: readonly string[]): string {
  const lines = [
    ...header,
    ...[...entries].sort().map((entry) => `  '${entry}',`),
    ']);',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Write `source` to `targetPath` atomically: the full source is written to a
 * co-located `.tmp` file, then `rename`d into place. A crash mid-write leaves
 * only the `.tmp` — never a half-written baseline — since `rename` is a single
 * filesystem operation.
 */
export async function emitBaselineFile(targetPath: string, source: string): Promise<void> {
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, source);
  await rename(tmp, targetPath);
}
