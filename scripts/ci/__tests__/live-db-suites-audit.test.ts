import { describe, expect, it } from 'vitest';
import { auditLiveDbSuite } from '../live-db-suites-audit';

const LIVE_DB = 'const url = process.env.TEST_DATABASE_POOL_URL;';
const APPLIES_DDL = `
  await db.unsafe(readFileSync(resolve(process.cwd(), 'supabase/migrations/088_x.sql'), 'utf-8'));
`;

describe('live-db-suites-audit', () => {
  it('passes a live-DB suite that is named correctly and applies no DDL', () => {
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.integration.test.ts', LIVE_DB)).toEqual([]);
  });

  it('ignores a file that never touches the live test DB', () => {
    expect(auditLiveDbSuite('src/lib/x/__tests__/x.test.ts', 'const a = 1;')).toEqual([]);
  });

  it('flags a live-DB suite outside the serialized *.integration.test.ts glob', () => {
    const findings = auditLiveDbSuite('worker/jobs/y/__tests__/integration-y.test.ts', LIVE_DB);
    expect(findings.map((finding) => finding.rule)).toEqual(['naming']);
  });

  it('flags run-time migration DDL in a suite that is not a migration-shape suite', () => {
    const findings = auditLiveDbSuite(
      'src/lib/x/__tests__/x.integration.test.ts',
      LIVE_DB + APPLIES_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  it('reports both rules for the #573 offender shape', () => {
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

  it('accepts 074 on its own dedicated apply lock rather than the shared one', () => {
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
});
