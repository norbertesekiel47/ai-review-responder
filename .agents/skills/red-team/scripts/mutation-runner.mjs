#!/usr/bin/env node

/**
 * mutation-runner.mjs — the crash-safe mechanics of a `/red-team` mutation pass.
 *
 * WHY A SCRIPT AND NOT PROSE IN THE SKILL. Three of these mechanics are
 * unverifiable as instructions: a durable journal written BEFORE the mutation
 * lands, a supervisor whose identity is recorded before it can run anything,
 * and a finalizer that refuses to overwrite content it did not write. Each has a
 * crash window that only a test can prove closed, so each lives here.
 *
 * THE JOURNAL IS THE CONTRACT. `.feature/red-team-journal.json` (gitignored run
 * scratch) is the only durable link between a mutation and its undo. The
 * INVOKING agent — not the subagent that ran the mutations — runs `finalize`,
 * and it works from the journal alone, so a dead subagent cannot strand a
 * mutation in the worktree.
 *
 * THE SUPERVISOR EXISTS FOR ONE REASON. `spawn`'s own timeout kills the process
 * it started, not the descendants Vitest forks. Each run is therefore launched
 * under a PAUSED `sh` that is its own session and process-group leader: the
 * parent journals its PGID and start time, and only then writes the release
 * byte that lets it `exec` the real command. `exec` preserves PID and start
 * time, so the journaled identity stays valid for the group's whole life. The
 * start time is a PID-REUSE GUARD, not an ornament: without it a stale journal
 * entry could target a PID the OS has since handed to something else.
 *
 * THE RELEASE CHANNEL IS THE PARENT'S STDIN PIPE, and that closes the first of
 * the two crash windows on its own: a parent that dies before releasing gives
 * the supervisor EOF, and `read … || exit 0` makes it exit WITHOUT executing
 * anything. The identity is already durable at that point, so a later `reap`
 * finds an empty group and closes the entry rather than guessing.
 *
 * WHEN THE LEADER IS GONE BUT THE GROUP IS NOT, the group is still safe to
 * target: POSIX forbids reusing a process-group ID while any member of that
 * group is alive, so an orphaned descendant cannot be a stranger's process.
 *
 * NOTHING HERE INTERPOLATES A REPOSITORY-CONTROLLED NAME INTO A SHELL STRING.
 * Every launch is an argument array with `shell: false`.
 *
 * Exit codes: 0 success, 1 failure or abort, 2 usage error, 124 run timeout.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Plan budget: ≤30 mutation runs per round, ≤120s per run. */
export const MAX_RUNS_PER_ROUND = 30;
export const RUN_TIMEOUT_MS = 120_000;

// One owner-approved ticket continuation, not a general CLI/env override.
// Original pin/inventory stay immutable until completion; see #1185 D3.
const CONTINUATION_AUTHORIZATION = 'owner-1185-budget-continuation';
const CONTINUATION_TEXT = 'Question: Approve the ticket-scoped verifier change needed to finish those 439 cases—at least 878 additional test runs? The red-team skill limits verification to “30 mutation runs per round,” which is the remaining blocker.\nOwner: I approve';

const RUN_C_BASELINE = '72cc51abd5d45b10cd7abf3c993f9039c5e63f65';
const RUN_C_AUTHORIZATION = 'owner-run-c-budget-next-pass';
const RUN_C_TEXT = "Question: May I make a Run C-only change to the verifier’s limit, allowing up to 1,500 local test runs to finish those checks?\nOwner: I'll finish everything from C, D, and E. I give you the approval.";
const RUN_C_REPORT = 'docs/reviews/red-team/codex-owner-operator-run-c-14b9e1/findings.json';
const RUN_C_EXTENSION_PATHS = new Set([
  '.agents/skills/red-team/scripts/mutation-runner.mjs',
  'scripts/ci/__tests__/red-team-mutation-runner.test.ts',
  '.agents/skills/red-team/SKILL.md',
  '.claude/skills/red-team/SKILL.md',
  'docs/superpowers/plans/codex-owner-operator-run-c-intake.json',
  'docs/superpowers/plans/codex-owner-operator-run-c-deviations.md',
  RUN_C_REPORT,
  'docs/reviews/red-team/codex-owner-operator-run-c-14b9e1/findings.md',
  'docs/reviews/codex-owner-operator-run-c/evidence.md',
  'docs/reviews/codex-owner-operator-run-c/resume.md',
  'docs/reviews/finding-checklists/spec-correctness.md',
  'docs/reviews/codex-owner-operator-run-c/budget-extension-review.md',
]);

const RUN_C_FOURTH_BASELINE = 'fb536c09711ec331262f5efc64ff42f066bec3ba';
const RUN_C_HISTORY_BLOB = 'd2de690d9154e591d83cbb9e9591db8d0567d318';
const RUN_C_HISTORY_MARKDOWN_BLOB = 'caae5b4d877e254033485a73f38f56b074c8910e';
const RUN_C_MARKDOWN = 'docs/reviews/red-team/codex-owner-operator-run-c-14b9e1/findings.md';
const RUN_C_FOURTH_AUTHORIZATION = 'owner-run-c-fourth-round-prompt-regression';
const RUN_C_FOURTH_TEXT = 'Question: May I make the Run C-only verifier change described in /private/tmp/run-c-fourth-round-proposal.md and run a fourth verification round, capped at 150 local test launches? It covers the prompt fix and the verifier’s own safeguards, preserves all earlier evidence, uses Codex only, and keeps further rounds blocked.\nOwner: Yes, approve the scoped fourth round';
const RUN_C_FOURTH_PATHS = new Set([
  '.agents/skills/red-team/scripts/mutation-runner.mjs',
  '.agents/skills/feature/scripts/red-team-status.mjs',
  'scripts/ci/__tests__/red-team-mutation-runner.test.ts',
  'scripts/ci/__tests__/red-team-status.test.ts',
  '.agents/skills/red-team/SKILL.md',
  '.claude/skills/red-team/SKILL.md',
  'src/lib/agents/operator/prompt.ts',
  'src/lib/agents/operator/__tests__/prompt.test.ts',
  'tests/llm-eval/structured-runner.ts',
  'tests/llm-eval/__tests__/structured-runner.test.ts',
  'docs/superpowers/plans/codex-owner-operator-run-c-intake.json',
  'docs/superpowers/plans/codex-owner-operator-run-c-deviations.md',
  RUN_C_REPORT,
  'docs/reviews/red-team/codex-owner-operator-run-c-14b9e1/findings.md',
  'docs/reviews/codex-owner-operator-run-c/evidence.md',
  'docs/reviews/codex-owner-operator-run-c/resume.md',
  'docs/reviews/codex-owner-operator-run-c/fourth-round-extension-review.md',
  'docs/reviews/finding-checklists/spec-correctness.md',
]);

const RUN_D_BRANCH = 'codex/owner-operator-run-d';
const RUN_D_BASELINE = 'bd23d56e542a825da1dc16b2c0375127ded2443c';
const RUN_D_HISTORY_BLOB = '6cacfba8fcfddd2fe6c2832e8a1d51c8e88d93f0';
const RUN_D_MARKDOWN_BLOB = '52625d75432e613c6ae6c7f535219c81d1f9d9ec';
const RUN_D_REPORT = 'docs/reviews/red-team/codex-owner-operator-run-d-7749f8/findings.json';
const RUN_D_MARKDOWN = 'docs/reviews/red-team/codex-owner-operator-run-d-7749f8/findings.md';
const RUN_D_INTAKE = 'docs/superpowers/plans/codex-owner-operator-run-d-intake.json';
const RUN_D_AUTHORIZATION = 'owner-run-d-second-pass-200';
const RUN_D_TEXT = 'Question: May I make the Run D-only verifier change described in /private/tmp/run-d-next-pass-proposal.md and run its second adversarial pass, capped at 200 local test launches? This covers the 35 unmeasured cases, the recovery correction and verifier safeguards, includes only the named supporting paths, preserves earlier evidence, uses Codex only, and grants no third round.\nOwner: Go for it';
const RUN_D_SUPPORT_PATHS = [
  '.agents/skills/red-team/scripts/mutation-runner.mjs',
  '.agents/skills/red-team/SKILL.md',
  '.claude/skills/red-team/SKILL.md',
  'scripts/ci/__tests__/red-team-mutation-runner.test.ts',
];
const RUN_D_ADDED_TESTS = [
  'watchdog recovery of exhausted dispatching Operator work preserves live claims and other topics',
  'watchdog recovery of exhausted dispatching work defers a turn locked by completion',
];
const RUN_D_EXTENSION_PATHS = new Set([
  ...RUN_D_SUPPORT_PATHS, RUN_D_REPORT, RUN_D_MARKDOWN, RUN_D_INTAKE,
  'docs/superpowers/plans/codex-owner-operator-run-d-deviations.md',
  'docs/superpowers/plans/codex-owner-operator-run-d-plan.md',
  'docs/reviews/codex-owner-operator-run-d/async-round-1.md',
  'docs/reviews/codex-owner-operator-run-d/async-round-2.md',
  'docs/reviews/codex-owner-operator-run-d/second-pass-authorization.md',
  'docs/reviews/codex-owner-operator-run-d/budget-extension-review.md',
  'docs/reviews/codex-owner-operator-run-d/spec-correctness-round-1.md',
  'docs/reviews/codex-owner-operator-run-d/standards-maintainability-round-1.md',
  'docs/reviews/finding-checklists/async.md',
  'docs/reviews/finding-checklists/spec-correctness.md',
  'docs/reviews/finding-checklists/standards-maintainability.md',
  'docs/runbooks/evidence/2026-09-13-owner-operator-run-d-evidence.md',
  'docs/runbooks/evidence/owner-operator-run-d-2026-09-13/watchdog-recovery-after-rollback-preflight.json',
  'docs/runbooks/evidence/owner-operator-run-d-2026-09-13/watchdog-recovery-after-rollback-result.json',
  'docs/runbooks/evidence/owner-operator-run-d-2026-09-13/watchdog-recovery-after-rollback-cleanup.json',
  'docs/runbooks/evidence/owner-operator-run-d-2026-09-13/watchdog-recovery-after-rollback-runner.mjs',
  '.claude/reference/lab-notes/history/2026-09.md',
]);

/** One finite second pass; neither a report rewrite nor an intake expansion grants more work. */
function authorizedRunDBudget(root, journal) {
  if (journal.round !== 2 || !Number.isInteger(journal.runs) || journal.runs < 0) return null;
  try {
    if (git(root, ['branch', '--show-current']) !== RUN_D_BRANCH) return null;
    const headSha = git(root, ['rev-parse', 'HEAD']);
    if (git(root, ['merge-base', RUN_D_BASELINE, headSha]) !== RUN_D_BASELINE) return null;
    const changed = git(root, ['diff', '--name-only', '--no-renames', RUN_D_BASELINE, headSha]);
    if (changed.split('\n').filter(Boolean).some((path) => !RUN_D_EXTENSION_PATHS.has(path))
      || !onlyJournaledChanges(root, journal)
      || git(root, ['ls-files', '--others', '--exclude-standard'])) return null;
    if (git(root, ['rev-parse', `${RUN_D_BASELINE}:${RUN_D_REPORT}`]) !== RUN_D_HISTORY_BLOB
      || git(root, ['rev-parse', `${RUN_D_BASELINE}:${RUN_D_MARKDOWN}`]) !== RUN_D_MARKDOWN_BLOB) return null;
    const historical = JSON.parse(git(root, ['show', RUN_D_HISTORY_BLOB]));
    const admission = JSON.parse(git(root, ['show', `${headSha}:${RUN_D_REPORT}`]));
    if (admission?.mode !== 'feature' || admission.branch !== RUN_D_BRANCH || admission.round !== 1
      || admission.head_sha !== '8b1c612b08d2b93208b4fbb7102f7d917ea9b9c2'
      || !Array.isArray(admission.inventory) || admission.inventory.length !== 226
      || !unchangedPrefix(historical.authorizations, admission.authorizations)
      || admission.authorizations.length !== historical.authorizations.length + 1) return null;
    const identities = admission.inventory.map((row) => ({ id: row?.id, file: row?.file, test: row?.test }));
    if (sha256(JSON.stringify(identities)) !== 'fa3b864a18eee4f2d9fbb7e64c630e53d6d54b90da8a410a88c0d128c6b1c032') return null;
    const authorization = admission.authorizations.at(-1);
    if (authorization?.id !== RUN_D_AUTHORIZATION || authorization.date !== '2026-09-14'
      || authorization.text !== RUN_D_TEXT
      || Object.keys(authorization).sort().join(',') !== 'date,finding_ids,id,text'
      || !Array.isArray(authorization.finding_ids) || authorization.finding_ids.length !== 0
      || admission.authorizations.filter((entry) => entry?.id === RUN_D_AUTHORIZATION).length !== 1) return null;
    const { authorizations: _oldGrants, ...oldEvidence } = historical;
    const { authorizations: _newGrants, ...newEvidence } = admission;
    if (JSON.stringify(oldEvidence) !== JSON.stringify(newEvidence)) return null;
    const historicalMarkdown = execFileSync('git', ['cat-file', 'blob', RUN_D_MARKDOWN_BLOB], { cwd: root });
    const admissionMarkdown = execFileSync('git', ['show', `${headSha}:${RUN_D_MARKDOWN}`], { cwd: root });
    if (!admissionMarkdown.subarray(0, historicalMarkdown.length).equals(historicalMarkdown)) return null;
    const originalIntake = JSON.parse(git(root, ['show', `${RUN_D_BASELINE}:${RUN_D_INTAKE}`]));
    const intake = JSON.parse(git(root, ['show', `${headSha}:${RUN_D_INTAKE}`]));
    const { allowed_edit_surface: originalSurface, tests_to_add: originalTests, ...originalContract } = originalIntake;
    const { allowed_edit_surface: surface, tests_to_add: tests, ...contract } = intake;
    if (!Array.isArray(originalSurface) || !Array.isArray(surface)
      || !Array.isArray(originalTests)
      || JSON.stringify(tests) !== JSON.stringify([...RUN_D_ADDED_TESTS, ...originalTests])
      || surface.some((path) => typeof path !== 'string')
      || JSON.stringify(originalContract) !== JSON.stringify(contract)
      || JSON.stringify([...surface].sort())
        !== JSON.stringify([...new Set([...originalSurface, ...RUN_D_SUPPORT_PATHS])].sort())) return null;
    const grant = { id: authorization.id, maxRuns: 200, sha256: sha256(JSON.stringify(authorization)), headSha };
    if ((journal.runs > 0 && !journal.budgetAuthorization)
      || (journal.budgetAuthorization && (!sameGrant(journal.budgetAuthorization, grant)
        || journal.budgetAuthorization.firstRun !== 1))) return null;
    return grant;
  } catch {
    return null;
  }
}

const RUN_E_BRANCH = 'codex/owner-operator-run-e';
const RUN_E_BASELINE = '54cb1a05e82de192355e379b7eb7b76182189306';
const RUN_E_HISTORY_COMMIT = '76f7914636e3d20c4a676a5d7ef512e17dab25ce';
const RUN_E_HISTORY_BLOB = 'b6348b608056c339cbb0915f3ac581574a18c3b1';
const RUN_E_HISTORY_MARKDOWN_BLOB = '348acba4301870cc9be3ba72866891ba681c3573';
const RUN_E_HISTORY_SHA256 = 'b869b052d2f39574c51418e2a608f136c43e375853e3692385921f95c2259a0c';
const RUN_E_MARKDOWN_SHA256 = '42cc8719dba7356dac5e626b6d606628789b5d24698de4e7998cbcb138b0cc46';
const RUN_E_IDENTITY_SHA256 = 'cb7c194ac0f963e76e723f123007c143b913aea924360b77439b6a8007c4476b';
const RUN_E_REPORT = 'docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/findings.json';
const RUN_E_MARKDOWN = 'docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/findings.md';
const RUN_E_INTAKE = 'docs/superpowers/plans/codex-owner-operator-run-e-intake.json';
const RUN_E_AUTHORIZATION = 'owner-run-e-second-pass-1600';
const RUN_E_TEXT = 'Question: May I apply the reviewed Run E proposal at /private/tmp/run-e-next-pass-proposal.md and run one second adversarial pass, capped at 1,600 local test launches? This covers the 707 remaining cases, the Restore fix and verifier safeguards, the named supporting files and staging alert setup. It preserves earlier evidence and your approval in history, leaves the final risk-waiver list empty, uses Codex only, and grants no third round.\nOwner: Yes, approve the scoped E second pass';
const RUN_E_SUPPORT_PATHS = [
  '.agents/skills/red-team/scripts/mutation-runner.mjs',
  '.agents/skills/red-team/SKILL.md',
  '.claude/skills/red-team/SKILL.md',
  'scripts/ci/__tests__/red-team-mutation-runner.test.ts',
  '.agents/skills/feature/scripts/red-team-status.mjs',
  'scripts/ci/__tests__/red-team-status.test.ts',
  'docs/runbooks/beta-launch-alerting.md',
];
const RUN_E_ADDED_TESTS = [
  'adopts a rejected timeline Apply and refreshes its Restore source: %s',
  'pins Run E HEAD and grant before the first child executes',
  'allows Run E launch 1600 and refuses 1601 and a third round',
  'certifies Run E round 2 only with intact admission history and a closed capped launch journal',
  'rejects Run E third and higher reports before generic authorization prose',
];
const RUN_E_EXTENSION_PATHS = new Set([
  ...RUN_E_SUPPORT_PATHS, RUN_E_REPORT, RUN_E_MARKDOWN, RUN_E_INTAKE,
  'docs/superpowers/plans/codex-owner-operator-run-e-plan.md',
  'docs/superpowers/plans/codex-owner-operator-run-e-deviations.md',
  'docs/reviews/codex-owner-operator-run-e/second-pass-authorization.md',
  'docs/reviews/codex-owner-operator-run-e/budget-extension-review.md',
]);

/** Denial text must never satisfy the generic third-round prose matcher. */
export function runEThirdRoundForbidden(branch, grantId, round) {
  return round >= 3 && (branch === RUN_E_BRANCH || grantId === RUN_E_AUTHORIZATION);
}

/** Committed evidence shared by launch admission and final certification. */
export function validateRunEAdmission(root, headSha) {
  try {
    if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)
      || git(root, ['merge-base', RUN_E_BASELINE, RUN_E_HISTORY_COMMIT]) !== RUN_E_BASELINE
      || git(root, ['merge-base', RUN_E_HISTORY_COMMIT, headSha]) !== RUN_E_HISTORY_COMMIT
      || git(root, ['merge-base', headSha, 'HEAD']) !== headSha) return null;
    const changed = git(root, ['diff', '--name-only', '--no-renames', RUN_E_BASELINE, headSha]);
    if (changed.split('\n').filter(Boolean).some((path) => !RUN_E_EXTENSION_PATHS.has(path))) return null;
    // History was published after corrected code: pin its own commit and exact
    // bytes, never pretend the original report existed at the product baseline.
    if (git(root, ['rev-parse', `${RUN_E_HISTORY_COMMIT}:${RUN_E_REPORT}`]) !== RUN_E_HISTORY_BLOB
      || git(root, ['rev-parse', `${RUN_E_HISTORY_COMMIT}:${RUN_E_MARKDOWN}`]) !== RUN_E_HISTORY_MARKDOWN_BLOB) return null;
    const historicalBytes = execFileSync('git', ['cat-file', 'blob', RUN_E_HISTORY_BLOB], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    const historicalMarkdown = execFileSync('git', ['cat-file', 'blob', RUN_E_HISTORY_MARKDOWN_BLOB], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    if (sha256(historicalBytes) !== RUN_E_HISTORY_SHA256
      || sha256(historicalMarkdown) !== RUN_E_MARKDOWN_SHA256) return null;
    const historical = JSON.parse(historicalBytes.toString('utf8'));
    const admission = JSON.parse(git(root, ['show', `${headSha}:${RUN_E_REPORT}`]));
    if (historical?.mode !== 'feature' || historical.branch !== RUN_E_BRANCH || historical.round !== 1
      || historical.head_sha !== '890eea76c8c04b8d2acfcc73a895ec3112560e38'
      || !Array.isArray(historical.inventory) || historical.inventory.length !== 2113
      || !Array.isArray(historical.authorizations) || historical.authorizations.length !== 0
      || !Array.isArray(admission.authorizations) || admission.authorizations.length !== 1) return null;
    const identities = historical.inventory.map((row) => ({ id: row?.id, file: row?.file, test: row?.test }));
    if (sha256(JSON.stringify(identities)) !== RUN_E_IDENTITY_SHA256) return null;
    const authorization = admission.authorizations[0];
    if (authorization?.id !== RUN_E_AUTHORIZATION || authorization.date !== '2026-09-15'
      || authorization.text !== RUN_E_TEXT
      || Object.keys(authorization).sort().join(',') !== 'date,finding_ids,id,text'
      || !Array.isArray(authorization.finding_ids) || authorization.finding_ids.length !== 0) return null;
    const { authorizations: _oldGrants, ...oldEvidence } = historical;
    const { authorizations: _newGrants, ...newEvidence } = admission;
    if (JSON.stringify(oldEvidence) !== JSON.stringify(newEvidence)) return null;
    const admissionMarkdown = execFileSync('git', ['show', `${headSha}:${RUN_E_MARKDOWN}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    if (!admissionMarkdown.subarray(0, historicalMarkdown.length).equals(historicalMarkdown)
      || !admissionMarkdown.subarray(historicalMarkdown.length).toString('utf8').includes(RUN_E_TEXT)) return null;
    const originalIntake = JSON.parse(git(root, ['show', `${RUN_E_BASELINE}:${RUN_E_INTAKE}`]));
    const intake = JSON.parse(git(root, ['show', `${headSha}:${RUN_E_INTAKE}`]));
    const { allowed_edit_surface: originalSurface, tests_to_add: originalTests, ...originalContract } = originalIntake;
    const { allowed_edit_surface: surface, tests_to_add: tests, ...contract } = intake;
    if (!Array.isArray(originalSurface) || !Array.isArray(surface) || !Array.isArray(originalTests)
      || JSON.stringify(tests) !== JSON.stringify([...RUN_E_ADDED_TESTS, ...originalTests])
      || JSON.stringify(originalContract) !== JSON.stringify(contract)) return null;
    const correctedSurface = originalSurface.map((path) => path === 'docs/reviews/red-team/codex-owner-operator-run-e/**'
      ? 'docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/**' : path);
    if (surface.some((path) => typeof path !== 'string')
      || JSON.stringify([...surface].sort())
        !== JSON.stringify([...new Set([...correctedSurface, ...RUN_E_SUPPORT_PATHS])].sort())) return null;
    return {
      grant: { id: authorization.id, maxRuns: 1600, sha256: sha256(JSON.stringify(authorization)), headSha },
      historical, admission, historicalMarkdown, admissionMarkdown, intake,
    };
  } catch {
    return null;
  }
}

function authorizedRunEBudget(root, journal) {
  if (journal.round !== 2 || !Number.isInteger(journal.runs) || journal.runs < 0) return null;
  try {
    if (git(root, ['branch', '--show-current']) !== RUN_E_BRANCH
      || !onlyJournaledChanges(root, journal)
      || (journal.runs === 0 && git(root, ['diff', '--name-only', 'HEAD']))
      || git(root, ['ls-files', '--others', '--exclude-standard'])) return null;
    const proof = validateRunEAdmission(root, git(root, ['rev-parse', 'HEAD']));
    if (!proof || JSON.stringify(JSON.parse(readFileSync(join(root, '.feature/intake.json'), 'utf8')))
      !== JSON.stringify(JSON.parse(git(root, ['show', `${proof.grant.headSha}:${RUN_E_INTAKE}`])))) return null;
    if ((journal.runs > 0 && !journal.budgetAuthorization)
      || (journal.budgetAuthorization && (!sameGrant(journal.budgetAuthorization, proof.grant)
        || journal.budgetAuthorization.firstRun !== 1))) return null;
    return proof.grant;
  } catch {
    return null;
  }
}

/** Pure shape check shared with the checker; matching prose alone grants nothing. */
export function runCFourthAuthorization(sidecar) {
  if (sidecar?.mode !== 'feature' || sidecar.branch !== 'codex/owner-operator-run-c'
    || !Array.isArray(sidecar.inventory) || sidecar.inventory.length < 785
    || !Array.isArray(sidecar.authorizations)) return null;
  const identities = sidecar.inventory.slice(0, 785).map((row) => (
    { id: row?.id, file: row?.file, test: row?.test }
  ));
  if (sha256(JSON.stringify(identities)) !== '58454909c7c79f1f7b71c6a261fb3deab104d7bc36d5a0fa3ff6958e0a353c3b') return null;
  const matches = sidecar.authorizations.filter((entry) => entry?.id === RUN_C_FOURTH_AUTHORIZATION);
  const authorization = matches[0];
  if (matches.length !== 1 || authorization.date !== '2026-09-13'
    || authorization.text !== RUN_C_FOURTH_TEXT
    || Object.keys(authorization).sort().join(',') !== 'date,finding_ids,id,text'
    || !Array.isArray(authorization.finding_ids) || authorization.finding_ids.length !== 0) return null;
  return authorization;
}

function unchangedPrefix(original, current) {
  return Array.isArray(original) && Array.isArray(current) && current.length >= original.length
    && JSON.stringify(current.slice(0, original.length)) === JSON.stringify(original);
}

function sameGrant(previous, grant) {
  return previous?.id === grant.id && previous.sha256 === grant.sha256
    && previous.headSha === grant.headSha && previous.maxRuns === grant.maxRuns;
}

/** Read committed admission evidence, never the final report's self-asserted permission. */
function runCFourthProof(root, headSha) {
  try {
    if (git(root, ['branch', '--show-current']) !== 'codex/owner-operator-run-c'
      || git(root, ['merge-base', RUN_C_FOURTH_BASELINE, headSha]) !== RUN_C_FOURTH_BASELINE
      || git(root, ['merge-base', headSha, 'HEAD']) !== headSha) return null;
    const changed = git(root, ['diff', '--name-only', '--no-renames', RUN_C_FOURTH_BASELINE, headSha]);
    if (changed.split('\n').filter(Boolean).some((path) => !RUN_C_FOURTH_PATHS.has(path))) return null;
    if (git(root, ['rev-parse', `${RUN_C_FOURTH_BASELINE}:${RUN_C_REPORT}`]) !== RUN_C_HISTORY_BLOB) return null;
    if (git(root, ['rev-parse', `${RUN_C_FOURTH_BASELINE}:${RUN_C_MARKDOWN}`]) !== RUN_C_HISTORY_MARKDOWN_BLOB
      || git(root, ['rev-parse', `${headSha}:${RUN_C_MARKDOWN}`]) !== RUN_C_HISTORY_MARKDOWN_BLOB) return null;
    // Keep raw bytes: the usual git helper trims trailing newlines, which are
    // part of the historical narrative that the final report must preserve.
    const historicalMarkdown = execFileSync('git', ['cat-file', 'blob', RUN_C_HISTORY_MARKDOWN_BLOB], {
      cwd: root, maxBuffer: 64 * 1024 * 1024,
    });
    const historical = JSON.parse(git(root, ['show', RUN_C_HISTORY_BLOB]));
    const admission = JSON.parse(git(root, ['show', `${headSha}:${RUN_C_REPORT}`]));
    const authorization = runCFourthAuthorization(admission);
    if (!authorization || admission.round !== 3
      || admission.head_sha !== '2565c78585d6b08837e01dbb2a4a3ba3c265eff0'
      || admission.inventory.length !== 785
      || !unchangedPrefix(historical.authorizations, admission.authorizations)) return null;
    // Retain the entire measured report, including attempts and narrative evidence.
    const { authorizations: _historicalAuthorizations, ...historicalEvidence } = historical;
    const { authorizations: _admissionAuthorizations, ...admissionEvidence } = admission;
    if (JSON.stringify(historicalEvidence) !== JSON.stringify(admissionEvidence)) return null;
    return {
      admission,
      historicalMarkdown,
      grant: { id: authorization.id, maxRuns: 150, sha256: sha256(JSON.stringify(authorization)), headSha },
    };
  } catch {
    return null;
  }
}

function authorizedRunCFourthBudget(root, journal) {
  if (journal.round !== 4) return null;
  try {
    const proof = runCFourthProof(root, git(root, ['rev-parse', 'HEAD']));
    if (!proof || !onlyJournaledChanges(root, journal)
      || (journal.runs > 0 && !journal.budgetAuthorization)
      || (journal.budgetAuthorization && (!sameGrant(journal.budgetAuthorization, proof.grant)
        || journal.budgetAuthorization.firstRun !== 1))) return null;
    return proof.grant;
  } catch {
    return null;
  }
}

/** Final evidence may append results, but must corroborate the committed admission and launch pin. */
export function validRunCFourthReport(root, sidecar, sidecarPath, journal) {
  if (sidecarPath !== RUN_C_REPORT || sidecar?.round !== 4 || !runCFourthAuthorization(sidecar)) return false;
  const proof = runCFourthProof(root, sidecar.head_sha);
  if (!proof || journal?.round !== 4 || !sameGrant(journal.budgetAuthorization, proof.grant)
    || journal.budgetAuthorization.firstRun !== 1
    || !Number.isInteger(journal.runs) || journal.runs < 1 || journal.runs > 150) return false;
  try {
    const markdown = readFileSync(join(root, RUN_C_MARKDOWN));
    if (!markdown.subarray(0, proof.historicalMarkdown.length).equals(proof.historicalMarkdown)) return false;
  } catch {
    return false;
  }
  return ['inventory', 'findings', 'authorizations'].every((key) => unchangedPrefix(proof.admission[key], sidecar[key]))
    && ['mode', 'branch', 'run_id', 'fork_sha', 'merge_base_sha'].every((key) => sidecar[key] === proof.admission[key]);
}

function onlyJournaledChanges(root, journal) {
  if (git(root, ['diff', '--cached', '--name-only'])) return false;
  const changed = git(root, ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  return changed.every((path) => {
    const mutation = journal.mutations?.findLast((entry) => entry.path === path);
    return mutation?.state === 'applied'
      && mutation.originalOid === git(root, ['rev-parse', `HEAD:${path}`])
      && mutation.mutantOid === git(root, ['hash-object', '--', path]);
  });
}

function authorizedRunCBudget(root, journal) {
  if (journal.round !== 2) return null;
  try {
    if (git(root, ['branch', '--show-current']) !== 'codex/owner-operator-run-c') return null;
    const headSha = git(root, ['rev-parse', 'HEAD']);
    if (git(root, ['merge-base', RUN_C_BASELINE, headSha]) !== RUN_C_BASELINE) return null;
    const changedPaths = git(root, ['diff', '--name-only', '--no-renames', RUN_C_BASELINE, headSha]);
    if (changedPaths.split('\n').filter(Boolean).some((path) => !RUN_C_EXTENSION_PATHS.has(path))) return null;
    if (!onlyJournaledChanges(root, journal)) return null;
    // Approval must already be committed; an uncommitted sidecar cannot grant a budget.
    const sidecar = JSON.parse(git(root, ['show', `${headSha}:${RUN_C_REPORT}`]));
    if (sidecar.mode !== 'feature' || sidecar.branch !== 'codex/owner-operator-run-c'
      || sidecar.round !== 1 || sidecar.head_sha !== '5f2c201769ba982f49b9ecbd82678b45e75b19b1'
      || !Array.isArray(sidecar.inventory) || sidecar.inventory.length !== 710
      || !Array.isArray(sidecar.authorizations)) return null;
    const identities = sidecar.inventory.map(({ id, file, test }) => ({ id, file, test }));
    if (sha256(JSON.stringify(identities)) !== '0bf987c7d6f389894e1d23d7d221f1690933f600b37a235efb11af6f3685a35a') return null;
    const authorization = sidecar.authorizations.find((entry) => (
      entry?.id === RUN_C_AUTHORIZATION && entry.date === '2026-09-13' && entry.text === RUN_C_TEXT
    ));
    if (!authorization) return null;
    const grant = { id: authorization.id, maxRuns: 1500, sha256: sha256(JSON.stringify(authorization)), headSha };
    const previous = journal.budgetAuthorization;
    if (previous && (previous.id !== grant.id || previous.sha256 !== grant.sha256
      || previous.headSha !== headSha || previous.maxRuns !== grant.maxRuns)) return null;
    return grant;
  } catch {
    // Missing ancestry, malformed evidence or a changed inventory fails closed.
    return null;
  }
}

function authorizedBudget(root, journal) {
  if (journal.round === 4) return authorizedRunCFourthBudget(root, journal);
  if (journal.round === 2) return authorizedRunEBudget(root, journal) ?? authorizedRunDBudget(root, journal) ?? authorizedRunCBudget(root, journal);
  if (journal.round !== 1) return null;
  try {
    if (git(root, ['branch', '--show-current']) !== 'feat/1185') return null;
    const sidecar = JSON.parse(readFileSync(
      join(root, 'docs/reviews/red-team/feat-1185-67f43e/findings.json'), 'utf8',
    ));
    if (sidecar.mode !== 'feature' || sidecar.branch !== 'feat/1185' || sidecar.round !== 1
      || sidecar.head_sha !== '0b374b6a9b76ac4eee3222d84b47eae3e359bf4d'
      || !Array.isArray(sidecar.inventory) || sidecar.inventory.length !== 453
      || !Array.isArray(sidecar.authorizations)) return null;
    const identities = sidecar.inventory.map(({ id, file, test }) => ({ id, file, test }));
    if (sha256(JSON.stringify(identities)) !== '64929f4afa45ccdc52c8efc2da2e106729e569ed84863259d9bf990a5d9d9f1a') return null;
    const authorization = sidecar.authorizations.find((entry) => (
      entry?.id === CONTINUATION_AUTHORIZATION && entry.date === '2026-09-09'
      && entry.text === CONTINUATION_TEXT
    ));
    if (!authorization) return null;
    return { id: authorization.id, maxRuns: 1400, sha256: sha256(JSON.stringify(authorization)) };
  } catch {
    // Unreadable or malformed evidence never enlarges the cap.
    return null;
  }
}

/** The suffix that makes a stranded dotenv backup findable by the status checker. */
export const DOTENV_BACKUP_SUFFIX = '.red-team-backup';

/** A process serving or watching this worktree can execute a mutation under an unscrubbed env. */
export const WATCHER_PATTERNS = [
  /\bnext\s+dev\b/,
  /\bnext-server\b/,
  /\btsx\s+watch\b/,
  /\bpnpm\s+dev\b/,
  /\bpnpm\s+worker\b/,
  /\bdev-stack\.sh\b/,
  /\bplaywright\s+test\b/,
  /\bvitest\s+(?:--)?watch\b/,
];

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Vitest's `-t` is a REGULAR EXPRESSION filter, not a test identifier. An
 * unescaped title containing `(`, `+` or `?` selects the wrong set — or none.
 */
export function escapeTestName(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The minimal environment both the baseline and the mutant run under.
 *
 * An ALLOWLIST, never a denylist: a denylist that omits `ZERNIO_*` or
 * `SUPABASE_SERVICE_KEY` is a credential leak the day a new provider lands.
 * Without a validated local database the repo's own live-DB kill switch is set,
 * because `resolveTestDatabaseUrl()` falls back to reading `.env.local` off disk.
 */
export function buildRunEnv({ path, tmpHome, testDatabaseUrl = null, mockExternalApis = 'true' }) {
  if (!tmpHome) throw new Error('buildRunEnv needs a temporary HOME');
  const env = {
    PATH: path,
    HOME: tmpHome,
    TMPDIR: join(tmpHome, 'tmp'),
    NODE_ENV: 'test',
    CI: 'true',
    MOCK_EXTERNAL_APIS: mockExternalApis,
  };
  if (testDatabaseUrl === null) {
    env.REPWORTH_DISABLE_LIVE_DB_SUITES = '1';
  } else {
    assertLocalDatabaseUrl(testDatabaseUrl);
    env.TEST_DATABASE_POOL_URL = testDatabaseUrl;
    env.DATABASE_POOL_URL = testDatabaseUrl;
  }
  return env;
}

export function assertLocalDatabaseUrl(value) {
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error(`TEST_DATABASE_POOL_URL is not a URL: ${value}`);
  }
  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `refusing a non-local test database host '${host}' — a mutation removes the guard that `
      + 'made a remote endpoint safe',
    );
  }
  return true;
}

/**
 * `ps -Ao pid=,command=` rows that look like a server or watcher on this tree.
 *
 * `ignorePids` excludes THIS process and its ancestors, and it is not an
 * optimisation. Measured on a real machine: the shell that invoked the check was
 * itself reported, because its command line embedded a script containing the
 * literal text `next dev`. That is the same self-match that makes a grep-based
 * guard block its own documentation. Everything else still matches on substring,
 * deliberately — a false positive here refuses a run, which is the safe
 * direction; a false negative mutates code under a live hot-reloader.
 */
export function findWatchers(psOutput, ignorePids = new Set()) {
  return psOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const pid = Number(line.split(/\s+/)[0]);
      return !(Number.isFinite(pid) && ignorePids.has(pid));
    })
    .filter((line) => WATCHER_PATTERNS.some((pattern) => pattern.test(line)));
}

/** This process and every ancestor, so the checker never reports itself. */
export function selfAncestry(startPid = process.pid) {
  const pids = new Set();
  let pid = startPid;
  for (let depth = 0; depth < 32 && pid > 1; depth += 1) {
    pids.add(pid);
    const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parent = Number((result.stdout ?? '').trim());
    if (!Number.isFinite(parent) || parent <= 1 || pids.has(parent)) break;
    pid = parent;
  }
  return pids;
}

/**
 * Exactly one executed test, or the oracle proved nothing.
 *
 * `-t` is a regex, so a careless title can select a whole describe block; a kill
 * counted from that run says nothing about the test under examination.
 */
export function countExecutedTests(report) {
  const executed = [];
  for (const file of report?.testResults ?? []) {
    for (const assertion of file?.assertionResults ?? []) {
      if (assertion?.status === 'passed' || assertion?.status === 'failed') {
        executed.push(assertion.fullName ?? assertion.title ?? '<unnamed>');
      }
    }
  }
  return executed;
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

export function journalPathFor(root) {
  return join(root, '.feature', 'red-team-journal.json');
}

/** `round` defaults to 0: a journal that exists but has had no round opened yet. */
export function emptyJournal(round = 0) {
  return {
    version: 1,
    round,
    runs: 0,
    mutations: [],
    dotenv: { open: false, files: [] },
    supervisors: [],
  };
}

export function readJournal(root) {
  const path = journalPathFor(root);
  if (!existsSync(path)) return emptyJournal();
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Durable write: temp file, fsync, rename.
 *
 * The journal's whole value is surviving the process that wrote it, so a
 * buffered write that a crash discards would defeat the mechanism it exists for.
 */
export function writeJournal(root, journal) {
  const path = journalPathFor(root);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const descriptor = openSync(temporary, 'w');
  try {
    writeSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

// ---------------------------------------------------------------------------
// git and process probes
// ---------------------------------------------------------------------------

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function repoRoot(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
}

/** The process start time, second resolution. The PID-reuse guard. */
export function processStartTime(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Every RUNNING PID in `pgid`, from a portable `ps -Ao pid=,pgid=,stat=`.
 *
 * Zombies are excluded deliberately. A reaped-but-unwaited child still appears
 * in `ps` while its parent is busy, and it can no longer execute anything — so
 * counting it would make the finalizer report a group it had already emptied.
 */
export function groupMembers(pgid, psOutput = null) {
  const output = psOutput
    ?? spawnSync('ps', ['-Ao', 'pid=,pgid=,stat='], { encoding: 'utf8' }).stdout
    ?? '';
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]))
    .filter((parts) => !parts[2].startsWith('Z'))
    .filter((parts) => Number(parts[1]) === Number(pgid))
    .map((parts) => Number(parts[0]));
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

/**
 * Terminate and reap one journaled process group.
 *
 * Identity rule, and the two cases it separates:
 *  - the leader is ALIVE  → its start time must match the journal, or the PID
 *    was reused and this is a stranger's process. Refuse.
 *  - the leader is GONE but the group is not empty → POSIX forbids PGID reuse
 *    while a member lives, so the survivors are ours. Kill the group.
 */
export async function reapGroup(supervisor) {
  const { pid, pgid, startedAt } = supervisor;
  const leaderStart = processStartTime(pid);
  if (leaderStart !== null && leaderStart !== startedAt) {
    return { ok: false, reason: `pid ${pid} was reused (start time differs) — refusing to signal it` };
  }
  if (groupMembers(pgid).length === 0) return { ok: true, killed: 0 };

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') return { ok: false, reason: `kill ${signal} on ${pgid}: ${error.message}` };
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (groupMembers(pgid).length === 0) return { ok: true, killed: 1 };
      await sleep(100);
    }
  }
  const remaining = groupMembers(pgid);
  return remaining.length === 0
    ? { ok: true, killed: 1 }
    : { ok: false, reason: `process group ${pgid} still holds ${remaining.join(', ')}` };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function usage(message) {
  console.error('usage: mutation-runner.mjs <command> [options]');
  console.error('  commands: round-start | env | watchers | escape-test-name | assert-one-test |');
  console.error('            mutate | run | reap | finalize | dotenv-swap | dotenv-restore | status');
  if (message) console.error(`  ${message}`);
  process.exit(2);
}

function options(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      parsed._ = argv.slice(index + 1);
      break;
    }
    if (!token.startsWith('--')) usage(`unexpected argument '${token}'`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function commandEnv(root, parsed) {
  return buildRunEnv({
    path: process.env.PATH ?? '/usr/bin:/bin',
    tmpHome: parsed['tmp-home'] ? resolve(parsed['tmp-home']) : join(root, '.feature', 'red-team-home'),
    testDatabaseUrl: typeof parsed['test-db'] === 'string' ? parsed['test-db'] : null,
    mockExternalApis: typeof parsed['mock-external'] === 'string' ? parsed['mock-external'] : 'true',
  });
}

/**
 * TRUE when this branch's sidecar already records an owner authorization naming a
 * third round.
 *
 * It reads the sidecar rather than a flag or an env var on purpose: the
 * authorization has to survive in the committed evidence, where a reviewer sees it
 * beside the findings, and it has to exist BEFORE the round opens. Matching on
 * `branch` rather than re-deriving the slug keeps this from needing a second copy
 * of the checker's path logic — two derivations of one path can disagree, and a
 * disagreement here would either block a granted round or open an ungranted one.
 *
 * Fails CLOSED on anything it cannot read: no directory, no matching sidecar,
 * unparseable JSON, or no matching text all mean "not authorized".
 */
function hasThirdRoundAuthorization(root) {
  const reviewsDir = join(root, 'docs', 'reviews', 'red-team');
  if (!existsSync(reviewsDir)) return false;

  let branch;
  try {
    branch = git(root, ['branch', '--show-current']);
  } catch {
    return false;
  }
  if (!branch) return false;

  let entries;
  try {
    entries = readdirSync(reviewsDir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sidecarPath = join(reviewsDir, entry.name, 'findings.json');
    if (!existsSync(sidecarPath)) continue;
    let sidecar;
    try {
      sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    } catch {
      continue;
    }
    if (sidecar?.branch !== branch) continue;
    const authorizations = Array.isArray(sidecar.authorizations) ? sidecar.authorizations : [];
    if (authorizations.some((a) => /third round/i.test(String(a?.text ?? '')))) return true;
  }
  return false;
}

/**
 * Open a round: verify the journal is closed, then reset the run budget.
 *
 * The budget is "30 runs per ROUND", and the journal outlives a round — so
 * without this the second round would inherit the first round's counter and hit
 * the cap having executed nothing. Refusing to open over an unclean journal is
 * the same check in the other direction: a round must never start on top of an
 * unrestored mutation or an open dotenv swap.
 */
function cmdRoundStart(root) {
  const journal = readJournal(root);
  const branch = git(root, ['branch', '--show-current']);
  if (branch === RUN_E_BRANCH || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION) {
    // Opening a round discards its counter: an already pinned E grant cannot
    // re-enter admission even if its round number has been changed backwards.
    if (journal.budgetAuthorization) {
      console.error('round-start: REFUSED — Run E grant is already pinned and grants no third round');
      return 1;
    }
    if (!Number.isInteger(journal.round) || journal.round < 0
      || !Number.isInteger(journal.runs) || journal.runs < 0
      || (journal.round === 0 && journal.runs !== 0)) {
      console.error('round-start: REFUSED — malformed Run E round or run counter');
      return 1;
    }
  }
  const blockers = [];
  if (journal.dotenv?.open === true) blockers.push('the dotenv swap is still open');
  for (const entry of journal.mutations ?? []) {
    if (entry.state !== 'restored') {
      blockers.push(`mutation of ${entry.path} is journaled '${entry.state}', not 'restored'`);
    }
  }
  for (const supervisor of journal.supervisors ?? []) {
    if (supervisor.active === true) {
      blockers.push(`supervisor pgid ${supervisor.pgid} is still journaled active`);
    }
  }
  if (blockers.length > 0) {
    console.error('round-start: REFUSED — the previous round did not finalize');
    for (const blocker of blockers) console.error(`  ${blocker}`);
    console.error('  Run `finalize` and resolve any abort before opening a new round.');
    return 1;
  }
  const round = (journal.round ?? 0) + 1;
  if (runEThirdRoundForbidden(git(root, ['branch', '--show-current']), journal.budgetAuthorization?.id, round)) {
    console.error('round-start: REFUSED — Run E authorization grants no third round');
    return 1;
  }
  // The Run D grant itself says "no third round"; the legacy text matcher
  // must never interpret that denial as permission to open another round.
  if (round >= 3 && (git(root, ['branch', '--show-current']) === RUN_D_BRANCH
    || journal.budgetAuthorization?.id === RUN_D_AUTHORIZATION)) {
    console.error('round-start: REFUSED — Run D authorization grants no third round');
    return 1;
  }
  // Two rounds is still what a run reaches on its own. A THIRD opens only on an
  // owner authorization already recorded in the sidecar. Only the explicitly
  // approved Run C fourth-round contract below extends that ceiling.
  //
  // Why the exception exists (#1184, after the same wall on #1178 and #1186): a
  // round-2 finding whose fix touches the tree makes the sidecar stale by
  // construction, and with no third round the only ways out were to leave a known
  // defect unfixed or to hand-edit `head_sha` — an evidence file rewriting its own
  // provenance. The escape is deliberately not free: the authorization must ALREADY
  // be in the sidecar before the round opens, so a third round is something the
  // owner granted rather than something a stuck agent decided for itself.
  const fourthGrant = round === 4
    ? authorizedRunCFourthBudget(root, { ...journal, round: 4, runs: 0, budgetAuthorization: undefined })
    : null;
  if (round > 3 && !fourthGrant) {
    console.error(`round-start: REFUSED — round ${round} exceeds the hard cap of 3`);
    return 1;
  }
  if (round === 3 && !hasThirdRoundAuthorization(root)) {
    console.error('round-start: REFUSED — a third round needs a recorded owner authorization');
    console.error("  Add an entry to the sidecar's `authorizations` array whose text names the");
    console.error('  third round (e.g. "third round authorized"), then re-run round-start.');
    return 1;
  }
  writeJournal(root, emptyJournal(round));
  console.log(`round-start: round ${round} open, ${fourthGrant?.maxRuns ?? MAX_RUNS_PER_ROUND} mutation runs available`);
  return 0;
}

function cmdEnv(root, parsed) {
  const env = commandEnv(root, parsed);
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  console.log(JSON.stringify(env, null, 2));
  return 0;
}

function cmdWatchers(parsed) {
  const output = typeof parsed['ps-source'] === 'string'
    ? readFileSync(resolve(parsed['ps-source']), 'utf8')
    : (spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '');
  const matches = findWatchers(
    output,
    typeof parsed['ps-source'] === 'string' ? new Set() : selfAncestry(),
  );
  if (matches.length === 0) {
    console.log('watchers: none — no dev server, watch worker, or E2E server is serving this worktree');
    return 0;
  }
  console.error('watchers: ABORT — a process is watching or serving this worktree:');
  for (const line of matches) console.error(`  ${line}`);
  console.error('  Hot reload can execute a mutation under that process\'s unscrubbed environment.');
  return 1;
}

function cmdAssertOneTest(parsed) {
  if (typeof parsed.report !== 'string') usage('assert-one-test needs --report <json-file>');
  let report;
  try {
    report = JSON.parse(readFileSync(resolve(parsed.report), 'utf8'));
  } catch (error) {
    console.error(`assert-one-test: unreadable report — ${error.message}`);
    return 1;
  }
  const executed = countExecutedTests(report);
  if (executed.length === 1) {
    console.log(`assert-one-test: exactly one test executed — ${executed[0]}`);
    return 0;
  }
  console.error(`assert-one-test: INCONCLUSIVE — ${executed.length} test(s) executed, expected exactly 1`);
  for (const name of executed.slice(0, 5)) console.error(`  ${name}`);
  return 1;
}

function cmdMutate(root, parsed) {
  if (typeof parsed.file !== 'string' || typeof parsed.mutant !== 'string') {
    usage('mutate needs --file <tracked-path> --mutant <file-holding-the-mutant>');
  }
  const target = resolve(root, parsed.file);
  if (!existsSync(target)) {
    console.error(`mutate: ${parsed.file} does not exist`);
    return 1;
  }
  const mutantSource = readFileSync(resolve(parsed.mutant));

  // The original blob is written into the object database BEFORE the mutation,
  // so the finalizer can always restore it even from a fresh process.
  const originalOid = git(root, ['hash-object', '-w', '--', target]);
  const journal = readJournal(root);
  journal.mutations.push({
    path: parsed.file,
    originalOid,
    patchSha256: sha256(mutantSource),
    mutantOid: null,
    state: 'pending',
    at: new Date().toISOString(),
  });
  writeJournal(root, journal);

  writeFileSync(target, mutantSource);
  const mutantOid = git(root, ['hash-object', '-w', '--', target]);
  const entry = journal.mutations[journal.mutations.length - 1];
  entry.mutantOid = mutantOid;
  entry.state = 'applied';
  writeJournal(root, journal);

  console.log(`mutate: ${parsed.file} ${originalOid.slice(0, 12)} -> ${mutantOid.slice(0, 12)}`);
  return 0;
}

async function cmdRun(root, parsed) {
  const argv = parsed._;
  if (argv.length === 0) usage('run needs the command after `--`');
  const journal = readJournal(root);
  const authorization = authorizedBudget(root, journal);
  const runEBranch = git(root, ['branch', '--show-current']) === RUN_E_BRANCH;
  if (((runEBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION)
    && (!authorization || journal.round !== 2 || authorization.id !== RUN_E_AUTHORIZATION)) {
    console.error('run: Run E second-pass authorization, evidence or pinned HEAD invalid; refusing launch');
    return 1;
  }
  const runDBranch = git(root, ['branch', '--show-current']) === RUN_D_BRANCH;
  if (((runDBranch && journal.round !== 1) || journal.budgetAuthorization?.id === RUN_D_AUTHORIZATION)
    && (!authorization || journal.round !== 2 || authorization.id !== RUN_D_AUTHORIZATION)) {
    console.error('run: Run D second-pass authorization, evidence or pinned HEAD invalid; refusing launch');
    return 1;
  }
  if ((journal.round >= 4 || journal.budgetAuthorization?.id === RUN_C_FOURTH_AUTHORIZATION)
    && (!authorization || journal.round !== 4 || !Number.isInteger(journal.runs) || journal.runs < 0)) {
    console.error('run: Run C fourth-round authorization or pinned HEAD invalid; refusing launch');
    return 1;
  }
  if (journal.budgetAuthorization?.id === RUN_C_AUTHORIZATION && !authorization) {
    console.error('run: Run C budget authorization or pinned HEAD changed; refusing another launch');
    return 1;
  }
  if (!authorization && journal.round === 2
    && git(root, ['branch', '--show-current']) === 'codex/owner-operator-run-c') {
    console.error('run: Run C startup preconditions failed; refusing the first launch');
    return 1;
  }
  const maxRuns = authorization?.maxRuns ?? MAX_RUNS_PER_ROUND;
  if (journal.runs >= maxRuns) {
    console.error(`run: mutation budget exhausted (${maxRuns} runs this round)`);
    console.error('  Mark the remaining candidates skipped-budget; the status becomes INCOMPLETE_BUDGET.');
    return 1;
  }
  const timeout = Number(parsed.timeout ?? RUN_TIMEOUT_MS);
  const env = commandEnv(root, parsed);
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });

  // A PAUSED supervisor: `sh` blocks on a read, so the parent can journal its
  // identity before anything runs. `exec` then preserves that identity.
  // `--no-release` deliberately LEAVES the supervisor paused, so its output
  // streams are discarded rather than inherited: an orphan holding the parent's
  // pipes open would make the caller wait for a process it just abandoned.
  const paused = parsed['no-release'] === true;
  const supervisor = spawn(
    '/bin/sh',
    ['-c', 'read RELEASE || exit 0; exec "$@"', 'red-team-supervisor', ...argv],
    {
      cwd: root,
      detached: true,
      env,
      stdio: paused ? ['pipe', 'ignore', 'ignore'] : ['pipe', 'inherit', 'inherit'],
    },
  );
  const pid = supervisor.pid;
  const startedAt = processStartTime(pid);
  journal.runs += 1;
  if (authorization && !journal.budgetAuthorization) {
    journal.budgetAuthorization = { ...authorization, firstRun: journal.runs };
  }
  journal.supervisors.push({
    pid,
    pgid: pid,
    startedAt,
    active: true,
    command: argv[0],
    at: new Date().toISOString(),
  });
  writeJournal(root, journal);

  if (paused) {
    supervisor.unref();
    supervisor.stdin.end();
    console.log(`run: supervisor ${pid} journaled and left PAUSED (--no-release)`);
    return 0;
  }

  supervisor.stdin.write('go\n');
  supervisor.stdin.end();

  const outcome = await new Promise((resolveRun) => {
    const timer = setTimeout(() => resolveRun({ timedOut: true }), timeout);
    supervisor.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ timedOut: false, code, signal });
    });
  });

  const reaped = await reapGroup({ pid, pgid: pid, startedAt });
  const current = readJournal(root);
  const record = current.supervisors.find((entry) => entry.pid === pid);
  if (record) record.active = !reaped.ok;
  writeJournal(root, current);

  if (!reaped.ok) {
    console.error(`run: could not reap the process group — ${reaped.reason}`);
    return 1;
  }
  if (outcome.timedOut) {
    console.error(`run: TIMEOUT after ${timeout}ms; the whole process group was terminated and reaped`);
    return 124;
  }
  console.log(`run: exited code=${outcome.code} signal=${outcome.signal ?? 'none'} (group reaped)`);
  return outcome.code === 0 ? 0 : 1;
}

async function cmdReap(root) {
  const journal = readJournal(root);
  const failures = [];
  for (const supervisor of journal.supervisors) {
    if (supervisor.active !== true) continue;
    const result = await reapGroup(supervisor);
    if (result.ok) supervisor.active = false;
    else failures.push(result.reason);
  }
  writeJournal(root, journal);
  if (failures.length > 0) {
    console.error('reap: FAILED');
    for (const reason of failures) console.error(`  ${reason}`);
    return 1;
  }
  console.log(`reap: every journaled process group is empty (${journal.supervisors.length} recorded)`);
  return 0;
}

function restoreMutations(root, journal) {
  const failures = [];
  const restored = [];
  for (const entry of journal.mutations) {
    if (entry.state === 'restored') continue;
    const target = resolve(root, entry.path);
    if (!existsSync(target)) {
      failures.push(`${entry.path} is missing — refusing to recreate it`);
      continue;
    }
    const current = git(root, ['hash-object', '--', target]);
    if (current === entry.originalOid) {
      entry.state = 'restored';
      continue;
    }
    if (current !== entry.mutantOid) {
      // NEITHER the original nor the mutant we journaled. Foreign content is
      // never overwritten: an unrelated edit made during the run would be lost.
      failures.push(
        `${entry.path} holds neither the original (${entry.originalOid.slice(0, 12)}) nor the `
        + `journaled mutant (${String(entry.mutantOid).slice(0, 12)}) — ABORT, nothing touched`,
      );
      continue;
    }
    const original = execFileSync('git', ['cat-file', 'blob', entry.originalOid], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(target, original);
    const verified = git(root, ['hash-object', '--', target]);
    if (verified !== entry.originalOid) {
      failures.push(`${entry.path} did not verify after restore (${verified.slice(0, 12)})`);
      continue;
    }
    entry.state = 'restored';
    restored.push(entry.path);
  }
  return { failures, restored };
}

function restoreDotenv(root, journal) {
  const failures = [];
  const restored = [];
  for (const file of journal.dotenv.files) {
    const target = resolve(root, file.path);
    const backup = resolve(root, file.backupPath);
    if (!existsSync(backup)) {
      // The backup is gone. Two very different worlds, told apart by the one
      // hash the journal DOES carry:
      //
      //   * the destination is NOT the scrubbed copy → someone already put the
      //     real file back by hand (the documented resolution after an abort).
      //     Accept it and close the entry. Without this the journal stays open
      //     forever and every transition fails with no way out — measured, not
      //     hypothesised.
      //   * the destination IS still the scrubbed copy → the real content is
      //     gone. That stays a hard failure; closing it would bless a scrubbed
      //     dotenv as if it were the operator's own file.
      if (existsSync(target) && sha256(readFileSync(target)) !== file.scrubbedSha256) {
        restored.push(`${file.path} (already restored by hand)`);
        continue;
      }
      failures.push(
        `${file.backupPath} is gone and ${file.path} is still the scrubbed copy — the real `
        + 'file is LOST; restore it from your own backup before any transition',
      );
      continue;
    }
    if (existsSync(target)) {
      const actual = sha256(readFileSync(target));
      if (actual !== file.scrubbedSha256) {
        // Someone edited the scrubbed file during the run. Keeping both beats
        // silently discarding an edit we cannot read.
        failures.push(
          `${file.path} no longer matches the scrubbed copy this run wrote — ABORT, both files kept`,
        );
        continue;
      }
      rmSync(target);
    }
    renameSync(backup, target);
    restored.push(file.path);
  }
  if (failures.length === 0) {
    journal.dotenv = { open: false, files: [] };
  }
  return { failures, restored };
}

async function cmdFinalize(root) {
  const reapCode = await cmdReap(root);
  if (reapCode !== 0) {
    console.error('finalize: ABORT — a process group is still live; files were NOT restored');
    return 1;
  }
  const journal = readJournal(root);
  const mutations = restoreMutations(root, journal);
  const dotenv = restoreDotenv(root, journal);
  writeJournal(root, journal);

  const failures = [...mutations.failures, ...dotenv.failures];
  if (failures.length > 0) {
    console.error(`finalize: FAILED (${failures.length} issue(s))`);
    for (const reason of failures) console.error(`  ${reason}`);
    console.error('  Resolve by hand. Never let a report be written over an unrestored tree.');
    return 1;
  }
  console.log(
    `finalize: restored ${mutations.restored.length} mutated file(s) and `
    + `${dotenv.restored.length} dotenv file(s); journal closed`,
  );
  return 0;
}

function cmdDotenvSwap(root, parsed) {
  const names = typeof parsed.files === 'string' ? parsed.files.split(',') : ['.env.local', '.env'];
  const journal = readJournal(root);
  if (journal.dotenv.open === true) {
    console.error('dotenv-swap: a swap is already open — run dotenv-restore first');
    return 1;
  }
  const scrubbed = [
    '# red-team scrubbed replacement. The real file is at the journaled backup path.',
    'MOCK_EXTERNAL_APIS=true',
    ...(typeof parsed['test-db'] === 'string' ? [`TEST_DATABASE_POOL_URL=${parsed['test-db']}`] : []),
    '',
  ].join('\n');
  if (typeof parsed['test-db'] === 'string') assertLocalDatabaseUrl(parsed['test-db']);

  const files = [];
  for (const name of names) {
    const target = resolve(root, name);
    if (!existsSync(target)) continue;
    const backupPath = `${name}${DOTENV_BACKUP_SUFFIX}`;
    const backup = resolve(root, backupPath);
    if (existsSync(backup)) {
      console.error(`dotenv-swap: ${backupPath} already exists — an earlier run did not finalize`);
      return 1;
    }
    // Rename FIRST: the real file is never overwritten in place, so a crash
    // between the two steps leaves it recoverable at the backup path.
    renameSync(target, backup);
    writeFileSync(target, scrubbed);
    files.push({ path: name, backupPath, scrubbedSha256: sha256(scrubbed) });
  }
  journal.dotenv = { open: files.length > 0, files };
  writeJournal(root, journal);
  console.log(`dotenv-swap: swapped ${files.length} file(s): ${files.map((f) => f.path).join(', ') || 'none'}`);
  return 0;
}

function cmdDotenvRestore(root) {
  const journal = readJournal(root);
  const result = restoreDotenv(root, journal);
  writeJournal(root, journal);
  if (result.failures.length > 0) {
    console.error('dotenv-restore: FAILED');
    for (const reason of result.failures) console.error(`  ${reason}`);
    return 1;
  }
  console.log(`dotenv-restore: restored ${result.restored.length} file(s)`);
  return 0;
}

async function main(argv) {
  const command = argv[0];
  if (!command || command.startsWith('--')) usage('a command is required');
  const parsed = options(argv.slice(1));
  const root = repoRoot();

  switch (command) {
    case 'round-start': return cmdRoundStart(root);
    case 'env': return cmdEnv(root, parsed);
    case 'watchers': return cmdWatchers(parsed);
    case 'escape-test-name': {
      const name = parsed._[0] ?? parsed.name;
      if (typeof name !== 'string') usage('escape-test-name needs -- <name>');
      console.log(escapeTestName(name));
      return 0;
    }
    case 'assert-one-test': return cmdAssertOneTest(parsed);
    case 'mutate': return cmdMutate(root, parsed);
    case 'run': return cmdRun(root, parsed);
    case 'reap': return cmdReap(root);
    case 'finalize': return cmdFinalize(root);
    case 'dotenv-swap': return cmdDotenvSwap(root, parsed);
    case 'dotenv-restore': return cmdDotenvRestore(root);
    case 'status': {
      console.log(JSON.stringify(readJournal(root), null, 2));
      return 0;
    }
    default: return usage(`unknown command '${command}'`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(`mutation-runner: ${error.message}`);
    process.exit(1);
  }
}
