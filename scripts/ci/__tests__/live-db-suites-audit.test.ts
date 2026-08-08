import { describe, expect, it } from 'vitest';
import { auditLiveDbSuite, listTestFiles } from '../live-db-suites-audit';

const LIVE_DB = 'const url = process.env.TEST_DATABASE_POOL_URL;';
const APPLIES_DDL = `
  await db.unsafe(readFileSync(resolve(process.cwd(), 'supabase/migrations/088_x.sql'), 'utf-8'));
`;

describe('live-db-suites-audit', () => {
  // #694. R2 keyed on an INCIDENTAL marker — the file happening to name
  // `supabase/migrations` alongside a `.unsafe(` — rather than on DDL. Three
  // suites executed DDL without naming that path and passed clean; one of them
  // stranded a temporary CHECK constraint on the shared test container and cost
  // 14 spurious failures across three unrelated suites. The fixtures below are
  // the shapes the marker cannot see.

  /** A plain tagged template — no `.unsafe(`, no `supabase/migrations` anywhere. */
  const PLAIN_TEMPLATE_DDL = "await db`ALTER TABLE job_outbox ADD COLUMN IF NOT EXISTS x TEXT`;\n";
  /** `.unsafe()` on a call-form receiver — the 770-use `sql()` shape. */
  const CALL_FORM_UNSAFE_DDL = "await sql().unsafe('ALTER TABLE job_outbox DROP CONSTRAINT c');\n";
  /** A non-null-asserted tag — the 73-use `db!` shape. */
  const NON_NULL_TAG_DDL = "await db!`CREATE INDEX idx_x ON job_outbox (topic)`;\n";
  /** `.unsafe()` whose argument cannot be read statically. */
  const OPAQUE_UNSAFE = 'await db.unsafe(readMigrationSql());\n';

  it('passes a live-DB suite that is named correctly and applies no DDL', () => {
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', LIVE_DB)).toEqual([]);
  });

  it('still ignores a file that never reaches the live test DB', () => {
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.test.ts', 'const a = 1;')).toEqual([]);
  });

  it('flags a live-DB suite outside the serialized *.integration.test.ts glob', () => {
    const findings = auditLiveDbSuite('worker/jobs/y/__tests__/integration-y.test.ts', LIVE_DB);
    expect(findings.map((finding) => finding.rule)).toEqual(['naming']);
  });

  it('still flags run-time migration DDL in a suite that is on no allowlist', () => {
    const findings = auditLiveDbSuite(
      'src/lib/x/__tests__/x.integration.test.ts',
      LIVE_DB + APPLIES_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  it('reports naming and runtime-ddl together for the #573 offender shape', () => {
    const findings = auditLiveDbSuite(
      'worker/jobs/account-offboarding/__tests__/integration-lifecycle.test.ts',
      LIVE_DB + APPLIES_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['naming', 'runtime-ddl']);
  });

  it('allows an allowlisted migration-shape suite that holds the cross-process lock', () => {
    const findings = auditLiveDbSuite(
      'src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts',
      LIVE_DB + APPLIES_DDL + 'await acquireLiveDbLock(url);',
    );
    expect(findings).toEqual([]);
  });

  it('flags an allowlisted migration-shape suite that applies DDL unlocked', () => {
    const findings = auditLiveDbSuite(
      'src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts',
      LIVE_DB + APPLIES_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['unlocked-ddl']);
  });

  it('still accepts 074 on its own dedicated apply lock rather than the shared one', () => {
    const file = 'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts';
    expect(auditLiveDbSuite(file, LIVE_DB + APPLIES_DDL + 'withMigration074ApplyLock(db, fn);')).toEqual(
      [],
    );
    expect(
      auditLiveDbSuite(file, LIVE_DB + APPLIES_DDL).map((finding) => finding.rule),
    ).toEqual(['unlocked-ddl']);
  });

  it('does not treat the describe-with-db helper test as a live-DB suite', () => {
    expect(auditLiveDbSuite('src/__tests__/helpers/describe-with-db.test.ts', LIVE_DB)).toEqual([]);
  });

  // REACH. The three executed-DDL shapes the `supabase/migrations` + `.unsafe(`
  // conjunction is blind to. Each of these is a real shape in this repo.
  it('flags DDL executed through a plain tagged template in a file containing no .unsafe( at all', () => {
    const source = LIVE_DB + PLAIN_TEMPLATE_DDL;
    expect(source).not.toContain('.unsafe(');
    expect(source).not.toContain('supabase/migrations');
    const findings = auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source);
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  it('flags DDL executed through .unsafe() on a call-form receiver such as sql()', () => {
    const findings = auditLiveDbSuite(
      'src/lib/x/__tests__/x.integration.test.ts',
      LIVE_DB + CALL_FORM_UNSAFE_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  it('flags DDL executed through a tagged template whose tag is a non-null assertion such as db!', () => {
    const findings = auditLiveDbSuite(
      'src/lib/x/__tests__/x.integration.test.ts',
      LIVE_DB + NON_NULL_TAG_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  // PRECISION. Reach without precision is a broken gate: every fixture below is
  // lifted from a REAL suite that must stay clean. A detector that greps for DDL
  // verbs fails all four — the distinction is EXECUTED SQL versus SQL a suite
  // merely asserts about, quotes, or holds in a constant.

  // migration-102-import-consent-analytics-events.integration.test.ts:56
  it('ignores a DDL verb that appears only inside a regex literal', () => {
    const source =
      LIVE_DB +
      'expect(sql).toMatch(/ALTER TABLE analytics_events\\s+DROP CONSTRAINT x/i);\n';
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // migration-096-solicitation-suppressions.integration.test.ts:610
  it('ignores a DDL verb that appears only inside an expect().toContain() assertion', () => {
    const source = LIVE_DB + "expect(globalIndex).toContain('CREATE UNIQUE INDEX');\n";
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // migration-079-agent-run-spine-archival.integration.test.ts:6
  it('ignores a DDL verb that appears only inside a comment', () => {
    const source = LIVE_DB + '// Migration 079 adds two CREATE INDEX CONCURRENTLY scan indexes.\n';
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // migration-076-judge-verdicts-governor.integration.test.ts:115-142
  it('ignores a DDL verb that appears only in a string constant that is never executed', () => {
    const source =
      LIVE_DB +
      "const EXPECTED = ['CREATE TABLE IF NOT EXISTS judge_verdicts (', 'ALTER TABLE judge_verdicts ENABLE ROW LEVEL SECURITY;'];\n";
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // FAIL CLOSED. When the argument to `.unsafe()` cannot be read statically the
  // audit cannot prove the SQL is harmless, and "cannot prove" must resolve to
  // flagged — the pragma is the reviewed way out, not a silent pass.
  it('treats .unsafe() with a non-literal argument as applied DDL rather than as safe', () => {
    const source = LIVE_DB + OPAQUE_UNSAFE;
    expect(source).not.toContain('supabase/migrations');
    const findings = auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source);
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  // PRAGMA. `live-db-ddl-ignore` follows `outbox-seam-ignore` (#568) and must
  // match lineHasPragma's semantics exactly — see scripts/ci/lib/sql-tag-scan.ts.
  it('exempts a DDL line carrying a trailing live-db-ddl-ignore pragma', () => {
    const source =
      LIVE_DB +
      "await tx`CREATE UNIQUE INDEX i ON job_outbox (topic)`; // live-db-ddl-ignore: temp table\n";
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  it('exempts a DDL line whose immediately preceding comment-only line carries the pragma', () => {
    const source =
      LIVE_DB +
      'await tx`\n' +
      '  -- live-db-ddl-ignore: ON COMMIT DROP temp job_outbox, pg_temp shadows public\n' +
      '  CREATE UNIQUE INDEX i ON job_outbox (topic)\n' +
      '`;\n';
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // The fail-OPEN guard: a trailing pragma on a CODE line must not blanket the
  // line below it, or one reviewed exemption silently covers a different
  // statement that nobody looked at.
  it('does not let a code line trailing the pragma exempt the DDL line below it', () => {
    const source =
      LIVE_DB +
      'await tx`SELECT 1`; // live-db-ddl-ignore: unrelated\n' +
      'await tx`ALTER TABLE job_outbox ADD COLUMN y TEXT`;\n';
    const findings = auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', source);
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  // DDL-PROBE SUITES. A second allowlist, distinct from MIGRATION_SHAPE_SUITES:
  // DDL that redefines a session-scoped object (`auth.uid()`) inside a
  // transaction that always rolls back. Allowlisted does NOT mean unlocked —
  // the probe still redefines a shared-catalog object for the duration of the
  // transaction, so the cross-process lock is required exactly as it is for a
  // migration-shape suite.
  it('flags an allowlisted DDL-probe suite that applies probe DDL without the cross-process lock', () => {
    const findings = auditLiveDbSuite(
      'src/lib/solicitation/__tests__/outreach-render.integration.test.ts',
      LIVE_DB + "await tx.unsafe('CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ $$');\n",
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['unlocked-ddl']);
  });

  it('allows an allowlisted DDL-probe suite that holds the cross-process lock', () => {
    const findings = auditLiveDbSuite(
      'src/lib/solicitation/__tests__/outreach-render.integration.test.ts',
      LIVE_DB +
        "await tx.unsafe('CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ $$');\n" +
        'await acquireLiveDbLock(url);\n',
    );
    expect(findings).toEqual([]);
  });

  // #573's audit recognised ONLY the literal env-var name, so five suites that
  // reach the DB purely through the shared helpers — batch-builder (the suite
  // whose deadlock IS #573) and migration-088 among them — were skipped before
  // any rule ran. Each helper import is now its own entry point.
  describe('detects a live-DB suite however it reaches the database', () => {
    const VIA_HELPERS = [
      ['live-db-lock', "import { resolveTestDatabaseUrl } from './helpers/live-db-lock';"],
      ['describe-with-db', "import { describeWithDb } from '@/__tests__/helpers/describe-with-db';"],
      ['schema-ready', "import { assertSchemaReady } from '@/lib/shared/__tests__/helpers/schema-ready';"],
      ['the env var by name', LIVE_DB],
    ] as const;

    it.each(VIA_HELPERS)('flags a misnamed suite that reaches the DB via %s', (_label, source) => {
      const findings = auditLiveDbSuite('src/lib/x/__tests__/x.test.ts', source);
      expect(findings.map((finding) => finding.rule)).toEqual(['naming']);
    });

    it.each(VIA_HELPERS)('flags run-time DDL in a suite that reaches the DB via %s', (_label, source) => {
      const findings = auditLiveDbSuite(
        'src/lib/x/__tests__/x.integration.test.ts',
        source + APPLIES_DDL,
      );
      expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
    });

    it('reaches the unlocked-ddl rule for an allowlisted suite using only helpers', () => {
      // This is the check that was unreachable: migration-088 is allowlisted as a
      // migration-shape suite precisely so its lock enrolment gets verified, and
      // it names no env var, so the audit returned early every time.
      const findings = auditLiveDbSuite(
        'src/lib/shared/__tests__/migration-088-solicitation-batch-executor.integration.test.ts',
        "import { describeWithDb } from '@/__tests__/helpers/describe-with-db';" + APPLIES_DDL,
      );
      expect(findings.map((finding) => finding.rule)).toEqual(['unlocked-ddl']);
    });
  });

  // The end state, asserted directly rather than inferred from the fixtures
  // above: with the tightened detector, every live-DB suite in the repository
  // is clean. Marked `.fails` until Tasks 1-4 land (the detector rewrite, the
  // two allowlist entries, and the offender fixes) — Task 5 drops `.fails`.
  //
  // Precedent for a unit test that reads the repository: src/__tests__/ci-audit-wiring.test.ts
  it.fails('every live-DB suite in the repository passes the tightened detector', async () => {
    const { readFile } = await import('node:fs/promises');
    const offenders: string[] = [];
    for (const file of listTestFiles()) {
      const findings = auditLiveDbSuite(file, await readFile(file, 'utf8'));
      offenders.push(...findings.map((finding) => `${finding.file} [${finding.rule}]`));
    }
    expect(offenders).toEqual([]);
  });
});
