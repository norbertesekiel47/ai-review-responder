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

// `vi.hoisted` rather than a bare `const`: the stub has to exist before the
// module graph is loaded, and `job-failure-sink.test.ts` is the house form.
const sentryStub = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@sentry/node', () => sentryStub);

const MIGRATION_116 = 'supabase/migrations/116_refusal_events.sql';

/** The default-ON kill switch. Only the literal string 'false' disables it. */
const LEDGER_FLAG = 'REFUSAL_LEDGER_ENABLED';

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
  delete process.env[LEDGER_FLAG];
});

afterEach(() => {
  delete process.env[LEDGER_FLAG];
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

    process.env[LEDGER_FLAG] = 'false';
    await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();

    // Still one: the disabled call returned BEFORE touching the deciding
    // transaction. This is the lever the ticket names — "not a revert deploy".
    expect(harness.sqlCalls).toHaveLength(1);

    // Only the literal 'false' disables. Anything else is on, the
    // LLM_CIRCUIT_BREAKER_ENABLED / DB_ADMISSION_ENABLED shape.
    process.env[LEDGER_FLAG] = 'FALSE';
    await writeRefusalEvent(tx(), autonomySuspended());
    expect(harness.sqlCalls).toHaveLength(2);
  });

  it('writeRefusalEvent observes a false to true to false REFUSAL_LEDGER_ENABLED change within one process', async () => {
    // ONE process, ONE module instance, no `vi.resetModules()` between the
    // three calls — that is the whole case. A `const enabled =
    // readFlagEnabledByDefault(...)` evaluated at module construction passes
    // title 7 and fails here, because it can never see the second toggle.

    process.env[LEDGER_FLAG] = 'false';
    await writeRefusalEvent(tx(), autonomySuspended());
    expect(harness.sqlCalls, 'off: nothing may reach the transaction').toHaveLength(0);

    process.env[LEDGER_FLAG] = 'true';
    await writeRefusalEvent(tx(), autonomySuspended());
    expect(harness.sqlCalls, 'on: the write lands without a restart').toHaveLength(1);

    process.env[LEDGER_FLAG] = 'false';
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
    process.env[LEDGER_FLAG] = 'false';

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
    process.env[LEDGER_FLAG] = 'false';

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
      process.env[LEDGER_FLAG] = 'false';

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
      process.env[LEDGER_FLAG] = 'true';
      await writeRefusalEvent(tx(), autonomySuspended());
      expect(harness.sqlCalls, 'the enabled call writes and ends the episode').toHaveLength(1);

      process.env[LEDGER_FLAG] = 'false';
      await writeRefusalEvent(tx(), autonomySuspended());
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(failures + 2);
      expect(ledgerWarnings()).toHaveLength(failures + 2);
      expect(harness.sqlCalls).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
