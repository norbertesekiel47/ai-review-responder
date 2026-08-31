// The Refusal ledger's vocabulary eval — #1009 slice 2, task T1 (the RED phase).
//
// Every title here is VERBATIM from `.feature/intake.json` `tests_to_add`; the
// verify gate's `promised-tests` row matches on exact text, so a reworded title
// reads as an unwritten test.
//
// WHY THESE CASES PARSE THE MIGRATION RATHER THAN RESTATE ITS MEMBERS.
// `refusal_events`'s three column CHECKs are the authority for the lane, the
// category and the subject-type vocabularies. A test that re-typed the seven
// lanes as literals would become a SECOND authority over the same fact and
// would drift with the migration rather than against it — the precise defect
// #1001 cites when it declines to CHECK the 22 `AutoApprovalBlockReason`
// members. So titles 1-3 read `supabase/migrations/116_refusal_events.sql` and
// compare what it admits against what TypeScript exports, IN THE MIGRATION'S
// ORDER. Precedent: the parked `feat/refusal-log` branch's own
// `vocabulary.test.ts` parses migration 111 for the same reason.
//
// Title 4's authority is a bare TYPE union (`AutonomySuspensionTrigger`), which
// nothing can enumerate at run time, so that case parses the union out of its
// owning module instead of re-spelling four literals here.
//
// The reads happen INSIDE each case, never at module scope: a module-scope read
// of a missing file throws during collection and takes every other case in this
// file down with it, hiding which one actually failed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES,
  REFUSAL_CATEGORIES,
  REFUSAL_SOURCES,
  REFUSAL_SUBJECT_TYPES,
  REFUSAL_VOCABULARY_VERSION,
} from '../vocabulary';

/** The table under test. Applied to staging and production; never edited here. */
const MIGRATION_116 = 'supabase/migrations/116_refusal_events.sql';

/** The module T2 creates. Read as TEXT by title 5. */
const VOCABULARY_MODULE = 'src/lib/refusals/vocabulary.ts';

/** The single owner of `AutonomySuspensionTrigger`. */
const WORKER_TYPES_MODULE = 'src/lib/shared/worker-types.ts';

/**
 * The frozen vocabulary version, on `RESTRAINT_POLICY_VERSION`'s
 * `<name>_<date>.<rev>` shape, dated the day map #994 closed.
 *
 * Spelled here deliberately: title 5's whole claim is that this string is a
 * LITERAL nothing derives, and the only way to assert that is to state the
 * expected bytes and compare.
 */
const EXPECTED_VOCABULARY_VERSION = 'refusal_vocab_2026-08-30.1';

function readRepoFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

/**
 * The migration with its `--` comment lines removed.
 *
 * 116's header and its five CHECK blocks carry long prose that names
 * `refusal_source` and `subject_type` repeatedly; stripping whole comment lines
 * keeps a sentence from ever being read as a vocabulary.
 */
function migrationSqlWithoutComments(): string {
  return readRepoFile(MIGRATION_116)
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

/** Every single-quoted lower_snake literal in a fragment, in source order. */
function quotedMembers(fragment: string): readonly string[] {
  return [...fragment.matchAll(/'([a-z_]+)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * The members of a column-level `CHECK (<column> IN (…))`, in the migration's
 * order. Anchored on `IN (` so C1's `subject_type = 'response'` arms and C3's
 * `refusal_source <> 'autonomy_suspended'` can never be mistaken for the list.
 */
function columnCheckMembers(column: string): readonly string[] {
  const pattern = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`);
  const match = pattern.exec(migrationSqlWithoutComments());
  const members = match?.[1];
  if (members === undefined) {
    throw new Error(`${MIGRATION_116}: could not locate the ${column} CHECK member list`);
  }
  return quotedMembers(members);
}

/** The members of a bare exported TS union, read out of its owning module. */
function unionMembers(relativePath: string, typeName: string): readonly string[] {
  const declaration = new RegExp(`export type ${typeName}\\s*=([^;]*);`).exec(
    readRepoFile(relativePath),
  );
  const body = declaration?.[1];
  if (body === undefined) {
    throw new Error(`${relativePath}: could not locate \`export type ${typeName}\``);
  }
  return quotedMembers(body);
}

describe('Refusal ledger vocabulary', () => {
  it("REFUSAL_SOURCES lists exactly the seven lanes migration 116's refusal_source CHECK admits, in the migration's order", () => {
    const admitted = columnCheckMembers('refusal_source');

    // Guard the parse itself: an anchor that silently matched nothing would
    // make every assertion below vacuous.
    expect(admitted).toHaveLength(7);

    // ORDERED, not sorted. A Refusal source is the LANE, and the lane order is
    // the migration's — `policy_gate_held` joined the parent effort's six in
    // #1003 and sits last there, so a TypeScript copy that re-sorts them is
    // already a second authority.
    expect([...REFUSAL_SOURCES]).toEqual([...admitted]);
  });

  it("REFUSAL_CATEGORIES lists exactly the eight categories migration 116's refusal_category CHECK admits, in the migration's order", () => {
    const admitted = columnCheckMembers('refusal_category');

    // Eight: `owner_review_required` was coined in #998 and joined the closed
    // seven the parked branch shipped.
    expect(admitted).toHaveLength(8);
    expect([...REFUSAL_CATEGORIES]).toEqual([...admitted]);
  });

  it("REFUSAL_SUBJECT_TYPES lists exactly the four subject types migration 116's subject_type CHECK admits", () => {
    const admitted = columnCheckMembers('subject_type');

    expect(admitted).toHaveLength(4);
    expect([...REFUSAL_SUBJECT_TYPES]).toEqual([...admitted]);
  });

  it('AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES maps every AutonomySuspensionTrigger to autonomy_paused and omits none', () => {
    const triggers = unionMembers(WORKER_TYPES_MODULE, 'AutonomySuspensionTrigger');
    expect(triggers.length).toBeGreaterThan(0);

    const mapped = AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES as Readonly<Record<string, string>>;

    // Keys are EXACTLY the union's members: an omission and an invention both
    // fail. `satisfies Record<AutonomySuspensionTrigger, RefusalCategory>` makes
    // an omission a compile error, but nothing at run time enumerates a bare
    // type union — this is the run-time half of that guard.
    expect(Object.keys(mapped).sort()).toEqual([...triggers].sort());

    for (const trigger of triggers) {
      expect(Object.hasOwn(mapped, trigger), `'${trigger}' has no entry`).toBe(true);
      // The trigger distinguishes WHO stopped us (Judge or Governor), which is
      // admin detail. The owner-facing fact is one category for all four.
      expect(mapped[trigger], `'${trigger}' maps to the wrong category`).toBe('autonomy_paused');
    }
  });

  it('REFUSAL_VOCABULARY_VERSION is a frozen literal, not a value any code derives at runtime', () => {
    expect(REFUSAL_VOCABULARY_VERSION).toBe(EXPECTED_VOCABULARY_VERSION);

    // `<name>_<date>.<rev>`, the RESTRAINT_POLICY_VERSION shape.
    expect(REFUSAL_VOCABULARY_VERSION).toMatch(/^[a-z_]+_\d{4}-\d{2}-\d{2}\.\d+$/);

    // The VALUE assertion above cannot tell a frozen literal from a value that
    // happened to evaluate to the same string on the day the suite ran — a
    // `${today}` template would pass it exactly once and then rot. So the
    // DECLARATION is asserted too: a single-quoted literal, nothing else.
    const source = readRepoFile(VOCABULARY_MODULE);
    const declaration = /export const REFUSAL_VOCABULARY_VERSION[^\n]*\n/.exec(source)?.[0];
    expect(declaration, `${VOCABULARY_MODULE}: no REFUSAL_VOCABULARY_VERSION export`).toBeDefined();
    expect(declaration).toContain(`'${EXPECTED_VOCABULARY_VERSION}'`);

    // No derivation on that line: no template literal, no clock read, no
    // concatenation. #1002 ruled there is never a backfill, so this string
    // identifies no derived row and must never move on its own.
    expect(declaration).not.toContain('`');
    expect(declaration).not.toMatch(/Date|now\(|\+/);
  });
});
