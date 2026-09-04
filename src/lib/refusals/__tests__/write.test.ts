// The Refusal ledger's write path — unit eval (#1009 slice 2, task T1, RED).
//
// Titles are VERBATIM from `.feature/intake.json` `tests_to_add` (6-11 and 28);
// the verify gate's `promised-tests` row matches on exact text.
//
// WHAT THIS FILE OWNS AND WHAT IT DELIBERATELY DOES NOT.
// `writeRefusalEvent` takes its `tx` as an explicit parameter (invariant #15),
// so the whole kill-switch and statement-shape surface is reachable against a
// Postgres.js MOCK — no database, no `@/lib/db/server`. The live-DB half of the
// helper's contract (does the byte-for-byte `ON CONFLICT` actually INFER the
// partial index; does `'transaction_time'` really take the deciding
// transaction's clock) lives in `write.integration.test.ts`, because SQL TEXT
// alone is the fake-coverage pattern #1008's third red-team pass killed. Title
// 11 here is the text half; title 12 there is its live partner, and neither is
// sufficient alone.
//
// Migration 116's five CHECKs, C1's fall-through and both partial-index
// idempotency cases are ALREADY proven by
// `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts`.
// This slice proves the same properties THROUGH THE HELPER, which is the
// untested claim; re-writing the schema suite would be duplicate coverage the
// intake names as a non-goal.

import { readFileSync } from 'node:fs';
import { REFUSAL_LEDGER_FLAG } from '@/lib/refusals/write';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
import {
  WARN_RETRY_COOLDOWN_MS,
  resetRefusalLedgerWarningForTests,
  writeRefusalEvent,
  type WriteRefusalEventInput,
} from '../write';
// NAMESPACE import for the SET-BASED arm (#1010 T2), on
// `approval.integration.test.ts`'s precedent. A named import of an export that
// does not exist yet fails the whole FILE at collection — vite's ssr transform
// validates `importedNames` — which at the RED phase would take the five
// pre-existing single-row cases above down with it and run none of them. A
// namespace access is `undefined` until T2 lands, so each new case fails on its
// own, naming the missing export. Kept after T2 for the same reason the
// precedent kept its own: the next slice to add an arm here inherits it.
import * as refusalWrite from '../write';
import { POLICY_GATE_HELD_REFUSAL_CATEGORIES } from '../vocabulary';

// `vi.hoisted` rather than a bare `const`: the stub has to exist before the
// module graph is loaded, and `job-failure-sink.test.ts` is the house form.
const sentryStub = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@sentry/node', () => sentryStub);

/**
 * The vocabulary resolver as a SPY, so `noteUnmappedBlockReasons` can be proven
 * never to call it (#1105, task T1 case 8).
 *
 * IT IS THE ONLY ORACLE FOR THAT CLAIM IN THE WHOLE EVAL. The five persist-side
 * cases assert a resolver spy at zero too, but that suite MOCKS
 * `@/lib/refusals/write` wholesale, so the helper under test there is a stub and
 * the real one could resolve-and-catch behind it and still pass every one of
 * them. Here the helper is real and the resolver is watched.
 *
 * WHY IT MATTERS AND IS NOT DEFENSIVE PADDING: guard 4 contains a vocabulary
 * fault by NON-EXECUTION (#1079). A signal that reached for the resolver — even
 * inside a `try` — would put the throwing code back inside the deciding
 * transaction, which is the exact fault the kill switch exists to contain.
 *
 * A PARTIAL mock, on `persist.test.ts`'s `importOriginal` precedent: the module
 * also owns `REFUSAL_VOCABULARY_VERSION` and the category map, and both are read
 * elsewhere in this file and by `write.ts` itself.
 *
 * NO DELEGATING IMPLEMENTATION, and that is deliberate rather than an omission.
 * `persist.test.ts`'s copy of this spy delegates to the real resolver because
 * cases there drive the ON arm and need real behaviour. Here, nothing does:
 * `write.ts` does not import the resolver, and the only case that names it
 * asserts it is NEVER CALLED. A delegating body would be code no test can
 * execute — branch review round 1 measured it as dead.
 */
const resolvePolicyGateRefusalSpy = vi.hoisted(() =>
  vi.fn<(codes: readonly string[]) => unknown>(),
);

vi.mock('../vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vocabulary')>();
  return { ...actual, resolvePolicyGateRefusal: resolvePolicyGateRefusalSpy };
});

const MIGRATION_116 = 'supabase/migrations/116_refusal_events.sql';

/** The default-ON kill switch. Only the literal string 'false' disables it. */

let harness: MockSqlHarness;

function tx(): TransactionSql {
  return harness.mockSql as unknown as TransactionSql;
}

/**
 * The account-wide lane, exactly as `suspendAccountAutonomy` writes it:
 * `business_id` NULL (C3), no subject (C1/C2), no code array (C5), and the
 * trigger verbatim as the code (C4).
 */
function autonomySuspended(): WriteRefusalEventInput {
  return {
    accountId: '00000000-0000-4000-8000-0000000000a1',
    businessId: null,
    refusalSource: 'autonomy_suspended',
    refusalCode: 'judge_flag',
    allRefusalCodes: null,
    refusalCategory: 'autonomy_paused',
    subjectType: null,
    subjectId: null,
    occurredAt: 'transaction_time',
  };
}

/** A per-location lane WITH a subject — the only shape the partial index sees. */
function heldDraft(subjectId: string): WriteRefusalEventInput {
  return {
    accountId: '00000000-0000-4000-8000-0000000000a1',
    businessId: '00000000-0000-4000-8000-0000000000b1',
    refusalSource: 'held_draft',
    refusalCode: null,
    allRefusalCodes: null,
    refusalCategory: 'unsafe_content',
    subjectType: 'response',
    subjectId,
    occurredAt: new Date('2026-08-30T11:22:33.444Z'),
  };
}

/** One batch's decision time, shared by every row a build proposes. */
const ASK_DECIDED_AT = new Date('2026-08-30T09:08:07.006Z');

/**
 * The `ask_withheld` lane, exactly as `commitAskDecisions` writes it (#1010):
 * a per-location Refusal pointing at one `solicitation_asks` row, the withheld
 * reason verbatim as the code, and the batch's own `decidedAt` as the decision
 * time.
 */
function askWithheld(subjectId: string, occurredAt = ASK_DECIDED_AT): WriteRefusalEventInput {
  return {
    accountId: '00000000-0000-4000-8000-0000000000a1',
    businessId: '00000000-0000-4000-8000-0000000000b1',
    refusalSource: 'ask_withheld',
    refusalCode: 'no_consent',
    allRefusalCodes: null,
    refusalCategory: 'no_permission',
    subjectType: 'solicitation_ask',
    subjectId,
    occurredAt,
  };
}

/** A distinct, well-formed subject id per index — the partial index keys on it. */
function askSubjectId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The warning's PRIMARY transport.
 *
 * `logger.warn` ends at `console.warn` with one JSON line
 * (`src/lib/shared/logger.ts`), and that line — not the Sentry capture — is the
 * durable half of the disabled-ledger signal: `@sentry/node`'s `captureMessage`
 * returns an event id as soon as the event is QUEUED and swallows a failed
 * transport send internally, so a returning capture proves nothing was
 * delivered. Spying here is how a case asserts the signal actually landed.
 * Silencing it also keeps the output readable now that cases warn more than once.
 */
function spyOnConsoleWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

let consoleWarn: ReturnType<typeof spyOnConsoleWarn>;

/** The disabled-ledger lines only, so another module's warning cannot inflate a count. */
function ledgerWarnings(): unknown[] {
  return consoleWarn.mock.calls.filter((call) =>
    JSON.stringify(call).includes('refusal ledger disabled'),
  );
}

/**
 * The VOCABULARY-HOLE lines only (#1105).
 *
 * TWO FILTERS, NOT ONE, and the separation is the point. These are two different
 * faults with two different lifetimes: "the ledger is off deliberately" is an
 * episode of the kill switch, and "a block reason has no category mapping" is a
 * defect behind it. A single filter would let either signal satisfy an assertion
 * about the other, which is the confusion the whole ticket exists to remove.
 *
 * SO THE TWO MESSAGES MUST NOT SHARE A SUBSTRING. `ledgerWarnings` matches
 * `refusal ledger disabled`; a new line containing that phrase would inflate
 * every pre-existing count in this file and pass while proving nothing.
 */
function unmappedSignals(): unknown[] {
  return consoleWarn.mock.calls.filter((call) =>
    JSON.stringify(call).includes('refusal ledger vocabulary hole'),
  );
}

/**
 * A block-reason set every member of which the category map really holds.
 *
 * READ OFF THE MAP rather than typed out. A hand-copied literal proves the copy,
 * and this fixture's whole job is to be genuinely mapped — a stale literal would
 * turn the negative cases into false passes the day a member is renamed.
 */
function mappedBlockReasons(count: number): string[] {
  const keys = Object.keys(POLICY_GATE_HELD_REFUSAL_CATEGORIES);
  if (keys.length < count) {
    throw new Error(`the category map holds ${keys.length} members, fewer than the ${count} asked`);
  }
  return keys.slice(0, count);
}

/**
 * `refusal_events_subject_uniq`'s predicate, read off the migration that owns
 * it. Parsed rather than typed out: "byte-for-byte" is a claim about two
 * artifacts agreeing, and a hand-copied expectation only ever proves the copy.
 */
function migrationSubjectUniqPredicate(): string {
  const source = readFileSync(join(process.cwd(), MIGRATION_116), 'utf8');
  const match = /CREATE UNIQUE INDEX[^;]*refusal_events_subject_uniq[^;]*?(WHERE[^;]*);/.exec(
    source,
  );
  const predicate = match?.[1];
  if (predicate === undefined) {
    throw new Error(`${MIGRATION_116}: could not locate refusal_events_subject_uniq's predicate`);
  }
  return squash(predicate);
}

/** The module this eval is about, on disk. */
const WRITE_MODULE = 'src/lib/refusals/write.ts';

/**
 * Every `ON CONFLICT … DO NOTHING` clause the module SPELLS, comments removed.
 *
 * The strip is not cosmetic. `write.ts` discusses its own clause in prose — the
 * header, and the block under the single-row INSERT — so a scan of the raw file
 * matches spans of ENGLISH and would report four clauses where two exist, or
 * compare a comment against a statement and pass.
 *
 * Read out of the module rather than compared to a hand-typed literal: "the two
 * arms agree byte-for-byte" is a claim about two artifacts, and a literal
 * expectation only ever proves the copy — which is the SECOND AUTHORITY the
 * case exists to prevent (#1001 made this module the sole owner of the
 * statement, and the set-based arm is the second spelling it warned about).
 */
function onConflictClauses(): string[] {
  const source = readFileSync(join(process.cwd(), WRITE_MODULE), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
  return [...source.matchAll(/ON CONFLICT[\s\S]*?DO NOTHING/g)].map((match) =>
    squash(match[0]),
  );
}

beforeEach(() => {
  harness = createMockSql();
  sentryStub.captureMessage.mockReset();
  sentryStub.captureException.mockReset();
  consoleWarn = spyOnConsoleWarn();
  // Both module-level pieces of the warn latch — the episode flag and the
  // cooldown deadline — start clean, on `circuit-breaker.ts`'s `reset()`
  // precedent. Without this, title 9's "exactly one" would be satisfied by
  // whichever case ran first.
  resetRefusalLedgerWarningForTests();
  delete process.env[REFUSAL_LEDGER_FLAG];
});

afterEach(() => {
  delete process.env[REFUSAL_LEDGER_FLAG];
  resetRefusalLedgerWarningForTests();
  consoleWarn.mockRestore();
});

describe('writeRefusalEvent', () => {
  it('WriteRefusalEventInput requires occurredAt and rejects an omitted value at compile time', () => {
    // A COMPILE-TIME assertion, and it has to be. Every other case in this eval
    // supplies `occurredAt`, so an `occurredAt?: …` that silently defaulted to
    // insert time would pass all of them — only the type system can catch it.
    // `outreach_withheld` decides during the LLM round trip and persists
    // afterwards, so an omission THERE would record persist time, seconds late,
    // and still compile.
    //
    // If omitting the field ever starts to compile, `@ts-expect-error` itself
    // becomes the error. That inversion is the assertion; `pnpm typecheck` is
    // where it fires.
    // @ts-expect-error — occurredAt is REQUIRED, never optional (intake invariant).
    const withoutOccurredAt: WriteRefusalEventInput = {
      accountId: '00000000-0000-4000-8000-0000000000a1',
      businessId: null,
      refusalSource: 'autonomy_suspended',
      refusalCode: 'judge_flag',
      allRefusalCodes: null,
      refusalCategory: 'autonomy_paused',
      subjectType: null,
      subjectId: null,
    };

    expect(Object.hasOwn(withoutOccurredAt, 'occurredAt')).toBe(false);

    // And the sentinel is a real member of the input type, so a lane that
    // decides inside its own transaction can SAY so rather than arrive there by
    // omission.
    const withSentinel: WriteRefusalEventInput = { ...withoutOccurredAt, occurredAt: 'transaction_time' };
    expect(withSentinel.occurredAt).toBe('transaction_time');

    // THE LANE NOW DETERMINES THE REST, and the same inversion is the assertion:
    // each `@ts-expect-error` below becomes the error the day its pairing starts
    // to compile. `WriteRefusalEventInput` is a discriminated union on
    // `refusalSource` — one arm per lane, transcribed from migration 116's
    // C1–C5 — so a pairing the database answers with 23514 is a type error here
    // instead. That matters because this module deliberately does not catch: a
    // 23514 aborts the DECIDING transaction, and the ledger would break the very
    // decision it exists to record.
    //
    // Each probe is built as its OWN variable and then assigned, so the failure
    // is one whole-object error at the assignment rather than one per field.
    const subjectBearingSuspension = {
      accountId: '00000000-0000-4000-8000-0000000000a1',
      businessId: null,
      refusalSource: 'autonomy_suspended',
      refusalCode: 'judge_flag',
      allRefusalCodes: null,
      refusalCategory: 'autonomy_paused',
      subjectType: 'response',
      subjectId: '00000000-0000-4000-8000-0000000000c1',
      occurredAt: 'transaction_time',
    } as const;
    // @ts-expect-error — C1/C2: the account-wide lane points at nothing.
    const rejectedSubject: WriteRefusalEventInput = subjectBearingSuspension;

    const codedHeldDraft = {
      accountId: '00000000-0000-4000-8000-0000000000a1',
      businessId: '00000000-0000-4000-8000-0000000000b1',
      refusalSource: 'held_draft',
      refusalCode: 'moderation_high',
      allRefusalCodes: null,
      refusalCategory: 'unsafe_content',
      subjectType: 'response',
      subjectId: '00000000-0000-4000-8000-0000000000c1',
      occurredAt: 'transaction_time',
    } as const;
    // @ts-expect-error — C4: `held_draft` is the one lane with no code axis at all.
    const rejectedCode: WriteRefusalEventInput = codedHeldDraft;

    const emptyCodeSet = {
      accountId: '00000000-0000-4000-8000-0000000000a1',
      businessId: '00000000-0000-4000-8000-0000000000b1',
      refusalSource: 'policy_gate_held',
      refusalCode: 'below_min_star',
      allRefusalCodes: [],
      refusalCategory: 'owner_review_required',
      subjectType: 'response',
      subjectId: '00000000-0000-4000-8000-0000000000c1',
      occurredAt: 'transaction_time',
    } as const;
    // @ts-expect-error — C5: `'{}'` is a different fact from NULL, so the array
    // is a non-empty tuple type and an empty one is not spellable.
    const rejectedEmptySet: WriteRefusalEventInput = emptyCodeSet;

    // The probes are compile-time; these keep them referenced and prove each one
    // is the lane it claims to be rather than a typo that would compile anyway.
    expect(rejectedSubject.refusalSource).toBe('autonomy_suspended');
    expect(rejectedCode.refusalSource).toBe('held_draft');
    expect(rejectedEmptySet.refusalSource).toBe('policy_gate_held');
  });

  it('writeRefusalEvent writes nothing and returns when REFUSAL_LEDGER_ENABLED is the literal string false', async () => {
    // The CONTROL first: default-ON. Without it a helper that never writes
    // anything at all would satisfy this title.
    await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();
    expect(harness.sqlCalls).toHaveLength(1);

    process.env[REFUSAL_LEDGER_FLAG] = 'false';
    await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();

    // Still one: the disabled call returned BEFORE touching the deciding
    // transaction. This is the lever the ticket names — "not a revert deploy".
    expect(harness.sqlCalls).toHaveLength(1);

    // Only the literal 'false' disables. Anything else is on, the
    // LLM_CIRCUIT_BREAKER_ENABLED / DB_ADMISSION_ENABLED shape.
    process.env[REFUSAL_LEDGER_FLAG] = 'FALSE';
    await writeRefusalEvent(tx(), autonomySuspended());
    expect(harness.sqlCalls).toHaveLength(2);
  });

  it('writeRefusalEvent observes a false to true to false REFUSAL_LEDGER_ENABLED change within one process', async () => {
    // ONE process, ONE module instance, no `vi.resetModules()` between the
    // three calls — that is the whole case. A `const enabled =
    // readFlagEnabledByDefault(...)` evaluated at module construction passes
    // title 7 and fails here, because it can never see the second toggle.

    process.env[REFUSAL_LEDGER_FLAG] = 'false';
    await writeRefusalEvent(tx(), autonomySuspended());
    expect(harness.sqlCalls, 'off: nothing may reach the transaction').toHaveLength(0);

    process.env[REFUSAL_LEDGER_FLAG] = 'true';
    await writeRefusalEvent(tx(), autonomySuspended());
    expect(harness.sqlCalls, 'on: the write lands without a restart').toHaveLength(1);

    process.env[REFUSAL_LEDGER_FLAG] = 'false';
    await writeRefusalEvent(tx(), autonomySuspended());
    expect(harness.sqlCalls, 'off again: the toggle works in BOTH directions').toHaveLength(1);

    // TWO warnings, not one. The rate-limit unit is the DISABLED EPISODE, not
    // the process: the enabled call in the middle ends the first episode, so the
    // second outage is reported. Under a process-lifetime latch this sequence
    // warns once and every later outage is silent for the life of the worker —
    // and this warning is the only evidence a ledger gap exists at all.
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(2);
    expect(ledgerWarnings()).toHaveLength(2);
  });

  it('writeRefusalEvent emits exactly one Sentry warning per disabled episode while the kill switch stays off', async () => {
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    for (let call = 0; call < 5; call++) {
      await writeRefusalEvent(tx(), autonomySuspended());
    }

    // ONCE per DISABLED EPISODE, not once per decision: a suspended fleet would
    // otherwise emit one capture per refusal and drown the signal it exists to
    // give. Per EPISODE rather than per process is the point — the latch clears
    // when the flag is next seen enabled, so a second outage in the same worker
    // still warns (test 8 pins that). The warning matters because the ledger
    // structurally cannot show its own gap: an absent row and a decision that
    // never happened look identical at read time.
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentryStub.captureMessage.mock.calls[0]?.[1]).toMatchObject({ level: 'warning' });
    // The durable transport is bounded on the same terms — one line, not five.
    expect(ledgerWarnings()).toHaveLength(1);
    expect(harness.sqlCalls).toHaveLength(0);
  });

  it('a throwing Sentry capture does not stop writeRefusalEvent returning cleanly with the kill switch off', async () => {
    sentryStub.captureMessage.mockImplementation(() => {
      throw new Error('sentry transport is down');
    });
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    // An UNGUARDED emission rejects before the helper returns, and a suspension
    // then fails BECAUSE THE LEDGER WAS TURNED OFF — the exact opposite of what
    // the kill switch promises. Telemetry observes the path; it never carries
    // it, so this catch swallows.
    await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();

    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);
    // …and the warning is NOT lost with it. The structured log line is emitted
    // BEFORE the capture and OUTSIDE its `try`, in its own guard, so it is the
    // one transport no Sentry behaviour can take away.
    expect(ledgerWarnings()).toHaveLength(1);
    expect(harness.sqlCalls).toHaveLength(0);

    // THE OTHER DIRECTION, and the one three plan-review rounds did not cover: a
    // throwing CONSOLE. It has its own guard, so it can take neither the Sentry
    // capture nor the helper's return with it. Under a single `try` around both
    // transports the capture never runs and the warning leaves no trace at all.
    // The reset clears the cooldown the first failure just bought.
    resetRefusalLedgerWarningForTests();
    consoleWarn.mockImplementationOnce(() => {
      throw new Error('the log sink is gone');
    });
    await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();
    expect(
      sentryStub.captureMessage,
      'the second transport is still attempted after the first one throws',
    ).toHaveBeenCalledTimes(2);
  });

  it('writeRefusalEvent re-spells the refusal_events_subject_uniq predicate byte-for-byte in its ON CONFLICT clause', async () => {
    await writeRefusalEvent(tx(), heldDraft('00000000-0000-4000-8000-0000000000c1'));

    expect(harness.sqlCalls).toHaveLength(1);
    const statement = squash(harness.sqlCalls[0]!.text);

    expect(statement).toContain('INSERT INTO refusal_events');

    // The predicate as the MIGRATION spells it. Postgres cannot infer a partial
    // index unless the two agree, and a failed inference raises 23505 and
    // poisons the transaction the decision lives in.
    expect(statement).toContain(migrationSubjectUniqPredicate());

    // …and as the intake spells it, so a migration parse that silently matched
    // the wrong block cannot make this case vacuous.
    expect(statement).toContain('WHERE subject_id IS NOT NULL');
    expect(statement).toContain(
      'ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL DO NOTHING',
    );

    // DO NOTHING is required, not optional: a bare unique index raises on a
    // duplicate and aborts the transaction it sits in, and that transaction IS
    // the decision. The ledger must never break the thing it records.
    expect(statement).toContain('DO NOTHING');

    // NOT parameterised. A bind parameter inside `ON CONFLICT … WHERE` defeats
    // partial-index inference (CLAUDE.md invariant #2), and the mock renders
    // every bound value as `?` — so a `?` anywhere in the clause is the bug.
    const clause = statement.slice(statement.indexOf('ON CONFLICT'));
    expect(clause).not.toContain('?');
  });

  it('a first Sentry capture that throws does not suppress the refusal-ledger warning permanently', async () => {
    // Round 2 defect 3 and round 3 defect 2, pinned — and pinned against MANY
    // consecutive failures, not one. Setting the latch BEFORE the attempt trades
    // one blip for permanent silence about a ledger gap; a LIFETIME attempt
    // ceiling (`MAX_WARN_ATTEMPTS = 3`, the defect plan review round 3 removed)
    // trades a handful of blips for the same silence — and a single-failure
    // fixture cannot tell the two apart, because one failure is under every
    // plausible ceiling. FOUR failures then a recovery can. The rule is a
    // COOLDOWN counted in time, and time always recovers.
    const failures = 4;
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      let clock = 1_800_000_000_000;
      nowSpy.mockImplementation(() => clock);
      sentryStub.captureMessage.mockImplementation(() => {
        throw new Error('sentry transport is down');
      });
      process.env[REFUSAL_LEDGER_FLAG] = 'false';

      for (let attempt = 1; attempt <= failures; attempt++) {
        // Each attempt throws and is swallowed. The episode latch is NOT set —
        // it is set only when the capture call RETURNS, and never before it.
        await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();
        expect(sentryStub.captureMessage, `attempt ${attempt} runs`).toHaveBeenCalledTimes(attempt);

        // Inside the cooldown: no re-attempt, so a broken Sentry costs at most
        // one swallowed call per window rather than one per decision.
        clock += WARN_RETRY_COOLDOWN_MS - 1;
        await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();
        expect(
          sentryStub.captureMessage,
          `attempt ${attempt}: the window still suppresses`,
        ).toHaveBeenCalledTimes(attempt);

        clock += 1; // window elapsed — the next iteration is allowed to attempt
      }

      // THE DURABLE SIGNAL LANDED ON EVERY ATTEMPT. The log line is emitted
      // before the capture and outside its `try`, so four un-acknowledged
      // captures still leave four operator-visible warnings. That is what makes
      // "Sentry is best-effort with no delivery guarantee" survivable.
      expect(ledgerWarnings()).toHaveLength(failures);

      // Sentry recovers: the warning arrives. This is the case a lifetime
      // ceiling of 3 loses, and it is why the bound is time rather than a count.
      sentryStub.captureMessage.mockImplementation(() => 'event-id');
      await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(failures + 1);
      expect(sentryStub.captureMessage.mock.calls[failures]?.[1]).toMatchObject({
        level: 'warning',
      });

      // Exactly one acknowledged warning for the REST OF THIS EPISODE: the latch
      // is set now, so a further cooldown's worth of decisions adds nothing.
      clock += WARN_RETRY_COOLDOWN_MS * 10;
      await writeRefusalEvent(tx(), autonomySuspended());
      await writeRefusalEvent(tx(), autonomySuspended());
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(failures + 1);
      expect(ledgerWarnings()).toHaveLength(failures + 1);
      expect(harness.sqlCalls, 'every call so far was on the disabled path').toHaveLength(0);

      // …but the latch belongs to the EPISODE, not the process. One enabled call
      // ends it, and the NEXT outage warns again. A process-lifetime latch would
      // leave that second outage silent for the life of the worker, which is the
      // failure this design exists to avoid — the warning is the only evidence a
      // ledger gap exists.
      process.env[REFUSAL_LEDGER_FLAG] = 'true';
      await writeRefusalEvent(tx(), autonomySuspended());
      expect(harness.sqlCalls, 'the enabled call writes and ends the episode').toHaveLength(1);

      process.env[REFUSAL_LEDGER_FLAG] = 'false';
      await writeRefusalEvent(tx(), autonomySuspended());
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(failures + 2);
      expect(ledgerWarnings()).toHaveLength(failures + 2);
      expect(harness.sqlCalls).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// ── #1010 T2: the SET-BASED arm ──────────────────────────────────────────────
//
// Four of the arm's seven promised titles live here — the ones a Postgres.js
// MOCK can settle honestly: what the module SPELLS, and how many statements it
// issues. The other three (one row per input with in-call dedup, a commit over
// an earlier call's subject, and the caller-rollback case) need a real database
// and live in `write.integration.test.ts`.
//
// WHY THE STATEMENT COUNT IS A PROMISED TITLE AT ALL. Round-1 plan review
// finding R1-1: every OTHER claim about this arm — all rows written, duplicates
// handled, empty input, flag off — is satisfied by an export that simply LOOPS
// the single-row helper. The 5,000 sequential round trips under the batch's
// advisory lock that this arm exists to prevent would still happen, and the
// eval would be green. `harness.sqlCalls` counts AWAITED queries, so a loop
// reports N and this arm reports 1.
describe('writeRefusalEvents', () => {
  it('the set-based arm re-spells the refusal_events_subject_uniq predicate byte-for-byte, identically to the single-row arm', () => {
    const clauses = onConflictClauses();

    // TWO arms, and exactly two. A third spelling anywhere in this module is
    // the drift #1001 declined to allow, and it fails here rather than at the
    // first duplicate subject in production.
    expect(clauses, `expected exactly two ON CONFLICT clauses in ${WRITE_MODULE}`)
      .toHaveLength(2);

    // The claim itself: the two arms are the SAME TEXT. Compared to each other,
    // never to a literal — a literal is the second authority.
    expect(clauses[1]).toBe(clauses[0]);

    // …and both agree with the MIGRATION that owns the index. Postgres cannot
    // infer a partial index unless the clause and the predicate agree, and a
    // clause that reads right and infers nothing raises 23505 on the second
    // write — inside the transaction that IS the decision.
    for (const clause of clauses) {
      expect(clause).toContain(migrationSubjectUniqPredicate());
      expect(clause).toContain('DO NOTHING');
      // NOT parameterised, in EITHER arm. A bind parameter inside
      // `ON CONFLICT … WHERE` defeats inference outright (invariant #2). The
      // module source carries `${…}` for a bound value, so neither an
      // interpolation nor the mock's rendered `?` may appear inside the clause.
      expect(clause).not.toContain('?');
      expect(clause).not.toContain('${');
    }
  });

  it('the set-based arm issues no statement for an empty input set', async () => {
    // An INSERT of zero rows is not a decision, and `jsonb_to_recordset` over
    // `[]` is a round trip that records nothing — inside a transaction already
    // holding the per-Business advisory lock and the batch row lock.
    await expect(refusalWrite.writeRefusalEvents(tx(), [])).resolves.toBeUndefined();
    expect(harness.sqlCalls).toHaveLength(0);

    // The CONTROL: one input DOES reach the transaction, so a helper that never
    // writes anything at all cannot satisfy this title.
    await refusalWrite.writeRefusalEvents(tx(), [askWithheld(askSubjectId(1))]);
    expect(harness.sqlCalls).toHaveLength(1);
  });

  it('the set-based arm issues exactly one INSERT statement for every non-empty input set', async () => {
    // R1-1's case. One statement per SET, at every size a batch build can
    // reach: the singleton, a handful, and a cohort far past the point where a
    // loop's cost becomes the defect. `MAX_DATA_ROWS` is 5,000; 250 is enough
    // to separate 1 from N without making a unit case slow.
    for (const size of [1, 2, 250]) {
      harness.resetMockSql();
      const inputs = Array.from({ length: size }, (_, index) =>
        askWithheld(askSubjectId(index + 1)));

      await refusalWrite.writeRefusalEvents(tx(), inputs);

      expect(harness.sqlCalls, `${size} inputs must issue ONE statement`).toHaveLength(1);
      const statement = squash(harness.sqlCalls[0]!.text);
      // One INSERT inside that one statement, too: a helper that concatenated N
      // inserts into a single template would still be N statements to Postgres.
      expect(statement.match(/INSERT INTO refusal_events/g)).toHaveLength(1);
      // The set idiom, not a VALUES list built by string concatenation — the
      // rows ride as ONE bound JSONB parameter, which is what keeps the
      // statement's text independent of the cohort size.
      expect(statement).toContain('jsonb_to_recordset');
    }
  });

  it('the set-based arm writes nothing when REFUSAL_LEDGER_ENABLED is the literal string false', async () => {
    const inputs = [askWithheld(askSubjectId(1)), askWithheld(askSubjectId(2))];

    // The CONTROL first: default-ON.
    await refusalWrite.writeRefusalEvents(tx(), inputs);
    expect(harness.sqlCalls).toHaveLength(1);

    process.env[REFUSAL_LEDGER_FLAG] = 'false';
    await expect(refusalWrite.writeRefusalEvents(tx(), inputs)).resolves.toBeUndefined();

    // Still one: the disabled call returned BEFORE touching the deciding
    // transaction, exactly as the single-row arm does. The batch build itself
    // is untouched — that is what makes the switch a lever and not a revert.
    expect(harness.sqlCalls).toHaveLength(1);
    // And the gap is REPORTED. The ledger cannot show its own absence, so this
    // warning is the only evidence one exists.
    expect(ledgerWarnings()).toHaveLength(1);

    // Only the literal 'false' disables — the LLM_CIRCUIT_BREAKER_ENABLED /
    // DB_ADMISSION_ENABLED shape, and the same rule the single-row arm follows.
    process.env[REFUSAL_LEDGER_FLAG] = 'FALSE';
    await refusalWrite.writeRefusalEvents(tx(), inputs);
    expect(harness.sqlCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The kill switch behind ONE name (#1079 T1).
//
// `isRefusalLedgerEnabled` exists so a CALLER can decline to run ledger work at
// all — `recordPolicyGateRefusal` resolves a Refusal category before either
// write arm is reached, and that resolve is code the flag must be able to stop.
// Extracting the read is a refactor, so these two cases are the PINS that say
// the extraction changed nothing: the warning stays bounded per EPISODE across
// BOTH arms, and an empty batch still warns about nothing.
//
// They are also the side-effect-freedom oracle. A predicate that warned or
// cleared the latch would make an off-lane guard emit the very noise
// `writeRefusalEvents`' contract forbids — bullet 1, "AN EMPTY INPUT ISSUES NO
// STATEMENT … a build that withheld nothing has no ledger GAP to warn about" —
// so each case calls the predicate directly and asserts the counts do not move.
// CITED BY SYMBOL, NEVER BY A LINE RANGE: the range this comment used to carry
// went stale inside the very commit that inserted `noteRefusalLedgerDark`.
// ---------------------------------------------------------------------------
describe('isRefusalLedgerEnabled', () => {
  it('writeRefusalEvent and writeRefusalEvents together emit exactly one disabled warning across one disabled episode', async () => {
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    // ONE episode, BOTH arms. The latch is module-level, so this count is what
    // says the two arms SHARE one episode rather than each opening its own.
    //
    // IT IS NOT A DETECTOR FOR AN EXTRA WARNING SOURCE, and an earlier version
    // of this comment claimed it was. Once the first arm latches, a second line
    // is impossible within this episode no matter who else warns — a predicate
    // that warned on its own would be ABSORBED here, not revealed. The case that
    // does detect one is the next case in this describe — "…emits no disabled
    // warning for an empty input while the flag is off", named rather than
    // numbered for the reason item 1 of this pass exists: the latch is still
    // clear there, so a stray transport moves that zero off zero.
    await writeRefusalEvent(tx(), autonomySuspended());
    await refusalWrite.writeRefusalEvents(tx(), [askWithheld(askSubjectId(1))]);
    await writeRefusalEvent(tx(), autonomySuspended());

    expect(ledgerWarnings()).toHaveLength(1);
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);
    expect(harness.sqlCalls, 'nothing reached the deciding transaction').toHaveLength(0);

    // THE PREDICATE IS SIDE-EFFECT-FREE — no transport. Ten reads mid-episode
    // add no line. (The contract word is no longer "PURE": `vocabulary.ts`
    // reserves PURE for "no DB handle, no clock, no flag read", and this
    // function's whole body IS a flag read.)
    for (let call = 0; call < 10; call++) {
      expect(refusalWrite.isRefusalLedgerEnabled()).toBe(false);
    }
    expect(ledgerWarnings()).toHaveLength(1);
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);

    // …and no LATCH MUTATION either, which is the half a no-op stub would also
    // satisfy above. Reading the predicate while the flag is ON must not end the
    // disabled episode: only a WRITE that observed the enabled flag does that
    // (`endDisabledEpisode`). If the predicate cleared it, the next disabled
    // write below would warn a SECOND time.
    process.env[REFUSAL_LEDGER_FLAG] = 'true';
    expect(refusalWrite.isRefusalLedgerEnabled()).toBe(true);
    process.env[REFUSAL_LEDGER_FLAG] = 'false';
    await writeRefusalEvent(tx(), autonomySuspended());
    expect(ledgerWarnings(), 'the predicate did not end the episode').toHaveLength(1);

    // THE CONTROL for the whole count, and it has to be here: every assertion
    // above is an assertion of ABSENCE, so a broken warn oracle passes them all.
    // A real enabled write between two disabled ones DOES end the episode, and
    // the next outage warns again.
    resetRefusalLedgerWarningForTests();
    process.env[REFUSAL_LEDGER_FLAG] = 'true';
    await writeRefusalEvent(tx(), autonomySuspended());
    process.env[REFUSAL_LEDGER_FLAG] = 'false';
    await writeRefusalEvent(tx(), autonomySuspended());
    expect(ledgerWarnings(), 'a new episode warns again').toHaveLength(2);
  });

  it('writeRefusalEvents issues no statement and emits no disabled warning for an empty input while the flag is off', async () => {
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    // ORDER IS LOAD-BEARING — `writeRefusalEvents`' own contract, bullet 1 ("AN
    // EMPTY INPUT ISSUES NO STATEMENT … The check runs BEFORE the kill-switch
    // read on purpose"), cited by symbol because the line range that stood here
    // rotted inside a single commit. The `inputs.length === 0`
    // return comes BEFORE the flag read, so a build that withheld nothing has no
    // ledger GAP — and warning about it would put noise on the one signal that
    // says the ledger is dark. Moving the flag read above the empty check, or
    // folding the warning into the predicate, breaks exactly this.
    await expect(refusalWrite.writeRefusalEvents(tx(), [])).resolves.toBeUndefined();
    expect(harness.sqlCalls).toHaveLength(0);
    expect(ledgerWarnings()).toHaveLength(0);
    expect(sentryStub.captureMessage).not.toHaveBeenCalled();

    // The predicate is not a warning transport, so probing it here stays silent
    // too — even though this caller never reached it.
    expect(refusalWrite.isRefusalLedgerEnabled()).toBe(false);
    expect(ledgerWarnings()).toHaveLength(0);

    // THE CONTROL. A zero-warning assertion passes on a broken oracle, so one
    // NON-empty disabled batch must produce exactly the line the empty one did
    // not.
    await refusalWrite.writeRefusalEvents(tx(), [askWithheld(askSubjectId(1))]);
    expect(harness.sqlCalls, 'still nothing written — the flag is off').toHaveLength(0);
    expect(ledgerWarnings(), 'a withheld SET does warn').toHaveLength(1);
  });

  // The SIDE-EFFECTING sibling (#1079). `isRefusalLedgerEnabled` above may not
  // warn; `noteRefusalLedgerDark` is how a caller that has ALREADY established a
  // real ledger gap — `recordPolicyGateRefusal`'s guard 4, via
  // `wouldRecordRefusal` — says so without running the resolver the switch
  // exists to contain.
  //
  // THE CLAIM UNDER TEST IS "SAME WARNING", NOT "A WARNING". A second, private
  // latch inside the new export would satisfy any single-call assertion, so the
  // oracle has to be a MIXED episode: the note and a write arm together must
  // still produce exactly one line.
  // DOUBLE QUOTES, deliberately, and this is not a style choice. The gate's
  // `promised-tests` row greps each intake title as a VERBATIM substring. A
  // single-quoted string spells the apostrophe as `arms\'`, the backslash breaks
  // the match, and the row reports a written test as missing — which is how this
  // very title first went red. `avoidEscape` makes double quotes lint-clean here.
  it("noteRefusalLedgerDark shares the write arms' once-per-episode latch", async () => {
    process.env[REFUSAL_LEDGER_FLAG] = 'false';

    // The NOTE goes first, so it is the call that opens the episode. If it kept
    // its own latch, the write arm below would find the shared one still clear
    // and add a SECOND line.
    refusalWrite.noteRefusalLedgerDark();
    expect(ledgerWarnings(), 'the note raises the line itself').toHaveLength(1);

    await writeRefusalEvent(tx(), autonomySuspended());

    expect(ledgerWarnings(), 'ONE line across the note and the write arm').toHaveLength(1);
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);
    expect(harness.sqlCalls, 'nothing reached the deciding transaction').toHaveLength(0);

    // …and the sharing runs the other way too: an arm that has already latched
    // absorbs a later note, which is what makes guard 4 safe to call on a lane
    // whose write arm may warn moments later.
    refusalWrite.noteRefusalLedgerDark();
    expect(ledgerWarnings(), 'a note after an arm adds nothing').toHaveLength(1);

    // THE CONTROL, and this case needs one badly: every assertion above is "the
    // count did not move", which a note that silently did NOTHING would also
    // pass. A fresh episode must warn again, and the note alone must be enough
    // to raise it.
    resetRefusalLedgerWarningForTests();
    refusalWrite.noteRefusalLedgerDark();
    expect(ledgerWarnings(), 'a new episode warns again').toHaveLength(2);
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(2);
  });
});

/**
 * `noteUnmappedBlockReasons` — the vocabulary-hole signal (#1105, task T1, RED).
 *
 * THE FAULT THIS BLOCK IS ABOUT. Guard 4 in
 * `worker/jobs/response-generation/persist.ts` contains a vocabulary fault by
 * NON-EXECUTION: with `REFUSAL_LEDGER_ENABLED` off it returns before
 * `resolvePolicyGateRefusal` can throw (#1079). The lane keeps its ledger-dark
 * warning through `wouldRecordRefusal`, but that predicate is
 * `every(mapped && non-null)` and an UNMAPPED member makes `Object.hasOwn`
 * false. So an unmapped code produced no Sentry issue and no ledger-dark line —
 * the #1080 fault class was entirely unsignalled.
 *
 * WHY THE LEDGER-DARK SILENCE IS CORRECT AND STAYS. An unmapped member would
 * have THROWN rather than written, so no Refusal row was lost, and
 * `writeRefusalEvents`' contract forbids claiming a gap for a call that would
 * not have written a row. This is a SECOND signal, never a widening of the
 * first.
 *
 * MOST OF THESE CASES EXIST BECAUSE A REVIEW FOUND AN EARLIER SET
 * INSUFFICIENT, and each says which. Plan review round 1 added six here: the
 * original set passed on an implementation that resolves and catches, that
 * merely reads the wrong latch, that logs unbounded, that signals on an empty
 * set, that sorts its codes, or that throws when both transports fail at once.
 * (A seventh, the `Object.hasOwn`-versus-`in` case, moved to `persist.test.ts`
 * when the membership test moved there — deviations D5.) Branch review round 1
 * added the per-code latch, cap and grouping cases.
 *
 * DO NOT DELETE ONE AS REDUNDANT WITHOUT RE-DERIVING WHY IT WAS ADDED. A count
 * is deliberately NOT quoted here: an earlier version said "seven of these
 * thirteen … the other six" and was falsified by the very move it describes.
 */
describe('noteUnmappedBlockReasons', () => {
  beforeEach(() => {
    // LOCAL, not folded into the file's top-level `beforeEach`. At the RED phase
    // the export does not exist, and a throwing top-level hook would take this
    // file's pre-existing cases down with it — the same collapse the namespace
    // import at the top of this file exists to avoid.
    refusalWrite.resetUnmappedBlockReasonSignalForTests();
  });

  afterEach(() => {
    refusalWrite.resetUnmappedBlockReasonSignalForTests();
  });

  it('noteUnmappedBlockReasons captures one error-level Sentry event naming every unmapped code', () => {
    refusalWrite.noteUnmappedBlockReasons(['ghost_reason', 'phantom_reason']);

    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = sentryStub.captureMessage.mock.calls[0]!;
    // A CONSTANT MESSAGE. Sentry groups by message, so interpolating the codes
    // would open a new issue group per distinct set, ordering and duplication —
    // scattering one fault across many issues and defeating the per-issue
    // throttling this repo's alerting relies on. (Branch review round 1,
    // adversarial axis.) The codes ride `extra`.
    expect(message).toBe(refusalWrite.UNMAPPED_BLOCK_REASON_MESSAGE);
    // `error`, NOT `warning`. The ledger being off is a deliberate operator act
    // and warns; a vocabulary hole behind it is a defect, and the level is what
    // separates the two in the issue stream.
    expect(options).toMatchObject({
      level: 'error',
      tags: { subsystem: 'refusal_ledger', fault: 'unmapped_block_reason' },
      // BOTH codes, by name, and the FLAG. An operator who cannot read the code
      // off the event has to go find the map by hand, which is most of the work.
      extra: { flag: REFUSAL_LEDGER_FLAG, codes: 'ghost_reason, phantom_reason' },
    });
  });

  it('noteUnmappedBlockReasons uses one constant Sentry message whatever the codes are', () => {
    // THE GROUPING PIN. Two calls with completely different code sets must
    // produce the SAME message, or Sentry files them as two issues. Asserting
    // the constant in one case is not enough — a message built as
    // `${CONST}: ${codes}` would satisfy a `toContain` and still fragment.
    refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
    refusalWrite.noteUnmappedBlockReasons(['a_totally_different_code']);

    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(2);
    const messages = sentryStub.captureMessage.mock.calls.map((call) => call[0]);
    expect(new Set(messages).size, 'one group, not two').toBe(1);
    expect(messages[0]).toBe(refusalWrite.UNMAPPED_BLOCK_REASON_MESSAGE);
    // …and the codes are still carried, per event.
    expect(sentryStub.captureMessage.mock.calls[1]![1]).toMatchObject({
      extra: { codes: 'a_totally_different_code' },
    });
  });

  it('noteUnmappedBlockReasons signals for the codes it is given without re-testing membership', () => {
    // THE CALLER OWNS THE PRECONDITION, on `noteRefusalLedgerDark`'s precedent.
    // Feeding this helper a genuinely MAPPED code is not a mistake the helper is
    // meant to catch — it is the fixture that proves the helper does not
    // classify. `unmappedBlockReasons` in `persist.ts` owns that decision, and
    // the lane's own cases are its oracle.
    //
    // AN EARLIER DRAFT PUT THE MEMBERSHIP TEST IN HERE and this case asserted
    // the opposite. The eval refuted it: with the test inside the helper, the
    // lane suite — which mocks this module — recorded a call for a healthy set
    // too, so four of its five cases discriminated nothing.
    refusalWrite.noteUnmappedBlockReasons(mappedBlockReasons(1));

    expect(sentryStub.captureMessage, 'it signals what it is handed').toHaveBeenCalledTimes(1);
    // …and never on the OTHER signal's transport: the ledger-dark counter must
    // stay clean, or the two faults become one line.
    expect(ledgerWarnings()).toHaveLength(0);
  });

  it('noteUnmappedBlockReasons reports each distinct code once and repeats none', () => {
    refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);

    // THE SAME code again: silent. This is the per-code latch.
    refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
    expect(sentryStub.captureMessage, 'a repeat is suppressed').toHaveBeenCalledTimes(1);

    // A DIFFERENT code: reported. THE FIRST VERSION OF THIS BRANCH LATCHED ONE
    // BOOLEAN AND WENT SILENT HERE, justified as "a map hole is systemic, so
    // one line is enough". Branch review round 1 refuted the justification, not
    // the design: since #1080 the compiler rejects the systemic static hole, so
    // what is left is a value that escaped the union at run time — and that
    // varies per decision. In a long-lived single-replica worker the boolean
    // let the first bad value permanently hide a second, from a DIFFERENT
    // unsafe producer. The two events are not redundant evidence.
    refusalWrite.noteUnmappedBlockReasons(['second_ghost']);
    expect(sentryStub.captureMessage, 'a new code is not hidden').toHaveBeenCalledTimes(2);
    expect(sentryStub.captureMessage.mock.calls[1]![1]).toMatchObject({
      extra: { codes: 'second_ghost' },
    });

    // A MIXED set — one seen, one new — reports ONLY the new one. This is what
    // forces the filter to run BEFORE the emit rather than after: a whole-call
    // latch would drop the new code, and an unfiltered emit would re-report the
    // old one.
    refusalWrite.noteUnmappedBlockReasons(['ghost_reason', 'third_ghost']);
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(3);
    expect(sentryStub.captureMessage.mock.calls[2]![1]).toMatchObject({
      extra: { codes: 'third_ghost' },
    });
  });

  it('noteUnmappedBlockReasons stops at the distinct-code cap with one overflow marker', () => {
    // THE BOUND. The codes are by definition values the type system did not
    // vouch for, so an unbounded Set keyed on them is a memory leak with extra
    // steps. Driven off the exported cap, never a hard-coded 8 — a literal here
    // would pass while measuring nothing if the cap changed.
    const cap = refusalWrite.UNMAPPED_SIGNAL_CAP;
    for (let i = 0; i < cap; i++) refusalWrite.noteUnmappedBlockReasons([`ghost_${i}`]);
    expect(sentryStub.captureMessage, 'every code up to the cap reports').toHaveBeenCalledTimes(cap);

    // The code PAST the cap: one overflow marker, its own message and its own
    // tag. It is a different operational fact — "the producer is generating
    // varied garbage" rather than "this code has no mapping" — so a silently
    // dropped code would report neither.
    refusalWrite.noteUnmappedBlockReasons(['one_too_many']);
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(cap + 1);
    const [message, options] = sentryStub.captureMessage.mock.calls[cap]!;
    expect(message).toBe(refusalWrite.UNMAPPED_BLOCK_REASON_OVERFLOW_MESSAGE);
    expect(options).toMatchObject({
      level: 'error',
      tags: { subsystem: 'refusal_ledger', fault: 'unmapped_block_reason_overflow' },
      extra: { cap },
    });
    // It names NO code: past the cap the input is unbounded, and not carrying it
    // is the point of having a cap.
    expect(JSON.stringify(options)).not.toContain('one_too_many');

    // …and it is emitted ONCE. Everything after the cap is silent.
    refusalWrite.noteUnmappedBlockReasons(['and_another']);
    refusalWrite.noteUnmappedBlockReasons(['and_yet_another']);
    expect(sentryStub.captureMessage, 'one marker, not one per code').toHaveBeenCalledTimes(cap + 1);

    // THE DURABLE TRANSPORT CARRIED THE MARKER TOO. Red-team round 2 found this
    // log line had no oracle anywhere: deleting it survived the whole suite,
    // while the module latches on a QUEUED capture on the stated grounds that
    // the log line is what makes that acceptable. An untested durable transport
    // cannot carry that argument.
    const overflowLines = consoleWarn.mock.calls.filter((call) =>
      JSON.stringify(call).includes(refusalWrite.UNMAPPED_OVERFLOW_LOG_MESSAGE),
    );
    expect(overflowLines, 'the marker reached the durable transport').toHaveLength(1);

    // PARSED AND READ BY FIELD, never matched as a substring of the whole line.
    // The first version of this assertion was `toContain(String(cap))`, and a
    // fresh red-team pass proved it a FALSE PASS: the line carries an ISO
    // timestamp, so with `cap` = 8 the digit was satisfied by the clock. The
    // `cap: 0` mutant died at 07:37 and SURVIVED at another instant — the same
    // assertion, the same code, a different second.
    const payload = JSON.parse(String(overflowLines[0]![0])) as {
      data?: { cap?: unknown; flag?: unknown };
    };
    expect(payload.data?.cap, 'the cap is carried as a NUMBER, by name').toBe(cap);
    expect(payload.data?.flag).toBe(REFUSAL_LEDGER_FLAG);
  });

  it('noteUnmappedBlockReasons bounds the latch when a single call carries more codes than the cap', () => {
    // THE BOUND, AND IT DID NOT EXIST WHEN THIS BRANCH FIRST CLAIMED IT.
    // Red-team round 2 P0: the implementation tested the Set's SIZE and then
    // added every fresh code, so one call carrying N new codes grew the Set to
    // N. Four documents asserted a bound the code did not enforce, and the
    // correctly-bounded mutant survived 29/29 because every case fed one code
    // at a time.
    const cap = refusalWrite.UNMAPPED_SIGNAL_CAP;
    const codes = Array.from({ length: cap + 3 }, (_, i) => `ghost_${i}`);

    refusalWrite.noteUnmappedBlockReasons(codes);

    // ONE report naming exactly `cap` codes, plus ONE overflow marker — the same
    // call both reports what it can carry and says there was more.
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(2);
    expect(sentryStub.captureMessage.mock.calls[0]![1]).toMatchObject({
      extra: { codes: codes.slice(0, cap).join(', ') },
    });
    expect(sentryStub.captureMessage.mock.calls[1]![0]).toBe(
      refusalWrite.UNMAPPED_BLOCK_REASON_OVERFLOW_MESSAGE,
    );

    // THE CODES PAST THE CAP WERE NOT MARKED AS REPORTED. Marking them would
    // record a claim the operator never received.
    expect(JSON.stringify(sentryStub.captureMessage.mock.calls[0]![1])).not.toContain(
      codes[cap]!,
    );

    // THE BOUND ITSELF, READ OFF THE LATCH. Every emission path reads the Set's
    // size through `room`, which saturates identically at and past the cap — so
    // marking `fresh` instead of `reportable` is EMISSION-equivalent and no
    // assertion about captures or log lines can tell them apart. A fresh
    // red-team pass measured that mutant surviving 31/31. The difference is
    // unbounded growth, which is the entire reason the cap exists, so the
    // invariant needs an oracle that can actually see it.
    expect(
      refusalWrite.unmappedSignalledCodeCountForTests(),
      'the latch never exceeds the cap',
    ).toBe(cap);

    // And a further NEW code gets the marker, never a report.
    sentryStub.captureMessage.mockClear();
    refusalWrite.noteUnmappedBlockReasons(['one_more_entirely_new']);
    expect(sentryStub.captureMessage, 'the cap holds').toHaveBeenCalledTimes(0);
    expect(refusalWrite.unmappedSignalledCodeCountForTests()).toBe(cap);
  });

  it('noteUnmappedBlockReasons counts DISTINCT codes, not repeats, against the cap', () => {
    // REPEATS ARE NOT DISTINCT CODES. Before the de-duplication,
    // `fresh.length > room` compared array entries against Set slots, so N
    // repeats of ONE code tripped the cap-reached page, named that code N times,
    // and burned the once-per-process overflow latch — after which the GENUINE
    // cap-reached event could never fire. Reproduced by a fresh red-team pass.
    //
    // Unreachable from today's only caller, which de-duplicates upstream. Fixed
    // regardless: this helper's contract must not depend on a property of one
    // call site.
    const cap = refusalWrite.UNMAPPED_SIGNAL_CAP;
    const repeats = Array.from({ length: cap + 1 }, () => 'one_code');

    refusalWrite.noteUnmappedBlockReasons(repeats);

    expect(sentryStub.captureMessage, 'one report, no overflow marker').toHaveBeenCalledTimes(1);
    expect(sentryStub.captureMessage.mock.calls[0]![0]).toBe(
      refusalWrite.UNMAPPED_BLOCK_REASON_MESSAGE,
    );
    expect(sentryStub.captureMessage.mock.calls[0]![1]).toMatchObject({
      extra: { codes: 'one_code' },
    });
    expect(refusalWrite.unmappedSignalledCodeCountForTests(), 'one distinct code').toBe(1);
  });

  it('a synchronously throwing Sentry buys a cooldown on the overflow marker too', () => {
    // THE OVERFLOW CATCH HAD NO ORACLE — red-team round 2 P1: deleting its
    // cooldown survived the whole suite, so the "shares the SAME cooldown,
    // deliberately" claim in that catch was prose nothing executed.
    const cap = refusalWrite.UNMAPPED_SIGNAL_CAP;
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      let clock = 1_800_000_000_000;
      nowSpy.mockImplementation(() => clock);

      // Fill the cap with a working transport.
      for (let i = 0; i < cap; i++) refusalWrite.noteUnmappedBlockReasons([`ghost_${i}`]);
      sentryStub.captureMessage.mockClear();

      // Now break Sentry and trip the overflow.
      sentryStub.captureMessage.mockImplementation(() => {
        throw new Error('sentry transport is down');
      });
      expect(() => refusalWrite.noteUnmappedBlockReasons(['past_the_cap'])).not.toThrow();
      expect(sentryStub.captureMessage, 'the marker was attempted').toHaveBeenCalledTimes(1);

      // Inside the window: no second attempt, and the overflow latch is NOT set —
      // a throw buys time, never the latch.
      clock += WARN_RETRY_COOLDOWN_MS - 1;
      refusalWrite.noteUnmappedBlockReasons(['past_the_cap_again']);
      expect(sentryStub.captureMessage, 'the window suppresses').toHaveBeenCalledTimes(1);

      // Window elapsed and Sentry recovers: the marker still lands.
      clock += 1;
      sentryStub.captureMessage.mockImplementation(() => 'event-id');
      refusalWrite.noteUnmappedBlockReasons(['past_the_cap_once_more']);
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(2);
      expect(sentryStub.captureMessage.mock.calls[1]![0]).toBe(
        refusalWrite.UNMAPPED_BLOCK_REASON_OVERFLOW_MESSAGE,
      );
    } finally {
      nowSpy.mockRestore();
      sentryStub.captureMessage.mockImplementation(() => undefined);
    }
  });

  it('a synchronously throwing Sentry buys a cooldown rather than the latch on noteUnmappedBlockReasons', () => {
    // FOUR consecutive failures then a recovery, on the ledger-dark case's
    // precedent above. One failure cannot tell a time cooldown from a lifetime
    // attempt ceiling, because one failure is under every plausible ceiling.
    const failures = 4;
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      let clock = 1_800_000_000_000;
      nowSpy.mockImplementation(() => clock);
      sentryStub.captureMessage.mockImplementation(() => {
        throw new Error('sentry transport is down');
      });

      for (let attempt = 1; attempt <= failures; attempt++) {
        refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
        expect(sentryStub.captureMessage, `attempt ${attempt} runs`).toHaveBeenCalledTimes(attempt);

        clock += WARN_RETRY_COOLDOWN_MS - 1;
        refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
        expect(
          sentryStub.captureMessage,
          `attempt ${attempt}: the window still suppresses`,
        ).toHaveBeenCalledTimes(attempt);

        clock += 1;
      }

      // The durable log line landed on EVERY attempt — the latch is set when the
      // capture RETURNS, never before it.
      expect(unmappedSignals()).toHaveLength(failures);

      sentryStub.captureMessage.mockImplementation(() => 'event-id');
      refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(failures + 1);

      // Now the latch is set, and it is a PROCESS latch, not an episode latch:
      // no amount of elapsed time re-opens it. That is the difference from
      // `warnLedgerDisabled`, whose episode ends when the ledger is observed on.
      clock += WARN_RETRY_COOLDOWN_MS * 10;
      refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(failures + 1);
    } finally {
      nowSpy.mockRestore();
      sentryStub.captureMessage.mockImplementation(() => undefined);
    }
  });

  it('a throwing logger does not stop noteUnmappedBlockReasons from capturing', () => {
    consoleWarn.mockImplementation(() => {
      throw new Error('console is broken');
    });

    expect(() => refusalWrite.noteUnmappedBlockReasons(['ghost_reason'])).not.toThrow();
    // The log guard owns its own `catch`, so a broken console cannot take the
    // second transport with it.
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('noteUnmappedBlockReasons leaves the ledger-dark episode latch untouched', () => {
    refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
    expect(unmappedSignals()).toHaveLength(1);

    // The ledger-dark latch was NOT consumed: its own signal still raises its
    // own line. Two faults, two latches, two lifetimes.
    refusalWrite.noteRefusalLedgerDark();
    expect(ledgerWarnings(), 'the ledger-dark line still fires').toHaveLength(1);
    expect(sentryStub.captureMessage, 'two captures, one per fault').toHaveBeenCalledTimes(2);
  });

  it('a prior ledger-dark warning does not suppress noteUnmappedBlockReasons', () => {
    // THE REVERSE ORDER, AND A DIFFERENT DEFECT. The case above catches an
    // implementation that WRITES the shared latch. This one catches an
    // implementation that merely READS it: such a helper passes the case above,
    // then goes silent for the rest of the episode the moment any mapped
    // decision warns first — which is the common case in production.
    refusalWrite.noteRefusalLedgerDark();
    expect(ledgerWarnings()).toHaveLength(1);

    refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
    expect(unmappedSignals(), 'the vocabulary hole still signals').toHaveLength(1);
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(2);
  });

  it('noteUnmappedBlockReasons never invokes resolvePolicyGateRefusal', () => {
    // INVARIANT 1'S ONLY REAL ORACLE. Containment is by NON-EXECUTION, so a
    // helper that resolves and catches has already lost — the throw would be
    // inside the deciding transaction, and a `catch` is not what the kill switch
    // promised.
    resolvePolicyGateRefusalSpy.mockClear();

    refusalWrite.noteUnmappedBlockReasons(['ghost_reason', ...mappedBlockReasons(1)]);

    expect(
      resolvePolicyGateRefusalSpy,
      'the throwing resolver stays unreached',
    ).not.toHaveBeenCalled();
    expect(sentryStub.captureMessage, 'and the signal still landed').toHaveBeenCalledTimes(1);
  });

  it('noteUnmappedBlockReasons emits one structured logger line naming every unmapped code and the flag', () => {
    // TWO CALLS, THE SAME SET. A one-call version of this case passes an
    // implementation that logs on EVERY call and latches only the Sentry side —
    // a broken map would then write one line per held draft for as long as the
    // hole stays open, which is the noise the latch exists to prevent.
    //
    // THE SETS MUST MATCH now that the latch is per code: two DIFFERENT sets
    // legitimately produce two lines, so that fixture would assert the opposite
    // of the contract.
    refusalWrite.noteUnmappedBlockReasons(['ghost_reason', 'phantom_reason']);
    refusalWrite.noteUnmappedBlockReasons(['ghost_reason', 'phantom_reason']);

    expect(unmappedSignals(), 'exactly one line across both calls').toHaveLength(1);
    expect(
      sentryStub.captureMessage,
      'exactly one capture across both calls',
    ).toHaveBeenCalledTimes(1);

    const line = JSON.stringify(unmappedSignals()[0]);
    expect(line).toContain('ghost_reason');
    expect(line).toContain('phantom_reason');
    expect(line).toContain(REFUSAL_LEDGER_FLAG);
  });

  it('an enabled ledger does not re-arm the vocabulary-hole latch', async () => {
    // PLAN DECISION D3, AND UNTIL BRANCH REVIEW IT HAD NO ORACLE. Adding
    // `signalledUnmappedCodes.clear()` to `endDisabledEpisode` survived the whole
    // suite, because no case drove an ENABLED write between two signals.
    //
    // The two latches have two lifetimes on purpose. A disabled EPISODE ends
    // when the ledger is observed on, and the next outage must warn again. A
    // vocabulary hole is not an episode of the switch: flipping the flag back
    // does not add the missing map entry, so re-reporting the same code there
    // would be noise carrying no new information.
    refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);

    // An ENABLED write — this is what calls `endDisabledEpisode`.
    delete process.env[REFUSAL_LEDGER_FLAG];
    await writeRefusalEvent(tx(), autonomySuspended());

    refusalWrite.noteUnmappedBlockReasons(['ghost_reason']);
    expect(
      sentryStub.captureMessage,
      'the enabled write did not re-arm the vocabulary latch',
    ).toHaveBeenCalledTimes(1);
  });

  it('noteUnmappedBlockReasons ignores an empty block-reason set', () => {
    // The mapped-set case above uses a real NON-EMPTY set, so a helper that
    // signals on `[]` passes it. Guard 2 makes the empty set unreachable at the
    // one call site, which is exactly why the helper's own contract carries it.
    refusalWrite.noteUnmappedBlockReasons([]);

    expect(sentryStub.captureMessage).not.toHaveBeenCalled();
    expect(unmappedSignals()).toHaveLength(0);
  });

  it('noteUnmappedBlockReasons preserves unmapped codes in input order', () => {
    // ORDER IS PRESERVED; DUPLICATES ARE NOT, and the difference is deliberate
    // at THIS seam only. The gate's evaluation order is evidence for whoever
    // debugs it — `vocabulary.ts` says exactly that about `allRefusalCodes`, and
    // the codes go out in it. But here a code is also a LATCH KEY and the cap
    // counts DISTINCT codes, so repeats collapse. An earlier version of this
    // case asserted `'zeta, alpha, zeta'`; a fresh red-team pass showed keeping
    // repeats let nine copies of one code trip the cap-reached page.
    //
    // `zeta` BEFORE `alpha` is what kills a sort: alphabetical output would
    // reverse them.
    refusalWrite.noteUnmappedBlockReasons(['zeta', 'alpha', 'zeta']);

    // On `extra`, not the message: the message is a constant so Sentry files
    // every occurrence of this fault under one issue.
    expect(sentryStub.captureMessage.mock.calls[0]![1]).toMatchObject({
      extra: { codes: 'zeta, alpha' },
    });
  });

  it('simultaneously throwing logger and Sentry transports do not escape noteUnmappedBlockReasons', () => {
    // BOTH AT ONCE. The two cases above throw one transport each, and a
    // combined-failure path could still escape and abort the response persist
    // while passing both. That is invariant 1 and invariant 6 together, and it
    // is the precise failure the kill switch exists to prevent: a decision that
    // failed BECAUSE the ledger was turned off.
    consoleWarn.mockImplementation(() => {
      throw new Error('console is broken');
    });
    sentryStub.captureMessage.mockImplementation(() => {
      throw new Error('sentry transport is down');
    });

    try {
      expect(() => refusalWrite.noteUnmappedBlockReasons(['ghost_reason'])).not.toThrow();
      expect(
        sentryStub.captureMessage,
        'the second transport was still attempted',
      ).toHaveBeenCalledTimes(1);
    } finally {
      sentryStub.captureMessage.mockImplementation(() => undefined);
    }
  });
});
