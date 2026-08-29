// The Refusal Log eval — read-layer unit half (T0, red-first).
//
// Titles are VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches them as fixed strings.
//
// `src/lib/refusals/read.ts` does not exist at this commit — T2 creates it and
// T3/T4 add its arms. Cases that need `getRefusalLog` itself are `it.todo`
// (a static import of a missing module fails the whole file at collection).
// Two cases are written for REAL because they are source-shape invariants that
// need no module to be loaded, only to EXIST — both fail today naming the
// missing file, which is the point:
//
//   - the flagged-reason redaction invariant (risk 1 in plan §7: S1 is deny-all
//     RLS read through the RLS-bypassing `postgres` role, so redaction is the
//     whole security story and the assertion is the ABSENCE of the column from
//     the SQL, not that a label looks right);
//   - invariant #15, which is a file-level import rule by construction.
//
// Behavioural coverage — tenant isolation, presence per source, windows,
// exclusions — lives in `./read.integration.test.ts`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REFUSALS_DIR = join(process.cwd(), 'src/lib/refusals');
const READ_MODULE = 'src/lib/refusals/read.ts';

/** Production modules under `src/lib/refusals/` — `__tests__/` is a directory, so the `.ts` filter drops it. */
function refusalsProductionModules(): readonly string[] {
  if (!existsSync(REFUSALS_DIR)) return [];
  return readdirSync(REFUSALS_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
}

function readSourceOrFail(relativePath: string, owner: string): string {
  const absolute = join(process.cwd(), relativePath);
  expect(existsSync(absolute), `${relativePath} does not exist yet — ${owner} creates it`).toBe(true);
  return readFileSync(absolute, 'utf8');
}

/** SQL keywords a naive `FROM <table> <word>` capture can pick up instead of an alias. */
const SQL_KEYWORDS = new Set([
  'where',
  'on',
  'join',
  'left',
  'inner',
  'union',
  'order',
  'group',
  'limit',
  'and',
  'as',
]);

describe('getRefusalLog redaction', () => {
  // REAL, red at this commit. `flagged_responses.reason` is moderation prose;
  // no value read from it may be selected by the query or placed in a returned
  // object (intake invariant 4).
  it('getRefusalLog never selects flagged_responses.reason', () => {
    const source = readSourceOrFail(READ_MODULE, 'T2');

    expect(source).not.toContain('flagged_responses.reason');

    const aliasMatch = /flagged_responses\s+(?:AS\s+)?([a-z][a-z0-9_]*)/i.exec(source);
    const alias = aliasMatch?.[1];
    if (alias !== undefined && !SQL_KEYWORDS.has(alias.toLowerCase())) {
      expect(source, `the flagged_responses arm selects ${alias}.reason`).not.toContain(
        `${alias}.reason`,
      );
    }
  });

  it.todo('getRefusalLog returns no draft text or review text for a held draft');
});

describe('getRefusalLog query shape', () => {
  it.todo('every refusal source query scopes account reads by account_id');

  it.todo('every business-scoped refusal source query scopes location reads by account_id and business_id');

  it.todo('getRefusalLog orders entries newest first');

  // Intake edge case: an unrecognised source code reaching the read is a fault,
  // not a category. Assert rather than fall back to a default.
  it.todo('getRefusalLog throws on an unrecognised source code rather than defaulting a category');
});

describe('refusals module invariants', () => {
  // REAL, red at this commit — invariant #15. Domain modules under `src/lib/**`
  // take `sql` as an explicit parameter; only the route file (a composition
  // root) imports the singleton.
  it('refusals domain modules do not import @/lib/db/server', () => {
    const modules = refusalsProductionModules();
    expect(
      modules.length,
      'src/lib/refusals holds no production module yet — T1 and T2 create them',
    ).toBeGreaterThan(0);

    const offenders = modules.filter((name) =>
      readFileSync(join(REFUSALS_DIR, name), 'utf8').includes('@/lib/db/server'),
    );
    expect(offenders, 'refusals domain modules importing the db singleton').toEqual([]);
  });
});
