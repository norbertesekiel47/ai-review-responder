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

/**
 * Ordinary budget: 20 minutes of MEASURED test time per round, ≤120s per launch.
 *
 * The budget was once a count — 30 launches, sized for the 120s worst case (an
 * hour). Measured on feat/safety-review-auto-approval (2026-09-18), a launch
 * takes 2.8s, so 30 of them bought 1.4 minutes: an 85-row inventory needed three
 * rounds and an owner grant and still ended INCOMPLETE_BUDGET with 28 rows
 * unmeasured. #1185, #1189, #1190 and Runs C, D and E each needed a one-off
 * extension for the same reason. Time is what the cap was protecting, so time
 * is what it now counts. MAX_RUNS_PER_ROUND stays as a backstop against a loop
 * of instant commands; at the measured rate it does not bind before the clock.
 *
 * The owner-granted budgets below are closed, branch-pinned history. They keep
 * their launch counts, and their literal 30s are their own checkpoints.
 */
export const ROUND_TIME_BUDGET_MS = 20 * 60_000;
export const MAX_RUNS_PER_ROUND = 400;
export const RUN_TIMEOUT_MS = 120_000;

/**
 * Test time this round has spent on the ordinary budget. A launch that never
 * recorded its end (a crash, a `--no-release` pause, a journal from before this
 * field existed) is charged its whole timeout: an unknown cost is the worst one.
 */
export function ordinaryTimeSpentMs(journal) {
  return (journal.supervisors ?? []).reduce((total, entry) => total
    + (Number.isFinite(entry.elapsedMs) ? entry.elapsedMs : entry.timeoutMs ?? RUN_TIMEOUT_MS), 0);
}

// This is a continuation of the restored thirty-launch checkpoint, not a new
// round. The first committed manifest is immutable, including on renamed branches.
export const OPERATOR_CONTINUATION_ID = 'operator-fallow-round-1-continuation-2026-09-15';
const OPERATOR_BRANCH = 'codex/operator-fallow-refactor';
const OPERATOR_BASELINE = '2ac6ff871b4496f996c37aaaaade9bdc7eee9a62';
const OPERATOR_CHECKPOINT = '8660fd1d01e35c22b9142b4fc2a020c05946f1c5';
const OPERATOR_SCHEDULE = ['15a5f447f9c415be5671ddd432917f472f939b9f', '8ea2ac28f49724dd6df65435fe956d781dd72638'];
const OPERATOR_REVIEW = 'docs/reviews/codex-operator-fallow-refactor/budget-extension-review.md';
const OPERATOR_REPORT = 'docs/reviews/red-team/codex-operator-fallow-refactor-3b29b6/findings.json';
const OPERATOR_MARKDOWN = OPERATOR_REPORT.replace('.json', '.md');
const OPERATOR_INTAKE = 'docs/superpowers/plans/codex-operator-fallow-refactor-intake.json';
const OPERATOR_APPROVAL = '[@Computer](plugin://computer-use@openai-bundled) you can proceed and finish the remaining work please';
const OPERATOR_VERIFIER_TESTS = ['scripts/ci/__tests__/red-team-mutation-runner.test.ts', 'scripts/ci/__tests__/red-team-status.test.ts'];
const OPERATOR_AXES = ['spec-correctness', 'security', 'database', 'standards-maintainability']
  .map((axis) => `docs/reviews/codex-operator-fallow-refactor/${axis}.md`);
const OPERATOR_BROWSER_PATHS = ['docs/reviews/codex-operator-fallow-refactor/browser-verification.md',
  ...['before', 'after'].flatMap((state) => ['proposal', 'receipt'].flatMap((view) => [390, 1440]
    .map((width) => `docs/reviews/codex-operator-fallow-refactor/browser-${state}-${view}-${width}.png`)))];
const OPERATOR_DISCOVERY_IDS = [[46, 46], [55, 55], [63, 65], [73, 79], [81, 87], [109, 116],
  [125, 125], [128, 128], [132, 133], [136, 136], [145, 154], [172, 172], [175, 190],
  [192, 193], [195, 195], [201, 201], [208, 208], [210, 246], [276, 279], [310, 332],
  [334, 334], [342, 343], [346, 501]]
  .flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, index) => `rt-${String(first + index).padStart(4, '0')}`));
const OPERATOR_DISCOVERY_CORRECTIONS_SHA256 = 'cb2c6819986e93c46e4a9c928c83974429696e00044404b78ac50a67e22c6c60';
const OPERATOR_DISCOVERY_PROPOSAL_SHA256 = 'f8b5181724be926ee0d6a732d56b40a2c62678d824e76ca161176e12e81de637';
const OPERATOR_ADDITIONAL_DISCOVERY_IDS = [8, 18, 19, 21, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 34, 42, 43, 47, 48, 49, 50, 51, 52, 53, 54, 119, 131, 135, 143, 163, 171, 194, 196, 197, 199, 202, 207, 209, 257, 272, 282, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 338, 339, 340]
  .map((id) => `rt-${String(id).padStart(4, '0')}`);
const OPERATOR_ADDITIONAL_CORRECTIONS_SHA256 = '5ef86e871b2f321bdd70694555205a2098a9c549f66dd57f10f624651dd70482';
const OPERATOR_ADDITIONAL_PROPOSAL_SHA256 = '47a86bfaeaf00295109a950da50d6ab3dfa540fb547b440f586ca5889ef96440';
const OPERATOR_PATHS = new Set([
  '.agents/skills/red-team/scripts/mutation-runner.mjs', '.agents/skills/feature/scripts/red-team-status.mjs',
  ...OPERATOR_VERIFIER_TESTS, '.agents/skills/red-team/SKILL.md', '.claude/skills/red-team/SKILL.md',
  OPERATOR_REVIEW, OPERATOR_REPORT, OPERATOR_MARKDOWN, OPERATOR_INTAKE,
  OPERATOR_INTAKE.replace('-intake.json', '-deviations.md'), ...OPERATOR_AXES, ...OPERATOR_BROWSER_PATHS,
]);

function operatorBlob(root, revision, path) {
  return execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
}

function operatorAdmissionHead(root) {
  return git(root, ['log', '--first-parent', '--diff-filter=A', '--format=%H', 'HEAD', '--', OPERATOR_REVIEW])
    .split('\n').filter(Boolean).at(-1) ?? null;
}

/**
 * The continuation is finished once its admission commit is on origin/main:
 * #1297 squash-merged the review into main, so every later branch carries the
 * file and presence alone would claim them all (#1302). Any other git answer —
 * not an ancestor, or no origin/main ref at all — keeps the lineage fail-closed.
 */
function operatorAdmissionMerged(root, admissionHead) {
  const probe = spawnSync('git', ['merge-base', '--is-ancestor', admissionHead, 'refs/remotes/origin/main'], {
    cwd: root, stdio: 'ignore', timeout: 10_000,
  });
  return !probe.error && probe.status === 0;
}

export function requiresOperatorContinuation(root, journal) {
  if (journal?.budgetAuthorization?.id === OPERATOR_CONTINUATION_ID) return true;
  try {
    if (git(root, ['branch', '--show-current']) === OPERATOR_BRANCH) return true;
    const admissionHead = operatorAdmissionHead(root);
    return admissionHead !== null && !operatorAdmissionMerged(root, admissionHead);
  } catch { return false; }
}

function operatorIdentity(row) {
  return { id: row.id, file: row.file, test: row.test };
}

function operatorArtifact(reference, prefix = '') {
  const path = reference?.[`${prefix}Path`];
  const digest = reference?.[`${prefix}Sha256`];
  if (typeof path !== 'string' || !/^[a-f0-9]{64}$/.test(digest ?? '')) return null;
  try {
    const bytes = readFileSync(path);
    return sha256(bytes) === digest ? bytes : null;
  } catch { return null; }
}

/** Pure checkpoint validation is also exercised against synthetic, isolated fixtures. */
export function validateOperatorHistory(manifest, historical, journal) {
  const checkpoint = manifest.checkpointJournal;
  if (checkpoint?.version !== 1 || checkpoint.round !== 1 || checkpoint.runs !== 30
    || checkpoint.mutations?.length !== 15 || checkpoint.supervisors?.length !== 30
    || checkpoint.dotenv?.open !== false || checkpoint.mutations.some((entry) => entry.state !== 'restored')
    || checkpoint.supervisors.some((entry) => entry.active !== false)
    || sha256(JSON.stringify(checkpoint)) !== manifest.journalSha256
    || historical.inventory?.length !== 501
    || sha256(JSON.stringify(historical.inventory.map(operatorIdentity))) !== manifest.inventorySha256
    || !Array.isArray(manifest.suffix) || manifest.suffix.some((row) => !OPERATOR_VERIFIER_TESTS.includes(row.file))
    || !Array.isArray(manifest.legacyAttempts) || manifest.legacyAttempts.length !== 15) return null;
  const inventory = [...historical.inventory.map(operatorIdentity), ...manifest.suffix];
  const ids = new Set();
  const selectors = new Set();
  for (const row of inventory) {
    if (typeof row.id !== 'string' || !row.id || typeof row.test !== 'string' || !row.test
      || typeof row.file !== 'string' || row.file !== row.file.replace(/\\/g, '/')
      || row.file.split('/').some((part) => !part || part === '.' || part === '..')
      || Object.keys(operatorIdentity(row)).some((key) => typeof row[key] !== 'string')
      || ids.has(row.id) || selectors.has(`${row.file}\0${escapeTestName(row.test)}`)) return null;
    ids.add(row.id);
    selectors.add(`${row.file}\0${escapeTestName(row.test)}`);
  }
  const attempts = new Map();
  const launches = new Set();
  for (const [index, mapping] of manifest.legacyAttempts.entries()) {
    const candidate = inventory.find((row) => row.id === mapping.candidateId);
    const nextAttempt = (attempts.get(mapping.candidateId) ?? 0) + 1;
    if (!candidate || mapping.mutationIndex !== index || mapping.selector !== escapeTestName(candidate.test)
      || mapping.attempt !== nextAttempt || nextAttempt > 2) return null;
    attempts.set(candidate.id, nextAttempt);
    for (const phase of ['baseline', 'mutant']) {
      const result = mapping[phase];
      if (!Number.isInteger(result?.launch) || result.launch < 1 || result.launch > 30
        || launches.has(result.launch) || result.launch !== index * 2 + (phase === 'baseline' ? 1 : 2)
        || !operatorArtifact(result, 'log')
        || ((result.resultPath !== null || result.resultSha256 !== null) && !operatorArtifact(result, 'result'))) return null;
      launches.add(result.launch);
    }
  }
  if (journal?.version !== 1 || journal.round !== 1 || !Number.isInteger(journal.runs)
    || journal.runs < 30 || journal.runs > 1500 || journal.supervisors?.length !== journal.runs
    || !unchangedPrefix(checkpoint.mutations, journal.mutations)
    || !unchangedPrefix(checkpoint.supervisors, journal.supervisors)) return null;
  for (const mutation of journal.mutations.slice(15)) {
    const candidate = inventory.find((row) => row.id === mutation.candidateId);
    const nextAttempt = (attempts.get(mutation.candidateId) ?? 0) + 1;
    if (!candidate || mutation.selector !== operatorCandidateSelector(candidate, mutation.selectorCorrection) || mutation.attempt !== nextAttempt
      || nextAttempt > 2 || mutation.target !== mutation.path
      || !/^[a-f0-9]{40}$/.test(mutation.originalOid ?? '')
      || !/^[a-f0-9]{64}$/.test(mutation.mutantSha256 ?? '')) return null;
    attempts.set(candidate.id, nextAttempt);
  }
  return { inventory, attempts };
}

/** Reconstruct the two retained duplicate-token edits without changing their immutable blob pins. */
export function operatorLegacyReconstruction(id, original, from, to, mutant) {
  if (typeof from !== 'string' || !from || typeof to !== 'string') return false;
  const parts = original.split(from);
  if (parts.length === 2) return original.replace(from, to) === mutant;
  if (parts.length !== 3) return false;
  if (id === 'rt-0127' && from === 'actorName: facts.actorName,' && to === 'actorName: null,') {
    return `${parts[0]}${to}${parts[1]}${from}${parts[2]}` === mutant;
  }
  if (id === 'rt-0142' && from === 'if (!write.ok) return write.result;'
    && to === "if (!write.ok) return { kind: 'not_found' } as ApplyResult;") {
    return `${parts[0]}${from}${parts[1]}${to}${parts[2]}` === mutant;
  }
  return false;
}

const OPERATOR_USED_ADMISSION = '03502fdcee60e61b891636a625c95c6a9dadec9b';
const OPERATOR_FILE_CORRECTION = 'operator-fallow-round-1-file-accounting-42';
const OPERATOR_FILE_CHECKPOINT_SHA256 = '91b56fcabdcc94a08d0fa18cce3db5e8fc3f287eb32148cc3fe5036432cc2e8b';
const OPERATOR_FILE_EVIDENCE_SHA256 = 'e66e50ea3da81d9057d823f25e9870f61ebe10e296a10504f811a83ceecde359';
const OPERATOR_CONTROL_PATHS = ['.agents/skills/red-team/scripts/mutation-runner.mjs',
  '.agents/skills/feature/scripts/red-team-status.mjs', ...OPERATOR_VERIFIER_TESTS];

/** The used checkpoint is retained in full; only later mutation/launch rows may append. */
export function operatorCorrectionHistory(checkpoint, journal) {
  return checkpoint?.version === 1 && checkpoint.round === 1 && checkpoint.runs === 42
    && checkpoint.mutations?.length === 21 && checkpoint.supervisors?.length === 42
    && checkpoint.dotenv?.open === false && checkpoint.mutations.every((row) => row.state === 'restored')
    && checkpoint.supervisors.every((row) => row.active === false)
    && journal?.version === 1 && journal.round === 1 && Number.isInteger(journal.runs)
    && journal.runs >= 42 && journal.runs <= 1500 && journal.supervisors?.length === journal.runs
    && JSON.stringify(journal.budgetAuthorization) === JSON.stringify(checkpoint.budgetAuthorization)
    && unchangedPrefix(checkpoint.mutations, journal.mutations)
    && unchangedPrefix(checkpoint.supervisors, journal.supervisors);
}

const OPERATOR_USED_FILE_CONTROL = 'e3bd968ae9fca8e0d787291cf067c266e67d89f9';
const OPERATOR_SELECTION_CORRECTION = 'operator-fallow-round-1-selection-and-resolves';
// Replaced only after the completed, restored campaign checkpoint is frozen and reviewed.
const OPERATOR_SELECTION_CHECKPOINT_SHA256 = '0942d85131597e501bf50f38d0f4868d02d007e8f0e37ee9efc051ba227a4d6e';

/** Only the identified prefix collision receives an anchored selector. */
export function operatorCandidateSelector(candidate, correctionId) {
  const selector = escapeTestName(candidate.test);
  return candidate.id === 'rt-0103' && correctionId === OPERATOR_SELECTION_CORRECTION ? `^${selector}$` : selector;
}

export function operatorSelectionHistory(checkpoint, journal) {
  return checkpoint?.version === 1 && checkpoint.round === 1 && Number.isInteger(checkpoint.runs)
    && checkpoint.runs > 42 && checkpoint.runs <= 1500 && checkpoint.supervisors?.length === checkpoint.runs
    && checkpoint.dotenv?.open === false && checkpoint.mutations?.every((row) => row.state === 'restored')
    && checkpoint.supervisors.every((row) => row.active === false)
    && journal?.version === 1 && journal.round === 1 && Number.isInteger(journal.runs)
    && journal.runs >= checkpoint.runs && journal.runs <= 1500 && journal.supervisors?.length === journal.runs
    && JSON.stringify(journal.budgetAuthorization) === JSON.stringify(checkpoint.budgetAuthorization)
    && unchangedPrefix(checkpoint.mutations, journal.mutations)
    && unchangedPrefix(checkpoint.supervisors, journal.supervisors);
}

function operatorSelectionControl(root, prior, descendants, journal) {
  const controlHead = descendants[0];
  if (prior.controlHead !== OPERATOR_USED_FILE_CONTROL || !controlHead
    || git(root, ['show', '-s', '--format=%P', controlHead]) !== OPERATOR_USED_FILE_CONTROL) return null;
  const document = operatorBlob(root, controlHead, OPERATOR_REVIEW);
  if (!document.subarray(0, prior.document.length).equals(prior.document)) return null;
  const matches = [...document.subarray(prior.document.length).toString('utf8')
    .matchAll(/## Operator exact-selection and resolves correction\r?\n+```json\r?\n([\s\S]*?)\r?\n```/g)];
  if (matches.length !== 1) return null;
  const correction = JSON.parse(matches[0][1]);
  if (correction.schema !== 1 || correction.id !== OPERATOR_SELECTION_CORRECTION
    || correction.admission !== OPERATOR_USED_ADMISSION || correction.priorControl !== OPERATOR_USED_FILE_CONTROL
    || correction.authority !== 'existing-approved-verifier-support-scope'
    || sha256(JSON.stringify(correction.checkpoint)) !== OPERATOR_SELECTION_CHECKPOINT_SHA256
    || !operatorSelectionHistory(correction.checkpoint, journal)
    || JSON.stringify(Object.keys(correction.sourceBlobs ?? {}).sort()) !== JSON.stringify([...OPERATOR_CONTROL_PATHS].sort())
    || correction.failedSelection?.candidateId !== 'rt-0103'
    || correction.failedSelection.measurementSha256 !== '4366858d241421e1482fec183be29e25247aca86f40c6ca18b07767a0d542fd7'
    || correction.failedFixture?.candidateId !== 'rt-0516'
    || correction.failedFixture.measurementSha256 !== '77eb90a39e53da98aa61020e3d5ae864aa73ee1c4e1ea9b97917466d51806a01'
    || correction.reevaluation?.candidateId !== 'rt-0144'
    || correction.reevaluation.measurementSha256 !== '468489f392cedd75a85b6b13892b12eae10028389e6e56223aedc3fedd874f13') return null;
  for (const path of OPERATOR_CONTROL_PATHS) {
    if (git(root, ['rev-parse', `${controlHead}:${path}`]) !== correction.sourceBlobs[path]) return null;
  }
  const deviations = OPERATOR_INTAKE.replace('-intake.json', '-deviations.md');
  const before = operatorBlob(root, OPERATOR_USED_FILE_CONTROL, deviations);
  if (!operatorBlob(root, controlHead, deviations).subarray(0, before.length).equals(before)) return null;
  const allowed = new Set([...OPERATOR_CONTROL_PATHS, OPERATOR_REVIEW, deviations]);
  if (git(root, ['diff', '--name-only', '--no-renames', OPERATOR_USED_FILE_CONTROL, controlHead])
    .split('\n').filter(Boolean).some((path) => !allowed.has(path))) return null;
  for (const revision of descendants.slice(1)) {
    if (git(root, ['show', '-s', '--format=%P', revision]).split(' ').length !== 1
      || git(root, ['diff', '--name-only', '--no-renames', `${revision}^`, revision]).split('\n').filter(Boolean)
        .some((path) => path !== OPERATOR_REPORT && path !== OPERATOR_MARKDOWN)) return null;
  }
  for (const entry of [correction.failedSelection, correction.failedFixture, correction.reevaluation]) {
    const raw = operatorArtifact({ resultPath: entry.measurementPath, resultSha256: entry.measurementSha256 }, 'result');
    if (!raw) return null;
    const measurement = JSON.parse(raw);
    if (measurement.candidateId !== entry.candidateId || measurement.controlHead !== OPERATOR_USED_FILE_CONTROL
      || measurement.admission !== OPERATOR_USED_ADMISSION || measurement.outcome !== 'inconclusive') return null;
  }
  for (const launch of correction.checkpoint.supervisors.slice(42)) {
    const raw = operatorArtifact(launch, 'supervisor');
    const { supervisorPath, supervisorSha256, ...receipt } = launch;
    if (!raw || JSON.stringify(JSON.parse(raw)) !== JSON.stringify(receipt)
      || (launch.resultSha256 !== null && !operatorArtifact(launch, 'result'))) return null;
  }
  return { ...prior, fileControlHead: prior.controlHead, controlHead, document, selectionCorrection: correction };
}

function operatorSelectionProvenance(proof, inventory) {
  if (!proof.selectionCorrection) return undefined;
  return { id: OPERATOR_SELECTION_CORRECTION, priorControl: OPERATOR_USED_FILE_CONTROL,
    controlHead: proof.controlHead, checkpointSha256: OPERATOR_SELECTION_CHECKPOINT_SHA256,
    failedSelection: { candidateId: 'rt-0103', measurementSha256: proof.selectionCorrection.failedSelection.measurementSha256,
      originalSuggestion: 'inconclusive', retained: true },
    failedFixture: { candidateId: 'rt-0516', measurementSha256: proof.selectionCorrection.failedFixture.measurementSha256,
      originalSuggestion: 'inconclusive', retained: true },
    reevaluation: { candidateId: 'rt-0144', measurementSha256: proof.selectionCorrection.reevaluation.measurementSha256,
      originalSuggestion: 'inconclusive', outcome: inventory.find((row) => row.id === 'rt-0144')?.outcome } };
}

function operatorControlRevision(root, admissionHead, document, journal) {
  if (admissionHead !== OPERATOR_USED_ADMISSION) return { controlHead: admissionHead, correction: null, document };
  const descendants = git(root, ['rev-list', '--reverse', '--first-parent', `${admissionHead}..HEAD`]).split('\n').filter(Boolean);
  const controlHead = descendants[0];
  if (!controlHead || git(root, ['show', '-s', '--format=%P', controlHead]) !== admissionHead) return null;
  const controlDocument = operatorBlob(root, controlHead, OPERATOR_REVIEW);
  if (!controlDocument.subarray(0, document.length).equals(document)) return null;
  const suffix = controlDocument.subarray(document.length).toString('utf8');
  const matches = [...suffix.matchAll(/## Operator failed-file accounting correction\r?\n+```json\r?\n([\s\S]*?)\r?\n```/g)];
  if (matches.length !== 1) return null;
  const correction = JSON.parse(matches[0][1]);
  if (correction.schema !== 1 || correction.id !== OPERATOR_FILE_CORRECTION
    || correction.admission !== OPERATOR_USED_ADMISSION || correction.authority !== 'existing-approved-verifier-support-scope'
    || sha256(JSON.stringify(correction.checkpoint)) !== OPERATOR_FILE_CHECKPOINT_SHA256
    || sha256(JSON.stringify(correction.evidence)) !== OPERATOR_FILE_EVIDENCE_SHA256
    || !operatorCorrectionHistory(correction.checkpoint, journal)
    || JSON.stringify(Object.keys(correction.sourceBlobs ?? {}).sort()) !== JSON.stringify([...OPERATOR_CONTROL_PATHS].sort())) return null;
  for (const path of OPERATOR_CONTROL_PATHS) {
    if (git(root, ['rev-parse', `${controlHead}:${path}`]) !== correction.sourceBlobs[path]) return null;
  }
  const deviations = OPERATOR_INTAKE.replace('-intake.json', '-deviations.md');
  const before = operatorBlob(root, admissionHead, deviations);
  if (!operatorBlob(root, controlHead, deviations).subarray(0, before.length).equals(before)) return null;
  const allowed = new Set([...OPERATOR_CONTROL_PATHS, OPERATOR_REVIEW, deviations]);
  if (git(root, ['diff', '--name-only', '--no-renames', admissionHead, controlHead]).split('\n').filter(Boolean)
    .some((path) => !allowed.has(path))) return null;
  if (controlHead === OPERATOR_USED_FILE_CONTROL && descendants.length > 1
    && git(root, ['diff', '--name-only', '--no-renames', controlHead, descendants[1]]).split('\n').filter(Boolean)
      .some((path) => path !== OPERATOR_REPORT && path !== OPERATOR_MARKDOWN)) {
    const evidence = correction.evidence;
    if (!operatorArtifact({ resultPath: evidence.records.path, resultSha256: evidence.records.sha256 }, 'result')) return null;
    for (const pair of evidence.pairs) {
      if (!operatorArtifact({ resultPath: pair.measurementPath, resultSha256: pair.measurementSha256 }, 'result')) return null;
    }
    for (const launch of correction.checkpoint.supervisors.slice(30)) {
      const raw = operatorArtifact(launch, 'supervisor');
      const { supervisorPath, supervisorSha256, ...receipt } = launch;
      if (!operatorArtifact(launch, 'result') || !raw || JSON.stringify(JSON.parse(raw)) !== JSON.stringify(receipt)) return null;
    }
    return operatorSelectionControl(root, { controlHead, correction, document: controlDocument }, descendants.slice(1), journal);
  }
  for (const revision of descendants.slice(1)) {
    if (git(root, ['show', '-s', '--format=%P', revision]).split(' ').length !== 1
      || git(root, ['diff', '--name-only', '--no-renames', `${revision}^`, revision]).split('\n').filter(Boolean)
        .some((path) => path !== OPERATOR_REPORT && path !== OPERATOR_MARKDOWN)) return null;
  }
  const evidence = correction.evidence;
  if (!operatorArtifact({ resultPath: evidence.records.path, resultSha256: evidence.records.sha256 }, 'result')) return null;
  for (const pair of evidence.pairs) {
    if (!operatorArtifact({ resultPath: pair.measurementPath, resultSha256: pair.measurementSha256 }, 'result')) return null;
  }
  for (const launch of correction.checkpoint.supervisors.slice(30)) {
    const receiptRaw = operatorArtifact(launch, 'supervisor');
    const { supervisorPath, supervisorSha256, ...receipt } = launch;
    if (!operatorArtifact(launch, 'result') || !receiptRaw || JSON.stringify(JSON.parse(receiptRaw)) !== JSON.stringify(receipt)) return null;
  }
  return { controlHead, correction, document: controlDocument };
}

function operatorCorrectionProvenance(proof, inventory) {
  if (!proof.correction) return undefined;
  return { id: OPERATOR_FILE_CORRECTION, controlHead: proof.fileControlHead ?? proof.controlHead, checkpointSha256: OPERATOR_FILE_CHECKPOINT_SHA256,
    reevaluations: proof.correction.evidence.pairs.map((pair) => ({ candidateId: pair.id,
      measurementSha256: pair.measurementSha256, originalSuggestion: 'inconclusive',
      outcome: inventory.find((row) => row.id === pair.id)?.outcome })) };
}

/** Validate the first immutable admission, the historical pins and cumulative journal. */
export function validateOperatorAdmission(root, journal, { report = false } = {}) {
  try {
    if (git(root, ['branch', '--show-current']) !== OPERATOR_BRANCH) return null;
    const admissionHead = operatorAdmissionHead(root);
    if (!admissionHead || git(root, ['merge-base', OPERATOR_SCHEDULE[1], admissionHead]) !== OPERATOR_SCHEDULE[1]) return null;
    const document = operatorBlob(root, admissionHead, OPERATOR_REVIEW);
    const match = document.toString('utf8').match(/## Operator continuation manifest\r?\n+```json\r?\n([\s\S]*?)\r?\n```/);
    if (!match) return null;
    const manifest = JSON.parse(match[1]);
    if (manifest.schema !== 1 || manifest.id !== OPERATOR_CONTINUATION_ID || manifest.branch !== OPERATOR_BRANCH
      || manifest.round !== 1 || manifest.maxRuns !== 1500 || manifest.maxTimeoutMs !== RUN_TIMEOUT_MS
      || manifest.maxMutantsPerCandidate !== 2 || manifest.ownerApproval !== OPERATOR_APPROVAL
      || manifest.productBaseline !== OPERATOR_BASELINE || manifest.checkpointHead !== OPERATOR_CHECKPOINT
      || JSON.stringify(manifest.schedulingHeads) !== JSON.stringify(OPERATOR_SCHEDULE)
      || manifest.journalSha256 !== '9b1f54e102b0badf1a7c515084984e8c92f997971d381f78bc241b0b614a6073'
      || manifest.inventorySha256 !== '378cb2ba55fafec04566cda2b201631143432d3f34c5d71ac4fd1ca1bc353972') return null;
    const control = operatorControlRevision(root, admissionHead, document, journal);
    if (!control || !operatorBlob(root, 'HEAD', OPERATOR_REVIEW).equals(control.document)
      || !readFileSync(join(root, OPERATOR_REVIEW)).equals(control.document)
      || !readFileSync(join(root, '.feature/intake.json')).equals(operatorBlob(root, admissionHead, OPERATOR_INTAKE))) return null;
    const changed = git(root, ['diff', '--name-only', '--no-renames', OPERATOR_BASELINE, admissionHead]).split('\n').filter(Boolean);
    if (changed.some((path) => !OPERATOR_PATHS.has(path))) return null;
    const later = git(root, ['diff', '--name-only', '--no-renames', control.controlHead, 'HEAD']).split('\n').filter(Boolean);
    if (later.some((path) => path !== OPERATOR_REPORT && path !== OPERATOR_MARKDOWN)) return null;
    // Scheduling exceptions are byte-level substitutions at the two pinned commits.
    for (const [index, revision] of OPERATOR_SCHEDULE.entries()) {
      if (git(root, ['diff', '--name-only', `${revision}^`, revision]) !== OPERATOR_INTAKE) return null;
      const prior = operatorBlob(root, `${revision}^`, OPERATOR_INTAKE).toString('utf8');
      const expected = index === 0 ? prior.replace('--maxWorkers=2', '--maxWorkers=1')
        : prior.replace('pnpm test --maxWorkers=1 --coverage', 'pnpm test --project=integration --maxWorkers=1 --coverage')
          .replaceAll('.feature/operator-live-coverage', '.feature/operator-integration-coverage');
      if (expected === prior || operatorBlob(root, revision, OPERATOR_INTAKE).toString('utf8') !== expected) return null;
    }
    for (const path of OPERATOR_AXES) {
      const oid = git(root, ['rev-parse', `${OPERATOR_CHECKPOINT}:${path}`]);
      if (manifest.axisBlobs?.[path] !== oid || git(root, ['rev-parse', `HEAD:${path}`]) !== oid
        || git(root, ['hash-object', '--', path]) !== oid) return null;
    }
    const oldJson = operatorBlob(root, OPERATOR_CHECKPOINT, OPERATOR_REPORT);
    const oldMarkdown = operatorBlob(root, OPERATOR_CHECKPOINT, OPERATOR_MARKDOWN);
    if (git(root, ['rev-parse', `${OPERATOR_CHECKPOINT}:${OPERATOR_REPORT}`]) !== '08cdc7ea5f3d566993ff1deba8246f04340121ef'
      || git(root, ['rev-parse', `${OPERATOR_CHECKPOINT}:${OPERATOR_MARKDOWN}`]) !== 'e8c8f894ee43ad34519e5c7d34211c5be276e39c'
      || sha256(oldJson) !== manifest.historicalReportSha256 || sha256(oldMarkdown) !== manifest.historicalMarkdownSha256
      || !readFileSync(join(root, OPERATOR_MARKDOWN)).subarray(0, oldMarkdown.length).equals(oldMarkdown)) return null;
    const historical = JSON.parse(oldJson);
    const history = validateOperatorHistory(manifest, historical, journal);
    if (!history) return null;
    if (!Array.isArray(manifest.discoveryCorrections) || manifest.discoveryCorrections.length !== 355) return null;
    const originalCorrections = manifest.discoveryCorrections.slice(0, 287);
    const additionalCorrections = manifest.discoveryCorrections.slice(287);
    if (JSON.stringify(originalCorrections.map((row) => row.id)) !== JSON.stringify(OPERATOR_DISCOVERY_IDS)
      || sha256(JSON.stringify(originalCorrections)) !== OPERATOR_DISCOVERY_CORRECTIONS_SHA256
      || manifest.discoveryAdjudication?.arbiter !== 'inventory_scope_audit'
      || manifest.discoveryAdjudication.decision !== 'exclude-never-measured'
      || manifest.discoveryAdjudication.idsSha256 !== sha256(JSON.stringify(OPERATOR_DISCOVERY_IDS))
      || manifest.discoveryAdjudication.ownerApproval !== 'Approve the exact 287 documented discovery corrections'
      || manifest.discoveryAdjudication.proposalSha256 !== OPERATOR_DISCOVERY_PROPOSAL_SHA256
      || originalCorrections.some((row) => historical.inventory.find((old) => old.id === row.id)?.outcome !== 'skipped-budget'
        || manifest.legacyAttempts.some((attempt) => attempt.candidateId === row.id)
        || !row.reason?.startsWith('Direction B discovery correction: ') || typeof row.proof !== 'string' || !row.proof.trim())) return null;
    if (JSON.stringify(additionalCorrections.map((row) => row.id)) !== JSON.stringify(OPERATOR_ADDITIONAL_DISCOVERY_IDS)
      || sha256(JSON.stringify(additionalCorrections)) !== OPERATOR_ADDITIONAL_CORRECTIONS_SHA256
      || manifest.additionalDiscoveryAdjudication?.arbiter !== 'root-and-independent-discovery-review'
      || manifest.additionalDiscoveryAdjudication.decision !== 'exclude-never-measured-contract-scope'
      || manifest.additionalDiscoveryAdjudication.idsSha256 !== sha256(JSON.stringify(OPERATOR_ADDITIONAL_DISCOVERY_IDS))
      || manifest.additionalDiscoveryAdjudication.ownerApproval !== 'Approve the exact 68 additional documented discovery corrections'
      || manifest.additionalDiscoveryAdjudication.proposalSha256 !== OPERATOR_ADDITIONAL_PROPOSAL_SHA256
      || additionalCorrections.some((row) => OPERATOR_DISCOVERY_IDS.includes(row.id)
        || historical.inventory.find((old) => old.id === row.id)?.outcome !== 'skipped-budget'
        || manifest.legacyAttempts.some((attempt) => attempt.candidateId === row.id)
        || !row.reason?.startsWith('Direction B additional discovery correction: ')
        || typeof row.proof !== 'string' || !row.proof.trim()
        || !['A', 'B'].includes(row.category) || !Array.isArray(row.evidence) || row.evidence.length === 0)) return null;
    const measurementsRaw = operatorArtifact({ resultPath: manifest.measurements?.path,
      resultSha256: manifest.measurements?.sha256 }, 'result');
    if (!measurementsRaw) return null;
    const measurements = JSON.parse(measurementsRaw);
    if (!Array.isArray(measurements) || measurements.length !== 15) return null;
    for (const [index, mapping] of manifest.legacyAttempts.entries()) {
      const measured = measurements[index];
      const candidate = history.inventory.find((row) => row.id === mapping.candidateId);
      const mutation = manifest.checkpointJournal.mutations[index];
      if (measured.id !== candidate.id || measured.file !== candidate.file || measured.test !== candidate.test
        || measured.mutation?.file !== mutation.path) return null;
      const original = execFileSync('git', ['cat-file', 'blob', mutation.originalOid], { cwd: root });
      const mutant = execFileSync('git', ['cat-file', 'blob', mutation.mutantOid], { cwd: root });
      if (!operatorLegacyReconstruction(measured.id, original.toString('utf8'), measured.mutation.from,
        measured.mutation.to, mutant.toString('utf8'))
        || sha256(mutant) !== mutation.patchSha256) return null;
      for (const phase of ['baseline', 'mutant']) {
        if (measured[phase]?.report !== mapping[phase].resultPath) return null;
      }
    }
    // Existing verifier assertions are immutable too: safeguards are an append-only suffix.
    for (const path of OPERATOR_VERIFIER_TESTS) {
      const original = operatorBlob(root, OPERATOR_BASELINE, path);
      if (!operatorBlob(root, control.controlHead, path).subarray(0, original.length).equals(original)) return null;
      const labels = (bytes) => [...bytes.toString('utf8').matchAll(/^\s*(?:describe|it)\(\s*(['"`])([^\n]*?)\1/gm)].map((match) => match[0].trimStart());
      if (JSON.stringify(labels(operatorBlob(root, admissionHead, path)))
        !== JSON.stringify(labels(operatorBlob(root, control.controlHead, path)))) return null;
    }
    const grant = { id: OPERATOR_CONTINUATION_ID, maxRuns: 1500, sha256: sha256(document), headSha: admissionHead };
    if ((journal.runs > 30 && !journal.budgetAuthorization)
      || (journal.budgetAuthorization && (!sameGrant(journal.budgetAuthorization, grant)
        || journal.budgetAuthorization.firstRun !== 31))) return null;
    for (const [index, mutation] of journal.mutations.entries()) {
      if (index < 15) continue;
      const sourceHead = control.selectionCorrection && index >= control.selectionCorrection.checkpoint.mutations.length
        ? control.controlHead : control.correction && index >= 21 ? (control.fileControlHead ?? control.controlHead) : admissionHead;
      const selectorCorrection = control.selectionCorrection && sourceHead === control.controlHead && mutation.candidateId === 'rt-0103'
        ? OPERATOR_SELECTION_CORRECTION : undefined;
      if (mutation.selectorCorrection !== selectorCorrection) return null;
      if (mutation.admission !== admissionHead || (index >= 21 && control.correction && mutation.controlHead !== sourceHead)
        || mutation.originalOid !== git(root, ['rev-parse', `${sourceHead}:${mutation.path}`])) return null;
    }
    const usedResults = new Set();
    for (const [index, launch] of journal.supervisors.entries()) {
      if (index < 30) continue;
      const sourceHead = control.selectionCorrection && index >= control.selectionCorrection.checkpoint.runs
        ? control.controlHead : control.correction && index >= 42 ? (control.fileControlHead ?? control.controlHead) : admissionHead;
      const selectorCorrection = control.selectionCorrection && sourceHead === control.controlHead && launch.candidateId === 'rt-0103'
        ? OPERATOR_SELECTION_CORRECTION : undefined;
      if (launch.selectorCorrection !== selectorCorrection) return null;
      if (control.correction && index >= 42 && launch.controlHead !== sourceHead) return null;
      const candidate = history.inventory.find((row) => row.id === launch.candidateId);
      if (!candidate || launch.admission !== admissionHead || launch.selector !== operatorCandidateSelector(candidate, selectorCorrection)
        || !['baseline', 'mutant'].includes(launch.phase) || !Number.isInteger(launch.attempt)
        || launch.attempt < 1 || launch.attempt > 2 || !launch.target
        || launch.originalOid !== git(root, ['rev-parse', `${sourceHead}:${launch.target}`])
        || !/^[a-f0-9]{64}$/.test(launch.mutantSha256 ?? '')
        || !/^[a-f0-9]{64}$/.test(launch.envSha256 ?? '')
        || typeof launch.resultPath !== 'string' || usedResults.has(launch.resultPath)) return null;
      usedResults.add(launch.resultPath);
      if (launch.phase === 'mutant' && !journal.mutations.slice(15).some((mutation) =>
        mutation.candidateId === launch.candidateId && mutation.attempt === launch.attempt
        && mutation.path === launch.target && mutation.mutantSha256 === launch.mutantSha256)) return null;
      if (report && (launch.active !== false || (launch.resultSha256 !== null && !operatorArtifact(launch, 'result'))
        || !operatorArtifact(launch, 'supervisor'))) return null;
    }
    const changedWorking = git(root, ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
    if (git(root, ['diff', '--cached', '--name-only']) || changedWorking.some((path) => {
      if (path === OPERATOR_REPORT || path === OPERATOR_MARKDOWN) return !report;
      const mutation = journal.mutations.findLast((entry) => entry.path === path);
      return report || mutation?.state !== 'applied' || mutation.mutantOid !== git(root, ['hash-object', '--', path]);
    }) || git(root, ['ls-files', '--others', '--exclude-standard'])) return null;
    if (report && (journal.dotenv?.open !== false || journal.mutations.some((entry) => entry.state !== 'restored')
      || journal.supervisors.some((entry) => entry.active !== false))) return null;
    const processes = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
    if (processes.status !== 0) return null;
    if (findWorktreeWatchers(processes.stdout, selfAncestry(), root).length > 0) return null;
    return { ...history, manifest, historical, grant, admissionHead, controlHead: control.controlHead, correction: control.correction,
      fileControlHead: control.fileControlHead, selectionCorrection: control.selectionCorrection };
  } catch { return null; }
}

function operatorRunMetadata(root, parsed, proof, journal, phase) {
  const candidate = proof.inventory.find((row) => row.id === parsed.candidate);
  const attempt = Number(parsed.attempt);
  const target = parsed.target ?? parsed.file;
  if (!candidate || candidate.file !== parsed['test-file'] || operatorCandidateSelector(candidate, proof.selectionCorrection?.id) !== parsed.selector
    || !Number.isInteger(attempt) || attempt < 1 || attempt > 2 || typeof target !== 'string'
    || target.split('/').some((part) => !part || part === '.' || part === '..')
    || !/^[a-f0-9]{64}$/.test(parsed['mutant-sha256'] ?? '')) return null;
  const originalOid = git(root, ['rev-parse', `${proof.controlHead}:${target}`]);
  const previous = journal.mutations.findLast((entry) => entry.candidateId === candidate.id && entry.attempt === attempt);
  if (phase === 'mutation' || phase === 'baseline') {
    if (attempt !== (proof.attempts.get(candidate.id) ?? 0) + 1
      || journal.mutations.some((entry) => entry.state !== 'restored')
      || git(root, ['hash-object', '--', target]) !== originalOid) return null;
  } else if (!previous || previous.state !== 'applied' || previous.path !== target
    || previous.mutantSha256 !== parsed['mutant-sha256']
    || git(root, ['hash-object', '--', target]) !== previous.mutantOid
    || sha256(readFileSync(join(root, target))) !== previous.mutantSha256) return null;
  return { candidateId: candidate.id, selector: parsed.selector, attempt, target,
    originalOid, mutantSha256: parsed['mutant-sha256'], admission: proof.admissionHead,
    ...(proof.correction ? { controlHead: proof.controlHead } : {}),
    ...(proof.selectionCorrection && candidate.id === 'rt-0103' ? { selectorCorrection: OPERATOR_SELECTION_CORRECTION } : {}) };
}

const OPERATOR_FRONTEND_ASSERTION_SITES = [
  {"id": "rt-0144", "file": "src/lib/agents/operator/__tests__/completion-materialization.test.ts", "test": "fenced reply materialization boundaries locks location requests before account requests while preserving model order and stored ownership", "testSha256": "d451764285ccdc077f62c059459e68338aeb770b2cec63d462676961ebc4a24b", "line": 57, "sourceLine": "    await expect(completeTurnFenced(sql as never, input())).resolves.toEqual({ fenced: true });", "target": "src/lib/agents/operator/turns.ts", "originalOid": "f42fbd06ac7ea800b2871a662e5d958abb6ff76c", "mutantSha256": "3366bc3c3d8e20136cf859b54eb4bc93de31fd677eca04383d3de526d8f01962", "family": "resolves", "header": "Error: promise rejected \"Error: agents/operator: restore request d…\" instead of resolving"},
  {"id": "rt-0009","file": "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx","test": "OperatorClient operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled","testSha256": "d0dc077ac462d88f2eb029a1c45c14d32e4648f8643afdb16b7ae60cbcaaf563","line": 330,"sourceLine": "    expect(await screen.findByText(/not available right now/i)).toBeInTheDocument();","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "fc44b7818ebc025c4cfe7ea594830cbf90491683880d06322b1b2765b212077a","family": "query","query": "findByText","header": "Error","messagePrefix": "Unable to find an element with the text: /not available right now/i. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible."},
  {"id": "rt-0011","file": "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx","test": "OperatorClient retry after a lost POST response resumes the original turn","testSha256": "d0dc077ac462d88f2eb029a1c45c14d32e4648f8643afdb16b7ae60cbcaaf563","line": 390,"sourceLine": "    const retryButton = await screen.findByRole('button', { name: RETRY_SEND });","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b","family": "query","query": "findByRole","header": "Error","messagePrefix": "Unable to find role=\"button\" and name \"Try again\""},
  {"id": "rt-0012","file": "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx","test": "OperatorClient a POST that never settles releases the composer and offers the same retry","testSha256": "d0dc077ac462d88f2eb029a1c45c14d32e4648f8643afdb16b7ae60cbcaaf563","line": 459,"sourceLine": "    const retryButton = await screen.findByRole('button', { name: RETRY_SEND });","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b","family": "query","query": "findByRole","header": "Error","messagePrefix": "Unable to find role=\"button\" and name \"Try again\""},
  {"id": "rt-0013","file": "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx","test": "OperatorClient a refusal the server answered offers no retry and an unusable location says so","testSha256": "d0dc077ac462d88f2eb029a1c45c14d32e4648f8643afdb16b7ae60cbcaaf563","line": 489,"sourceLine": "    expect(await screen.findByText(ROUTE_ERROR_WORDING.unauthorized!)).toBeInTheDocument();","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "26e079a543b84c098c640a8a3d116946cdb2da7c9cf7b82b16a75f086017957b","family": "query","query": "findByText","header": "Error","messagePrefix": "Unable to find an element with the text: Your account can no longer make this change. Nothing was applied.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible."},
  {"id": "rt-0016","file": "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx","test": "OperatorClient terminal failures and requested capabilities survive reload and subsequent turns","testSha256": "d0dc077ac462d88f2eb029a1c45c14d32e4648f8643afdb16b7ae60cbcaaf563","line": 697,"sourceLine": "    expect(screen.getByText(TURN_FAILURE_WORDING.exhausted!)).toBeInTheDocument();","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "9670b21a4e5ee3d5e8f296675fe2ef7efcdb21ec19e99342316416f67e75e996","family": "query","query": "getByText","header": "TestingLibraryElementError","messagePrefix": "Unable to find an element with the text: We tried several times and could not finish this message. Nothing was changed. Start a new conversation to try again.. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible."},
  {"id": "rt-0017","file": "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx","test": "OperatorClient loaded conversations retain identity and starting over stays empty","testSha256": "d0dc077ac462d88f2eb029a1c45c14d32e4648f8643afdb16b7ae60cbcaaf563","line": 722,"sourceLine": "    expect(await screen.findByText(PREPARING)).toBeInTheDocument();","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "7fbfb44e8d2c7dca2865f25ca0f367ed23520e2a6edc5913cd074357bca179ba","family": "query","query": "findByText","header": "Error","messagePrefix": "Unable to find an element with the text: Preparing your plan. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible."},
  {"id": "rt-0022","file": "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx","test": "OperatorClient Refresh plan preserves the original instruction and location after scope changes","testSha256": "d0dc077ac462d88f2eb029a1c45c14d32e4648f8643afdb16b7ae60cbcaaf563","line": 1097,"sourceLine": "    const button = await screen.findByRole('button', { name: 'Refresh plan' });","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "0d0c893cd91ab3e1fff5bc8d7552b44033dce3deb074f10dbe3ccb20a89e178c","family": "query","query": "findByRole","header": "Error","messagePrefix": "Unable to find role=\"button\" and name \"Refresh plan\""},
  {"id": "rt-0035","file": "src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx","test": "Operator Restore workflow refused cards and the operating rules timeline survive reload","testSha256": "4a50c840717fee831c2b86b147f4d3db5bdd0ed3772f7b1028dff238e01b90bb","line": 81,"sourceLine": "      const refusal = await screen.findByRole('group', { name: 'Policy refused' });","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "2ba3dcac4aab92e8fb59893a5f7d2bd82fe3d9e7465a01636a11f4043990a60c","family": "query","query": "findByRole","header": "Error","messagePrefix": "Unable to find role=\"group\" and name \"Policy refused\""},
  {"id": "rt-0039","file": "src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx","test": "Operator Restore workflow keeps an out-of-window prepared restore actionable immediately and after loading persisted timeline history","testSha256": "4a50c840717fee831c2b86b147f4d3db5bdd0ed3772f7b1028dff238e01b90bb","line": 175,"sourceLine": "    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument();","target": "src/app/(authenticated)/dashboard/operator/ProposalCard.tsx","originalOid": "b38870fbe1ce62fc45cf915919d6638b289f414e","mutantSha256": "bac4f0615c272ef3ad934026fc372aedf08d1283b502b87acbe22e5aaaa74905","family": "query","query": "findByRole","header": "Error","messagePrefix": "Unable to find role=\"button\" and name \"Apply\""},
  {"id": "rt-0044","file": "src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx","test": "Operator Restore workflow discards a slow previous-scope timeline page after the owner changes location","testSha256": "4a50c840717fee831c2b86b147f4d3db5bdd0ed3772f7b1028dff238e01b90bb","line": 266,"sourceLine": "    expect(await screen.findByRole('heading', { name: 'Current scope history' })).toBeInTheDocument();","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "31f157b11041735feeec5165a4f2ebf75c8fa7130478655f5f0ca3b74179db89","family": "query","query": "findByRole","header": "Error","messagePrefix": "Unable to find role=\"heading\" and name \"Current scope history\""},
  {"id": "rt-0045","file": "src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx","test": "Operator Restore workflow retries a failed timeline read without treating it as empty history","testSha256": "4a50c840717fee831c2b86b147f4d3db5bdd0ed3772f7b1028dff238e01b90bb","line": 283,"sourceLine": "    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load your rules timeline. Try again.');","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "c5c4045ef07a3bb912bb4f993618893bc80722527ab467bb5d1c70322fa99b34","family": "query","query": "findByRole","header": "Error","messagePrefix": "Unable to find role=\"alert\""},
  {"id": "rt-0010","file": "src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx","test": "OperatorClient operator screen disables the composer under All locations and enables it once a location is chosen","testSha256": "d0dc077ac462d88f2eb029a1c45c14d32e4648f8643afdb16b7ae60cbcaaf563","line": 347,"sourceLine": "    expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled();","target": "src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts","originalOid": "93f076f81bd038783a67b85ee85a25211cbfc4df","mutantSha256": "2a0dcbeb98b119d2632512e865dbe1b042c0fb828163d7f1fe257d5d330d2852","family": "jest-dom","header": "Error","matcher": "toBeDisabled","messageLines": ["expect(element).toBeDisabled()","Received element is not disabled:"]},
  {"id": "rt-0041","file": "src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx","test": "Operator Restore workflow shows preparation progress and a retryable error without creating an Apply button","testSha256": "4a50c840717fee831c2b86b147f4d3db5bdd0ed3772f7b1028dff238e01b90bb","line": 217,"sourceLine": "    expect(screen.getByRole('button', { name: 'Preparing restore…' })).toBeDisabled();","target": "src/app/(authenticated)/dashboard/operator/ProposalCard.tsx","originalOid": "b38870fbe1ce62fc45cf915919d6638b289f414e","mutantSha256": "36986d07441fcc05bcf0eb0a6cf2e39044d82a3599ef389f923157e427f0425c","family": "jest-dom","header": "Error","matcher": "toBeDisabled","messageLines": ["expect(element).toBeDisabled()","Received element is not disabled:"]},
];

/** Each reviewed site observes expected behavior at its pinned test line. */
export function operatorFrontendAssertion(message, launch, candidate) {
  if (typeof message !== 'string'
    || /Cannot find module|Failed to load|SyntaxError|ReferenceError|TypeError|beforeAll|beforeEach|afterAll|afterEach/.test(message)) return false;
  const site = OPERATOR_FRONTEND_ASSERTION_SITES.find((row) => row.id === candidate.id
    && row.file === candidate.file && row.test === candidate.test && row.target === launch.target
    && row.originalOid === launch.originalOid && row.mutantSha256 === launch.mutantSha256);
  if (!site) return false;
  try {
    const root = repoRoot();
    const source = readFileSync(join(root, site.file));
    if (sha256(source) !== site.testSha256 || source.toString('utf8').split(/\r?\n/)[site.line - 1] !== site.sourceLine) return false;
    const text = message.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
    const lines = text.trimEnd().split('\n');
    let start = lines.length;
    while (start > 0 && /^    at /.test(lines[start - 1])) start -= 1;
    const stack = lines.slice(start)
      .map((line) => ({ line, location: line.match(/(?:\(|\s)(?:file:\/\/)?(\/.*):(\d+):(\d+)\)?$/) }));
    if (stack.some((frame) => !frame.location && frame.line !== '    at new Promise (<anonymous>)'
      && !(site.family === 'resolves' && frame.line === '    at Reflect.get (<anonymous>)'))) return false;
    const frames = stack.filter((frame) => frame.location !== null);
    const projectFrames = frames.filter((frame) => !frame.location[1].includes('/node_modules/'));
    const direct = projectFrames[0];
    if (projectFrames.length !== 1 || !direct || direct.location[1] !== join(root, site.file) || Number(direct.location[2]) !== site.line) return false;
    const dependencies = frames.slice(0, frames.indexOf(direct));
    if (site.family === 'resolves') {
      return text.startsWith(`${site.header}\n`)
        && dependencies.some((frame) => frame.line.includes('__VITEST_RESOLVES__')
          && frame.location[1].endsWith('/node_modules/@vitest/expect/dist/index.js'));
    }
    if (site.family === 'jest-dom') {
      return text.startsWith(`Error: ${site.messageLines[0]}\n`)
        && text.split('\n').includes(site.messageLines[1])
        && dependencies.some((frame) => frame.line.includes('__VITEST_EXTEND_ASSERTION__')
          && frame.location[1].endsWith('/node_modules/@vitest/expect/dist/index.js'));
    }
    if (!text.startsWith(`${site.header}: ${site.messagePrefix}\n`)
      || !dependencies.some((frame) => frame.location[1].endsWith('/node_modules/@testing-library/dom/dist/query-helpers.js'))) return false;
    return !site.query.startsWith('findBy') || dependencies.some((frame) => frame.line.includes('waitForWrapper')
      && frame.location[1].endsWith('/node_modules/@testing-library/dom/dist/wait-for.js'));
  } catch { return false; }
}

/** Evidence must identify one executed assertion; setup/import errors never kill. */
export function operatorMeasuredAssertion(launch, candidate, expectedStatus) {
  const raw = operatorArtifact(launch, 'result');
  const supervisor = operatorArtifact(launch, 'supervisor');
  if (!raw || !supervisor) return false;
  try {
    const result = JSON.parse(raw);
    const receipt = JSON.parse(supervisor);
    const { supervisorPath, supervisorSha256, ...record } = launch;
    if (JSON.stringify(receipt) !== JSON.stringify(record) || launch.active !== false || launch.timedOut !== false
      || launch.code !== (expectedStatus === 'passed' ? 0 : 1) || launch.signal !== null
      || result.numRuntimeErrorTestSuites > 0) return false;
    const files = result.testResults ?? [];
    if (!Array.isArray(files)
      || files.filter((file) => file.status === 'failed').length > (expectedStatus === 'failed' ? 1 : 0)
      || files.some((file) => typeof file.message === 'string' && file.message.trim())) return false;
    const assertions = files.flatMap((file) => (file.assertionResults ?? [])
      .filter((assertion) => ['passed', 'failed'].includes(assertion.status)).map((assertion) => ({ file, assertion })));
    if (assertions.length !== 1) return false;
    const { file, assertion } = assertions[0];
    if (!(file.name === candidate.file || file.name?.endsWith(`/${candidate.file}`))
      || (assertion.fullName ?? assertion.title) !== candidate.test || assertion.status !== expectedStatus
      || file.status !== expectedStatus) return false;
    return expectedStatus === 'passed' || (assertion.failureMessages?.length > 0
      && assertion.failureMessages.every((message) => (/AssertionError|expected .* to /s.test(message)
        || operatorFrontendAssertion(message, launch, candidate))
        && !/Cannot find module|Failed to load|SyntaxError|ReferenceError|TypeError|beforeAll|beforeEach|afterAll|afterEach/.test(message)));
  } catch { return false; }
}

export function operatorLaunchAllowed(runs, timeout) {
  return Number.isInteger(runs) && runs >= 30 && runs < 1500
    && Number.isFinite(timeout) && timeout > 0 && timeout <= RUN_TIMEOUT_MS;
}

/**
 * Names WHICH precondition failed `cmdRun`'s Operator-continuation gate, or
 * null when every one passed — one refusal path, one exit code, but the
 * cause is no longer fused into a single string.
 *
 * A fused message ("admission, candidate metadata, test command, result path
 * or timeout invalid") is identical for all eight causes, so a test asserting
 * "this specific bad input is refused" passes even when the REAL cause was
 * something else entirely (an unrelated watcher blocking admission, say) —
 * it never actually exercised the input under test. Naming the cause turns
 * that into a real assertion instead of a vacuous one.
 */
export function operatorRunRejectionReason({
  admissionValid, candidateMetadataValid, argvMatches, resultPathValid,
  supervisorClash, launchAllowed, dotenvSafe, noRelease,
}) {
  if (!admissionValid) return 'operator continuation admission is invalid';
  if (!candidateMetadataValid) return 'candidate metadata is invalid';
  if (!argvMatches) return 'the test command does not match the expected invocation';
  if (!resultPathValid) return 'the result path is missing or already in use';
  if (supervisorClash) return 'a supervisor clash (an active launch or a reused result path)';
  if (!launchAllowed) return 'the launch budget or timeout is invalid';
  if (!dotenvSafe) return 'a dotenv file is not scrubbed';
  if (noRelease) return '--no-release was set';
  return null;
}

export function operatorOutcomeCorroborated(candidate, launches, admissionHead) {
  if (candidate.outcome !== 'killed') return false;
  const bound = launches.filter((entry) => entry.candidateId === candidate.id
    && entry.selector === operatorCandidateSelector(candidate, entry.selectorCorrection) && entry.admission === admissionHead);
  return bound.some((baseline) => baseline.phase === 'baseline'
    && operatorMeasuredAssertion(baseline, candidate, 'passed')
    && bound.some((mutant) => mutant.phase === 'mutant' && mutant.attempt === baseline.attempt
      && mutant.target === baseline.target && mutant.originalOid === baseline.originalOid
      && mutant.mutantSha256 === baseline.mutantSha256
      && mutant.envSha256 === baseline.envSha256 && mutant.controlHead === baseline.controlHead
      && mutant.selectorCorrection === baseline.selectorCorrection
      && operatorMeasuredAssertion(mutant, candidate, 'failed')));
}

export function validOperatorReport(root, sidecar, journal) {
  const proof = validateOperatorAdmission(root, journal, { report: true });
  if (!proof || sidecar.branch !== OPERATOR_BRANCH || sidecar.round !== 1
    || sidecar.head_sha !== proof.controlHead || sidecar.authorizations?.length !== 0
    || JSON.stringify(sidecar.operatorVerifierCorrection) !== JSON.stringify(operatorCorrectionProvenance(proof, sidecar.inventory ?? []))
    || JSON.stringify(sidecar.operatorSelectionCorrection) !== JSON.stringify(operatorSelectionProvenance(proof, sidecar.inventory ?? []))
    || ['mode', 'run_id', 'fork_sha', 'merge_base_sha', 'risk'].some((key) => sidecar[key] !== proof.historical[key])
    || !unchangedPrefix(proof.historical.findings ?? [], sidecar.findings ?? [])
    || !unchangedPrefix(proof.historical.authorizations ?? [], sidecar.authorizations)
    || sidecar.intake_sha256 !== sha256(operatorBlob(root, proof.admissionHead, OPERATOR_INTAKE))
    || JSON.stringify(sidecar.inventory?.map(operatorIdentity)) !== JSON.stringify(proof.inventory)) return false;
  for (const [index, candidate] of sidecar.inventory.entries()) {
    const old = proof.historical.inventory[index];
    if (old?.outcome === 'excluded') {
      if (JSON.stringify(candidate) !== JSON.stringify(old)) return false;
      continue;
    }
    const discoveryCorrection = proof.manifest.discoveryCorrections.find((row) => row.id === candidate.id);
    if (discoveryCorrection && candidate.outcome === 'excluded') {
      if (candidate.reason !== discoveryCorrection.reason) return false;
      continue;
    }
    if (candidate.outcome === 'excluded') return false;
    if (old?.outcome === 'killed') {
      if (JSON.stringify(candidate) !== JSON.stringify(old)) return false;
      continue;
    }
    if (candidate.outcome !== 'killed' && candidate.outcome !== 'equivalent') continue;
    const launches = proof.selectionCorrection && index >= 501
      ? journal.supervisors.filter((row) => row.controlHead === proof.controlHead
        && row.attempt === (candidate.id === 'rt-0516' ? 1 : 2))
      : journal.supervisors.slice(30);
    if (!operatorOutcomeCorroborated(candidate, launches, proof.admissionHead)) return false;
  }
  return true;
}

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
const RUN_E_ORIGINAL_ADMISSION = 'b6ee3973b3e0ad9f6749f02c5428e6b4980cf837';
const RUN_E_CHECKPOINT_SHA256 = '1fd1ce99a5a70d8ba0feacb6ca0b30a2f0623207295f32e184258a104122df72';
// Complete root-reviewed census; the earlier 162 corrections remain separate.
const RUN_E_CONTINUATION_SCOPE_SHA256 = 'e0cde5e28d709850630f5c1470e150d9d94269c7c04b0dd5c8e26020bfc271b3';
const RUN_E_REVIEW_DOCUMENT = 'docs/reviews/codex-owner-operator-run-e/budget-extension-review.md';
const RUN_E_CONTINUATION_PATHS = new Set([
  '.agents/skills/red-team/scripts/mutation-runner.mjs',
  '.agents/skills/feature/scripts/red-team-status.mjs',
  '.agents/skills/red-team/SKILL.md', '.claude/skills/red-team/SKILL.md',
  'scripts/ci/__tests__/red-team-mutation-runner.test.ts',
  'scripts/ci/__tests__/red-team-status.test.ts',
  RUN_E_REVIEW_DOCUMENT,
  'docs/superpowers/plans/codex-owner-operator-run-e-deviations.md',
]);

// Finite root-adjudicated correction under the existing E grant. The root
// finalized and froze this complete checkpoint before preparing the candidate.
const RUN_E_CORRECTIVE_PREDECESSOR = '9f20dbecd2ce302494088a49cc3147bca96a3f27';
const RUN_E_CORRECTIVE_CHECKPOINT_SHA256 = '1d38d0cc1f21f86833c42f1e5ebc568c8fa42d9546c2bdfefe70829830853b4b';
const RUN_E_CORRECTIVE_CHECKPOINT_RUNS = 594;
// Exact full-file blobs, not permission to make arbitrary edits to these paths.
// Root and independent review verified these five exact corrected test files.
const RUN_E_CORRECTIVE_TEST_BLOBS = Object.freeze({
  'src/lib/auto-approval/__tests__/settings.test.ts': 'b0dfad32973e956b7ae9ca2fcabcddf8be767841',
  'src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx': '2188c84b35f4aa479ee4dfa746ea837a4045565b',
  'src/lib/agents/operator/__tests__/apply.test.ts': '9f9e0df549f23323d88abaa582010c56aec0c6da',
  'src/lib/agents/operator/__tests__/proposals.test.ts': '76b7d410968d882c5b7ecd006800118340a68411',
  'src/lib/agents/operator/__tests__/render.test.ts': '0e257ef89fab59698ceb2f5fb5bc6909a69766fd',
});
const RUN_E_CORRECTIVE_DOCUMENTS = [
  RUN_E_REVIEW_DOCUMENT,
  'docs/superpowers/plans/codex-owner-operator-run-e-deviations.md',
];


// One root-adjudicated staging diagnostic correction; never a reusable successor budget.
const RUN_E_STAGING_PREDECESSOR = '263fe7e3def2ebd1cae4f76de146c7822b278d9a';
const RUN_E_STAGING_PUBLICATION = 'da87399c317d89f85ca8076a6dc1643c4c8995cc';
const RUN_E_STAGING_DIAGNOSTIC = '690a8792efebc2f0f791653d4f73fdaa9bb660da';
const RUN_E_STAGING_CHECKPOINT_SHA256 = '5652b40bbf08cb1883c6fda49376ad8dd30d27dfc54de376030039d89e422321';
const RUN_E_STAGING_CHECKPOINT_RUNS = 776;
const RUN_E_STAGING_REPORT_SHA256 = 'bdca52a9c33b62a980cab848080a97cc80c37ea961ca48fa02f258322c830fb5';
const RUN_E_STAGING_MARKDOWN_SHA256 = '25fa9b2847ffba6461ac71cbe2262a50a8a3a1d2f22c0c7c30734f9e42f19050';
const RUN_E_STAGING_BLOBS = Object.freeze({
  'src/lib/agents/operator/render.ts': '29b3b67d3f08e71f9e5b9534826adc3187d1345c',
  'src/lib/agents/operator/model-call.ts': '7584b6f6fd6c35b7a12b79a199e41364e82008f3',
  'src/lib/agents/operator/__tests__/render.test.ts': '8f53cc82d2be5ad6b21b904b64987ce747f5fb4b',
  'src/lib/agents/operator/__tests__/model-call.test.ts': '2d8415d121832bce5af7cdd8b616499f980d9bfc',
  'docs/reviews/codex-owner-operator-run-e/staging-diagnostics.md': '5cda288cff0e5a656f56f19c8bc9b23bdcbf0658',
});

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

function committedRunESection(document, name) {
  const start = `<!-- RUN_E_${name}_START -->`;
  const end = `<!-- RUN_E_${name}_END -->`;
  if (document.split(start).length !== 2 || document.split(end).length !== 2
    || document.indexOf(start) >= document.indexOf(end)) return null;
  const payload = document.slice(document.indexOf(start) + start.length, document.indexOf(end))
    .match(/^\s*```json\s*\n([\s\S]*?)\n```\s*$/);
  return payload ? JSON.parse(payload[1]) : null;
}

/** One reviewed correction may continue the closed checkpoint, never replace it. */
export function validateRunEContinuation(root, journal, headSha, allowUnpinned = false) {
  try {
    if (headSha === RUN_E_ORIGINAL_ADMISSION
      || git(root, ['branch', '--show-current']) !== RUN_E_BRANCH
      || git(root, ['merge-base', RUN_E_ORIGINAL_ADMISSION, headSha]) !== RUN_E_ORIGINAL_ADMISSION) return null;
    const changed = git(root, ['diff', '--name-only', '--no-renames', RUN_E_ORIGINAL_ADMISSION, headSha]);
    if (changed.split('\n').filter(Boolean).some((path) => !RUN_E_CONTINUATION_PATHS.has(path))) return null;
    const original = validateRunEAdmission(root, RUN_E_ORIGINAL_ADMISSION);
    const proof = validateRunEAdmission(root, headSha);
    if (!original || !proof) return null;
    const readDocument = (revision) => execFileSync('git', ['show', `${revision}:${RUN_E_REVIEW_DOCUMENT}`], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const originalDocument = readDocument(RUN_E_ORIGINAL_ADMISSION);
    const document = readDocument(headSha);
    if (!document.startsWith(originalDocument)) return null;
    const checkpoint = committedRunESection(document, 'CHECKPOINT_124');
    const scopeCorrections = committedRunESection(document, 'CONTINUATION_SCOPE_CORRECTIONS');
    if (!checkpoint || sha256(JSON.stringify(checkpoint)) !== RUN_E_CHECKPOINT_SHA256
      || Object.keys(checkpoint).sort().join(',') !== 'budgetAuthorization,dotenv,mutations,round,runs,supervisors,version'
      || checkpoint.version !== 1 || checkpoint.round !== 2 || checkpoint.runs !== 124
      || checkpoint.mutations?.length !== 62 || checkpoint.supervisors?.length !== 124
      || checkpoint.mutations.some((entry) => entry.state !== 'restored')
      || checkpoint.supervisors.some((entry) => entry.active !== false)
      || JSON.stringify(checkpoint.dotenv) !== JSON.stringify({ open: false, files: [] })
      || JSON.stringify(checkpoint.budgetAuthorization) !== JSON.stringify({ ...original.grant, firstRun: 1 })
      || !scopeCorrections || sha256(JSON.stringify(scopeCorrections)) !== RUN_E_CONTINUATION_SCOPE_SHA256
      || scopeCorrections.schema !== 1 || scopeCorrections.sourceHead !== RUN_E_ORIGINAL_ADMISSION
      || !Array.isArray(scopeCorrections.groups)) return null;
    if (journal.version !== checkpoint.version || journal.round !== 2
      || !Number.isInteger(journal.runs) || journal.runs < 124 || journal.runs > 1600
      || journal.supervisors?.length !== journal.runs
      || !unchangedPrefix(checkpoint.supervisors, journal.supervisors)
      || !unchangedPrefix(checkpoint.mutations, journal.mutations)
      || JSON.stringify(journal.budgetAuthorization) !== JSON.stringify(checkpoint.budgetAuthorization)) return null;
    const continuationAdmission = { headSha, checkpointSha256: RUN_E_CHECKPOINT_SHA256, firstRun: 125 };
    if (journal.continuationAdmission === undefined) {
      if (!allowUnpinned || journal.runs !== 124 || journal.mutations.length !== 62
        || git(root, ['diff', '--name-only', 'HEAD'])) return null;
    } else if (journal.runs < 125
      || JSON.stringify(journal.continuationAdmission) !== JSON.stringify(continuationAdmission)) return null;
    return { ...proof, continuationAdmission, scopeCorrections };
  } catch {
    return null;
  }
}

function afterRunEOriginalAdmission(root, headSha) {
  if (headSha === RUN_E_ORIGINAL_ADMISSION) return false;
  try {
    return git(root, ['merge-base', RUN_E_ORIGINAL_ADMISSION, headSha]) === RUN_E_ORIGINAL_ADMISSION;
  } catch {
    return false;
  }
}

export function requiresRunEContinuation(root, journal, headSha) {
  return journal.continuationAdmission !== undefined
    || afterRunEOriginalAdmission(root, headSha)
    || Boolean(journal.budgetAuthorization && journal.budgetAuthorization.headSha !== headSha);
}

/** Missing immutable anchor is ordinary in independent test/branch histories.
 * Capture stderr and distinguish expected absence from probe failure; a caught
 * execFileSync diagnostic would break those public fixtures' clean stderr. */
function runECorrectiveDescendant(root, revision) {
  const probe = (args) => spawnSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const anchor = probe(['rev-parse', '--verify', '--quiet', `${RUN_E_CORRECTIVE_PREDECESSOR}^{commit}`]);
  if (!anchor.error && anchor.status === 1 && anchor.stderr === '') return false;
  if (anchor.error || anchor.status !== 0 || anchor.stderr !== '') return null;
  const target = probe(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  if (target.error || target.status !== 0 || target.stderr !== '') return null;
  if (target.stdout.trim() === RUN_E_CORRECTIVE_PREDECESSOR) return false;
  const ancestry = probe(['merge-base', '--is-ancestor', RUN_E_CORRECTIVE_PREDECESSOR, target.stdout.trim()]);
  if (ancestry.error || ancestry.stderr !== '' || ![0, 1].includes(ancestry.status)) return null;
  return ancestry.status === 0;
}

/** Either actual checkout ancestry or supplied proof selects this obligation.
 * Unexpected Git failures also require proof, which then fails closed. */
export function requiresRunECorrectiveAdmission(root, journal, headSha) {
  return journal?.correctiveAdmission !== undefined
    || runECorrectiveDescendant(root, 'HEAD') !== false
    || runECorrectiveDescendant(root, headSha) !== false;
}

/** One exact corrective candidate preserves both earlier pins and all attempts. */
export function validateRunECorrectiveAdmission(root, journal, headSha, allowUnpinned = false) {
  try {
    if (!Number.isInteger(RUN_E_CORRECTIVE_CHECKPOINT_RUNS)
      || RUN_E_CORRECTIVE_CHECKPOINT_RUNS < 125 || RUN_E_CORRECTIVE_CHECKPOINT_RUNS >= 1600
      || RUN_E_CORRECTIVE_CHECKPOINT_SHA256 === '0'.repeat(64)
      || typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)
      || runECorrectiveDescendant(root, headSha) !== true
      || git(root, ['branch', '--show-current']) !== RUN_E_BRANCH
      || git(root, ['merge-base', headSha, 'HEAD']) !== headSha) return null;
    const fixes = Object.entries(RUN_E_CORRECTIVE_TEST_BLOBS);
    if (fixes.length === 0 || fixes.some(([path, blob]) => !path || !/^[0-9a-f]{40}$/.test(blob))) return null;
    const allowed = new Set([...RUN_E_CONTINUATION_PATHS, ...fixes.map(([path]) => path)]);
    const changed = git(root, ['diff', '--name-only', '--no-renames', RUN_E_CORRECTIVE_PREDECESSOR, headSha]);
    if (changed.split('\n').filter(Boolean).some((path) => !allowed.has(path))) return null;
    for (const [path, blob] of fixes) {
      if (git(root, ['ls-tree', headSha, '--', path]) !== `100644 blob ${blob}\t${path}`) return null;
    }
    const readDocument = (revision, path) => execFileSync('git', ['show', `${revision}:${path}`], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const path of RUN_E_CORRECTIVE_DOCUMENTS) {
      if (!readDocument(headSha, path).startsWith(readDocument(RUN_E_CORRECTIVE_PREDECESSOR, path))) return null;
    }
    const checkpoint = committedRunESection(readDocument(headSha, RUN_E_REVIEW_DOCUMENT), 'CORRECTIVE_CHECKPOINT');
    const keys = 'budgetAuthorization,continuationAdmission,dotenv,mutations,round,runs,supervisors,version';
    if (!checkpoint || sha256(JSON.stringify(checkpoint)) !== RUN_E_CORRECTIVE_CHECKPOINT_SHA256
      || Object.keys(checkpoint).sort().join(',') !== keys
      || checkpoint.runs !== RUN_E_CORRECTIVE_CHECKPOINT_RUNS
      || checkpoint.mutations.some((entry) => entry.state !== 'restored')
      || checkpoint.supervisors.some((entry) => entry.active !== false)
      || JSON.stringify(checkpoint.dotenv) !== JSON.stringify({ open: false, files: [] })) return null;
    // Validate the archived predecessor, never widen the old baseline's paths.
    const proof = validateRunEContinuation(root, checkpoint, RUN_E_CORRECTIVE_PREDECESSOR);
    if (!proof || journal?.version !== checkpoint.version || journal.round !== 2
      || !Number.isInteger(journal.runs) || journal.runs < checkpoint.runs || journal.runs > 1600
      || !Array.isArray(journal.supervisors) || journal.supervisors.length !== journal.runs
      || !Array.isArray(journal.mutations)
      || !unchangedPrefix(checkpoint.supervisors, journal.supervisors)
      || !unchangedPrefix(checkpoint.mutations, journal.mutations)
      || JSON.stringify(journal.budgetAuthorization) !== JSON.stringify(checkpoint.budgetAuthorization)
      || JSON.stringify(journal.continuationAdmission) !== JSON.stringify(checkpoint.continuationAdmission)) return null;
    const correctiveAdmission = {
      headSha, predecessorHeadSha: RUN_E_CORRECTIVE_PREDECESSOR,
      checkpointSha256: RUN_E_CORRECTIVE_CHECKPOINT_SHA256, firstRun: checkpoint.runs + 1,
    };
    if (journal.correctiveAdmission === undefined) {
      if (!allowUnpinned || journal.runs !== checkpoint.runs
        || Object.keys(journal).sort().join(',') !== keys
        || JSON.stringify(journal) !== JSON.stringify(checkpoint)
        || git(root, ['diff', '--name-only', 'HEAD'])
        || git(root, ['ls-files', '--others', '--exclude-standard'])) return null;
    } else if (journal.runs <= checkpoint.runs
      || Object.keys(journal).sort().join(',') !== keys.replace('dotenv,', 'correctiveAdmission,dotenv,')
      || JSON.stringify(journal.correctiveAdmission) !== JSON.stringify(correctiveAdmission)) return null;
    return { ...proof, correctiveAdmission };
  } catch {
    return null;
  }
}

function runEStagingDescendant(root, revision) {
  const probe = (args) => spawnSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const anchor = probe(['rev-parse', '--verify', '--quiet', `${RUN_E_STAGING_DIAGNOSTIC}^{commit}`]);
  if (!anchor.error && anchor.status === 1 && anchor.stderr === '') return false;
  if (anchor.error || anchor.status !== 0 || anchor.stderr !== '') return null;
  const target = probe(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  if (target.error || target.status !== 0 || target.stderr !== '') return null;
  if (target.stdout.trim() === RUN_E_STAGING_DIAGNOSTIC) return false;
  const ancestry = probe(['merge-base', '--is-ancestor', RUN_E_STAGING_DIAGNOSTIC, target.stdout.trim()]);
  if (ancestry.error || ancestry.stderr !== '' || ![0, 1].includes(ancestry.status)) return null;
  return ancestry.status === 0;
}

/** Checkout ancestry and either proof source must survive stripped journal labels. */
export function requiresRunEStagingAdmission(root, journal, headSha) {
  return journal?.stagingCorrectionAdmission !== undefined
    || runEStagingDescendant(root, 'HEAD') !== false
    || runEStagingDescendant(root, headSha) !== false;
}

/** Preserve the finalized 776-launch proof and admit only the reviewed diagnostic blobs. */
export function validateRunEStagingAdmission(root, journal, headSha, allowUnpinned = false) {
  try {
    if (!Number.isInteger(RUN_E_STAGING_CHECKPOINT_RUNS)
      || RUN_E_STAGING_CHECKPOINT_RUNS < 127 || RUN_E_STAGING_CHECKPOINT_RUNS >= 1600
      || RUN_E_STAGING_CHECKPOINT_SHA256 === '0'.repeat(64)
      || typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)
      || runEStagingDescendant(root, headSha) !== true
      || git(root, ['branch', '--show-current']) !== RUN_E_BRANCH
      || git(root, ['merge-base', headSha, 'HEAD']) !== headSha
      || git(root, ['merge-base', RUN_E_STAGING_PREDECESSOR, RUN_E_STAGING_PUBLICATION]) !== RUN_E_STAGING_PREDECESSOR
      || git(root, ['merge-base', RUN_E_STAGING_PUBLICATION, RUN_E_STAGING_DIAGNOSTIC]) !== RUN_E_STAGING_PUBLICATION) return null;
    const blobs = Object.entries(RUN_E_STAGING_BLOBS);
    if (blobs.length === 0 || blobs.some(([path, blob]) => !path || !/^[0-9a-f]{40}$/.test(blob))) return null;
    const allowed = new Set([...RUN_E_CONTINUATION_PATHS, ...blobs.map(([path]) => path)]);
    const changed = git(root, ['diff', '--name-only', '--no-renames', RUN_E_STAGING_PUBLICATION, headSha]);
    if (changed.split('\n').filter(Boolean).some((path) => !allowed.has(path))) return null;
    for (const [path, blob] of blobs) {
      if (git(root, ['ls-tree', headSha, '--', path]) !== `100644 blob ${blob}\t${path}`) return null;
    }
    const readDocument = (revision, path) => execFileSync('git', ['show', `${revision}:${path}`], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const path of RUN_E_CORRECTIVE_DOCUMENTS) {
      if (!readDocument(headSha, path).startsWith(readDocument(RUN_E_STAGING_PUBLICATION, path))) return null;
    }
    const historicalText = readDocument(RUN_E_STAGING_PUBLICATION, RUN_E_REPORT);
    const historicalMarkdown = readDocument(RUN_E_STAGING_PUBLICATION, RUN_E_REPORT.replace(/\.json$/, '.md'));
    if (sha256(historicalText) !== RUN_E_STAGING_REPORT_SHA256
      || sha256(historicalMarkdown) !== RUN_E_STAGING_MARKDOWN_SHA256) return null;
    const stagingHistoricalReport = JSON.parse(historicalText);
    if (stagingHistoricalReport.head_sha !== RUN_E_STAGING_PREDECESSOR
      || stagingHistoricalReport.round !== 2 || !Array.isArray(stagingHistoricalReport.inventory)
      || !Array.isArray(stagingHistoricalReport.findings)) return null;
    const checkpoint = committedRunESection(readDocument(headSha, RUN_E_REVIEW_DOCUMENT), 'STAGING_CHECKPOINT_776');
    const keys = 'budgetAuthorization,continuationAdmission,correctiveAdmission,dotenv,mutations,round,runs,supervisors,version';
    if (!checkpoint || sha256(JSON.stringify(checkpoint)) !== RUN_E_STAGING_CHECKPOINT_SHA256
      || Object.keys(checkpoint).sort().join(',') !== keys
      || checkpoint.runs !== RUN_E_STAGING_CHECKPOINT_RUNS
      || checkpoint.mutations.some((entry) => entry.state !== 'restored')
      || checkpoint.supervisors.some((entry) => entry.active !== false)
      || JSON.stringify(checkpoint.dotenv) !== JSON.stringify({ open: false, files: [] })) return null;
    const proof = validateRunECorrectiveAdmission(root, checkpoint, RUN_E_STAGING_PREDECESSOR);
    if (!proof || journal?.version !== checkpoint.version || journal.round !== 2
      || !Number.isInteger(journal.runs) || journal.runs < checkpoint.runs || journal.runs > 1600
      || !Array.isArray(journal.supervisors) || journal.supervisors.length !== journal.runs
      || !Array.isArray(journal.mutations)
      || !unchangedPrefix(checkpoint.supervisors, journal.supervisors)
      || !unchangedPrefix(checkpoint.mutations, journal.mutations)
      || ['budgetAuthorization', 'continuationAdmission', 'correctiveAdmission']
        .some((key) => JSON.stringify(journal[key]) !== JSON.stringify(checkpoint[key]))) return null;
    const stagingCorrectionAdmission = {
      headSha, predecessorHeadSha: RUN_E_STAGING_PREDECESSOR,
      checkpointSha256: RUN_E_STAGING_CHECKPOINT_SHA256, firstRun: checkpoint.runs + 1,
    };
    if (journal.stagingCorrectionAdmission === undefined) {
      if (!allowUnpinned || journal.runs !== checkpoint.runs
        || Object.keys(journal).sort().join(',') !== keys
        || JSON.stringify(journal) !== JSON.stringify(checkpoint)
        || git(root, ['diff', '--name-only', 'HEAD'])
        || git(root, ['ls-files', '--others', '--exclude-standard'])) return null;
    } else if (journal.runs <= checkpoint.runs
      || Object.keys(journal).sort().join(',') !== keys.replace('supervisors,', 'stagingCorrectionAdmission,supervisors,')
      || JSON.stringify(journal.stagingCorrectionAdmission) !== JSON.stringify(stagingCorrectionAdmission)) return null;
    return {
      ...proof, stagingCorrectionAdmission, stagingHistoricalReport, stagingHistoricalMarkdown: historicalMarkdown,
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
    const headSha = git(root, ['rev-parse', 'HEAD']);
    if (requiresRunEStagingAdmission(root, journal, headSha)) {
      const proof = validateRunEStagingAdmission(root, journal, headSha, true);
      if (!proof || JSON.stringify(JSON.parse(readFileSync(join(root, '.feature/intake.json'), 'utf8')))
        !== JSON.stringify(proof.intake)) return null;
      return { ...proof.grant, stagingCorrectionAdmission: proof.stagingCorrectionAdmission };
    }
    if (requiresRunECorrectiveAdmission(root, journal, headSha)) {
      const proof = validateRunECorrectiveAdmission(root, journal, headSha, true);
      if (!proof || JSON.stringify(JSON.parse(readFileSync(join(root, '.feature/intake.json'), 'utf8')))
        !== JSON.stringify(proof.intake)) return null;
      return { ...proof.grant, correctiveAdmission: proof.correctiveAdmission };
    }
    const continuing = requiresRunEContinuation(root, journal, headSha);
    const proof = continuing
      ? validateRunEContinuation(root, journal, headSha, true)
      : validateRunEAdmission(root, headSha);
    if (!proof || JSON.stringify(JSON.parse(readFileSync(join(root, '.feature/intake.json'), 'utf8')))
      !== JSON.stringify(JSON.parse(git(root, ['show', `${proof.grant.headSha}:${RUN_E_INTAKE}`])))) return null;
    if (!continuing && ((journal.runs > 0 && !journal.budgetAuthorization)
      || (journal.budgetAuthorization && (!sameGrant(journal.budgetAuthorization, proof.grant)
        || journal.budgetAuthorization.firstRun !== 1)))) return null;
    return continuing ? { ...proof.grant, continuationAdmission: proof.continuationAdmission } : proof.grant;
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
  if (requiresOperatorContinuation(root, journal)) return validateOperatorAdmission(root, journal)?.grant ?? null;
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

/**
 * A process serving or watching THIS worktree can execute a mutation under an
 * unscrubbed env. These patterns match by TEXT alone, machine-wide — a hit
 * says nothing about which checkout the process is serving. Scoping a match
 * down to this worktree is `findWorktreeWatchers`'s job (via `processServes`,
 * which reads each match's process cwd), not this list's.
 */
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
 * `ps -Ao pid=,command=` rows that look like a dev server or watch-mode
 * process, by TEXT PATTERN alone, machine-wide. A match here does NOT mean
 * the process is watching this worktree — it means its command line contains
 * one of `WATCHER_PATTERNS`, full stop. Narrowing that down to processes that
 * actually serve a given worktree is `findWorktreeWatchers`'s job.
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
 * The real `cwdOf` behind `processServes`: `pid`'s current working directory,
 * read via `lsof`'s field output (`-Fn` prints an `n`-prefixed name line for
 * the `cwd` file descriptor `-d cwd` selects). Returns the absolute path, or
 * null when it cannot be determined — no `lsof`, the process is already gone,
 * or the read otherwise failed.
 */
function processCwd(pid) {
  const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const line = (result.stdout ?? '').split('\n').find((entry) => entry.startsWith('n'));
  return line ? line.slice(1) : null;
}

/**
 * TRUE when `pid` actually serves the worktree at `root` — its cwd is `root`
 * itself or a path underneath it — or when the cwd could not be read at all.
 *
 * FAILS CLOSED on an unreadable cwd. That is a DECISION, not a swallowed
 * error: admission is a safety gate, so a process this check cannot classify
 * must never become a silent permit — the opposite direction (treating
 * "unknown" as "safe") is exactly the hole a fail-open check would leave.
 *
 * `cwdOf` is the injection seam: tests pass a fake pid->cwd lookup instead of
 * spawning real processes or real `lsof`; production code takes the default.
 */
export function processServes(root, pid, cwdOf = processCwd) {
  const cwd = cwdOf(pid);
  if (cwd === null) return true;
  const boundary = root.endsWith('/') ? root : `${root}/`;
  return cwd === root || cwd.startsWith(boundary);
}

/**
 * `findWatchers` narrowed to the matches that actually serve `root`.
 *
 * `findWatchers` matches by TEXT alone, machine-wide — a watcher serving an
 * unrelated checkout must not block a mutation pass in THIS worktree, which
 * is what made `validateOperatorAdmission` and `cmdWatchers` machine-global
 * despite both claiming worktree scope. This is the seam that actually scopes
 * them: `findWatchers` itself stays pure and untouched.
 */
export function findWorktreeWatchers(psOutput, ignorePids, root, cwdOf = processCwd) {
  return findWatchers(psOutput, ignorePids)
    .filter((line) => processServes(root, Number(line.split(/\s+/)[0]), cwdOf));
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
  // `kill(-1)` signals every process the user owns and `kill(-0)` this process's
  // own group. The journal is a file, so its pgid is input: a corrupt or
  // hand-written entry must never be able to aim the signal below.
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return { ok: false, reason: `pgid ${JSON.stringify(pgid)} is not a signalable process group — refusing` };
  }
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
 * The budget is per ROUND, and the journal outlives a round — so without this
 * the second round would inherit the first round's spent time and launch count
 * and hit the cap having executed nothing. Refusing to open over an unclean journal is
 * the same check in the other direction: a round must never start on top of an
 * unrestored mutation or an open dotenv swap.
 */
function cmdRoundStart(root) {
  const journal = readJournal(root);
  if (requiresOperatorContinuation(root, journal)) {
    console.error('round-start: REFUSED — Operator continuation retains round 1 and its thirty-launch checkpoint');
    return 1;
  }
  const branch = git(root, ['branch', '--show-current']);
  const headSha = git(root, ['rev-parse', 'HEAD']);
  if (requiresRunEStagingAdmission(root, journal, headSha)
    || requiresRunECorrectiveAdmission(root, journal, headSha) || afterRunEOriginalAdmission(root, headSha)) {
    console.error('round-start: REFUSED — Run E continuation retains its existing round and spent launches');
    return 1;
  }
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
  console.log(fourthGrant
    ? `round-start: round ${round} open, ${fourthGrant.maxRuns} mutation runs available`
    : `round-start: round ${round} open, ${ROUND_TIME_BUDGET_MS / 60_000} min of test time available `
      + `(≤${MAX_RUNS_PER_ROUND} launches, ≤${RUN_TIMEOUT_MS / 1000}s each)`);
  return 0;
}

function cmdEnv(root, parsed) {
  const env = commandEnv(root, parsed);
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  console.log(JSON.stringify(env, null, 2));
  return 0;
}

function cmdWatchers(root, parsed) {
  const output = typeof parsed['ps-source'] === 'string'
    ? readFileSync(resolve(parsed['ps-source']), 'utf8')
    : (spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '');
  const matches = findWorktreeWatchers(
    output,
    typeof parsed['ps-source'] === 'string' ? new Set() : selfAncestry(),
    root,
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
  const journal = readJournal(root);
  let operatorMetadata = null;
  if (requiresOperatorContinuation(root, journal)) {
    const proof = validateOperatorAdmission(root, journal);
    operatorMetadata = proof && operatorRunMetadata(root, parsed, proof, journal, 'mutation');
    if (!operatorMetadata || operatorMetadata.target !== parsed.file || sha256(mutantSource) !== operatorMetadata.mutantSha256
      || journal.supervisors.some((entry) => entry.active === true)
      || journal.mutations.some((entry) => entry.state !== 'restored')
      || !journal.supervisors.slice(30).some((entry) => entry.candidateId === operatorMetadata.candidateId
        && entry.attempt === operatorMetadata.attempt && entry.phase === 'baseline'
        && entry.target === operatorMetadata.target && entry.mutantSha256 === operatorMetadata.mutantSha256
        && entry.originalOid === operatorMetadata.originalOid && entry.controlHead === operatorMetadata.controlHead
        && operatorMeasuredAssertion(entry, proof.inventory.find((row) => row.id === entry.candidateId), 'passed'))) {
      console.error('mutate: Operator admission, candidate attempt or green baseline invalid');
      return 1;
    }
  }

  // The original blob is written into the object database BEFORE the mutation,
  // so the finalizer can always restore it even from a fresh process.
  const originalOid = git(root, ['hash-object', '-w', '--', target]);
  journal.mutations.push({
    ...(operatorMetadata ?? {}),
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
  let operatorMetadata = null;
  if (requiresOperatorContinuation(root, journal)) {
    const proof = validateOperatorAdmission(root, journal);
    const timeout = Number(parsed.timeout ?? RUN_TIMEOUT_MS);
    const phaseValid = ['baseline', 'mutant'].includes(parsed.phase);
    const candidateMetadata = proof && phaseValid ? operatorRunMetadata(root, parsed, proof, journal, parsed.phase) : null;
    operatorMetadata = candidateMetadata;
    const candidate = proof?.inventory.find((row) => row.id === parsed.candidate);
    const resultPath = typeof parsed.result === 'string' ? resolve(parsed.result) : null;
    const expectedArgv = ['pnpm', '--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', candidate?.file, '--testNamePattern', parsed.selector,
      '--reporter=json', `--outputFile=${resultPath}`, '--maxWorkers=1'];
    const dotenvSafe = ['.env', '.env.local', '.env.test', '.env.test.local'].every((path) => {
      if (!existsSync(join(root, path))) return true;
      const entry = journal.dotenv?.files?.find((file) => file.path === path);
      return journal.dotenv?.open === true && entry && existsSync(join(root, entry.backupPath))
        && sha256(readFileSync(join(root, path))) === entry.scrubbedSha256;
    });
    const resultPathValid = resultPath !== null && !existsSync(resultPath) && !existsSync(`${resultPath}.supervisor.json`);
    const supervisorClash = journal.supervisors.some((entry) => entry.active === true || entry.resultPath === resultPath);
    const rejection = operatorRunRejectionReason({
      admissionValid: !!proof,
      candidateMetadataValid: !!candidateMetadata,
      argvMatches: JSON.stringify(argv) === JSON.stringify(expectedArgv),
      resultPathValid,
      supervisorClash,
      launchAllowed: operatorLaunchAllowed(journal.runs, timeout),
      dotenvSafe,
      noRelease: parsed['no-release'] === true,
    });
    if (rejection) {
      console.error(`run: refusing the launch — ${rejection}`);
      return 1;
    }
    parsed['tmp-home'] = join(root, '.feature', 'operator-continuation-home', parsed.candidate, String(parsed.attempt));
    const envSha256 = sha256(JSON.stringify(commandEnv(root, parsed)));
    if (parsed.phase === 'mutant' && !journal.supervisors.slice(30).some((entry) =>
      entry.candidateId === operatorMetadata.candidateId && entry.attempt === operatorMetadata.attempt
      && entry.phase === 'baseline' && entry.envSha256 === envSha256)) {
      console.error('run: Operator baseline and mutant environment differ');
      return 1;
    }
    operatorMetadata = { ...operatorMetadata, phase: parsed.phase, resultPath, argv, timeout, envSha256 };
  }
  const runEBranch = git(root, ['branch', '--show-current']) === RUN_E_BRANCH;
  const headSha = git(root, ['rev-parse', 'HEAD']);
  const runEAdmittedHead = headSha === RUN_E_ORIGINAL_ADMISSION || afterRunEOriginalAdmission(root, headSha);
  if (((runEBranch && journal.round !== 1) || runEAdmittedHead || journal.budgetAuthorization?.id === RUN_E_AUTHORIZATION
    || requiresRunECorrectiveAdmission(root, journal, headSha) || requiresRunEStagingAdmission(root, journal, headSha))
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
  // An owner grant is a launch count and nothing else. The ordinary budget is
  // the clock, checked BEFORE the launch: the last launch may overrun by at most
  // its own timeout, so a round is bounded at budget + 120s.
  const spentMs = authorization ? 0 : ordinaryTimeSpentMs(journal);
  if (!authorization && spentMs >= ROUND_TIME_BUDGET_MS) {
    console.error(`run: mutation budget exhausted (${Math.round(spentMs / 1000)}s of `
      + `${ROUND_TIME_BUDGET_MS / 1000}s test time this round, ${journal.runs} launches)`);
    console.error('  Mark the remaining candidates skipped-budget; the status becomes INCOMPLETE_BUDGET.');
    return 1;
  }
  const timeout = Number(parsed.timeout ?? RUN_TIMEOUT_MS);
  // "≤120s per launch" was prose until the budget became a clock. Now the bound
  // on a round is budget + one timeout, so the timeout has to be real.
  if (!authorization && !(Number.isFinite(timeout) && timeout > 0 && timeout <= RUN_TIMEOUT_MS)) {
    console.error(`run: --timeout must be between 1 and ${RUN_TIMEOUT_MS}ms`);
    return 1;
  }
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
  if (authorization?.continuationAdmission && journal.continuationAdmission === undefined) {
    journal.continuationAdmission = authorization.continuationAdmission;
  }
  if (authorization?.correctiveAdmission && journal.correctiveAdmission === undefined) {
    journal.correctiveAdmission = authorization.correctiveAdmission;
  }
  if (authorization?.stagingCorrectionAdmission && journal.stagingCorrectionAdmission === undefined) {
    journal.stagingCorrectionAdmission = authorization.stagingCorrectionAdmission;
  }
  // Granted runs keep their journal byte-for-byte: their checkpoints compare it.
  const timed = !authorization;
  const launchedAt = Date.now();
  journal.supervisors.push({
    ...(operatorMetadata ?? {}),
    pid,
    pgid: pid,
    startedAt,
    active: true,
    command: argv[0],
    at: new Date().toISOString(),
    ...(timed ? { timeoutMs: timeout } : {}),
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
  if (record && timed) record.elapsedMs = Date.now() - launchedAt;
  if (record && operatorMetadata) {
    Object.assign(record, { timedOut: outcome.timedOut, code: outcome.code ?? null, signal: outcome.signal ?? null });
    record.resultSha256 = existsSync(record.resultPath) ? sha256(readFileSync(record.resultPath)) : null;
    const receipt = Buffer.from(JSON.stringify(record));
    const supervisorPath = `${record.resultPath}.supervisor.json`;
    writeFileSync(supervisorPath, receipt, { flag: 'wx', mode: 0o600 });
    record.supervisorPath = supervisorPath;
    record.supervisorSha256 = sha256(receipt);
  }
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
  if (timed) {
    console.log(`run: budget — ${Math.round(ordinaryTimeSpentMs(current) / 1000)}s of `
      + `${ROUND_TIME_BUDGET_MS / 1000}s test time, ${current.runs} of ${MAX_RUNS_PER_ROUND} launches`);
  }
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
    case 'watchers': return cmdWatchers(root, parsed);
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
