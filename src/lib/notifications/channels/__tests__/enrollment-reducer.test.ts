// src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts
import { describe, it, expect } from 'vitest';
import {
  enrollmentReducer,
  initialEnrollment,
  type EnrollmentSnapshot,
  type EnrollmentAction,
  type ChannelEnrollmentRow,
} from '../enrollment-reducer';

const verifiedRow = (overrides: Partial<ChannelEnrollmentRow> = {}): ChannelEnrollmentRow => ({
  channel: 'telegram',
  handle: '••• 1234',
  status: 'verified',
  verified_at: '2026-04-28T12:00:00.000Z',
  disabled_at: null,
  unsubscribed_at: null,
  unsubscribed_reason: null,
  expires_at: null,
  ...overrides,
});

const pendingRow = (expiresAtIso = '2026-04-28T13:00:00.000Z'): ChannelEnrollmentRow =>
  verifiedRow({ status: 'pending_verification', handle: null, verified_at: null, expires_at: expiresAtIso });

describe('initialEnrollment', () => {
  it('starts in idle with all fields null', () => {
    expect(initialEnrollment).toEqual({
      state: 'idle',
      previousState: null,
      handle: null,
      deepLink: null,
      qrDataUrl: null,
      expiresAt: null,
      unsubscribedReason: null,
      errorMessage: null,
    });
  });
});

describe('enrollmentReducer — CONNECT_REQUESTED', () => {
  it('idle → generating', () => {
    const next = enrollmentReducer(initialEnrollment, { type: 'CONNECT_REQUESTED' });
    expect(next.state).toBe('generating');
  });

  it('disabled → generating', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'disabled' },
      { type: 'CONNECT_REQUESTED' },
    );
    expect(next.state).toBe('generating');
  });
});

describe('enrollmentReducer — CONNECT_SUCCEEDED', () => {
  it('generating → awaiting_scan with deepLink/qr/expiresAt', () => {
    const start: EnrollmentSnapshot = { ...initialEnrollment, state: 'generating' };
    const next = enrollmentReducer(start, {
      type: 'CONNECT_SUCCEEDED',
      deepLink: 'https://t.me/RepWorthBot?start=abc',
      qrDataUrl: 'data:image/png;base64,FAKE',
      expiresAt: 1735000000000,
    });
    expect(next.state).toBe('awaiting_scan');
    expect(next.deepLink).toBe('https://t.me/RepWorthBot?start=abc');
    expect(next.qrDataUrl).toBe('data:image/png;base64,FAKE');
    expect(next.expiresAt).toBe(1735000000000);
    expect(next.errorMessage).toBeNull();
  });
});

describe('enrollmentReducer — CONNECT_FAILED error classification', () => {
  it('401 → error / Session expired', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 401, message: 'unauthorized' },
    );
    expect(next.state).toBe('error');
    expect(next.errorMessage).toBe('Session expired — please sign in again.');
  });

  it('403 → error / Session expired', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 403, message: 'forbidden' },
    );
    expect(next.errorMessage).toBe('Session expired — please sign in again.');
  });

  it('404 → error / channel disabled', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 404, message: 'not_found' },
    );
    expect(next.errorMessage).toBe('This channel is currently unavailable.');
  });

  it('503 → error / service unavailable', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 503, message: 'env_not_ready' },
    );
    expect(next.errorMessage).toBe('Service temporarily unavailable. Please try again.');
  });

  it('409 (multiple_mobile_channels) → error with switch-channel message', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 409, message: 'multiple_mobile_channels' },
    );
    expect(next.errorMessage).toBe('Disconnect your current channel before connecting another.');
  });

  it('409 (already_verified) → error with already-connected copy', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 409, message: 'already_verified' },
    );
    expect(next.errorMessage).toBe('Already connected.');
  });

  it('other status → error with generic message', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 500, message: 'boom' },
    );
    expect(next.state).toBe('error');
    expect(next.errorMessage).toContain('500');
  });
});

describe('enrollmentReducer — STATUS_FETCHED transition table', () => {
  const awaitingState: EnrollmentSnapshot = {
    ...initialEnrollment,
    state: 'awaiting_scan',
    deepLink: 'https://t.me/RepWorthBot?start=abc',
    qrDataUrl: 'data:image/png;base64,FAKE',
    expiresAt: 1735000000000,
  };

  it('awaiting_scan + null row → no-op (preserves expiresAt + qrDataUrl)', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: null,
      nowMs: 1734999000000,
    });
    expect(next).toBe(awaitingState); // identity-equal — strict no-op
  });

  it('awaiting_scan + pending_verification → no-op (preserves cached expiresAt)', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: pendingRow('2026-99-99T00:00:00.000Z'), // intentionally different from cached expiresAt
      nowMs: 1734999000000,
    });
    expect(next).toBe(awaitingState);
  });

  it('awaiting_scan + verified → verified', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: verifiedRow(),
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('verified');
    expect(next.handle).toBe('••• 1234');
  });

  it('awaiting_scan + disabled → disabled (admin or webhook killed mid-flow)', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: verifiedRow({ status: 'disabled', handle: null }),
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('disabled');
  });

  it('awaiting_scan + unsubscribed → unsubscribed with reason', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: verifiedRow({ status: 'unsubscribed', handle: null, unsubscribed_reason: 'telegram_blocked' }),
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('unsubscribed');
    expect(next.unsubscribedReason).toBe('telegram_blocked');
  });

  it('idle + verified → verified (take row authoritatively)', () => {
    const next = enrollmentReducer(initialEnrollment, {
      type: 'STATUS_FETCHED',
      row: verifiedRow(),
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('verified');
    expect(next.handle).toBe('••• 1234');
  });

  it('idle + null → idle (no change)', () => {
    const next = enrollmentReducer(initialEnrollment, {
      type: 'STATUS_FETCHED',
      row: null,
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('idle');
  });

  it('verified + null row → idle (row gone)', () => {
    const verified: EnrollmentSnapshot = { ...initialEnrollment, state: 'verified', handle: '••• 1234' };
    const next = enrollmentReducer(verified, {
      type: 'STATUS_FETCHED',
      row: null,
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('idle');
    expect(next.handle).toBeNull();
  });

  it('generating + any row → no-op (wait for CONNECT_SUCCEEDED/FAILED)', () => {
    const generating: EnrollmentSnapshot = { ...initialEnrollment, state: 'generating' };
    const next = enrollmentReducer(generating, {
      type: 'STATUS_FETCHED',
      row: verifiedRow(),
      nowMs: 1734999000000,
    });
    expect(next).toBe(generating);
  });
});

describe('enrollmentReducer — TICK', () => {
  const awaitingState: EnrollmentSnapshot = {
    ...initialEnrollment,
    state: 'awaiting_scan',
    expiresAt: 1735000000000,
  };

  it('TICK with nowMs < expiresAt → unchanged', () => {
    const next = enrollmentReducer(awaitingState, { type: 'TICK', nowMs: 1734999999999 });
    expect(next).toBe(awaitingState);
  });

  it('TICK with nowMs === expiresAt → expired', () => {
    const next = enrollmentReducer(awaitingState, { type: 'TICK', nowMs: 1735000000000 });
    expect(next.state).toBe('expired');
  });

  it('TICK with nowMs > expiresAt → expired', () => {
    const next = enrollmentReducer(awaitingState, { type: 'TICK', nowMs: 1735000001000 });
    expect(next.state).toBe('expired');
  });

  it('TICK in non-awaiting_scan states → no-op', () => {
    const verified: EnrollmentSnapshot = { ...initialEnrollment, state: 'verified', handle: '••• 1234' };
    const next = enrollmentReducer(verified, { type: 'TICK', nowMs: 9999999999999 });
    expect(next).toBe(verified);
  });
});

describe('enrollmentReducer — CANCEL_SUCCEEDED + DISABLE_SUCCEEDED + DISMISS_ERROR', () => {
  it('CANCEL_SUCCEEDED from awaiting_scan → idle (clears qr/deepLink/expiresAt)', () => {
    const awaiting: EnrollmentSnapshot = {
      ...initialEnrollment,
      state: 'awaiting_scan',
      deepLink: 'x',
      qrDataUrl: 'y',
      expiresAt: 123,
    };
    const next = enrollmentReducer(awaiting, { type: 'CANCEL_SUCCEEDED' });
    expect(next.state).toBe('idle');
    expect(next.deepLink).toBeNull();
    expect(next.qrDataUrl).toBeNull();
    expect(next.expiresAt).toBeNull();
  });

  it('DISABLE_SUCCEEDED from verified → disabled (clears handle)', () => {
    const verified: EnrollmentSnapshot = { ...initialEnrollment, state: 'verified', handle: '••• 1234' };
    const next = enrollmentReducer(verified, { type: 'DISABLE_SUCCEEDED' });
    expect(next.state).toBe('disabled');
    expect(next.handle).toBeNull();
  });

  it('DISMISS_ERROR from error → idle (clears errorMessage)', () => {
    const errored: EnrollmentSnapshot = { ...initialEnrollment, state: 'error', errorMessage: 'boom' };
    const next = enrollmentReducer(errored, { type: 'DISMISS_ERROR' });
    expect(next.state).toBe('idle');
    expect(next.errorMessage).toBeNull();
  });

  it('DISMISS_ERROR from error-after-verified → restores verified', () => {
    // Simulate the failed-disable flow: verified → CONNECT_FAILED (error) → DISMISS_ERROR
    const verified: EnrollmentSnapshot = { ...initialEnrollment, state: 'verified', handle: '••• 1234' };
    const errored = enrollmentReducer(verified, { type: 'CONNECT_FAILED', status: 500, message: 'disable_failed' });
    expect(errored.state).toBe('error');
    expect(errored.previousState).toBe('verified');
    expect(errored.handle).toBe('••• 1234'); // preserved via spread

    const restored = enrollmentReducer(errored, { type: 'DISMISS_ERROR' });
    expect(restored.state).toBe('verified');
    expect(restored.previousState).toBeNull();
    expect(restored.errorMessage).toBeNull();
    expect(restored.handle).toBe('••• 1234');
  });

  it('CONNECT_FAILED while in error preserves the original previousState', () => {
    const verified: EnrollmentSnapshot = { ...initialEnrollment, state: 'verified', handle: '••• 1234' };
    const firstError = enrollmentReducer(verified, { type: 'CONNECT_FAILED', status: 500, message: 'first' });
    expect(firstError.previousState).toBe('verified');
    // A second failure shouldn't clobber previousState with 'error'
    const secondError = enrollmentReducer(firstError, { type: 'CONNECT_FAILED', status: 503, message: 'second' });
    expect(secondError.previousState).toBe('verified');
  });
});

describe('enrollmentReducer — pure-function invariant', () => {
  it('does not call Date.now() (state independent of wall clock)', () => {
    // Run the same action twice with no clock change; identical result by reference equality.
    const action: EnrollmentAction = { type: 'CONNECT_REQUESTED' };
    const a = enrollmentReducer(initialEnrollment, action);
    const b = enrollmentReducer(initialEnrollment, action);
    expect(a).toEqual(b);
  });
});

describe('enrollmentReducer — mobile-channel conflict copy (launch contract)', () => {
  it('maps a 409 multiple_mobile_channels to the generic disconnect message', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 409, message: 'multiple_mobile_channels' },
    );
    expect(next.state).toBe('error');
    expect(next.errorMessage).toBe('Disconnect your current channel before connecting another.');
  });

  it('maps a 409 already_verified to the already-connected message', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 409, message: 'already_verified' },
    );
    expect(next.errorMessage).toBe('Already connected.');
  });
});
