// src/lib/db/__tests__/transient-error.test.ts
//
// Unit tests for isTransientPostgresError — the additive db-infra layer that
// lets the overage lock tx RETRY a transient Postgres blip (and the worker
// crash-net recover from one) instead of terminal-failing / crashing.

import { describe, it, expect } from 'vitest';
import { isCrashNetRecoverableDbError, isTransientPostgresError } from '../transient-error';

describe('isTransientPostgresError', () => {
  it.each([
    // postgres.js connection-lifecycle codes (exact strings postgres.js v3.4.9 raises)
    'CONNECTION_CLOSED',
    'CONNECTION_ENDED',
    'CONNECTION_DESTROYED',
    'CONNECT_TIMEOUT',
    // transient server SQLSTATEs
    '57014', // query_canceled (statement / lock-wait timeout)
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    // SQLSTATE class 08 — connection_exception
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08007',
    '08P01',
  ])('treats Postgres code %s as transient', (code) => {
    expect(isTransientPostgresError(Object.assign(new Error('db blip'), { code }))).toBe(true);
  });

  it('matches any 5-char SQLSTATE in the 08 connection_exception class', () => {
    expect(isTransientPostgresError(Object.assign(new Error('x'), { code: '08555' }))).toBe(true);
  });

  it('is false for a code-less generic error (preserves the worker terminal default)', () => {
    expect(isTransientPostgresError(new Error('Stripe rate limit'))).toBe(false);
  });

  it('is false for an OS socket code (ECONNRESET) — owned by the Stripe network-code path, not this layer', () => {
    expect(isTransientPostgresError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(false);
  });

  it('is false for a Stripe-typed error with no transient PG code', () => {
    expect(
      isTransientPostgresError(
        Object.assign(new Error('Invalid API key'), { type: 'StripeAuthenticationError', statusCode: 401 }),
      ),
    ).toBe(false);
  });

  it('is false for a deterministic SQLSTATE (23505 unique_violation) — not a transient class', () => {
    expect(isTransientPostgresError(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
  });

  it('is false for non-object / nullish inputs', () => {
    expect(isTransientPostgresError(undefined)).toBe(false);
    expect(isTransientPostgresError(null)).toBe(false);
    expect(isTransientPostgresError('CONNECTION_CLOSED')).toBe(false);
  });
});

describe('isCrashNetRecoverableDbError (stricter process-level subset)', () => {
  it.each([
    '57014', // the observed statement-timeout — the whole reason this exists
    '57P01',
    '57P02',
    '57P03',
    'CONNECTION_CLOSED',
    'CONNECTION_ENDED',
    'CONNECTION_DESTROYED',
    'CONNECT_TIMEOUT',
    '08001', // can't-establish connection failures: operation provably didn't run
    '08003',
    '08004',
    '08006',
  ])('recovers (no crash) on clearly-transient code %s', (code) => {
    expect(isCrashNetRecoverableDbError(Object.assign(new Error('blip'), { code }))).toBe(true);
  });

  it.each([
    '08007', // transaction_resolution_unknown — ambiguous COMMIT; crash instead of silently continuing
    '08P01', // protocol_violation — likely a deeper fault
  ])('does NOT recover (still crashes) on ambiguous/unknown code %s', (code) => {
    expect(isCrashNetRecoverableDbError(Object.assign(new Error('ambiguous'), { code }))).toBe(false);
  });

  it('does NOT apply the open-ended 08-class prefix — an unlisted 08xxx still crashes', () => {
    // isTransientPostgresError matches this via the prefix; the crash-net must not.
    expect(isTransientPostgresError(Object.assign(new Error('x'), { code: '08555' }))).toBe(true);
    expect(isCrashNetRecoverableDbError(Object.assign(new Error('x'), { code: '08555' }))).toBe(false);
  });

  it('is false for code-less / deterministic / nullish inputs', () => {
    expect(isCrashNetRecoverableDbError(new Error('no code'))).toBe(false);
    expect(isCrashNetRecoverableDbError(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
    expect(isCrashNetRecoverableDbError(undefined)).toBe(false);
  });
});
