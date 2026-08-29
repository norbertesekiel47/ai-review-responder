// The Refusal Log eval — vocabulary and mapping half (T0, red-first).
//
// Every title here is VERBATIM from `docs/superpowers/plans/feat-refusal-log-intake.json`
// `tests_to_add`; the `promised-tests` gate row matches them as fixed strings,
// so a reworded title reads as an unwritten test.
//
// `src/lib/refusals/vocabulary.ts` does not exist at this commit — T1 creates
// it. A static import of a missing module fails the whole FILE at collection
// (vite's ssr transform validates the specifier) and a collection failure runs
// none of this file's cases, so every case that needs the module is `it.todo`
// rather than a broken import. The ONE exception is the migration-111
// exhaustiveness case: its authority is a SQL CHECK that exists today, so it is
// written for real and fails on the missing mapping file, naming it.
//
// Plan: docs/superpowers/plans/feat-refusal-log-plan.md §3 (the vocabulary and
// the category feeder table).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The migration that owns the authoritative outreach disposition vocabulary. */
const MIGRATION_111 = 'supabase/migrations/111_platform_halt_reason.sql';

/** The mapping module T1 creates. Read as TEXT, never imported: see the header. */
const VOCABULARY_MODULE = 'src/lib/refusals/vocabulary.ts';

/**
 * The `withheld` arm of 111's `solicitation_outreach_status_reason_consistency`
 * CHECK. Plan §3: this vocabulary is authoritative ONLY in the migration — it is
 * fragmented across partial TypeScript unions, so `satisfies Record<…>` cannot
 * guard it and this parse is the guard instead.
 */
function withheldDispositionVocabulary(): readonly string[] {
  const sql = readFileSync(join(process.cwd(), MIGRATION_111), 'utf8');
  const arm =
    /delivery_status\s*=\s*'withheld'\s+AND\s+disposition_reason\s+IN\s*\(([^)]*)\)/i.exec(sql);
  const members = arm?.[1];
  if (members === undefined) {
    throw new Error(`${MIGRATION_111}: could not locate the withheld arm of the outreach CHECK`);
  }
  return [...members.matchAll(/'([a-z_]+)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('refusal vocabulary', () => {
  it.todo('every WithholdReason maps to a RefusalCategory or explicit null');

  it.todo('every AutoPolicyDowngradeReason maps to a RefusalCategory or explicit null');

  it.todo('every AutonomySuspensionTrigger maps to a RefusalCategory or explicit null');

  it.todo('every batch halt reason maps to a RefusalCategory or explicit null');

  it.todo('every solicitation_outreach withheld disposition_reason maps to a RefusalCategory or explicit null');

  // REAL, red at this commit. The CHECK half passes (it pins 111's vocabulary
  // so a later widening cannot slip past unmapped); the mapping half fails
  // because `src/lib/refusals/vocabulary.ts` is not written yet.
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

  it.todo('every excluded source code maps explicitly to null');

  it.todo('every source code maps to its locked RefusalCategory');

  it.todo('REFUSAL_CATEGORIES is listed in precedence order and has no duplicates');

  it.todo('every RefusalCategory has an owner label and at most one link target');

  // Plan §2: `latchHalt` writes a batch's halt reason through to every cancelled
  // outreach row, so the cancelled-arm copies must map to null or S7's one batch
  // halt is counted again per outreach row.
  it.todo('the cancelled-arm admin_halt and platform_halt outreach copies map explicitly to null');
});
