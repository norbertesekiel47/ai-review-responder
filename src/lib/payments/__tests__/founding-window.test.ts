import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfigForTests } from '@/lib/config/server';
import { isFoundingWindowOpen } from '../founding-window';

const reportCaughtError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError }));

const originalDeadline = process.env.FOUNDING_DEADLINE;

beforeEach(() => {
  process.env.FOUNDING_DEADLINE = '2027-01-01T00:00:00Z';
  resetServerConfigForTests();
  reportCaughtError.mockClear();
});

afterEach(() => {
  if (originalDeadline === undefined) delete process.env.FOUNDING_DEADLINE;
  else process.env.FOUNDING_DEADLINE = originalDeadline;
  resetServerConfigForTests();
});

describe('isFoundingWindowOpen', () => {
  it('uses the strict now < deadline boundary', () => {
    expect(isFoundingWindowOpen(new Date('2026-12-31T23:59:59.999Z'))).toBe(true);
    expect(isFoundingWindowOpen(new Date('2027-01-01T00:00:00.000Z'))).toBe(false);
    expect(isFoundingWindowOpen(new Date('2027-01-01T00:00:00.001Z'))).toBe(false);
    expect(reportCaughtError).not.toHaveBeenCalled();
  });

  it('accepts a real full UTC leap-day timestamp that round-trips exactly', () => {
    process.env.FOUNDING_DEADLINE = '2028-02-29T12:34:56Z';
    resetServerConfigForTests();
    expect(isFoundingWindowOpen(new Date('2028-02-29T12:34:55Z'))).toBe(true);
    expect(reportCaughtError).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '2027-01-01',
    '2027-01-01T00:00:00+00:00',
    '2027-01-01T00:00:00.000Z',
    '2027-01-01T00:00:00Z trailing',
    '2027-02-29T00:00:00Z',
    '2027-13-01T00:00:00Z',
    '2027-01-01T24:00:00Z',
  ])('fails closed and reports scrubbed malformed configuration for %j', (value) => {
    process.env.FOUNDING_DEADLINE = value;
    resetServerConfigForTests();

    expect(isFoundingWindowOpen(new Date('2026-01-01T00:00:00Z'))).toBe(false);
    expect(reportCaughtError).toHaveBeenCalledTimes(1);
    expect(reportCaughtError).toHaveBeenCalledWith(
      'payments/founding-window',
      expect.objectContaining({
        message: 'FOUNDING_DEADLINE is missing or malformed; list pricing selected',
      }),
      { reason: 'malformed' },
    );
    expect(JSON.stringify(reportCaughtError.mock.calls)).not.toContain(value || 'raw-empty-value');
  });

  it('fails closed and reports missing configuration without throwing', () => {
    delete process.env.FOUNDING_DEADLINE;
    resetServerConfigForTests();

    expect(() => isFoundingWindowOpen(new Date('2026-01-01T00:00:00Z'))).not.toThrow();
    expect(isFoundingWindowOpen(new Date('2026-01-01T00:00:00Z'))).toBe(false);
    expect(reportCaughtError).toHaveBeenLastCalledWith(
      'payments/founding-window',
      expect.any(Error),
      { reason: 'missing' },
    );
  });
});
