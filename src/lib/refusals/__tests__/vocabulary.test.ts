// The Refusal Log eval — vocabulary and mapping half.
//
// Every title here is VERBATIM from `docs/superpowers/plans/feat-refusal-log-intake.json`
// `tests_to_add`; the `promised-tests` gate row matches them as fixed strings,
// so a reworded title reads as an unwritten test.
//
// T0 wrote this file red, with every mapping case as `it.todo`, because a static
// import of a not-yet-written module fails the whole FILE at collection (vite's
// ssr transform validates the specifier) and a collection failure runs none of
// its cases. T1 created `src/lib/refusals/vocabulary.ts`, so the import below is
// real and the todos are real cases.
//
// WHY SOME AUTHORITIES ARE PARSED RATHER THAN IMPORTED. Three of the five source
// vocabularies have no runtime enumeration to assert against:
//
//   - `AutoPolicyDowngradeReason` and `AutonomySuspensionTrigger` are bare TYPE
//     unions. `satisfies Record<Enum, …>` makes an ADDED member a compile error,
//     but nothing at run time can list them — so those cases parse the union out
//     of its owning module rather than re-spelling six and four literals here,
//     which would fork the enum into the test that is supposed to guard it.
//   - the batch halt list and the full outreach withheld vocabulary have no TS
//     owner at all; their authority is the migration 111 CHECK (plan §3 says so
//     explicitly), and those cases parse that SQL.
//
// `WithholdReason` is the exception that proves the rule: `WITHHOLD_REASONS` is
// a real exported `as const` array, so its case iterates the array itself.
//
// Plan: docs/superpowers/plans/feat-refusal-log-plan.md §3 (the vocabulary and
// the category feeder table).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WITHHOLD_REASONS } from '@/lib/solicitation/restraint-policy';
import {
  ASK_WITHHELD_REFUSAL_CATEGORIES,
  AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES,
  AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
  BATCH_HALTED_REFUSAL_CATEGORIES,
  BATCH_HALT_REASONS,
  OUTREACH_NON_REFUSAL_CATEGORIES,
  OUTREACH_WITHHELD_REASONS,
  OUTREACH_WITHHELD_REFUSAL_CATEGORIES,
  REFUSAL_CATEGORIES,
  REFUSAL_CATEGORY_META,
  UnknownRefusalCodeError,
  refusalCategoryFor,
  type RefusalCategory,
  type RefusalSource,
} from '../vocabulary';

/** The migration that owns the authoritative outreach disposition vocabulary. */
const MIGRATION_111 = 'supabase/migrations/111_platform_halt_reason.sql';

/** The mapping module T1 created. Read as TEXT by the exhaustiveness case below. */
const VOCABULARY_MODULE = 'src/lib/refusals/vocabulary.ts';

function readRepoFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

/** Every single-quoted lower_snake literal in a fragment, in order. */
function quotedMembers(fragment: string): readonly string[] {
  return [...fragment.matchAll(/'([a-z_]+)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * The `withheld` arm of 111's `solicitation_outreach_status_reason_consistency`
 * CHECK. Plan §3: this vocabulary is authoritative ONLY in the migration — it is
 * fragmented across partial TypeScript unions, so `satisfies Record<…>` cannot
 * guard it and this parse is the guard instead.
 */
function withheldDispositionVocabulary(): readonly string[] {
  const arm =
    /delivery_status\s*=\s*'withheld'\s+AND\s+disposition_reason\s+IN\s*\(([^)]*)\)/i.exec(
      readRepoFile(MIGRATION_111),
    );
  const members = arm?.[1];
  if (members === undefined) {
    throw new Error(`${MIGRATION_111}: could not locate the withheld arm of the outreach CHECK`);
  }
  return quotedMembers(members);
}

/**
 * The reason list of 111's `solicitation_batches_halt_consistency` CHECK. The
 * anchor is the `halt_reason IS NULL OR` prefix, because that constraint's ACTOR
 * arm contains a SECOND, narrower `halt_reason IN (…)` which must not be read as
 * the vocabulary — 111 deliberately left it at three members.
 */
function batchHaltVocabulary(): readonly string[] {
  const arm = /halt_reason\s+IS\s+NULL\s+OR\s+halt_reason\s+IN\s*\(([^)]*)\)/i.exec(
    readRepoFile(MIGRATION_111),
  );
  const members = arm?.[1];
  if (members === undefined) {
    throw new Error(`${MIGRATION_111}: could not locate the halt_reason list of the batch CHECK`);
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

/**
 * The shared assertion behind the five "maps to a RefusalCategory or explicit
 * null" cases: the map's keys are EXACTLY the authority's members (an omission
 * and an invention both fail), and every value is a real category or an explicit
 * `null`. `Object.hasOwn` rather than a truthiness check, because `null` is the
 * decision and `undefined` is the omission — conflating them is the whole bug
 * this rule exists to prevent.
 */
function expectTotalMapping(
  map: Readonly<Record<string, RefusalCategory | null>>,
  authority: readonly string[],
  label: string,
): void {
  expect([...Object.keys(map)].sort(), `${label}: mapped codes`).toEqual([...authority].sort());
  for (const code of authority) {
    expect(Object.hasOwn(map, code), `${label}: '${code}' has no entry`).toBe(true);
    // `undefined` is deliberately NOT accepted here: under
    // `noUncheckedIndexedAccess` it is exactly the omission `null` is the
    // decision against, and collapsing the two would make this case vacuous.
    const category = map[code];
    expect(
      category === null || (category !== undefined && REFUSAL_CATEGORIES.includes(category)),
      `${label}: '${code}' maps to ${JSON.stringify(category)} — neither a RefusalCategory nor null`,
    ).toBe(true);
  }
}

describe('refusal vocabulary', () => {
  it('every WithholdReason maps to a RefusalCategory or explicit null', () => {
    expectTotalMapping(ASK_WITHHELD_REFUSAL_CATEGORIES, WITHHOLD_REASONS, 'WithholdReason');
  });

  it('every AutoPolicyDowngradeReason maps to a RefusalCategory or explicit null', () => {
    const authority = unionMembers(
      'worker/jobs/publisher/auto-policy-downgrade.ts',
      'AutoPolicyDowngradeReason',
    );
    expect(authority.length, 'parsed no AutoPolicyDowngradeReason members').toBeGreaterThan(0);
    expectTotalMapping(AUTO_POST_REVOKED_REFUSAL_CATEGORIES, authority, 'AutoPolicyDowngradeReason');
  });

  // ── S3's SECOND key space moved out of this file (T4 §A, deviations D13).
  //
  // `approval_audit_log.action` holds one of FIVE audit actions rather than one
  // of six downgrade reasons, and reaching those action literals means a VALUE
  // import of `@/lib/approval/audit`, whose graph carries `node:crypto`. That
  // made `vocabulary.ts` unusable from a `'use client'` component (D12b's
  // carry-forward), so the action key space, its derivation and its four cases
  // now live with the only code that ever sees a stored action —
  // `../read.ts` and `./read.test.ts`. Titles moved verbatim.

  it('every AutonomySuspensionTrigger maps to a RefusalCategory or explicit null', () => {
    const authority = unionMembers('src/lib/shared/worker-types.ts', 'AutonomySuspensionTrigger');
    expect(authority.length, 'parsed no AutonomySuspensionTrigger members').toBeGreaterThan(0);
    expectTotalMapping(AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES, authority, 'AutonomySuspensionTrigger');
  });

  it('every batch halt reason maps to a RefusalCategory or explicit null', () => {
    const authority = batchHaltVocabulary();
    // The locally declared closed constant must equal the migration's list. That
    // equality is what earns the `satisfies Record<BatchHaltReason, …>` guard on
    // the map, since the batch halt reasons have no TypeScript owner to satisfy.
    expect([...BATCH_HALT_REASONS], 'BATCH_HALT_REASONS vs the migration 111 CHECK').toEqual([
      ...authority,
    ]);
    expectTotalMapping(BATCH_HALTED_REFUSAL_CATEGORIES, authority, 'batch halt reason');
  });

  it('every solicitation_outreach withheld disposition_reason maps to a RefusalCategory or explicit null', () => {
    const authority = withheldDispositionVocabulary();
    expect([...OUTREACH_WITHHELD_REASONS], 'OUTREACH_WITHHELD_REASONS vs the CHECK').toEqual([
      ...authority,
    ]);
    expectTotalMapping(
      OUTREACH_WITHHELD_REFUSAL_CATEGORIES,
      authority,
      'outreach withheld disposition_reason',
    );
  });

  // The CHECK half pins 111's vocabulary so a later widening cannot slip past
  // unmapped; the module half proves every member reaches the mapping file.
  it('the outreach withheld disposition mapping is exhaustive against the migration 111 CHECK vocabulary', () => {
    const codes = withheldDispositionVocabulary();
    expect(codes).toEqual([
      'moderation_high',
      'render_failed',
      'lint_failed',
      'no_consent',
      'suppressed',
      'unsubscribed',
      'no_postal_address',
      'postal_address_mismatch',
    ]);

    const modulePath = join(process.cwd(), VOCABULARY_MODULE);
    expect(
      existsSync(modulePath),
      `${VOCABULARY_MODULE} does not exist yet — T1 creates it`,
    ).toBe(true);

    const source = readFileSync(modulePath, 'utf8');
    const unmapped = codes.filter((code) => !source.includes(`'${code}'`) && !source.includes(`${code}:`));
    expect(unmapped, 'outreach withheld codes with no entry in the refusal mapping').toEqual([]);
  });

  // Intake `non_goals`, one entry per excluded code. `null` is the DECISION "not
  // a refusal", so the assertion is `hasOwn` AND `=== null`, never absence.
  it('every excluded source code maps explicitly to null', () => {
    const excluded: readonly [Readonly<Record<string, RefusalCategory | null>>, string, string][] = [
      // Volume shaping, not a refusal (BatchReport.tsx:27).
      [ASK_WITHHELD_REFUSAL_CATEGORIES, 'velocity_banked', 'ask withheld'],
      // The owner acted. Reporting an owner's own act back as our restraint is
      // a lie about who decided.
      [BATCH_HALTED_REFUSAL_CATEGORIES, 'owner_veto', 'batch halt'],
      [BATCH_HALTED_REFUSAL_CATEGORIES, 'owner_halt', 'batch halt'],
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'owner_veto', 'outreach cancelled'],
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'owner_halt', 'outreach cancelled'],
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'owner_excluded', 'outreach cancelled'],
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'owner_withdrawn', 'outreach cancelled'],
      // A clock ran out, or delivery failed. Neither is a decision not to act.
      [BATCH_HALTED_REFUSAL_CATEGORIES, 'send_window_elapsed', 'batch halt'],
      [BATCH_HALTED_REFUSAL_CATEGORIES, 'batch_expired', 'batch halt'],
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'send_window_elapsed', 'outreach cancelled'],
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'batch_expired', 'outreach cancelled'],
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'send_failed', 'outreach failed'],
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'send_exhausted', 'outreach failed'],
      // A newer attempt replaced the row; the provider never said what happened.
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'superseded', 'outreach cancelled'],
      [OUTREACH_NON_REFUSAL_CATEGORIES, 'send_indeterminate', 'outreach unknown'],
    ];

    for (const [map, code, lane] of excluded) {
      expect(Object.hasOwn(map, code), `${lane} '${code}' is OMITTED, not decided`).toBe(true);
      expect(map[code], `${lane} '${code}' should map to null`).toBeNull();
    }
  });

  // Plan §3's feeder table, read back through the ONE public lookup. The second
  // half is the harder half: anything the table does not name must not resolve
  // to a category at all, so a mapping cannot be added to the module unnoticed.
  it('every source code maps to its locked RefusalCategory', () => {
    const locked: readonly [RefusalSource, string | null, RefusalCategory][] = [
      ['held_draft', null, 'unsafe_content'],
      ['outreach_withheld', 'moderation_high', 'unsafe_content'],

      ['auto_post_revoked', 'judge_disabled', 'watchdog_unavailable'],
      ['auto_post_revoked', 'judge_unhealthy', 'watchdog_unavailable'],
      ['auto_post_revoked', 'notice_undelivered', 'watchdog_unavailable'],

      ['outreach_withheld', 'render_failed', 'below_our_bar'],
      ['outreach_withheld', 'lint_failed', 'below_our_bar'],

      ['ask_withheld', 'no_consent', 'no_permission'],
      ['ask_withheld', 'suppressed', 'no_permission'],
      ['outreach_withheld', 'no_consent', 'no_permission'],
      ['outreach_withheld', 'suppressed', 'no_permission'],
      ['outreach_withheld', 'unsubscribed', 'no_permission'],

      ['ask_withheld', 'already_reviewed', 'wrong_moment'],
      ['ask_withheld', 'stale_visit', 'wrong_moment'],
      ['ask_withheld', 'over_contacted', 'wrong_moment'],

      ['auto_post_revoked', 'auto_approval_disabled', 'autonomy_paused'],
      ['auto_post_revoked', 'autopilot_entitlement_lost', 'autonomy_paused'],
      ['auto_post_revoked', 'policy_suspended', 'autonomy_paused'],
      ['autonomy_suspended', 'judge_flag', 'autonomy_paused'],
      ['autonomy_suspended', 'governor_edit_rate', 'autonomy_paused'],
      ['autonomy_suspended', 'governor_veto_rate', 'autonomy_paused'],
      ['autonomy_suspended', 'governor_judge_signal_rate', 'autonomy_paused'],
      ['batch_halted', 'admin_halt', 'autonomy_paused'],
      ['batch_halted', 'platform_halt', 'autonomy_paused'],

      ['outreach_withheld', 'no_postal_address', 'missing_information'],
      ['outreach_withheld', 'postal_address_mismatch', 'missing_information'],
    ];

    for (const [source, code, category] of locked) {
      expect(refusalCategoryFor(source, code), `${source}/${String(code)}`).toBe(category);
    }

    const namedPairs = new Set(locked.map(([source, code]) => `${source}/${String(code)}`));
    const mapsBySource: readonly [
      RefusalSource,
      Readonly<Record<string, RefusalCategory | null>>,
    ][] = [
      ['auto_post_revoked', AUTO_POST_REVOKED_REFUSAL_CATEGORIES],
      ['autonomy_suspended', AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES],
      ['ask_withheld', ASK_WITHHELD_REFUSAL_CATEGORIES],
      ['outreach_withheld', OUTREACH_WITHHELD_REFUSAL_CATEGORIES],
      ['outreach_withheld', OUTREACH_NON_REFUSAL_CATEGORIES],
      ['batch_halted', BATCH_HALTED_REFUSAL_CATEGORIES],
    ];
    const unlisted = mapsBySource.flatMap(([source, map]) =>
      Object.entries(map)
        .filter(([code, category]) => category !== null && !namedPairs.has(`${source}/${code}`))
        .map(([code]) => `${source}/${code}`),
    );
    expect(unlisted, 'category assignments absent from the locked feeder table').toEqual([]);

    // Assert, do not default (intake edge case): a code in no map is a FAULT.
    // A default would file an unmapped refusal under a plausible-looking heading
    // and the owner could never tell the difference.
    expect(() => refusalCategoryFor('ask_withheld', 'recent_negative')).toThrow(
      UnknownRefusalCodeError,
    );
  });

  it('REFUSAL_CATEGORIES is listed in precedence order and has no duplicates', () => {
    expect([...REFUSAL_CATEGORIES]).toEqual([
      'unsafe_content',
      'watchdog_unavailable',
      'below_our_bar',
      'no_permission',
      'wrong_moment',
      'autonomy_paused',
      'missing_information',
    ]);
    expect(new Set(REFUSAL_CATEGORIES).size).toBe(REFUSAL_CATEGORIES.length);
  });

  it('every RefusalCategory has an owner label and at most one link target', () => {
    // Keyed `Record<RefusalCategory, …>` AND in the same order, so the tab can
    // render straight off the enum without a second ordering to keep in step.
    expect(Object.keys(REFUSAL_CATEGORY_META)).toEqual([...REFUSAL_CATEGORIES]);

    for (const category of REFUSAL_CATEGORIES) {
      const meta = REFUSAL_CATEGORY_META[category];
      expect(meta.label.length, `${category}: empty label`).toBeGreaterThan(0);
      expect(meta.label, `${category}: the label is the raw code`).not.toBe(category);
      expect(meta.sentence.trim().endsWith('.'), `${category}: sentence is not a sentence`).toBe(
        true,
      );
      if (meta.link !== null) {
        // AT MOST ONE target: one link object, and an `href` kind carries exactly
        // one destination. Two targets on one category would put two competing
        // "what do I do about this" affordances on the same row.
        expect(Object.keys(meta.link).sort(), `${category}: link shape`).toEqual(
          meta.link.kind === 'href' ? ['href', 'kind'] : ['kind'],
        );
      }
    }

    // The locked owner decision: links only, no writes.
    expect(REFUSAL_CATEGORY_META.unsafe_content.link).toEqual({ kind: 'review' });
    expect(REFUSAL_CATEGORY_META.autonomy_paused.link).toEqual({
      kind: 'href',
      href: '/settings/auto-approval',
    });
    expect(REFUSAL_CATEGORY_META.no_permission.link).toEqual({
      kind: 'href',
      href: '/dashboard/requests/contacts',
    });
    expect(REFUSAL_CATEGORY_META.wrong_moment.link).toBeNull();
    expect(REFUSAL_CATEGORY_META.below_our_bar.link).toBeNull();
    expect(REFUSAL_CATEGORY_META.missing_information.link).toBeNull();
    expect(REFUSAL_CATEGORY_META.watchdog_unavailable.link).toBeNull();
  });

  // Plan §2: `latchHalt` writes a batch's halt reason through to every cancelled
  // outreach row, so the cancelled-arm copies must map to null or S7's one batch
  // halt is counted again per outreach row.
  it('the cancelled-arm admin_halt and platform_halt outreach copies map explicitly to null', () => {
    for (const code of ['admin_halt', 'platform_halt'] as const) {
      expect(
        Object.hasOwn(OUTREACH_NON_REFUSAL_CATEGORIES, code),
        `outreach cancelled '${code}' is OMITTED, not decided`,
      ).toBe(true);
      expect(OUTREACH_NON_REFUSAL_CATEGORIES[code]).toBeNull();
      expect(refusalCategoryFor('outreach_withheld', code)).toBeNull();
    }

    // The asymmetry is the point: the SAME code counts once, at the batch.
    expect(refusalCategoryFor('batch_halted', 'admin_halt')).toBe('autonomy_paused');
    expect(refusalCategoryFor('batch_halted', 'platform_halt')).toBe('autonomy_paused');
  });
});
