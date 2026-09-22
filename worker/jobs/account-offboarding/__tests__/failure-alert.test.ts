import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCaptureMessage, mockLoggerError } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
}));

vi.mock('../../../../src/lib/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/shared/logger')>();
  return {
    ...actual,
    createWorkerLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: mockLoggerError }),
  };
});

import {
  alertOffboardingFailure,
  OFFBOARDING_ALERT_RULE_16,
  OFFBOARDING_FAILURE_ALERT_MESSAGE,
  OFFBOARDING_FAILURE_STEPS,
  offboardingRetryFingerprint,
  offboardingTerminalFingerprintPrefix,
  type OffboardingFailureStep,
} from '../failure-alert';

const ACCOUNT_ID = '00000000-0000-7000-8000-000000000001';
const OFFBOARDING_ID = '00000000-0000-7000-8000-000000000002';
const OTHER_OFFBOARDING_ID = '00000000-0000-7000-8000-0000000000f1';

function alert(step: OffboardingFailureStep, terminal: boolean, accountOffboardingId = OFFBOARDING_ID) {
  alertOffboardingFailure({
    step,
    accountOffboardingId,
    accountId: ACCOUNT_ID,
    safeMessage: 'provider refused',
    terminal,
  });
}

function capturedFingerprint(call: number): unknown {
  return (mockCaptureMessage.mock.calls[call]?.[1] as { fingerprint?: unknown } | undefined)?.fingerprint;
}

// ── The shared emitter (#1412) ─────────────────────────────────────────────
//
// The fingerprints are spelled out here rather than derived from the helper
// on purpose: they are an operator-facing contract with a configured Sentry
// rule, and deriving them would let a rename pass on both sides while every
// rule stopped matching. The runbook pins further down DO read the exported
// constants — that comparison is between two artifacts and must not be
// hand-copied.
describe('alertOffboardingFailure', () => {
  beforeEach(() => {
    mockCaptureMessage.mockReset();
    mockLoggerError.mockReset();
  });

  it.each([
    ['purge', 'account_offboarding_purge_failed'],
    ['teardown', 'account_offboarding_teardown_failed'],
    ['billing', 'account_offboarding_billing_schedule_failed'],
  ] as const)('%s: a terminal alert is an error under [<message>, terminal, <offboarding id>]', (step, message) => {
    alert(step, true);

    expect(mockCaptureMessage).toHaveBeenCalledOnce();
    expect(mockCaptureMessage).toHaveBeenCalledWith(message, {
      level: 'error',
      fingerprint: [message, 'terminal', OFFBOARDING_ID],
      tags: { subsystem: 'account_offboarding', step, terminal: 'true' },
      extra: {
        account_offboarding_id: OFFBOARDING_ID,
        account_id: ACCOUNT_ID,
        error: 'provider refused',
      },
    });
  });

  it.each([
    ['purge', 'account_offboarding_purge_failed'],
    ['teardown', 'account_offboarding_teardown_failed'],
    ['billing', 'account_offboarding_billing_schedule_failed'],
  ] as const)('%s: a retry alert is a warning under the shared [<message>, retry]', (step, message) => {
    alert(step, false);

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        level: 'warning',
        fingerprint: [message, 'retry'],
        tags: expect.objectContaining({ step, terminal: 'false' }),
      }),
    );
  });

  it('the terminal and retry alerts of one step never share a fingerprint', () => {
    for (const step of OFFBOARDING_FAILURE_STEPS) {
      mockCaptureMessage.mockReset();
      alert(step, false);
      alert(step, true);
      const [retry, terminal] = [capturedFingerprint(0), capturedFingerprint(1)];
      // Two absent fingerprints compare EQUAL — the #1016 defect itself — so
      // presence is asserted before inequality.
      expect(Array.isArray(retry) && Array.isArray(terminal)).toBe(true);
      expect(retry).not.toEqual(terminal);
    }
  });

  it("two offboardings' terminal alerts never share a fingerprint, on every step", () => {
    // Sentry's action throttle is PER ISSUE: one shared terminal issue would
    // swallow a second account's page inside the 60-minute window (Codex A1).
    for (const step of OFFBOARDING_FAILURE_STEPS) {
      mockCaptureMessage.mockReset();
      alert(step, true, OFFBOARDING_ID);
      alert(step, true, OTHER_OFFBOARDING_ID);
      expect(capturedFingerprint(0)).not.toEqual(capturedFingerprint(1));
    }
  });

  it('the three steps never share a message, so no two rules can match one event', () => {
    const messages = OFFBOARDING_FAILURE_STEPS.map((step) => OFFBOARDING_FAILURE_ALERT_MESSAGE[step]);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('swallows a Sentry throw and logs it, so an alert can never strand the marks before it', () => {
    mockCaptureMessage.mockImplementation(() => {
      throw new Error('sentry transport down');
    });

    expect(() => alert('purge', true)).not.toThrow();
    expect(mockLoggerError).toHaveBeenCalledOnce();
    // Ids and the step only — the scrubbed error text is Sentry's, not the log's.
    expect(mockLoggerError.mock.calls[0]).toEqual([
      'account-offboarding failure alert failed',
      expect.any(Error),
      { step: 'purge', account_offboarding_id: OFFBOARDING_ID, terminal: true },
    ]);
  });
});

// ── The runbook routes what the emitter sends (rules 16, 17, 18) ──────────
//
// A fingerprint nobody routes is worth nothing: before #1016 the purge signal
// had no rule at all (red-team RT-05), and before #1412 the two siblings had
// none either. Read off the exported constants rather than hand-copied,
// because "the runbook and the worker agree" is a claim about two artifacts
// and a copy only ever proves the copy.
//
// Rule 16 gets its OWN block below, `toBe`-equality against the typed
// `OFFBOARDING_ALERT_RULE_16` record (#1414): three red-team rounds kept
// beating a pin built from `toContain` / `toMatch` over the prose — presence
// survives a `do **not**` prefix (RT16-11), and a position-scoped regex still
// has to re-derive the sentence as a pattern rather than just comparing it.
// Equality does not have that gap: any reworded, negated, or reordered cell
// is simply a different string.
//
// Rules 17 and 18 stay on the OLDER position-scoped substring pin below —
// RT16-11 is an accepted, open risk on those two rows until they get their
// own record (owner decision tracked in #1447). Every assertion there is
// scoped to one named CELL of the rule's own table row — the cells the
// operator copies into the Sentry form — and each cell is located by its
// header, not by a hard-coded index. A
// file-wide `toContain` passed with the row corrupted to `terminal equals
// false` at `warning` on the retry fingerprint (red-team RT-A6), because §1's
// bullet carries the same strings; a ROW-wide regex then still passed when
// the two fingerprint spellings were SWAPPED inside the row (RT16-02).
// Position, not mere presence, is what the operator reads.

/** The runbook that owns the Sentry rules routing these workers' terminal alerts. */
const ALERTING_RUNBOOK = 'docs/runbooks/beta-launch-alerting.md';

// Rule 16 is NOT in this list — it gets its own cell-equality block below,
// against the typed `OFFBOARDING_ALERT_RULE_16` record (#1414).
const RULES: ReadonlyArray<{ rule: number; step: OffboardingFailureStep; rowName: string }> = [
  { rule: 17, step: 'teardown', rowName: 'account-offboarding-teardown-terminal → discord' },
  { rule: 18, step: 'billing', rowName: 'account-offboarding-billing-terminal → discord' },
];

/**
 * One rule's own block: from its `**Rule N` header to the next `**Rule ` header
 * or `## ` section heading. Slicing is the whole point (RT-A6): the operator
 * configures Sentry from the ROW, so the row is what has to be pinned.
 */
function ruleBlock(runbook: string, rule: number): string {
  const header = `**Rule ${rule} `;
  const start = runbook.indexOf(header);
  expect(start, `the runbook has no ${header.trim()} block`).toBeGreaterThan(-1);
  const rest = runbook.slice(start + header.length);
  const ends = [rest.indexOf('\n**Rule '), rest.indexOf('\n## ')].filter((index) => index >= 0);
  return ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest;
}

/** A markdown table row's cells, split on unescaped `|` (an escaped `\|` stays in its cell). */
function tableCells(row: string): string[] {
  // A well-formed row opens and closes with `|`, so the outer two parts are empty.
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** The ONE table row inside the block that names the alert rule (RT16-13: a contradicting duplicate below it must not hide). */
function ruleTableRow(block: string, rowName: string): string {
  const rows = block.split('\n').filter((line) => line.startsWith('|') && line.includes(rowName));
  expect(rows, `expected exactly one table row for ${rowName}`).toHaveLength(1);
  return rows[0]!;
}

/**
 * A named column's index, READ OFF the block's own header row rather than
 * hard-coded — inserting a column has to move the assertions, not silently
 * re-point them at a neighbouring cell.
 */
function columnIndex(block: string, columnHeader: string): number {
  const headerRow = block
    .split('\n')
    .find((line) => line.startsWith('|') && line.includes('Rule name'));
  expect(headerRow, 'the rule block has no table header row').toBeDefined();
  const index = tableCells(headerRow!).indexOf(columnHeader);
  expect(index, `the rule table has no "${columnHeader}" column`).toBeGreaterThan(-1);
  return index;
}

/** Regex metacharacters escaped, so a constant is matched literally and never widens the pin. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `[a, b, …]` as the runbook spells a fingerprint, from the constants themselves. */
function fingerprintPattern(members: readonly string[]): RegExp {
  return new RegExp(`\\[\\s*${members.map(escapeRegExp).join(',\\s*')}\\s*\\]`);
}

/** The three cells the operator copies into the Sentry form, parsed INSIDE each test so a malformed block fails a named test, not collection. */
function ruleCells(rule: number, rowName: string): { filterCell: string; groupingCell: string; triggerCell: string } {
  const runbook = readFileSync(join(process.cwd(), ALERTING_RUNBOOK), 'utf8');
  const block = ruleBlock(runbook, rule);
  const cells = tableCells(ruleTableRow(block, rowName));
  return {
    filterCell: cells[columnIndex(block, 'Emitted identity and filter')]!,
    groupingCell: cells[columnIndex(block, 'Level and grouping')]!,
    triggerCell: cells[columnIndex(block, 'Trigger and destination')]!,
  };
}

// ── Rule 16: cell-for-cell equality against a typed record (#1414) ────────
//
// Not a search, not a regex — string equality. Every red-team beat found on
// the position-scoped substring pin (still used by rules 17/18 below) turns
// into a plain mismatch here: a `do **not**` prefix on any facet (RT16-11)
// changes the cell's text and fails `toBe`; a reworded trigger or swapped
// fingerprint spelling does the same. `ruleTableRow` still enforces exactly
// ONE row in the block naming the rule (RT16-13), so a contradicting
// duplicate pasted below the real row fails there, not silently.
describe('runbook rule 16 pins a typed record, cell for cell', () => {
  const rule = 16;
  const rowName = 'account-offboarding-purge-terminal → discord';

  it('matches OFFBOARDING_ALERT_RULE_16 exactly on every cell the operator copies into Sentry', () => {
    const runbook = readFileSync(join(process.cwd(), ALERTING_RUNBOOK), 'utf8');
    const block = ruleBlock(runbook, rule);
    // Exactly one row may carry the rule name (RT16-13).
    const row = ruleTableRow(block, rowName);
    const cells = tableCells(row);

    expect(cells[columnIndex(block, 'Rule name')]).toBe(OFFBOARDING_ALERT_RULE_16.ruleNameCell);
    expect(cells[columnIndex(block, 'Emitted identity and filter')]).toBe(
      OFFBOARDING_ALERT_RULE_16.filterCell,
    );
    expect(cells[columnIndex(block, 'Level and grouping')]).toBe(
      OFFBOARDING_ALERT_RULE_16.groupingCell,
    );
    expect(cells[columnIndex(block, 'Trigger and destination')]).toBe(
      OFFBOARDING_ALERT_RULE_16.triggerCell,
    );
  });

  it('the record agrees with what the emitter actually sends, not just with itself', () => {
    expect(OFFBOARDING_ALERT_RULE_16.signal).toBe(OFFBOARDING_FAILURE_ALERT_MESSAGE.purge);
    expect(OFFBOARDING_ALERT_RULE_16.level).toBe('error');
  });
});

describe.each(RULES)('runbook rule $rule routes the $step terminal alert', ({ rule, step, rowName }) => {
  const message = OFFBOARDING_FAILURE_ALERT_MESSAGE[step];

  it('filters on the constant message, terminal:true at error, the subsystem and this step', () => {
    const { filterCell } = ruleCells(rule, rowName);
    expect(filterCell).toContain(`\`${message}\``);
    expect(filterCell).toMatch(/`terminal`\s+equals\s+`true`/);
    expect(filterCell).not.toMatch(/`terminal`\s+equals\s+`false`/);
    expect(filterCell).not.toMatch(/do\s+\*\*not\*\*\s+filter\s+tag/i);
    expect(filterCell).toMatch(/level\s+equals\s+`error`/);
    expect(filterCell).toMatch(/`subsystem`\s+equals\s+`account_offboarding`/);
    expect(filterCell).toMatch(new RegExp(`\`step\`\\s+equals\\s+\`${escapeRegExp(step)}\``));
    expect(filterCell).toMatch(/scope to the deployment environment/i);
  });

  it('groups terminal events per offboarding and retry events together, in that order', () => {
    const { groupingCell } = ruleCells(rule, rowName);
    // Level: the grouping cell configures it a second time, and a rule saved
    // at `warning` never fires on this `error` event. It has to OPEN with the
    // level, which is where the operator reads it.
    expect(groupingCell).toMatch(/^`error`/);

    // POSITION-SCOPED: the cell states the terminal grouping first and
    // introduces the retry arm in its own sentence; each fingerprint must
    // appear in its own part and NOWHERE in the other, or swapping the two
    // spellings reads green (RT16-02).
    const retryArmStart = groupingCell.indexOf('The retry arm');
    expect(retryArmStart, "the grouping cell has no retry-arm sentence").toBeGreaterThan(-1);
    const terminalGrouping = groupingCell.slice(0, retryArmStart);
    const retryArm = groupingCell.slice(retryArmStart);

    const terminalFingerprint = fingerprintPattern([
      ...offboardingTerminalFingerprintPrefix(step),
      '<account_offboarding_id>',
    ]);
    const retryFingerprint = fingerprintPattern(offboardingRetryFingerprint(step));

    expect(terminalGrouping).toMatch(terminalFingerprint);
    expect(terminalGrouping).not.toMatch(retryFingerprint);
    expect(retryArm).toMatch(retryFingerprint);
    expect(retryArm).not.toMatch(terminalFingerprint);
  });

  it('triggers on every event with the per-issue throttle the third fingerprint member is built on', () => {
    const { triggerCell } = ruleCells(rule, rowName);
    // First-seen is the RT-08 defect these rules exist to undo. The cell must
    // OPEN with the trigger (RT16-11's short-term pin), not merely contain it.
    expect(triggerCell).toMatch(/^Every event, action throttle\s+60\s+minutes\s+per\s+issue/i);
    expect(triggerCell).not.toMatch(/first[\s-]seen/i);
    expect(triggerCell).toMatch(/integration\s+443670\b/);
  });
});
