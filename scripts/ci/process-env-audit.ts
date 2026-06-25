// scripts/ci/process-env-audit.ts
//
// Baseline guard: the sanctioned process.env home is src/lib/config/** (plus
// worker/env.ts and worker/config/startup-assert.ts). Every OTHER in-scope file
// (src/lib/**, worker/**) that reads process.env today is in PROCESS_ENV_BASELINE.
// CI fails when a NEW (non-baseline, non-allowlisted) file reads process.env, or
// when a baseline entry no longer reads it (stale — remove it). The baseline
// shrinks to 0 over Stage 3 as reads migrate onto the config accessors.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROCESS_ENV_BASELINE, isAllowlisted } from './process-env-baseline';

export { isAllowlisted };

const SCAN_DIRS = ['src/lib', 'worker'] as const;
const SCAN_EXT = /\.(?:ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next', 'coverage', '__fixtures__']);
const SKIP_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;

// A genuine read: process.env.X or process.env['X'] on a non-comment line.
const PROCESS_ENV_ACCESS = /process\.env(?:\.\w+|\[)/;

function normalize(file: string): string {
  return file.split(sep).join('/');
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** True if any non-comment line reads process.env. Pure — unit-tested. */
export function fileReadsProcessEnv(text: string): boolean {
  return text.split('\n').some((line) => !isCommentLine(line) && PROCESS_ENV_ACCESS.test(line));
}

export interface EvaluateInput {
  readingFiles: ReadonlySet<string>;
  baseline?: ReadonlySet<string>;
}

/** Compare the live reading-file set against the baseline. Pure — unit-tested. */
export function evaluateFindings(input: EvaluateInput): string[] {
  const baseline = input.baseline ?? PROCESS_ENV_BASELINE;
  const findings: string[] = [];
  for (const file of input.readingFiles) {
    if (isAllowlisted(file)) continue;
    if (!baseline.has(file)) {
      findings.push(
        `${file} reads process.env but is NOT in PROCESS_ENV_BASELINE — route it through src/lib/config/* (Stage 3) instead of adding a new raw read`,
      );
    }
  }
  for (const file of baseline) {
    if (!input.readingFiles.has(file)) {
      findings.push(
        `${file} is in PROCESS_ENV_BASELINE but no longer reads process.env — remove the stale baseline entry (the baseline shrinks to 0 over Stage 3)`,
      );
    }
  }
  return findings;
}

async function collectFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(join(dir, entry.name), root, out);
    } else if (entry.isFile() && SCAN_EXT.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(normalize(relative(root, join(dir, entry.name))));
    }
  }
}

export async function collectReadingFiles(root: string): Promise<Set<string>> {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) await collectFiles(resolve(root, dir), root, files);
  const reading = new Set<string>();
  for (const file of files) {
    if (isAllowlisted(file)) continue;
    if (fileReadsProcessEnv(await readFile(resolve(root, file), 'utf8'))) reading.add(file);
  }
  return reading;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const reading = await collectReadingFiles(root);
  const findings = evaluateFindings({ readingFiles: reading });
  if (findings.length > 0) {
    console.error('process-env-audit: failed');
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log(
    `process-env-audit: passed (baseline ${PROCESS_ENV_BASELINE.size} files reading process.env outside the config home)`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('process-env-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
