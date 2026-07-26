// Guards the two live-DB test conventions that #573 was caused by breaking.
//
// A "live-DB suite" is any test file that reads TEST_DATABASE_POOL_URL, i.e.
// one that talks to the shared local Postgres.
//
// R1 — NAMING. A live-DB suite must be named `*.integration.test.ts`. That glob
//      is what puts it in vitest's serialized `integration` project; a suite
//      that misses it runs in the fully parallel project alongside ~740 other
//      files, unsynchronized against every other live-DB writer.
//
// R2 — NO RUN-TIME DDL. A live-DB suite must not apply migration SQL. DDL takes
//      ACCESS EXCLUSIVE locks; a sibling suite holding ordinary row locks on the
//      same relations in the opposite order deadlocks against it (40P01), and
//      the victim is whichever transaction Postgres picks — so the failure lands
//      somewhere unrelated and reads as flake. The schema is provisioned once by
//      `pnpm test:db:setup`; suites assert it with `assertSchemaReady`.
//
//      Migration-SHAPE suites are the sanctioned exception: proving a migration
//      applies IS their subject. Each one is allowlisted below and must enrol in
//      the cross-process lock (`acquireLiveDbLock`), which is the only mechanism
//      that serializes them against suites in OTHER vitest processes.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export interface LiveDbSuiteFinding {
  file: string;
  rule: 'naming' | 'runtime-ddl' | 'unlocked-ddl';
  reason: string;
}

/**
 * Files that mention TEST_DATABASE_POOL_URL without connecting to it:
 * `describe-with-db.test.ts` manipulates the variable to exercise the DB-gating
 * helper, and this audit's own test carries violating source as fixtures.
 */
const NOT_LIVE_DB = new Set([
  'src/__tests__/helpers/describe-with-db.test.ts',
  'scripts/ci/__tests__/live-db-suites-audit.test.ts',
]);

/**
 * Migration-shape suites: applying the migration is the thing under test.
 * Every entry must hold the cross-process live-DB lock (enforced below).
 */
const MIGRATION_SHAPE_SUITES = new Set([
  'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts',
  'src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts',
  'src/lib/shared/__tests__/migration-077-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-078-copilot-autopilot.integration.test.ts',
  'src/lib/shared/__tests__/migration-088-solicitation-batch-executor.integration.test.ts',
]);

/**
 * 074 predates the shared lock and serializes on its own dedicated apply lock
 * (`withMigration074ApplyLock`), which is equally cross-process. Accepted as an
 * alternative to `acquireLiveDbLock` for that file only.
 */
const OWN_APPLY_LOCK = new Set([
  'src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts',
]);

const LIVE_DB_MARKER = 'TEST_DATABASE_POOL_URL';
const MIGRATION_DIR_MARKER = 'supabase/migrations';
const RAW_SQL_MARKER = '.unsafe(';
const SHARED_LOCK_MARKER = 'acquireLiveDbLock';
const OWN_LOCK_MARKER = 'withMigration074ApplyLock';

export function auditLiveDbSuite(file: string, text: string): LiveDbSuiteFinding[] {
  if (NOT_LIVE_DB.has(file)) return [];
  if (!text.includes(LIVE_DB_MARKER)) return [];

  const findings: LiveDbSuiteFinding[] = [];

  if (!file.endsWith('.integration.test.ts')) {
    findings.push({
      file,
      rule: 'naming',
      reason:
        'live-DB suite must be named *.integration.test.ts so vitest serializes it ' +
        'in the `integration` project (it currently runs in the parallel project)',
    });
  }

  const appliesDdl = text.includes(MIGRATION_DIR_MARKER) && text.includes(RAW_SQL_MARKER);
  if (!appliesDdl) return findings;

  if (!MIGRATION_SHAPE_SUITES.has(file)) {
    findings.push({
      file,
      rule: 'runtime-ddl',
      reason:
        'live-DB suite applies migration SQL at run time — ACCESS EXCLUSIVE locks ' +
        'deadlock sibling suites (#573). Provision with `pnpm test:db:setup` and ' +
        'assert with assertSchemaReady() instead',
    });
    return findings;
  }

  const locked = OWN_APPLY_LOCK.has(file)
    ? text.includes(OWN_LOCK_MARKER)
    : text.includes(SHARED_LOCK_MARKER);
  if (!locked) {
    findings.push({
      file,
      rule: 'unlocked-ddl',
      reason:
        'allowlisted migration-shape suite applies DDL without the cross-process ' +
        'live-DB lock — call acquireLiveDbLock() in beforeAll and release it in afterAll',
    });
  }
  return findings;
}

export function listTestFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

async function main(): Promise<void> {
  const findings: LiveDbSuiteFinding[] = [];
  for (const file of listTestFiles()) {
    findings.push(...auditLiveDbSuite(file, await readFile(file, 'utf8')));
  }

  if (findings.length > 0) {
    console.error('live-db-suites-audit: failed');
    for (const finding of findings) {
      console.error(`${finding.file} [${finding.rule}]: ${finding.reason}`);
    }
    process.exit(1);
  }
  console.log('live-db-suites-audit: passed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('live-db-suites-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
