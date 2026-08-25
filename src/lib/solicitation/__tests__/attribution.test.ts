// The pure half of #632's `review_attributed` shadow attribution, plus the
// eval contract that makes every other promised test real.
//
// The matcher is DB-free by construction (plan § "matchAttribution is an
// internal seam"), so these cases cross it without a database and the property
// cases can generate names freely.
//
// At Task 0 this file does not resolve `../attribution` — that module lands in
// Task 2. The import failure IS the expected Task 0 result.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  matchAttribution,
  normalizePersonName,
  type AttributionCandidate,
} from '../attribution';

// The COMMITTED audit copy, never `.feature/intake.json`. The arming copy is
// gitignored by design (#512), so a test that read it would pass locally and
// fail on every CI checkout. feature-setup.sh commits this one.
const INTAKE = join(
  process.cwd(),
  'docs/superpowers/plans/feat-632-review-attributed-shadow-intake.json',
);
const SUITE_FILES = [
  'src/lib/solicitation/__tests__/attribution.test.ts',
  'src/lib/solicitation/__tests__/attribution.integration.test.ts',
  'src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts',
  'src/lib/shared/__tests__/job-outbox-helpers.test.ts',
  'src/lib/shared/__tests__/job-outbox-helpers-attribution.integration.test.ts',
  'src/lib/reviews/__tests__/process-review.test.ts',
  'src/lib/reviews/__tests__/process-review-attribution.integration.test.ts',
  'worker/__tests__/solicitation-attribution.test.ts',
  'worker/__tests__/solicitation-attribution.integration.test.ts',
  'src/app/api/dashboard/solicitation/attributed/__tests__/route.test.ts',
  'src/app/(authenticated)/dashboard/requests/__tests__/attributed-reviews.test.tsx',
];

it('eval contract: every promised test executes with zero todo or skip cases', () => {
  const promised: string[] = JSON.parse(readFileSync(INTAKE, 'utf8')).tests_to_add;
  const corpus = SUITE_FILES
    .map((f) => { try { return readFileSync(join(process.cwd(), f), 'utf8'); } catch { return ''; } })
    .join('\n');

  // Every promised title must appear VERBATIM. Title discipline: the whole
  // title lives in the `it(...)` string, never split across a `describe`
  // prefix, because this check and the gate's `promised-tests` row both grep
  // the literal string.
  const missing = promised.filter((title) => !corpus.includes(title));
  expect(missing).toEqual([]);

  // NO parked test may exist in these files AT ALL — not "no parked promised
  // title". Scanning only promised titles was false-green twice (round-2
  // finding): an obsolete unpromised parked test survived, and a parked
  // DESCRIBE wrapper slipped through because the wrapper's argument is not a
  // promised title.
  //
  // Comment lines are dropped FIRST (round-3 finding). Without that, a comment
  // in this very file that names a parked form matches the scan and the test
  // can never go green. Do not name parked forms in these suites' comments —
  // which is why the prose here refers to them only in the abstract.
  //
  // The drop is WHOLE-LINE and therefore FAIL-CLOSED (round-4 finding). The
  // round-3 version used lexical regex replacement, which is not syntax-aware
  // and silently ate real code: a comment marker inside a string literal lost
  // everything after it on that line, hiding a parked call — a FALSE GREEN. A
  // block-comment strip did the same between two markers living in two
  // different string literals, erasing every parked test between them.
  // Dropping only lines that are ENTIRELY a comment cannot hide a marker,
  // because a marker never appears on a comment-only line. The trade is that a
  // TRAILING comment naming a parked form is not stripped and turns the test
  // RED. That is the safe direction, and the rule above forbids writing one.
  //
  // The pattern covers the chained and x-prefixed spellings too.
  //
  // This test is MEANT to be red for most of the branch's life.
  const code = corpus
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');
  const parked = [
    ...code.matchAll(/\b(?:it|test|describe)(?:\s*\.\s*\w+)*\s*\.\s*(?:todo|skip|skipIf|fails)\b/g),
    ...code.matchAll(/\bx(?:it|test|describe)\s*\(/g),
  ].map((m) => m[0].trim());
  expect(parked).toEqual([]);
});

function candidate(name: string, id = 'o1'): AttributionCandidate {
  return {
    outreachId: id,
    contactName: name,
    sentAt: '2026-08-10T15:03:00.000Z',
    agentRunId: 'run-1',
  };
}

describe('matchAttribution', () => {
  it('matchAttribution: exact normalized full-name equality attributes', () => {
    const result = matchAttribution('Dana Rodriguez', [candidate('dana rodriguez')]);
    // `candidateCount` is on the attributed arm too (branch-review M3). Kept as
    // an exact `toEqual` rather than loosened to `toMatchObject`: this is the one
    // case that pins the WHOLE returned shape, so a field appearing or vanishing
    // should break it.
    expect(result).toEqual({
      resolution: 'attributed',
      candidate: candidate('dana rodriguez'),
      rule: 'full_name',
      candidateCount: 1,
    });
  });

  it('matchAttribution: first name plus matching last initial attributes', () => {
    const result = matchAttribution('Dana R.', [candidate('Dana Rodriguez')]);
    expect(result.resolution).toBe('attributed');
    expect(result).toMatchObject({ rule: 'first_last_initial' });
  });

  it('matchAttribution: a bare first name with no surname token never attributes', () => {
    const result = matchAttribution('Dana', [candidate('Dana Rodriguez')]);
    expect(result).toEqual({ resolution: 'no_match', candidateCount: 1 });
  });

  it('matchAttribution: accents and letter case normalize before comparison', () => {
    const result = matchAttribution('JOSÉ MARTÍNEZ', [candidate('jose martinez')]);
    expect(result).toMatchObject({ resolution: 'attributed', rule: 'full_name' });
  });

  it('matchAttribution: two candidates matching the same review abstain with resolution ambiguous', () => {
    const result = matchAttribution('Dana R.', [
      candidate('Dana Rodriguez', 'o1'),
      candidate('Dana Ramirez', 'o2'),
    ]);
    expect(result).toEqual({ resolution: 'ambiguous', candidateCount: 2 });
  });

  it('matchAttribution: a null or empty reviewer name never attributes', () => {
    expect(matchAttribution(null, [candidate('Dana Rodriguez')]))
      .toEqual({ resolution: 'no_match', candidateCount: 1 });
    expect(matchAttribution('   ', [candidate('Dana Rodriguez')]))
      .toEqual({ resolution: 'no_match', candidateCount: 1 });
  });

  it('matchAttribution: one matching candidate among unrelated non-matches attributes that candidate', () => {
    const result = matchAttribution('Dana Rodriguez', [
      candidate('Priya Raman', 'o1'),
      candidate('Dana Rodriguez', 'o2'),
      candidate('Michael Okafor', 'o3'),
    ]);
    expect(result).toMatchObject({
      resolution: 'attributed',
      rule: 'full_name',
      candidate: { outreachId: 'o2' },
    });
  });

  describe('invariants', () => {
    const nameArb = fc.stringMatching(/^[a-z]{1,8}( [a-z]{1,8}){0,2}$/);

    // A TEST-SIDE oracle. It re-implements the locked rule independently and
    // calls neither matchAttribution nor normalizePersonName. The first draft
    // decided the expected answer by calling matchAttribution again on
    // singletons, which is circular: a matcher that always abstains for arrays
    // longer than one passed vacuously (round-1 finding A12).
    const oracleTokens = (s: string) =>
      s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);

    function oracleMatches(contactName: string, reviewerName: string): boolean {
      const a = oracleTokens(contactName), b = oracleTokens(reviewerName);
      if (a.length < 2 || b.length < 2) return false;
      const ok = (x: string, y: string) =>
        x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y));
      const fa = a[0]!, la = a[a.length - 1]!, fb = b[0]!, lb = b[b.length - 1]!;
      return ok(fa, fb) && ok(la, lb) && (fa === fb || la === lb);
    }

    it('invariants: matchAttribution agrees with an independent test-side oracle on match cardinality', () => {
      fc.assert(
        fc.property(nameArb, fc.array(nameArb, { maxLength: 6 }), (reviewer, names) => {
          const result = matchAttribution(reviewer, names.map((n, i) => candidate(n, `o${i}`)));
          const hits = names.filter((n) => oracleMatches(n, reviewer)).length;
          if (names.length === 0) return result.resolution === 'no_candidates';
          if (hits === 0) return result.resolution === 'no_match';
          if (hits > 1) return result.resolution === 'ambiguous';
          return result.resolution === 'attributed';
        }),
      );
    });

    it('invariants: matchAttribution never returns more than one attributed candidate', () => {
      fc.assert(
        fc.property(nameArb, fc.array(nameArb, { maxLength: 6 }), (reviewer, names) => {
          const result = matchAttribution(reviewer, names.map((n, i) => candidate(n, `o${i}`)));
          if (result.resolution !== 'attributed') return true;
          return names.filter((n) => oracleMatches(n, reviewer)).length === 1;
        }),
      );
    });

    it('invariants: matchAttribution never attributes when no candidate shares a full name token', () => {
      fc.assert(
        fc.property(nameArb, nameArb, (reviewer, contact) => {
          const result = matchAttribution(reviewer, [candidate(contact)]);
          if (result.resolution !== 'attributed') return true;
          const a = normalizePersonName(reviewer).split(' ');
          const b = normalizePersonName(contact).split(' ');
          return a[0] === b[0] || a[a.length - 1] === b[b.length - 1];
        }),
      );
    });
  });
});

describe('architecture', () => {
  // Invariant #15 read straight off the module source. `ci:db-imports` is the
  // repo-wide gate, but it derives composition-root status from registration
  // and could one day classify this module as a root by accident; this case
  // pins the narrower claim the whole feature rests on — attribution.ts is a
  // DOMAIN module, and the only way it can reach Postgres is through the
  // executor its caller hands it.
  it('architecture: attribution.ts receives its DB executor and never imports the singleton', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/solicitation/attribution.ts'), 'utf8');

    // Every import specifier in the module, quotes stripped. Matching on the
    // specifier rather than on raw text means a mention inside a comment or a
    // string can never make this pass or fail.
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const forbidden of ['@/lib/db/server', '../db/server', '../../db/server']) {
      expect(specifiers, `attribution.ts imports the singleton from ${forbidden}`)
        .not.toContain(forbidden);
    }
    expect(specifiers.filter((s) => s !== undefined && /(^|\/)db\/server$/.test(s))).toEqual([]);

    // EVERY DB-touching entry point takes its executor first — all THREE, not
    // two (branch-review C4). The earlier version checked `attributeReview` and
    // the private `loadCandidates` and omitted the exported
    // `listAttributedReviews`, so dropping that read model's parameter and
    // reaching for a client indirectly would have left this test green while
    // breaking invariant #15 and this test's own title.
    expect(source).toContain('export async function attributeReview(\n  tx: TransactionSql,');
    expect(source).toContain('async function loadCandidates(\n  tx: TransactionSql,');
    expect(source).toContain('export async function listAttributedReviews(\n  sql: Sql,');

    // …and nothing in the module reaches for a module-scope client instead.
    expect(source).not.toMatch(/^\s*(?:const|let)\s+sql\s*=/m);
  });
});
