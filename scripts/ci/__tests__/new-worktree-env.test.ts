import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Pins the security-sensitive halves of scripts/new-worktree.sh: by DEFAULT
// every .env*.local is copied into the new worktree (the trustworthy-local-CI
// flow depends on it), and SKIP_ENV_COPY=1 copies NOTHING — the /queue-run
// controller relies on that to keep staging/provider credentials out of
// executor worktrees, generating a minimal env before install instead.
//
// The script derives REPO_ROOT from its own location, so the fixture repo
// carries a copy of the script at <repo>/scripts/new-worktree.sh and
// worktrees land at the sibling <repo>-worktrees/ dir inside the temp root.

const SCRIPT = resolve(process.cwd(), 'scripts/new-worktree.sh');

const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

let root: string;
let repo: string;

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_FREE_ENV });
  expect(result.status).toBe(0);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worktree-env-'));
  repo = join(root, 'fixture-repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(repo, 'scripts', 'new-worktree.sh'));
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  writeFileSync(join(repo, '.gitignore'), '.env*.local\n');
  writeFileSync(join(repo, '.env.local'), 'SECRET=real-provider-key\n');
  writeFileSync(join(repo, '.env.staging.local'), 'STAGING=creds\n');
  git(['init', '-b', 'main']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md', '.gitignore', 'scripts/new-worktree.sh']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'fixture', '--no-gpg-sign']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runScript(branch: string, extraEnv: Record<string, string>) {
  return spawnSync('bash', [join(repo, 'scripts', 'new-worktree.sh'), branch], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...GIT_FREE_ENV, SKIP_INSTALL: '1', ...extraEnv },
  });
}

const worktreePath = (slug: string) => join(root, 'fixture-repo-worktrees', slug);

describe('new-worktree.sh env handling', () => {
  it('copies every .env*.local by default (SKIP_INSTALL only skips install)', () => {
    const result = runScript('feat-default', {});
    expect(result.status).toBe(0);
    expect(existsSync(join(worktreePath('feat-default'), '.env.local'))).toBe(true);
    expect(existsSync(join(worktreePath('feat-default'), '.env.staging.local'))).toBe(true);
  });

  it('copies nothing with SKIP_ENV_COPY=1', () => {
    const result = runScript('feat-scrubbed', { SKIP_ENV_COPY: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SKIP_ENV_COPY=1');
    expect(existsSync(worktreePath('feat-scrubbed'))).toBe(true);
    expect(existsSync(join(worktreePath('feat-scrubbed'), '.env.local'))).toBe(false);
    expect(existsSync(join(worktreePath('feat-scrubbed'), '.env.staging.local'))).toBe(false);
  });
});
