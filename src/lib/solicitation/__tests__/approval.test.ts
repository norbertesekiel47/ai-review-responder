import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deriveBatchState, type BatchLifecycleRow } from '../outreach';
import { ownerHaltReason } from '../approval';

const EPOCH = new Date('2026-08-16T12:00:00.000Z');

function lifecycle(overrides: Partial<BatchLifecycleRow> = {}): BatchLifecycleRow {
  return {
    built_at: EPOCH,
    approved_at: null,
    veto_deadline_at: null,
    sending_started_at: null,
    send_closed_at: null,
    halted_at: null,
    ...overrides,
  };
}

describe('invariants', () => {
  it('property: deriveBatchState returns the highest-precedence state for any lifecycle timestamp combination', () => {
    const stamp = fc.option(fc.date({ min: new Date('2026-01-01'), max: new Date('2027-01-01') }), {
      nil: null,
    });
    fc.assert(
      fc.property(stamp, stamp, stamp, stamp, stamp, stamp, (built, approved, veto, sending, closed, halted) => {
        const row: BatchLifecycleRow = {
          built_at: built,
          approved_at: approved,
          veto_deadline_at: veto,
          sending_started_at: sending,
          send_closed_at: closed,
          halted_at: halted,
        };
        // EVERY arm names ONE expected state. An earlier draft allowed
        // "veto_window OR approved" and "built OR expired", which an
        // implementation that never recognises an elapsed deadline passes —
        // the property has to constrain the boundary, not restate the
        // precedence list.
        const state = deriveBatchState(row, EPOCH);
        if (halted !== null) return state === 'halted';
        if (closed !== null) return state === 'closed';
        if (sending !== null) return state === 'sending';
        if (approved !== null) {
          const inWindow = veto !== null && EPOCH.getTime() < veto.getTime();
          return state === (inWindow ? 'veto_window' : 'approved');
        }
        if (built === null) return state === 'pending';
        const deadline = built.getTime() + 7 * 24 * 60 * 60 * 1000;
        return state === (EPOCH.getTime() >= deadline ? 'expired' : 'built');
      }),
    );
  });

  it('property: the owner halt reason is owner_veto exactly when sending has not started', () => {
    // Driven from a LIFECYCLE ROW, not from a hand-listed state set: the
    // helper's contract is about the batch, and a property over five literals
    // only restates the function body.
    const stamp = fc.option(fc.date({ min: new Date('2026-01-01'), max: new Date('2027-01-01') }), {
      nil: null,
    });
    fc.assert(
      fc.property(stamp, stamp, stamp, stamp, (built, approved, veto, sending) => {
        const row: BatchLifecycleRow = {
          built_at: built,
          approved_at: approved,
          veto_deadline_at: veto,
          sending_started_at: sending,
          send_closed_at: null,
          halted_at: null,
        };
        const state = deriveBatchState(row, EPOCH);
        const reason = ownerHaltReason(state);
        // A halt is owner_halt exactly when email may already have left, and
        // `sending` is the only state in which that is true.
        return sending !== null
          ? reason === 'owner_halt'
          : reason === 'owner_veto';
      }),
    );
  });
});

describe('deriveBatchState send-lane arms', () => {
  it('reports the derived batch state and approval readiness on the built batch view', () => {
    expect(deriveBatchState(lifecycle(), EPOCH)).toBe('built');
    expect(
      deriveBatchState(
        lifecycle({ approved_at: EPOCH, veto_deadline_at: new Date(EPOCH.getTime() + 60_000) }),
        EPOCH,
      ),
    ).toBe('veto_window');
  });
});
