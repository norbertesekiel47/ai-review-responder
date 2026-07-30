import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BATCH_APPROVAL_WINDOW_DAYS,
  BATCH_SEND_WINDOW_HOURS,
  BATCH_STATES,
  deriveBatchState,
  type BatchLifecycleRow,
  type BatchState,
} from '../outreach';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const NOW = new Date('2026-07-29T12:00:00.000Z');
const HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);
const HOUR_AHEAD = new Date(NOW.getTime() + 60 * 60 * 1000);
const LONG_AGO = new Date(NOW.getTime() - 30 * MS_PER_DAY);

const NOTHING: BatchLifecycleRow = {
  built_at: null,
  approved_at: null,
  veto_deadline_at: null,
  sending_started_at: null,
  send_closed_at: null,
  halted_at: null,
};

function row(overrides: Partial<BatchLifecycleRow>): BatchLifecycleRow {
  return { ...NOTHING, ...overrides };
}

describe('deriveBatchState', () => {
  it('returns pending for a batch that has not been built', () => {
    expect(deriveBatchState(NOTHING, NOW)).toBe<BatchState>('pending');
  });

  it('returns built inside the approval window', () => {
    expect(deriveBatchState(row({ built_at: HOUR_AGO }), NOW)).toBe<BatchState>('built');
  });

  it('returns expired once the approval window elapses unapproved', () => {
    const builtAt = new Date(NOW.getTime() - BATCH_APPROVAL_WINDOW_DAYS * MS_PER_DAY);
    expect(deriveBatchState(row({ built_at: builtAt }), NOW)).toBe<BatchState>('expired');
  });

  it('returns approved when the veto deadline has passed but sending has not started', () => {
    const approved = row({
      built_at: LONG_AGO,
      approved_at: HOUR_AGO,
      veto_deadline_at: HOUR_AGO,
    });
    expect(deriveBatchState(approved, NOW)).toBe<BatchState>('approved');
  });

  it('returns approved when no veto deadline has been granted yet', () => {
    const approved = row({ built_at: HOUR_AGO, approved_at: HOUR_AGO });
    expect(deriveBatchState(approved, NOW)).toBe<BatchState>('approved');
  });

  it('returns veto_window while the granted deadline is still ahead', () => {
    const inWindow = row({
      built_at: HOUR_AGO,
      approved_at: HOUR_AGO,
      veto_deadline_at: HOUR_AHEAD,
    });
    expect(deriveBatchState(inWindow, NOW)).toBe<BatchState>('veto_window');
  });

  it('applies sending over the veto window once the drip starts', () => {
    const sending = row({
      built_at: HOUR_AGO,
      approved_at: HOUR_AGO,
      veto_deadline_at: HOUR_AHEAD,
      sending_started_at: HOUR_AGO,
    });
    expect(deriveBatchState(sending, NOW)).toBe<BatchState>('sending');
  });

  it('applies closed over sending', () => {
    const closed = row({
      built_at: LONG_AGO,
      approved_at: HOUR_AGO,
      sending_started_at: HOUR_AGO,
      send_closed_at: HOUR_AGO,
    });
    expect(deriveBatchState(closed, NOW)).toBe<BatchState>('closed');
  });

  it('applies expired over built only once the window elapses, never over approved', () => {
    const staleButApproved = row({ built_at: LONG_AGO, approved_at: HOUR_AGO });
    expect(deriveBatchState(staleButApproved, NOW)).toBe<BatchState>('approved');
  });

  it('deriveBatchState applies halted over every other state', () => {
    const everything = row({
      built_at: LONG_AGO,
      approved_at: HOUR_AGO,
      veto_deadline_at: HOUR_AHEAD,
      sending_started_at: HOUR_AGO,
      send_closed_at: HOUR_AGO,
      halted_at: HOUR_AGO,
    });
    expect(deriveBatchState(everything, NOW)).toBe<BatchState>('halted');
  });
});

describe('send-mode window constants', () => {
  it('owns the 7-day approval window and the 72-hour send window', () => {
    expect(BATCH_APPROVAL_WINDOW_DAYS).toBe(7);
    expect(BATCH_SEND_WINDOW_HOURS).toBe(72);
  });
});

// Property tests (fast-check): the house style for invariant-level coverage.
describe('deriveBatchState invariants', () => {
  const ANCHOR = Date.UTC(2026, 6, 1);
  const SPAN_MS = 60 * MS_PER_DAY;

  const anyInstant = fc.date({
    min: new Date(ANCHOR),
    max: new Date(ANCHOR + SPAN_MS),
    noInvalidDate: true,
  });
  const maybeInstant = fc.option(anyInstant, { nil: null });

  /**
   * The eight `solicitation_batches` timestamps. `created_at` and `reviewed_at`
   * are generated even though `deriveBatchState` cannot read them — a row that
   * carried them must still land in exactly one state.
   */
  const anyBatchRow = fc.record({
    created_at: anyInstant,
    built_at: maybeInstant,
    reviewed_at: maybeInstant,
    approved_at: maybeInstant,
    veto_deadline_at: maybeInstant,
    sending_started_at: maybeInstant,
    send_closed_at: maybeInstant,
    halted_at: maybeInstant,
  });

  /**
   * Each state's condition, evaluated INDEPENDENTLY of the precedence order.
   * `veto_window` implies `approved`, `expired` implies `built`, and
   * `built`/`pending` partition every row, so this set is never empty.
   */
  function activeStates(batch: BatchLifecycleRow, now: Date): BatchState[] {
    const approvalDeadline =
      batch.built_at === null
        ? null
        : batch.built_at.getTime() + BATCH_APPROVAL_WINDOW_DAYS * MS_PER_DAY;
    const active: BatchState[] = [];
    if (batch.halted_at !== null) active.push('halted');
    if (batch.send_closed_at !== null) active.push('closed');
    if (batch.sending_started_at !== null) active.push('sending');
    if (
      batch.approved_at !== null
      && batch.veto_deadline_at !== null
      && now.getTime() < batch.veto_deadline_at.getTime()
    ) {
      active.push('veto_window');
    }
    if (batch.approved_at !== null) active.push('approved');
    if (approvalDeadline !== null && batch.approved_at === null && now.getTime() >= approvalDeadline) {
      active.push('expired');
    }
    if (batch.built_at !== null) active.push('built');
    if (batch.built_at === null) active.push('pending');
    return active;
  }

  it('invariants: deriveBatchState returns exactly one state for any combination of batch timestamps', () => {
    fc.assert(
      fc.property(anyBatchRow, anyInstant, (batch, now) => {
        const state = deriveBatchState(batch, now);
        expect(BATCH_STATES).toContain(state);

        const active = activeStates(batch, now);
        expect(active.length).toBeGreaterThan(0);
        // Exactly one state is selectable: the highest-precedence active one.
        const selected = BATCH_STATES.filter((candidate) => active.includes(candidate));
        expect(state).toBe(selected[0]);
      }),
    );
  });

  it('holds the precedence order pairwise for every pair of active states', () => {
    fc.assert(
      fc.property(anyBatchRow, anyInstant, (batch, now) => {
        const state = deriveBatchState(batch, now);
        const winnerIndex = BATCH_STATES.indexOf(state);
        for (const other of activeStates(batch, now)) {
          expect(winnerIndex).toBeLessThanOrEqual(BATCH_STATES.indexOf(other));
        }
      }),
    );
  });

  it('is stable: the same row and clock always derive the same state', () => {
    fc.assert(
      fc.property(anyBatchRow, anyInstant, (batch, now) => {
        expect(deriveBatchState(batch, now)).toBe(deriveBatchState(batch, now));
      }),
    );
  });
});
