import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd());
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), NODE_ENV: 'test' as const };
let root: string;

function run(command: string, args: string[]) {
  return spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
}

function feature(script: string, ...args: string[]) {
  return run('node', [`.agents/skills/feature/scripts/${script}.mjs`, ...args]);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'feature-runtime-')));
  expect(run('git', ['init', '-q', '-b', 'codex/fixture']).status).toBe(0);
  cpSync(join(sourceRoot, '.agents/skills/feature/scripts'), join(root, '.agents/skills/feature/scripts'), { recursive: true });
  cpSync(join(sourceRoot, '.codex/hooks'), join(root, '.codex/hooks'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  for (const name of ['feature-setup', 'arm-check', 'feature-state', 'feature-surface-check', 'feature-autonomy-profile']) {
    cpSync(join(sourceRoot, `scripts/${name}.sh`), join(root, `scripts/${name}.sh`));
  }
  writeFileSync(join(root, '.gitignore'), '.feature/\n.claude/settings.local.json\n');
  expect(run('git', ['add', '.']).status).toBe(0);
  expect(run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture']).status).toBe(0);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('feature lane selection', () => {
  it.each([
    ['trivial', 'normal', 'trivial', false, false],
    ['small', 'normal', 'small', false, false],
    ['standard', 'normal', 'guarded', true, true],
    ['trivial', 'high', 'guarded', true, true],
    ['small', 'high', 'guarded', true, true],
    ['standard', 'high', 'guarded', true, true],
    ['epic', 'high', 'epic', false, true],
  ])('routes %s/%s without creating state', (size, risk, lane, arm, plan) => {
    const result = feature('progress', 'route', '--size', String(size), '--risk', String(risk));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ lane, arm, plan });
    expect(existsSync(join(root, '.feature'))).toBe(false);
  });

  it('requires a build even for a lightweight backend change', () => {
    const result = feature('progress', 'route', '--size', 'small', '--risk', 'normal');
    expect(JSON.parse(result.stdout).verification).toContain('pnpm build');
  });
});

describe('native Codex workflow', () => {
  it('requires plan approval before a guarded small/high run can execute', () => {
    mkdirSync(join(root, '.feature'));
    writeFileSync(join(root, '.feature/intake.json'), JSON.stringify({ size: 'small', risk: 'high', surface: 'backend' }));
    expect(run('bash', ['scripts/feature-state.sh', 'set-phase', 'worktree_ready']).status).toBe(0);
    expect(feature('transition-state', 'executing').status).toBe(1);
    expect(JSON.parse(readFileSync(join(root, '.feature/state.json'), 'utf8')).phase).toBe('worktree_ready');
    expect(feature('transition-state', 'plan_approved').status).toBe(0);
    expect(feature('transition-state', 'executing').status).toBe(0);
  });

  it('prepares an armed run without committing, deleting the draft, or writing Claude permissions', () => {
    const originalHead = run('git', ['rev-parse', 'HEAD']).stdout;
    const draft = JSON.stringify({ size: 'standard', risk: 'high', surface: 'backend', allowed_edit_surface: ['src/allowed.ts'] });
    writeFileSync(join(root, 'draft.json'), draft);
    const result = run('bash', ['scripts/feature-setup.sh', 'draft.json', '--runtime', 'codex']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(run('git', ['rev-parse', 'HEAD']).stdout).toBe(originalHead);
    expect(run('git', ['diff', '--cached', '--name-only']).stdout).toBe('');
    expect(readFileSync(join(root, 'draft.json'), 'utf8')).toBe(draft);
    // Keep workflow size separate from the plans/ path in billing-policy scans.
    const installedAuditCopy = readFileSync(join(root, 'docs/superpowers/plans/codex-fixture-intake.json'), 'utf8');
    expect(installedAuditCopy).toBe(draft);
    expect(existsSync(join(root, '.claude/settings.local.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, '.feature/progress.json'), 'utf8'))).toMatchObject({ runtime: 'codex', risk: 'high' });
  });

  it('reports unavailable Codex usage instead of a zero Claude bill', () => {
    expect(feature('progress', 'init', '--size', 'standard', '--risk', 'normal', '--surface', 'backend', '--runtime', 'codex').status).toBe(0);
    const result = feature('progress', 'cost');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('unavailable');
    const costs = JSON.parse(readFileSync(join(root, '.feature/phase-cost.json'), 'utf8'));
    expect(costs.total).toBeNull();
  });

  it('records and renders a native review without companion state', () => {
    expect(feature('review-log', 'round-start', '--axis', 'spec-correctness').status).toBe(0);
    writeFileSync(join(root, 'review.md'), 'Verified the exact diff. VERDICT: APPROVED\n');
    const attach = feature('review-log', 'attach-review', '--id', 'native-review-42', '--report', 'review.md');
    expect(attach.status, attach.stderr).toBe(0);
    expect(feature('review-log', 'round-end', '--verdict', 'APPROVED').status).toBe(0);
    const transcript = readFileSync(join(root, '.feature/review-transcript.jsonl'), 'utf8');
    expect(transcript).toContain('native-review-42');
    expect(transcript).toContain('Verified the exact diff.');
    expect(feature('review-log', 'render').stdout).toContain('APPROVED');
  });

  it('keeps the selected runtime when carrying progress from another host', () => {
    writeFileSync(join(root, 'parent-progress.json'), JSON.stringify({
      runtime: 'claude', size: 'standard', risk: 'normal', surface: 'backend', steps: {},
    }));
    expect(feature('progress', 'carry', 'parent-progress.json', '--runtime', 'codex').status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, '.feature/progress.json'), 'utf8')).runtime).toBe('codex');
    expect(feature('progress', 'cost').stdout).toContain('unavailable');
  });

  it('refuses an ambiguous latest companion job', () => {
    const result = feature('review-log', 'attach-codex', '--latest');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('exact --job');
  });
});
