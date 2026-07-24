import { describe, expect, it } from 'vitest';
import { resolveContactMatch } from '../ingest';

const X = { id: 'contact-x', name: 'Ada', email: 'ada@example.com', phone: null };
const Y = { id: 'contact-y', name: 'Bob', email: null, phone: '+14155552671' };

describe('resolveContactMatch', () => {
  it('creates a new contact when neither handle matches', () => {
    expect(resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: null }, null, null,
    )).toEqual({ action: 'create' });
  });

  it('rejects a row whose email and phone match two different contacts with ambiguous_identity', () => {
    expect(resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: '+14155552671' }, X, Y,
    )).toEqual({ action: 'reject', reason: 'ambiguous_identity' });
  });

  it('merges a missing handle into the matched contact', () => {
    const result = resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: '+14155552671' }, X, null,
    );
    expect(result).toEqual({
      action: 'update', contactId: 'contact-x',
      set: { name: 'Ada', phone: '+14155552671' },
    });
  });

  it('latest non-empty name wins on a matched contact', () => {
    const result = resolveContactMatch(
      { name: 'Ada L.', email: 'ada@example.com', phone: null }, X, null,
    );
    expect(result).toEqual({
      action: 'update', contactId: 'contact-x', set: { name: 'Ada L.' },
    });
    const unchanged = resolveContactMatch(
      { name: '', email: 'ada@example.com', phone: null }, X, null,
    );
    expect(unchanged).toEqual({ action: 'update', contactId: 'contact-x', set: {} });
  });

  it('same contact matched by both handles is a plain update', () => {
    const both = { ...X, phone: '+14155552671' };
    expect(resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: '+14155552671' }, both, both,
    )).toEqual({ action: 'update', contactId: 'contact-x', set: {} });
  });
});
