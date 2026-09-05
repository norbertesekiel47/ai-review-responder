import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd());
const cleanEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), NODE_ENV: 'test' as const };
let root: string;

function run(command: string, args: string[], input?: string) {
  return spawnSync(command, args, {
    cwd: root, encoding: 'utf8', input,
    env: { ...cleanEnv, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TMPDIR: root },
  });
}

function write(path: string, contents: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function hook(name: string, payload: Record<string, unknown> = {}) {
  return run('bash', [join(sourceRoot, '.codex/hooks', name)], JSON.stringify({ cwd: root, ...payload }));
}

function patch(command: string) {
  return { tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n${command}\n*** End Patch` } };
}

function fingerprint(action: string) {
  return run('node', ['.agents/skills/feature/scripts/gate-fingerprint.mjs', action]);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-hook-enforcement-')));
  expect(run('git', ['init', '-q']).status).toBe(0);
  write('.gitignore', '.feature/\nbin/\nchecks.log\n');
  write('src/allowed.ts', 'export const value = 1;\n');
  write('.feature/intake.json', JSON.stringify({ allowed_edit_surface: ['src/allowed.ts'] }));
  write('.claude/reference/migrations-log.md', 'Current head: **001**\n');
  write('package.json', JSON.stringify({ scripts: { typecheck: 'fixture' } }));
  const relative = '.agents/skills/feature/scripts/gate-fingerprint.mjs';
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  copyFileSync(join(sourceRoot, relative), join(root, relative));
  expect(run('git', ['add', '.']).status).toBe(0);
  expect(run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture']).status).toBe(0);
  write('.feature/gate-status.json', JSON.stringify({ passed: true, timestamp: Math.floor(Date.now() / 1000) + 2, checks: [] }));
  expect(fingerprint('write').status).toBe(0);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Codex patch path enforcement', () => {
  it('checks a rename destination as well as the allowed source', () => {
    const result = hook('edit-surface-guard.sh', patch('*** Update File: src/allowed.ts\n*** Move to: src/forbidden.ts\n@@\n-old\n+new'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('src/forbidden.ts');
  });

  it('normalizes traversal before applying the docs exemption', () => {
    expect(hook('edit-surface-guard.sh', patch('*** Add File: docs/../src/forbidden.ts\n+new')).status).toBe(2);
  });

  it('resolves directory symlinks before applying the docs exemption', () => {
    mkdirSync(join(root, 'docs'));
    symlinkSync('../src', join(root, 'docs/source'));
    expect(hook('edit-surface-guard.sh', patch('*** Add File: docs/source/forbidden.ts\n+new')).status).toBe(2);
  });

  it('accepts a normalized path inside the declared surface', () => {
    expect(hook('edit-surface-guard.sh', patch('*** Update File: src/../src/allowed.ts\n@@\n-old\n+new')).status).toBe(0);
  });

  it('checks an applied migration used as a rename destination', () => {
    expect(hook('migration-immutability-guard.sh', patch('*** Update File: supabase/migrations/002_new.sql\n*** Move to: supabase/migrations/001_old.sql\n@@\n-old\n+new')).status).toBe(2);
  });

  it('normalizes a migration path before recognizing its directory', () => {
    expect(hook('migration-immutability-guard.sh', patch('*** Update File: supabase/other/../migrations/001_old.sql\n@@\n-old\n+new')).status).toBe(2);
  });
});

describe('Codex stop evidence', () => {
  it('allows an unchanged green fingerprint', () => {
    expect(hook('stop-gate.sh').status).toBe(0);
  });

  it('rejects uncommitted changes after a green gate', () => {
    write('src/allowed.ts', 'export const value = 2;\n');
    expect(fingerprint('check').status).toBe(1);
    expect(hook('stop-gate.sh').status).toBe(2);
  });

  it('rejects missing fingerprint evidence', () => {
    rmSync(join(root, '.feature/codex-gate-fingerprint.json'));
    expect(hook('stop-gate.sh').status).toBe(2);
  });

  it('checks the repository when the hook cwd is a subdirectory', () => {
    write('src/allowed.ts', 'export const value = 2;\n');
    expect(hook('stop-gate.sh', { cwd: join(root, 'src') }).status).toBe(2);
  });

  it('reruns typecheck when an untracked file changes after a green run', () => {
    write('bin/pnpm', '#!/bin/bash\nif [ "$1" = typecheck ]; then\n  echo checked >> checks.log\n  if grep -q INVALID src/new.ts; then echo "error TS2322: fixture"; exit 1; fi\nfi\n');
    chmodSync(join(root, 'bin/pnpm'), 0o755);
    write('src/new.ts', 'export const value = 1;\n');
    const session_id = `fixture-${root.split('/').at(-1)}`;
    expect(hook('typecheck-on-stop.sh', { session_id }).status).toBe(0);
    expect(hook('typecheck-on-stop.sh', { session_id }).status).toBe(0);
    write('src/new.ts', 'INVALID\n');
    expect(hook('typecheck-on-stop.sh', { session_id }).status).toBe(2);
    expect(readFileSync(join(root, 'checks.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('refreshes lint paths when a file disappears during typecheck and does not cache the changed tree', () => {
    write('bin/pnpm', `#!/bin/bash
if [ "$1" = typecheck ]; then
  echo checked >> checks.log
  rm -f src/disappearing.ts
else
  for argument in "$@"; do
    case "$argument" in *.ts) [ -f "$argument" ] || exit 2 ;; esac
  done
fi
`);
    chmodSync(join(root, 'bin/pnpm'), 0o755);
    write('src/allowed.ts', 'export const value = 2;\n');
    write('src/disappearing.ts', 'export const temporary = 1;\n');
    expect(hook('typecheck-on-stop.sh').status).toBe(0);
    expect(hook('typecheck-on-stop.sh').status).toBe(0);
    expect(readFileSync(join(root, 'checks.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('does not cache a green result when content changes during lint', () => {
    write('bin/pnpm', `#!/bin/bash
if [ "$1" = typecheck ]; then
  echo checked >> checks.log
else
  printf 'export const value = 3;\\n' > src/allowed.ts
fi
`);
    chmodSync(join(root, 'bin/pnpm'), 0o755);
    write('src/allowed.ts', 'export const value = 2;\n');
    expect(hook('typecheck-on-stop.sh').status).toBe(0);
    expect(readdirSync(root).filter(name => name.startsWith('codex-stop-typecheck-green-'))).toEqual([]);
    expect(hook('typecheck-on-stop.sh').status).toBe(0);
    expect(readFileSync(join(root, 'checks.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
