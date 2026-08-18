// scripts/ci/feature-surface-audit.ts
//
// CI-side enforcement of the /feature intake contract's allowed_edit_surface
// — the platform "last line of defense". The PreToolUse hooks
// (edit-surface-guard, bash-write-guard) are in-session guardrails that a
// different editing modality could bypass; this audit re-checks the BRANCH
// DIFF against the COMMITTED intake at merge time, where nothing can route
// around it.
//
// Behavior:
// - Always: every committed intake under docs/superpowers/plans/*-intake.json
//   must spell its allowed_edit_surface entries in the ONE form all three
//   matchers accept (see "Glob semantics"). A pre-escaped bracket spelling
//   fails the audit, on every branch, so the class stays loud repo-wide.
// - Resolves the branch (GITHUB_HEAD_REF in CI PR runs, otherwise
//   `git branch --show-current`) and looks for the committed intake at
//   docs/superpowers/plans/<slug>-intake.json where slug = branch with
//   '/' → '-'. No committed intake → not a /feature-workflow branch → pass.
// - With an intake: every file changed vs the fork point (merge-base with
//   origin/<base branch>) must match allowed_edit_surface, the
//   always-allowed process surfaces (docs/**, CONTEXT.md — mirroring the
//   edit-surface guard's exemptions), or be inside .feature/ (never
//   committed anyway). Violations fail the audit with the file list.
// - With an intake: every non-process allowed_edit_surface entry must match
//   at least one file — tracked at HEAD, or in the branch diff (so a declared
//   deletion still counts). An entry that matches NOTHING is always a mistake
//   (typo, wrong spelling, or a plan the implementation abandoned) and fails
//   the audit (#867). It cannot be a "not written yet" file: the audit runs
//   against a committed tree, and /feature pushes only after implementation.
//   For a WIP push before implementation, `git push --no-verify`.
// - Glob semantics MATCH both edit-surface-guard hooks' bash [[ == ]] rules:
//   `*` crosses `/` (so 'src/worker/*' matches nested paths), `?` is one
//   character, and `[`/`]` are ALWAYS literal — a Next.js dynamic segment is
//   written as the plain path (`src/app/api/u/[token]/route.ts`), never
//   pre-escaped (`\[token\]`, `[[]token[]]`): every matcher escapes brackets
//   itself at match time, so pre-escaping escapes the escape and matches
//   nothing (#867). Character classes are therefore not expressible. Keep
//   the hooks and this audit in lockstep — the hooks own the semantics
//   in-session; this audit is their merge-time mirror, and
//   scripts/ci/__tests__/edit-surface-guard.test.ts pins all three to one
//   table.
//
// CI requirement: the lint job checks out with fetch-depth: 0 so the
// merge-base against the base branch exists. Locally the audit runs as part
// of verify-gate's dynamic ci:* enumeration, validating the committed diff
// (uncommitted edits remain the hooks' job).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const INTAKE_DIR = 'docs/superpowers/plans';

export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (const char of glob) {
    if (char === '*') {
      pattern += '.*';
    } else if (char === '?') {
      pattern += '.';
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

const ALWAYS_ALLOWED = [/^docs\//, /^CONTEXT\.md$/, /^\.feature\//];

/**
 * A surface entry that pre-escapes a bracket for bash — `\[`, `\]`, `[[]`,
 * `[]]` — matches NEITHER hook nor this audit, because all three escape
 * brackets themselves at match time (#867). The plain literal is the one
 * spelling every matcher accepts.
 */
const PRE_ESCAPED_BRACKET = /\\\[|\\\]|\[\[\]|\[\]\]/;

export function findPreEscapedEntries(allowedEditSurface: string[]): string[] {
  return allowedEditSurface.filter((entry) => PRE_ESCAPED_BRACKET.test(entry));
}

/** The plain-literal spelling of a pre-escaped entry, for the failure message. */
export function plainSpellingOf(entry: string): string {
  return entry.replace(/\[\[\]/g, '[').replace(/\[\]\]/g, ']').replace(/\\([[\]])/g, '$1');
}

/** True when the entry lives entirely inside an always-allowed process surface. */
function isProcessEntry(entry: string): boolean {
  const literalPrefix = entry.replace(/[*?].*$/, '');
  return ALWAYS_ALLOWED.some((pattern) => pattern.test(literalPrefix));
}

/**
 * Non-process surface entries that match no file at all — neither tracked at
 * HEAD nor touched by the branch diff. Such an entry can never admit an edit,
 * so it is either a typo/wrong spelling (the surface is silently narrower than
 * declared) or dead weight the implementation abandoned (#867).
 */
export function findUnmatchedEntries(
  allowedEditSurface: string[],
  trackedFiles: string[],
  changedFiles: string[],
): string[] {
  const candidates = [...new Set([...trackedFiles, ...changedFiles])];
  return allowedEditSurface.filter((entry) => {
    if (isProcessEntry(entry)) return false;
    const pattern = globToRegExp(entry);
    return !candidates.some((file) => pattern.test(file));
  });
}

export function auditSurface(
  changedFiles: string[],
  allowedEditSurface: string[],
): string[] {
  const surfacePatterns = allowedEditSurface.map(globToRegExp);
  return changedFiles.filter((file) => {
    if (ALWAYS_ALLOWED.some((pattern) => pattern.test(file))) return false;
    return !surfacePatterns.some((pattern) => pattern.test(file));
  });
}

export function extractSurface(parsed: unknown): string[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const surface = (parsed as Record<string, unknown>)['allowed_edit_surface'];
  if (!Array.isArray(surface)) return [];
  return surface.filter((entry): entry is string => typeof entry === 'string');
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function auditedBranch(headRef: string | undefined, currentBranch: string): string | null {
  const branch = headRef || currentBranch;
  if (!branch || branch === 'main' || branch === 'staging') return null;
  return branch;
}

export function intakePathFor(branch: string): string {
  return `${INTAKE_DIR}/${branch.replace(/\//g, '-')}-intake.json`;
}

function loadSurface(intakePath: string): string[] {
  return extractSurface(JSON.parse(readFileSync(intakePath, 'utf8')) as unknown);
}

function mergeBaseWith(baseRefEnv: string | undefined): string {
  const baseRef = baseRefEnv ? `origin/${baseRefEnv}` : 'origin/main';
  return git('merge-base', 'HEAD', baseRef);
}

/** The violation check's input — git's default rename handling, unchanged since #560. */
function changedFilesVsBase(mergeBase: string): string[] {
  return git('diff', '--name-only', mergeBase, 'HEAD').split('\n').filter(Boolean);
}

/**
 * The unmatched-entry check's input: `--no-renames` so the OLD path of a
 * rename is listed (as a deletion) and a surface entry declaring it still
 * counts as matched. Kept separate so the violation check's semantics do not
 * move.
 */
function touchedFilesVsBase(mergeBase: string): string[] {
  return git('diff', '--name-only', '--no-renames', mergeBase, 'HEAD').split('\n').filter(Boolean);
}

function trackedFilesAtHead(): string[] {
  return git('ls-files').split('\n').filter(Boolean);
}

/** Every committed intake's pre-escaped entries, keyed by intake path. */
export function preEscapedEntriesByIntake(intakeDir: string): Map<string, string[]> {
  const findings = new Map<string, string[]>();
  if (!existsSync(intakeDir)) return findings;
  for (const name of readdirSync(intakeDir).filter((n) => n.endsWith('-intake.json')).sort()) {
    const path = `${intakeDir}/${name}`;
    const bad = findPreEscapedEntries(loadSurface(path));
    if (bad.length > 0) findings.set(path, bad);
  }
  return findings;
}

function fail(lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function reportPreEscaped(findings: Map<string, string[]>): never {
  const lines = [
    `feature-surface-audit: FAILED — ${findings.size} intake(s) pre-escape a bracket in allowed_edit_surface:`,
  ];
  for (const [path, entries] of findings) {
    lines.push(`  ${path}`);
    for (const entry of entries) lines.push(`    - ${entry}   → write: ${plainSpellingOf(entry)}`);
  }
  lines.push(
    'Brackets are ALWAYS literal in a surface glob: the hooks and this audit escape them themselves,',
    'so a pre-escaped spelling matches nothing. Write the plain Next.js path (#867).',
  );
  return fail(lines);
}

function reportUnmatched(intakePath: string, unmatched: string[]): never {
  return fail([
    `feature-surface-audit: FAILED — ${unmatched.length} allowed_edit_surface entr(y/ies) in '${intakePath}' match NO file (tracked at HEAD or changed on this branch):`,
    ...unmatched.map((entry) => `  - ${entry}`),
    'An entry that matches nothing cannot admit an edit — fix its spelling, or remove it if the plan no longer',
    'touches that path (narrowing is an auto-approved amendment; update BOTH intake copies). WIP push before',
    'implementation? `git push --no-verify` (#867).',
  ]);
}

function reportViolations(intakePath: string, violations: string[]): never {
  return fail([
    `feature-surface-audit: FAILED — ${violations.length} changed file(s) outside '${intakePath}' allowed_edit_surface:`,
    ...violations.map((file) => `  - ${file}`),
    'Either the change is scope drift (revert it), or the surface was declared too narrowly (amend the intake WITH sign-off and commit both copies).',
  ]);
}

function main(): void {
  const preEscaped = preEscapedEntriesByIntake(INTAKE_DIR);
  if (preEscaped.size > 0) reportPreEscaped(preEscaped);

  const branch = auditedBranch(process.env.GITHUB_HEAD_REF, git('branch', '--show-current'));
  if (!branch) {
    console.log('feature-surface-audit: long-lived or detached ref — intake spellings clean, passing.');
    return;
  }
  const intakePath = intakePathFor(branch);
  if (!existsSync(intakePath)) {
    console.log(
      `feature-surface-audit: no committed intake for '${branch}' — not a /feature branch, passing.`,
    );
    return;
  }
  const surface = loadSurface(intakePath);
  const mergeBase = mergeBaseWith(process.env.GITHUB_BASE_REF);
  const changedFiles = changedFilesVsBase(mergeBase);
  const violations = auditSurface(changedFiles, surface);
  if (violations.length > 0) reportViolations(intakePath, violations);
  const unmatched = findUnmatchedEntries(surface, trackedFilesAtHead(), touchedFilesVsBase(mergeBase));
  if (unmatched.length > 0) reportUnmatched(intakePath, unmatched);
  console.log(
    `feature-surface-audit: passed (${changedFiles.length} changed file(s) within the declared surface; every surface entry matches a file).`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
