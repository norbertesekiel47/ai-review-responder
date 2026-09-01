#!/usr/bin/env node

// Prints the token bill per /feature step and refreshes .feature/phase-cost.json.
//
//   phase-cost.mjs          table, one row per step that has run
//   phase-cost.mjs --json   the same as JSON
//
// progress.mjs prints the closing step's row every time a step is marked
// done, so this command exists for the handoff and the post-merge read-back:
// which step cost the most, and did that change since the last run.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { featureDir, repoRoot } from './lib/feature-snapshot.mjs';
import { phaseCosts, renderCosts, writePhaseCosts } from './lib/phase-cost.mjs';

const root = repoRoot();
const progressPath = join(featureDir(root), 'progress.json');
if (!existsSync(progressPath)) {
  console.error('missing .feature/progress.json; run progress.mjs init first');
  process.exit(2);
}

const progress = JSON.parse(readFileSync(progressPath, 'utf8'));
const report = phaseCosts(root, progress);
writePhaseCosts(root, report);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderCosts(report));
}
