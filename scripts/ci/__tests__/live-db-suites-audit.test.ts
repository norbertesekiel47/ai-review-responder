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
});
