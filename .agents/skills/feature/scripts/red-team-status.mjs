#!/usr/bin/env node

/**
 * red-team-status.mjs — the fail-closed gate for a `/red-team` pass.
 *
 * WHY THIS IS CODE AND NOT PROSE. "An open P0 blocks the ship" was, in the
 * plan's first three review rounds, an instruction nothing read. Instructions
 * are not gates. This script is the gate: `transition-state.mjs` runs it on the
 * `reviewed` transition and the Claude lane runs it before `gh pr ready`, so a
 * missing, self-inconsistent, or STALE red-team report fails a phase change
 * rather than being noticed later.
 *
 * THE REQUIREMENT IS RISK-SCOPED (2026-08-31). A feature-lane run whose
 * signed-off intake declares `risk: high` requires the sidecar; absence is
 * failure. A `risk: normal` run may omit the pass — absence records a WAIVED
 * pass instead, derived ONLY from `.feature/intake.json` (missing, unreadable,
 * or risk-less intakes fail closed). A sidecar that exists is always validated
 * in full, whatever the risk. Rationale: the review wave's cost must scale
 * with failure impact, and the repository's deterministic gate plus the review
 * axes remain the normal-risk safety layer.
 *
 * IT NEVER TRUSTS THE SIDECAR'S OWN SUMMARY. `status` and `counts` are
 * RECOMPUTED from the deduped inventory rows and finding dispositions, then
 * compared against what the file claims. A sidecar that says `CLEAR` while its
 * inventory holds a confirmed survivor fails here, not in review.
 *
 * RUN BINDING IS MODE-AWARE AND NON-CIRCULAR. The expected report path is
 * derived from inputs this script resolves itself — the current branch in
 * `feature` mode, `--issue` plus `--head` on a detached standalone run — never
 * from the sidecar under validation. Deriving the path from a value stored
 * inside the file being checked would let the file choose its own identity.
 *
 * Exit codes: 0 pass, 1 fail, 2 usage error.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  requiresOperatorContinuation, validOperatorReport,
  runCFourthAuthorization, validRunCFourthReport,
  runEThirdRoundForbidden, validateRunEAdmission, validateRunEContinuation, requiresRunEContinuation,
  requiresRunECorrectiveAdmission, validateRunECorrectiveAdmission,
  requiresRunEStagingAdmission, validateRunEStagingAdmission,
} from '../../red-team/scripts/mutation-runner.mjs';

const RUN_E_BRANCH = 'codex/owner-operator-run-e';
const RUN_E_GRANT = 'owner-run-e-second-pass-1600';
const RUN_E_REPORT = 'docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/findings.json';
const RUN_E_SCOPE_CORRECTIONS_SHA256 = 'ec9afe3a0eb73387201dc1783c8628f96f543355761cf15f5509d9155dfbaf0e';

/** Root-reviewed discovery corrections are finite evidence, not a coverage waiver. */
function runEScopeCorrections(root, admissionHead) {
  const document = makeGit(root)(['show', `${admissionHead}:docs/reviews/codex-owner-operator-run-e/budget-extension-review.md`]);
  const start = '<!-- RUN_E_SCOPE_CORRECTIONS_START -->';
  const end = '<!-- RUN_E_SCOPE_CORRECTIONS_END -->';
  if (document.split(start).length !== 2 || document.split(end).length !== 2) return null;
  const payload = document.slice(document.indexOf(start) + start.length, document.indexOf(end))
    .match(/^\s*```json\s*\n([\s\S]*?)\n```\s*$/);
  if (!payload) return null;
  const manifest = JSON.parse(payload[1]);
  if (sha256(JSON.stringify(manifest)) !== RUN_E_SCOPE_CORRECTIONS_SHA256
    || manifest.schema !== 1 || !Array.isArray(manifest.groups)) return null;
  const corrections = new Map();
  for (const group of manifest.groups) {
    if (!isPlainObject(group) || !nonEmptyString(group.reason) || !Array.isArray(group.ids)) return null;
    for (const id of group.ids) {
      if (!nonEmptyString(id) || corrections.has(id)) return null;
      corrections.set(id, group.reason);
    }
  }
  return corrections;
}

/** Statuses, most-blocking first. The recomputation returns the first that fires. */
const STATUS_PRECEDENCE = [
  'OPEN_P0',
  'INCOMPLETE_INFRA',
  'INCOMPLETE_ORACLE',
  'INCOMPLETE_BUDGET',
  'OPEN_P1',
  'CLEAR',
];

// `equivalent` is NOT a softer `inconclusive`. It is a claim about the MUTANT —
// that it provably preserves behaviour, so no test could kill it — where
// `inconclusive/oracle` is a claim about the ORACLE, that a test SHOULD have
// killed it and none did. Before this member existed the two collapsed into
// one, and a run whose only survivors were provably equivalent could never
// reach CLEAR (feat/1013 deviation D11). The row must carry the proof in its
// `reason`, and it may not also raise a finding.
const OUTCOMES = new Set([
  'killed',
  'survived-confirmed-P0',
  'equivalent',
  'inconclusive',
  'skipped-budget',
  'excluded',
]);

const SEVERITIES = new Set(['P0', 'P1', 'P2']);
const DISPOSITIONS = new Set(['open', 'fixed', 'rejected', 'accepted-risk']);
const MODES = new Set(['feature', 'standalone']);
const RISKS = new Set(['normal', 'high']);

const TOP_LEVEL_KEYS = new Set([
  'schema',
  'mode',
  'run_id',
  'branch',
  'fork_sha',
  'merge_base_sha',
  'head_sha',
  'intake_sha256',
  'risk',
  'round',
  'generated_at',
  'inventory',
  'findings',
  'authorizations',
  'operatorVerifierCorrection',
  'operatorSelectionCorrection',
  'remeasurement',
  'counts',
  'status',
]);

/** Present only on the sidecars that carry them; every other top-level key is required. */
const OPTIONAL_TOP_LEVEL_KEYS = new Set([
  'operatorVerifierCorrection',
  'operatorSelectionCorrection',
  'remeasurement',
]);

const ROW_KEYS = new Set([
  'id',
  'test',
  'file',
  'outcome',
  'reason',
  'inconclusive_class',
  'finding_id',
  'type_check',
]);

// `type_check` RECORDS a measurement, so it belongs only on a row that carries
// a measured, terminal outcome (#1343). See `validateTypeCheck`.
const TYPE_CHECK_OUTCOMES = new Set(['killed', 'survived-confirmed-P0']);
const TYPE_CHECK_KEYS = new Set(['command', 'mutants']);
const TYPE_CHECK_MUTANT_KEYS = new Set(['mutation', 'exit_code', 'output_identical']);

const REMEASUREMENT_KEYS = new Set(['of_round', 'at', 'prior_commit', 'fixes']);
const REMEASUREMENT_FIX_KEYS = new Set(['finding_id', 'rows']);

// Every branch-pinned grant states its own ceiling and none of them
// contemplates a re-measurement round. `remeasure-start` refuses on each; this
// is the checker's own copy of that refusal, for the reason the round-3 rule
// gives — a sidecar must never be able to claim a round the runner would have
// refused, and the runner's journal is scratch that is routinely gone by the
// time this runs.
const REMEASUREMENT_FORBIDDEN_BRANCHES = new Set([
  'codex/owner-operator-run-d',
  'codex/owner-operator-run-e',
  'codex/operator-fallow-refactor',
  'codex/owner-operator-run-c',
]);

const FINDING_KEYS = new Set([
  'id',
  'severity',
  'title',
  'at',
  'duty',
  'disposition',
  'reason',
  'authorization',
  'arbiter_reasoning',
]);

const AUTHORIZATION_KEYS = new Set(['id', 'date', 'finding_ids', 'text']);

const COUNT_KEYS = [
  'inventory_total',
  'killed',
  'survived_confirmed_p0',
  'equivalent',
  'inconclusive',
  'skipped_budget',
  'excluded',
  'findings_total',
  'p0_open',
  'p1_open',
  'p2_open',
  'accepted_risk',
  'fixed',
  'rejected',
];

const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// pure helpers — every rule that decides pass or fail lives in one of these
// ---------------------------------------------------------------------------

export function sanitizeSlugBase(value) {
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return cleaned.length > 0 ? cleaned : 'run';
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The report identity.
 *
 * A checked-out branch names the run. Only a detached standalone run falls back
 * to the issue reference plus the short head SHA, which is why `--head` is a CLI
 * input and not a `git rev-parse`: the report commit moves HEAD, and the run's
 * identity must survive its own commit.
 */
export function deriveIdentity({ mode, branch, issue, headSha }) {
  const hasBranch = typeof branch === 'string' && branch.length > 0;
  const identity = hasBranch ? branch : `${issue}@${headSha}`;
  const base = hasBranch ? branch : `${issue}-${String(headSha).slice(0, 7)}`;
  const slug = `${sanitizeSlugBase(base)}-${sha256(identity).slice(0, 6)}`;
  return { slug, runId: `${mode}-${slug}`, branch: hasBranch ? branch : null };
}

/** The Codex intake names it `risk`; the Claude intake names it `classification`. */
export function normalizeRisk(intake) {
  if (!intake || typeof intake !== 'object') return null;
  if (typeof intake.risk === 'string') {
    return RISKS.has(intake.risk) ? intake.risk : null;
  }
  if (typeof intake.classification === 'string') {
    return intake.classification === 'high' ? 'high' : 'normal';
  }
  return null;
}

export function recomputeCounts(sidecar) {
  const rows = sidecar.inventory ?? [];
  const findings = sidecar.findings ?? [];
  const byOutcome = (outcome) => rows.filter((row) => row.outcome === outcome).length;
  const openOf = (severity) =>
    findings.filter((f) => f.severity === severity && f.disposition === 'open').length;
  return {
    inventory_total: rows.length,
    killed: byOutcome('killed'),
    survived_confirmed_p0: byOutcome('survived-confirmed-P0'),
    equivalent: byOutcome('equivalent'),
    inconclusive: byOutcome('inconclusive'),
    skipped_budget: byOutcome('skipped-budget'),
    excluded: byOutcome('excluded'),
    findings_total: findings.length,
    p0_open: openOf('P0'),
    p1_open: openOf('P1'),
    p2_open: openOf('P2'),
    accepted_risk: findings.filter((f) => f.disposition === 'accepted-risk').length,
    fixed: findings.filter((f) => f.disposition === 'fixed').length,
    rejected: findings.filter((f) => f.disposition === 'rejected').length,
  };
}

/**
 * The status, derived from rows and dispositions alone.
 *
 * An empty inventory is never CLEAR: step 6 of the plan requires every
 * behaviour-affecting production hunk to reach the inventory through reverse
 * import search, so "nothing to check" means the inventory was not built.
 */
export function recomputeStatus(sidecar) {
  const rows = sidecar.inventory ?? [];
  const counts = recomputeCounts(sidecar);
  if (counts.p0_open > 0) return 'OPEN_P0';
  if (rows.some((row) => row.outcome === 'inconclusive' && row.inconclusive_class === 'infra')) {
    return 'INCOMPLETE_INFRA';
  }
  if (rows.some((row) => row.outcome === 'inconclusive' && row.inconclusive_class === 'oracle')) {
    return 'INCOMPLETE_ORACLE';
  }
  if (rows.length === 0) return 'INCOMPLETE_ORACLE';
  if (counts.skipped_budget > 0) return 'INCOMPLETE_BUDGET';
  if (counts.p1_open > 0) return 'OPEN_P1';
  return 'CLEAR';
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKeys(scope, object, allowed, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${scope}: unknown field '${key}'`);
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A row whose ONLY oracle is the type checker (#1343).
 *
 * `inconclusive`/`oracle` is a claim that a row was NOT MEASURED — it was never
 * a claim that the row is unmeasurable. A type-only change (an annotation, a
 * narrowed predicate) has no vitest oracle at all, so no mutation could ever
 * resolve it and `recomputeStatus` pinned `INCOMPLETE_ORACLE` forever: a branch
 * that added one could never reach `CLEAR`, however clean it was. `type_check`
 * is the missing measurement record. Both mutants, both exit codes, and whether
 * the output was identical, so the row's terminal outcome is CORROBORATED by
 * what is written down rather than asserted.
 *
 * THE GUARD THIS MUST NOT DISSOLVE: a row that records no measurement is still
 * `inconclusive`/`oracle` and still pins the status. `recomputeStatus` is
 * untouched — this field cannot appear on an unmeasured outcome at all.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not pin the measurement to a
 * committed artifact the way the branch-scoped budget grants pin theirs. Every
 * inventory outcome in this schema is already the runner's own report of what
 * it observed — a row may say `killed` today with nothing corroborating it —
 * so `type_check` records strictly MORE than the outcome it accompanies, not
 * less. It is evidence written down, not a new class of trust.
 */
function validateTypeCheck(scope, row, errors) {
  const measurement = row.type_check;
  if (measurement === undefined) return;
  if (!TYPE_CHECK_OUTCOMES.has(row.outcome)) {
    errors.push(
      `${scope}: type_check belongs only on a ${[...TYPE_CHECK_OUTCOMES].join(' or ')} row `
      + '— it records a measurement, so it can never accompany an unmeasured outcome',
    );
    return;
  }
  if (!isPlainObject(measurement)) {
    errors.push(`${scope}.type_check must be an object`);
    return;
  }
  checkKeys(`${scope}.type_check`, measurement, TYPE_CHECK_KEYS, errors);
  if (!nonEmptyString(measurement.command)) {
    errors.push(`${scope}.type_check.command must name the type-check command that measured the row`);
  }
  // The claim "the type checker is this row's ONLY oracle" is not derivable
  // from the schema, so it has to be STATED. A reviewer reading the sidecar can
  // then disagree with it; an unstated premise nobody can see, nobody checks.
  if (!nonEmptyString(row.reason)) {
    errors.push(`${scope}: a type_check row must record why the type checker is its only oracle`);
  }
  // Exactly two: the standing per-test limit is two mutations, and ONE mutant
  // that the type checker ignored is not enough evidence to leave the oracle
  // class — the second is what distinguishes "nothing consumes this" from "that
  // particular weakening happened to be invisible".
  if (!Array.isArray(measurement.mutants) || measurement.mutants.length !== 2) {
    errors.push(`${scope}.type_check.mutants must record exactly 2 measured mutants`);
    return;
  }
  const reacted = [];
  for (const [index, mutant] of measurement.mutants.entries()) {
    const mutantScope = `${scope}.type_check.mutants[${index}]`;
    if (!isPlainObject(mutant)) {
      errors.push(`${mutantScope} must be an object`);
      return;
    }
    checkKeys(mutantScope, mutant, TYPE_CHECK_MUTANT_KEYS, errors);
    if (!nonEmptyString(mutant.mutation)) {
      errors.push(`${mutantScope}.mutation must describe the mutant that was type-checked`);
    }
    if (!Number.isInteger(mutant.exit_code) || mutant.exit_code < 0) {
      errors.push(`${mutantScope}.exit_code must be a non-negative integer`);
    }
    if (typeof mutant.output_identical !== 'boolean') {
      errors.push(`${mutantScope}.output_identical must be a boolean`);
    }
    reacted.push(mutant.exit_code !== 0 || mutant.output_identical === false);
  }
  if (row.outcome === 'killed' && !reacted.every(Boolean)) {
    errors.push(
      `${scope}: a killed type_check row needs the type checker to have reacted to EVERY mutant `
      + '— a non-zero exit or different output',
    );
  }
  if (row.outcome === 'survived-confirmed-P0' && reacted.every(Boolean)) {
    errors.push(
      `${scope}: a survived type_check row needs at least one mutant the type checker did not `
      + 'react to (exit 0, byte-identical output) — that survival IS the finding',
    );
  }
}

/**
 * The re-measurement round's own record (#1342) — shape only; history below.
 *
 * `SKILL.md` § "The loop" owns the rule. What is enforced here is the bound:
 * one entry per raised finding, every re-measured row named, and the round
 * number unmoved. A re-measurement round is not a fourth round and matches no
 * authorization prose, which is the whole point — the prose generalisation was
 * tried on #1340 and reverted because `RUN_C_FOURTH_TEXT` contains the literal
 * phrase "approve the scoped fourth round".
 */
function remeasurementShapeErrors(sidecar, rowIds, findingIds) {
  const block = sidecar.remeasurement;
  if (!isPlainObject(block)) return ['remeasurement must be an object'];
  const errors = [];
  checkKeys('remeasurement', block, REMEASUREMENT_KEYS, errors);
  for (const key of REMEASUREMENT_KEYS) {
    if (!(key in block)) errors.push(`remeasurement: missing required field '${key}'`);
  }
  if (sidecar.round !== 2 && sidecar.round !== 3) {
    errors.push(
      'remeasurement belongs only to a run that has spent its last fresh round (2, or an '
      + 'authorized 3) — round 4 is the branch-pinned Run C contract and never carries one',
    );
  }
  if (block.of_round !== sidecar.round) {
    errors.push('remeasurement.of_round must equal round — a re-measurement round does not advance the round number');
  }
  if (REMEASUREMENT_FORBIDDEN_BRANCHES.has(sidecar.branch)) {
    errors.push(`remeasurement: the branch-pinned grant on ${sidecar.branch} admits no re-measurement round`);
  }
  const authorizations = Array.isArray(sidecar.authorizations) ? sidecar.authorizations : [];
  if (authorizations.some((authorization) => authorization?.id === RUN_E_GRANT)) {
    errors.push('remeasurement: the Run E grant admits no re-measurement round');
  }
  // The same predicate `round-start` uses, read the same way — but here it can
  // only REFUSE. A re-measurement round opens where the fresh-round cap closes;
  // while the owner has granted a round that is still unspent, that round is
  // the stronger instrument and this one is not available.
  if (sidecar.round === 2
    && authorizations.some((entry) => /third round/i.test(String(entry?.text ?? '')))) {
    errors.push('remeasurement: a fresh third round is authorized and still available — that round, not this');
  }
  if (block.at !== sidecar.head_sha) {
    errors.push('remeasurement.at must equal head_sha — the re-measurement is measured at the sidecar head');
  }
  if (!SHA1_RE.test(String(block.prior_commit))) {
    errors.push('remeasurement.prior_commit must be a full 40-character object id');
  }
  if (!Array.isArray(block.fixes) || block.fixes.length === 0) {
    errors.push('remeasurement.fixes must name at least one raised finding whose fix was re-measured');
    return errors;
  }
  const byFindingId = new Map((sidecar.findings ?? []).map((finding) => [finding.id, finding]));
  const seenFindings = new Set();
  const seenRows = new Set();
  for (const [index, fix] of block.fixes.entries()) {
    const scope = `remeasurement.fixes[${index}]`;
    if (!isPlainObject(fix)) {
      errors.push(`${scope} must be an object`);
      continue;
    }
    checkKeys(scope, fix, REMEASUREMENT_FIX_KEYS, errors);
    if (!nonEmptyString(fix.finding_id) || !findingIds.has(fix.finding_id)) {
      errors.push(`${scope}.finding_id must resolve to a finding in this sidecar`);
    } else if (seenFindings.has(fix.finding_id)) {
      errors.push(`${scope}.finding_id duplicates '${fix.finding_id}' — one re-measurement per raised finding`);
    } else {
      seenFindings.add(fix.finding_id);
      if (byFindingId.get(fix.finding_id).disposition === 'open') {
        errors.push(
          `${scope}: finding '${fix.finding_id}' is still open — a re-measurement round measures `
          + 'a FIX, so the finding it names must carry a disposition',
        );
      }
    }
    if (!Array.isArray(fix.rows) || fix.rows.length === 0) {
      errors.push(`${scope}.rows must name at least one re-measured inventory row`);
      continue;
    }
    for (const id of fix.rows) {
      if (!nonEmptyString(id) || !rowIds.has(id)) {
        errors.push(`${scope}.rows: ${JSON.stringify(id)} resolves to no inventory row`);
        continue;
      }
      if (seenRows.has(id)) errors.push(`${scope}.rows: '${id}' is claimed by more than one fix`);
      seenRows.add(id);
      // Naming a row exempts it from the byte-identity rule below, so naming
      // one and then NOT measuring it is the way to launder an inventory row
      // through a re-measurement round. `excluded` and `skipped-budget` are the
      // two outcomes that mean "deliberately not measured" — a re-measurement
      // round may not end on either. An honest `inconclusive` is allowed: it
      // pins the status on its own, which is the correct outcome.
      const row = (sidecar.inventory ?? []).find((candidate) => candidate.id === id);
      if (row && (row.outcome === 'excluded' || row.outcome === 'skipped-budget')) {
        errors.push(
          `${scope}.rows: '${id}' ends '${row.outcome}' — a re-measurement round MEASURES `
          + 'every row it names',
        );
      }
    }
  }
  return errors;
}

/** Strict shape validation. Returns the error list; empty means the shape is legal. */
export function validateShape(sidecar) {
  const errors = [];
  if (!isPlainObject(sidecar)) return ['findings.json must be one JSON object'];

  checkKeys('findings.json', sidecar, TOP_LEVEL_KEYS, errors);
  for (const key of TOP_LEVEL_KEYS) {
    if (!OPTIONAL_TOP_LEVEL_KEYS.has(key) && !(key in sidecar)) errors.push(`findings.json: missing required field '${key}'`);
  }

  if (sidecar.operatorSelectionCorrection !== undefined) {
    const correction = sidecar.operatorSelectionCorrection;
    if (sidecar.branch !== 'codex/operator-fallow-refactor' || !isPlainObject(correction)) {
      errors.push('operatorSelectionCorrection requires the exact Operator branch and an object');
    } else {
      checkKeys('operatorSelectionCorrection', correction,
        new Set(['id', 'priorControl', 'controlHead', 'checkpointSha256', 'failedSelection', 'failedFixture', 'reevaluation']), errors);
      if (correction.id !== 'operator-fallow-round-1-selection-and-resolves'
        || correction.priorControl !== 'e3bd968ae9fca8e0d787291cf067c266e67d89f9'
        || !SHA1_RE.test(String(correction.controlHead))
        || correction.checkpointSha256 !== '0942d85131597e501bf50f38d0f4868d02d007e8f0e37ee9efc051ba227a4d6e') errors.push('operatorSelectionCorrection identity is invalid');
      for (const [key, id, digest] of [
        ['failedSelection', 'rt-0103', '4366858d241421e1482fec183be29e25247aca86f40c6ca18b07767a0d542fd7'],
        ['failedFixture', 'rt-0516', '77eb90a39e53da98aa61020e3d5ae864aa73ee1c4e1ea9b97917466d51806a01'],
        ['reevaluation', 'rt-0144', '468489f392cedd75a85b6b13892b12eae10028389e6e56223aedc3fedd874f13'],
      ]) {
        const row = correction[key];
        if (!isPlainObject(row)) { errors.push(`operatorSelectionCorrection ${key} must be an object`); continue; }
        checkKeys(`operatorSelectionCorrection ${key}`, row,
          new Set(['candidateId', 'measurementSha256', 'originalSuggestion', key !== 'reevaluation' ? 'retained' : 'outcome']), errors);
        if (row.candidateId !== id || row.measurementSha256 !== digest || row.originalSuggestion !== 'inconclusive'
          || (key !== 'reevaluation' ? row.retained !== true : !OUTCOMES.has(row.outcome))) {
          errors.push(`operatorSelectionCorrection ${key} is invalid`);
        }
      }
    }
  }

  if (sidecar.operatorVerifierCorrection !== undefined) {
    const correction = sidecar.operatorVerifierCorrection;
    if (sidecar.branch !== 'codex/operator-fallow-refactor' || !isPlainObject(correction)) {
      errors.push('operatorVerifierCorrection requires the exact Operator branch and an object');
    } else {
      checkKeys('operatorVerifierCorrection', correction, new Set(['id', 'controlHead', 'checkpointSha256', 'reevaluations']), errors);
      if (correction.id !== 'operator-fallow-round-1-file-accounting-42'
        || !SHA1_RE.test(String(correction.controlHead))
        || correction.checkpointSha256 !== '91b56fcabdcc94a08d0fa18cce3db5e8fc3f287eb32148cc3fe5036432cc2e8b'
        || !Array.isArray(correction.reevaluations) || correction.reevaluations.length !== 6) {
        errors.push('operatorVerifierCorrection has invalid identity, control revision or checkpoint');
      } else {
        const seen = new Set();
        for (const row of correction.reevaluations) {
          if (!isPlainObject(row)) { errors.push('operatorVerifierCorrection reevaluation must be an object'); continue; }
          checkKeys('operatorVerifierCorrection reevaluation', row,
            new Set(['candidateId', 'measurementSha256', 'originalSuggestion', 'outcome']), errors);
          if (!nonEmptyString(row.candidateId) || seen.has(row.candidateId)
            || !SHA256_RE.test(String(row.measurementSha256)) || row.originalSuggestion !== 'inconclusive'
            || !OUTCOMES.has(row.outcome)) errors.push('operatorVerifierCorrection reevaluation is invalid');
          seen.add(row.candidateId);
        }
      }
    }
  }

  if (sidecar.schema !== 1) errors.push('schema must equal 1');
  if (!MODES.has(sidecar.mode)) errors.push('mode must be feature or standalone');
  if (!nonEmptyString(sidecar.run_id)) errors.push('run_id must be a non-empty string');
  if (sidecar.branch !== null && !nonEmptyString(sidecar.branch)) {
    errors.push('branch must be a non-empty string or null');
  }
  if (sidecar.mode === 'feature' && sidecar.branch === null) {
    errors.push('branch must not be null in feature mode');
  }
  for (const key of ['fork_sha', 'merge_base_sha', 'head_sha']) {
    if (typeof sidecar[key] !== 'string' || !SHA1_RE.test(sidecar[key])) {
      errors.push(`${key} must be a full 40-character object id`);
    }
  }
  if (sidecar.intake_sha256 !== null && !SHA256_RE.test(String(sidecar.intake_sha256))) {
    errors.push('intake_sha256 must be a 64-character hex digest or null');
  }
  if (!RISKS.has(sidecar.risk)) errors.push('risk must be normal or high');
  // Rounds 1 and 2 stand on their own. A THIRD is legal only when the sidecar
  // itself carries the owner authorization that opened it — the same condition
  // `mutation-runner.mjs round-start` enforces, re-checked here so a sidecar can
  // never claim a round the runner would have refused. The one scoped Run C
  // fourth round also needs committed admission and journal proof below.
  //
  // The cap and the reasons for it have ONE owner: `red-team/SKILL.md` § "The
  // loop". This cap is for FRESH adversarial rounds; the last round's own fixes
  // are re-measured by the re-measurement round, which leaves `round` alone and
  // records itself in `remeasurement` (validated above and below).
  const eGrant = Array.isArray(sidecar.authorizations)
    && sidecar.authorizations.some((authorization) => authorization?.id === RUN_E_GRANT);
  if (runEThirdRoundForbidden(sidecar.branch, eGrant ? RUN_E_GRANT : null, sidecar.round)) {
    errors.push('Run E grants round 2 only; third and higher rounds are forbidden regardless of authorization prose');
  } else if (sidecar.round === 3) {
    const authorizations = Array.isArray(sidecar.authorizations) ? sidecar.authorizations : [];
    if (!authorizations.some((entry) => /third round/i.test(String(entry?.text ?? '')))) {
      errors.push('round 3 requires an authorizations entry whose text names the third round');
    }
  } else if (sidecar.round !== 1 && sidecar.round !== 2
    && !(sidecar.round === 4 && runCFourthAuthorization(sidecar))) {
    errors.push('round must be 1, 2, or an authorized 3 (hard cap)');
  }
  if (!nonEmptyString(sidecar.generated_at)) errors.push('generated_at must be a non-empty string');
  if (!STATUS_PRECEDENCE.includes(sidecar.status)) {
    errors.push(`status must be one of ${STATUS_PRECEDENCE.join(', ')}`);
  }
  if (!Array.isArray(sidecar.inventory)) errors.push('inventory must be an array');
  if (!Array.isArray(sidecar.findings)) errors.push('findings must be an array');
  if (!Array.isArray(sidecar.authorizations)) errors.push('authorizations must be an array');
  if (!isPlainObject(sidecar.counts)) errors.push('counts must be an object');

  if (errors.length > 0) return errors;

  const rowIds = new Set();
  for (const [index, row] of sidecar.inventory.entries()) {
    const scope = `inventory[${index}]`;
    if (!isPlainObject(row)) {
      errors.push(`${scope} must be an object`);
      continue;
    }
    checkKeys(scope, row, ROW_KEYS, errors);
    if (!nonEmptyString(row.id)) errors.push(`${scope}.id must be a non-empty string`);
    else if (rowIds.has(row.id)) errors.push(`${scope}.id duplicates '${row.id}'`);
    else rowIds.add(row.id);
    if (!nonEmptyString(row.test)) errors.push(`${scope}.test must be a non-empty string`);
    if (!nonEmptyString(row.file)) errors.push(`${scope}.file must be a non-empty string`);
    if (!OUTCOMES.has(row.outcome)) {
      errors.push(`${scope}.outcome must be one of ${[...OUTCOMES].join(', ')}`);
      continue;
    }
    if (row.outcome === 'excluded' && !nonEmptyString(row.reason)) {
      errors.push(`${scope}: an excluded row must record a reason`);
    }
    if (row.outcome === 'equivalent') {
      if (!nonEmptyString(row.reason)) {
        errors.push(`${scope}: an equivalent row must record the proof that behaviour is preserved`);
      }
      if (row.finding_id !== undefined) {
        errors.push(`${scope}: an equivalent row may not reference a finding — it claims the mutant changes nothing`);
      }
    }
    if (row.outcome === 'inconclusive') {
      if (row.inconclusive_class !== 'oracle' && row.inconclusive_class !== 'infra') {
        errors.push(`${scope}: an inconclusive row must set inconclusive_class to oracle or infra`);
      }
      if (!nonEmptyString(row.reason)) {
        errors.push(`${scope}: an inconclusive row must record a reason`);
      }
    } else if (row.inconclusive_class !== undefined) {
      errors.push(`${scope}: inconclusive_class belongs only on an inconclusive row`);
    }
    if (row.outcome === 'survived-confirmed-P0' && !nonEmptyString(row.finding_id)) {
      errors.push(`${scope}: a confirmed survivor must reference the P0 finding it raised`);
    }
    validateTypeCheck(scope, row, errors);
  }

  const findingIds = new Set();
  for (const [index, finding] of sidecar.findings.entries()) {
    const scope = `findings[${index}]`;
    if (!isPlainObject(finding)) {
      errors.push(`${scope} must be an object`);
      continue;
    }
    checkKeys(scope, finding, FINDING_KEYS, errors);
    if (!nonEmptyString(finding.id)) errors.push(`${scope}.id must be a non-empty string`);
    else if (findingIds.has(finding.id)) errors.push(`${scope}.id duplicates '${finding.id}'`);
    else findingIds.add(finding.id);
    if (!SEVERITIES.has(finding.severity)) errors.push(`${scope}.severity must be P0, P1, or P2`);
    if (!nonEmptyString(finding.title)) errors.push(`${scope}.title must be a non-empty string`);
    if (!nonEmptyString(finding.at)) errors.push(`${scope}.at must name a file:line`);
    if (!Number.isInteger(finding.duty) || finding.duty < 1 || finding.duty > 5) {
      errors.push(`${scope}.duty must be an integer 1-5`);
    }
    if (!DISPOSITIONS.has(finding.disposition)) {
      errors.push(`${scope}.disposition must be one of ${[...DISPOSITIONS].join(', ')}`);
      continue;
    }
    // Exclusive dispositions: a finding is never both open and accepted-risk.
    if (finding.disposition === 'rejected' && !nonEmptyString(finding.reason)) {
      errors.push(`${scope}: a rejected finding must carry its one-line verdict`);
    }
    if (finding.disposition === 'accepted-risk' && !nonEmptyString(finding.authorization)) {
      errors.push(`${scope}: an accepted-risk finding must reference an authorization`);
    }
    if (finding.disposition !== 'accepted-risk' && finding.authorization !== undefined) {
      errors.push(`${scope}: authorization belongs only on an accepted-risk finding`);
    }
  }

  const authorizationIds = new Set();
  // This exact grant authorizes verification work, not accepting any finding.
  // Its owner-recorded empty list must remain empty; risk links still reject it.
  const fourthRoundGrant = sidecar.round === 3 || sidecar.round === 4
    ? runCFourthAuthorization(sidecar)
    : null;
  for (const [index, authorization] of sidecar.authorizations.entries()) {
    const scope = `authorizations[${index}]`;
    if (!isPlainObject(authorization)) {
      errors.push(`${scope} must be an object`);
      continue;
    }
    checkKeys(scope, authorization, AUTHORIZATION_KEYS, errors);
    if (!nonEmptyString(authorization.id)) errors.push(`${scope}.id must be a non-empty string`);
    else if (authorizationIds.has(authorization.id)) {
      errors.push(`${scope}.id duplicates '${authorization.id}'`);
    } else authorizationIds.add(authorization.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(authorization.date ?? ''))) {
      errors.push(`${scope}.date must be YYYY-MM-DD`);
    }
    if (!nonEmptyString(authorization.text)) {
      errors.push(`${scope}.text must carry the verbatim approval`);
    }
    if (
      !Array.isArray(authorization.finding_ids)
      || (authorization.finding_ids.length === 0 && authorization !== fourthRoundGrant)
      || authorization.finding_ids.some((id) => !nonEmptyString(id))
    ) {
      errors.push(`${scope}.finding_ids must be a non-empty array of finding ids`);
    }
  }

  for (const [index, row] of sidecar.inventory.entries()) {
    if (row?.finding_id !== undefined && !findingIds.has(row.finding_id)) {
      errors.push(`inventory[${index}].finding_id '${row.finding_id}' resolves to no finding`);
    }
  }

  if (sidecar.remeasurement !== undefined) {
    errors.push(...remeasurementShapeErrors(sidecar, rowIds, findingIds));
  }

  return errors;
}

/**
 * Reference resolution for accepted risk.
 *
 * An `accepted-risk` disposition passes only when its reference resolves to a
 * committed authorization that names THIS finding. A dangling reference is the
 * shape an unauthorized acceptance takes.
 */
export function validateAuthorizationLinks(sidecar) {
  const errors = [];
  const byId = new Map((sidecar.authorizations ?? []).map((a) => [a.id, a]));
  for (const finding of sidecar.findings ?? []) {
    if (finding.disposition !== 'accepted-risk') continue;
    const authorization = byId.get(finding.authorization);
    if (!authorization) {
      errors.push(
        `finding ${finding.id}: authorization '${finding.authorization}' is not in the authorizations array`,
      );
      continue;
    }
    if (!authorization.finding_ids.includes(finding.id)) {
      errors.push(
        `finding ${finding.id}: authorization '${authorization.id}' does not name this finding`,
      );
    }
  }
  for (const authorization of sidecar.authorizations ?? []) {
    for (const id of authorization.finding_ids ?? []) {
      if (!(sidecar.findings ?? []).some((finding) => finding.id === id)) {
        errors.push(`authorization ${authorization.id}: names unknown finding '${id}'`);
      }
    }
  }
  return errors;
}

/** High-risk adjudication is enforced here, not in prose. */
export function validateHighRiskAdjudication(sidecar, derivedRisk) {
  if (derivedRisk !== 'high') return [];
  return (sidecar.findings ?? [])
    .filter((finding) => finding.severity === 'P1' && finding.disposition === 'open')
    .map(
      (finding) =>
        `finding ${finding.id}: a high-risk run cannot ship an open P1 — fix it, or record `
        + 'user authorization and set disposition accepted-risk',
    );
}

/** A confirmed survivor must have the arbiter's non-equivalence reasoning on record. */
export function validateArbiterReasoning(sidecar) {
  const errors = [];
  const byId = new Map((sidecar.findings ?? []).map((finding) => [finding.id, finding]));
  for (const row of sidecar.inventory ?? []) {
    if (row.outcome !== 'survived-confirmed-P0') continue;
    const finding = byId.get(row.finding_id);
    if (!finding) continue;
    if (finding.severity !== 'P0') {
      errors.push(`inventory ${row.id}: a confirmed survivor must reference a P0 finding`);
    }
    if (!nonEmptyString(finding.arbiter_reasoning)) {
      errors.push(
        `finding ${finding.id}: a confirmed survivor needs the arbiter's recorded reasoning `
        + 'that the mutation is neither equivalent nor on an unexecuted branch',
      );
    }
  }
  return errors;
}

/**
 * The re-measurement round's bound, resolved against committed history (#1342).
 *
 * The shape rules above are self-consistency. THIS is the part that makes the
 * round bounded rather than a fourth round by another name: the previous
 * round's report is read out of the branch's own committed history, and every
 * inventory row that is not named in `fixes` must be byte-identical to it. A
 * re-measurement round therefore re-measures the fixes it names and opens no
 * new adversarial front — and a finding it raises itself may not be `fixed`,
 * because fixing one would move the tree past `at` with no further round left
 * to measure that fix.
 *
 * The prior report is addressed by COMMIT, not by blob: a blob can be conjured
 * with `git hash-object -w`, while a commit has to be in this branch's history.
 */
function validateRemeasurementHistory(root, sidecar, sidecarPath) {
  const block = sidecar.remeasurement;
  const git = makeGit(root);
  let prior;
  try {
    git(['cat-file', '-e', `${block.prior_commit}^{commit}`], { quiet: true });
    if (git(['merge-base', block.prior_commit, 'HEAD'], { quiet: true }) !== block.prior_commit) {
      return [
        `remeasurement.prior_commit ${String(block.prior_commit).slice(0, 12)} is not an ancestor `
        + 'of HEAD — the round being re-measured must be this branch\'s committed history',
      ];
    }
    prior = JSON.parse(git(['show', `${block.prior_commit}:${sidecarPath}`], { quiet: true }));
  } catch {
    return [`remeasurement.prior_commit does not carry a readable ${sidecarPath}`];
  }
  if (!isPlainObject(prior)) return ['remeasurement: the prior report is not one JSON object'];
  // ONE per run, enforced where it survives: the runner's journal marker cannot
  // be consulted here, and reading a single hop back would let a chain of
  // re-measurements — each naming the last as its prior — raise a finding, fix
  // it in the next link, and repeat without `round` ever moving. Requiring the
  // prior report to be a FRESH round's report makes one hop the whole chain.
  if (prior.remeasurement !== undefined) {
    return ['remeasurement: the prior report is itself a re-measurement — a run gets ONE, and it re-measures a fresh round'];
  }

  const errors = [];
  for (const key of ['mode', 'branch', 'run_id', 'fork_sha', 'merge_base_sha', 'round']) {
    if (prior[key] !== sidecar[key]) {
      errors.push(`remeasurement: the prior report's ${key} does not match this report's`);
    }
  }
  if (prior.head_sha === sidecar.head_sha) {
    errors.push('remeasurement: the prior report was measured at this same head — nothing was fixed, so there is nothing to re-measure');
  } else {
    try {
      if (git(['merge-base', String(prior.head_sha), sidecar.head_sha], { quiet: true }) !== prior.head_sha) {
        errors.push('remeasurement: head_sha does not descend from the head the prior round measured');
      }
    } catch {
      errors.push('remeasurement: cannot relate head_sha to the head the prior round measured');
    }
  }

  const named = new Set(
    (block.fixes ?? []).flatMap((fix) => (Array.isArray(fix?.rows) ? fix.rows : [])),
  );
  const priorRows = Array.isArray(prior.inventory) ? prior.inventory : [];
  if (sidecar.inventory.length < priorRows.length) {
    errors.push('remeasurement: the inventory is shorter than the one the prior round measured');
  }
  for (const [index, priorRow] of priorRows.entries()) {
    const current = sidecar.inventory[index];
    if (!current || current.id !== priorRow?.id) {
      errors.push(`remeasurement: inventory row ${index} is no longer '${priorRow?.id}' — prior rows keep their identity and order`);
      continue;
    }
    if (!named.has(current.id) && JSON.stringify(current) !== JSON.stringify(priorRow)) {
      errors.push(`remeasurement: inventory row '${current.id}' changed but no fix names it — a re-measurement round opens no new front`);
    }
    // A row the prior round chose not to measure is unmeasured INVENTORY, and
    // measuring it is round work — a new front by another name. The round's
    // scope is the fixes it names plus what those fixes added.
    if (named.has(current.id)
      && (priorRow.outcome === 'excluded' || priorRow.outcome === 'skipped-budget')) {
      errors.push(
        `remeasurement: inventory row '${current.id}' was '${priorRow.outcome}' before this round `
        + '— a re-measurement round re-measures what the round MEASURED, it does not pick up '
        + 'inventory the round left alone',
      );
    }
  }
  for (const row of sidecar.inventory.slice(priorRows.length)) {
    if (!named.has(row.id)) {
      errors.push(`remeasurement: inventory row '${row.id}' is new but no fix names it — a re-measurement round opens no new front`);
    }
  }

  const priorFindings = new Map(
    (Array.isArray(prior.findings) ? prior.findings : []).map((finding) => [finding?.id, finding]),
  );
  const remeasured = new Set((block.fixes ?? []).map((fix) => fix?.finding_id));
  for (const [id, priorFinding] of priorFindings) {
    const current = sidecar.findings.find((finding) => finding.id === id);
    if (!current) {
      errors.push(`remeasurement: finding '${id}' from the round being re-measured is gone`);
      continue;
    }
    // A finding the round re-measured may move its disposition and reason —
    // that is the point. Every OTHER prior finding stays byte-for-byte, or a
    // re-measurement round becomes a way to quietly reject or accept-risk an
    // unrelated open finding without anything in `fixes` recording it.
    if (!remeasured.has(id)) {
      if (JSON.stringify(current) !== JSON.stringify(priorFinding)) {
        errors.push(`remeasurement: finding '${id}' changed but no fix names it — a re-measurement round adjudicates only what it re-measured`);
      }
      continue;
    }
    for (const key of ['severity', 'title', 'at', 'duty']) {
      if (current[key] !== priorFinding[key]) {
        errors.push(`remeasurement: finding '${id}' rewrote its ${key}`);
      }
    }
  }
  for (const fix of block.fixes ?? []) {
    if (nonEmptyString(fix?.finding_id) && !priorFindings.has(fix.finding_id)) {
      errors.push(`remeasurement: finding '${fix.finding_id}' was not raised by the round being re-measured`);
    }
  }
  for (const finding of sidecar.findings) {
    if (priorFindings.has(finding.id)) continue;
    if (finding.disposition === 'fixed') {
      errors.push(
        `remeasurement: finding '${finding.id}' was raised by the re-measurement round and marked `
        + 'fixed — that fix moves the tree past the measured head, and no further round can measure it',
      );
    }
  }
  return errors;
}

/** Execution authority lives in immutable admission history, never in final risk waivers. */
function validRunEReport(root, sidecar, sidecarPath, journal) {
  if (sidecarPath !== RUN_E_REPORT || sidecar.branch !== RUN_E_BRANCH || sidecar.round !== 2
    || sidecar.authorizations.length !== 0 || sidecar.findings.some((finding) => finding.disposition === 'accepted-risk')
    || !isPlainObject(journal) || journal.round !== 2
    || !Number.isInteger(journal.runs) || journal.runs < 1 || journal.runs > 1600
    || !Array.isArray(journal.mutations) || !Array.isArray(journal.supervisors)
    || !isPlainObject(journal.dotenv) || journal.dotenv.open !== false
    || journal.mutations.some((entry) => !isPlainObject(entry) || entry.state !== 'restored')
    || journal.supervisors.some((entry) => !isPlainObject(entry) || entry.active !== false)) return false;
  const pin = journal.budgetAuthorization;
  if (!isPlainObject(pin) || pin.id !== RUN_E_GRANT || pin.maxRuns !== 1600
    || pin.firstRun !== 1) return false;
  const staging = requiresRunEStagingAdmission(root, journal, sidecar.head_sha);
  const correcting = staging || requiresRunECorrectiveAdmission(root, journal, sidecar.head_sha);
  const continuing = correcting || requiresRunEContinuation(root, journal, sidecar.head_sha);
  const proof = staging ? validateRunEStagingAdmission(root, journal, sidecar.head_sha) : correcting
    ? validateRunECorrectiveAdmission(root, journal, sidecar.head_sha)
    : continuing ? validateRunEContinuation(root, journal, sidecar.head_sha)
      : validateRunEAdmission(root, pin.headSha);
  if (!proof || (!continuing && (pin.headSha !== sidecar.head_sha
    || ['id', 'maxRuns', 'sha256', 'headSha'].some((key) => pin[key] !== proof.grant[key])))) return false;
  // A new diagnostic row may reactivate this previously excluded real warning path.
  // Every other finalized row and finding remains byte-for-byte evidence.
  if (staging) {
    const historical = proof.stagingHistoricalReport;
    const affectedId = 'src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:1133';
    if (sidecar.inventory.length < historical.inventory.length
      || !historical.inventory.some((row) => row.id === affectedId)) return false;
    for (const [index, row] of historical.inventory.entries()) {
      const current = sidecar.inventory[index];
      if (row.id === affectedId) {
        if (current.outcome === 'excluded'
          || ['id', 'file', 'test'].some((key) => current[key] !== row[key])
          || !nonEmptyString(current.reason)
          || (current.outcome !== row.outcome && current.reason === row.reason)) return false;
      } else if (JSON.stringify(current) !== JSON.stringify(row)) return false;
    }
    for (const row of historical.findings) {
      if (JSON.stringify(sidecar.findings.find((finding) => finding.id === row.id)) !== JSON.stringify(row)) return false;
    }
  }
  let scopeCorrections;
  try {
    scopeCorrections = runEScopeCorrections(root, proof.grant.headSha);
    if (!scopeCorrections) return false;
    if (continuing) {
      for (const group of proof.scopeCorrections.groups) {
        if (!isPlainObject(group) || !nonEmptyString(group.reason) || !Array.isArray(group.ids)) return false;
        for (const id of group.ids) {
          if (!nonEmptyString(id) || scopeCorrections.has(id)) return false;
          scopeCorrections.set(id, group.reason);
        }
      }
      const inventoryById = new Map(sidecar.inventory.map((row) => [row.id, row]));
      for (const [id, reason] of scopeCorrections) {
        const row = inventoryById.get(id);
        if (!row || (row.outcome === 'excluded' && row.reason !== reason)) return false;
      }
    }
    if (JSON.stringify(JSON.parse(readFileSync(join(root, '.feature/intake.json'), 'utf8')))
      !== JSON.stringify(proof.intake)) return false;
    const markdown = readFileSync(join(root, sidecarPath.replace(/\.json$/, '.md')));
    if (!markdown.subarray(0, proof.admissionMarkdown.length).equals(proof.admissionMarkdown)
      || (staging && !markdown.toString('utf8').startsWith(proof.stagingHistoricalMarkdown))) return false;
  } catch {
    return false;
  }
  if (['mode', 'branch', 'run_id', 'fork_sha', 'merge_base_sha'].some((key) => sidecar[key] !== proof.admission[key])) return false;
  if (sidecar.inventory.length < proof.historical.inventory.length) return false;
  for (const [index, historical] of proof.historical.inventory.entries()) {
    const current = sidecar.inventory[index];
    if (['id', 'file', 'test'].some((key) => current[key] !== historical[key])) return false;
    if (historical.outcome === 'excluded' && JSON.stringify(current) !== JSON.stringify(historical)) return false;
    if (historical.outcome !== 'excluded' && current.outcome === 'excluded'
      && (historical.outcome !== 'skipped-budget' || scopeCorrections.get(historical.id) !== current.reason)) return false;
    if (current.outcome !== historical.outcome
      && (!nonEmptyString(current.reason) || current.reason === historical.reason)) return false;
  }
  for (const historical of proof.historical.findings) {
    const current = sidecar.findings.find((finding) => finding.id === historical.id);
    if (!current || ['severity', 'title', 'at', 'duty'].some((key) => current[key] !== historical[key])
      || (current.disposition !== 'open' && !nonEmptyString(current.reason))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// git and filesystem probes
// ---------------------------------------------------------------------------

// TRAILING whitespace only. A full `.trim()` also eats the LEADING space of the
// first line, and `git status --porcelain=v1` puts the status code in columns
// 1-2 — an unstaged modification is ` M path`. Trimming turns the first line
// into `M path`, so the `line.slice(3)` below yields `ath` instead of `path`
// and no exclusion can ever match line 1. The other three call sites emit a
// single token with no leading whitespace, so they are unaffected.
function makeGit(root) {
  return function git(args, options = {}) {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'pipe'],
    }).replace(/\s+$/, '');
  };
}

/** Every `.env*` backup the dotenv swap could have left behind. Porcelain cannot see this class. */
export function findDotenvBackups(root) {
  return readdirSync(root)
    .filter((name) => name.startsWith('.env') && name.endsWith('.red-team-backup'))
    .sort();
}

/** The run scratch journal, when a crash left one open. */
export function readJournal(root) {
  const path = join(root, '.feature', 'red-team-journal.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { parseError: true };
  }
}

export function journalErrors(journal) {
  if (journal === null) return [];
  if (journal.parseError) {
    return ['.feature/red-team-journal.json is present and unreadable — run the finalizer'];
  }
  const errors = [];
  if (journal.dotenv?.open === true) {
    errors.push('the dotenv swap is still open — run the finalizer before any transition');
  }
  for (const entry of journal.mutations ?? []) {
    if (entry.state !== 'restored') {
      errors.push(`mutation of ${entry.path} is journaled as '${entry.state}', not 'restored'`);
    }
  }
  for (const supervisor of journal.supervisors ?? []) {
    if (supervisor.active === true) {
      errors.push(`supervisor pgid ${supervisor.pgid} is still journaled active — reap it first`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) return { error: `unexpected argument '${token}'` };
    const key = token.slice(2);
    if (!['mode', 'issue', 'head', 'risk'].includes(key)) {
      return { error: `unknown option '${token}'` };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { error: `option '${token}' needs a value` };
    }
    options[key] = value;
    index += 1;
  }

  const mode = options.mode ?? (options.issue ? 'standalone' : 'feature');
  if (!MODES.has(mode)) return { error: `--mode must be feature or standalone` };
  if (mode === 'standalone') {
    if (!options.issue) return { error: '--issue is required in standalone mode' };
    if (!options.head) return { error: '--head is required in standalone mode' };
    if (!SHA1_RE.test(options.head)) return { error: '--head must be a full 40-character SHA' };
    if (options.risk !== undefined && !RISKS.has(options.risk)) {
      return { error: '--risk must be normal or high' };
    }
  } else {
    if (options.issue || options.head) {
      return { error: '--issue and --head belong to standalone mode' };
    }
    if (options.risk) {
      return { error: 'feature mode derives risk from the intake; --risk is standalone-only' };
    }
  }
  return { mode, issue: options.issue ?? null, head: options.head ?? null, risk: options.risk ?? null };
}

function fail(messages) {
  console.error(`red-team-status: FAILED (${messages.length} issue(s))`);
  for (const message of messages) console.error(`  - ${message}`);
  console.error('');
  console.error('  A `reviewed` phase requires a current, self-consistent red-team sidecar.');
  console.error('  Run `/red-team` on this branch, or fix the findings it recorded.');
  process.exit(1);
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`usage: red-team-status.mjs [--mode feature|standalone] [--issue <ref> --head <sha> [--risk normal|high]]`);
    console.error(`  ${parsed.error}`);
    process.exit(2);
  }

  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('red-team-status: not inside a git repository');
    process.exit(1);
  }
  const git = makeGit(root);

  const errors = [];
  const branch = git(['branch', '--show-current']);
  if (parsed.mode === 'feature' && branch.length === 0) {
    fail(['feature mode needs a checked-out branch; HEAD is detached']);
  }

  const identity = deriveIdentity({
    mode: parsed.mode,
    branch,
    issue: parsed.issue,
    headSha: parsed.head,
  });
  const reportDir = join('docs', 'reviews', 'red-team', identity.slug);
  const sidecarPath = join(reportDir, 'findings.json');
  const reportPath = join(reportDir, 'findings.md');

  if (!existsSync(join(root, sidecarPath))) {
    if (requiresOperatorContinuation(root, readJournal(root))) {
      fail(['Operator continuation requires its original report, immutable admission and preserved cumulative journal; no risk waiver applies']);
    }
    if (requiresRunEStagingAdmission(root, readJournal(root), git(['rev-parse', 'HEAD']))
      || requiresRunECorrectiveAdmission(root, readJournal(root), git(['rev-parse', 'HEAD']))) {
      fail([`Run E corrective admission requires its report at ${sidecarPath}; no risk waiver applies`]);
    }
    // The risk-scoped waiver (2026-08-31). A feature-lane run requires the
    // sidecar when the SIGNED-OFF intake declares `risk: high`. A normal-risk
    // run may omit the pass: the deterministic gate plus the review axes are
    // its safety layer, and this branch records the waiver instead. The waiver
    // fails CLOSED — it derives risk only from `.feature/intake.json` (the
    // locked contract the user signed off at intake; the schema stays strict
    // and closed, so no new field exists to abuse), and a missing, unreadable,
    // or risk-less intake is failure, never a waiver. A sidecar that EXISTS is
    // always validated in full further down, regardless of risk.
    if (parsed.mode === 'feature') {
      const waiverIntakePath = join(root, '.feature', 'intake.json');
      let waiverRisk = null;
      let waiverProblem = 'missing .feature/intake.json';
      if (existsSync(waiverIntakePath)) {
        try {
          waiverRisk = normalizeRisk(JSON.parse(readFileSync(waiverIntakePath, 'utf8')));
          waiverProblem = waiverRisk === null
            ? 'the intake declares neither `risk` nor `classification`'
            : null;
        } catch {
          waiverProblem = '.feature/intake.json is not valid JSON';
        }
      }
      if (waiverRisk === 'normal') {
        console.log(
          `red-team-status: WAIVED — no red-team sidecar at ${sidecarPath}; the signed-off `
          + 'intake declares risk normal, and the red-team pass is required only for risk high. '
          + 'A sidecar that exists is always validated in full.',
        );
        process.exit(0);
      }
      fail([
        `no red-team sidecar at ${sidecarPath}`,
        waiverRisk === 'high'
          ? 'the signed-off intake declares risk high — a high-risk feature-lane run requires '
            + 'the red-team pass, and absence is failure'
          : `cannot derive a normal-risk waiver (${waiverProblem}) — the waiver fails closed, `
            + 'so absence is failure',
      ]);
    }
    fail([
      `no red-team sidecar at ${sidecarPath}`,
      'a standalone run writes its report to that path — absence means the pass did not '
        + 'complete, or --issue/--head do not name the run being checked',
    ]);
  }
  if (!existsSync(join(root, reportPath))) {
    errors.push(`the human report ${reportPath} is missing beside the sidecar`);
  }

  let sidecar;
  try {
    sidecar = JSON.parse(readFileSync(join(root, sidecarPath), 'utf8'));
  } catch (error) {
    fail([`${sidecarPath} is not valid JSON: ${error.message}`]);
  }

  const journal = readJournal(root);
  if (requiresOperatorContinuation(root, journal) && !validOperatorReport(root, sidecar, journal)) {
    errors.push('Operator continuation requires immutable admission/history, exact inventory and exclusions, cumulative journal and corroborated outcome upgrades');
  }
  // Checkout ancestry survives a forged report branch/round and stripped pins.
  const correctiveProofRequired = requiresRunEStagingAdmission(root, journal, sidecar?.head_sha)
    || requiresRunECorrectiveAdmission(root, journal, sidecar?.head_sha);
  if (correctiveProofRequired && sidecar?.round !== 2) {
    fail([...errors, 'Run E corrective admission retains round 2 regardless of report or journal labels']);
  }
  if (runEThirdRoundForbidden(branch, journal?.budgetAuthorization?.id, sidecar?.round)) {
    fail([...errors, 'Run E grants round 2 only; the checkout or launch grant forbids third and higher reports']);
  }
  const shapeErrors = validateShape(sidecar);
  if (shapeErrors.length > 0) fail([...errors, ...shapeErrors]);
  const requiresRunEProof = correctiveProofRequired || journal?.budgetAuthorization?.id === RUN_E_GRANT
    || (branch === RUN_E_BRANCH && journal?.round === 2)
    || (sidecar.round === 2 && (branch === RUN_E_BRANCH
      || sidecar.authorizations.some((authorization) => authorization.id === RUN_E_GRANT)));
  if (requiresRunEProof && !validRunEReport(root, sidecar, sidecarPath, journal)) {
    errors.push('Run E round 2 requires intact committed admission/history, its original inventory prefix, no risk waiver, and a closed matching 1600-launch journal');
  }
  if (sidecar.round === 4 && !validRunCFourthReport(root, sidecar, sidecarPath, readJournal(root))) {
    errors.push('Run C round 4 requires committed admission, unchanged historical evidence, and the matching 150-launch journal grant');
  }
  if (sidecar.remeasurement !== undefined) {
    errors.push(...validateRemeasurementHistory(root, sidecar, sidecarPath));
  }

  // --- run binding -------------------------------------------------------
  if (sidecar.mode !== parsed.mode) {
    errors.push(`sidecar mode '${sidecar.mode}' does not match the checked mode '${parsed.mode}'`);
  }
  if (sidecar.run_id !== identity.runId) {
    errors.push(`sidecar run_id '${sidecar.run_id}' does not match the derived '${identity.runId}'`);
  }
  if (sidecar.branch !== identity.branch) {
    errors.push(
      `sidecar branch ${JSON.stringify(sidecar.branch)} does not match the checkout `
      + `${JSON.stringify(identity.branch)}`,
    );
  }
  if (parsed.mode === 'standalone' && sidecar.head_sha !== parsed.head) {
    errors.push(`sidecar head_sha does not match --head ${parsed.head}`);
  }

  // --- recomputed counts and status --------------------------------------
  const counts = recomputeCounts(sidecar);
  for (const key of COUNT_KEYS) {
    // `equivalent` post-dates the first sidecars, so an ABSENT field reads as
    // zero for that key alone. Every other key stays required: an absent
    // `killed` must still mismatch, or a truncated counts object validates.
    const claimed = key === 'equivalent' ? (sidecar.counts[key] ?? 0) : sidecar.counts[key];
    if (claimed !== counts[key]) {
      errors.push(`counts.${key} claims ${claimed}, recomputed ${counts[key]}`);
    }
  }
  for (const key of Object.keys(sidecar.counts)) {
    if (!COUNT_KEYS.includes(key)) errors.push(`counts: unknown field '${key}'`);
  }
  const status = recomputeStatus(sidecar);
  if (sidecar.status !== status) {
    errors.push(`status claims ${sidecar.status}, recomputed ${status}`);
  }
  if (status !== 'CLEAR') {
    errors.push(`red-team status is ${status} — every non-CLEAR status blocks the transition`);
  }

  errors.push(...validateAuthorizationLinks(sidecar));
  errors.push(...validateArbiterReasoning(sidecar));

  // --- contract binding ---------------------------------------------------
  const intakePath = join(root, '.feature', 'intake.json');
  let intake = null;
  if (existsSync(intakePath)) {
    const raw = readFileSync(intakePath);
    if (sidecar.intake_sha256 !== sha256(raw)) {
      errors.push('intake_sha256 does not match .feature/intake.json — an amended intake voids the evidence');
    }
    try {
      intake = JSON.parse(raw.toString('utf8'));
    } catch {
      errors.push('.feature/intake.json is not valid JSON');
    }
  } else if (parsed.mode === 'feature') {
    errors.push('feature mode requires .feature/intake.json as the locked contract');
  } else if (sidecar.intake_sha256 !== null) {
    errors.push('intake_sha256 must be null when no .feature/intake.json is present');
  }

  const derivedRisk = normalizeRisk(intake) ?? (parsed.mode === 'standalone' ? (parsed.risk ?? 'high') : null);
  if (derivedRisk === null) {
    errors.push('cannot derive risk: the intake declares neither `risk` nor `classification`');
  } else if (sidecar.risk !== derivedRisk) {
    errors.push(`sidecar risk '${sidecar.risk}' does not match the derived '${derivedRisk}'`);
  }
  errors.push(...validateHighRiskAdjudication(sidecar, derivedRisk));

  // --- SHA pinning --------------------------------------------------------
  let mergeBase = null;
  try {
    mergeBase = git(['merge-base', sidecar.fork_sha, 'HEAD'], { quiet: true });
  } catch {
    errors.push(`cannot recompute a merge-base from fork_sha ${sidecar.fork_sha}`);
  }
  if (mergeBase !== null && mergeBase !== sidecar.merge_base_sha) {
    errors.push(`merge_base_sha ${sidecar.merge_base_sha} does not match the recomputed ${mergeBase}`);
  }

  // --- staleness ----------------------------------------------------------
  // Exclude ONLY this run's two artifacts. Excluding all of docs/reviews/**
  // would let an unrelated review edit land after red-team without invalidating
  // its evidence.
  let headResolves = true;
  try {
    git(['cat-file', '-e', `${sidecar.head_sha}^{commit}`], { quiet: true });
  } catch {
    headResolves = false;
    errors.push(`head_sha ${sidecar.head_sha} resolves to no commit in this repository`);
  }
  if (headResolves) {
    try {
      execFileSync('git', [
        'diff', '--quiet', sidecar.head_sha, 'HEAD', '--', '.',
        `:(exclude)${reportDir}/findings.md`,
        `:(exclude)${reportDir}/findings.json`,
      ], { cwd: root, stdio: 'ignore' });
    } catch {
      errors.push(
        `the tree moved since ${sidecar.head_sha.slice(0, 12)} outside this run's own two artifacts `
        + '— the red-team evidence is stale, re-run it',
      );
    }
  }

  // --- the mutation must not have survived the run ------------------------
  // Tracked modifications only: a leftover mutation shows as modified, while
  // unrelated untracked scratch is not this check's business.
  const porcelain = git(['status', '--porcelain=v1', '--untracked-files=no'])
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).trim();
      return path !== `${reportDir}/findings.md` && path !== `${reportDir}/findings.json`;
    });
  if (porcelain.length > 0) {
    errors.push(
      `the worktree carries ${porcelain.length} tracked modification(s) outside this run's report `
      + `— a mutation may not have been restored: ${porcelain.slice(0, 3).join(' | ')}`,
    );
  }

  const backups = findDotenvBackups(root);
  if (backups.length > 0) {
    errors.push(`dotenv backup(s) still present: ${backups.join(', ')} — run the finalizer`);
  }
  errors.push(...journalErrors(readJournal(root)));

  if (errors.length > 0) fail(errors);

  console.log(
    `red-team-status: passed (${sidecar.mode} run ${sidecar.run_id}, round ${sidecar.round}, `
    + `status CLEAR, ${counts.inventory_total} inventory row(s), ${counts.findings_total} finding(s))`,
  );
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2));
}
