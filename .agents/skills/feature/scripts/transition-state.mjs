#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

if (nextPhase === 'reviewed') {
  execFileSync('node', [
    join(root, '.agents/skills/feature/scripts/gate-fingerprint.mjs'),
    'check',
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
