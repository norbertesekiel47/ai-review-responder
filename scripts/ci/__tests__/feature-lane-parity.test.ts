import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The /feature workflow has two routers, and `ci:agent-config` marks the pair
// LANE_DIVERGENT on purpose: the Claude lane ships to main, the Codex lane
// stops at review-ready. That exemption once let everything else drift too —
// the two files described different review depths, different round rules, and
// one had no step ladder at all.
//
// This pins the reconciliation (speed lane build 5): shared rules have ONE
// owner under references/, and both routers cite it rather than restating it.
// A rule that has to change now changes in one file.

const root = process.cwd();
const claudeLane = readFileSync(resolve(root, '.claude/commands/feature.md'), 'utf8');
const codexLane = readFileSync(resolve(root, '.agents/skills/feature/SKILL.md'), 'utf8');
const workingRules = readFileSync(
  resolve(root, '.agents/skills/feature/references/working-rules.md'),
  'utf8',
);
const executionLanes = readFileSync(
  resolve(root, '.agents/skills/feature/references/execution-lanes.md'),
  'utf8',
);

const ROUTERS = [
  ['Claude lane (.claude/commands/feature.md)', claudeLane],
  ['Codex lane (.agents/skills/feature/SKILL.md)', codexLane],
] as const;

const smallLane = readFileSync(resolve(root, '.claude/commands/feature-small.md'), 'utf8');

// The small lane once claimed "this IS the lefthook pre-push subset" while
// spelling out lint + typecheck + test by hand, which left out every ci:* audit
// the hook runs. A hand-kept list drifts; running the hook cannot.
describe('the small lane gate', () => {
  it('runs the pre-push hook instead of re-listing it', () => {
    expect(smallLane).toContain('pnpm exec lefthook run pre-push');
    expect(smallLane).not.toMatch(/pnpm lint && pnpm typecheck/);
  });

  it('builds, because AGENTS.md requires a build for a behavior change', () => {
    expect(smallLane).toContain('pnpm build');
  });
});

describe('both routers cite the shared rule set', () => {
  it.each(ROUTERS)('%s cites working-rules.md', (_name, router) => {
    expect(router).toContain('working-rules.md');
  });

  it.each(ROUTERS)('%s cites execution-lanes.md', (_name, router) => {
    expect(router).toContain('execution-lanes.md');
  });
});

describe('shared rules are not restated in a router', () => {
  // One sentence per rule set, distinctive enough that a copy is unambiguous.
  // A router that re-states one of these has forked the rule: the next edit
  // lands in one copy and the lanes disagree again.
  const OWNED_BY_WORKING_RULES = [
    'No abstraction before the second use',
    'Disk is the source of truth',
    'Never pull raw logs into context',
  ];

  it.each(OWNED_BY_WORKING_RULES)('working-rules.md owns %j', (sentence) => {
    expect(workingRules).toContain(sentence);
    expect(claudeLane).not.toContain(sentence);
    expect(codexLane).not.toContain(sentence);
  });
});

describe('the speed-lane rules reached both lanes', () => {
  // Lever A — the red-team pass rides inside the review wave, so the staging
  // directory is the load-bearing detail: an untracked report under docs/
  // breaks red-team precondition 1 and its post-restore assertion.
  it.each(ROUTERS)('%s stages review reports outside git', (_name, router) => {
    expect(router).toContain('review-staging');
  });

  // Lever B — a verification round is owed only when the contract moved.
  it.each(ROUTERS)('%s decides verification rounds mechanically', (_name, router) => {
    expect(router).toContain('contract-changed');
  });

  // The plan hash reads UNCHANGED after every code fix, so a branch round is
  // decided from the tree. A router that loses this goes back to skipping the
  // one round that verifies a fix.
  it.each(ROUTERS)('%s decides a branch round from the tree, not the plan hash', (_name, router) => {
    expect(router).toContain('branch-round-owed');
  });

  // Lever C — the unattended fix loop runs the narrowed gate.
  it.each(ROUTERS)('%s runs the fast gate inside the loop', (_name, router) => {
    expect(router).toContain('--fast');
  });

  // Codex round economics. Measured on feat/1008: 7.27M input tokens for 56K
  // of output across two plan waves, because each wave cloned one brief three
  // ways and then started the next wave cold.
  it.each(ROUTERS)('%s resumes a verification round instead of a cold start', (_name, router) => {
    expect(router).toContain('codex exec resume');
  });

  it.each(ROUTERS)('%s points at the Codex dispatch rules', (_name, router) => {
    expect(router).toContain('Dispatching a Codex round');
  });

  // The most expensive single event measured in a /feature run was a rebase,
  // not a slow reviewer: 67 of red team's 174 minutes on feat/1008 went to one
  // post-rebase re-run. Both routers must say so at the wave.
  it.each(ROUTERS)('%s freezes the fork at the wave', (_name, router) => {
    expect(router).toContain('Pin the fork');
    expect(router).toContain('Take main BEFORE');
  });
});

describe('the Codex dispatch rules keep their guardrails', () => {
  const reviewPrompts = readFileSync(
    resolve(root, '.agents/skills/feature/references/review-prompts.md'),
    'utf8',
  );

  it('scopes resume to verification rounds only', () => {
    // A resumed session is anchored on its own earlier conclusions. That is
    // right for checking its own findings and fatal for an independent axis.
    expect(reviewPrompts).toContain('Never resume for round 1');
    expect(reviewPrompts).toContain('never for an independent axis');
  });

  it('keeps the reviewer read access when briefing it', () => {
    // The cited-artifact check needs the filesystem. The rule removes
    // re-derivation, never discovery.
    expect(reviewPrompts).toContain('You keep full read access');
  });

  it('protects approvals_reviewer from being mistaken for review fan-out', () => {
    // The short sessions beside every round are the approval reviewer, a
    // security control — not redundant sub-agents. An earlier read of these
    // logs got this wrong; the test exists so the next one cannot.
    expect(reviewPrompts).toContain('Do not touch `approvals_reviewer`');
  });

  it('differentiates a fan-out instead of deleting it', () => {
    // Cutting three clones to one would trade tokens for lost sampling. The
    // fix is three different questions, not one question.
    for (const question of ['failability', 'cited artifacts', 'invariants']) {
      expect(reviewPrompts).toContain(question);
    }
  });
});

describe('the reference owns what the routers only point at', () => {
  it('execution-lanes.md defines the wave, the fork rule, the conditional round and the loop', () => {
    expect(executionLanes).toContain('## The review wave');
    expect(executionLanes).toContain('## Pin the fork');
    expect(executionLanes).toContain('## Conditional verification rounds');
    expect(executionLanes).toContain('## The gate loop');
  });

  it('names the same four sizes in the reference and both routers', () => {
    for (const size of ['trivial', 'small', 'standard', 'epic']) {
      expect(executionLanes).toContain(size);
    }
    // The routers may spell a lane in caps ("SMALL PATH"); compare lowercased.
    for (const [name, router] of ROUTERS) {
      expect(router.toLowerCase(), name).toContain('epic');
      expect(router.toLowerCase(), name).toContain('trivial');
    }
  });

  it('keeps the caps in one place — three plan rounds, two red-team rounds', () => {
    expect(executionLanes).toContain('three plan\nrounds, three branch rounds, two red-team rounds');
  });
});

describe('the one intended divergence still holds', () => {
  it('only the Claude lane ships', () => {
    expect(claudeLane).toContain('## 8. SHIP');
    expect(codexLane).toContain('Stop at review-ready');
    expect(codexLane).not.toContain('## 8. SHIP');
  });
});
