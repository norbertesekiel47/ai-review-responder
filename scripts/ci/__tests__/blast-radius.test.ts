// Subprocess tests for scripts/blast-radius.sh (#888): the git plumbing must
// feed the matcher BOTH paths of a rename (the two -z formats order the pair
// differently), keep deletions and spaced paths intact, and never leave a
// partial or stale-looking report when the matcher fails. Each test runs the
// real script against a throwaway git repository, with the matcher swapped
// for a stdin-capturing fake via BLAST_RADIUS_MATCHER_CMD.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../blast-radius.sh');

let repo: string;
let captureFile: string;
let fakeMatcher: string;

// git EXPORTS its repo-locating variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
// …) into hook processes, and from a linked worktree GIT_DIR is set for the
// pre-push hook. Inherited by this suite (lefthook → vitest --changed → spawnSync)
// they retarget every `git` call below at the CALLER's repo: on 2026-09-05 the
// `git init` + `config` + `commit 'base'` sequence below re-initialised a
// worktree's gitdir, wrote `core.bare=true` and the fake identity into the
// SHARED .git/config, and stacked eight "base" commits on the pushing branch.
// Same scrub as edit-surface-guard.test.ts and feature-state-amendments.test.ts.
const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

function git(...args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function write(repoPath: string, content: string): void {
  const full = join(repo, repoPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function runScript(env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...GIT_FREE_ENV, BLAST_RADIUS_MATCHER_CMD: fakeMatcher, ...env },
  });
}

function capturedPaths(): string[] {
  return readFileSync(captureFile, 'utf8').split('\n').filter(Boolean);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'blast-radius-repo-'));
  captureFile = join(repo, 'captured-matcher-stdin.txt');

  // The fake matcher records its NUL-separated stdin as lines and emits a
  // fixed report, so tests can assert exactly what the plumbing produced.
  fakeMatcher = join(repo, 'fake-matcher.sh');
  writeFileSync(
    fakeMatcher,
    `#!/usr/bin/env bash\ntr '\\0' '\\n' > "${captureFile}"\necho "FAKE REPORT"\n`,
  );
  chmodSync(fakeMatcher, 0o755);

  git('init', '-q', '-b', 'feat-test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('src/lib/target.ts', 'export const x = 1;\n');
  write('src/lib/consumer.ts', "import { x } from './target';\nexport const y = x;\n");
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  // The script diffs against origin/main; point it at the base commit.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('blast-radius.sh plumbing', () => {
  it('feeds BOTH paths of a staged rename to the matcher', () => {
    git('mv', 'src/lib/target.ts', 'src/lib/renamed.ts');
    const result = runScript();
    expect(result.status).toBe(0);
    const paths = capturedPaths();
    expect(paths).toContain('src/lib/target.ts');
    expect(paths).toContain('src/lib/renamed.ts');
  });

  it('feeds both halves of an unstaged delete-plus-untracked-add', () => {
    rmSync(join(repo, 'src/lib/target.ts'));
    write('src/lib/rehomed.ts', 'export const x = 1;\n');
    const result = runScript();
    expect(result.status).toBe(0);
    const paths = capturedPaths();
    expect(paths).toContain('src/lib/target.ts');
    expect(paths).toContain('src/lib/rehomed.ts');
  });

  it('keeps a deleted file in the changed set', () => {
    rmSync(join(repo, 'src/lib/target.ts'));
    const result = runScript();
    expect(result.status).toBe(0);
    expect(capturedPaths()).toContain('src/lib/target.ts');
  });

  it('passes paths with spaces through intact', () => {
    write('src/lib/my mod.ts', 'export const x = 1;\n');
    const result = runScript();
    expect(result.status).toBe(0);
    expect(capturedPaths()).toContain('src/lib/my mod.ts');
  });

  it('excludes tests, non-source trees, and non-ts files', () => {
    write('src/lib/__tests__/target.test.ts', 'export {};\n');
    write('docs/notes.ts', 'export {};\n');
    write('src/lib/data.json', '{}\n');
    write('src/lib/fresh.ts', 'export const x = 1;\n');
    const result = runScript();
    expect(result.status).toBe(0);
    const paths = capturedPaths();
    expect(paths).toEqual(['src/lib/fresh.ts']);
  });

  it('writes the report and prints the wrote line on success', () => {
    write('src/lib/fresh.ts', 'export const x = 1;\n');
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('wrote docs/reviews/feat-test/blast-radius.md');
    expect(readFileSync(join(repo, 'docs/reviews/feat-test/blast-radius.md'), 'utf8')).toContain(
      'FAKE REPORT',
    );
  });

  it('on matcher failure: exits non-zero, prints no wrote line, preserves the previous report, leaves no temp file', () => {
    const outDir = join(repo, 'docs/reviews/feat-test');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'blast-radius.md'), 'PREVIOUS REPORT\n');
    write('src/lib/fresh.ts', 'export const x = 1;\n');

    const result = runScript({ BLAST_RADIUS_MATCHER_CMD: 'false' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('wrote');
    expect(result.stderr).toContain('matcher failed');
    expect(readFileSync(join(outDir, 'blast-radius.md'), 'utf8')).toBe('PREVIOUS REPORT\n');
    expect(readdirSync(outDir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('refuses to run on a detached HEAD', () => {
    git('checkout', '-q', '--detach');
    const result = runScript();
    expect(result.status).not.toBe(0);
    expect(existsSync(join(repo, 'docs/reviews'))).toBe(false);
  });
});
