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
import { WITHHOLD_REASONS } from '@/lib/solicitation/restraint-policy';
import {
  ASK_WITHHELD_REFUSAL_CATEGORIES,
  AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
  AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES,
  BATCH_HALTED_REFUSAL_CATEGORIES,
  OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES,
  OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES,
  REFUSAL_CATEGORIES,
  REFUSAL_SOURCES,
  REFUSAL_SUBJECT_TYPES,
  REFUSAL_VOCABULARY_VERSION,
} from '../vocabulary';

/** The table under test. Applied to staging and production; never edited here. */
const MIGRATION_116 = 'supabase/migrations/116_refusal_events.sql';

/** The module T2 creates. Read as TEXT by title 5. */
const VOCABULARY_MODULE = 'src/lib/refusals/vocabulary.ts';

/** The single owner of `AutonomySuspensionTrigger` and `AutoPolicyDowngradeReason`. */
const WORKER_TYPES_MODULE = 'src/lib/shared/worker-types.ts';

/** The single owner of the three Halt-latch reason unions. */
const APPROVAL_MODULE = 'src/lib/solicitation/approval.ts';

/** The single owner of `OutreachWithheldReason` — the DISPATCH half. */
const DISPATCH_MODULE = 'src/lib/solicitation/dispatch.ts';

/** The single owner of `RenderWithholdReason` — the RENDER half. */
const OUTREACH_MODULE = 'src/lib/solicitation/outreach.ts';

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

/**
 * Assert one lane map against the members of the enum it is keyed on.
 *
 * TWO CLAIMS, and the first is why this is not a loop over `Object.entries`:
 * the keys must be EXACTLY the members, so an omission and an invention both
 * fail. `satisfies Record<Enum, …>` already makes an omission a compile error,
 * but nothing at run time enumerates a bare union — this is the run-time half
 * of that guard, the same pairing title 4 states for the suspension map.
 *
 * The second claim is that every non-null value is a member of
 * `REFUSAL_CATEGORIES`, which migration 116's CHECK is the authority for. A
 * category string the CHECK rejects must not be spellable.
 */
function expectLaneMap(
  map: Readonly<Record<string, string | null>>,
  members: readonly string[],
  label: string,
): void {
  // Guard the parse: an anchor that matched nothing makes every claim vacuous.
  expect(members.length, `${label}: parsed no members`).toBeGreaterThan(0);
  expect(Object.keys(map).sort(), `${label}: keys are not exactly the members`).toEqual(
    [...members].sort(),
  );

  for (const member of members) {
    expect(Object.hasOwn(map, member), `${label}: '${member}' has no entry`).toBe(true);
    const category = map[member];
    // `null` is a decision — this code is not a Refusal — so it is skipped
    // rather than treated as a missing entry. The key check above is what
    // proves it was decided at all.
    if (category !== null) {
      expect(REFUSAL_CATEGORIES as readonly string[], `${label}: '${member}'`).toContain(category);
    }
  }
}

/**
 * `LatchHaltReason`'s members, assembled from the THREE unions it composes.
 *
 * It is not a flat quoted union — `OwnerHaltReason | 'admin_halt' |
 * SystemHaltReason` — so a single parse would see only `admin_halt`. Reading
 * all three keeps the eval anchored on the same declarations `approval.ts`
 * owns, rather than re-typing six literals here.
 *
 * `LatchHaltReason` itself is PRIVATE and stays private (`approval.test.ts`
 * pins the non-export in source text). This is the reason the vocabulary
 * re-composes the union rather than importing it, and the reason this eval
 * reads the file: source text is the only place a private union is observable,
 * so a seventh reason added there and not mapped still fails here.
 */
function latchHaltMembers(): readonly string[] {
  return [
    ...unionMembers(APPROVAL_MODULE, 'OwnerHaltReason'),
    ...unionMembers(APPROVAL_MODULE, 'LatchHaltReason'),
    ...unionMembers(APPROVAL_MODULE, 'SystemHaltReason'),
  ];
}

/**
 * The members of a bare TS union, read out of its owning module.
 *
 * `export` IS OPTIONAL IN THE ANCHOR, and that is load-bearing rather than
 * lax: `LatchHaltReason` is private by design — `approval.test.ts` asserts the
 * non-export in source text, because the union spans actor classes and an
 * exported signature accepting it could forge an actor — so requiring `export`
 * here would force a choice between reading the real declaration and leaving
 * that design intact. Reading the text needs no export.
 *
 * THE MATCH IS ANCHORED AT COLUMN ZERO for that same reason. Dropping `export`
 * from the pattern widens what it can hit, and a JSDoc line reading
 * `` * type LatchHaltReason = … `` inside a comment is exactly the shape that
 * would then match first — not a hypothetical, since this branch's own
 * deviations route a rewrite of that module's comment to #1010. A top-level
 * declaration starts at column zero in every module this reads, so requiring
 * that excludes every indented line and every comment body.
 */
function unionMembers(relativePath: string, typeName: string): readonly string[] {
  const declaration = new RegExp(`(?:^|\\n)(?:export )?type ${typeName}\\s*=([^;]*);`).exec(
    readRepoFile(relativePath),
  );
  const body = declaration?.[1];
  if (body === undefined) {
    throw new Error(`${relativePath}: could not locate \`type ${typeName}\``);
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

  it('ASK_WITHHELD_REFUSAL_CATEGORIES maps every WithholdReason and marks velocity_banked as not a Refusal', () => {
    // `WithholdReason` derives from a runtime `as const` array, so this lane
    // enumerates the members directly instead of parsing its module as text.
    expectLaneMap(ASK_WITHHELD_REFUSAL_CATEGORIES, WITHHOLD_REASONS, 'ask_withheld');

    // The one `null`, asserted by name. A banked candidate is DEFERRED, not
    // refused: the send caps held it for this build and it stays in the pool.
    expect(ASK_WITHHELD_REFUSAL_CATEGORIES.velocity_banked).toBeNull();

    // Every other member IS a Refusal. Stated as a count so a future `null`
    // added anywhere in this map fails here rather than silently shrinking
    // what the Restraint tab shows.
    const refusals = Object.values(ASK_WITHHELD_REFUSAL_CATEGORIES).filter((c) => c !== null);
    expect(refusals).toHaveLength(WITHHOLD_REASONS.length - 1);
  });

  it('OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES maps every OutreachWithheldReason to a category', () => {
    const members = unionMembers(DISPATCH_MODULE, 'OutreachWithheldReason');
    expect(members).toHaveLength(6);
    expectLaneMap(OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES, members, 'outreach_withheld/dispatch');

    // No `null` anywhere: every one of the six is RepWorth declining to send.
    expect(Object.values(OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES)).not.toContain(null);
  });

  it('OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES maps every RenderWithholdReason to a category', () => {
    const members = unionMembers(OUTREACH_MODULE, 'RenderWithholdReason');
    expect(members).toHaveLength(3);
    expectLaneMap(OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES, members, 'outreach_withheld/render');

    expect(Object.values(OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES)).not.toContain(null);
  });

  it('BATCH_HALTED_REFUSAL_CATEGORIES maps only admin_halt and platform_halt to a category and the other four to null', () => {
    const members = latchHaltMembers();
    expect(members).toHaveLength(6);
    expectLaneMap(BATCH_HALTED_REFUSAL_CATEGORIES, members, 'batch_halted');

    // The lane's whole claim: a Refusal here is a batch WE halted. The two
    // named arms are ours; the four `null`s are the owner's decision or a
    // deadline, and crediting either to RepWorth would make the tab lie.
    const ours = Object.entries(BATCH_HALTED_REFUSAL_CATEGORIES)
      .filter(([, category]) => category !== null)
      .map(([reason]) => reason)
      .sort();
    expect(ours).toEqual(['admin_halt', 'platform_halt']);
    expect(BATCH_HALTED_REFUSAL_CATEGORIES.admin_halt).toBe('autonomy_paused');
    expect(BATCH_HALTED_REFUSAL_CATEGORIES.platform_halt).toBe('autonomy_paused');
  });

  it('AUTO_POST_REVOKED_REFUSAL_CATEGORIES maps every AutoPolicyDowngradeReason to a category', () => {
    const members = unionMembers(WORKER_TYPES_MODULE, 'AutoPolicyDowngradeReason');
    expect(members).toHaveLength(6);
    expectLaneMap(AUTO_POST_REVOKED_REFUSAL_CATEGORIES, members, 'auto_post_revoked');

    expect(Object.values(AUTO_POST_REVOKED_REFUSAL_CATEGORIES)).not.toContain(null);

    // Two codes, one category, and they stay two codes: `refusal_code` is
    // stored verbatim, so the ledger records WHICH watchdog held the post.
    expect(AUTO_POST_REVOKED_REFUSAL_CATEGORIES.judge_disabled).toBe('watchdog_unavailable');
    expect(AUTO_POST_REVOKED_REFUSAL_CATEGORIES.judge_unhealthy).toBe('watchdog_unavailable');
  });

  it('every category any lane map assigns is a member of REFUSAL_CATEGORIES', () => {
    // The sweep the five per-lane cases above make individually, stated once
    // over all six maps: nothing a writer can pass reaches migration 116's
    // refusal_category CHECK as a value the CHECK rejects.
    const everyMap = [
      AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES,
      ASK_WITHHELD_REFUSAL_CATEGORIES,
      OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES,
      OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES,
      BATCH_HALTED_REFUSAL_CATEGORIES,
      AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
    ] as readonly Readonly<Record<string, string | null>>[];

    const assigned = everyMap.flatMap((map) => Object.values(map)).filter((c) => c !== null);
    expect(assigned.length).toBeGreaterThan(0);
    for (const category of assigned) {
      expect(REFUSAL_CATEGORIES as readonly string[]).toContain(category);
    }
  });

  it('the dispatch and render outreach maps stay separate and agree on the codes they share', () => {
    // SEPARATE CONSTANTS, deliberately. Both write refusal_source
    // `outreach_withheld`, but they are different WRITERS over different closed
    // enums (#997's "eleven sites, not seven"), and merging them would let a
    // dispatch-only reason type-check at a render site.
    expect(OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES).not.toBe(
      OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES,
    );

    const dispatchKeys = Object.keys(OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES);
    const renderKeys = Object.keys(OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES);
    expect(dispatchKeys).not.toEqual(renderKeys);

    // The overlap is REAL and must never disagree: the dispatch gate re-lints
    // and re-moderates the stored copy at send time, so one code carrying two
    // categories would put the same fact in two places on the Restraint tab.
    const shared = renderKeys.filter((key) => dispatchKeys.includes(key));
    expect(shared.sort()).toEqual(['lint_failed', 'moderation_high']);
    for (const key of shared) {
      const dispatch = OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES as Record<string, string>;
      const render = OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES as Record<string, string>;
      expect(render[key], `'${key}' disagrees between the two halves`).toBe(dispatch[key]);
    }
  });

  it('vocabulary.ts imports no value at runtime, so the Restraint tab may import it', () => {
    // The Restraint tab (#1014) is a `'use client'` surface and Next polyfills
    // no `node:`-prefixed builtin, so ONE value import whose graph reaches
    // `node:crypto` enters the browser bundle silently. Invariant #1's runtime
    // ban covers src/app/** and src/components/**, not this file — there is no
    // ESLint rule behind this, which is why the assertion is here.
    //
    // THREE WAYS A VALUE CAN ENTER A MODULE, and an earlier version of this case
    // checked only the first — a re-export or a dynamic import would have passed
    // it silently while pulling the same graph in.
    //
    //   1. `import …`      — a plain statement. Only a CONTINUATION line of a
    //                        multi-line import fails to start with `import`, so
    //                        matching the first line of each statement is enough.
    //   2. `export … from` — a re-export is an import with a different name, and
    //                        `export type … from` is the only erased form.
    //   3. `import(…)`     — dynamic, never erased, and legal anywhere in the
    //                        file rather than only at the top.
    const source = readRepoFile(VOCABULARY_MODULE);
    const lines = source.split('\n');

    const runtimeImports = lines.filter(
      (line) => /^import\s/.test(line) && !/^import type\s/.test(line),
    );
    const runtimeReExports = lines.filter(
      (line) => /^export\s/.test(line) && /\sfrom\s/.test(line) && !/^export type\s/.test(line),
    );
    const dynamicImports = lines.filter((line) => /\bimport\s*\(/.test(line));

    expect(runtimeImports, 'every import in vocabulary.ts must be `import type`').toEqual([]);
    expect(runtimeReExports, 'a re-export pulls the same graph an import would').toEqual([]);
    expect(dynamicImports, 'a dynamic import is never erased at compile time').toEqual([]);
  });
});
