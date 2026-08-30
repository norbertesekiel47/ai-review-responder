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
  // Both module-level pieces of the warn-once latch — the `warned` flag and the
  // cooldown deadline — start clean, on `circuit-breaker.ts`'s `reset()`
  // precedent. Without this, title 9's "exactly one per process" would be
  // satisfied by whichever case ran first.
  resetRefusalLedgerWarningForTests();
  delete process.env[LEDGER_FLAG];
});

afterEach(() => {
  delete process.env[LEDGER_FLAG];
  resetRefusalLedgerWarningForTests();
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
  });

  it('writeRefusalEvent emits exactly one Sentry warning per process while the kill switch stays off', async () => {
    process.env[LEDGER_FLAG] = 'false';

    for (let call = 0; call < 5; call++) {
      await writeRefusalEvent(tx(), autonomySuspended());
    }

    // ONCE per process, not once per decision: a suspended fleet would
    // otherwise emit one capture per refusal and drown the signal it exists to
    // give. The warning matters because the ledger structurally cannot show its
    // own gap — an absent row and a decision that never happened look identical
    // at read time.
    expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentryStub.captureMessage.mock.calls[0]?.[1]).toMatchObject({ level: 'warning' });
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
    expect(harness.sqlCalls).toHaveLength(0);
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
    // Round 2 defect 3 and round 3 defect 2, pinned. Setting the once-per-process
    // latch BEFORE the attempt trades one network blip for permanent silence
    // about a ledger gap; a LIFETIME attempt ceiling trades three blips for the
    // same silence. The rule is a COOLDOWN, counted in time — and time always
    // recovers.
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const start = 1_800_000_000_000;
      nowSpy.mockReturnValue(start);
      sentryStub.captureMessage.mockImplementationOnce(() => {
        throw new Error('sentry transport blipped');
      });
      process.env[LEDGER_FLAG] = 'false';

      // Attempt 1 throws and is swallowed. The latch is NOT set — it is set on a
      // SUCCESSFUL capture and never before the attempt.
      await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);

      // Inside the cooldown: no re-attempt, so a broken Sentry costs at most one
      // swallowed call per window rather than one per decision.
      nowSpy.mockReturnValue(start + WARN_RETRY_COOLDOWN_MS - 1);
      await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(1);

      // Cooldown elapsed and Sentry has recovered: the warning arrives. This is
      // the case a lifetime ceiling loses.
      nowSpy.mockReturnValue(start + WARN_RETRY_COOLDOWN_MS + 1);
      await expect(writeRefusalEvent(tx(), autonomySuspended())).resolves.toBeUndefined();
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(2);
      expect(sentryStub.captureMessage.mock.calls[1]?.[1]).toMatchObject({ level: 'warning' });

      // EXACTLY ONE successful warning, forever after. The latch is now set, so
      // a further cooldown's worth of calls adds nothing.
      nowSpy.mockReturnValue(start + WARN_RETRY_COOLDOWN_MS * 10);
      await writeRefusalEvent(tx(), autonomySuspended());
      await writeRefusalEvent(tx(), autonomySuspended());
      expect(sentryStub.captureMessage).toHaveBeenCalledTimes(2);

      expect(harness.sqlCalls).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
