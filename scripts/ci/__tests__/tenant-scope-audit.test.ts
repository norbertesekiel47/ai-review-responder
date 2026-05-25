import { describe, expect, it } from 'vitest';
import { auditSqlText, extractSqlTemplates } from '../tenant-scope-audit';

describe('tenant-scope-audit', () => {
  const finding = (file: string, table: string) => [
    {
      file,
      table,
      reason: 'missing account_id or business_id scope',
    },
  ];

  it('passes scoped account query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM reviews WHERE account_id = ${accountId}')).toEqual([]);
  });

  it('passes scoped business query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM responses WHERE business_id = ${businessId}')).toEqual([]);
  });

  it('passes scoped qualified business predicate', () => {
    expect(
      auditSqlText('src/example.ts', 'SELECT resp.id FROM responses resp WHERE resp.business_id = ${businessId}'),
    ).toEqual([]);
  });

  it('fails tenant predicate with non-scoping inequality', () => {
    expect(
      auditSqlText('src/example.ts', 'SELECT * FROM reviews WHERE business_id != ${businessId}'),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails tenant predicate with non-scoping ordering comparison', () => {
    expect(
      auditSqlText('src/example.ts', 'SELECT * FROM reviews WHERE business_id > ${businessId}'),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails tenant predicate with non-scoping NOT IN comparison', () => {
    expect(
      auditSqlText('src/example.ts', 'SELECT * FROM reviews WHERE business_id NOT IN (${businessId})'),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails tenant predicate broadened by OR', () => {
    expect(
      auditSqlText('src/example.ts', 'SELECT * FROM reviews WHERE business_id = ${businessId} OR true'),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails negated tenant predicate', () => {
    expect(
      auditSqlText('src/example.ts', 'SELECT * FROM reviews WHERE NOT (business_id = ${businessId})'),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails join-only tenant relationship without bound account or business scope', () => {
    expect(
      auditSqlText('src/example.ts', 'SELECT r.* FROM reviews r JOIN businesses b ON b.id = r.business_id'),
    ).toEqual([
      ...finding('src/example.ts', 'businesses'),
      ...finding('src/example.ts', 'reviews'),
    ]);
  });

  it('fails row-id predicate joined to businesses without bound account or business scope', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT r.* FROM reviews r JOIN businesses b ON b.id = r.business_id WHERE r.id = ${reviewId}',
      ),
    ).toEqual([
      ...finding('src/example.ts', 'businesses'),
      ...finding('src/example.ts', 'reviews'),
    ]);
  });

  it('does not let an unrelated scoped subquery scope an outer tenant table', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT * FROM reviews WHERE EXISTS (SELECT 1 FROM businesses WHERE account_id = ${accountId})',
      ),
    ).toEqual([
      ...finding('src/example.ts', 'businesses'),
      ...finding('src/example.ts', 'reviews'),
    ]);
  });

  it('does not combine unrelated scoped and relationship subqueries', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT r.* FROM reviews r
          WHERE EXISTS (SELECT 1 FROM businesses b WHERE b.account_id = \${accountId})
            AND EXISTS (SELECT 1 FROM businesses b WHERE r.business_id = b.id)
        `,
      ),
    ).toEqual([
      ...finding('src/example.ts', 'businesses'),
      ...finding('src/example.ts', 'reviews'),
    ]);
  });

  it('passes tenant table joined through a scoped business', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT r.* FROM reviews r JOIN businesses b ON b.id = r.business_id WHERE b.account_id = ${accountId}',
      ),
    ).toEqual([]);
  });

  it('fails tenant relationship broadened by OR', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT r.* FROM reviews r JOIN businesses b ON b.id = r.business_id OR true WHERE b.account_id = ${accountId}',
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails negated tenant relationship', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT r.* FROM reviews r JOIN businesses b ON NOT (b.id = r.business_id) WHERE b.account_id = ${accountId}',
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('passes tenant table joined through a scoped account', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT aal.* FROM account_audit_log aal JOIN accounts a ON a.id = aal.account_id WHERE a.id = ${accountId}',
      ),
    ).toEqual([]);
  });

  it('fails unscoped tenant table query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM reviews')).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails when tenant column only appears in the select list', () => {
    expect(
      auditSqlText('src/example.ts', 'SELECT business_id FROM responses WHERE id = ${responseId}'),
    ).toEqual(finding('src/example.ts', 'responses'));
  });

  it('passes account root lookup by id', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM accounts WHERE id = ${accountId}')).toEqual([]);
  });

  it('passes business root lookup by id', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM businesses WHERE id = ${businessId}')).toEqual([]);
  });

  it('fails non-root tenant row primary-key lookup without account or business scope', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM responses WHERE id = ${responseId}')).toEqual(
      finding('src/example.ts', 'responses'),
    );
  });

  it('fails foreign-key lookup without account or business scope', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM responses WHERE review_id = ${reviewId}')).toEqual(
      finding('src/example.ts', 'responses'),
    );
  });

  it('passes an allowlisted statement when the exact snippet matches', () => {
    expect(
      auditSqlText(
        'worker/background/pollers/ArchivalPoller.ts',
        `
          WITH candidates AS (
            SELECT id FROM notification_deliveries
            WHERE created_at < NOW() - INTERVAL '90 days'
            LIMIT 5000
            FOR UPDATE SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM notification_deliveries WHERE id IN (SELECT id FROM candidates)
            RETURNING id
          )
          SELECT COUNT(*)::text AS count FROM deleted
        `,
      ),
    ).toEqual([]);
  });

  it('fails a different unscoped statement in the same allowlisted file and table', () => {
    expect(
      auditSqlText(
        'worker/background/pollers/ArchivalPoller.ts',
        'SELECT id FROM notification_deliveries WHERE failed_at IS NOT NULL',
      ),
    ).toEqual(finding('worker/background/pollers/ArchivalPoller.ts', 'notification_deliveries'));
  });

  it('fails an allowlisted statement with an appended unscoped statement', () => {
    expect(
      auditSqlText(
        'worker/background/pollers/ArchivalPoller.ts',
        `
          WITH candidates AS (
            SELECT id FROM notification_deliveries
            WHERE created_at < NOW() - INTERVAL '90 days'
            LIMIT 5000
            FOR UPDATE SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM notification_deliveries WHERE id IN (SELECT id FROM candidates)
            RETURNING id
          )
          SELECT COUNT(*)::text AS count FROM deleted;
          DELETE FROM notification_deliveries WHERE failed_at IS NOT NULL
        `,
      ),
    ).toEqual(finding('worker/background/pollers/ArchivalPoller.ts', 'notification_deliveries'));
  });

  it('fails unscoped review_exceptions query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM review_exceptions')).toEqual(
      finding('src/example.ts', 'review_exceptions'),
    );
  });

  it('fails unscoped ranking_snapshots query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM ranking_snapshots')).toEqual(
      finding('src/example.ts', 'ranking_snapshots'),
    );
  });

  it('ignores global table query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM inbound_events')).toEqual([]);
  });

  it('extracts sql and transaction tagged templates', () => {
    expect(extractSqlTemplates(`
      await sql\`SELECT * FROM reviews WHERE business_id = \${businessId}\`;
      await tx\`UPDATE responses SET status = 'posted' WHERE id = \${responseId}\`;
    `)).toEqual([
      { tag: 'sql', sqlText: 'SELECT * FROM reviews WHERE business_id = ${businessId}' },
      { tag: 'tx', sqlText: "UPDATE responses SET status = 'posted' WHERE id = ${responseId}" },
    ]);
  });
});
