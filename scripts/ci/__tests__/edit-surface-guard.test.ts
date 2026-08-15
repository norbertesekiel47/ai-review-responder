import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Lives here, not beside the hook, for the same reason gate-rows.test.ts does:
// vitest's include roots are scripts/ci/**, src/**, worker/**, tests/**, e2e/**
// — a test under .claude/ would silently never run.
//
// The guard matched declared surfaces with bash `[[ "$path" == $GLOB ]]`, which
// reads `[id]` in a glob as a CHARACTER CLASS matching one char ('i' or 'd').
// Every Next.js dynamic route segment was therefore unmatchable and the guard
// blocked writes to paths the intake explicitly listed — [id], [reviewId],
// [token], [responseId], [sessionId], [offboardingId], [escalationId],
// [businessId].
//
// feature-surface-audit.ts is the merge-time mirror of this hook and already
// escaped brackets correctly, so the two were out of lockstep despite that
// file's header claiming they match. These cases pin the bash side to the
// semantics the audit already implements.

const ROOT = resolve(process.cwd());
const GUARD = join(ROOT, '.claude', 'hooks', 'edit-surface-guard.sh');

let repo: string;

/** A throwaway git repo with an armed intake, so the guard resolves a target root. */
beforeAll(() => {
  // realpath: on macOS $TMPDIR is /var/folders/... symlinked to /private/var/...,
  // and `git rev-parse --show-toplevel` returns the RESOLVED path. Without this
  // the guard's prefix strip fails, REL_PATH stays absolute, and every case
  // blocks — a test-environment artifact that looks exactly like a guard bug.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'edit-surface-guard-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.feature'), { recursive: true });
  writeFileSync(
    join(repo, '.feature', 'intake.json'),
    JSON.stringify({
      allowed_edit_surface: [
        'src/app/admin/businesses/[id]/page.tsx',
        'src/app/admin/businesses/[id]/__tests__/**',
        'src/lib/competitors/named-rival.ts',
        'src/components/dashboard/shell/__tests__/**',
      ],
    }),
  );
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Exit 0 = allowed, 2 = BLOCKED. */
function guardExitFor(relPath: string): number {
  const payload = JSON.stringify({ tool_input: { file_path: join(repo, relPath) } });
  const result = spawnSync('bash', [GUARD], {
    cwd: repo,
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, WORKTREE_EDIT_GUARD_DISABLE: '1' },
  });
  return result.status ?? -1;
}

describe('edit-surface-guard dynamic route segments', () => {
  it('allows a declared path containing a [id] dynamic segment', () => {
    expect(guardExitFor('src/app/admin/businesses/[id]/page.tsx')).toBe(0);
  });

  it('allows a declared ** subtree under a [id] dynamic segment', () => {
    expect(guardExitFor('src/app/admin/businesses/[id]/__tests__/page-source.test.ts')).toBe(0);
  });

  it('does not treat [id] as a character class matching a single char', () => {
    // The pre-fix bug matched this and NOT the real '[id]' directory above.
    expect(guardExitFor('src/app/admin/businesses/i/page.tsx')).toBe(2);
  });

  it('still blocks an undeclared path', () => {
    expect(guardExitFor('src/lib/config/server.ts')).toBe(2);
  });

  it('still honours ordinary literal and ** globs', () => {
    expect(guardExitFor('src/lib/competitors/named-rival.ts')).toBe(0);
    expect(guardExitFor('src/components/dashboard/shell/__tests__/Sidebar.test.tsx')).toBe(0);
  });

  it('still exempts docs/ and .feature/ regardless of surface', () => {
    expect(guardExitFor('docs/anything.md')).toBe(0);
    expect(guardExitFor('.feature/intake.json')).toBe(0);
  });
});
