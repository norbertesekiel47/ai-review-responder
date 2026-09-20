import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

// `carry` compares a carried ladder's `updatedAt` against the mtime of the
// intake file it is handed, so every fixture below lays the three events down
// in PRODUCTION order: the intake is AUTHORED first (its own file, outside
// .feature/), the parent ladder is updated next while the run is still in the
// parent checkout, and feature-setup.sh COPIES the intake into .feature/ last.
// `cp` stamps that copy NOW, so the installed copy is always the newest of the
// three and says nothing about when this run's intake was written — anchoring
// recency on it refuses every legitimate carry. The anchor is the authored
// source, which feature-setup.sh passes as `--intake "$SRC"`.
//
// Author time is set explicitly rather than relying on "the later write really
// did happen later": filesystem mtime resolution on some filesystems is
// coarser than the millisecond gap between two writes in the same test.
function authorIntake(intake: Record<string, unknown>, authoredMsAgo: number) {
  const source = join(root, 'authored-intake.json');
  writeFileSync(source, JSON.stringify(intake));
  const authoredAt = new Date(Date.now() - authoredMsAgo);
  utimesSync(source, authoredAt, authoredAt);
  mkdirSync(join(root, '.feature'), { recursive: true });
  writeFileSync(join(root, '.feature/intake.json'), JSON.stringify(intake));
  return source;
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

// The status bar refreshes constantly and from any directory, so the one-line
// form has two jobs: agree with the block (same snapshot), and never break the
// bar. It owns no state — the project rule is one progress ledger.
describe('progress statusline', () => {
  const init = () => feature('progress', 'init', '--size', 'standard', '--risk', 'high', '--surface', 'backend');

  it('prints nothing when no run exists', () => {
    const result = feature('progress', 'statusline');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(existsSync(join(root, '.feature'))).toBe(false);
  });

  it('prints nothing and exits 0 outside a repository or over a corrupt ladder', () => {
    const outside = spawnSync('node', [join(root, '.agents/skills/feature/scripts/progress.mjs'), 'statusline'], { cwd: tmpdir(), env, encoding: 'utf8' });
    expect([outside.status, outside.stdout]).toEqual([0, '']);

    mkdirSync(join(root, '.feature'));
    writeFileSync(join(root, '.feature/progress.json'), '{ half-written');
    const corrupt = feature('progress', 'statusline');
    expect([corrupt.status, corrupt.stdout]).toEqual([0, '']);
  });

  it('shows the active step and the tracer ratio, and agrees with the block', () => {
    expect(init().status).toBe(0);
    for (const step of ['intake', 'armed', 'plan']) expect(feature('progress', 'step', step, 'done').status).toBe(0);
    feature('progress', 'tracers', 'set', 'T1 gate constant|T2 veto window|T3 judge precondition');
    feature('progress', 'tracer', 'T1', 'done');
    feature('progress', 'tracer', 'T2', 'active');

    const line = feature('progress', 'statusline').stdout;
    expect(line).toBe('/feature 54% ▸ 4 execute 1/3');
    expect(feature('progress', 'render').stdout).toContain(' 54%');
  });

  it('accepts the repository root as an argument, so the bar need not cd', () => {
    expect(init().status).toBe(0);
    const result = spawnSync('node', [join(root, '.agents/skills/feature/scripts/progress.mjs'), 'statusline', root], { cwd: tmpdir(), env, encoding: 'utf8' });
    expect(result.stdout).toMatch(/^\/feature \d+% ▸ 1 intake$/);
  });

  it('marks a gate as running only while its heartbeat exists', () => {
    expect(init().status).toBe(0);
    for (const step of ['intake', 'armed', 'plan', 'execute']) feature('progress', 'step', step, 'done');
    expect(feature('progress', 'statusline').stdout).toMatch(/▸ 5 gate$/);
    writeFileSync(join(root, '.feature/gate-heartbeat.json'), '{}');
    expect(feature('progress', 'statusline').stdout).toMatch(/▸ 5 gate \(running\)$/);
  });

  it('puts a blocked step ahead of everything else, and reports done at the end', () => {
    expect(init().status).toBe(0);
    feature('progress', 'step', 'intake', 'blocked', '--note', 'owner sign-off');
    expect(feature('progress', 'statusline').stdout).toMatch(/✗ 1 intake blocked$/);

    for (const step of ['intake', 'armed', 'plan', 'execute', 'gate', 'review', 'ready']) feature('progress', 'step', step, 'done');
    expect(feature('progress', 'statusline').stdout).toBe('/feature 100% ✓ done');
  });
});

// The owner plans on a frontier model and implements on tier 3. At the step
// 3->4 checkpoint the planning session prints the prompt the owner pastes into
// a FRESH session. A fresh session has only the disk, so the command refuses
// unless the phase and the handoff doc are already there.
describe('progress handoff', () => {
  const DOC = 'docs/superpowers/plans/codex-fixture-handoff.md';
  const init = (runtime: string) => feature('progress', 'init', '--size', 'standard', '--risk', 'high', '--surface', 'backend', '--runtime', runtime);
  const approve = () => expect(run('bash', ['scripts/feature-state.sh', 'set-phase', 'plan_approved']).status).toBe(0);
  const writeDoc = () => { mkdirSync(join(root, 'docs/superpowers/plans'), { recursive: true }); writeFileSync(join(root, DOC), '# handoff\n'); };

  it('refuses before the plan is approved', () => {
    expect(init('claude').status).toBe(0);
    writeDoc();
    const result = feature('progress', 'handoff');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not 'plan_approved'");
    expect(result.stdout).toBe('');
  });

  it('refuses when the handoff doc is missing, and names the path', () => {
    expect(init('claude').status).toBe(0);
    approve();
    const result = feature('progress', 'handoff');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${DOC} does not exist`);
    expect(result.stdout).toBe('');
  });

  it('prints the Claude launch command on opus and the resume prompt', () => {
    expect(init('claude').status).toBe(0);
    approve();
    writeDoc();
    const result = feature('progress', 'handoff');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`cd ${root} && claude --model opus`);
    expect(result.stdout).toContain('   /feature-resume codex/fixture');
    expect(result.stdout).toContain('IS your sign-off to implement');
    expect(result.stdout).toContain(DOC);
    expect(result.stdout).not.toContain('gpt-');
  });

  it('prints the Codex launch command on sol and the $feature-resume prompt', () => {
    expect(init('codex').status).toBe(0);
    approve();
    writeDoc();
    const result = feature('progress', 'handoff');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`cd ${root} && codex -m gpt-5.6-sol`);
    expect(result.stdout).toContain('   $feature-resume codex/fixture');
    expect(result.stdout).not.toContain('claude --model');
  });

  // execution-lanes.md § Model routing OWNS the tier table. The script carries a
  // copy of two IDs so it can print a command; this fails if they ever drift.
  it('uses exactly the tier-3 IDs that execution-lanes.md owns', async () => {
    const lanes = readFileSync(join(sourceRoot, '.agents/skills/feature/references/execution-lanes.md'), 'utf8');
    const tier3 = lanes.split('\n').find((line) => line.startsWith('| 3 strong'));
    const { EXECUTE_LEAD } = await import(/* @vite-ignore */ join(sourceRoot, '.agents/skills/feature/scripts/lib/feature-snapshot.mjs')) as {
      EXECUTE_LEAD: { claude: { model: string }; codex: { model: string } };
    };
    expect(tier3).toBeDefined();
    expect(tier3).toContain(`\`${EXECUTE_LEAD.claude.model}\``);
    expect(tier3).toContain(`\`${EXECUTE_LEAD.codex.model}\``);
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
    // #1107: carry now checks the parent ladder's axes and recency against
    // the locked intake, so this fixture needs one that matches and a parent
    // ladder that is not older than it.
    const authored = authorIntake({ size: 'standard', risk: 'normal', surface: 'backend' }, 120_000);
    writeFileSync(join(root, 'parent-progress.json'), JSON.stringify({
      runtime: 'claude', size: 'standard', risk: 'normal', surface: 'backend', steps: {},
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    expect(feature('progress', 'carry', 'parent-progress.json', '--intake', authored, '--runtime', 'codex').status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, '.feature/progress.json'), 'utf8')).runtime).toBe('codex');
    expect(feature('progress', 'cost').stdout).toContain('unavailable');
  });

  it('refuses an ambiguous latest companion job', () => {
    const result = feature('review-log', 'attach-codex', '--latest');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('exact --job');
  });
});

// #1107: `carry` blindly overwrote the worktree's ladder stub with whatever
// the parent checkout held. A `/feature-swarm` wave's parent may hold no
// per-ticket ladder at all, or a stale one left over from an earlier, already
// merged run — the first armed worktree reported `standard·high·ui` on a
// `small·high·backend` ticket, sign-off note and all, and arm-check's own
// "no parent ladder carried" message disagreed with what actually happened.
// `carry` must check the parent ladder's axes and recency against the LOCKED
// intake before replacing the stub, and say why when it refuses.
describe('parent ladder carry (#1107)', () => {
  it('carries the parent ladder when its axes match the intake and it is no older', () => {
    // Production ordering: intake authored, THEN the ladder updated, THEN the
    // installed copy stamped now (authorIntake writes all three). The ladder
    // is older than the installed copy and newer than the authored source —
    // which is why the anchor has to be the source.
    const authored = authorIntake({ size: 'standard', risk: 'high', surface: 'backend' }, 120_000);
    const parentSteps = { orient: { status: 'done' }, intake: { status: 'done' } };
    const parentTracers = [{ id: 'T1', title: 'gate constant', status: 'done' }];
    writeFileSync(join(root, 'parent-progress.json'), JSON.stringify({
      runtime: 'claude', size: 'standard', risk: 'high', surface: 'backend',
      steps: parentSteps, tracers: parentTracers, updatedAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    const result = feature('progress', 'carry', 'parent-progress.json', '--intake', authored);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ladder: carried from');

    const progress = JSON.parse(readFileSync(join(root, '.feature/progress.json'), 'utf8'));
    expect(progress).toMatchObject({ size: 'standard', risk: 'high', surface: 'backend' });
    expect(progress.steps).toMatchObject(parentSteps);
    expect(progress.tracers).toEqual(parentTracers);
  });

  it('refuses to carry a parent ladder whose axes disagree with the intake', () => {
    const authored = authorIntake({ size: 'small', risk: 'high', surface: 'backend' }, 120_000);
    expect(feature('progress', 'init', '--size', 'small', '--risk', 'high', '--surface', 'backend').status).toBe(0);
    writeFileSync(join(root, 'parent-progress.json'), JSON.stringify({
      runtime: 'claude', size: 'standard', risk: 'high', surface: 'ui', steps: {}, tracers: [],
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    const result = feature('progress', 'carry', 'parent-progress.json', '--intake', authored);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ladder: kept the intake stub');

    const progress = JSON.parse(readFileSync(join(root, '.feature/progress.json'), 'utf8'));
    expect(progress).toMatchObject({ size: 'small', risk: 'high', surface: 'backend' });
  });

  it('refuses to carry a parent ladder older than the locked intake', () => {
    // The #1107 shape, which the author-time anchor must still refuse: the
    // intake was authored for THIS run just now, and the parent still holds a
    // ladder from an earlier, already-merged run days before it.
    const authored = authorIntake({ size: 'standard', risk: 'high', surface: 'backend' }, 0);
    expect(feature('progress', 'init', '--size', 'standard', '--risk', 'high', '--surface', 'backend').status).toBe(0);
    writeFileSync(join(root, 'parent-progress.json'), JSON.stringify({
      runtime: 'claude', size: 'standard', risk: 'high', surface: 'backend', steps: {}, tracers: [],
      updatedAt: new Date(0).toISOString(),
    }));

    const result = feature('progress', 'carry', 'parent-progress.json', '--intake', authored);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ladder: kept the intake stub');
    expect(result.stdout).toContain('is older than the locked intake');
  });

  // The refusal half was pinned from the start; the carry half was not, and
  // nothing ran feature-setup.sh end to end against a MATCHING parent ladder.
  // That is the case feature-setup broke: it installs .feature/intake.json
  // with `cp` moments before calling carry, so anchoring recency on the
  // installed copy made every legitimate carry refuse and threw the parent's
  // real orient/intake history and sign-off note away.
  it('carries the parent ladder through feature-setup when the axes match', () => {
    const parentSteps = {
      orient: { status: 'done', note: 'orientation read' },
      intake: { status: 'done', note: 'owner signed off on the locked intake' },
    };
    const parentTracers = [{ id: 'T1', title: 'gate constant', status: 'done' }];
    mkdirSync(join(root, '.feature'), { recursive: true });
    writeFileSync(join(root, '.feature/progress.json'), JSON.stringify({
      version: 1, runtime: 'claude', size: 'small', risk: 'high', surface: 'backend',
      steps: parentSteps, tracers: parentTracers, updatedAt: new Date().toISOString(),
    }));

    const worktreePath = mkdtempSync(join(tmpdir(), 'feature-runtime-carry-'));
    try {
      expect(run('git', ['worktree', 'add', '-b', 'codex/child-carry', worktreePath]).status).toBe(0);
      const draftPath = join(worktreePath, 'draft.json');
      writeFileSync(draftPath, JSON.stringify({
        size: 'small', risk: 'high', surface: 'backend', allowed_edit_surface: ['src/allowed.ts'],
      }));
      // Authored before the parent ladder was last updated, as in a real run.
      const authoredAt = new Date(Date.now() - 120_000);
      utimesSync(draftPath, authoredAt, authoredAt);

      const result = spawnSync('bash', ['scripts/feature-setup.sh', 'draft.json', '--runtime', 'claude'], { cwd: worktreePath, env, encoding: 'utf8' });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('ladder: carried from');
      expect(result.stdout).not.toContain('ladder: kept the intake stub');

      const progress = JSON.parse(readFileSync(join(worktreePath, '.feature/progress.json'), 'utf8'));
      expect(progress).toMatchObject({ size: 'small', risk: 'high', surface: 'backend', runtime: 'claude' });
      expect(progress.steps.orient).toMatchObject(parentSteps.orient);
      expect(progress.steps.intake).toMatchObject(parentSteps.intake);
      expect(progress.tracers).toEqual(parentTracers);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('names the reason when feature-setup keeps the intake stub instead of carrying', () => {
    // The main fixture repo plays the parent checkout: give it a stale ladder
    // (wrong axes) the way a `/feature-swarm` parent would carry one over
    // from an earlier, already-merged ticket.
    mkdirSync(join(root, '.feature'), { recursive: true });
    writeFileSync(join(root, '.feature/progress.json'), JSON.stringify({
      version: 1, runtime: 'claude', size: 'standard', risk: 'high', surface: 'ui',
      steps: {}, tracers: [], updatedAt: new Date().toISOString(),
    }));

    const worktreePath = mkdtempSync(join(tmpdir(), 'feature-runtime-child-'));
    try {
      expect(run('git', ['worktree', 'add', '-b', 'codex/child', worktreePath]).status).toBe(0);
      const draft = JSON.stringify({ size: 'small', risk: 'high', surface: 'backend', allowed_edit_surface: ['src/allowed.ts'] });
      writeFileSync(join(worktreePath, 'draft.json'), draft);
      const result = spawnSync('bash', ['scripts/feature-setup.sh', 'draft.json', '--runtime', 'claude'], { cwd: worktreePath, env, encoding: 'utf8' });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('ladder: kept the intake stub');

      const progress = JSON.parse(readFileSync(join(worktreePath, '.feature/progress.json'), 'utf8'));
      expect(progress).toMatchObject({ size: 'small', risk: 'high', surface: 'backend' });
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});

// #1107: arm-check silently substituted a default axis (`standard` / `normal`
// / `backend`) for anything it did not recognise — which is how #1080's
// `"risk": "high"` intake became a `normal` stub with no trace of why. The
// intake is this run's sole authority for the stub's axes: an unreadable
// field must DISARM, never fall back.
describe('arm-check axis validation (#1107)', () => {
  const writeIntake = (intake: Record<string, unknown>) => {
    mkdirSync(join(root, '.feature'), { recursive: true });
    writeFileSync(join(root, '.feature/intake.json'), JSON.stringify(intake));
  };

  it('builds the arm-check stub from the intake size, risk and surface', () => {
    writeIntake({ size: 'small', risk: 'high', surface: 'ui' });
    const result = run('bash', ['scripts/arm-check.sh']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('ARMED');

    const progress = JSON.parse(readFileSync(join(root, '.feature/progress.json'), 'utf8'));
    expect(progress).toMatchObject({ size: 'small', risk: 'high', surface: 'ui' });
  });

  it('refuses to arm when the intake risk is absent or not a declared value', () => {
    const badIntakes = [
      { size: 'small', surface: 'backend' },
      { size: 'small', risk: 'medium', surface: 'backend' },
      { size: 'small', classification: { risk: 'high' }, surface: 'backend' },
    ];
    for (const intake of badIntakes) {
      rmSync(join(root, '.feature'), { recursive: true, force: true });
      writeIntake(intake);
      const result = run('bash', ['scripts/arm-check.sh']);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('DISARMED');
      expect(result.stdout).toContain('risk');
      expect(existsSync(join(root, '.feature/progress.json'))).toBe(false);
    }
  });

  it('reports the stub without claiming a carry outcome it does not decide', () => {
    writeIntake({ size: 'standard', risk: 'normal', surface: 'mixed' });
    const result = run('bash', ['scripts/arm-check.sh']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('ladder: .feature/progress.json initialized from the intake');
    expect(result.stdout).not.toContain('no parent ladder carried');
  });
});
