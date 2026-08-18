import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Lives here, not beside the hooks, for the same reason gate-rows.test.ts does:
// vitest's include roots are scripts/ci/**, src/**, worker/**, tests/**, e2e/**
// — a test under .claude/ or .codex/ would silently never run.
//
// ONE table, THREE matchers. The Claude guard, its Codex port, and
// scripts/ci/feature-surface-audit.ts (see feature-surface-audit.test.ts) all
// claim the same glob semantics for allowed_edit_surface. Both bash guards
// match with `[[ "$path" == $GLOB ]]`, which reads `[id]` as a CHARACTER
// CLASS matching one char ('i' or 'd') unless the brackets are escaped first.
// The Claude guard gained that escape in #828; the Codex port did not, so
// until #867 no single spelling of a Next.js dynamic segment satisfied all
// three matchers — the plain `[id]` matched Claude + audit but not Codex, and
// the pre-escaped `\[id\]` / `[[]id[]]` matched Codex only. Intakes grew both
// spellings side by side (#729, #730 lab-notes prescribed exactly that).
//
// The contract pinned here: brackets are ALWAYS literal, the plain path is the
// ONLY spelling, and a pre-escaped entry matches nothing anywhere.

const ROOT = resolve(process.cwd());
const GUARDS = [
  ['claude', join(ROOT, '.claude', 'hooks', 'edit-surface-guard.sh')],
  ['codex', join(ROOT, '.codex', 'hooks', 'edit-surface-guard.sh')],
] as const;

let repo: string;

// git EXPORTS its repo-locating variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
// …) into hook processes — and from a linked worktree GIT_DIR is set for the
// pre-push hook. Inherited by this suite (lefthook → vitest → spawnSync), they
// retarget every `git` call below at the CALLER's repo instead of the throwaway
// one: `git init` re-inits the caller, `rev-parse --show-toplevel` answers with
// the spawn cwd, and the two `.feature/intake.json` cases block. Passes when
// run by hand, fails only under `git push` from a worktree — scrub them.
const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

/** A throwaway git repo with an armed intake, so the guards resolve a target root. */
beforeAll(() => {
  // realpath: on macOS $TMPDIR is /var/folders/... symlinked to /private/var/...,
  // and `git rev-parse --show-toplevel` returns the RESOLVED path. Without this
  // the guard's prefix strip fails, REL_PATH stays absolute, and every case
  // blocks — a test-environment artifact that looks exactly like a guard bug.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'edit-surface-guard-')));
  spawnSync('git', ['init', '-q'], { cwd: repo, env: GIT_FREE_ENV });
  mkdirSync(join(repo, '.feature'), { recursive: true });
  writeFileSync(
    join(repo, '.feature', 'intake.json'),
    JSON.stringify({
      allowed_edit_surface: [
        'src/app/admin/businesses/[id]/page.tsx',
        'src/app/admin/businesses/[id]/__tests__/**',
        'src/lib/competitors/named-rival.ts',
        'src/components/dashboard/shell/__tests__/**',
        // Pre-escaped spellings ONLY (no plain '[token]' entry): they must be
        // inert in every matcher, so the real path stays BLOCKED.
        'src/app/api/u/\\[token\\]/route.ts',
        'src/app/api/u/[[]token[]]/route.ts',
      ],
    }),
  );
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Exit 0 = allowed, 2 = BLOCKED. */
function guardExitFor(guard: string, relPath: string): number {
  const payload = JSON.stringify({ tool_input: { file_path: join(repo, relPath) }, cwd: repo });
  const result = spawnSync('bash', [guard], {
    cwd: repo,
    input: payload,
    encoding: 'utf8',
    env: { ...GIT_FREE_ENV, WORKTREE_EDIT_GUARD_DISABLE: '1' },
  });
  return result.status ?? -1;
}

describe.each(GUARDS)('%s edit-surface-guard dynamic route segments', (_name, guard) => {
  it('allows a declared path containing a [id] dynamic segment', () => {
    expect(guardExitFor(guard, 'src/app/admin/businesses/[id]/page.tsx')).toBe(0);
  });

  it('allows a declared ** subtree under a [id] dynamic segment', () => {
    expect(
      guardExitFor(guard, 'src/app/admin/businesses/[id]/__tests__/page-source.test.ts'),
    ).toBe(0);
  });

  it('does not treat [id] as a character class matching a single char', () => {
    // The pre-fix bug matched this and NOT the real '[id]' directory above.
    expect(guardExitFor(guard, 'src/app/admin/businesses/i/page.tsx')).toBe(2);
  });

  it('treats a pre-escaped bracket spelling as inert — the plain path stays blocked (#867)', () => {
    // '\[token\]' and '[[]token[]]' are declared; the real path is not. Under
    // the raw-glob Codex port these matched (bash un-escaped them), which is
    // how the pre-escaped duplicates got into intakes in the first place.
    expect(guardExitFor(guard, 'src/app/api/u/[token]/route.ts')).toBe(2);
  });

  it('still blocks an undeclared path', () => {
    expect(guardExitFor(guard, 'src/lib/config/server.ts')).toBe(2);
  });

  it('still honours ordinary literal and ** globs', () => {
    expect(guardExitFor(guard, 'src/lib/competitors/named-rival.ts')).toBe(0);
    expect(
      guardExitFor(guard, 'src/components/dashboard/shell/__tests__/Sidebar.test.tsx'),
    ).toBe(0);
  });

  it('still exempts docs/ and .feature/ regardless of surface', () => {
    expect(guardExitFor(guard, 'docs/anything.md')).toBe(0);
    expect(guardExitFor(guard, '.feature/intake.json')).toBe(0);
  });
});
