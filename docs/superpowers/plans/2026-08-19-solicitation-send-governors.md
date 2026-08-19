# Solicitation Send Governors Implementation Plan (#898)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three send governors that stand between an approved **Send batch parent** and a physical send — the platform-wide reputation circuit breaker, the platform daily ceiling, and the account daily cap — as callable domain modules with explicit `sql` parameters, plus migration 110. **Nothing in this plan sends.**

**Architecture:** Migration 110 makes three additive schema changes: two new members on the `withheld` arm of `solicitation_outreach_status_reason_consistency`, a `bounce_kind` discriminator column on `solicitation_outreach`, and the `solicitation_send_breaker` append-only latch table whose "at most one open trip" invariant lives in a partial unique index rather than in application code. Two new domain modules sit on top: `send-breaker.ts` (evaluate + trip, read, reset) and `send-caps.ts` (two resolvers, two counters). The `HealthAlertPoller` becomes the breaker's only tripper and pager; #900 will be its only reader. An AAL2-gated admin route and a new `/admin/solicitation` page own the reset.

**Tech Stack:** Postgres (Supabase), Postgres.js (`postgres`), Next.js 16 App Router, Fastify/BullMQ worker, Vitest, `fast-check`, Zod.

**Intake contract:** `.feature/intake.json` (arming copy) · `docs/superpowers/plans/feat-898-solicitation-send-governors-intake.json` (audit copy).

**Governing docs:** `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` §3.2A/§3.2B/§3.3/§3.4/§4 · `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` D19/D20 · `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` **B3/B6/B13** (the amendments doc wins on conflict).

---

## Glossary excerpt — use these terms verbatim

Every task prompt, identifier, comment, commit message and log line uses these. Do not paraphrase them, and do not coin synonyms.

- **Outreach row** — one `solicitation_outreach` row; one dispatch attempt for one **Ask**. Carries the send lifecycle (`delivery_status`, `disposition_reason`). _Avoid_: message row, send record.
- **Solicitation lane** — the branch of the Resend webhook ingress selected by `data.tags.lane === 'solicitation'`. Its write surface is deliberately narrow: `bounced_at`, `complained_at`, `provider_error`, plus the **Suppression ledger**. **This plan widens it by exactly one column, `bounce_kind`, of the same async-signal class** — Task 8 amends the `CONTEXT.md` entry in the same change. _Avoid_: solicitation webhook, second handler.
- **Sending identity** — the `reviews@feedback.<env>.repworth.net` mailbox + the `feedback.` sending domain + `SOLICITATION_RESEND_API_KEY`. **The asset the breaker protects.** One database is one Sending identity, which is why the breaker is a singleton and not per-domain. _Avoid_: from address, sender config.
- **Halt latch** — the monotone `halted_at`/`halt_reason`/`halted_by` write on `solicitation_batches`. **Distinct from the breaker**: the Halt latch stops ONE batch, the breaker stops ALL sending platform-wide. Never call the breaker a halt latch. _Avoid_: pause, resume, cancel batch.
- **Dispatch gate** — the nine-item union in amendments **B6**, run inside the child's pre-send transaction. **This ticket ships no gate**; it only widens the vocabulary two of its items need. _Avoid_: send gate (that is the **Send handoff**).
- **Send handoff** — `enqueueGenerateSolicitationAsks` at the end of `constructBatch`; withheld per-location with reason `postal_address_missing`. **A different fact from this ticket's `no_postal_address`** outreach disposition: handoff-time location fact vs dispatch-time row fact.

**New terms this plan coins** (Task 8 adds them to `CONTEXT.md`):

- **Send breaker** — the platform-wide reputation circuit breaker. One `solicitation_send_breaker` row per trip; a trip is **open** while `reset_at IS NULL`. Never self-clears.
- **Send breaker trip** — one row. Carries `tripped_at`, `trip_reason`, and the `metrics` snapshot that tripped it.
- **Breaker window** — rolling 7 days, minimum 100 sends. Denominator is send-dated (`sent_at`); numerators are signal-dated (`bounced_at` / `complained_at`).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/110_solicitation_send_governors.sql` | **Create.** Three additive changes. | 2 |
| `src/lib/shared/__tests__/helpers/schema-ready.ts` | **Modify.** Add `MIGRATION_110_SEND_GOVERNORS`. | 2 |
| `.claude/reference/migrations-log.md` | **Modify.** Head bump 109→110, entry, retention row. | 2 |
| `worker/ingress/resend/solicitation-lane.ts` | **Modify.** `recordBounce` writes `bounce_kind`. | 3 |
| `src/lib/solicitation/send-caps.ts` | **Create.** Two resolvers, two counters. No breaker knowledge. | 4 |
| `src/lib/solicitation/send-breaker.ts` | **Create.** `evaluateSendBreaker`, `readSendBreaker`, `resetSendBreaker`. | 5 |
| `scripts/ci/tenant-scope-allowlist.ts` | **Modify.** Three cross-account aggregate entries. | 4, 5 |
| `worker/background/pollers/health-alert/checks.ts` | **Modify.** `checkSolicitationSendBreaker` + one line in the sequential list. | 6 |
| `src/app/api/admin/solicitation/breaker/reset/route.ts` | **Create.** AAL2 gate → parse → one module call → map errors. | 7 |
| `src/app/admin/solicitation/page.tsx` | **Create.** Server page, Safety group. | 7 |
| `src/app/admin/solicitation/SendBreakerClient.tsx` | **Create.** Client panel. | 7 |
| `docs/runbooks/solicitation-sending-domain.md` | **Modify.** New §8. | 8 |
| `docs/runbooks/beta-launch-alerting.md` | **Modify.** Cross-ref. | 8 |
| `CONTEXT.md`, `docs/directory.md`, `.claude/reference/env-vars.md` | **Modify.** Glossary, rows, enforcement note. | 8 |

**Test files** (all created in Task 1):

| File | Lane |
|---|---|
| `src/lib/solicitation/__tests__/migration-110-send-governors.integration.test.ts` | live-DB |
| `src/lib/solicitation/__tests__/send-breaker.integration.test.ts` | live-DB |
| `src/lib/solicitation/__tests__/send-breaker.test.ts` | unit |
| `src/lib/solicitation/__tests__/send-caps.test.ts` | unit + property |
| `src/lib/solicitation/__tests__/send-caps.integration.test.ts` | live-DB |
| `worker/background/pollers/health-alert/__tests__/send-breaker-check.test.ts` | unit |
| `src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts` | unit |
| `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts` | live-DB (**modify**, do not create) |

---

## Task dependency graph

```
T1 (eval) ──┬──> T2 (migration) ──┬──> T3 (lane)      ─┐
            │                     └──> T5 (breaker) ───┼──> T6 (health check) ─┐
            └──> T4 (caps) ───────────────────────────┘                        ├──> T8 (docs)
                                                        └──> T7 (admin surface)┘
```

**Mutually independent (safe to dispatch in parallel):** `{T2, T4}` · `{T3, T5}` · `{T6, T7}`.
**Serial:** T1 alone first (its completion is the enforcement spot check). T8 alone last.

---

## Task 1: Eval — the spec in executable form

**Blocking edges:** none. **Turns green:** nothing — every test here MUST fail.

This task authors all 27 `tests_to_add` titles VERBATIM. The `promised-tests` gate row matches them character-for-character, so a retitle is a plan change, not a typo fix.

**Files:**
- Create: `src/lib/solicitation/__tests__/migration-110-send-governors.integration.test.ts`
- Create: `src/lib/solicitation/__tests__/send-breaker.integration.test.ts`
- Create: `src/lib/solicitation/__tests__/send-breaker.test.ts`
- Create: `src/lib/solicitation/__tests__/send-caps.test.ts`
- Create: `src/lib/solicitation/__tests__/send-caps.integration.test.ts`
- Create: `worker/background/pollers/health-alert/__tests__/send-breaker-check.test.ts`
- Create: `src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts`
- Modify: `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts`

- [ ] **Step 1: Read the two precedents before writing a line**

Read `src/lib/solicitation/__tests__/suppression.integration.test.ts` lines 1–60 for the live-DB suite skeleton, and `src/lib/reviews/__tests__/sentiment.test.ts` for the `fast-check` `describe('invariants')` house style. Copy their shape; do not invent a new one.

**Live-DB rules that are not negotiable (#573, CI-enforced by `ci:live-db-suites`):**
- A live-DB suite is named `*.integration.test.ts` and executes **NO DDL at run time** — `pnpm test:db:setup` provisions to head and the suite **asserts** with `assertSchemaReady`.
- Every write runs inside a transaction that is **always rolled back**.
- Acquire `acquireLiveDbLock` in `beforeAll`, release in `afterAll`, with `LIVE_DB_LOCK_HOOK_TIMEOUT_MS`.

- [ ] **Step 2: Write `migration-110-send-governors.integration.test.ts`**

```typescript
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_110_SEND_GOVERNORS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';

// Live-DB contract suite for migration 110 (#898). Three things only a real
// database can prove:
//
//  1. THE CHECK ARMS. `solicitation_outreach_status_reason_consistency` has
//     existed under that NAME since 091 and is REPLACED by 108, 109 and now
//     110, so presence proves nothing (the same trap `schema-ready.ts`
//     documents for analytics_events_event_name_check). Only the DEFINITION
//     can be tested, and only by pushing a value at it.
//  2. THE ONE-OPEN INDEX. "At most one trip is open" lives in a partial unique
//     index, not in application code, precisely so no future caller can
//     violate it. A test that only exercised the module would never see it.
//  3. DENY-ALL RLS. A missing `ENABLE ROW LEVEL SECURITY` does not fail to
//     compile; it silently exposes platform operational state.

const databaseUrl = resolveTestDatabaseUrl();
let sql: postgresType.Sql;
let lock: LiveDbLock;
let seed: TenantSeed;

describeWithDb('migration 110 — solicitation send governors', () => {
  beforeAll(async () => {
    assertLocalTestDatabaseUrl(databaseUrl);
    sql = postgres(databaseUrl, { max: 2, prepare: false, statement_timeout: 30_000 });
    lock = await acquireLiveDbLock(sql);
    await assertSchemaReady(sql, MIGRATION_110_SEND_GOVERNORS);
    seed = await seedTenantAccount(sql);
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanupTenantAccount(sql, seed);
    await lock?.release();
    await sql?.end({ timeout: 5 });
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  it('migration 110 admits no_postal_address and postal_address_mismatch on the withheld arm', async () => {
    for (const reason of ['no_postal_address', 'postal_address_mismatch']) {
      await expect(
        sql.begin(async (tx) => {
          await insertOutreach(tx, seed, { delivery_status: 'withheld', disposition_reason: reason });
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
    }
  });

  it('migration 110 still rejects an unknown withheld disposition_reason', async () => {
    await expect(
      sql.begin(async (tx) => {
        await insertOutreach(tx, seed, {
          delivery_status: 'withheld',
          disposition_reason: 'subscription_lapsed',
        });
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('migration 110 leaves the cancelled, failed and unknown arms of the reason CHECK unchanged', async () => {
    const arms: [string, string][] = [
      ['cancelled', 'owner_veto'], ['cancelled', 'owner_halt'], ['cancelled', 'admin_halt'],
      ['cancelled', 'owner_excluded'], ['cancelled', 'owner_withdrawn'],
      ['cancelled', 'batch_expired'], ['cancelled', 'send_window_elapsed'],
      ['cancelled', 'superseded'],
      ['failed', 'send_failed'], ['failed', 'send_exhausted'],
      ['unknown', 'send_indeterminate'],
    ];
    for (const [status, reason] of arms) {
      await expect(
        sql.begin(async (tx) => {
          await insertOutreach(tx, seed, { delivery_status: status, disposition_reason: reason });
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
    }
  });

  it('bounce_kind accepts only hard or soft and defaults to NULL', async () => {
    // NULL default on insert
    await expect(
      sql.begin(async (tx) => {
        const [row] = await insertOutreach(tx, seed, { delivery_status: 'rendered' });
        expect(row.bounce_kind).toBeNull();
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    // 'stale' is rejected by the value CHECK
    await expect(
      sql.begin(async (tx) => {
        const [row] = await insertOutreach(tx, seed, { delivery_status: 'sent' });
        await tx`UPDATE solicitation_outreach
                    SET bounced_at = NOW(), bounce_kind = 'stale' WHERE id = ${row.id}`;
      }),
    ).rejects.toMatchObject({ code: '23514' });
    // a kind without a bounce is rejected by the pairing CHECK
    await expect(
      sql.begin(async (tx) => {
        const [row] = await insertOutreach(tx, seed, { delivery_status: 'sent' });
        await tx`UPDATE solicitation_outreach SET bounce_kind = 'hard' WHERE id = ${row.id}`;
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('solicitation_send_breaker permits at most one open trip row', async () => {
    await expect(
      sql.begin(async (tx) => {
        await insertTrip(tx, { trip_reason: 'hard_bounce_rate' });
        await insertTrip(tx, { trip_reason: 'complaint_rate' });
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('solicitation_send_breaker admits a second trip once the prior trip is reset', async () => {
    await expect(
      sql.begin(async (tx) => {
        const [first] = await insertTrip(tx, { trip_reason: 'hard_bounce_rate' });
        await tx`UPDATE solicitation_send_breaker
                    SET reset_at = NOW(), reset_by = ${seed.userId}, reset_note = 'cap rolled back'
                  WHERE id = ${first.id}`;
        const [second] = await insertTrip(tx, { trip_reason: 'complaint_rate' });
        expect(second.id).not.toBe(first.id);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });

  it('solicitation_send_breaker has row level security enabled and denies the anon role', async () => {
    const [row] = await sql<{ relrowsecurity: boolean }[]>`
      SELECT c.relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'solicitation_send_breaker'`;
    expect(row.relrowsecurity).toBe(true);
    const policies = await sql`
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'solicitation_send_breaker'`;
    expect(policies).toHaveLength(0); // deny-all: RLS on, no policies (096 precedent)
  });
});
```

Write the two local helpers `insertOutreach(tx, seed, overrides)` and `insertTrip(tx, overrides)` in the same file (they are used by this suite only — no shared helper for one consumer), plus `class Rollback extends Error {}`. `insertOutreach` must supply every `NOT NULL` column 091 declares (`prompt_version`, `prompt_hash`, `interpolation_inputs`, `rendered_at`, `ask_lint_version`, `lint_detail`, `moderation_status`, `moderation_detail`) and satisfy 091's status↔timestamp CHECK: a `'sent'` row needs `sent_at`, a non-`'sent'` row must not carry one.

- [ ] **Step 3: Write `send-breaker.integration.test.ts`**

Same skeleton. Seven tests, titles VERBATIM:

```typescript
it('the breaker does not trip below the 100-send minimum however bad the rate', async () => {
  // 99 sends, 99 hard bounces = 100% — still no trip.
  await sql.begin(async (tx) => {
    await seedSends(tx, seed, { sent: 99, hardBounced: 99 });
    const finding = await evaluateSendBreaker(tx);
    expect(finding).toBeNull();
    expect(await countOpenTrips(tx)).toBe(0);
    throw new Rollback();
  }).catch(expectRollback);
});

it('the breaker trips when the hard bounce rate exceeds 2 percent over 100 or more sends', async () => {
  // 100 sends, 3 hard bounces = 3% > 2%.
  await sql.begin(async (tx) => {
    await seedSends(tx, seed, { sent: 100, hardBounced: 3 });
    const finding = await evaluateSendBreaker(tx);
    expect(finding?.key).toBe('solicitation_send_breaker_tripped');
    expect(finding?.level).toBe('error');
    expect(finding?.detail).toMatchObject({ trip_reason: 'hard_bounce_rate', sends: 100 });
    const [trip] = await tx`SELECT trip_reason, metrics FROM solicitation_send_breaker
                             WHERE reset_at IS NULL`;
    expect(trip.trip_reason).toBe('hard_bounce_rate');
    throw new Rollback();
  }).catch(expectRollback);
});

it('the breaker trips when the complaint rate exceeds 0.3 percent over 100 or more sends', async () => {
  // 1000 sends, 4 complaints = 0.4% > 0.3%, zero bounces.
  await sql.begin(async (tx) => {
    await seedSends(tx, seed, { sent: 1000, complained: 4 });
    const finding = await evaluateSendBreaker(tx);
    expect(finding?.detail).toMatchObject({ trip_reason: 'complaint_rate' });
    throw new Rollback();
  }).catch(expectRollback);
});

it('the breaker counts a bounce by bounced_at and a send by sent_at over the same 7 day window', async () => {
  // The locked window basis: numerator signal-dated, denominator send-dated.
  // A row sent 9 days ago whose bounce landed TODAY still counts in the
  // numerator, and is absent from the denominator. 100 in-window sends, zero
  // in-window bounces, plus 3 old sends that bounced today -> 3/100 = 3%.
  await sql.begin(async (tx) => {
    await seedSends(tx, seed, { sent: 100 });
    await seedSends(tx, seed, { sent: 3, hardBounced: 3, sentDaysAgo: 9, bouncedDaysAgo: 0 });
    const finding = await evaluateSendBreaker(tx);
    expect(finding?.detail).toMatchObject({ trip_reason: 'hard_bounce_rate', sends: 100, hard_bounces: 3 });
    throw new Rollback();
  }).catch(expectRollback);
});

it('the breaker reports hard_bounce_rate when both thresholds breach in the same window', async () => {
  // classifyBreach checks hard bounce FIRST. Without this test that precedence
  // is unobservable, and a reversed implementation passes every other test —
  // then pages the wrong metric on the one night both go bad at once.
  await sql.begin(async (tx) => {
    await seedSends(tx, seed, { sent: 1000, hardBounced: 30, complained: 10 }); // 3% and 1%
    const finding = await evaluateSendBreaker(tx);
    expect(finding?.detail).toMatchObject({ trip_reason: 'hard_bounce_rate' });
    const [trip] = await tx`SELECT trip_reason FROM solicitation_send_breaker WHERE reset_at IS NULL`;
    expect(trip.trip_reason).toBe('hard_bounce_rate');
    throw new Rollback();
  }).catch(expectRollback);
});

it('the breaker ignores soft bounces when computing the hard bounce rate', async () => {
  // 100 sends, 50 SOFT bounces, zero hard. No trip.
  await sql.begin(async (tx) => {
    await seedSends(tx, seed, { sent: 100, softBounced: 50 });
    expect(await evaluateSendBreaker(tx)).toBeNull();
    throw new Rollback();
  }).catch(expectRollback);
});

it('evaluateSendBreaker is idempotent while a trip is already open', async () => {
  // The one-open partial index makes a second trip a 23505 unless the insert
  // tolerates it. Two evaluations against a breached window must leave ONE row.
  await sql.begin(async (tx) => {
    await seedSends(tx, seed, { sent: 100, hardBounced: 3 });
    const first = await evaluateSendBreaker(tx);
    const second = await evaluateSendBreaker(tx);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // already open -> no second page
    expect(await countOpenTrips(tx)).toBe(1);
    throw new Rollback();
  }).catch(expectRollback);
});

it('readSendBreaker reports open while a trip is unreset and clear once it is reset', async () => {
  await sql.begin(async (tx) => {
    expect((await readSendBreaker(tx)).open).toBe(false);
    await seedSends(tx, seed, { sent: 100, hardBounced: 3 });
    await evaluateSendBreaker(tx);
    const tripped = await readSendBreaker(tx);
    expect(tripped.open).toBe(true);
    expect(tripped.trip?.tripReason).toBe('hard_bounce_rate');
    await resetSendBreaker(tx, { actorUserId: seed.userId, note: 'ramp rolled back to stage 1' });
    expect((await readSendBreaker(tx)).open).toBe(false);
    throw new Rollback();
  }).catch(expectRollback);
});
```

Write `seedSends(tx, seed, opts)` locally: it inserts `opts.sent` outreach rows with `delivery_status='sent'` and `sent_at = NOW() - (opts.sentDaysAgo ?? 1) days`, then stamps `bounced_at`/`bounce_kind='hard'` on the first `opts.hardBounced`, `bounce_kind='soft'` on the next `opts.softBounced`, and `complained_at` on the next `opts.complained`, each dated `NOW() - (opts.bouncedDaysAgo ?? 1) days`. Each row needs its own **Ask** and **Contact** to satisfy 091's FKs and the one-live-per-ask index — batch the inserts with a single `INSERT … SELECT … FROM generate_series` per table, not 100 round trips.

> **µs trap (#520):** seed timestamps with `NOW() - interval '…'` computed **in Postgres**. Never round-trip a JS `Date` into a window boundary comparison — postgres.js truncates microseconds and the comparison mis-orders by <1ms.

- [ ] **Step 4: Write `send-breaker.test.ts` (unit — the fail-closed contract)**

```typescript
it('readSendBreaker propagates a database failure so the caller halts rather than sends', async () => {
  // THE fail-closed invariant (#622 §3.2B): a DB failure inside the breaker's
  // own read degrades to HALT, never to "unmeasured therefore send". The
  // interface carries this fact — readSendBreaker returns state or THROWS, and
  // the throw IS the halt signal. It must never resolve to a "clear" verdict.
  const boom = new Error('connection terminated unexpectedly');
  const failing = (() => { throw boom; }) as unknown as Sql;
  await expect(readSendBreaker(failing)).rejects.toThrow('connection terminated unexpectedly');
});
```

- [ ] **Step 5: Write `send-caps.test.ts` (unit + property)**

```typescript
it('resolveAccountDailySendCap returns the platform default of 10 when the policy cap is null', () => {
  expect(resolveAccountDailySendCap({ dailySendCap: null })).toBe(DEFAULT_DAILY_SEND_CAP_ACCOUNT);
  expect(DEFAULT_DAILY_SEND_CAP_ACCOUNT).toBe(10);
});

it('resolvePlatformDailyCap returns 0 when SOLICITATION_PLATFORM_DAILY_CAP is unset or unparseable', () => {
  for (const value of [undefined, '', '   ', 'nope', '1.5', '-1', 'NaN', 'Infinity']) {
    expect(resolvePlatformDailyCap(value)).toBe(0);
  }
});

it('resolvePlatformDailyCap treats an explicit 0 as the dial at rest and not a misconfiguration', () => {
  expect(resolvePlatformDailyCap('0')).toBe(0);
  expect(resolvePlatformDailyCap('50')).toBe(50);
  expect(resolvePlatformDailyCap(' 5000 ')).toBe(5000);
});

describe('invariants', () => {
  it('resolveAccountDailySendCap never exceeds the platform default for any configured value', () => {
    // #619 D20 / amendment B3: the dial moves toward restraint ONLY. The schema
    // CHECK admits 1..50, so an admin CAN store 50 — the resolver is what makes
    // that harmless. An example test cannot cover the 1..50 range; this can.
    fc.assert(
      fc.property(fc.option(fc.integer({ min: 1, max: 50 }), { nil: null }), (configured) => {
        const effective = resolveAccountDailySendCap({ dailySendCap: configured });
        expect(effective).toBeLessThanOrEqual(DEFAULT_DAILY_SEND_CAP_ACCOUNT);
        expect(effective).toBeGreaterThanOrEqual(1);
        if (configured !== null) expect(effective).toBeLessThanOrEqual(configured);
      }),
    );
  });
});
```

`resolvePlatformDailyCap` takes the raw string as a **parameter** so the property/unit tests never mutate `process.env` (`src/lib/config/server.ts` reads it; the module's zero-arg overload is the composition-root convenience).

- [ ] **Step 6: Write `send-caps.integration.test.ts`**

```typescript
it('countAccountDispatchAttemptsToday counts outreach rows by queued_at in the UTC day and ignores sent_at', async () => {
  // Amendment B3: the counting basis is DISPATCH ATTEMPTS, not successes —
  // a bounce still spent reputation, so #619 D9's sent_at counting is
  // superseded. UTC day boundary mirrors auto-approval.ts.
  await sql.begin(async (tx) => {
    // The session zone AND the fixture spelling are both load-bearing (round-1
    // B1.6). Under UTC the short and long forms of the boundary agree, so the
    // case proves nothing; and a fixture that re-uses the production expression
    // shifts WITH the bug, so the boundary row is counted either way. Pin a
    // non-UTC zone, and spell the boundary a different way.
    await tx`SET LOCAL TIME ZONE 'America/New_York'`;
    await seedOutreach(tx, seed, { queuedAt: "(to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' 00:00:00+00')::timestamptz", sentAt: null });
    await seedOutreach(tx, seed, { queuedAt: 'NOW()', sentAt: 'NOW()' });
    await seedOutreach(tx, seed, { queuedAt: "NOW() - interval '2 days'", sentAt: 'NOW()' });
    await seedOutreach(tx, seed, { queuedAt: null, sentAt: null });
    expect(await countAccountDispatchAttemptsToday(tx, seed.accountId)).toBe(2);
    throw new Rollback();
  }).catch(expectRollback);
});

it('countAccountDispatchAttemptsToday excludes dispatch attempts belonging to another account', async () => {
  // Without a second tenant in the fixture, an implementation that DROPS the
  // account_id filter returns exactly the same number and every other test
  // stays green — while every account on the platform shares one cap.
  await sql.begin(async (tx) => {
    const other = await seedTenantAccount(tx);
    await seedOutreach(tx, seed, { queuedAt: 'NOW()', sentAt: null });
    await seedOutreach(tx, other, { queuedAt: 'NOW()', sentAt: null });
    expect(await countAccountDispatchAttemptsToday(tx, seed.accountId)).toBe(1);
    expect(await countAccountDispatchAttemptsToday(tx, other.accountId)).toBe(1);
    throw new Rollback();
  }).catch(expectRollback);
});
```

Add to `send-caps.test.ts` (unit), beside the other `resolvePlatformDailyCap` cases:

```typescript
it('resolvePlatformDailyCap returns 0 for a value too large to be a safe integer', () => {
  // The one branch Number.isSafeInteger exists for: /^\d+$/ admits the digits,
  // Number() silently rounds past 2^53, and a ceiling nobody can reach is not
  // a ceiling. Fails closed like every other unparseable value.
  expect(resolvePlatformDailyCap('99999999999999999999')).toBe(0);
});
```

- [ ] **Step 7: Write `send-breaker-check.test.ts` (unit)**

```typescript
it('checkSolicitationSendBreaker returns an error finding naming the breached metric', async () => {
  const finding = await checkSolicitationSendBreaker(stubSqlReturning({
    sends: 100, hard_bounces: 3, complaints: 0,
  }));
  expect(finding?.key).toBe('solicitation_send_breaker_tripped');
  expect(finding?.level).toBe('error');
  expect(finding?.title).toContain('hard bounce');
  // Aggregate-only detail — counts and rates, never a recipient address or
  // message content (checkStalledSendBatches precedent).
  expect(JSON.stringify(finding?.detail)).not.toMatch(/@/);
});

it('checkSolicitationSendBreaker returns null when the window is healthy', async () => {
  expect(await checkSolicitationSendBreaker(stubSqlReturning({
    sends: 5_000, hard_bounces: 10, complaints: 5,
  }))).toBeNull(); // 0.2% and 0.1% — both under bar
});
```

- [ ] **Step 8: Write `reset-route.test.ts` (unit)**

Mirror `src/app/api/admin/autonomy/__tests__/routes.test.ts` exactly — same mocking of `requireAdminWithAal2`, same `NextRequest` construction.

```typescript
it('the breaker reset route rejects a request without AAL2', async () => {
  gateMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'aal2_required' }, { status: 403 }) });
  expect((await POST(makeRequest({ note: 'x' }))).status).toBe(403);
});

it('the breaker reset route fixes the actor from the session and ignores any actor in the body', async () => {
  // Same discipline adminHaltBatch applies to its reason: identity comes from
  // the gate, never from the request. A body-supplied actor must not merely be
  // overridden — strictObject REJECTS it, so a caller cannot believe it worked.
  const response = await POST(makeRequest({ note: 'ramp rolled back', actorUserId: OTHER_USER_ID }));
  expect(response.status).toBe(400);
  expect(resetSendBreakerMock).not.toHaveBeenCalled();
});

it('the breaker reset route returns 409 when no trip is open', async () => {
  resetSendBreakerMock.mockResolvedValue({ reset: false });
  const response = await POST(makeRequest({ note: 'nothing to clear' }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'not_tripped' });
});

it('the breaker reset route requires a non-empty note', async () => {
  for (const note of ['', '   ']) {
    expect((await POST(makeRequest({ note }))).status).toBe(400);
  }
});
```

- [ ] **Step 9: Add the lane test to the EXISTING suite**

Append to `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts`, inside the existing bounce `describe`. Do **not** create a new file.

```typescript
it('the solicitation lane records bounce_kind hard for a permanent bounce and soft for a transient one', async () => {
  const permanent = await seedAndDeliver(buildBouncePayload({ bounceType: 'Permanent' }));
  expect((await readOutreach(permanent.outreachId)).bounce_kind).toBe('hard');
  const transient = await seedAndDeliver(buildBouncePayload({ bounceType: 'Transient' }));
  expect((await readOutreach(transient.outreachId)).bounce_kind).toBe('soft');
});
```

Extend the suite's local `readOutreach` projection with `bounce_kind` (it already lists `bounced_at::text`, `complained_at::text`).

- [ ] **Step 10: Run the suite and verify EVERY new test fails**

```bash
cd <worktree-root> && export TEST_DATABASE_POOL_URL=... DATABASE_POOL_URL=... \
  && pnpm vitest run src/lib/solicitation/__tests__/send-breaker \
       src/lib/solicitation/__tests__/send-caps \
       src/lib/solicitation/__tests__/migration-110 \
       worker/background/pollers/health-alert/__tests__/send-breaker-check \
       src/app/api/admin/solicitation 2>&1 | tail -40
```

Expected: every test FAILS. Live-DB suites fail at `assertSchemaReady` naming `110_solicitation_send_governors`; unit suites fail on unresolved imports. **A test that passes here is a test that asserts nothing — fix it now, not later.**

- [ ] **Step 11: Commit**

```bash
git add src/lib/solicitation/__tests__ worker/background/pollers/health-alert/__tests__ \
        src/app/api/admin/solicitation worker/ingress/__tests__
git commit -m "test(898): eval task — 27 failing tests define the send governors"
```

---

## Task 2: Migration 110

**Blocking edges:** T1. **Turns green:** the 7 schema-contract tests in `migration-110-send-governors.integration.test.ts` (and unblocks `assertSchemaReady` for T5's suite).

**Files:**
- Create: `supabase/migrations/110_solicitation_send_governors.sql`
- Modify: `src/lib/shared/__tests__/helpers/schema-ready.ts`
- Modify: `.claude/reference/migrations-log.md`

- [ ] **Step 1: Confirm the number**

`grep -n "Current head" .claude/reference/migrations-log.md` must read **109**. Yours is **110**. Never guess or reuse.

- [ ] **Step 2: Write the migration**

```sql
-- 110_solicitation_send_governors.sql
--
-- Solicitation send governors (#898; wayfinder map #617, child of #630).
-- THREE ADDITIVE CHANGES, NO DATA CHANGE.
--
--   (a) Dispatch-gate withhold vocabulary — two members amendment B6 items 6
--       needs. Item 3 (subscriptionGrantsFullAccess) deliberately gets NO
--       member: a lapsed subscription is recoverable inside the send window,
--       so the child gate DEFERS (the row stays 'rendered') and the existing
--       send_window_elapsed cancellation is the terminal answer. Do not widen
--       this CHECK further than the gate can write.
--   (b) solicitation_outreach.bounce_kind — the hard/soft discriminator the
--       reputation circuit breaker reads. #622 §3.2B counts bounce.type =
--       'Permanent' only, but the Solicitation lane stamps bounced_at for soft
--       bounces too, so bounced_at alone cannot serve.
--   (c) solicitation_send_breaker — the platform-wide latch. Deny-all RLS.
--
-- NO BACKFILL IS NEEDED, and this is a proof rather than an observation: no
-- send worker exists (#899 builds it), so nothing in any environment has ever
-- written solicitation_outreach.sent_at or received a bounce webhook for one.
--
-- Specs: docs/superpowers/specs/2026-07-28-sender-deliverability-design.md
--        §3.2A/§3.2B/§4; …-send-mode-cross-spec-amendments.md B3/B6.

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── (a) Dispatch-time withhold vocabulary ───────────────────────────────────
-- Strict superset of 109's text. Every other arm is reproduced byte-for-byte;
-- the IS TRUE wrapper is 091's NULL-safety idiom and must not be dropped.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_status_reason_consistency;

ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_status_reason_consistency CHECK (
    (
      (delivery_status IN ('rendered', 'queued', 'sending', 'sent')
        AND disposition_reason IS NULL) OR
      (delivery_status = 'withheld' AND disposition_reason IN (
        'moderation_high', 'render_failed', 'lint_failed',
        'no_consent', 'suppressed', 'unsubscribed',
        'no_postal_address', 'postal_address_mismatch'
      )) OR
      (delivery_status = 'cancelled' AND disposition_reason IN (
        'owner_veto', 'owner_halt', 'admin_halt', 'owner_excluded', 'owner_withdrawn',
        'batch_expired', 'send_window_elapsed', 'superseded'
      )) OR
      (delivery_status = 'failed' AND disposition_reason IN (
        'send_failed', 'send_exhausted'
      )) OR
      (delivery_status = 'unknown' AND disposition_reason = 'send_indeterminate')
    ) IS TRUE
  );

COMMENT ON CONSTRAINT solicitation_outreach_status_reason_consistency ON solicitation_outreach IS
  'Status <-> reason totality. 110 added no_postal_address and postal_address_mismatch to the withheld arm for the Dispatch gate (#898, amendment B6 item 6); item 3 (subscriptionGrantsFullAccess) deliberately has NO member because a lapsed subscription defers and send_window_elapsed terminalizes. 109 added owner_withdrawn; 108 added owner_excluded; every other arm is 091 verbatim.';

-- ── (b) bounce_kind ─────────────────────────────────────────────────────────
ALTER TABLE solicitation_outreach
  ADD COLUMN IF NOT EXISTS bounce_kind TEXT;

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_bounce_kind_check;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_bounce_kind_check
  CHECK ((bounce_kind IS NULL OR bounce_kind IN ('hard', 'soft')) IS TRUE);

-- A kind without a bounce is incoherent, and would let the breaker's numerator
-- count a row its denominator never saw.
ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_bounce_kind_pairing;
ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_bounce_kind_pairing
  CHECK ((bounce_kind IS NULL OR bounced_at IS NOT NULL) IS TRUE);

COMMENT ON COLUMN solicitation_outreach.bounce_kind IS
  'hard | soft; NULL until a bounce lands. Written by the Solicitation lane beside bounced_at (#898). The reputation circuit breaker counts hard only (#622 §3.2B: bounce.type = Permanent). provider_error cannot serve as the discriminator because recordFailure COALESCEs failed:<reason> into that same column, so an email.failed arriving before email.bounced would mask a real hard bounce — the fail-OPEN direction on a governor specified to fail closed.';

-- Serves the breaker denominator, which is the only unbounded count in the
-- 7-day window. The bounced_at / complained_at numerators are DELIBERATELY
-- unindexed: at the top ramp stage (5,000/day x 7 days) the window holds ~35k
-- rows and the breaker runs once per 5-minute poll cycle, so a bitmap scan is
-- cheaper than two more indexes to maintain on every send. Revisit at stage 5,
-- not before.
CREATE INDEX IF NOT EXISTS idx_solicitation_outreach_sent_at
  ON solicitation_outreach (sent_at)
  WHERE sent_at IS NOT NULL;

-- ── (c) solicitation_send_breaker ───────────────────────────────────────────
-- APPEND-ONLY. One row per trip; a trip is OPEN while reset_at IS NULL. Chosen
-- over a mutable singleton because a second breach would otherwise overwrite
-- the first, and a breach is exactly the thing someone reviews after the fact.
-- account_audit_log cannot hold this: it is account-scoped, and this event is
-- platform-wide. This table IS the audit record.
CREATE TABLE IF NOT EXISTS solicitation_send_breaker (
  id           UUID PRIMARY KEY,             -- UUIDv7, app-supplied (repo convention, no DB default)
  tripped_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trip_reason  TEXT NOT NULL,
  metrics      JSONB NOT NULL,               -- the snapshot that tripped it
  reset_at     TIMESTAMPTZ,
  reset_by     UUID REFERENCES users(id),    -- NO ACTION on delete: the reset CHECK below forbids NULLing it
  reset_note   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT solicitation_send_breaker_trip_reason_check
    CHECK (trip_reason IN ('hard_bounce_rate', 'complaint_rate')),

  -- A reset is ONE act: timestamp, actor and note together or none. This is
  -- what makes "who cleared this, and why" unanswerable-by-omission impossible.
  CONSTRAINT solicitation_send_breaker_reset_consistency CHECK (
    (
      (reset_at IS NULL AND reset_by IS NULL AND reset_note IS NULL) OR
      (reset_at IS NOT NULL AND reset_by IS NOT NULL
        AND reset_note IS NOT NULL AND length(btrim(reset_note)) > 0)
    ) IS TRUE
  )
);

-- AT MOST ONE OPEN TRIP, enforced in the database rather than in application
-- code — the same idiom as 091's solicitation_outreach_one_live_per_ask. The
-- expression is (reset_at IS NULL) rather than a bare constant so the index
-- expression is unambiguously IMMUTABLE over a real column.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_send_breaker_one_open
  ON solicitation_send_breaker ((reset_at IS NULL))
  WHERE reset_at IS NULL;

COMMENT ON TABLE solicitation_send_breaker IS
  'Platform-wide reputation circuit breaker trips (#898, #622 §3.2B). Append-only; a trip is open while reset_at IS NULL, and at most one may be open. NEVER self-clears — only an explicit admin reset closes one. Platform-scoped: no account_id, therefore not a TENANT_TABLES member. Admin-only (deny-all RLS).';

ALTER TABLE solicitation_send_breaker ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all (096 precedent).

COMMIT;
```

- [ ] **Step 3: Add the schema requirement**

In `src/lib/shared/__tests__/helpers/schema-ready.ts`, after `MIGRATION_108_OUTREACH_OWNER_EXCLUDED`:

```typescript
/**
 * #898. The CHECK is NOT the proof: `solicitation_outreach_status_reason_consistency`
 * has existed under that name since 091 and is REPLACED by 108, 109 and 110,
 * so its presence is satisfied by a database three migrations behind head —
 * the same trap documented for analytics_events_event_name_check below. The
 * new relation, column and index are the honest proof that 110 is applied.
 */
export const MIGRATION_110_SEND_GOVERNORS: SchemaRequirement = {
  migration: '110_solicitation_send_governors',
  tables: ['solicitation_send_breaker'],
  columns: ['solicitation_outreach.bounce_kind'],
  indexes: ['solicitation_send_breaker_one_open'],
};
```

- [ ] **Step 4: Bookkeeping in `.claude/reference/migrations-log.md`**

Three edits, all in this commit:
1. Line 4: `Current head: **110** — next migration is **111**`.
2. A `110` entry after `109`, matching the surrounding entries' prose style: the three changes, why item 3 gets no member, why no backfill is needed, and the append-only + one-open-index rationale.
3. A **retention policy** row for `solicitation_send_breaker`: *No TTL — a trip and its reset are the audit record for a platform-wide sending halt, and this table is the only sink that can hold one (`account_audit_log` is account-scoped). No poller touches it. Not in `TABLE_DISPOSITIONS`: the table carries no `account_id` and no customer data, so account offboarding has nothing to purge.*

- [ ] **Step 5: Verify `TABLE_DISPOSITIONS` genuinely needs no entry**

```bash
cd <worktree-root> && pnpm vitest run src/lib/account-offboarding/__tests__/table-disposition.test.ts 2>&1 | tail -20
```
Expected: PASS. If a test asserts exhaustiveness over the live schema, add a `not_applicable` / `not_checked` entry for `solicitation_send_breaker` in `src/lib/account-offboarding/table-disposition.ts` **and** record it in the deviations file — that file is outside `allowed_edit_surface` and needs a surface amendment first.

- [ ] **Step 6: Provision and run**

```bash
cd <worktree-root> && pnpm test:db:setup 2>&1 | tail -5
pnpm vitest run src/lib/solicitation/__tests__/migration-110-send-governors.integration.test.ts 2>&1 | tail -20
```
Expected: 7 passed.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/110_solicitation_send_governors.sql \
        src/lib/shared/__tests__/helpers/schema-ready.ts .claude/reference/migrations-log.md
git commit -m "feat(898): migration 110 — dispatch withhold vocabulary, bounce_kind, send breaker latch"
```

---

## Task 3: Solicitation lane writes `bounce_kind`

**Blocking edges:** T2. **Turns green:** `the solicitation lane records bounce_kind hard for a permanent bounce and soft for a transient one`.

**Files:** Modify `worker/ingress/resend/solicitation-lane.ts` (`recordBounce`).

- [ ] **Step 1: Extend the UPDATE**

`classifyBounce` already returns `isHard`. Add one column to the existing statement — do not add a second statement, and do not change the `COALESCE` first-write-wins semantics the surrounding columns use.

```typescript
      const updated = await tx`
        UPDATE solicitation_outreach
           SET bounced_at = COALESCE(bounced_at, NOW()),
               -- The breaker's discriminator (#898). COALESCE for the same
               -- reason bounced_at does: a redelivered webhook must not
               -- reclassify a bounce we already recorded. Paired with
               -- bounced_at by 110's bounce_kind_pairing CHECK, so it is set
               -- in the SAME statement or the row is rejected.
               bounce_kind = COALESCE(bounce_kind, ${isHard ? 'hard' : 'soft'}),
               provider_error = COALESCE(provider_error, ${reason}),
               updated_at = NOW()
         WHERE id = ${attribution.id}
      `;
```

- [ ] **Step 2: Run and commit**

```bash
cd <worktree-root> && pnpm vitest run worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts 2>&1 | tail -20
git add worker/ingress/resend/solicitation-lane.ts worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts
git commit -m "feat(898): solicitation lane records bounce_kind beside bounced_at"
```
Expected: the whole suite passes — the pre-existing bounce tests must not regress.

---

## Task 4: `send-caps.ts` — platform ceiling and account daily cap

**Blocking edges:** T1 only (`queued_at` exists since 091; this task does **not** need migration 110). **Mutually independent with T2.** **Turns green:** the 5 cap tests.

**Files:**
- Create: `src/lib/solicitation/send-caps.ts`
- Modify: `scripts/ci/tenant-scope-allowlist.ts`

- [ ] **Step 1: Write the module**

Precedent: `src/lib/auto-approval/policy.ts`. Match its shape — a named constant with a doc comment stating where the number comes from, and a resolver that is a pure function of the policy row.

```typescript
import type { Sql, TransactionSql } from 'postgres';

/**
 * Platform default when an account's `auto_approval_policies.daily_send_cap`
 * is NULL — amendment B3 / #622 D4. Ten, not 25, because the cap must bind a
 * SINGLE approved batch: at 25 (= BATCH_CAP) a full batch could dispatch
 * inside one calendar day and the cap would only bite on a second batch. At
 * 10 a 25-ask batch is structurally forced across >= 3 calendar days, so the
 * velocity story is true by construction rather than by the drip worker
 * behaving. #619 §8's 50 is superseded.
 *
 * Deliberately the same number as DEFAULT_DAILY_AUTO_POST_CAP
 * (src/lib/auto-approval/policy.ts). SEPARATELY OWNED constants that coincide
 * by design today — never derive one from the other.
 */
export const DEFAULT_DAILY_SEND_CAP_ACCOUNT = 10;

/**
 * The enforced per-account cap. LEAST(configured, platform default): the
 * schema CHECK admits 1..50, so an admin CAN store 50 — this resolver is what
 * makes that harmless. **The dial moves toward restraint only** (#619 D20).
 */
export function resolveAccountDailySendCap(
  policy: { dailySendCap: number | null },
): number {
  const configured = policy.dailySendCap;
  if (configured === null) return DEFAULT_DAILY_SEND_CAP_ACCOUNT;
  return Math.min(configured, DEFAULT_DAILY_SEND_CAP_ACCOUNT);
}

/**
 * The platform-wide daily ceiling (#622 §3.2A) — the warm-up dial and the
 * emergency brake in one var.
 *
 * FAILS CLOSED: unset, blank or unparseable yields 0, and 0 means NO SENDS.
 * An explicit '0' is the dial at rest, not a misconfiguration — the two are
 * indistinguishable by design, because both must stop sending.
 *
 * Takes the raw value as a parameter so it is a pure function; the zero-arg
 * form is the composition-root convenience.
 */
export function resolvePlatformDailyCap(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  if (!/^\d+$/.test(trimmed)) return 0;   // rejects '-1', '1.5', 'nope', 'Infinity'
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/**
 * Dispatch attempts made by one account in the current UTC day.
 *
 * COUNTING BASIS IS `queued_at`, NOT `sent_at` (amendment B3): a bounce still
 * spent reputation, so #619 D9's sent_at counting is superseded. UTC day
 * boundary mirrors worker/jobs/response-generation/auto-approval.ts:231.
 *
 * THE TRAILING `AT TIME ZONE 'UTC'` IS LOAD-BEARING. Without it, the truncated
 * value is a bare `timestamp`, which Postgres casts back to `timestamptz` using
 * the SESSION zone — a LOCAL-day boundary, wrong for part of the day in every
 * zone but one. An earlier draft of this plan carried the short form and the bug
 * shipped from it once (round-1 B1.9); auto-approval.ts:231 has always had the
 * trailing conversion.
 *
 * Takes `sql` explicitly (invariant #15) — this module never imports
 * @/lib/db/server.
 */
export async function countAccountDispatchAttemptsToday(
  sql: Sql | TransactionSql,
  accountId: string,
): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
      FROM solicitation_outreach
     WHERE account_id = ${accountId}
       AND queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `;
  return row?.count ?? 0;
}

/**
 * Dispatch attempts made across ALL accounts in the current UTC day — the
 * figure the platform ceiling bounds. Cross-account BY DESIGN: the ceiling is
 * the blast-radius bound for a runaway fan-out, so a per-account view cannot
 * express it. Allowlisted in scripts/ci/tenant-scope-allowlist.ts.
 *
 * Same trailing `AT TIME ZONE 'UTC'`, same reason as above — never drop it.
 */
export async function countPlatformDispatchAttemptsToday(
  sql: Sql | TransactionSql,
): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
      FROM solicitation_outreach
     WHERE queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `;
  return row?.count ?? 0;
}
```

- [ ] **Step 2: Allowlist the cross-account query**

Add one entry to `scripts/ci/tenant-scope-allowlist.ts` for `countPlatformDispatchAttemptsToday`, following the shape of the existing solicitation-lane entries (file, symbol, `sqlSnippet`, reason). Reason: *the platform ceiling is a blast-radius bound across all accounts; a tenant-scoped view cannot express it (#622 §3.2A).*

- [ ] **Step 3: Run, verify, commit**

```bash
cd <worktree-root> && pnpm vitest run src/lib/solicitation/__tests__/send-caps 2>&1 | tail -20
pnpm ci:tenant-scope 2>&1 | tail -5
git add src/lib/solicitation/send-caps.ts scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(898): send-caps — platform ceiling resolver, account daily cap, UTC-day dispatch counters"
```

---

## Task 5: `send-breaker.ts` — the reputation circuit breaker

**Blocking edges:** T2. **Mutually independent with T3.** **Turns green:** the 7 breaker integration tests + the fail-closed unit test.

**Files:**
- Create: `src/lib/solicitation/send-breaker.ts`
- Modify: `scripts/ci/tenant-scope-allowlist.ts`

- [ ] **Step 1: Write the module**

Three functions. Read the interface contract in the doc comments as binding — especially the throw semantics, which #900 depends on.

```typescript
import { v7 as uuidv7 } from 'uuid';   // repo convention: app-supplied UUIDv7 PKs
                                       // (precedent: src/lib/audit/log.ts,
                                       //  src/lib/notifications/delivery.ts).
                                       // `uuid` is already a dependency — adding
                                       // one would need .feature/deps-justification.md
                                       // plus package.json in the edit surface.
import type { Sql, TransactionSql } from 'postgres';

/** #622 §3.2B, locked. Rates are fractions, not percentages. */
export const BREAKER_WINDOW_DAYS = 7;
export const BREAKER_MIN_SENDS = 100;
export const BREAKER_HARD_BOUNCE_RATE = 0.02;   // > 2%
export const BREAKER_COMPLAINT_RATE = 0.003;    // > 0.3% — Gmail's stated bar

export const BREAKER_TRIP_REASONS = ['hard_bounce_rate', 'complaint_rate'] as const;
export type BreakerTripReason = (typeof BREAKER_TRIP_REASONS)[number];

export interface BreakerWindow {
  sends: number;
  hardBounces: number;
  complaints: number;
  hardBounceRate: number;
  complaintRate: number;
}

export interface SendBreakerTrip {
  id: string;
  trippedAt: Date;
  tripReason: BreakerTripReason;
  metrics: BreakerWindow;
}

export interface SendBreakerState {
  open: boolean;
  trip: SendBreakerTrip | null;
}
```

**`readSendBreaker`** — the gate read #900 calls every tick:

```typescript
/**
 * Is solicitation sending halted?
 *
 * FAIL-CLOSED CONTRACT — part of this interface, not of each caller's
 * judgment. This function returns state or THROWS. **The throw IS the halt
 * signal**: #622 §3.2B requires a DB failure in the breaker's own read path to
 * degrade to HALT, never to "unmeasured therefore send". It is the deliberate
 * inverse of the replica-cardinality precedent, which fails OPEN because a
 * worker that will not start is worse.
 *
 * A caller that wraps this in try/catch and proceeds has broken the invariant.
 * There is no "unknown" verdict to return, and adding one would be the bug.
 *
 * Cheap by construction: one indexed existence probe against
 * solicitation_send_breaker_one_open. The expensive read model lives in
 * evaluateSendBreaker, which runs on the HealthAlertPoller, not on the send
 * loop.
 */
export async function readSendBreaker(sql: Sql | TransactionSql): Promise<SendBreakerState> {
  const [row] = await sql<{ id: string; tripped_at: Date; trip_reason: BreakerTripReason; metrics: unknown }[]>`
    SELECT id, tripped_at, trip_reason, metrics
      FROM solicitation_send_breaker
     WHERE reset_at IS NULL
  `;
  if (!row) return { open: false, trip: null };
  return {
    open: true,
    trip: {
      id: row.id,
      trippedAt: row.tripped_at,
      tripReason: row.trip_reason,
      // PgBouncer can hand JSONB back as a string (the sanctioned carve-out).
      metrics: (typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics) as BreakerWindow,
    },
  };
}
```

**`evaluateSendBreaker`** — the read model, the trip, and the page:

```typescript
/**
 * Compute the Breaker window, trip the latch if it breaches, and return the
 * HealthFinding to page on (null when healthy or already open).
 *
 * WINDOW BASIS, locked in grilling and NOT symmetric:
 *   - denominator is SEND-dated  (sent_at within the window)
 *   - numerators are SIGNAL-dated (bounced_at / complained_at within it)
 * Bounces lag their send by minutes to days, so a cohort measure would dilute
 * a fresh bad batch with sends whose bounces have not landed — the fail-OPEN
 * direction. Signal-dating means a burst of bounces from a send 8 days ago
 * still trips it, and the ratio can exceed 1.0 in a pathological burst. That
 * is a trip, not a bug.
 *
 * The MIN_SENDS floor is checked before any rate: small-N noise must not trip
 * a platform-wide halt.
 *
 * Cross-account BY DESIGN — the asset protected is the shared Sending
 * identity, not one tenant's. Allowlisted in tenant-scope-allowlist.ts.
 *
 * Idempotent while a trip is open: the INSERT tolerates the one-open partial
 * unique index, so a second breached tick is a no-op and pages once, not every
 * five minutes.
 */
export async function evaluateSendBreaker(sql: Sql | TransactionSql): Promise<HealthFinding | null> {
  const window = await readBreakerWindow(sql);
  const reason = classifyBreach(window);
  if (reason === null) return null;

  const [inserted] = await sql<{ id: string }[]>`
    INSERT INTO solicitation_send_breaker (id, trip_reason, metrics)
    VALUES (${uuidv7()}, ${reason}, ${sql.json(window)})
    ON CONFLICT ((reset_at IS NULL)) WHERE reset_at IS NULL DO NOTHING
    RETURNING id
  `;
  if (!inserted) return null;   // a trip was already open — do not re-page
  return breakerFinding(reason, window);
}
```

> **`ON CONFLICT` byte-for-byte rule:** the conflict target and its `WHERE` must match `solicitation_send_breaker_one_open`'s definition **exactly** — `((reset_at IS NULL)) WHERE reset_at IS NULL`. A mismatch does not fail to compile; it throws *"no unique or exclusion constraint matching the ON CONFLICT specification"* at runtime, on the second breach. If Postgres declines to infer from this expression index, fall back to a `SELECT … WHERE reset_at IS NULL` guard **inside the caller's transaction** and record the change in the deviations file — do not silently drop the index.

Write the three private helpers in the same file:

```typescript
async function readBreakerWindow(sql: Sql | TransactionSql): Promise<BreakerWindow> {
  const [row] = await sql<{ sends: number; hard_bounces: number; complaints: number }[]>`
    SELECT
      COUNT(*) FILTER (
        WHERE sent_at >= NOW() - make_interval(days => ${BREAKER_WINDOW_DAYS})
      )::int AS sends,
      COUNT(*) FILTER (
        WHERE bounce_kind = 'hard'
          AND bounced_at >= NOW() - make_interval(days => ${BREAKER_WINDOW_DAYS})
      )::int AS hard_bounces,
      COUNT(*) FILTER (
        WHERE complained_at >= NOW() - make_interval(days => ${BREAKER_WINDOW_DAYS})
      )::int AS complaints
    FROM solicitation_outreach
  `;
  const sends = row?.sends ?? 0;
  const hardBounces = row?.hard_bounces ?? 0;
  const complaints = row?.complaints ?? 0;
  return {
    sends, hardBounces, complaints,
    hardBounceRate: sends === 0 ? 0 : hardBounces / sends,
    complaintRate: sends === 0 ? 0 : complaints / sends,
  };
}

/** Hard bounce is checked first: it is the louder signal and the one a provider acts on soonest. */
function classifyBreach(w: BreakerWindow): BreakerTripReason | null {
  if (w.sends < BREAKER_MIN_SENDS) return null;
  if (w.hardBounceRate > BREAKER_HARD_BOUNCE_RATE) return 'hard_bounce_rate';
  if (w.complaintRate > BREAKER_COMPLAINT_RATE) return 'complaint_rate';
  return null;
}
```

`breakerFinding` returns `{ key: 'solicitation_send_breaker_tripped', level: 'error', title, detail }`. **Detail is aggregate-only** — counts, rates, thresholds and the window length. Never a recipient address, a subject, or body text (the `checkStalledSendBatches` precedent: "detail is ids and durations only").

**`resetSendBreaker`** — the admin arm:

```typescript
/**
 * Close the open trip. The ONLY thing that clears the breaker — it never
 * self-clears, because a breach is a fact someone must look at.
 *
 * The actor is passed in by the route from its gate identity and is never read
 * from a request body — the same discipline adminHaltBatch applies to its
 * reason. A note is mandatory: 110's reset_consistency CHECK rejects a reset
 * without one, so "who cleared this and why" cannot be unanswerable.
 *
 * Resetting a still-breached window is PERMITTED and correct: the operator may
 * have just rolled the ceiling down, and forcing them to wait out a 7-day
 * window would be worse. The next poller tick re-evaluates honestly and
 * re-trips if the breach stands. The runbook says so.
 *
 * Returns { reset: false } when nothing was open — the route maps that to 409,
 * mirroring the unsuspend route's not_suspended arm.
 */
export async function resetSendBreaker(
  tx: TransactionSql,
  input: { actorUserId: string; note: string },
): Promise<{ reset: boolean; tripId: string | null }> { /* UPDATE … WHERE reset_at IS NULL RETURNING id */ }
```

- [ ] **Step 2: UUIDv7 — resolved, no branch**

Pre-resolved during the round-1 plan review: the repo has **no** `src/lib/shared/uuid` helper. Every app-supplied UUIDv7 PK uses the `uuid` package directly — `import { v7 as uuidv7 } from 'uuid'` — as in `src/lib/audit/log.ts:2` and `src/lib/notifications/delivery.ts:1`. Follow that precedent verbatim.

Do **not** substitute `randomUUID()` from `node:crypto`: that is UUID**v4**, which is random rather than time-ordered and breaks the time-ordered-PK convention `.claude/reference/migrations-log.md` line 5 states for every table. (Invariant #10's "use node:crypto" governs *hashing*, not id generation.)

- [ ] **Step 3: Allowlist, run, commit**

```bash
cd <worktree-root> && pnpm vitest run src/lib/solicitation/__tests__/send-breaker 2>&1 | tail -25
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:db-imports 2>&1 | tail -10
git add src/lib/solicitation/send-breaker.ts scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(898): reputation circuit breaker — 7d window read model, one-open trip latch, fail-closed read"
```

---

## Task 6: HealthAlertPoller wiring

**Blocking edges:** T5. **Mutually independent with T7.** **Turns green:** the 2 health-check tests.

**Files:** Modify `worker/background/pollers/health-alert/checks.ts`.

- [ ] **Step 1: Add the check beside `checkStalledSendBatches`**

```typescript
/**
 * The reputation circuit breaker (#622 §3.2B) — the piece a runbook genuinely
 * cannot do, because it has to fire at 3am.
 *
 * This poller is the breaker's ONLY tripper. #900's releaser is a pure reader
 * (readSendBreaker), so the expensive 7-day aggregate never runs on the send
 * loop. The cost is bounded trip latency: one HEALTH_ALERT_POLL_INTERVAL_MS
 * window (5 min default), which is ~17 sends at the top ramp stage and ~0 at
 * stage 1.
 *
 * Runs UNCONDITIONALLY, including when SOLICITATION_SEND_ENABLED is false: per
 * rule DR1 the Solicitation lane is never flag-gated, so bounce and complaint
 * facts keep arriving for mail already sent, and a live breach must still page.
 */
export async function checkSolicitationSendBreaker(sql: postgres.Sql): Promise<HealthFinding | null> {
  return evaluateSendBreaker(sql);
}
```

- [ ] **Step 2: Add ONE line to `runHealthChecks`, in the SEQUENTIAL list**

After `collect(await checkStalledSendBatches(sql));`:

```typescript
  collect(await checkSolicitationSendBreaker(sql));
```

> **Do NOT** wrap this in `Promise.all` with its neighbours, and do not "optimise" the sequential list. Firing these concurrently on one postgres.js client over the Supavisor transaction pooler pipelines them onto a shared connection and permanently wedges the `max:2` health client every cycle (#505, proven by a 6/6-vs-0/6 staging differential).

> **Do NOT** wrap it in the `try/catch` that isolates `checkBacklogDepth`. That isolation exists because the backlog check reads the DB precisely when the DB is under pressure. The breaker is the opposite case: a throw here must fail the cycle loudly, matching the fail-closed contract, rather than degrading to a warning that reads as "no breach".

- [ ] **Step 3: Run and commit**

```bash
cd <worktree-root> && pnpm vitest run worker/background/pollers/health-alert 2>&1 | tail -20
git add worker/background/pollers/health-alert/
git commit -m "feat(898): HealthAlertPoller evaluates and pages the send breaker"
```

---

## Task 7: Admin reset surface

**Blocking edges:** T5. **Mutually independent with T6.** **Turns green:** the 4 route tests.

**Files:**
- Create: `src/app/api/admin/solicitation/breaker/reset/route.ts`
- Create: `src/app/admin/solicitation/page.tsx`
- Create: `src/app/admin/solicitation/SendBreakerClient.tsx`

- [ ] **Step 1: Invoke the `repworth-brand-design` skill**

This is a Console-system surface. Read the skill and its Style Reference **before** writing JSX — do not infer tokens from neighbouring files.

- [ ] **Step 2: Write the route**

Copy `src/app/api/admin/autonomy/unsuspend/route.ts` structure exactly: `requireAdminWithAal2` → `request.json()` in try/catch → `z.strictObject` → `sql.begin(tx => resetSendBreaker(tx, …))` → 409 arm → `internalError` → `export const POST = withSameOrigin()(reset)`. Plus `export const dynamic = 'force-dynamic'`.

```typescript
// strictObject is load-bearing: a body carrying actorUserId is REJECTED, not
// silently overridden, so a caller cannot believe it chose the actor. The
// actor comes from gate.admin.id — the same discipline adminHaltBatch applies
// to its reason (identity fixes it; no request field can name it).
const ResetSchema = z.strictObject({
  note: z.string().trim().min(1).max(1_000),
});
```

The route orchestrates only (invariant #12): gate, parse, one module call, map errors. No breaker logic here. `{ reset: false }` → `409 { error: 'not_tripped' }`.

- [ ] **Step 3: Write the page and client panel**

`page.tsx`: `await requireAdminPage(sql, { from: '/admin/solicitation', aal2: true })` — AAL2 unconditional, matching the route. Then `readSendBreaker(sql)`, ISO-stringify the dates so the server-rendered `initialData` is structurally identical to a client refetch (the `/admin/autonomy` precedent), and render inside `<AdminPage group="Safety" title="Solicitation send breaker" description="Platform-wide halt on solicitation sending">`.

`SendBreakerClient.tsx`: when no trip is open, render the clear state and **no reset control** (there is nothing to reset). When open, render `tripped_at`, the trip reason as prose, the `metrics` snapshot (sends, hard-bounce rate, complaint rate against their thresholds), a required note field, and the reset button. On success, refetch. Copy `AutonomySuspensionsClient.tsx`'s fetch/error/pending shape.

> **Copy rule:** this surface is admin-facing, so the **Halt latch**'s owner-facing "stop" carve-out does **not** apply. Say *breaker*, *tripped*, *reset*. Never *pause*, *resume*, or *cancel*.

- [ ] **Step 4: Run, build, commit**

```bash
cd <worktree-root> && pnpm vitest run src/app/api/admin/solicitation 2>&1 | tail -20
pnpm ci:admin-aal2 && pnpm ci:static-policy 2>&1 | tail -5
pnpm build 2>&1 | tail -15
git add src/app/api/admin/solicitation src/app/admin/solicitation
git commit -m "feat(898): admin send-breaker reset route + /admin/solicitation Safety page"
```

---

## Task 8: Documentation and domain sweep

**Blocking edges:** T5, T6, T7. **Turns green:** nothing — the `docs_only` gate mode applies.

**Files:** Modify `docs/runbooks/solicitation-sending-domain.md`, `docs/runbooks/beta-launch-alerting.md`, `CONTEXT.md`, `docs/directory.md`, `.claude/reference/env-vars.md`.

- [ ] **Step 1: Runbook §8 — do NOT create a new file**

Add §8 *Reputation circuit breaker* to `docs/runbooks/solicitation-sending-domain.md`, after §7. It must **link** to §5's ramp table and §6's seed gate, never restate them — those facts keep exactly one owner (the #643 lesson). §8 covers: the read model and its two thresholds; what a trip page looks like (`solicitation_send_breaker_tripped`); the diagnosis order (check the window figures, then roll `SOLICITATION_PLATFORM_DAILY_CAP` down a stage per §5, then reset); the reset procedure at `/admin/solicitation` with its mandatory note; and the explicit statement that **resetting a still-breached window re-trips on the next poller tick, by design**.

- [ ] **Step 2: Cross-reference from the alerting runbook**

In `docs/runbooks/beta-launch-alerting.md`, add `solicitation_send_breaker_tripped` to the finding-key inventory with a pointer to §8 as its response procedure.

- [ ] **Step 3: `CONTEXT.md` — three new terms and one amendment**

Add **Send breaker**, **Send breaker trip** and **Breaker window** to the *Solicitation (send-mode)* section, each with its `_Avoid_` list and `*(coined in #898)*` provenance. Distinguish **Send breaker** from **Halt latch** explicitly (platform-wide vs one batch) and from **Send handoff** (`no_postal_address` dispatch-time row fact vs `postal_address_missing` handoff-time location fact).

**Amend the existing Solicitation lane entry**: its write surface is now `bounced_at`, `complained_at`, `bounce_kind`, `provider_error` + the Suppression ledger. State that `bounce_kind` is the same async-signal class 091 calls "columns, NOT statuses", and why `provider_error` could not serve.

- [ ] **Step 4: `docs/directory.md` rows**

One row per new production file under `worker/` and `src/lib/` — `ci:directory-map` fails on a production file with no row:
- `src/lib/solicitation/send-breaker.ts`
- `src/lib/solicitation/send-caps.ts`

Put the WHY in the `§ src/lib/solicitation/` folder prose (CLAUDE.md is shape-guarded; a row says WHERE plus ≤3 one-clause traps).

- [ ] **Step 5: `.claude/reference/env-vars.md`**

No new var. Update the `SOLICITATION_PLATFORM_DAILY_CAP` entry: enforcement now exists (`resolvePlatformDailyCap`, `src/lib/solicitation/send-caps.ts`), it still fails closed to 0, and #900 is the consumer that acts on it.

- [ ] **Step 6: Verify and commit**

```bash
cd <worktree-root> && pnpm ci:directory-map && pnpm vitest run src/__tests__/claude-md-shape.test.ts 2>&1 | tail -10
git add docs/ CONTEXT.md .claude/reference/env-vars.md
git commit -m "docs(898): runbook §8 breaker procedure, CONTEXT terms, directory rows, env-var enforcement note"
```

---

## Self-review

**1. Spec coverage.** Ticket §1(a) → T2 step 2(a). §1(b) → T2 step 2(c). §2 breaker → T5 + T6 (read model, platform scope, never self-clears, HealthAlertPoller paging, fail-closed read, admin reset surface T7). §3 platform ceiling → T4 `resolvePlatformDailyCap`. §4 account cap → T4 `resolveAccountDailySendCap` + `countAccountDispatchAttemptsToday`; the dropped `resolveSolicitationDailyCap()` twin and `DEFAULT_DAILY_SEND_CAP_BUSINESS` are absent, as B3 requires. §5 gate order → the modules are callable and independently ordered by #900; **this plan wires no order**, matching "#900 wires them into the release decision". §6 runbook → T8 step 1, deliberately as a section rather than a file (owner-approved deviation from the ticket text).

**Deliberate deviations from the ticket text, both owner-approved during grilling:** no new runbook file; `bounce_kind` widens the Solicitation lane's write surface by one column.

**2. Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Two steps deliberately branch on a fact the plan cannot know without running (T2 step 5's `TABLE_DISPOSITIONS` exhaustiveness, T5 step 2's UUIDv7 helper path) — each states the check command, both outcomes, and the deviations-file obligation. That is a decision procedure, not a placeholder.

**3. Type consistency.** `resolveAccountDailySendCap({ dailySendCap })` — one property name, used identically in T1 step 5 and T4 step 1. `evaluateSendBreaker` returns `HealthFinding | null` in T1 step 3, T5 and T6. `readSendBreaker` returns `SendBreakerState` (`{ open, trip }`) in T1 steps 3–4, T5 and T7. `resetSendBreaker(tx, { actorUserId, note })` returns `{ reset, tripId }` in T1 step 3, T5 and T7 — the route reads `reset` only. `trip_reason` values are `'hard_bounce_rate' | 'complaint_rate'` in the migration CHECK, `BREAKER_TRIP_REASONS`, and every test.
