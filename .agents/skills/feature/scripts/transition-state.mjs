#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { auditDeviationVerdicts } from './lib/deviations-verdicts.mjs';

const nextPhase = process.argv[2];
const phases = [
  'worktree_ready',
  'plan_approved',
  'executing',
  'gate_green',
  'reviewed',
  'shipped',
];

if (!phases.includes(nextPhase)) {
  console.error(`usage: transition-state.mjs <${phases.join('|')}>`);
  process.exit(2);
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const statePath = join(root, '.feature', 'state.json');

if (!existsSync(statePath)) {
  console.error('feature state missing; run scripts/feature-setup.sh first');
  process.exit(1);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const currentPhase = state.phase;
const allowed = {
  worktree_ready: new Set(['worktree_ready', 'plan_approved', 'executing']),
  plan_approved: new Set(['plan_approved', 'executing']),
  executing: new Set(['executing', 'gate_green']),
  gate_green: new Set(['gate_green', 'executing', 'reviewed']),
  reviewed: new Set(['reviewed', 'executing', 'gate_green', 'shipped']),
  shipped: new Set(['shipped']),
};

if (!allowed[currentPhase]?.has(nextPhase)) {
  console.error(`illegal feature phase transition: ${currentPhase} -> ${nextPhase}`);
  process.exit(1);
}

// `reviewed` is the phase that authorizes an external action, so both proofs
// are checked here rather than trusted from conversation: the gate fingerprint
// (the gate matches this exact worktree) and the red-team sidecar (a current,
// self-consistent adversarial pass with no open P0). Either check exits
// non-zero and takes the transition with it.
if (nextPhase === 'reviewed') {
  // Deviations read-back is enforced, not trusted: feature 719 reached review
  // with verdicts still "pending" despite the file promising resolution. A
  // missing file passes (trivial/small lanes may record no deviations); an
  // entry without a resolved ACCEPT verdict, or any RE-PLAN, refuses.
  const slug = String(state.branch ?? '').replace(/\//g, '-');
  const deviationsPath = join(
    root, 'docs', 'superpowers', 'plans', `${slug}-deviations.md`,
  );
  if (slug && existsSync(deviationsPath)) {
    const { problems } = auditDeviationVerdicts(readFileSync(deviationsPath, 'utf8'));
    if (problems.length > 0) {
      console.error(`deviations read-back incomplete (${deviationsPath}):`);
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error(
        'every entry needs **Verdict:** ACCEPT; a RE-PLAN goes through the abort criteria, not this transition.',
      );
      process.exit(1);
    }
  }

  execFileSync('node', [
    join(root, '.agents/skills/feature/scripts/gate-fingerprint.mjs'),
    'check',
  ], { cwd: root, stdio: 'inherit' });
  execFileSync('node', [
    join(root, '.agents/skills/feature/scripts/red-team-status.mjs'),
  ], { cwd: root, stdio: 'inherit' });
}

if (nextPhase === 'shipped' && currentPhase !== 'reviewed') {
  console.error('shipped requires reviewed state and explicit shipping authorization');
  process.exit(1);
}

execFileSync('bash', ['scripts/feature-state.sh', 'set-phase', nextPhase], {
  cwd: root,
  stdio: 'inherit',
});
