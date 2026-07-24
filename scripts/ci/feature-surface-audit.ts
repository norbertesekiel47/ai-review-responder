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
// - Resolves the branch (GITHUB_HEAD_REF in CI PR runs, otherwise
//   `git branch --show-current`) and looks for the committed intake at
//   docs/superpowers/plans/<slug>-intake.json where slug = branch with
//   '/' → '-'. No committed intake → not a /feature-workflow branch → pass.
// - With an intake: every file changed vs the fork point (merge-base with
//   origin/<base branch>) must match allowed_edit_surface, the
//   always-allowed process surfaces (docs/**, CONTEXT.md — mirroring the
//   edit-surface guard's exemptions), or be inside .feature/ (never
//   committed anyway). Violations fail the audit with the file list.
// - Glob semantics MATCH the edit-surface-guard hook's bash [[ == ]] rules:
//   `*` crosses `/` (so 'src/worker/*' matches nested paths) and `?` is one
//   character; character classes are NOT supported (no intake uses them).
//   Keep the hook and this audit in lockstep — the hook owns the semantics
//   in-session; this audit is its merge-time mirror.
//
// CI requirement: the lint job checks out with fetch-depth: 0 so the
// merge-base against the base branch exists. Locally the audit runs as part
// of verify-gate's dynamic ci:* enumeration, validating the committed diff
// (uncommitted edits remain the hooks' job).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export function auditedBranch(headRef: string | undefined, currentBranch: string): string | null {
  const branch = headRef || currentBranch;
  if (!branch || branch === 'main' || branch === 'staging') return null;
  return branch;
}

export function intakePathFor(branch: string): string {
  return `docs/superpowers/plans/${branch.replace(/\//g, '-')}-intake.json`;
}

function loadSurface(intakePath: string): string[] {
  return extractSurface(JSON.parse(readFileSync(intakePath, 'utf8')) as unknown);
}

function changedFilesVsBase(baseRefEnv: string | undefined): string[] {
  const baseRef = baseRefEnv ? `origin/${baseRefEnv}` : 'origin/main';
  const mergeBase = git('merge-base', 'HEAD', baseRef);
  return git('diff', '--name-only', mergeBase, 'HEAD').split('\n').filter(Boolean);
}

function reportViolations(intakePath: string, violations: string[]): never {
  console.error(
    `feature-surface-audit: FAILED — ${violations.length} changed file(s) outside '${intakePath}' allowed_edit_surface:`,
  );
  for (const file of violations) console.error(`  - ${file}`);
  console.error(
    'Either the change is scope drift (revert it), or the surface was declared too narrowly (amend the intake WITH sign-off and commit both copies).',
  );
  process.exit(1);
}

function main(): void {
  const branch = auditedBranch(process.env.GITHUB_HEAD_REF, git('branch', '--show-current'));
  if (!branch) {
    console.log('feature-surface-audit: long-lived or detached ref — passing.');
    return;
  }
  const intakePath = intakePathFor(branch);
  if (!existsSync(intakePath)) {
    console.log(
      `feature-surface-audit: no committed intake for '${branch}' — not a /feature branch, passing.`,
    );
    return;
  }
  const changedFiles = changedFilesVsBase(process.env.GITHUB_BASE_REF);
  const violations = auditSurface(changedFiles, loadSurface(intakePath));
  if (violations.length > 0) reportViolations(intakePath, violations);
  console.log(
    `feature-surface-audit: passed (${changedFiles.length} changed file(s) within the declared surface).`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
