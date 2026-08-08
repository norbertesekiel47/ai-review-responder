# #695 — Import consent enforcement locus (ADR) + durable block reason

> **For agentic workers:** REQUIRED SUB-SKILL: use `subagent-driven-development` to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Branch:** `feat-695-import-consent-block-reason`
**Intake:** `docs/superpowers/plans/feat-695-import-consent-block-reason-intake.json`
**Issue:** #695 (raised by the adversarial axis on #679, filed rather than re-planned)
**Spec:** `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.3
**Precedent ADR:** `docs/adr/0010-owner-unreachable-outcome.md`
**Risk:** high (worker + outbox seam + notification path) · **Surface:** backend · **DB-touching:** yes (no migration)

**Goal:** Reject `job_outbox`-boundary enforcement of **Import consent** in a written
ADR, and make `guardImportConsent`'s refusals durably queryable by completing the
refused outbox row with `completion_reason = 'import_consent_blocked'`.

**Architecture:** No new schema — `job_outbox.completion_reason` has existed since
migration 083. `markOutboxOwnerUnreachable` is generalized into
`markOutboxCompletedWithReason(exec, outboxId, reason, attempt)` so the outbox seam
stops growing one method per reason, and `guardImportConsent` becomes its second
caller. The ADR is the deliverable for the design half.

**Tech Stack:** TypeScript, Postgres.js, vitest, fast-check, BullMQ (untouched).

---

## 1. Why the trigger is rejected (the argument ADR 0016 must carry)

#695's counter-proposal is a constraint/trigger at the `job_outbox` insertion
boundary. The decisive argument against is **not** the one the issue states
("business logic in a DB trigger is a departure"):

> A trigger must re-spell `importConsentStateSql` — the derived-expiry predicate —
> in PL/pgSQL, in a migration. That is an **unavoidable second spelling** of the
> one predicate spec §5.3 declares must have a single owner, and nothing can check
> the two against each other: the TypeScript owner is unit-tested, the trigger body
> lives in already-applied migration files, and a change to one is mechanically
> invisible to the other. Keeping them in sync becomes a deploy-ordering discipline
> across two Supabase projects rather than a property the code can enforce.

Stated precisely, because the round-1 review was right to push on it: a later
migration *can* `CREATE OR REPLACE` a trigger function, so this is not literal
impossibility. It is unenforced drift with a two-environment deploy coupling —
which is decisive enough on a predicate whose whole design rationale (#670) was
"derive it once, on read, in one place."

Supporting, in descending weight:

- `job_outbox` is topic-agnostic infrastructure shared by 32 topics; a
  topic-specific trigger couples the shared table to one domain.
- The marginal gain over #679 is only "the row is never created" versus "the row
  no-op-completes" — and the observability half of *this* ticket closes the gap
  the reviewer actually complained about.
- An insert-time gate cannot see consent state that changes between enqueue and
  dispatch, so `guardImportConsent` would survive anyway. Two enforcement points
  to keep in sync, not one.

## 2. Design — modules and seams

Consulted `codebase-design`. **No new interface; the only new file is the ADR.**

| Module | Change | Depth verdict |
|---|---|---|
| `src/lib/shared/outbox-completion-reason.ts` | +1 member, +1 exported union type | **Deepening.** Interface shape unchanged. |
| `src/lib/shared/outbox.ts` | `markOutboxOwnerUnreachable` → `markOutboxCompletedWithReason` | **Deepening, and the interface NARROWS.** One method per reason becomes one method parameterized by the vocabulary; without this the module grows a method per reason forever. Deletion test: the attempt-guarded CAS + `warnOutboxNoop` reappear at 2 call sites. Second reason ⇒ the seam is real, not hypothetical. |
| `worker/jobs/zernio/job-eligibility.ts` | `guardImportConsent` swaps its completion writer | **Deepening, textbook.** Signature and `ImportConsentGate` unchanged; the reason write is pure implementation. |
| `worker/jobs/notification/NotificationWorker.ts` | call site, ~3 lines | No interface change. |

`markOutboxCompletedWithReason` returns `void`, matching the function it replaces.
No caller needs the CAS result; `markOutboxCompletedIfOwned` already models the
shape that does. **Do not** give it a `boolean` return "for symmetry".

## 3. Tasks

Blocking edges: **T1 → {T2, T4}**, **T2 → T3**, **{T3, T4} → Gate**. T2 and T4 touch
disjoint files with no edge between them and are **mutually independent**
(parallel-dispatchable after T1's enforcement spot check). The gate join is explicit
because T4 is docs-only and will usually finish first — starting verification on a
green T4 while T3 is still open would measure nothing.

**Revised after round-1 codex review** (session `019fe2ec-c789-7032-9b55-3b923267404f`);
accepted findings and the four rejected ones are recorded in
`docs/superpowers/plans/feat-695-import-consent-block-reason-deviations.md`.

---

### Task 1: EVAL — author all 14 promised tests, failing

**This task writes tests only. It must not touch a single production file.**
The branch is deliberately red (and does not typecheck) between T1 and T2 — that is
what "failing eval" means here. Do not use `.todo` or `.fails` to hide it.

**Files:**
- Modify: `src/lib/shared/__tests__/outbox.test.ts`
- Modify: `worker/jobs/notification/__tests__/NotificationWorker.test.ts`
- Modify: `worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts`
- Modify: `worker/jobs/zernio/__tests__/job-eligibility.test.ts`
- Modify: `worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts`

The 14 titles below are the intake's `tests_to_add` **verbatim**. The
`promised-tests` gate row matches them as exact strings — do not reword, do not
add a prefix, do not change capitalisation.

**Never write a bare `'import_consent_blocked'` or `'owner_unreachable'` string in
a test.** Import `OUTBOX_COMPLETION_REASON` and assert against its members — the
intake makes that an invariant, tests included. The one deliberate exception is the
wire-value test in Step 1, whose entire job is to compare the constant to a literal.

- [ ] **Step 1: Retarget the outbox unit suite**

In `src/lib/shared/__tests__/outbox.test.ts`, change the import list
(`markOutboxOwnerUnreachable` → `markOutboxCompletedWithReason`), rename
`describe('markOutboxOwnerUnreachable (invariants)')` to
`describe('markOutboxCompletedWithReason (invariants)')`, and replace its single
`it` with these four (three `markOutboxCompletedWithReason` titles + the wire-value
contract test).

The existing fast-check property becomes title #2 — **keep the property, retitle
it, and sweep the reason** rather than adding a fourth overlapping test.

```typescript
import { OUTBOX_COMPLETION_REASON } from '../outbox-completion-reason';

describe('markOutboxCompletedWithReason (invariants)', () => {
  it('markOutboxCompletedWithReason completes the dispatched row and stamps the supplied completion_reason', async () => {
    // The new capability: the reason is a PARAMETER, not baked into the method
    // name. Swept over every vocabulary member so adding one can't skip a site.
    for (const reason of Object.values(OUTBOX_COMPLETION_REASON)) {
      resetMockSql();
      sqlReturnQueue.push(mkTaggedResult([{ id: 'x' }]));

      await markOutboxCompletedWithReason(execMock, 'outbox-1', reason, 3);

      const q = sqlCalls.at(-1)!;
      expect(q.text).toContain("SET status = 'completed'");
      // `completed_at` is what makes a completed row auditable — it is the only
      // record of WHEN the marker landed, and every other outbox writer sets it.
      // A generalization that dropped it would leave reasoned completions as the
      // one class of completed row with no completion timestamp.
      expect(q.text).toContain('completed_at = NOW()');
      expect(q.text).toContain('completion_reason');
      expect(q.values).toContain(reason);
      // Row scoping lives in the shared `dispatchedRow` fragment, but the bind
      // has to arrive from THIS caller — assert the id reached the values.
      expect(q.values).toContain('outbox-1');
    }
  });

  it('OUTBOX_COMPLETION_REASON preserves the persisted owner_unreachable wire value', () => {
    // The vocabulary is self-referential: the writer, both pollers, and every
    // fixture resolve the SAME constant, so renaming its VALUE (not its key)
    // would strand every historical row while leaving all of them green. This is
    // the one place a bare literal is correct — comparing the constant to the
    // durable wire value is the whole assertion.
    expect(OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE).toBe('owner_unreachable');
    expect(OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED).toBe('import_consent_blocked');
  });

  it('markOutboxCompletedWithReason guards on the dispatched attempt so a superseded attempt stamps no reason', async () => {
    await fc.assert(fc.asyncProperty(
      fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }), // dispatched-attempt param
      fc.integer({ min: 0, max: 50 }),                                // the row's ACTUAL attempts
      fc.boolean(),                                                    // row is currently 'dispatched'?
      fc.constantFrom(...Object.values(OUTBOX_COMPLETION_REASON)),     // every vocabulary member
      async (attempt, actualAttempts, isDispatched, reason) => {
        resetMockSql();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const rowMatches = typeof attempt === 'number'
          ? (isDispatched && attempt === actualAttempts)
          : isDispatched;
        sqlReturnQueue.push(mkTaggedResult(rowMatches ? [{ id: 'x' }] : []));
        await markOutboxCompletedWithReason(execMock, 'outbox-1', reason, attempt);
        const q = sqlCalls.at(-1)!;
        expect(q.text).toContain("SET status = 'completed'");
        expect(q.text).toContain('completion_reason');
        expect(q.values).toContain(reason);
        // HOISTED out of the attempt branch (round-1 finding): the legacy
        // no-attempt path still must not overwrite a terminal row, and the old
        // assertion only covered the guarded path.
        expect(q.text).toContain("status = 'dispatched'");
        if (typeof attempt === 'number') {
          expect(q.text).toContain('attempts =');
          expect(q.values).toContain(attempt);
        } else {
          expect(q.text).not.toContain('attempts =');
        }
        expect(warn).toHaveBeenCalledTimes(typeof attempt === 'number' && !rowMatches ? 1 : 0);
        warn.mockRestore();
      },
    ), { numRuns: 200 });
  });

  it('markOutboxCompletedWithReason warns and swallows a 0-row update rather than throwing', async () => {
    // The warn label must name the REASON, not just the method — an operator
    // reading the line needs to know which marker was lost to the race.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlReturnQueue.push(mkTaggedResult([]));

    await expect(
      markOutboxCompletedWithReason(
        execMock, 'outbox-9', OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, 4,
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(
      OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED,
    );
    warn.mockRestore();
  });
});
```

Finally, add one assertion to the EXISTING
`describe('outbox writers — dispatchedRow attempt-guard composition')` block, inside
whichever test already exercises `markOutboxCompleted` — no new `it`, this is a
one-line contrast that pins the "legacy and other-topic rows keep NULL" invariant:

```typescript
    // A generic completion must stay reasonless: if `markOutboxCompleted` ever
    // grew a reason, every ordinary completed row would look like a policy event.
    expect(sqlCalls.at(-1)!.text).not.toContain('completion_reason');
```

- [ ] **Step 2: Retarget the NotificationWorker suite and add its promised title**

In `worker/jobs/notification/__tests__/NotificationWorker.test.ts`:

1. Rename the hoisted mock `mockMarkOutboxOwnerUnreachable` →
   `mockMarkOutboxCompletedWithReason` (declaration ~line 12, `vi.hoisted` ~line 36,
   `mockReset()` ~line 223).
2. In the `vi.mock('../../../../src/lib/shared/outbox', …)` factory (~line 48),
   replace `markOutboxOwnerUnreachable: mockMarkOutboxOwnerUnreachable` with
   `markOutboxCompletedWithReason: mockMarkOutboxCompletedWithReason`.
3. Update the existing test `'records owner_unreachable via the helper when no
   verified enrollments (no dispatch)'` (~line 391): its destructure at ~line 403
   gains a slot, because the reason now sits at index 2 and the attempt moves to 3.

```typescript
    const [execArg, outboxIdArg, reasonArg, attemptArg] =
      mockMarkOutboxCompletedWithReason.mock.calls[0]!;
```

While there, **assert `reasonArg`** in that test too. Destructuring it and not using
it trips the unused-variable lint rule, and the assertion is the point of the slot:

```typescript
    expect(reasonArg).toBe(OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE);
```

4. Add the promised title. It exists to pin the ONE regression the generalization
   could introduce — the worker silently passing the wrong reason (or none):

```typescript
  it('NotificationWorker still stamps owner_unreachable through the generalized reason helper', async () => {
    // The generalization's failure mode is a lost, wrong, or MISPOSITIONED marker:
    // HealthAlertPoller.checkOwnerUnreachable and NotificationFailoverPoller both
    // key on this exact value, and a worker passing anything else makes them go
    // quiet with no error. Assert the FULL call tuple, not just the reason — the
    // argument list grew by one and an off-by-one would put the attempt where the
    // reason belongs, which a reason-only assertion cannot see.
    //
    // Drive the job with an EXPLICIT outbox_attempt (round-1 finding): the file's
    // other owner-unreachable test uses a payload without one, so `attempt` is
    // `undefined` there and forwarding is untested.
    mockGetVerifiedEnrollments.mockResolvedValue([]);

    await runJob({ outbox_id: 'ob-owner-1', outbox_attempt: 7 });

    expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledTimes(1);
    const [, outboxIdArg, reasonArg, attemptArg] =
      mockMarkOutboxCompletedWithReason.mock.calls[0]!;
    expect(outboxIdArg).toBe('ob-owner-1');
    expect(reasonArg).toBe(OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE);
    expect(attemptArg).toBe(7);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });
```

Import `OUTBOX_COMPLETION_REASON` from `'../../../../src/lib/shared/outbox-completion-reason'`
at the top of the file, and reuse whatever the file's existing zero-enrollments test
(~line 391) uses to drive the worker — mirror its arrange/act lines exactly rather
than inventing a `runJob()` helper if none exists, threading the explicit
`outbox_id` / `outbox_attempt` through whatever job payload that test builds.

- [ ] **Step 2b: Retarget the failover poller's live-Postgres marker test**

`worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts`
imports the deleted helper at **line 55** and calls it at **365** and **373**.
Deleting `markOutboxOwnerUnreachable` without this file breaks `pnpm typecheck`
outright (`tsconfig.json` includes `**/*.ts`) — this file was added to
`allowed_edit_surface` for exactly that reason (deviations D1).

This is also the **strongest pin in the whole branch** for the `owner_unreachable`
regression class: it asserts what Postgres actually stored, where every other check
only asserts what a mock received.

1. Swap the import at line 55 to `markOutboxCompletedWithReason`, **and update the
   file header comment at line 4**, which also names the deleted helper ("…plus the
   `markOutboxOwnerUnreachable` attempt-guarded CAS…"). T2 Step 4's `rg` sweep is
   exact and will flag the comment; a header naming a function that no longer exists
   is the stale-citation class this plan is otherwise careful about.
2. Retitle the `Step 6b` test at line 353 to the promised title and thread the
   reason argument through both calls:

```typescript
  it('markOutboxCompletedWithReason preserves owner_unreachable against live Postgres and rejects a superseded attempt', async () => {
    // …existing arrange, unchanged…
    await markOutboxCompletedWithReason(
      sql, outboxId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, attempt - 1,
    );
    // …existing assertion that the stale attempt left the row dispatched…
    await markOutboxCompletedWithReason(
      sql, outboxId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, attempt,
    );
    // …existing assertion that the winning attempt completed the row…
  });
```

3. Keep every existing arrange/assert line. If the test currently asserts the
   persisted `completion_reason`, leave that assertion **reading the constant**; if
   it does not assert the persisted value at all, add:

```typescript
    const [row] = await sql<{ completion_reason: string | null }[]>`
      SELECT completion_reason FROM job_outbox WHERE id = ${outboxId}::uuid
    `;
    expect(row!.completion_reason).toBe(OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE);
```

This suite is live-DB and executes **no DDL** — keep it that way (`ci:live-db-suites`).

- [ ] **Step 3: Add the four `guardImportConsent` unit titles**

In `worker/jobs/zernio/__tests__/job-eligibility.test.ts`:

1. Extend the hoisted harness so the completion recorder captures the reason. Add a
   second recorder alongside the existing `mockMarkOutboxCompleted` — **keep both**,
   because `guardZernioJobEligibility` in the same module still calls the plain
   `markOutboxCompleted` and an incomplete mock factory makes it `undefined`:

```typescript
    mockMarkOutboxCompletedWithReason: vi.fn(
      (_exec: unknown, outboxId: string, reason: string, attempt: number | undefined) => {
        completionCalls.push({
          outboxId,
          attempt,
          reason,
          inTransaction: harness.isInTransaction(),
        });
      },
    ),
```

   Widen the `completionCalls` element type with `reason?: string`.

2. Extend the module mock:

```typescript
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxCompletedWithReason: mockMarkOutboxCompletedWithReason,
}));
```

3. **Retarget every pre-existing `mockMarkOutboxCompleted` assertion in the
   `guardImportConsent` describe block — there are SEVEN, not four.** An earlier
   draft of this plan said four and the round-1 review caught it; do not trust a
   count, run the grep. After T3 the guard calls the *reason* variant, so a
   `not.toHaveBeenCalled()` assertion silently goes vacuous and a
   `toHaveBeenCalledTimes(1)` assertion goes red.

   Run: `rg -n "mockMarkOutboxCompleted" worker/jobs/zernio/__tests__/job-eligibility.test.ts`
   Current sites: **175** (accepted — `not.toHaveBeenCalled`), **187, 199, 209, 240,
   247** (the five block cases: declined / pending-live / expired / NULL-deadline /
   missing-row), **309** (accepted-past-deadline — `not.toHaveBeenCalled`). Lines
   **188-189** and **343-344** read `completionCalls` and need no change beyond the
   harness widening in sub-step 1.

   Swap each to `mockMarkOutboxCompletedWithReason`. Leave line **83**'s
   `markOutboxCompleted: mockMarkOutboxCompleted` mock entry in place —
   `guardZernioJobEligibility` still calls it at `job-eligibility.ts:92,101,116`.
4. Append the four promised titles inside the existing
   `describe('guardImportConsent (#679 spec §5.3 fail-closed gate)')` block:

```typescript
  it('guardImportConsent completes a refused backfill row with completion_reason import_consent_blocked', async () => {
    pushConsentState('declined');

    expect(await runGuard({ attempt: 3 })).toEqual({ kind: 'skipped' });

    expect(completionCalls).toHaveLength(1);
    expect(completionCalls[0]!.reason).toBe(
      OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED,
    );
    expect(completionCalls[0]!.attempt).toBe(3);
  });

  it('guardImportConsent stamps import_consent_blocked for a businesses row that does not exist', async () => {
    // A hand-inserted row for a deleted location is a refusal, not a separate
    // class — the single marker deliberately does not distinguish `missing`
    // from `declined`. The per-state detail lives in the log line below it.
    pushConsentState(null);

    expect(await runGuard()).toEqual({ kind: 'skipped' });

    expect(completionCalls[0]!.reason).toBe(
      OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED,
    );
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'missing' }),
    );
  });

  it('guardImportConsent writes the block reason inside its own consent transaction', async () => {
    // TITLE RETITLED at round-1 review (deviations D2). The original claimed "on the
    // transaction handle, never the outer sql client" — a property this harness
    // CANNOT observe: mock-sql.ts:99-103 invokes the `sql.begin` callback with the
    // same mock object, so `exec === mockSql` holds under a correct AND a broken
    // implementation. The title now claims only the `inTransaction` evidence below.
    //
    // The stronger property — that the completion rides the guard's OWN transaction
    // and therefore its `businesses` row lock — is pinned against real Postgres by
    // the forced-race test in job-eligibility.integration.test.ts, which is where a
    // regression would actually show up as lost consent.
    pushConsentState('expired');

    await runGuard();

    expect(completionCalls[0]!.inTransaction).toBe(true);
  });

  it('guardImportConsent stamps no completion_reason when consent is accepted', async () => {
    // Proceeding must leave the row untouched: the worker completes it itself
    // after the import, and a marker here would label a real import a refusal.
    pushConsentState('accepted');

    expect(await runGuard()).toEqual({ kind: 'proceed' });

    expect(completionCalls).toHaveLength(0);
    expect(mockMarkOutboxCompletedWithReason).not.toHaveBeenCalled();
  });
```

   Import `OUTBOX_COMPLETION_REASON` from
   `'../../../../src/lib/shared/outbox-completion-reason'`.

- [ ] **Step 4: Add the four live-DB integration titles**

In `worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts`. **This suite
executes no DDL and must not start** (`ci:live-db-suites` extracts executed SQL and
will fail the gate). Reuse the existing `sql()`, `businessId`, `insertHandRow`, and
`resetToLivePendingOffer` helpers.

Add one reader next to the existing `outboxStatus` (~line 190) — a new helper rather
than widening `outboxStatus`, whose existing callers only want the status:

```typescript
async function outboxCompletion(
  outboxId: string,
): Promise<{ status: string; completion_reason: string | null } | null> {
  const [row] = await sql()<{ status: string; completion_reason: string | null }[]>`
    SELECT status, completion_reason FROM job_outbox WHERE id = ${outboxId}::uuid
  `;
  return row ?? null;
}
```

```typescript
describe('#695 durable block reason on the refused outbox row', () => {
  it('guardImportConsent persists completion_reason=import_consent_blocked on the outbox row for a declined import', async () => {
    await resetToLivePendingOffer();
    await sql()`
      UPDATE businesses
      SET import_decision = 'declined', import_decision_at = now()
      WHERE id = ${businessId}::uuid
    `;
    const outboxId = '0195f0aa-0000-7000-8000-000000000101';
    await insertHandRow(outboxId);

    const gate = await guardImportConsent(sql(), {
      businessId, outboxId, attempt: undefined, logger: silentLogger,
    });

    expect(gate).toEqual({ kind: 'skipped' });
    expect(await outboxCompletion(outboxId)).toEqual({
      status: 'completed',
      completion_reason: OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED,
    });
  });

  it('guardImportConsent persists completion_reason=import_consent_blocked on the outbox row for a derived-expired import', async () => {
    // `expired` is DERIVED in Postgres, never stored — a `pending` row whose
    // deadline has passed. The marker must land for a state that exists only as
    // a CASE arm, which a JS-side branch would have had to re-derive.
    await resetToLivePendingOffer();
    await sql()`
      UPDATE businesses
      SET import_offer_expires_at = now() - interval '1 day'
      WHERE id = ${businessId}::uuid
    `;
    const outboxId = '0195f0aa-0000-7000-8000-000000000102';
    await insertHandRow(outboxId);

    const gate = await guardImportConsent(sql(), {
      businessId, outboxId, attempt: undefined, logger: silentLogger,
    });

    expect(gate).toEqual({ kind: 'skipped' });
    expect(await outboxCompletion(outboxId)).toEqual({
      status: 'completed',
      completion_reason: OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED,
    });
  });

  it('guardImportConsent persists completion_reason=import_consent_blocked on the outbox row for a live pending import', async () => {
    // Added at round-1 review (deviations D3). `pending` with a LIVE deadline is a
    // location that was OFFERED the import and has not answered yet — the state a
    // hand-inserted row most plausibly races, and the one refusal state that had no
    // live-DB pin. (Migration 100's default is `pending` with a NULL deadline, which
    // is a different population and is covered by the unit suite's NULL-deadline
    // test.) `resetToLivePendingOffer` leaves exactly this state.
    await resetToLivePendingOffer();
    const outboxId = '0195f0aa-0000-7000-8000-000000000104';
    await insertHandRow(outboxId);

    const gate = await guardImportConsent(sql(), {
      businessId, outboxId, attempt: undefined, logger: silentLogger,
    });

    expect(gate).toEqual({ kind: 'skipped' });
    expect(await outboxCompletion(outboxId)).toEqual({
      status: 'completed',
      completion_reason: OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED,
    });
  });

  it('guardImportConsent leaves completion_reason NULL on the outbox row when consent is accepted', async () => {
    await resetToLivePendingOffer();
    await sql()`
      UPDATE businesses
      SET import_decision = 'accepted', import_decision_at = now()
      WHERE id = ${businessId}::uuid
    `;
    const outboxId = '0195f0aa-0000-7000-8000-000000000103';
    await insertHandRow(outboxId);

    const gate = await guardImportConsent(sql(), {
      businessId, outboxId, attempt: undefined, logger: silentLogger,
    });

    expect(gate).toEqual({ kind: 'proceed' });
    // Still 'dispatched': proceeding leaves the row for the worker to complete.
    expect(await outboxCompletion(outboxId)).toEqual({
      status: 'dispatched',
      completion_reason: null,
    });
  });
});
```

The suite's logger is **`silentLogger`** (defined at lines 103-107, passed at line
386) — the samples above use that name. Import `OUTBOX_COMPLETION_REASON` from
`'../../../../src/lib/shared/outbox-completion-reason'` at the top of the file; the
`toEqual` assertions read the constant, never a bare literal.

Each test picks a distinct hard-coded `outboxId` UUID (…0101 / …0102 / …0103 /
…0104) so a leaked row from one cannot satisfy another's assertion.

- [ ] **Step 5: Confirm red, then commit**

Run: `pnpm vitest run src/lib/shared/__tests__/outbox.test.ts worker/jobs/zernio/__tests__/job-eligibility.test.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts`
Expected: FAIL — `markOutboxCompletedWithReason` is not exported from `../outbox`,
and `OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED` is `undefined`. `pnpm typecheck`
is expected to fail here too; T2 turns both green.

```bash
git add src/lib/shared/__tests__/outbox.test.ts worker/jobs/zernio/__tests__/job-eligibility.test.ts worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts
git commit -m "test(#695): failing eval for the durable import-consent block reason"
```

---

### Task 2: Vocabulary member + generalized outbox marker

**Turns green:** titles 1-6 — the three `markOutboxCompletedWithReason` unit titles,
the `OUTBOX_COMPLETION_REASON` wire-value title, the live-Postgres owner-unreachable
title, and the `NotificationWorker` title. **Blocked by:** T1.

**Files:**
- Modify: `src/lib/shared/outbox-completion-reason.ts`
- Modify: `src/lib/shared/outbox.ts:127-142` (`markOutboxOwnerUnreachable`)
- Modify: `worker/jobs/notification/NotificationWorker.ts:15,69`

`worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts`
is the fourth file the deletion affects, but it is retargeted in **T1 Step 2b** — it
is a test file, so it belongs to the eval task. T2 must not need to touch it; if it
does, Step 2b was done incompletely.

- [ ] **Step 1: Add the vocabulary member and its union type**

```typescript
export const OUTBOX_COMPLETION_REASON = {
  OWNER_UNREACHABLE: 'owner_unreachable',
  /**
   * A `zernio_initial_backfill` row refused by `guardImportConsent` — the
   * Import consent state was anything other than `accepted`, or the
   * `businesses` row was gone (#695). One marker, not one per state: it records
   * THAT a refusal happened, and the state that caused it lives only in the
   * guard's structured log line — a later read of `businesses` can disagree (a
   * `pending` refusal the owner then accepts) or find nothing (the `missing`
   * case), so a per-state column would be a point-in-time fact readers would
   * compare against current state.
   *
   * Read by operators, not by code — deliberately no poller and no alert
   * (unlike OWNER_UNREACHABLE). A refusal is the guard working, not an
   * incident; the query that makes it useful is in ADR 0016.
   */
  IMPORT_CONSENT_BLOCKED: 'import_consent_blocked',
} as const;

/** Every value `job_outbox.completion_reason` may be written with. */
export type OutboxCompletionReason =
  (typeof OUTBOX_COMPLETION_REASON)[keyof typeof OUTBOX_COMPLETION_REASON];
```

Keep `OWNER_UNREACHABLE_AGE_FLOOR_SECONDS` exactly as it is.

- [ ] **Step 2: Generalize the marker, deleting the reason-specific name**

Replace `markOutboxOwnerUnreachable` wholesale. **Do not leave a
`markOutboxOwnerUnreachable` wrapper** — this is a pre-launch codebase with one
in-repo caller and no external consumer, so a compatibility shim is forbidden.

```typescript
/**
 * Marks an outbox entry completed with a DURABLE reason, so a row that finished
 * without doing its work is distinguishable by SQL from one that did.
 *
 * Generalized from `markOutboxOwnerUnreachable` at #695, when Import consent
 * refusals became the second reason. One method parameterized by the vocabulary,
 * rather than one method per reason: the latter grows the outbox seam's interface
 * forever while every body stays this same eleven-line CAS.
 *
 * Same attempt-guarded CAS as `markOutboxCompletedIfOwned` — a stale superseded
 * attempt no-ops (0 rows, logged and swallowed) rather than stamping a reason onto
 * a newer attempt's row. Idempotent re-marking on a later retry is expected;
 * downstream reads the LATEST completed reason, not the mere presence of one.
 *
 * Returns `void` deliberately: neither caller branches on the CAS result, and
 * `markOutboxCompletedIfOwned` already models the shape that does.
 */
export async function markOutboxCompletedWithReason(
  exec: SqlExecutor,
  outboxId: string,
  reason: OutboxCompletionReason,
  attempt?: number,
): Promise<void> {
  const res = await exec`
    UPDATE job_outbox
    SET status = 'completed',
        completed_at = NOW(),
        completion_reason = ${reason}
    WHERE ${dispatchedRow(exec, outboxId, attempt)}
  `;
  if (hasAttempt(attempt) && res.count === 0) {
    warnOutboxNoop(`markOutboxCompletedWithReason(${reason})`, outboxId, attempt);
  }
}
```

Update the import at the top of the file to bring in the type:

```typescript
import {
  OUTBOX_COMPLETION_REASON,
  type OutboxCompletionReason,
} from './outbox-completion-reason';
```

`OUTBOX_COMPLETION_REASON` may become unused inside `outbox.ts` once the constant
moves to the call sites — if so, drop it from that import rather than leaving a
`fallow` dead-import finding.

- [ ] **Step 3: Update the single NotificationWorker call site**

At `worker/jobs/notification/NotificationWorker.ts:15`, swap the import:

```typescript
  markOutboxCompletedWithReason,
```

and add, alongside the file's other `src/lib/shared` imports:

```typescript
import { OUTBOX_COMPLETION_REASON } from '../../../src/lib/shared/outbox-completion-reason';
```

(match the relative-path style the file already uses for `src/lib/shared/outbox`).

At line 69:

```typescript
      await markOutboxCompletedWithReason(
        sql, outboxId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, outboxAttempt,
      );
```

Leave the `logger.warn` line above it unchanged.

- [ ] **Step 4: Verify no stragglers**

Run: `rg -n "markOutboxOwnerUnreachable" --glob '!docs/**'`
Expected: **no matches** outside `docs/`. Any hit in `src/`, `worker/`, or
`scripts/` means a call site or mock was missed.

There were **two** production-adjacent references, not one — `NotificationWorker.ts`
and `NotificationFailoverPoller.integration.test.ts` (the latter retargeted in T1
Step 2b). `tsconfig.json` includes `**/*.ts`, so a missed test-file reference fails
`pnpm typecheck` just as hard as a missed source one.

- [ ] **Step 5: Run the tests this task turns green**

Run: `pnpm vitest run src/lib/shared/__tests__/outbox.test.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts`
Expected: PASS. `worker/jobs/zernio/__tests__/job-eligibility.test.ts` is still
expected to FAIL — T3 owns it.

Run (live-DB, `TEST_DATABASE_POOL_URL` must be set):
`pnpm vitest run worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts`
Expected: PASS — this is the pin that the persisted `owner_unreachable` value
survived the generalization.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/shared/outbox-completion-reason.ts src/lib/shared/outbox.ts worker/jobs/notification/NotificationWorker.ts
git commit -m "refactor(#695): generalize the outbox reason marker; add import_consent_blocked"
```

---

### Task 3: `guardImportConsent` stamps the block reason

**Turns green:** titles 7-14 — the four `guardImportConsent` unit titles + the four
live-DB integration titles. **Blocked by:** T2.

**Files:**
- Modify: `worker/jobs/zernio/job-eligibility.ts` (imports + the `guardImportConsent` skip branch)

- [ ] **Step 1: Swap the completion writer inside the existing transaction**

`markOutboxCompleted` stays imported — `guardZernioJobEligibility` has three call
sites of its own. Add the second import and the vocabulary:

```typescript
import { markOutboxCompleted, markOutboxCompletedWithReason } from '../../../src/lib/shared/outbox';
import { OUTBOX_COMPLETION_REASON } from '../../../src/lib/shared/outbox-completion-reason';
```

In `guardImportConsent`'s skip branch, replace the completion call. **The `tx`
handle and the position inside `sql.begin` do not change** — that serialization is
#679's data-loss fix, not tidiness:

```typescript
    const reason: ImportConsentBlockReason = row?.state ?? 'missing';
    logger.log('import consent blocked — skipping backfill', {
      reason,
      business_id: businessId,
    });
    await markOutboxCompletedWithReason(
      tx, outboxId, OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, attempt,
    );
    return { kind: 'skipped' };
```

Leave the `logger.log` line untouched: the per-state `reason` it carries is exactly
what the single durable marker deliberately does not duplicate.

- [ ] **Step 2: Extend the function's doc comment**

Append one paragraph to `guardImportConsent`'s existing docblock — it is the
file's convention to explain *why*, and the "why one marker" decision belongs
where the write happens:

```typescript
 * THE REFUSAL IS DURABLE, NOT JUST LOGGED (#695). The completed row carries
 * `completion_reason = 'import_consent_blocked'`, so a policy refusal is
 * separable by SQL from a genuine completed import — previously the only trace
 * was the log line above plus the ABSENCE of a `zernio_backfill_runs` row.
 *
 * ONE marker covers all four refusal states, and it proves only THAT a refusal
 * happened, not which state caused it. The state at refusal time lives in the log
 * line above and NOWHERE else: reading `businesses` afterwards can disagree (a
 * `pending` refusal whose owner later accepts) or find nothing at all (the
 * `missing` case). That is the deliberate trade — a per-state marker would put a
 * point-in-time fact in a column readers would inevitably compare against current
 * state. Nothing reads the marker in code — no poller, no alert — because a
 * refusal is this guard working correctly (ADR 0016).
```

- [ ] **Step 3: Run the unit suite**

Run: `pnpm vitest run worker/jobs/zernio/__tests__/job-eligibility.test.ts`
Expected: PASS, including the five pre-existing block tests (declined / pending-live /
expired / NULL-deadline / missing-row) whose seven assertion sites were retargeted in
T1 Step 3.

- [ ] **Step 4: Run the live-DB integration suite**

`pnpm test:integration` hard-gates only the publisher suite, so this file must be
invoked **directly** — an existing-but-not-run suite is how #520 shipped
(CLAUDE.md gotcha). `TEST_DATABASE_POOL_URL` must be set and the DB at migrations
head (`pnpm test:db:setup`).

Run: `pnpm vitest run worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts`
Expected: PASS — including the pre-existing acceptance-race test, which proves the
guard still holds its `businesses` row lock across the completion.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/zernio/job-eligibility.ts
git commit -m "feat(#695): stamp import_consent_blocked on refused backfill outbox rows"
```

---

### Task 4: ADR 0016 + spec, glossary, and CLAUDE.md cross-references

**Turns green:** nothing (docs). **Blocked by:** T1 only — disjoint files from T2/T3,
so this runs in parallel with T2.

**Files:**
- Create: `docs/adr/0016-import-consent-enforcement-locus.md`
- Modify: `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` (§5.3)
- Modify: `CONTEXT.md` (the **Import consent** term)
- Modify: `.claude/CLAUDE.md` (the review-import-consent row of "Where things live")

- [ ] **Step 1: Write ADR 0016**

Follow the structure of `docs/adr/0010-owner-unreachable-outcome.md` (184 lines),
which is `Status` / `Context` / `Decision` / `Consequences` / `Post-implementation
review`. **ADR 0016 adds an `Alternatives considered` section that 0010 does not
have** — rejecting an alternative is this ADR's entire subject, so the section is
earned rather than copied. Target ~100 lines. Title:

```markdown
# ADR 0016 — Import consent enforcement stays in the worker, not at the job_outbox insertion boundary
```

**Status:** Accepted, 2026-08-08. Supersedes nothing; re-affirms spec §5.3 (locked
#670, shipped #679).

**Context** must state the challenge fairly, in the reviewer's own terms: the
`job_outbox` insertion boundary is a chokepoint every producer shares — product
code, the admin manual-SQL re-enqueue path, and future producers alike — and it
sits *before* dispatch rather than after. Cite #695 and
`docs/reviews/feat-679-import-consent-worker-guard/review-adversarial.md`.

**Decision:** enforcement stays at `guardImportConsent` in `ZernioBackfillWorker`.
No trigger, no constraint, no migration.

**Alternatives considered** carries §1 of this plan in substance — lead with the
duplicate-spelling/unenforced-drift argument, and state it at §1's revised strength:
a later migration *can* replace a trigger function, so the objection is unenforced
drift plus a two-project deploy coupling, **not** literal impossibility. Overstating
it is how an ADR loses its authority the first time someone checks. Include the
issue's three "For" points honestly before answering them.

**Consequences** must record all of:
- The admin hand-insert path is covered at *dispatch*, not at insert — an
  unconsented row is created, then no-op-completes. Nothing is imported.
- Refusals are now durably queryable via `completion_reason` (this same ticket), so
  the observability half of #695's complaint is answered without the trigger.
- The `sql.begin` + `SELECT … FOR UPDATE` cost #679 added to the worker's
  previously lock-free path stays. That is accepted: it is what closes the
  accept-races-guard data-loss window, which an insert-time gate would have had to
  re-derive at its own locus anyway.
- Revisit if a future consumer genuinely needs refusal at insert time — this ADR
  records a weighing, not a permanent ban.

Include the operator query, **with its limitation stated** — there is no backfill,
so refusals from before this ships are also NULL and the NULL bucket means "genuine
import OR pre-deployment refusal":

```sql
SELECT completion_reason, count(*)
FROM job_outbox
WHERE topic = 'zernio_initial_backfill'
  AND status = 'completed'
  AND created_at >= '<deploy timestamp>'   -- rows before this carry NULL either way
GROUP BY 1;
```

- [ ] **Step 2: Correct and amend spec §5.3**

§5.3 spans lines 173-214. This is a re-affirmation, so every decision stands — but
**one sentence must be corrected, not preserved.** §5.3 currently argues:

> The admin re-enqueue path is manual SQL … so no enqueue-time gate can ever cover it.

That is now known to be false as written: a `job_outbox` trigger *is* an enqueue-time
gate and *would* cover manual SQL — that is the whole substance of #695's challenge.
Leaving it while citing an ADR that engages with the trigger makes the spec argue
against itself. Narrow it to what is true:

```markdown
The admin re-enqueue path is manual SQL — a runbook instruction
(`src/app/admin/runbook/page.tsx`), not a route; `/admin/jobs` is read-only — so no
gate at the four PRODUCT enqueue paths can cover it. A database-level gate at the
`job_outbox` insertion boundary could; that alternative was weighed at #695 and
declined (ADR 0016). Among application-level loci, the one chokepoint every path
shares (product enqueues, admin hand-inserts, future code) is
`ZernioBackfillWorker` itself.
```

Then append at the end of §5.3, after the runbook paragraph:

```markdown
**Challenged and re-affirmed (2026-08-08, #695).** The adversarial review of #679
proposed the `job_outbox` insertion boundary as an alternative enforcement locus.
Weighed and declined: a trigger needs a second, unenforceable spelling of
`importConsentStateSql` in PL/pgSQL, which this section's single-owner rule exists
to prevent, and it would not remove the worker guard anyway. Full reasoning, the
"For" case, and the operator query for refused rows:
`docs/adr/0016-import-consent-enforcement-locus.md`. The refusal is now durable
(`job_outbox.completion_reason = 'import_consent_blocked'`), which answers the
observability half of the same review finding.
```

- [ ] **Step 3: Update the CONTEXT.md **Import consent** term**

Append to the existing bullet (line ~26), immediately after the sentence ending
"…all no-op-complete with a logged `reason`." Do not restructure the term; the
glossary's convention is one dense bullet per concept:

```markdown
Since #695 a refused row is also **durably marked** — `job_outbox.completion_reason
= 'import_consent_blocked'` (the `OUTBOX_COMPLETION_REASON` vocabulary, column from
migration 083) — so a policy refusal is separable by SQL from a genuine completed
import, which before was only inferable from the log line plus the absence of a
`zernio_backfill_runs` row. ONE marker for all four refusal states: it records THAT
a refusal happened, and the state that caused it lives only in the log line — a
later read of `businesses` can disagree (a `pending` refusal the owner then accepts)
or find nothing (the `missing` case). Nothing reads it in code: no poller, no alert,
no admin surface — a refusal is the guard working. No backfill, so a NULL on a row
predating #695 is not evidence of a genuine import. The `job_outbox`-boundary
alternative was weighed and declined at #695 (ADR 0016).
```

**Also correct the stale symbol in the same bullet.** It currently reads
"…inside `sql.begin` with `SELECT … FOR UPDATE` + `markOutboxCompleted(tx, …)`".
After T3 that call is `markOutboxCompletedWithReason(tx, …)` — update it, or the
glossary names a function the guard no longer calls.

Update the term's trailing provenance parenthetical to append `; durable block
reason + enforcement-locus ADR at #695`.

- [ ] **Step 4: Cross-reference from `.claude/CLAUDE.md`**

In the "Where things live" table, the row beginning "touch **review import
consent**" (line ~101), make **two** changes:

1. Add ADR 0016 next to the existing ADR 0015 citation:

```
+ ADR `docs/adr/0015-consented-import-unflagged-replacement.md` + ADR
`docs/adr/0016-import-consent-enforcement-locus.md` (enforcement locus — why not a
job_outbox trigger)
```

2. **Correct the stale symbol.** That row currently says the guard's body "must stay
inside `sql.begin` with `SELECT … FOR UPDATE` + `markOutboxCompleted(tx, …)`".
After T3 it is `markOutboxCompletedWithReason(tx, …)`. Both authoritative documents
name this call — leaving either stale means the next agent greps for a function the
guard does not call.

- [ ] **Step 5: Verify every cited artifact exists**

Run: `ls docs/adr/0016-import-consent-enforcement-locus.md && rg -n "0016-import-consent-enforcement-locus" docs/superpowers/specs/2026-08-05-consented-review-import-design.md CONTEXT.md .claude/CLAUDE.md`
Expected: the file exists and all three cross-references resolve. A plan that cites
a section which was never written is the #643 failure class — check, don't assume.

- [ ] **Step 6: Commit**

```bash
git add docs/adr/0016-import-consent-enforcement-locus.md docs/superpowers/specs/2026-08-05-consented-review-import-design.md CONTEXT.md .claude/CLAUDE.md
git commit -m "docs(#695): ADR 0016 — Import consent enforcement locus stays in the worker"
```

---

## 4. Gate

After **both T3 and T4** (not T4 alone — T4 is docs-only and finishes first), run
`bash scripts/verify-gate.sh`, and `--review` before step 7.
`TEST_DATABASE_POOL_URL` must be set — `db_touching: true`, so the gate provisions
the test DB serially and runs the changed `*.integration.test.ts` suites. A gate
carrying the live-DB SKIP warning is **not** review-ready for this branch: two of
the three most load-bearing tests here (the persisted `owner_unreachable` value and
the four persisted `import_consent_blocked` assertions) exist only there.

## 5. Self-review notes

- **Coverage:** all 14 `tests_to_add` titles are authored in T1 and named by the
  task that turns them green (T2: titles 1-6, T3: titles 7-14). Both halves of #695
  are covered — the design challenge by T4, the durable block reason by T1–T3.
- **Type consistency:** `markOutboxCompletedWithReason(exec, outboxId, reason,
  attempt?)` — reason at index 2, attempt at 3 — is spelled identically in T1
  Steps 1/2/2b/3, T2 Steps 2/3, and T3 Step 1. `OutboxCompletionReason` is defined
  in T2 Step 1 before its first use in T2 Step 2.
- **Net lines:** T2 deletes `markOutboxOwnerUnreachable` rather than adding a
  sibling, so the seam's method count is flat while gaining a vocabulary member.
- **Round-1 review deltas:** the `{T3,T4} → Gate` join, the fifth-through-seventh
  retargeted assertions in T1 Step 3, the `NotificationFailoverPoller` file, three
  added titles, one retitle, and four corrected doc claims (ADR 0010's structure,
  §5.3's "no enqueue-time gate can ever cover it", the `markOutboxCompleted(tx, …)`
  symbol in two authoritative docs, and the over-absolute immutability argument).
  Rejections and their reasoning are in the deviations file, not here.
