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
import ts from 'typescript';
import { PROCESS_ENV_BASELINE, isAllowlisted } from './process-env-baseline';

export { isAllowlisted };

const SCAN_DIRS = ['src/lib', 'worker'] as const;
const SCAN_EXT = /\.(?:ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next', 'coverage', '__fixtures__']);
const SKIP_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;

function normalize(file: string): string {
  return file.split(sep).join('/');
}

/**
 * Env INDICATORS are exempt (Stage-3 convention #2): they describe WHICH
 * environment the process runs in, not subsystem CONFIG, so they stay direct
 * `process.env.X` reads and never route through a config accessor. A file that
 * reads ONLY these is therefore NOT counted as a config-bearing process.env
 * reader, letting it drop out of the migration baseline.
 *   - NODE_ENV          — runtime mode (prod/dev/test)
 *   - MOCK_EXTERNAL_APIS — local mock-mode switch
 *   - VERCEL_*          — platform-injected deploy indicators (VERCEL_ENV,
 *                          VERCEL_TARGET_ENV, VERCEL_URL, …)
 */
function isExemptIndicatorName(name: string): boolean {
  return name === 'NODE_ENV' || name === 'MOCK_EXTERNAL_APIS' || name.startsWith('VERCEL_');
}

/**
 * True when `node` is the member-access `process.env` (the `.env` part of
 * `process.env`). Covers `process.env.X`, `process.env['X']`,
 * `const { X } = process.env`, and `const e = process.env`.
 */
function isProcessEnvMemberAccess(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

/**
 * The single var NAME read off a `process.env` node — `X` from `process.env.X`
 * or `process.env['X']` — else null. A destructuring (`const { X } =
 * process.env`) or alias (`const e = process.env`) reads the whole env object;
 * its property name isn't knowable from this node alone, so it returns null and
 * is treated as a non-exempt (counted) read by the caller.
 */
function staticallyAccessedVarName(envNode: ts.PropertyAccessExpression): string | null {
  const parent = envNode.parent;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === envNode) {
    return parent.name.text;
  }
  if (
    parent &&
    ts.isElementAccessExpression(parent) &&
    parent.expression === envNode &&
    ts.isStringLiteralLike(parent.argumentExpression)
  ) {
    return parent.argumentExpression.text;
  }
  return null;
}

/**
 * True when `node` is a `process.env` access that COUNTS as a config-bearing
 * read — i.e. any `process.env` member access EXCEPT one whose single accessed
 * property is an exempt env indicator (convention #2). String literals and
 * comments are never this node, so they can't false-fire. Requires parent
 * pointers (createSourceFile setParentNodes=true) to inspect the access target.
 */
function isCountedProcessEnvAccess(node: ts.Node): boolean {
  if (!isProcessEnvMemberAccess(node)) return false;
  const varName = staticallyAccessedVarName(node);
  // null = destructure/alias (whole-object read) → counted. A statically-known
  // name is exempt only if it is an env indicator.
  return varName === null || !isExemptIndicatorName(varName);
}

/**
 * True if the file's AST contains any COUNTED `process.env` access — i.e. a read
 * of a NON-exempt var (exempt env indicators per convention #2 are ignored).
 * Parses with the TypeScript compiler (mirrors response-status-audit /
 * static-policy-audit) so a regex can't miss `const { FOO } = process.env` /
 * `const e = process.env`, and a `"process.env.X"` string literal or comment
 * can't false-fire. Parent pointers are enabled so an access target can be
 * inspected for the exemption. Pure — unit-tested.
 */
export function fileReadsProcessEnv(text: string): boolean {
  const source = ts.createSourceFile(
    'scan.tsx',
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isCountedProcessEnvAccess(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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
