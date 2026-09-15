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
  runCFourthAuthorization, validRunCFourthReport,
  runEThirdRoundForbidden, validateRunEAdmission,
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
  'counts',
  'status',
]);

const ROW_KEYS = new Set([
  'id',
  'test',
  'file',
  'outcome',
  'reason',
  'inconclusive_class',
  'finding_id',
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

/** Strict shape validation. Returns the error list; empty means the shape is legal. */
export function validateShape(sidecar) {
  const errors = [];
  if (!isPlainObject(sidecar)) return ['findings.json must be one JSON object'];

  checkKeys('findings.json', sidecar, TOP_LEVEL_KEYS, errors);
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in sidecar)) errors.push(`findings.json: missing required field '${key}'`);
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
  // The cap moved from 2 to 3 in #1184, after #1178 and #1186 hit the same wall:
  // a round-2 finding whose fix touches the tree makes the sidecar stale by
  // construction, and with no third round the only ways out were to leave a known
  // defect unfixed or to hand-edit `head_sha` — an evidence file rewriting its own
  // provenance.
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
    || pin.firstRun !== 1 || pin.headSha !== sidecar.head_sha) return false;
  const proof = validateRunEAdmission(root, pin.headSha);
  if (!proof || ['id', 'maxRuns', 'sha256', 'headSha'].some((key) => pin[key] !== proof.grant[key])) return false;
  let scopeCorrections;
  try {
    scopeCorrections = runEScopeCorrections(root, pin.headSha);
    if (!scopeCorrections) return false;
    if (JSON.stringify(JSON.parse(readFileSync(join(root, '.feature/intake.json'), 'utf8')))
      !== JSON.stringify(proof.intake)) return false;
    const markdown = readFileSync(join(root, sidecarPath.replace(/\.json$/, '.md')));
    if (!markdown.subarray(0, proof.admissionMarkdown.length).equals(proof.admissionMarkdown)) return false;
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
  if (runEThirdRoundForbidden(branch, journal?.budgetAuthorization?.id, sidecar?.round)) {
    fail([...errors, 'Run E grants round 2 only; the checkout or launch grant forbids third and higher reports']);
  }
  const shapeErrors = validateShape(sidecar);
  if (shapeErrors.length > 0) fail([...errors, ...shapeErrors]);
  const requiresRunEProof = journal?.budgetAuthorization?.id === RUN_E_GRANT
    || (branch === RUN_E_BRANCH && journal?.round === 2)
    || (sidecar.round === 2 && (branch === RUN_E_BRANCH
      || sidecar.authorizations.some((authorization) => authorization.id === RUN_E_GRANT)));
  if (requiresRunEProof && !validRunEReport(root, sidecar, sidecarPath, journal)) {
    errors.push('Run E round 2 requires intact committed admission/history, its original inventory prefix, no risk waiver, and a closed matching 1600-launch journal');
  }
  if (sidecar.round === 4 && !validRunCFourthReport(root, sidecar, sidecarPath, readJournal(root))) {
    errors.push('Run C round 4 requires committed admission, unchanged historical evidence, and the matching 150-launch journal grant');
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
