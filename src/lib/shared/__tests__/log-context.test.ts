import { describe, it, expect } from 'vitest';
import {
  withLogContext,
  getLogContext,
  mergeLogContext,
  createRequestId,
} from '../log-context';

describe('log-context', () => {
  it('returns an empty context outside any scope', () => {
    expect(getLogContext()).toEqual({});
  });

  it('exposes bound IDs inside withLogContext', () => {
    const seen = withLogContext({ business_id: 'biz-1', review_id: 'rev-2' }, () => getLogContext());
    expect(seen.business_id).toBe('biz-1');
    expect(seen.review_id).toBe('rev-2');
  });

  it('does not leak context outside the scope', () => {
    withLogContext({ business_id: 'biz-1' }, () => undefined);
    expect(getLogContext()).toEqual({});
  });

  it('merges nested scopes, child wins on conflict', () => {
    const seen = withLogContext({ business_id: 'biz-1', account_id: 'acc-1' }, () =>
      withLogContext({ business_id: 'biz-2' }, () => getLogContext()),
    );
    expect(seen).toEqual({ business_id: 'biz-2', account_id: 'acc-1' });
  });

  it('mergeLogContext adds IDs to the current scope', () => {
    const seen = withLogContext({ business_id: 'biz-1' }, () => {
      mergeLogContext({ outbox_id: 'ob-9' });
      return getLogContext();
    });
    expect(seen).toEqual({ business_id: 'biz-1', outbox_id: 'ob-9' });
  });

  it('strips undefined / null / empty values when binding', () => {
    const seen = withLogContext(
      { business_id: 'biz-1', account_id: undefined, review_id: '' },
      () => getLogContext(),
    );
    expect(seen).toEqual({ business_id: 'biz-1' });
  });

  it('mergeLogContext is a no-op outside any scope', () => {
    mergeLogContext({ outbox_id: 'ob-9' });
    expect(getLogContext()).toEqual({});
  });

  it('createRequestId returns unique non-empty strings', () => {
    const a = createRequestId();
    const b = createRequestId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
