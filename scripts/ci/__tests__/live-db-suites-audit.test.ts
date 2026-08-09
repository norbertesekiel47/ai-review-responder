import { describe, expect, it } from 'vitest';
import { auditLiveDbFile, listAuditedFiles } from '../live-db-suites-audit';

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

  /** A helper is handed its handle, so a `postgres` import is how it reaches the DB. */
  const HELPER_PG_IMPORT = "import type { Sql } from 'postgres';\n";
  /** The #706 shape: the helper BUILDS the statement, the suite only splices it. */
  const HELPER_FRAGMENT_DDL =
    'export const addCheck = sql`ALTER TABLE job_outbox ADD CONSTRAINT tmp_x CHECK (true) NOT VALID`;\n';
  const HELPER_PATH = 'src/lib/x/__tests__/helpers/frag.ts';
  const APPLY_074 = 'src/lib/shared/__tests__/helpers/apply-migration-074.ts';

  it('passes a live-DB suite that is named correctly and applies no DDL', () => {
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', LIVE_DB)).toEqual([]);
  });

  it('still ignores a file that never reaches the live test DB', () => {
    expect(auditLiveDbFile('src/lib/x/__tests__/x.test.ts', 'const a = 1;')).toEqual([]);
  });

  it('flags a live-DB suite outside the serialized *.integration.test.ts glob', () => {
    const findings = auditLiveDbFile('worker/jobs/y/__tests__/integration-y.test.ts', LIVE_DB);
    expect(findings.map((finding) => finding.rule)).toEqual(['naming']);
  });

  it('still flags run-time migration DDL in a suite that is on no allowlist', () => {
    const findings = auditLiveDbFile(
      'src/lib/x/__tests__/x.integration.test.ts',
      LIVE_DB + APPLIES_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  it('reports naming and runtime-ddl together for the #573 offender shape', () => {
    const findings = auditLiveDbFile(
      'worker/jobs/account-offboarding/__tests__/integration-lifecycle.test.ts',
      LIVE_DB + APPLIES_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['naming', 'runtime-ddl']);
  });

  it('allows an allowlisted migration-shape suite that holds the cross-process lock', () => {
    const findings = auditLiveDbFile(
      'src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts',
      LIVE_DB + APPLIES_DDL + 'await acquireLiveDbLock(url);',
    );
    expect(findings).toEqual([]);
  });

  it('flags an allowlisted migration-shape suite that applies DDL unlocked', () => {
    const findings = auditLiveDbFile(
      'src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts',
      LIVE_DB + APPLIES_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['unlocked-ddl']);
  });

  it('still accepts 074 on its own dedicated apply lock rather than the shared one', () => {
    const file = 'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts';
    expect(auditLiveDbFile(file, LIVE_DB + APPLIES_DDL + 'withMigration074ApplyLock(db, fn);')).toEqual(
      [],
    );
    expect(
      auditLiveDbFile(file, LIVE_DB + APPLIES_DDL).map((finding) => finding.rule),
    ).toEqual(['unlocked-ddl']);
  });

  it('does not treat the describe-with-db helper test as a live-DB suite', () => {
    expect(auditLiveDbFile('src/__tests__/helpers/describe-with-db.test.ts', LIVE_DB)).toEqual([]);
  });

  // REACH. The three executed-DDL shapes the `supabase/migrations` + `.unsafe(`
  // conjunction is blind to. Each of these is a real shape in this repo.
  it('flags DDL executed through a plain tagged template in a file containing no .unsafe( at all', () => {
    const source = LIVE_DB + PLAIN_TEMPLATE_DDL;
    expect(source).not.toContain('.unsafe(');
    expect(source).not.toContain('supabase/migrations');
    const findings = auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', source);
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  it('flags DDL executed through .unsafe() on a call-form receiver such as sql()', () => {
    const findings = auditLiveDbFile(
      'src/lib/x/__tests__/x.integration.test.ts',
      LIVE_DB + CALL_FORM_UNSAFE_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  it('flags DDL executed through a tagged template whose tag is a non-null assertion such as db!', () => {
    const findings = auditLiveDbFile(
      'src/lib/x/__tests__/x.integration.test.ts',
      LIVE_DB + NON_NULL_TAG_DDL,
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  // The property-access receiver was the only shape recognised, so the audit's
  // claim to see every `.unsafe()` call overreached by one cheap form.
  it('flags DDL executed through the bracket-indexed sql["unsafe"]() form', () => {
    const findings = auditLiveDbFile(
      'src/lib/x/__tests__/x.integration.test.ts',
      LIVE_DB + "await sql['unsafe']('DROP TABLE job_outbox');\n",
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
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // migration-096-solicitation-suppressions.integration.test.ts:610
  it('ignores a DDL verb that appears only inside an expect().toContain() assertion', () => {
    const source = LIVE_DB + "expect(globalIndex).toContain('CREATE UNIQUE INDEX');\n";
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // migration-079-agent-run-spine-archival.integration.test.ts:6
  it('ignores a DDL verb that appears only inside a comment', () => {
    const source = LIVE_DB + '// Migration 079 adds two CREATE INDEX CONCURRENTLY scan indexes.\n';
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // A comment INSIDE an executed template — the same promise as the TS-comment
  // case above, one level in. The raw template text was matched, so a verb only
  // a Postgres parser would ever skip was reported as executed DDL.
  it('ignores a DDL verb that appears only inside a SQL comment within an executed template', () => {
    const dashDash =
      LIVE_DB +
      'await tx`\n' +
      '  -- migration 083 replaced this ALTER TABLE reviews with an assertion\n' +
      '  SELECT count(*) FROM reviews\n' +
      '`;\n';
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', dashDash)).toEqual([]);

    const block = LIVE_DB + 'await tx`SELECT 1 /* not a CREATE INDEX, just a note */`;\n';
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', block)).toEqual([]);
  });

  // migration-076-judge-verdicts-governor.integration.test.ts:115-142
  it('ignores a DDL verb that appears only in a string constant that is never executed', () => {
    const source =
      LIVE_DB +
      "const EXPECTED = ['CREATE TABLE IF NOT EXISTS judge_verdicts (', 'ALTER TABLE judge_verdicts ENABLE ROW LEVEL SECURITY;'];\n";
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // FAIL CLOSED. When the argument to `.unsafe()` cannot be read statically the
  // audit cannot prove the SQL is harmless, and "cannot prove" must resolve to
  // flagged — the pragma is the reviewed way out, not a silent pass.
  it('treats .unsafe() with a non-literal argument as applied DDL rather than as safe', () => {
    const source = LIVE_DB + OPAQUE_UNSAFE;
    expect(source).not.toContain('supabase/migrations');
    const findings = auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', source);
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  // A template WITH substitutions read as statically readable, so an entire
  // statement smuggled in at a statement-start position matched no verb and
  // passed clean — a hole in the same "cannot prove" rule the test above pins.
  // The second half is the bound that keeps the fix honest: failing closed on
  // ALL interpolation would flag real suites, e.g. `setConsent` in
  // import-consent.integration.test.ts, which interpolates a test-controlled
  // literal MID-statement and so leaves the verb visible.
  it('fails closed on a substitution standing where a statement begins, not on one mid-statement', () => {
    const atStart = LIVE_DB + 'await db.unsafe(`${migrationSql}`);\n';
    expect(atStart).not.toContain('ALTER');
    const findings = auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', atStart);
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);

    const midStatement =
      LIVE_DB + "await sql().unsafe(`UPDATE businesses SET import_decision = '${decision}'`);\n";
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', midStatement)).toEqual([]);
  });

  // PRAGMA. `live-db-ddl-ignore` follows `outbox-seam-ignore` (#568) and must
  // match lineHasPragma's semantics exactly — see scripts/ci/lib/sql-tag-scan.ts.
  it('exempts a DDL line carrying a trailing live-db-ddl-ignore pragma', () => {
    const source =
      LIVE_DB +
      "await tx`CREATE UNIQUE INDEX i ON job_outbox (topic)`; // live-db-ddl-ignore: temp table\n";
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  it('exempts a DDL line whose immediately preceding comment-only line carries the pragma', () => {
    const source =
      LIVE_DB +
      'await tx`\n' +
      '  -- live-db-ddl-ignore: ON COMMIT DROP temp job_outbox, pg_temp shadows public\n' +
      '  CREATE UNIQUE INDEX i ON job_outbox (topic)\n' +
      '`;\n';
    expect(auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', source)).toEqual([]);
  });

  // The fail-OPEN guard: a trailing pragma on a CODE line must not blanket the
  // line below it, or one reviewed exemption silently covers a different
  // statement that nobody looked at.
  it('does not let a code line trailing the pragma exempt the DDL line below it', () => {
    const source =
      LIVE_DB +
      'await tx`SELECT 1`; // live-db-ddl-ignore: unrelated\n' +
      'await tx`ALTER TABLE job_outbox ADD COLUMN y TEXT`;\n';
    const findings = auditLiveDbFile('src/lib/x/__tests__/x.integration.test.ts', source);
    expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
  });

  // DDL-PROBE SUITES. A second allowlist, distinct from MIGRATION_SHAPE_FILES:
  // DDL that redefines a session-scoped object (`auth.uid()`) inside a
  // transaction that always rolls back. Allowlisted does NOT mean unlocked —
  // the probe still redefines a shared-catalog object for the duration of the
  // transaction, so the cross-process lock is required exactly as it is for a
  // migration-shape suite.
  it('flags an allowlisted DDL-probe suite that applies probe DDL without the cross-process lock', () => {
    const findings = auditLiveDbFile(
      'src/lib/solicitation/__tests__/outreach-render.integration.test.ts',
      LIVE_DB + "await tx.unsafe('CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ $$');\n",
    );
    expect(findings.map((finding) => finding.rule)).toEqual(['unlocked-ddl']);
  });

  it('allows an allowlisted DDL-probe suite that holds the cross-process lock', () => {
    const findings = auditLiveDbFile(
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
      const findings = auditLiveDbFile('src/lib/x/__tests__/x.test.ts', source);
      expect(findings.map((finding) => finding.rule)).toEqual(['naming']);
    });

    it.each(VIA_HELPERS)('flags run-time DDL in a suite that reaches the DB via %s', (_label, source) => {
      const findings = auditLiveDbFile(
        'src/lib/x/__tests__/x.integration.test.ts',
        source + APPLIES_DDL,
      );
      expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
    });

    it('reaches the unlocked-ddl rule for an allowlisted suite using only helpers', () => {
      // This is the check that was unreachable: migration-088 is allowlisted as a
      // migration-shape suite precisely so its lock enrolment gets verified, and
      // it names no env var, so the audit returned early every time.
      const findings = auditLiveDbFile(
        'src/lib/shared/__tests__/migration-088-solicitation-batch-executor.integration.test.ts',
        "import { describeWithDb } from '@/__tests__/helpers/describe-with-db';" + APPLIES_DDL,
      );
      expect(findings.map((finding) => finding.rule)).toEqual(['unlocked-ddl']);
    });
  });

  // #706. The audit's file set came from `git ls-files '*.test.ts' '*.test.tsx'`,
  // which never reaches `__tests__/` modules that are not themselves suites. A
  // helper can therefore BUILD a DDL fragment that a scanned suite splices in as
  // raw SQL text (Postgres.js `fragment()`), and the audit sees neither half.
  //
  // The unit of enforcement is now explicit: a SUITE matches vitest's runner
  // entry glob and gets R1 (naming) + R2 (DDL) + the lock check; a HELPER is any
  // other `.ts`/`.tsx` under `__tests__/` and gets R2 + the lock check only —
  // it is not a runner entry point and cannot be renamed to *.integration.test.ts.
  describe('audits helpers as well as suites (#706)', () => {
    it('includes non-suite files under __tests__ in the audited file list', () => {
      const files = listAuditedFiles();
      expect(files).toContain(APPLY_074);
      // NOT under a helpers/ directory — why the unit is "non-suite file under
      // __tests__", not the `__tests__/helpers/**` glob the ticket proposed.
      expect(files).toContain('src/lib/shared/__tests__/live-db-tenant.ts');
      expect(files).toContain('scripts/ci/__tests__/live-db-suites-audit.test.ts');
      // git dedupes across pathspecs; assert it rather than trusting it, since a
      // double-listed file would double-report every finding it carries.
      expect(new Set(files).size).toBe(files.length);
    });

    it('flags DDL built in a helper module that a suite splices in as a fragment', () => {
      const helper = auditLiveDbFile(HELPER_PATH, HELPER_PG_IMPORT + HELPER_FRAGMENT_DDL);
      expect(helper.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
      // The finding belongs to the file that BUILDS the statement. The suite
      // carries no DDL text and stays clean — correct, because the walk visits
      // the producing node, and cross-file provenance needs an import graph.
      const suite = auditLiveDbFile(
        'src/lib/x/__tests__/x.integration.test.ts',
        LIVE_DB + 'await sql`${addCheck}`;\n',
      );
      expect(suite).toEqual([]);
    });

    it('never reports the naming rule for a non-suite helper file', () => {
      // `describe-with-db.ts` names the env var and enters the scanned set with
      // this widening. It is a helper: no naming finding, and no DDL either.
      expect(auditLiveDbFile('src/__tests__/helpers/describe-with-db.ts', LIVE_DB)).toEqual([]);
      // A helper that DOES execute DDL reports runtime-ddl ALONE — never the
      // naming rule alongside it, however un-suite-like its filename.
      expect(
        auditLiveDbFile(HELPER_PATH, HELPER_PG_IMPORT + HELPER_FRAGMENT_DDL).map(
          (finding) => finding.rule,
        ),
      ).toEqual(['runtime-ddl']);
    });

    it('counts a type-only postgres import as a helper reaching the database', () => {
      // Four of the six DB-reaching helpers import the module type-only. A
      // value/type distinction here would re-open the hole immediately.
      const findings = auditLiveDbFile(
        HELPER_PATH,
        "import type postgres from 'postgres';\n" + OPAQUE_UNSAFE,
      );
      expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
    });

    it('ignores a non-suite helper that imports no DB handle at all', () => {
      // mock-sql.ts mocks the `sql` tag with vitest and touches no database. If
      // the gate did not hold, every mocked template would become a candidate
      // statement and the audit would flag pure unit-test scaffolding.
      expect(
        auditLiveDbFile(
          'worker/__tests__/helpers/mock-sql.ts',
          "import { vi } from 'vitest';\n" + HELPER_FRAGMENT_DDL,
        ),
      ).toEqual([]);
    });

    it('flags an allowlisted helper that executes DDL without its own apply lock', () => {
      const findings = auditLiveDbFile(APPLY_074, HELPER_PG_IMPORT + OPAQUE_UNSAFE);
      expect(findings.map((finding) => finding.rule)).toEqual(['unlocked-ddl']);
    });

    it('accepts the 074 apply helper on its own dedicated apply lock', () => {
      const findings = auditLiveDbFile(
        APPLY_074,
        HELPER_PG_IMPORT +
          'export async function withMigration074ApplyLock() {}\n' +
          OPAQUE_UNSAFE,
      );
      expect(findings).toEqual([]);
    });
  });

  // The end state, asserted directly rather than inferred from the fixtures
  // above: with the tightened detector, every live-DB suite in the repository
  // is clean.
  //
  // What this makes loud is a PRECISION regression, not a reach one: a change
  // that starts firing on a real suite — one of the ~1470 tagged templates the
  // detector now reads as SQL — or a newly added suite that genuinely executes
  // DDL. It cannot catch reach going backwards, and must not be read as if it
  // could: a detector that goes blind produces no findings, `offenders` comes
  // out empty, and this test PASSES — which is precisely the #694 mode, an audit
  // reporting `passed` on a tree that was executing DDL. Reach is pinned by the
  // fixtures above, each of which asserts a finding IS produced.
  //
  // `pnpm ci:live-db-suites` checks the same property in CI, but this puts it
  // inside `pnpm test`, where it fails next to the rules it depends on.
  //
  // Precedent for a unit test that reads the repository: src/__tests__/ci-audit-wiring.test.ts
  it('every live-DB file in the repository passes the widened detector', async () => {
    const { readFile } = await import('node:fs/promises');
    const offenders: string[] = [];
    for (const file of listAuditedFiles()) {
      const findings = auditLiveDbFile(file, await readFile(file, 'utf8'));
      offenders.push(...findings.map((finding) => `${finding.file} [${finding.rule}]`));
    }
    expect(offenders).toEqual([]);
  });
});
