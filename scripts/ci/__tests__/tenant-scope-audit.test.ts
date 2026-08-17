import { describe, expect, it } from 'vitest';
import {
  auditSourceText,
  auditSqlText,
  extractSqlTemplates,
  findAllowlistIntegrityFindings,
} from '../tenant-scope-audit';
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
      sqlIdentity: expect.any(String),
    },
  ];

  it('passes scoped account query', () => {
    expect(
      auditSqlText('src/example.ts', 'SELECT * FROM channel_enrollments WHERE account_id = ${accountId}'),
    ).toEqual([]);
  });

  it('rejects an unqualified scope column the table does not carry', () => {
    // reviews has no account_id (TENANT_SCOPE_COLUMNS). At the root this
    // statement cannot even compile; the audit still refuses it so the same
    // rule holds where it matters — inside a subquery, where PostgreSQL
    // resolves the missing column to the OUTER row and restricts nothing.
    expect(
      auditSqlText('src/example.ts', 'SELECT * FROM reviews WHERE account_id = ${accountId}'),
    ).toEqual(finding('src/example.ts', 'reviews'));
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

  it('rejects tenant equality hidden inside a larger boolean expression', () => {
    for (const predicate of [
      '(r.business_id = ${businessId}) = false',
      '(r.business_id = ${businessId}) IS FALSE',
      'CASE WHEN r.business_id = ${businessId} THEN true ELSE true END',
    ]) {
      expect(
        auditSqlText('src/example.ts', `SELECT * FROM reviews r WHERE ${predicate}`),
      ).toEqual(finding('src/example.ts', 'reviews'));
    }

    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT * FROM reviews r WHERE ((r.business_id = ${businessId}))',
      ),
    ).toEqual([]);
  });

  it('fails closed when a safe tenant conjunct precedes a same-level OR', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT * FROM reviews r WHERE r.account_id = ${accountId} AND r.id IS NOT NULL OR true',
      ),
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

  it('keeps an unrelated outer table unscoped while proving the child block independently', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT * FROM reviews WHERE EXISTS (SELECT 1 FROM businesses WHERE account_id = ${accountId})',
      ),
    // The child's own account_id predicate scopes businesses. It cannot lend
    // that proof to the unrelated outer reviews occurrence, which must fail.
    ).toEqual(finding('src/example.ts', 'reviews'));
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

  it('passes a directly scoped tenant table inside NOT EXISTS', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT a.id
          FROM solicitation_asks a
          WHERE a.account_id = \${accountId}
            AND NOT EXISTS (
              SELECT 1
              FROM solicitation_outreach o
              WHERE o.account_id = \${accountId}
                AND o.ask_id = a.id
            )
        `,
      ),
    ).toEqual([]);
  });

  it('passes a directly scoped tenant table inside a scalar subquery', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT (
            SELECT COUNT(*) FROM solicitation_outreach o
            WHERE o.business_id = \${businessId}
          ) AS rendered
        `,
      ),
    ).toEqual([]);
  });

  it('passes directly scoped tenant tables inside separate CTE bodies', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          WITH first AS (
            SELECT id FROM reviews WHERE business_id = \${businessId}
          ), second AS (
            SELECT id FROM responses WHERE business_id = \${businessId}
          )
          SELECT * FROM first CROSS JOIN second
        `,
      ),
    ).toEqual([]);
  });

  it('audits separate CTE bodies independently', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          WITH scoped AS (
            SELECT id FROM reviews WHERE business_id = \${businessId}
          ), unscoped AS (
            SELECT id FROM reviews
          )
          SELECT * FROM scoped CROSS JOIN unscoped
        `,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('uses ordered PostgreSQL CTE visibility and grants self-visibility only to recursive CTEs', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `WITH reviews AS (SELECT * FROM reviews)
         SELECT * FROM reviews`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));

    expect(
      auditSqlText(
        'src/example.ts',
        `WITH first AS (SELECT * FROM reviews),
              reviews AS (SELECT 1 AS id)
         SELECT * FROM first`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));

    expect(
      auditSqlText(
        'src/example.ts',
        `WITH reviews AS (SELECT 1 AS id),
              later AS (SELECT * FROM reviews)
         SELECT * FROM later`,
      ),
    ).toEqual([]);

    expect(
      auditSqlText(
        'src/example.ts',
        `WITH reviews AS (SELECT 1 AS id)
         SELECT * FROM reviews
         UNION ALL
         SELECT * FROM reviews`,
      ),
    ).toEqual([]);

    expect(
      auditSqlText(
        'src/example.ts',
        `WITH RECURSIVE reviews AS (
           SELECT 1 AS id
           UNION ALL
           SELECT id + 1 FROM reviews WHERE id < 2
         )
         SELECT * FROM reviews`,
      ),
    ).toEqual([]);

    expect(
      auditSqlText(
        'src/example.ts',
        `WITH candidates AS (
           SELECT r.id FROM reviews r WHERE r.business_id = b.id
         )
         SELECT b.id FROM businesses b
         WHERE b.account_id = \${accountId}`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('passes a child correlated by business_id to a proven-scoped outer alias', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT b.id
          FROM businesses b
          WHERE b.account_id = \${accountId}
            AND EXISTS (
              SELECT 1 FROM reviews r WHERE r.business_id = b.id
            )
        `,
      ),
    ).toEqual([]);
  });

  it('fails a nested tenant table correlated only by a non-tenant row id', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT b.id
          FROM businesses b
          WHERE b.account_id = \${accountId}
            AND EXISTS (
              SELECT 1 FROM reviews r WHERE r.id = b.id
            )
        `,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails an unscoped nested occurrence when the same table is scoped in the outer query', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT r.id
          FROM reviews r
          WHERE r.business_id = \${businessId}
            AND EXISTS (SELECT 1 FROM reviews nested WHERE nested.id = r.id)
        `,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails an unscoped CTE occurrence when the same table is scoped outside the CTE', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT r.id
          FROM reviews r
          WHERE r.business_id = \${businessId}
            AND EXISTS (
              WITH candidates AS (SELECT id FROM reviews)
              SELECT 1 FROM candidates
            )
        `,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails an unscoped second alias of the same tenant table in one query block', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT r1.id
          FROM reviews r1
          JOIN reviews r2 ON r2.id = r1.id
          WHERE r1.business_id = \${businessId}
        `,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('audits comma-separated bindings as separate occurrences', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r1.id
         FROM reviews r1, reviews r2
         WHERE r1.business_id = \${businessId}`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('recursively audits physical bindings in parenthesized joined-table groups', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT * FROM (reviews r CROSS JOIN businesses b)',
      ),
    ).toEqual([
      ...finding('src/example.ts', 'businesses'),
      ...finding('src/example.ts', 'reviews'),
    ]);

    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT a.id FROM accounts a
         LEFT JOIN ((reviews r CROSS JOIN businesses b)) grouped ON true
         WHERE a.id = \${accountId}`,
      ),
    ).toEqual([
      ...finding('src/example.ts', 'businesses'),
      ...finding('src/example.ts', 'reviews'),
    ]);

    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT * FROM (reviews r
         LEFT JOIN businesses b
           ON b.id = r.business_id AND b.account_id = \${accountId})`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));

    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r.id FROM reviews r
         LEFT JOIN (businesses b CROSS JOIN owner_leads lead)
           ON b.id = r.business_id AND b.account_id = \${accountId}`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails a child alias that shadows a scoped ancestor alias', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT r.id
          FROM reviews r
          WHERE r.business_id = \${businessId}
            AND EXISTS (SELECT 1 FROM reviews r WHERE r.id IS NOT NULL)
        `,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('does not let a subquery prove itself on a scope column its table lacks', () => {
    // Every child below compiles: PostgreSQL resolves the unqualified column
    // outward to the proven ancestor's row, so the child scans its whole table.
    // The old flattened scanner flagged each of these; the block analyzer must
    // not accept them as scoped just because a scope-shaped predicate exists.
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT b.id FROM businesses b
         WHERE b.account_id = \${accountId}
           AND EXISTS (SELECT 1 FROM reviews WHERE account_id = \${accountId})`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));

    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT b.id, (SELECT COUNT(*) FROM responses WHERE account_id = \${accountId}) AS n
         FROM businesses b
         WHERE b.account_id = \${accountId}`,
      ),
    ).toEqual(finding('src/example.ts', 'responses'));

    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r.id FROM reviews r
         WHERE r.business_id = \${businessId}
           AND EXISTS (SELECT 1 FROM auto_approval_policies WHERE business_id = \${businessId})`,
      ),
    ).toEqual(finding('src/example.ts', 'auto_approval_policies'));

    // The same shapes on a column the child table DOES carry stay proven.
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT b.id FROM businesses b
         WHERE b.account_id = \${accountId}
           AND EXISTS (SELECT 1 FROM reviews WHERE business_id = b.id)`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT b.id FROM businesses b
         WHERE b.account_id = \${accountId}
           AND EXISTS (SELECT 1 FROM reviews WHERE business_id = \${businessId})`,
      ),
    ).toEqual([]);
  });

  it('does not let a grandchild inherit an ancestor alias that an intermediate block shadows', () => {
    // `r` in the innermost block names the intermediate relation, never the
    // proven root `reviews r`. Three shadowing relation kinds: a non-tenant
    // table, a derived table, and a table function with a column-alias list.
    const intermediates = [
      'job_outbox r',
      '(SELECT gen_random_uuid() AS business_id) r',
      'unnest(\${ids}::uuid[]) WITH ORDINALITY AS r(business_id, ord)',
    ];
    for (const intermediate of intermediates) {
      expect(
        auditSqlText(
          'src/example.ts',
          `SELECT r.id FROM reviews r
           WHERE r.business_id = \${businessId}
             AND EXISTS (
               SELECT 1 FROM ${intermediate}
               WHERE EXISTS (SELECT 1 FROM responses p WHERE p.business_id = r.business_id)
             )`,
        ),
      ).toEqual(finding('src/example.ts', 'responses'));
    }

    // Control: an intermediate block that binds a DIFFERENT alias leaves the
    // root alias visible, and the grandchild's correlation stays proven.
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r.id FROM reviews r
         WHERE r.business_id = \${businessId}
           AND EXISTS (
             SELECT 1 FROM job_outbox j
             WHERE EXISTS (SELECT 1 FROM responses p WHERE p.business_id = r.business_id)
           )`,
      ),
    ).toEqual([]);
  });

  it('lets every local relation kind shadow a proven ancestor alias', () => {
    const childBodies = [
      `SELECT 1 FROM reviews r
       JOIN owner_leads b ON true
       WHERE r.business_id = b.id`,
      `WITH local_rows AS (SELECT 1 AS id)
       SELECT 1 FROM reviews r
       JOIN local_rows b ON true
       WHERE r.business_id = b.id`,
      `SELECT 1 FROM reviews r
       JOIN (SELECT 1 AS id) b ON true
       WHERE r.business_id = b.id`,
      `SELECT 1 FROM reviews r
       JOIN LATERAL (SELECT 1 AS id) b ON true
       WHERE r.business_id = b.id`,
    ];

    for (const childBody of childBodies) {
      expect(
        auditSqlText(
          'src/example.ts',
          `SELECT b.id FROM businesses b
           WHERE b.account_id = \${accountId}
             AND EXISTS (${childBody})`,
        ),
      ).toEqual(finding('src/example.ts', 'reviews'));
    }
  });

  it('uses the real alias after table-function WITH ORDINALITY modifiers', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT b.id FROM businesses b
         WHERE b.account_id = \${accountId}
           AND EXISTS (
             SELECT 1 FROM reviews r
             CROSS JOIN unnest(\${ids}::uuid[]) WITH ORDINALITY AS b(id, ord)
             WHERE r.business_id = b.id
           )`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));

    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT b.id FROM businesses b
         WHERE b.account_id = \${accountId}
           AND EXISTS (
             SELECT 1 FROM reviews r
             CROSS JOIN unnest(\${ids}::uuid[]) WITH ORDINALITY AS vals(id, ord)
             WHERE r.business_id = b.id
           )`,
      ),
    ).toEqual([]);
  });

  it('folds unquoted aliases but preserves quoted identifier case', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT mixed.id FROM reviews MiXeD WHERE mixed.business_id = ${businessId}',
      ),
    ).toEqual([]);

    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT "CaseAlias".id FROM reviews "CaseAlias" WHERE "casealias".business_id = ${businessId}',
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('treats quoted structural words as identifiers rather than clauses', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT "on".id FROM reviews AS "on" WHERE "on".business_id = ${businessId}',
      ),
    ).toEqual([]);
  });

  it('does not combine scope and relationship evidence from sibling subqueries', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT r.id FROM reviews r
          WHERE EXISTS (SELECT 1 FROM businesses b WHERE b.account_id = \${accountId})
            AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = r.business_id)
        `,
      ),
    ).toEqual([
      ...finding('src/example.ts', 'businesses'),
      ...finding('src/example.ts', 'reviews'),
    ]);
  });

  it('fails a nested tenant predicate broadened by OR', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT 1 WHERE EXISTS (
          SELECT 1 FROM reviews r
          WHERE r.business_id = \${businessId} OR r.id IS NOT NULL
        )`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('fails a negated nested tenant predicate', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT 1 WHERE EXISTS (
          SELECT 1 FROM reviews r
          WHERE NOT (r.business_id = \${businessId})
        )`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('audits every set-operation arm inside a subquery', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT 1 WHERE EXISTS (
          SELECT id FROM reviews WHERE business_id = \${businessId}
          UNION ALL
          SELECT id FROM reviews
        )`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('does not accept tenant-looking scope text inside single-quoted E-strings or dollar-quoted strings', () => {
    for (const literal of [
      "'business_id = ${businessId}'",
      "E'business_id = ${businessId} and \\\\''",
      '$$ business_id = ${businessId} $$',
      '$copy$ business_id = ${businessId} $copy$',
    ]) {
      expect(
        auditSqlText('src/example.ts', `SELECT * FROM reviews WHERE note = ${literal}`),
      ).toEqual(finding('src/example.ts', 'reviews'));
    }
  });

  it('does not report table-looking text inside single-quoted E-strings or dollar-quoted strings', () => {
    for (const literal of [
      "'SELECT * FROM reviews'",
      "E'SELECT * FROM reviews \\\\''",
      '$$ SELECT * FROM reviews $$',
      '$copy$ SELECT * FROM reviews $copy$',
    ]) {
      expect(auditSqlText('src/example.ts', `SELECT ${literal}`)).toEqual([]);
    }
  });

  it('does not parse nested block comments or line comments as query blocks', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT * FROM reviews
         /* outer business_id = \${businessId}
            /* nested account_id = \${accountId} */
         */
         -- business_id = \${businessId}
         WHERE id IS NOT NULL`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
    expect(
      auditSqlText('src/example.ts', 'SELECT 1 /* SELECT * FROM reviews /* nested */ */'),
    ).toEqual([]);
  });

  it('audits a scalar subquery nested inside ordinary function parentheses', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        'SELECT COALESCE((SELECT COUNT(*) FROM reviews), 0)',
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('keeps nested-query offsets stable after astral and multi-codepoint SQL text', () => {
    for (const marker of ['😀', '👨‍👩‍👧‍👦']) {
      expect(
        auditSqlText(
          'src/example.ts',
          `SELECT '${marker}' AS marker, (SELECT * FROM reviews)`,
        ),
      ).toEqual(finding('src/example.ts', 'reviews'));
    }
  });

  it('passes a LATERAL child explicitly correlated by tenant identity', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT b.id FROM businesses b
          JOIN LATERAL (
            SELECT r.id FROM reviews r WHERE r.business_id = b.id
          ) picked ON true
          WHERE b.account_id = \${accountId}
        `,
      ),
    ).toEqual([]);
  });

  it('fails a LATERAL child correlated only by a non-tenant row id', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `
          SELECT b.id FROM businesses b
          JOIN LATERAL (
            SELECT r.id FROM reviews r WHERE r.id = b.id
          ) picked ON true
          WHERE b.account_id = \${accountId}
        `,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('audits scoped and unscoped data-modifying CTE bodies', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `WITH changed AS (
          UPDATE reviews SET updated_at = NOW()
          WHERE business_id = \${businessId}
          RETURNING id
        ) SELECT * FROM changed`,
      ),
    ).toEqual([]);
    expect(
      auditSqlText(
        'src/example.ts',
        `WITH removed AS (
          DELETE FROM reviews RETURNING id
        ) SELECT * FROM removed`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('does not treat a CTE name shadowing a tenant table as a physical table reference', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `WITH reviews AS (SELECT 1 AS id)
         SELECT * FROM reviews`,
      ),
    ).toEqual([]);
  });

  it('does not let a CTE name shadow an explicitly schema-qualified physical table', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `WITH reviews AS (SELECT 1 AS id)
         SELECT * FROM public.reviews`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('reports a deterministic duplicate-template statement arm block and binding identity for every unscoped occurrence', () => {
    const findings = auditSqlText(
      'src/example.ts',
      `SELECT * FROM reviews r1 JOIN reviews r2 ON r2.id = r1.id;
       SELECT 1 WHERE EXISTS (SELECT * FROM reviews)`,
    );

    expect(findings).toHaveLength(3);
    expect(findings.map((item) => item.sqlIdentity)).toEqual([
      expect.stringContaining('statement:1:arm:1:block:root:table:reviews:alias:r1:binding:1'),
      expect.stringContaining('statement:1:arm:1:block:root:table:reviews:alias:r2:binding:2'),
      expect.stringContaining('statement:2:arm:1.1:block:root.1:table:reviews:alias:reviews:binding:1'),
    ]);
    expect(new Set(findings.map((item) => item.sqlIdentity)).size).toBe(3);
  });

  it('keeps descendant identities unique across outer set-operation arms', () => {
    const findings = auditSqlText(
      'src/example.ts',
      `SELECT 1 WHERE EXISTS (SELECT * FROM reviews)
       UNION ALL
       SELECT 1 WHERE EXISTS (SELECT * FROM reviews)`,
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((item) => item.sqlIdentity)).toEqual([
      expect.stringContaining(':arm:1.1:block:root.1:'),
      expect.stringContaining(':arm:2.1:block:root.1:'),
    ]);
    expect(new Set(findings.map((item) => item.sqlIdentity)).size).toBe(2);
  });

  it('assigns byte-identical occurrences through source extraction order', () => {
    const findings = auditSourceText(
      'src/example.ts',
      `await sql\`SELECT * FROM reviews\`;
       await tx\`SELECT * FROM reviews\`;`,
    );

    expect(findings).toHaveLength(2);
    expect(findings[0]?.sqlIdentity).toContain(':occurrence:1:');
    expect(findings[1]?.sqlIdentity).toContain(':occurrence:2:');
    expect(findings[0]?.sqlIdentity).not.toBe(findings[1]?.sqlIdentity);
  });

  it('merges unsafe and tagged templates in source order before assigning occurrences', () => {
    const sourceText = `
      const query = \`SELECT * FROM reviews\`;
      await sql.unsafe(query, []);
      await tx\`SELECT * FROM reviews\`;
    `;

    expect(extractSqlTemplates(sourceText).map((template) => template.tag)).toEqual([
      'sql.unsafe',
      'tx',
    ]);
    const findings = auditSourceText('src/example.ts', sourceText);
    expect(findings.map((item) => item.sqlIdentity)).toEqual([
      expect.stringContaining(':occurrence:1:'),
      expect.stringContaining(':occurrence:2:'),
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

  it('rejects tenant relationships hidden inside a larger boolean expression', () => {
    for (const relationship of [
      '(b.id = r.business_id) = false',
      '(b.id = r.business_id) IS FALSE',
      'CASE WHEN b.id = r.business_id THEN true ELSE true END',
    ]) {
      expect(
        auditSqlText(
          'src/example.ts',
          `SELECT r.* FROM reviews r
           JOIN businesses b ON ${relationship}
           WHERE b.account_id = \${accountId}`,
        ),
      ).toEqual(finding('src/example.ts', 'reviews'));
    }

    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r.* FROM reviews r
         JOIN businesses b ON ((b.id = r.business_id))
         WHERE b.account_id = \${accountId}`,
      ),
    ).toEqual([]);
  });

  it('fails closed when a safe relationship conjunct precedes a same-level OR', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r.* FROM reviews r
         JOIN businesses b
           ON b.id = r.business_id AND r.id IS NOT NULL OR true
         WHERE b.account_id = \${accountId}`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));
  });

  it('does not launder tenant proof through outer JOIN ON predicates', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r.* FROM reviews r
         LEFT JOIN businesses b
           ON b.id = r.business_id AND b.account_id = \${accountId}`,
      ),
    ).toEqual(finding('src/example.ts', 'reviews'));

    for (const joinType of ['RIGHT JOIN', 'FULL JOIN']) {
      expect(
        auditSqlText(
          'src/example.ts',
          `SELECT r.* FROM reviews r
           ${joinType} businesses b
             ON b.id = r.business_id AND b.account_id = \${accountId}`,
        ),
      ).toEqual([
        ...finding('src/example.ts', 'businesses'),
        ...finding('src/example.ts', 'reviews'),
      ]);
    }
  });

  it('propagates outer-join proof only from the preserved side to the nullable side', () => {
    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r.* FROM businesses b
         LEFT JOIN reviews r ON r.business_id = b.id
         WHERE b.account_id = \${accountId}`,
      ),
    ).toEqual([]);

    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r.* FROM reviews r
         RIGHT JOIN businesses b ON r.business_id = b.id
         WHERE b.account_id = \${accountId}`,
      ),
    ).toEqual([]);

    expect(
      auditSqlText(
        'src/example.ts',
        `SELECT r.* FROM reviews r
         FULL JOIN businesses b ON r.business_id = b.id
         WHERE b.account_id = \${accountId}`,
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

  it('audits PostgreSQL TABLE query expressions at root and child depth', () => {
    expect(auditSqlText('src/example.ts', 'TABLE reviews')).toEqual(
      finding('src/example.ts', 'reviews'),
    );
    expect(auditSqlText('src/example.ts', 'SELECT * FROM (TABLE reviews) r')).toEqual(
      finding('src/example.ts', 'reviews'),
    );
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

  it('can audit an exact allowlisted statement without applying the exception', () => {
    const sqlText = `
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
    `;
    expect(
      auditSqlText(
        'worker/background/pollers/ArchivalPoller.ts',
        sqlText,
        undefined,
        { applyAllowlist: false },
      ),
    ).toEqual([
      ...finding('worker/background/pollers/ArchivalPoller.ts', 'notification_deliveries'),
      ...finding('worker/background/pollers/ArchivalPoller.ts', 'notification_deliveries'),
    ]);
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

  it('extracts a nested TAGGED fragment but not a plain literal nested in a placeholder', () => {
    // `${\`key:${id}\`}` is a bind parameter at runtime, not SQL. The enclosing
    // template's text and `${` are masked to whitespace, so without the
    // expression boundary the inner literal would walk back to the OUTER tag.
    expect(extractSqlTemplates(`
      await tx\`SELECT pg_advisory_xact_lock(hashtextextended(\${\`mobile_enroll:\${accountId}\`}, 0))\`;
      await sql\`SELECT id FROM reviews r WHERE r.business_id = \${businessId} \${forUpdate ? sql\`FOR UPDATE\` : sql\`\`}\`;
    `)).toEqual([
      { tag: 'tx', sqlText: 'SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))' },
      { tag: 'sql', sqlText: 'SELECT id FROM reviews r WHERE r.business_id = ${businessId} ${forUpdate ? sql`FOR UPDATE` : sql``}' },
      { tag: 'sql', sqlText: 'FOR UPDATE' },
      { tag: 'sql', sqlText: '' },
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

  it('resolves sql.unsafe query variables from the nearest active lexical scope', () => {
    const sourceText = `
      const query = \`SELECT * FROM reviews\`;
      {
        const query = \`SELECT 1\`;
      }
      await sql.unsafe(query, []);
    `;

    expect(extractSqlTemplates(sourceText)).toEqual([
      { tag: 'sql.unsafe', sqlText: 'SELECT * FROM reviews' },
    ]);
    expect(auditSourceText('src/example.ts', sourceText)).toEqual(
      finding('src/example.ts', 'reviews'),
    );

    expect(extractSqlTemplates(`
      const query = \`SELECT * FROM reviews\`;
      {
        const query = \`SELECT 1\`;
        await sql.unsafe(query, []);
      }
    `)).toEqual([
      { tag: 'sql.unsafe', sqlText: 'SELECT 1' },
    ]);
  });

  it('resolves var query declarations at function or module scope rather than block scope', () => {
    const blockDeclared = `
      { var query = \`SELECT * FROM reviews\`; }
      await sql.unsafe(query, []);
    `;
    expect(extractSqlTemplates(blockDeclared)).toEqual([
      { tag: 'sql.unsafe', sqlText: 'SELECT * FROM reviews' },
    ]);
    expect(auditSourceText('src/example.ts', blockDeclared)).toEqual(
      finding('src/example.ts', 'reviews'),
    );

    const reassignedInBlock = `
      var query = \`SELECT 1\`;
      { var query = \`SELECT * FROM reviews\`; }
      await sql.unsafe(query, []);
    `;
    expect(extractSqlTemplates(reassignedInBlock)).toEqual([
      { tag: 'sql.unsafe', sqlText: 'SELECT 1' },
      { tag: 'sql.unsafe', sqlText: 'SELECT * FROM reviews' },
    ]);
    expect(auditSourceText('src/example.ts', reassignedInBlock)).toEqual(
      finding('src/example.ts', 'reviews'),
    );

    const nestedFunction = `
      var query = \`SELECT 1\`;
      function hidden(): void {
        var query = \`SELECT * FROM reviews\`;
        void query;
      }
      await sql.unsafe(query, []);
    `;
    expect(extractSqlTemplates(nestedFunction)).toEqual([
      { tag: 'sql.unsafe', sqlText: 'SELECT 1' },
    ]);

    const conditionalInitializer = `
      var query = \`SELECT * FROM reviews\`;
      if (false) {
        var query = \`SELECT * FROM reviews WHERE business_id = \${businessId}\`;
      }
      await sql.unsafe(query, []);
    `;
    expect(extractSqlTemplates(conditionalInitializer)).toEqual([
      { tag: 'sql.unsafe', sqlText: 'SELECT * FROM reviews' },
      {
        tag: 'sql.unsafe',
        sqlText: 'SELECT * FROM reviews WHERE business_id = ${businessId}',
      },
    ]);
    expect(auditSourceText('src/example.ts', conditionalInitializer)).toEqual(
      finding('src/example.ts', 'reviews'),
    );

    for (const functionExpression of [
      'function* ()',
      'async function* ()',
    ]) {
      const generator = `
        var query = \`SELECT * FROM reviews\`;
        const hidden = ${functionExpression} {
          var query = \`SELECT 1\`;
          void query;
        };
        void hidden;
        await sql.unsafe(query, []);
      `;
      expect(extractSqlTemplates(generator)).toEqual([
        { tag: 'sql.unsafe', sqlText: 'SELECT * FROM reviews' },
      ]);
    }

    const staticBlock = `
      var query = \`SELECT * FROM reviews\`;
      class Hidden {
        static {
          var query = \`SELECT 1\`;
          void query;
        }
      }
      void Hidden;
      await sql.unsafe(query, []);
    `;
    expect(extractSqlTemplates(staticBlock)).toEqual([
      { tag: 'sql.unsafe', sqlText: 'SELECT * FROM reviews' },
    ]);
  });

  it('masks JavaScript regex literals without poisoning query scope or declarations', () => {
    const braceRegexes = `
      const openBrace = /\\{/;
      const query = \`SELECT * FROM reviews\`;
      const closeBrace = /\\}/;
      await sql.unsafe(query, []);
    `;
    expect(auditSourceText('src/example.ts', braceRegexes)).toEqual(
      finding('src/example.ts', 'reviews'),
    );

    const controlHeaderRegexes = `
      if (enabled) /[{]/.test(input);
      const query = \`SELECT * FROM reviews\`;
      if (enabled) /[}]/.test(input);
      await sql.unsafe(query, []);
    `;
    expect(auditSourceText('src/example.ts', controlHeaderRegexes)).toEqual(
      finding('src/example.ts', 'reviews'),
    );

    const fakeDeclaration = `
      const query = \`SELECT * FROM reviews\`;
      const matcher = /const query = "SELECT 1"/;
      await sql.unsafe(query, []);
    `;
    expect(extractSqlTemplates(fakeDeclaration)).toEqual([
      { tag: 'sql.unsafe', sqlText: 'SELECT * FROM reviews' },
    ]);

    const divisionAndSqlRegexText = `
      const ratio = total / count;
      const query = \`SELECT * FROM reviews
        WHERE business_id = \${businessId} AND text ~ '/\\{/'\`;
      await sql.unsafe(query, [businessId]);
    `;
    expect(extractSqlTemplates(divisionAndSqlRegexText)).toEqual([
      {
        tag: 'sql.unsafe',
        sqlText: "SELECT * FROM reviews\n        WHERE business_id = ${businessId} AND text ~ '/{/'",
      },
    ]);
    expect(auditSourceText('src/example.ts', divisionAndSqlRegexText)).toEqual([]);
  });

  it('treats every expression-ending token before slash as division', () => {
    for (const expression of [
      'identifier',
      '"literal"',
      '42',
      'true',
      '`literal`',
      '/value/',
      'call()',
      'items[0]',
      'i++',
      'i--',
      'value!',
    ]) {
      const sourceText = `${expression} / total; await sql\`SELECT * FROM reviews\`; n / divisor;`;
      expect(extractSqlTemplates(sourceText)).toEqual([
        { tag: 'sql', sqlText: 'SELECT * FROM reviews' },
      ]);
      expect(auditSourceText('src/example.ts', sourceText)).toEqual(
        finding('src/example.ts', 'reviews'),
      );
    }
  });

  it('uses one regex-aware JavaScript scan for nested tags, comments, strings, and placeholders', () => {
    const nestedTags = [
      'const ignored = "sql`SELECT * FROM responses`";',
      '// sql`SELECT * FROM accounts`',
      'const matcher = /sql`SELECT * FROM businesses`/;',
      'await sql`SELECT EXISTS (${sql`SELECT * FROM reviews`})`;',
    ].join('\n');
    expect(extractSqlTemplates(nestedTags)).toEqual([
      {
        tag: 'sql',
        sqlText: 'SELECT EXISTS (${sql`SELECT * FROM reviews`})',
      },
      { tag: 'sql', sqlText: 'SELECT * FROM reviews' },
    ]);
    expect(auditSourceText('src/example.ts', nestedTags)).toEqual(
      finding('src/example.ts', 'reviews'),
    );

    const regexThenUrl = 'const re=/"/; const url="https://example.com"; await sql`SELECT * FROM reviews`;';
    expect(extractSqlTemplates(regexThenUrl)).toEqual([
      { tag: 'sql', sqlText: 'SELECT * FROM reviews' },
    ]);
    expect(auditSourceText('src/example.ts', regexThenUrl)).toEqual(
      finding('src/example.ts', 'reviews'),
    );

    const unicodePrefix = 'const message = "✅ done"; await sql`SELECT * FROM reviews`;';
    expect(extractSqlTemplates(unicodePrefix)).toEqual([
      { tag: 'sql', sqlText: 'SELECT * FROM reviews' },
    ]);

    const regexPlaceholder = 'await sql`SELECT ${/}/.test(input) ? `x` : `y`} FROM reviews`;';
    expect(extractSqlTemplates(regexPlaceholder)).toEqual([
      {
        tag: 'sql',
        sqlText: 'SELECT ${/}/.test(input) ? `x` : `y`} FROM reviews',
      },
    ]);
    expect(auditSourceText('src/example.ts', regexPlaceholder)).toEqual(
      finding('src/example.ts', 'reviews'),
    );
  });

  it('audits cooked JavaScript escapes in tagged and unsafe SQL literals', () => {
    const taggedSources = [
      'await sql`SELECT * FROM rev\\u0069ews`;',
      'await sql`SELECT * FROM \\x72eviews`;',
      ['await sql`SELECT * FROM rev\\', 'iews`;'].join('\n'),
    ];
    const unsafeSources = [
      'await sql.unsafe("SELECT * FROM rev\\u0069ews", []);',
      'const query = "SELECT * FROM \\x72eviews"; await sql.unsafe(query, []);',
      ['const query = `SELECT * FROM rev\\', 'iews`; await sql.unsafe(query, []);'].join('\n'),
    ];

    for (const sourceText of [...taggedSources, ...unsafeSources]) {
      expect(extractSqlTemplates(sourceText)).toEqual([
        expect.objectContaining({ sqlText: 'SELECT * FROM reviews' }),
      ]);
      expect(auditSourceText('src/example.ts', sourceText)).toEqual(
        finding('src/example.ts', 'reviews'),
      );
    }
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

  it('balances nested-brace placeholders with quoted closing braces during SQL template extraction', () => {
    expect(extractSqlTemplates(`
      await sql\`SELECT * FROM reviews
        WHERE business_id = \${choose({ nested: { value: businessId }, close: "}" })}\`;
    `)).toEqual([
      {
        tag: 'sql',
        sqlText: 'SELECT * FROM reviews\n        WHERE business_id = ${choose({ nested: { value: businessId }, close: "}" })}',
      },
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
