import { describe, expect, it } from 'vitest';
import { auditSqlText } from '../tenant-scope-audit';

describe('tenant-scope-audit', () => {
  it('passes scoped account query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM reviews WHERE account_id = ${accountId}')).toEqual([]);
  });

  it('passes scoped business query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM responses WHERE business_id = ${businessId}')).toEqual([]);
  });

  it('fails unscoped tenant table query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM reviews')).toEqual([
      {
        file: 'src/example.ts',
        table: 'reviews',
        reason: 'missing account_id or business_id scope',
      },
    ]);
  });

  it('passes account root lookup by id', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM accounts WHERE id = ${accountId}')).toEqual([]);
  });

  it('passes tenant row lookup by id', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM businesses WHERE id = ${businessId}')).toEqual([]);
  });

  it('passes response lookup by review id', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM responses WHERE review_id = ${reviewId}')).toEqual([]);
  });

  it('ignores global table query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM inbound_events')).toEqual([]);
  });
});
