import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Lives here rather than beside the hooks for the reason edit-surface-guard.test.ts
// states: vitest's include roots are scripts/ci/**, src/**, worker/**, tests/**,
// e2e/** — a test under .claude/ or .codex/ would silently never run.
//
// ONE table, TWO guards. The Claude hook and its Codex port carried the same
// defective `sed` rule, and fixing one would have left the other stale — the
// exact two-copies trap the arch-review log has already recorded twice.
//
// The contract pinned here: `-i` is the in-place flag ONLY as an option token.
// The previous rule was `sed[[:space:]][^;&|]*-i`, which matched `-i` anywhere
// after `sed `, so a read-only `sed -n '/foo-i/p' FILE` — hyphen-i inside a
// SEARCH PATTERN — was blocked as a write. That false positive cost a
// plan-review round in #1008. Its deviation D9 blamed the guard for not
// distinguishing `-n … p` from `-i`; that diagnosis was wrong, and the reads
// below are what disprove it.
const ROOT = resolve(process.cwd());
const GUARDS = [
  ['claude', join(ROOT, '.claude', 'hooks', 'bash-write-guard.sh')],
  ['codex', join(ROOT, '.codex', 'hooks', 'bash-write-guard.sh')],
] as const;

let repo: string;

// git EXPORTS its repo-locating variables into hook processes, and from a linked
// worktree GIT_DIR is set for the pre-push hook. Inherited through
// lefthook → vitest → spawnSync they retarget every git call at the CALLER's
// repo instead of the throwaway one — passes by hand, fails only under
// `git push` from a worktree. Scrub them.
const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

beforeAll(() => {
  // realpath: on macOS $TMPDIR is symlinked, and `git rev-parse --show-toplevel`
  // returns the RESOLVED path.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'bash-write-guard-')));
  spawnSync('git', ['init', '-q'], { cwd: repo, env: GIT_FREE_ENV });
  mkdirSync(join(repo, '.feature'), { recursive: true });
  mkdirSync(join(repo, 'src', 'lib'), { recursive: true });
  mkdirSync(join(repo, '.claude'), { recursive: true });
  // The guard arms on the presence of an intake, not on its contents.
  writeFileSync(join(repo, '.feature', 'intake.json'), JSON.stringify({ allowed_edit_surface: [] }));
  writeFileSync(join(repo, '.claude', 'CLAUDE.md'), '# stub\n');
  writeFileSync(join(repo, 'src', 'lib', 'x.ts'), 'export const x = 1;\n');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Exit 0 = allowed, 2 = BLOCKED. */
function guardExitFor(guard: string, command: string): number {
  const payload = JSON.stringify({ tool_input: { command }, cwd: repo });
  const result = spawnSync('bash', [guard], {
    cwd: repo,
    input: payload,
    encoding: 'utf8',
    env: { ...GIT_FREE_ENV, WORKTREE_EDIT_GUARD_DISABLE: '1' },
  });
  return result.status ?? -1;
}

describe.each(GUARDS)('%s bash-write-guard — sed in-place detection', (_name, guard) => {
  it('allows a read-only sed -n page range against repo source', () => {
    expect(guardExitFor(guard, "sed -n '1,260p' .claude/CLAUDE.md")).toBe(0);
  });

  it('allows a read whose SEARCH PATTERN contains -i (the #1008 false positive)', () => {
    // The pre-fix rule blocked this: `-i` inside '/refusal-in/' read as the flag.
    expect(guardExitFor(guard, "sed -n '/refusal-in/p' .claude/CLAUDE.md")).toBe(0);
    expect(guardExitFor(guard, "sed -n '/in-place/p' src/lib/x.ts")).toBe(0);
  });

  it('allows a read whose FILENAME contains -i', () => {
    expect(guardExitFor(guard, "sed -E -n '/x/p' src/lib/file-i.ts")).toBe(0);
  });

  it('does not arm on an unrelated -i belonging to another command', () => {
    expect(guardExitFor(guard, "grep -i foo src/lib/x.ts && sed -n '1p' src/lib/x.ts")).toBe(0);
  });

  it('still blocks sed -i against repo source', () => {
    expect(guardExitFor(guard, "sed -i 's/a/b/' src/lib/x.ts")).toBe(2);
  });

  it('still blocks every in-place spelling', () => {
    expect(guardExitFor(guard, "sed -i.bak 's/a/b/' src/lib/x.ts")).toBe(2);
    expect(guardExitFor(guard, "sed --in-place 's/a/b/' src/lib/x.ts")).toBe(2);
    expect(guardExitFor(guard, "sed --in-place=.bak 's/a/b/' src/lib/x.ts")).toBe(2);
    expect(guardExitFor(guard, "sed -Ei 's/a/b/' src/lib/x.ts")).toBe(2);
    expect(guardExitFor(guard, "sed -n -i 's/a/b/' src/lib/x.ts")).toBe(2);
  });

  it('blocks an in-place write in a SECOND sed on the same line', () => {
    // Scanning resets at each separator. A rule that stopped at the first
    // non-option token would return "allow" here and wave the write through.
    expect(guardExitFor(guard, "sed -n '1p' src/lib/x.ts; sed -i 's/a/b/' src/lib/x.ts")).toBe(2);
    expect(
      guardExitFor(guard, "sed -n '1p' src/lib/x.ts && sed --in-place 's/a/b/' src/lib/x.ts"),
    ).toBe(2);
  });
});
