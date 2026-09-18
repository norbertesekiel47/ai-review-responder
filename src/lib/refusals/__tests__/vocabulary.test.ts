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
// Run E extends the effective vocabulary with migration 121. These projection
// comparisons read its lists; migration-121's executable integration suite
// separately proves database behavior and unchanged access posture.
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
  AUTO_APPROVAL_BLOCK_PRECEDENCE,
  AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
  AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES,
  BATCH_HALTED_REFUSAL_CATEGORIES,
  OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES,
  OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES,
  POLICY_GATE_HELD_REFUSAL_CATEGORIES,
  REFUSAL_CATEGORIES,
  REFUSAL_SOURCES,
  REFUSAL_SUBJECT_TYPES,
  REFUSAL_VOCABULARY_VERSION,
  resolvePolicyGateRefusal,
} from '../vocabulary';
// NAMESPACE import for the four exports #1013 T3 and T4 add. A named import of
// an export that does not exist yet fails the whole FILE at collection, which at
// the RED phase would take every pre-existing case down with it. Same reason
// `write.integration.test.ts` reaches its set-based arm this way.
import * as vocabulary from '../vocabulary';
// TYPE-ONLY, so the namespace-import rule above does not apply: `import type`
// erases before the module is ever loaded, so it cannot fail at collection the
// way a value import of a missing export would. These two are #1080's whole
// deliverable — the derivation and the constraint that consumes it.
import type { AssertNever, UnrankedIn } from '../vocabulary';

/** The table under test. Applied to staging and production; never edited here. */
const VOCABULARY_MIGRATION = 'supabase/migrations/121_operator_refusals.sql';

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
  return readRepoFile(VOCABULARY_MIGRATION)
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
    throw new Error(`${VOCABULARY_MIGRATION}: could not locate the ${column} CHECK member list`);
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
  it("REFUSAL_SOURCES lists exactly the nine lanes migration 121's refusal_source CHECK admits, in the migration's order", () => {
    const admitted = columnCheckMembers('refusal_source');

    // Guard the parse itself: an anchor that silently matched nothing would
    // make every assertion below vacuous.
    expect(admitted).toHaveLength(9);

    // ORDERED, not sorted. A Refusal source is the LANE, and the lane order is
    // the migration's — `policy_gate_held` joined the parent effort's six in
    // #1003 and sits last there, so a TypeScript copy that re-sorts them is
    // already a second authority.
    expect([...REFUSAL_SOURCES]).toEqual([...admitted]);
  });

  it("REFUSAL_CATEGORIES lists exactly the nine categories migration 121's refusal_category CHECK admits, in the migration's order", () => {
    const admitted = columnCheckMembers('refusal_category');

    // Eight: `owner_review_required` was coined in #998 and joined the closed
    // seven the parked branch shipped.
    expect(admitted).toHaveLength(9);
    expect([...REFUSAL_CATEGORIES]).toEqual([...admitted]);
  });

  it("REFUSAL_SUBJECT_TYPES lists exactly the five subject types migration 121's subject_type CHECK admits", () => {
    const admitted = columnCheckMembers('subject_type');

    expect(admitted).toHaveLength(5);
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

// ---------------------------------------------------------------------------
// #1013 — the `policy_gate_held` map, its precedence, and the `held_draft`
// literal. Titles 1-9 and 12, VERBATIM from `.feature/intake.json`.
//
// NAMESPACE ACCESS, NOT NAMED IMPORTS, for the four exports T3 and T4 add. A
// named import of an export that does not exist yet fails the whole FILE at
// collection, which at the RED phase would take the thirty-odd pre-existing
// cases above down with it and hide which case actually failed. Same reason
// `write.integration.test.ts` reaches its set-based arm this way.
//
// The accessors below throw a NAMED error rather than returning undefined, so a
// RED run reads as "T3/T4 has not landed" instead of a `TypeError` on
// `undefined`.
// ---------------------------------------------------------------------------

/**
 * The 22-member map's authority is a bare TYPE union, which nothing can
 * enumerate at run time, so this parses it out of its owning module exactly as
 * title 4 does for `AutonomySuspensionTrigger`.
 *
 * It reads `WORKER_TYPES_MODULE` because #1013 T2 MOVES the declaration there,
 * on the `AutonomySuspensionTrigger` / `AutoPolicyDowngradeReason` precedent:
 * `vocabulary.ts` must NAME the union to type its map, and no production module
 * under `src/lib/` imports from `worker/`. Before T2 lands, `unionMembers`
 * throws here — the intended RED, and per-case rather than at collection.
 */
function autoApprovalBlockReasons(): readonly string[] {
  return unionMembers(WORKER_TYPES_MODULE, 'AutoApprovalBlockReason');
}

function policyGateMap(): Readonly<Record<string, string | null>> {
  const map = (vocabulary as Record<string, unknown>).POLICY_GATE_HELD_REFUSAL_CATEGORIES;
  if (map === undefined) {
    throw new Error('POLICY_GATE_HELD_REFUSAL_CATEGORIES is not exported yet (#1013 T4)');
  }
  return map as Readonly<Record<string, string | null>>;
}

function blockPrecedence(): readonly string[] {
  const order = (vocabulary as Record<string, unknown>).AUTO_APPROVAL_BLOCK_PRECEDENCE;
  if (order === undefined) {
    throw new Error('AUTO_APPROVAL_BLOCK_PRECEDENCE is not exported yet (#1013 T4)');
  }
  return order as readonly string[];
}

interface ResolvedRefusal {
  refusalCode: string;
  refusalCategory: string;
  allRefusalCodes: readonly string[];
}

function resolve(codes: readonly string[]): ResolvedRefusal | null {
  const fn = (vocabulary as Record<string, unknown>).resolvePolicyGateRefusal;
  if (typeof fn !== 'function') {
    throw new Error('resolvePolicyGateRefusal is not exported yet (#1013 T4)');
  }
  return (fn as (c: readonly string[]) => ResolvedRefusal | null)(codes);
}

function heldDraftCategory(): unknown {
  const value = (vocabulary as Record<string, unknown>).HELD_DRAFT_REFUSAL_CATEGORY;
  if (value === undefined) {
    throw new Error('HELD_DRAFT_REFUSAL_CATEGORY is not exported yet (#1013 T3)');
  }
  return value;
}

/** The veto set is DERIVED, never restated — a null value in the map IS the veto. */
function vetoMembers(): readonly string[] {
  const map = policyGateMap();
  return Object.keys(map).filter((member) => map[member] === null);
}

/**
 * #1003's locked tier order, most durable veto first.
 *
 * This IS restated here, and it is the one place restatement is correct: it is
 * the claim under test. `REFUSAL_CATEGORIES` must NOT be used as the
 * expectation — #1003 rejected that agreement test outright, because the two
 * orders legitimately disagree on `below_our_bar` (3rd there, 5th here) and
 * `missing_information` (last there, 4th here), and coupling them would falsify
 * #995's "a reorder is presentation only" ruling.
 */
const LOCKED_TIER_ORDER = [
  'unsafe_content',
  'watchdog_unavailable',
  'autonomy_paused',
  'missing_information',
  'below_our_bar',
  'owner_review_required',
] as const;

describe('Refusal ledger vocabulary — policy_gate_held (#1013)', () => {
  it('every AutoApprovalBlockReason member appears exactly once across the veto set and the precedence list', () => {
    const members = autoApprovalBlockReasons();
    expect(members.length, 'parsed no AutoApprovalBlockReason members').toBe(22);

    const map = policyGateMap();
    expectLaneMap(map, members, 'policy_gate_held');

    const veto = vetoMembers();
    const precedence = blockPrecedence();

    // The PARTITION is the claim: veto and precedence are disjoint, their union
    // is every member, and neither holds a duplicate. A 23rd member added to the
    // union later fails HERE rather than resolving to no category and silently
    // writing no row.
    expect(new Set(precedence).size, 'precedence holds a duplicate').toBe(precedence.length);
    expect(
      precedence.filter((member) => veto.includes(member)),
      'a member is in both the veto set and the precedence list',
    ).toEqual([]);
    expect(
      [...veto, ...precedence].sort(),
      'veto + precedence is not exactly the 22 members',
    ).toEqual([...members].sort());

    // The counts #1003 locked, stated so a silent re-partition is visible.
    expect(veto.length, 'the veto set is seven members').toBe(7);
    expect(precedence.length, 'the precedence list is fifteen members').toBe(15);
  });

  it('AUTO_APPROVAL_BLOCK_PRECEDENCE groups its members into the six locked category tiers in order', () => {
    const map = policyGateMap();
    const tiers = blockPrecedence().map((member) => map[member]);

    // Each tier must be CONTIGUOUS and the tiers must appear in the locked
    // order. Collapsing to a de-duplicated sequence proves both at once: a
    // member that strayed out of its tier reappears as a repeated tier later.
    const collapsed = tiers.filter((tier, index) => index === 0 || tier !== tiers[index - 1]);
    expect(collapsed, 'tiers are not contiguous, or not in the locked order').toEqual([
      ...LOCKED_TIER_ORDER,
    ]);
  });

  it('resolvePolicyGateRefusal returns null when any veto member is present, whatever its position', () => {
    const veto = vetoMembers();
    const precedenceMember = blockPrecedence()[0]!;

    for (const vetoMember of veto) {
      expect(resolve([vetoMember]), `${vetoMember} alone must veto`).toBeNull();
      expect(resolve([vetoMember, precedenceMember]), `${vetoMember} first must veto`).toBeNull();
      expect(resolve([precedenceMember, vetoMember]), `${vetoMember} last must veto`).toBeNull();
    }
  });

  it('resolvePolicyGateRefusal picks the highest precedence tier present, not the evaluation order', () => {
    const precedence = blockPrecedence();
    const map = policyGateMap();

    // REVERSED input, so a resolver that simply took the first element it saw
    // would return the LOWEST-ranked member and fail every assertion below.
    for (let i = 0; i < precedence.length; i += 1) {
      const window = precedence.slice(i);
      const resolved = resolve([...window].reverse());
      expect(resolved?.refusalCode, `window from ${window[0]}`).toBe(window[0]);
      expect(resolved?.refusalCategory).toBe(map[window[0]!]);
    }
  });

  it('resolvePolicyGateRefusal returns the winner as a member of the co-occurring set it won', () => {
    const precedence = blockPrecedence();
    // DELIBERATELY NEITHER ALPHABETICAL NOR PRECEDENCE-ORDERED. An earlier
    // version used indices [6, 1, 13], which happened to be alphabetical
    // ascending — so a resolver that SORTED the set passed the order assertion
    // below (red-team round 2, RT-8). This ordering is descending by precedence
    // rank and unsorted alphabetically, so `.sort()` and `.reverse()` both die.
    const input = [precedence[13]!, precedence[6]!, precedence[1]!];
    const resolved = resolve(input);

    // C5 requires membership in the DATABASE. This is the same claim one layer
    // up, so a row can never be rejected at INSERT for a resolver bug.
    expect(resolved).not.toBeNull();
    expect(resolved!.allRefusalCodes).toContain(resolved!.refusalCode);
    // The winner is the highest-ranked member present, not the first supplied.
    expect(resolved!.refusalCode).toBe(precedence[1]);
    // The set is the input VERBATIM, in its own order — the evaluation order is
    // itself evidence for support, and reordering it would discard that.
    expect(resolved!.allRefusalCodes).toEqual(input);
  });

  it('resolvePolicyGateRefusal throws on a code in neither the veto set nor the precedence list', () => {
    // An unrecognised code is a FAULT, not a category (docs/context/refusal-ledger.md → Refusal
    // category). A default would file an unmapped refusal under a
    // plausible-looking heading and the owner could not tell the difference.
    expect(() => resolve(['not_a_block_reason'])).toThrow(/not_a_block_reason/);
    expect(() => resolve([blockPrecedence()[0]!, 'not_a_block_reason'])).toThrow(
      /not_a_block_reason/,
    );
  });

  it('resolvePolicyGateRefusal returns null for an empty block reason list', () => {
    // An approved draft. No decision was made, so there is nothing to record —
    // and C5 rejects an empty array outright, so a row here could not be stored.
    expect(resolve([])).toBeNull();
  });

  it('a suspended week resolves policy_suspended and rating_below_threshold to autonomy_paused', () => {
    // #1003's deciding case: 45 drafts each carrying both codes must report
    // "Autonomy paused — 45", never "Sent to you — 45". Reusing
    // evaluateAutoApprovalCandidate's evaluation order would report the latter,
    // which is why that order is rejected as a precedence.
    const resolved = resolve(['rating_below_threshold', 'policy_suspended']);
    expect(resolved?.refusalCategory).toBe('autonomy_paused');
    expect(resolved?.refusalCode).toBe('policy_suspended');
  });

  it('a downgraded Autopilot account on a two-star review resolves to no Refusal', () => {
    // The policy row survives a downgrade (`auto-policy-downgrade.ts`), so the
    // draft is still evaluated. Telling the owner "We wanted you to decide this
    // one" would be false: the account holds no Autopilot, so that draft was
    // always going to them and we chose nothing.
    expect(resolve(['autopilot_tier_required', 'rating_below_positive_quadrant'])).toBeNull();
  });

  it('HELD_DRAFT_REFUSAL_CATEGORY is the frozen unsafe_content literal', () => {
    expect(heldDraftCategory()).toBe('unsafe_content');
    // A member of the closed set migration 116's CHECK admits. #1001 REJECTED a
    // CHECK pinning this lane to this category — true today, but it would make a
    // future re-map migration-bearing. The vocabulary owns the mapping; the
    // database owns the closed set.
    expect(columnCheckMembers('refusal_category')).toContain(heldDraftCategory());
  });
});

/**
 * #1080 — the precedence list's TOTALITY, moved from a run-time assertion into
 * the type system.
 *
 * WHY `@ts-expect-error` AND NOT A MATCHER. `pnpm typecheck` is where these two
 * cases fire: the repo has no `expectTypeOf` call and no vitest `typecheck`
 * block anywhere, so `@ts-expect-error` is the only type-level assertion the
 * tooling here supports, and the inversion IS the assertion — the day a
 * directive stops being necessary it becomes `TS2578` itself. Test files are
 * inside `tsconfig.json`'s `include`, so the gate's `typecheck` row (separate
 * from its `lint` row) sees them. Precedent: `write.test.ts`'s
 * `occurredAt` case.
 *
 * WHY NOT THE REPO'S OTHER COMPILE-TIME ASSERTION SHAPE, and the departure is
 * deliberate rather than unconsidered (`working-rules.md` asks for the precedent
 * to be named). The one existing example is
 * `src/lib/solicitation/__tests__/restraint-policy.test.ts`'s
 * `'is sentiment-blind at the TYPE level, not only in serialized output'`, which
 * declares `type AssertSentimentBlind<T> = … extends never ? true : never` and
 * consumes it as `const candidateIsBlind: AssertSentimentBlind<AskCandidate> =
 * true`. That shape works and stays; it is not copied here because its failure
 * is a `TS2322` reading "Type 'true' is not assignable to type 'never'." —
 * MEASURED by compiling that alias shape over a seeded type under this repo's
 * own `tsc`, not recalled. An earlier version of this paragraph quoted it as
 * `'boolean'` and was simply wrong: TypeScript reports the LITERAL type of the
 * initializer here (red-team round 2, RT1080-10). What matters either way is
 * that the message names a type, never the offending MEMBER. Naming the
 * unranked member is this ticket's entire deliverable, and only a constraint
 * violation (`TS2344` on `AssertNever<T extends never>`) prints it.
 *
 * WHY THE HOLE IS SEEDED IN THE TYPE ARGUMENT rather than in the production
 * tuple. `UnrankedIn<P>` is parameterized precisely so a hole can be seeded
 * without editing `vocabulary.ts`; the case then routes through the REAL
 * `RankableBlockReason` (and so the real map) and a real precedence tuple. That
 * makes this a permanent committed proof that the derivation fires, not one-shot
 * red-step evidence that can go stale.
 *
 * Each case carries a run-time companion, and neither is decoration: they assert
 * that the seeded hole is a REAL hole and that the probe is a REAL non-member,
 * so a precedence edit that made either premise false fails here rather than
 * quietly making the compile-time half vacuous.
 */
describe('Refusal ledger vocabulary — precedence totality (#1080)', () => {
  it('the precedence totality derivation rejects a precedence list missing a mapped rank', () => {
    type Ranks = typeof vocabulary.AUTO_APPROVAL_BLOCK_PRECEDENCE;
    type Holed = readonly Exclude<Ranks[number], 'daily_cap_exhausted'>[];

    // @ts-expect-error — dropping a rank leaves daily_cap_exhausted unranked
    type _Holed = AssertNever<UnrankedIn<Holed>>;

    // The premises the directive above depends on. If `daily_cap_exhausted` ever
    // leaves the precedence list or gains a `null` mapping, `Holed` stops being
    // holed, the directive becomes unnecessary, and TS2578 fails the typecheck
    // row — but these two lines say WHICH premise moved.
    expect(blockPrecedence(), 'daily_cap_exhausted is no longer ranked').toContain(
      'daily_cap_exhausted',
    );
    expect(policyGateMap().daily_cap_exhausted, 'daily_cap_exhausted is now a veto').not.toBeNull();
  });

  it('the precedence totality derivation accepts the current precedence list unchanged', () => {
    type Ranks = typeof vocabulary.AUTO_APPROVAL_BLOCK_PRECEDENCE;

    // NO directive, and its absence is the assertion: the shipped list ranks
    // every mapped member, so this resolves to `never` and compiles silently.
    type _Whole = AssertNever<UnrankedIn<Ranks>>;

    // ANTI-VACUITY, and it is the guard this case exists for. If
    // `AUTO_APPROVAL_BLOCK_PRECEDENCE` were ever respelled as a type ANNOTATION
    // — `const AUTO_APPROVAL_BLOCK_PRECEDENCE: readonly AutoApprovalBlockReason[]
    // = [...]` — `Ranks[number]` would widen to the whole 22-member union,
    // `UnrankedIn<Ranks>` would be `never` for the WRONG reason, and `_Whole`
    // would pass while proving nothing. `'moderation_held'` would then be
    // assignable, the directive below would be unnecessary, and TS2578 would
    // fail the typecheck row.
    //
    // MEASURED, because the obvious guess is wrong: dropping `as const` alone
    // does NOT widen anything and produces ZERO diagnostics. `satisfies readonly
    // AutoApprovalBlockReason[]` contextually types the elements, so the fifteen
    // literals survive with or without `as const` and `_Whole` keeps asserting.
    // The `as const` earns its place elsewhere (it freezes the ORDER into a
    // tuple type); it is the `satisfies` clause that this guard watches.
    // @ts-expect-error — moderation_held is a veto member, never a rank
    const notARank: Ranks[number] = 'moderation_held';

    expect(blockPrecedence(), 'moderation_held is now ranked').not.toContain(notARank);
  });

  it('resolvePolicyGateRefusal still throws unmapped_auto_approval_block_reason for a code in neither list', () => {
    // The REVERSE hole, and the case above it in the resolver. #1080 closes the
    // unranked hole at compile time; the unmapped one was already closed by the
    // map's own `satisfies`. The anchored regex pins the exact fault name, so
    // the pre-existing case at `'resolvePolicyGateRefusal throws on a code in
    // neither the veto set nor the precedence list'` (which matches loosely on
    // the offending code) is not merely restated here.
    expect(() => resolve(['not_a_block_reason'])).toThrow(
      /^unmapped_auto_approval_block_reason:not_a_block_reason$/,
    );

    // And the veto pass runs over EVERY member before any ranking, so an
    // unmapped code is still a fault when it arrives behind a ranked one.
    expect(() => resolve([blockPrecedence()[0]!, 'not_a_block_reason'])).toThrow(
      /^unmapped_auto_approval_block_reason:not_a_block_reason$/,
    );

    // BOTH NAMES, and the second one is asserted from SOURCE TEXT because it can
    // no longer be provoked at run time — an `unranked` throw needs a mapped
    // member with no rank, which is exactly what `_PrecedenceIsTotal` now makes a
    // compile error. Without this, a resolver that collapsed the two faults into
    // one name would pass the two expectations above unchanged, and support could
    // not tell a missing map entry from a missing rank. The regexes above prove
    // the unmapped path does not report as `unranked`; these two lines prove the
    // module still declares a SECOND, differently-named fault for the other hole.
    //
    // MATCHED ON THE TEMPLATE TEXT ONLY, never on the interpolated expression.
    // The first spelling of these two assertions included `${code}` and
    // `${blockReasons.join(',')}`, so renaming the resolver's loop variable —
    // a behaviour-preserving refactor that moves no fault name — failed this
    // case reporting "the unmapped fault lost its own name", which was untrue
    // (red-team round 2, RT1080-08). An oracle that reports a false cause on a
    // refactor teaches the next reader to distrust it. The literal prefix up to
    // the `:` is the part a rename cannot move, and it is also the part support
    // greps for in a log line.
    const source = readRepoFile(VOCABULARY_MODULE);
    expect(
      source,
      'vocabulary.ts no longer throws an Error whose message text begins `unmapped_auto_approval_block_reason:`',
    ).toContain('new Error(`unmapped_auto_approval_block_reason:');
    expect(
      source,
      'vocabulary.ts no longer throws a SECOND, differently named Error whose message text begins `unranked_auto_approval_block_reason:` — the two faults may have been folded into one',
    ).toContain('new Error(`unranked_auto_approval_block_reason:');
  });

  it('resolvePolicyGateRefusal resolves the same winner for every locked tier after the change', () => {
    const precedence = blockPrecedence();
    const map = policyGateMap();

    // WHAT THIS CASE CAN AND CANNOT DETECT, stated because an earlier spelling
    // derived both sides from `precedence.filter(...)` and so detected NEITHER.
    // A CROSS-tier move is owned by the contiguity case
    // ('AUTO_APPROVAL_BLOCK_PRECEDENCE groups its members into the six locked
    // category tiers in order'). A WITHIN-tier swap is deliberately unpinned —
    // `vocabulary.ts` records that within-tier order changes the stored
    // `refusal_code` only, carries no `vocabulary_version` obligation, and has no
    // contract to break. So this case pins the three claims that are left, and
    // each is derived independently of the thing it checks:
    //
    //   1. TIER MEMBERSHIP comes from the MAP's key order, never from
    //      `precedence`. A member mapped to a category and dropped from the
    //      precedence list therefore still appears in `members`, where filtering
    //      `precedence` could not contain it at all. The per-tier rank assertion
    //      below is what reports it, and it runs FIRST — it names the tier and
    //      lists the unranked members. (An earlier version of this bullet said
    //      the member "blows up in `resolve` below with
    //      `unranked_auto_approval_block_reason` naming it". That narration
    //      pre-dated the per-tier assertion and was wrong twice over: the
    //      assertion pre-empts the resolver, and the resolver would only throw
    //      if EVERY member of the tier had lost its rank — with one ranked
    //      member left, `find` still elects a winner and nothing throws.
    //      Red-team round 2, RT1080-09.)
    //   2. ORDER-INVARIANCE: the resolver elects by rank, not by input position,
    //      so the forward and reversed inputs must agree. Both sides here come
    //      from the resolver on different inputs, so nothing cancels out.
    //   3. The reported CATEGORY is the map's, not one derived from position.
    for (const tier of LOCKED_TIER_ORDER) {
      const members = Object.keys(map).filter((member) => map[member] === tier);
      expect(members.length, `tier ${tier} has no members`).toBeGreaterThan(0);

      // (1) Every mapped member of this tier holds a rank. This is #1080's
      // run-time half, stated per tier.
      expect(
        members.filter((member) => !precedence.includes(member)),
        `tier ${tier} has mapped members with no rank`,
      ).toEqual([]);

      const forward = resolve(members);
      const reversed = resolve([...members].reverse());

      // (2) Reversing the input cannot change the winner.
      expect(reversed?.refusalCode, `tier ${tier} elects by input position`).toBe(
        forward?.refusalCode,
      );
      // …and the winner is the tier's highest-ranked member, read off precedence.
      expect(forward?.refusalCode, `tier ${tier} elected the wrong member`).toBe(
        precedence.find((member) => members.includes(member)),
      );
      // (3) The category is the map's.
      expect(forward?.refusalCategory, `tier ${tier} reported the wrong category`).toBe(tier);
    }
  });
});

// ── Safety review block reason (G4-F1) ─────────────────────────────────────
//
// Plan round-1 finding 12: mapping the reason is NOT sufficient.
// `AUTO_APPROVAL_BLOCK_PRECEDENCE` is a second, separately compile-enforced
// seam (`_PrecedenceIsTotal`, vocabulary.ts:660), and `resolvePolicyGateRefusal`
// reads BOTH — the map for the veto, the tuple for the winner. A test that
// exercised only the map would pass while `pnpm typecheck` stayed red.

describe('safety_review_not_cleared', () => {
  it('maps safety_review_not_cleared to a refusal category', () => {
    expect(Object.hasOwn(POLICY_GATE_HELD_REFUSAL_CATEGORIES, 'safety_review_not_cleared')).toBe(
      true,
    );
    // It is a SAFETY veto, not a structural one: the draft named unsafe content
    // (or the check that looks for it failed), so it belongs with
    // moderation_flagged and triage_high_severity rather than with the
    // "we could not evaluate the policy" reasons.
    expect(POLICY_GATE_HELD_REFUSAL_CATEGORIES.safety_review_not_cleared).toBe(
      POLICY_GATE_HELD_REFUSAL_CATEGORIES.moderation_flagged,
    );
    expect(AUTO_APPROVAL_BLOCK_PRECEDENCE).toContain('safety_review_not_cleared');
  });

  it('resolves safety_review_not_cleared through the production refusal resolver with the declared category precedence', () => {
    // Alone: the production resolver, not the map, is what runs in the
    // deciding transaction.
    const alone = resolvePolicyGateRefusal(['safety_review_not_cleared']);
    expect(alone).not.toBeNull();
    expect(alone?.refusalCode).toBe('safety_review_not_cleared');

    // Alongside another category: this is the half that exercises the tuple's
    // POSITION. `moderation_flagged` is precedence tier 1, so it wins whichever
    // order the gate emitted them in.
    for (const order of [
      ['safety_review_not_cleared', 'moderation_flagged'],
      ['moderation_flagged', 'safety_review_not_cleared'],
    ] as const) {
      const together = resolvePolicyGateRefusal(order);
      expect(together?.refusalCode).toBe('moderation_flagged');
      expect(together?.allRefusalCodes).toEqual(expect.arrayContaining(['safety_review_not_cleared']));
    }
  });
});
