import { describe, expect, it } from 'vitest';
import { auditSqlText, extractSqlTemplates, findAllowlistIntegrityFindings } from '../tenant-scope-audit';
import {
  ALLOWLIST_BASELINE,
  tenantScopeAllowlist,
  type TenantScopeAllowlistEntry,
} from '../tenant-scope-allowlist';

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

  it('passes scoped tenant predicate with unrelated OR in another AND segment', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT * FROM channel_enrollments WHERE account_id = ${accountId}::uuid AND (location_id = ${locationId}::uuid OR location_id IS NULL)',
      ),
    ).toEqual([]);
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

  it('passes offboarding tokens joined through a scoped offboarding row', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT t.*
          FROM account_offboarding_tokens t
          JOIN account_offboardings o ON o.id = t.account_offboarding_id
          WHERE o.account_id = \${accountId}
        `,
      ),
    ).toEqual([]);
  });

  it('passes offboarding tokens joined through an account-scoped offboarding row', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT t.*
          FROM account_offboarding_tokens t
          JOIN account_offboardings o ON o.id = t.account_offboarding_id
          JOIN accounts a ON a.id = o.account_id
          WHERE a.id = \${accountId}
        `,
      ),
    ).toEqual([]);
  });

  it('fails offboarding tokens joined to an unscoped offboarding row', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT t.*
          FROM account_offboarding_tokens t
          JOIN account_offboardings o ON o.id = t.account_offboarding_id
        `,
      ),
    ).toEqual([
      ...finding('src/example.ts', 'account_offboardings'),
      ...finding('src/example.ts', 'account_offboarding_tokens'),
    ]);
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

  it('fails when a scoped union arm is followed by an unscoped arm', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT * FROM reviews WHERE business_id = ${businessId} UNION ALL SELECT * FROM reviews',
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('does not split set operator words inside string literals', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        "SELECT * FROM reviews WHERE business_id = ${businessId} AND text = 'union all'",
      ),
    ).toEqual([]);
  });

  it('does not split set operators inside CTE bodies', () => {
    const entry = tenantScopeAllowlist.find((allowlistEntry) => (
      allowlistEntry.file === 'src/lib/admin/cost-report-service.ts'
      && allowlistEntry.sqlSnippet.includes('WITH combined AS')
      && allowlistEntry.sqlSnippet.includes('UNION ALL')
    ));

    if (!entry) throw new Error('missing cost-report UNION ALL allowlist fixture');
    expect(auditSqlText(entry.file, entry.sqlSnippet)).toEqual([]);
  });

  it('keeps allowlist reasons specific enough for review', () => {
    expect(tenantScopeAllowlist.filter((entry) => (
      entry.reason.trim().length === 0
      || /reviewed by the audit allowlist/i.test(entry.reason)
      || /heuristic scanner cannot fully prove/i.test(entry.reason)
      || /row identifier, business identifier, or auth-owned account path/i.test(entry.reason)
    ))).toEqual([]);
  });

  it('fails when a scoped statement is followed by an unscoped statement', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT * FROM reviews WHERE business_id = ${businessId}; DELETE FROM reviews',
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails unscoped review_exceptions query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM review_exceptions')).toEqual(
      finding('src/example.ts', 'review_exceptions'),
    );
  });

  it('fails unscoped channel_enrollments query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM channel_enrollments')).toEqual(
      finding('src/example.ts', 'channel_enrollments'),
    );
  });

  it('fails unscoped tenant tables from the RLS inventory', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM weekly_summaries')).toEqual(
      finding('src/example.ts', 'weekly_summaries'),
    );
    expect(auditSqlText('src/example.ts', 'SELECT * FROM zernio_backfill_runs')).toEqual(
      finding('src/example.ts', 'zernio_backfill_runs'),
    );
    expect(auditSqlText('src/example.ts', 'SELECT * FROM zernio_connections')).toEqual(
      finding('src/example.ts', 'zernio_connections'),
    );
  });

  it('fails unscoped ranking_snapshots query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM ranking_snapshots')).toEqual(
      finding('src/example.ts', 'ranking_snapshots'),
    );
  });

  it('ignores a non-tenant table query (table absent from TENANT_TABLES)', () => {
    // owner_leads is a real table (migration 033) that is intentionally NOT in
    // TENANT_TABLES, so the audit never scopes it.
    expect(auditSqlText('src/example.ts', 'SELECT * FROM owner_leads')).toEqual([]);
  });

  it('extracts sql, transaction, and imported sql-alias tagged templates', () => {
    expect(extractSqlTemplates(`
      import { sql as defaultSql } from '@/lib/db/server';
      import { sql as workerSql } from '../../../src/lib/db/server';
      await sql\`SELECT * FROM reviews WHERE business_id = \${businessId}\`;
      await tx\`UPDATE responses SET status = 'posted' WHERE id = \${responseId}\`;
      await defaultSql\`SELECT * FROM businesses WHERE account_id = \${accountId}\`;
      await workerSql\`SELECT * FROM accounts WHERE id = \${accountId}\`;
      await db\`INSERT INTO account_audit_log (account_id) VALUES (\${accountId})\`;
    `)).toEqual([
      { tag: 'sql', sqlText: 'SELECT * FROM reviews WHERE business_id = ${businessId}' },
      { tag: 'tx', sqlText: "UPDATE responses SET status = 'posted' WHERE id = ${responseId}" },
      { tag: 'defaultSql', sqlText: 'SELECT * FROM businesses WHERE account_id = ${accountId}' },
      { tag: 'workerSql', sqlText: 'SELECT * FROM accounts WHERE id = ${accountId}' },
      { tag: 'db', sqlText: 'INSERT INTO account_audit_log (account_id) VALUES (${accountId})' },
    ]);
  });

  it('extracts sqlRead-tagged templates (read-bulkhead export, #477) — an un-aliased sqlRead import registers as tag sqlRead, not sql', () => {
    expect(extractSqlTemplates(`
      import { sql, sqlRead } from '@/lib/db/server';
      await sql\`SELECT * FROM reviews WHERE business_id = \${businessId}\`;
      await sqlRead\`SELECT subscription_status FROM accounts WHERE id = \${accountId}::uuid\`;
    `)).toEqual([
      { tag: 'sql', sqlText: 'SELECT * FROM reviews WHERE business_id = ${businessId}' },
      { tag: 'sqlRead', sqlText: 'SELECT subscription_status FROM accounts WHERE id = ${accountId}::uuid' },
    ]);
  });

  it('audits a sqlRead-tagged tenant-scoped query — the accounts self-scope predicate passes without needing an allowlist entry', () => {
    const templates = extractSqlTemplates(`
      import { sqlRead } from '@/lib/db/server';
      await sqlRead\`SELECT subscription_status FROM accounts WHERE id = \${accountId}::uuid\`;
    `);
    expect(templates.flatMap((template) => auditSqlText('src/example.ts', template.sqlText))).toEqual([]);
  });

  it('extracts sqlUnsubscribe-tagged templates (redemption-pool export, #651) — an un-aliased sqlUnsubscribe import registers as tag sqlUnsubscribe, not sql', () => {
    // #651 added a third db/server client. Every tagged-template client export
    // must be in DB_SERVER_SQL_TAG_SOURCE_NAMES or a query tagged with it
    // silently escapes this audit — the exact gap #477 closed for sqlRead.
    expect(extractSqlTemplates(`
      import { sql, sqlUnsubscribe } from '@/lib/db/server';
      await sql\`SELECT * FROM reviews WHERE business_id = \${businessId}\`;
      await sqlUnsubscribe\`SELECT * FROM reviews WHERE business_id != \${businessId}\`;
    `)).toEqual([
      { tag: 'sql', sqlText: 'SELECT * FROM reviews WHERE business_id = ${businessId}' },
      { tag: 'sqlUnsubscribe', sqlText: 'SELECT * FROM reviews WHERE business_id != ${businessId}' },
    ]);
  });

  it('a non-scoping predicate on a sqlUnsubscribe-tagged query is a finding, not a silent skip', () => {
    const templates = extractSqlTemplates(`
      import { sqlUnsubscribe } from '@/lib/db/server';
      await sqlUnsubscribe\`SELECT * FROM reviews WHERE business_id != \${businessId}\`;
    `);
    expect(templates.flatMap((template) => auditSqlText('src/example.ts', template.sqlText))).toEqual(
      finding('src/example.ts', 'reviews'),
    );
  });

  it('extracts sql.unsafe and tx.unsafe templates from local query variables', () => {
    expect(extractSqlTemplates(`
      const query = \`UPDATE businesses SET tone = $2 WHERE id = $1\`;
      await sql.unsafe(query, values);

      const dataQuery = \`
        SELECT nd.id
        FROM notification_deliveries nd
        \${whereClause}
        LIMIT $\${limitIdx}
      \`;
      await sql.unsafe<NotificationRow[]>(dataQuery, queryParams);

      const txQuery = \`UPDATE responses SET status = 'posted' WHERE review_id = \${reviewId}\`;
      await tx.unsafe(txQuery, values);

      const staticStringQuery = 'SELECT * FROM zernio_connections';
      await sql.unsafe(staticStringQuery, values);
    `)).toEqual([
      { tag: 'sql.unsafe', sqlText: 'UPDATE businesses SET tone = $2 WHERE id = $1' },
      {
        tag: 'sql.unsafe',
        sqlText: `
        SELECT nd.id
        FROM notification_deliveries nd
        \${whereClause}
        LIMIT $\${limitIdx}
      `,
      },
      {
        tag: 'tx.unsafe',
        sqlText: "UPDATE responses SET status = 'posted' WHERE review_id = ${reviewId}",
      },
      { tag: 'sql.unsafe', sqlText: 'SELECT * FROM zernio_connections' },
    ]);
  });

  it('audits sql.unsafe templates resolved from local query variables', () => {
    const templates = extractSqlTemplates(`
      const unsafeQuery = \`SELECT * FROM zernio_connections\`;
      await sql.unsafe(unsafeQuery, []);
    `);

    expect(templates.flatMap((template) => auditSqlText('src/example.ts', template.sqlText))).toEqual(
      finding('src/example.ts', 'zernio_connections'),
    );
  });

  it('does not treat a backtick-wrapped tag word inside a comment as a template opener', () => {
    expect(extractSqlTemplates(`
      // Each helper runs on an already-open transaction (\`tx\`), enforcing the guard.
      export async function supersedeSibling(tx) {
        const sup = await tx\`
          UPDATE responses SET status = 'superseded' WHERE id = \${siblingId} AND status = 'posted'
        \`;
      }
    `)).toEqual([
      {
        tag: 'tx',
        sqlText: `
          UPDATE responses SET status = 'superseded' WHERE id = \${siblingId} AND status = 'posted'
        `,
      },
    ]);
  });

  it('does not treat a backtick tag word inside a block comment as a template opener', () => {
    expect(extractSqlTemplates(`
      /* leaf module: helpers run on an open \`tx\` handle. */
      await sql\`SELECT * FROM reviews WHERE business_id = \${businessId}\`;
    `)).toEqual([
      { tag: 'sql', sqlText: 'SELECT * FROM reviews WHERE business_id = ${businessId}' },
    ]);
  });

  it('does not treat // inside a string literal as a line comment', () => {
    expect(extractSqlTemplates(`
      const u = 'https://example.com';
      await sql\`SELECT * FROM accounts WHERE id = \${accountId}\`;
    `)).toEqual([
      { tag: 'sql', sqlText: 'SELECT * FROM accounts WHERE id = ${accountId}' },
    ]);
  });

  it('does not treat /* inside a query string as a block comment', () => {
    expect(extractSqlTemplates(`
      await sql\`SELECT '/*' AS marker FROM reviews WHERE business_id = \${businessId}\`;
    `)).toEqual([
      { tag: 'sql', sqlText: "SELECT '/*' AS marker FROM reviews WHERE business_id = ${businessId}" },
    ]);
  });
});

describe('allowlist integrity (baseline gate + category invariants)', () => {
  const entry = (overrides: Partial<TenantScopeAllowlistEntry>): TenantScopeAllowlistEntry => ({
    file: 'src/app/api/admin/example/route.ts',
    table: 'businesses',
    sqlSnippet: 'SELECT id FROM businesses',
    category: 'admin-after-require-role',
    reason: 'test entry',
    ...overrides,
  });

  it('passes when the entry count matches the baseline and categories satisfy their path rules', () => {
    expect(findAllowlistIntegrityFindings([entry({})], 1)).toEqual([]);
  });

  it('fails when the entry count exceeds the baseline', () => {
    const findings = findAllowlistIntegrityFindings([entry({}), entry({ table: 'reviews' })], 1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain('2 entries but ALLOWLIST_BASELINE is 1');
  });

  it('fails when the entry count shrinks below the baseline (no shrink-then-regrow masking)', () => {
    const findings = findAllowlistIntegrityFindings([entry({})], 2);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain('1 entries but ALLOWLIST_BASELINE is 2');
  });

  it('fails an admin-category entry living outside the admin paths', () => {
    const findings = findAllowlistIntegrityFindings(
      [entry({ file: 'src/lib/reviews/example.ts' })],
      1,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("category 'admin-after-require-role'");
  });

  it('accepts an explicitly allowed file outside the standard prefixes', () => {
    expect(
      findAllowlistIntegrityFindings(
        [entry({ file: 'src/lib/account-offboarding/provider-disposition.ts' })],
        1,
      ),
    ).toEqual([]);
  });

  it('applies no path rule to categories whose justification is contextual', () => {
    expect(
      findAllowlistIntegrityFindings(
        [entry({ file: 'src/lib/anywhere/example.ts', category: 'tenant-root-lookup' })],
        1,
      ),
    ).toEqual([]);
  });

  it('holds against the real allowlist: count matches baseline and all invariants pass', () => {
    expect(findAllowlistIntegrityFindings()).toEqual([]);
    expect(tenantScopeAllowlist.length).toBe(ALLOWLIST_BASELINE);
  });
});
