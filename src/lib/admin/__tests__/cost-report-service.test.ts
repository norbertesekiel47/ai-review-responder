import { describe, it, expect } from 'vitest';
import { parseCostQuery } from '../cost-report-service';

describe('parseCostQuery', () => {
  it('returns defaults when no params provided', () => {
    const result = parseCostQuery(new URLSearchParams(''));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(7);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.accountId).toBe('');
  });

  it('clamps days=0 to 1 (not silently default to 7)', () => {
    const result = parseCostQuery(new URLSearchParams('days=0'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(1);
  });

  it('clamps negative days=-5 to 1', () => {
    const result = parseCostQuery(new URLSearchParams('days=-5'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(1);
  });

  it('clamps limit=-5 to 1', () => {
    const result = parseCostQuery(new URLSearchParams('limit=-5'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.limit).toBe(1);
  });

  it('clamps offset=-3 to 0', () => {
    const result = parseCostQuery(new URLSearchParams('offset=-3'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.offset).toBe(0);
  });

  it('returns error for days=400', () => {
    const result = parseCostQuery(new URLSearchParams('days=400'));
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('days parameter must be 365 or less');
  });

  it('falls back to 7 when days is non-numeric', () => {
    const result = parseCostQuery(new URLSearchParams('days=abc'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(7);
  });

  it('falls back to 20 when limit is non-numeric', () => {
    const result = parseCostQuery(new URLSearchParams('limit=abc'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.limit).toBe(20);
  });

  it('falls back to 0 when offset is non-numeric', () => {
    const result = parseCostQuery(new URLSearchParams('offset=abc'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.offset).toBe(0);
  });

  it('caps limit at 100', () => {
    const result = parseCostQuery(new URLSearchParams('limit=200'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.limit).toBe(100);
  });

  it('caps days at 365', () => {
    const result = parseCostQuery(new URLSearchParams('days=365'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(365);
  });

  it('parses accountId when provided', () => {
    const result = parseCostQuery(new URLSearchParams('account_id=acct-123'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    // asAccountId is a nominal cast — value is preserved
    expect(result.accountId).toBe('acct-123');
  });

  it('leaves accountId as empty string when not provided', () => {
    const result = parseCostQuery(new URLSearchParams(''));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.accountId).toBe('');
  });
});
