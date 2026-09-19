import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Pins the ALWAYS-ON half of both edit-surface guards — the containment rule
// that fires with no `/feature` arming at all: a session whose cwd is a
// worktree may not edit a different checkout, because that edit silently
// lands in the other tree (CLAUDE.md worktree rules).
//
// #1338: both copies decided "am I in a worktree?" with a path pattern
// (`*-worktrees/*`, `*/.claude/worktrees/*`, `*/.worktrees/*`), so a real
// linked worktree at any other path ran UNGUARDED. An Orca workspace at
// ~/orca/workspaces/<repo>/<slug> is exactly that. The fixture worktree below
// is therefore deliberately named to match NONE of the three patterns; the
// legacy-path worktree beside it proves the old layouts did not regress.
//
// Both guards are exercised through their real stdin contract — Claude sends
// `tool_input.file_path`, Codex sends an `apply_patch` envelope it parses —
// so a fix that only lands in one copy fails here.

const CLAUDE_GUARD = resolve(process.cwd(), '.claude/hooks/edit-surface-guard.sh');
const CODEX_GUARD = resolve(process.cwd(), '.codex/hooks/edit-surface-guard.sh');

const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

let root: string;
let primary: string;
/** A linked worktree whose path matches none of the retired patterns. */
let orcaWorktree: string;
/** A linked worktree on the blessed sibling layout, as a no-regression control. */
let legacyWorktree: string;

function git(args: string[], cwd = primary): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_FREE_ENV });
  expect(result.status, result.stderr).toBe(0);
}

interface Attempt {
  readonly cwd: string;
  readonly target: string;
  /** Extra variables layered over the git-free env; the repo's ProcessEnv type demands NODE_ENV, which a spread supplies. */
  readonly env?: Record<string, string>;
}

function runClaude({ cwd, target, env }: Attempt): number {
  const result = spawnSync('bash', [CLAUDE_GUARD], {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_FREE_ENV, ...env },
    input: JSON.stringify({ session_id: 'fixture-session', tool_input: { file_path: target } }),
  });
  return result.status ?? -1;
}

function runCodex({ cwd, target, env }: Attempt): number {
  const command = `*** Begin Patch\n*** Update File: ${target}\n*** End Patch\n`;
  const result = spawnSync('bash', [CODEX_GUARD], {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_FREE_ENV, ...env },
    input: JSON.stringify({
      session_id: 'fixture-session',
      cwd,
      tool_name: 'apply_patch',
      tool_input: { command },
    }),
  });
  return result.status ?? -1;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edit-guard-'));
  primary = join(root, 'fixture-repo');
  mkdirSync(join(primary, '.claude', 'hooks'), { recursive: true });
  mkdirSync(join(primary, '.codex', 'hooks'), { recursive: true });
  cpSync(CLAUDE_GUARD, join(primary, '.claude', 'hooks', 'edit-surface-guard.sh'));
  cpSync(CODEX_GUARD, join(primary, '.codex', 'hooks', 'edit-surface-guard.sh'));
  writeFileSync(join(primary, 'README.md'), 'fixture\n');
  git(['init', '-b', 'main']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'fixture', '--no-gpg-sign']);

  // Matches no retired pattern — the #1338 layout.
  orcaWorktree = join(root, 'orca', 'workspaces', 'fixture-repo', 'some-task');
  git(['worktree', 'add', '-q', '-b', 'task', orcaWorktree]);

  // The blessed sibling layout, which the retired pattern did match.
  legacyWorktree = join(root, 'fixture-repo-worktrees', 'legacy');
  git(['worktree', 'add', '-q', '-b', 'legacy', legacyWorktree]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('edit-surface guard — worktree containment is structural, not path-shaped (#1338)', () => {
  it('blocks a cross-checkout edit from a worktree whose path matches no naming convention', () => {
    const target = join(primary, 'README.md');
    expect(runClaude({ cwd: orcaWorktree, target })).toBe(2);
    expect(runCodex({ cwd: orcaWorktree, target })).toBe(2);
  });

  it('still blocks a cross-checkout edit from the sibling -worktrees layout', () => {
    const target = join(primary, 'README.md');
    expect(runClaude({ cwd: legacyWorktree, target })).toBe(2);
    expect(runCodex({ cwd: legacyWorktree, target })).toBe(2);
  });

  it('blocks an edit that targets a DIFFERENT worktree, not only the primary checkout', () => {
    const target = join(legacyWorktree, 'README.md');
    expect(runClaude({ cwd: orcaWorktree, target })).toBe(2);
    expect(runCodex({ cwd: orcaWorktree, target })).toBe(2);
  });

  it('allows editing a worktree from the primary checkout, which is the blessed direction', () => {
    const target = join(orcaWorktree, 'README.md');
    expect(runClaude({ cwd: primary, target })).toBe(0);
    expect(runCodex({ cwd: primary, target })).toBe(0);
  });

  it('allows an edit that stays inside the session worktree', () => {
    const target = join(orcaWorktree, 'README.md');
    expect(runClaude({ cwd: orcaWorktree, target })).toBe(0);
    expect(runCodex({ cwd: orcaWorktree, target })).toBe(0);
  });

  it('honours WORKTREE_EDIT_GUARD_DISABLE=1 as the documented escape hatch', () => {
    const target = join(primary, 'README.md');
    const env = { WORKTREE_EDIT_GUARD_DISABLE: '1' };
    expect(runClaude({ cwd: orcaWorktree, target, env })).toBe(0);
    expect(runCodex({ cwd: orcaWorktree, target, env })).toBe(0);
  });
});
