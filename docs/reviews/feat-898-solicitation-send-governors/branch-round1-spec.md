# Branch review round 1 — Spec & correctness (`feat-898-solicitation-send-governors`)

**Question:** does `git diff main...HEAD` faithfully implement `.feature/intake.json` and the plan's eight tickets?

**Scope reviewed:** fork point `54e4d374` → `7b0cda9b` (21 commits, 34 files, +5,303/−7).
Read in full: `.feature/intake.json`, `docs/superpowers/plans/2026-08-19-solicitation-send-governors.md`,
`docs/superpowers/plans/feat-898-solicitation-send-governors-deviations.md` (all 25 entries + 2 surface
amendments), `docs/reviews/feat-898-solicitation-send-governors/blast-radius.md`, every production file
and every test file in the diff.

**Verification run (read-only):**

- `npx vitest run src/lib/solicitation/__tests__/send-caps.test.ts src/lib/solicitation/__tests__/send-breaker.test.ts src/app/api/admin/solicitation src/app/admin/solicitation worker/background/pollers/health-alert/__tests__` → 11 files passed, 102 tests passed, 2 skipped (live-DB).
- `npx vitest run src/__tests__/eslint-boundaries.test.ts src/components/admin/__tests__/AdminSidebar.test.tsx src/lib/account-offboarding/__tests__/table-disposition.test.ts` → 3 files, 40 tests passed.
- Byte-diff of migration 110's `solicitation_outreach_status_reason_consistency` predicate against 109's: **identical except the two intended withheld members.** No other arm, member order, or the `IS TRUE` wrapper moved.

**Overall:** the branch is a faithful implementation. The four asymmetries the brief singled out
(asymmetric window, UTC-day boundary, fail-closed read, `ON CONFLICT` inference) are all implemented
correctly and — with one exception noted below — discriminatingly tested. No edit-surface drift.
Findings below are one test-coverage hole, one inherited fail-open classification, and a set of
contract/observability gaps.

---

## Findings

| # | Severity | File:line | Finding |
|---|---|---|---|
| 1 | Medium | `worker/background/pollers/health-alert/checks.ts:4`, `:338` | The module's stated contract "Read-only health checks … **No writes.**" is now false — `checkSolicitationSendBreaker` writes. It also sits in the shared-fate SEQUENTIAL core list, so a write failure now fails the whole cycle. |
| 2 | Medium | `src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts:79` | Promised test "the breaker reset route fixes the actor from the session and ignores any actor in the body" asserts only the *ignores* half. Nothing anywhere asserts `resetSendBreaker` receives `gate.admin.id`. |
| 3 | Medium | `worker/ingress/resend/bounce-classifier.ts:43`, `worker/ingress/resend/solicitation-lane.ts:288` | An unrecognised `bounce.type` classifies as `soft` and is excluded from the breaker's hard-bounce numerator — fail-OPEN on a governor the intake specifies as fail-closed. Untested. |
| 4 | Low | `src/lib/solicitation/__tests__/send-caps.integration.test.ts:103` | The `utc_day_start` fixture spells the boundary with the **short** form while production uses the long form, so the promised "in the UTC day" test cannot detect removal of the trailing `AT TIME ZONE 'UTC'` — the exact bug the T4 follow-up fixed stays untested. |
| 5 | Low | `src/lib/solicitation/send-breaker.ts` (whole file), `src/app/api/admin/solicitation/breaker/reset/route.ts:47` | Both structured log lines the intake's `observability` promises — `'solicitation send breaker tripped'` on trip, and the admin-reset line naming actor + trip id — are absent. |
| 6 | Low | `supabase/migrations/110_solicitation_send_governors.sql:92` | `idx_solicitation_outreach_sent_at` is created but appears in neither rollback script (intake `rollback_plan`, migrations-log 110 entry). The intake invariant "additive only: one nullable column, two new CHECK members, one new table" also omits it and the two new named constraints. |
| 7 | Low | `src/lib/solicitation/send-breaker.ts:130`, `src/app/api/admin/solicitation/breaker/route.ts:25` | No shipped surface exposes the **live** Breaker window while the breaker is clear, so the intake's own failure-detection story ("an absent finding against a non-zero send denominator visible in the same read model") is unobservable. |
| 8 | Low | `docs/superpowers/plans/2026-08-19-solicitation-send-governors.md:1231`, `:1248` | The checked-in plan still carries the **short** UTC-day form as the module source (as does `.feature/intake.json` `edge_cases[11]`). A resumed session re-deriving from the plan re-introduces the local-day bug. |

### 1 — `checks.ts` is no longer read-only, and the write shares fate with every other finding

`worker/background/pollers/health-alert/checks.ts:1-5` opens with:

> `// Read-only health checks for the silent-failure … // null. No writes.`

`checkSolicitationSendBreaker` (`:338`) delegates to `evaluateSendBreaker`, which performs
`INSERT INTO solicitation_send_breaker … ON CONFLICT … DO NOTHING`. Two consequences:

- The stated invariant is now wrong at the top of the file that owns it. Anyone reasoning about
  routing this poller onto a read path, or about what `recycleHealthSql` can safely abandon, is
  reading a false premise.
- `collect(await checkSolicitationSendBreaker(sql));` (`:434`) is inside the **core** sequential list,
  which is deliberately shared-fate (`:421-422`: "a core-check rejection propagates and fails the
  cycle"). Until now a core rejection could only come from a `SELECT`. A failed **write** — a lock
  wait on `solicitation_send_breaker_one_open`, a `23514` from a future constraint, or
  `HEALTH_CHECK_TIMEOUT_MS` firing mid-INSERT — now aborts the cycle and suppresses the outbox,
  stalled-dispatching and zero-delivery findings that ran before it, plus the backlog check after it.

Intake edge case 8 ("must join the SEQUENTIAL list") is satisfied; the *write* consequence of doing so
is what nothing in the intake or plan anticipated. Fix is either a one-line correction of the header
comment plus an explicit note that this one check writes, or (preferred) moving the trip write behind
its own try/catch the way `checkBacklogDepth` is isolated — the latter changes behaviour, so it is a
call for the owner, not a mid-review edit.

### 2 — the actor-fixing half of a promised test is not asserted

`src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts:79-89` renders as:

```ts
const response = await POST(makeRequest({ note: 'ramp rolled back', actorUserId: OTHER_USER_ID }));
expect(response.status).toBe(400);
expect(resetSendBreakerMock).not.toHaveBeenCalled();
```

That proves `strictObject` rejects a body-supplied actor (the "ignores" half). It does **not** prove
the actor the route passes is `gate.admin.id`. No case in the file asserts
`resetSendBreakerMock` call arguments — the 409 case and the note case both only read the status. An
implementation that passed `''`, a hard-coded uuid, or `parsed.data`'s absent field would pass all four
tests while violating intake invariant 4 and CLAUDE.md invariant #8.

Route code is correct (`reset/route.ts:47`: `actorUserId: gate.admin.id`). The gap is purely in the
promised test. One line closes it:

```ts
expect(resetSendBreakerMock).toHaveBeenCalledWith(expect.anything(), { actorUserId: ADMIN_ID, note: 'nothing to clear' });
```

### 3 — an unrecognised bounce type is silently excluded from the breaker's numerator

`bounce_kind` is derived from the pre-existing classifier (`solicitation-lane.ts:272`,
`:288`), whose documented default is (`bounce-classifier.ts:43`):

> `'unknown' is treated as soft to avoid flagging businesses on ambiguity.`

`extractBounceType` returns `'unknown'` whenever `data.bounce.type`, `data.reason` and `data.status`
are all absent or non-string. That default was chosen when the only consequence was whether a business
got flagged — a fail-safe. It is now the **discriminator for a platform safety governor**, where the
same default is fail-OPEN: a Resend payload-shape change, or any permanent-failure type Resend
introduces that does not contain the substring `permanent`, stamps `bounce_kind='soft'`, is excluded
from `readBreakerWindow`'s `bounce_kind = 'hard'` filter, and the breaker never trips however bad
deliverability gets.

Migration 110's CHECK admits exactly `hard | soft` — there is no third `unknown` kind that
`classifyBreach` could be made to count conservatively — and the promised lane test
(`resend-solicitation-lane.integration.test.ts:525`) exercises only `'Permanent'` and `'Transient'`,
never an unrecognised or missing type.

This is not a defect the diff *introduced* (the classifier predates it), but the diff is what makes the
default load-bearing for a fail-closed governor, and the intake's edge-case list stops one step short:
it names soft bounces, not unknown ones. Worth an explicit owner decision — either accept and document
it in `CONTEXT.md` → **Breaker window**, or add an `unknown` kind counted with `hard`.

### 4 — the UTC-day test cannot fail if the trailing conversion is removed again

Production (`src/lib/solicitation/send-caps.ts:74`, `:90`):

```sql
AND queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
```

Fixture (`src/lib/solicitation/__tests__/send-caps.integration.test.ts:103`):

```ts
case 'utc_day_start': return tx`date_trunc('day', NOW() AT TIME ZONE 'UTC')`;
```

Under a non-UTC session both the fixture's inserted boundary row and the (buggy) short-form predicate
shift by the same session offset, so the boundary row is counted either way. Worked example, session
`America/New_York`, `NOW() = 2026-08-19T03:00Z`: fixture row lands at `2026-08-19T05:00Z`; correct
predicate boundary is `2026-08-19T00:00Z` (counted); buggy predicate boundary is `2026-08-19T05:00Z`
(also counted). The promised test's "in the UTC day" clause is therefore unfalsifiable by the very
regression the T4 follow-up (deviations, "UTC-day boundary was a latent local-day bug") existed to
prevent — and the deviations entry says as much ("the suite does not discriminate between them"), but
the fix restored the code without closing the test hole.

Cheapest close: seed one row with a literal instant known to be inside the UTC day but outside the
session-local day (e.g. `TIMESTAMPTZ '…T02:00:00Z'` with the suite pinning `SET TIME ZONE
'America/New_York'` for that one case), asserting it is counted.

### 5 — two promised observability signals are missing

`.feature/intake.json` → `observability`:

> "Structured worker log line on trip from `evaluateSendBreaker`: msg `'solicitation send breaker
> tripped'` with the metric snapshot only"
> "Structured log line on admin reset naming the actor user id and the trip row id, plus the durable
> `solicitation_send_breaker` row"

Neither exists. `src/lib/solicitation/send-breaker.ts` imports no logger at all; the reset route
(`reset/route.ts`) logs only on the error path via `internalError`. The precedent the intake and plan
both cite for the reset discipline — `src/app/api/admin/solicitation/batch/halt/route.ts:49,136`
(`logger.log('admin_batch_halted', …)`) — does log. The durable row half of the third bullet ships
correctly; the log-line half does not.

Consequence is modest but real: a trip is visible only as a Sentry message (finding 11 in the
appendix compounds this), and a reset has no correlated worker/route log line at all.

### 6 — migration 110 ships more than the intake's "additive only" invariant enumerates, and the rollback misses one

Intake invariant 12: *"Migration 110 is additive only: one nullable column, two new CHECK members, one
new table."* Actually shipped (`supabase/migrations/110_solicitation_send_governors.sql`):

| Object | Line | In intake invariant? | In rollback plan? |
|---|---|---|---|
| withheld arm +2 members | `:36-46` | yes | yes |
| `bounce_kind` column | `:64` | yes | yes |
| `solicitation_outreach_bounce_kind_check` | `:72` | no | implicitly (dropped with the column) |
| `solicitation_outreach_bounce_kind_pairing` | `:80` | no | implicitly (dropped with the column) |
| `idx_solicitation_outreach_sent_at` | `:92` | **no** | **no** |
| `solicitation_send_breaker` + one-open index | `:105`, `:141` | yes | yes |

The index is on the pre-existing `solicitation_outreach.sent_at`, so nothing drops it when the column
and table go. Both rollback texts — `.feature/intake.json` `rollback_plan` and
`.claude/reference/migrations-log.md`'s 110 entry ("Rollback: `DROP TABLE …`, `ALTER TABLE … DROP
COLUMN bounce_kind`, and re-apply 109's constraint text verbatim") — leave it behind. Harmless in
effect; wrong as a written procedure, and `migrations-log.md` is the authoritative copy.

Separately: `CREATE INDEX` (not `CONCURRENTLY`) inside the migration's single transaction takes a
`SHARE` lock on `solicitation_outreach` for its duration. Safe today by the migration's own proof (no
row anywhere carries `sent_at`), but it is the one statement in 110 whose cost is not O(1) forever, and
it is not called out as a lock consideration anywhere.

### 7 — the live Breaker window is unobservable while the breaker is clear

Every surface reads only the latch:

- `readSendBreaker` (`send-breaker.ts:130`) selects from `solicitation_send_breaker` only and returns
  `{ open: false, trip: null }` when nothing is open.
- `GET /api/admin/solicitation/breaker` (`route.ts:25`) returns exactly that.
- `SendBreakerClient` renders `EmptyState "Breaker not tripped"` when `trip === null` — no figures.
- `evaluateSendBreaker` computes the window but returns only a `HealthFinding | null`; the window is
  never persisted except frozen into a trip row's `metrics`.

So:

- `user_visible_behavior[0]` — "showing the send circuit breaker state: open or tripped, **the
  tripping metric snapshot, and the 7-day window figures**" — is satisfied only while a trip is open,
  and then the snapshot *is* the window figures (frozen), not a second live view. The runbook is
  honest about this (§8.3 step 1: "frozen at the instant of the trip"); the intake reads as two things.
- `observability[4]` — *"How I would know it broke: … a breaker that never evaluates shows up as an
  absent finding against a non-zero send denominator visible in the same read model"* — has no
  surface. An operator cannot see the denominator anywhere without a DB session, so "absent finding
  against a non-zero denominator" is not a check anyone can actually run.

Cheap fix if the owner wants the stated detection story to work: have `evaluateSendBreaker` (or a
sibling read) return the window and have the GET route include it, so `/admin/solicitation` renders
the live figures on the untripped path too.

### 8 — the checked-in plan and intake still carry the pre-fix UTC-day spelling

`docs/superpowers/plans/2026-08-19-solicitation-send-governors.md:1231` and `:1248` present the module
source with the short form. `.feature/intake.json` `edge_cases[11]` reads:

> "The UTC day boundary for the cap count uses `date_trunc('day', NOW() AT TIME ZONE 'UTC')`, mirroring
> `worker/jobs/response-generation/auto-approval.ts`"

— which is both the buggy spelling and a misstatement of the precedent it names
(`auto-approval.ts:231` has the trailing conversion). The deviations file records the fix and marks the
earlier entry SUPERSEDED, but the plan body is the artifact a resumed session reads as the source of
truth ("Every downstream brief was told to trust the tests over the plan" — which does not help here,
because the tests do not discriminate either; see finding 4). Both should be corrected in the same
change, or the plan should carry an inline "SUPERSEDED — see deviations" marker at those two lines.

---

## What checks out

Recorded so a later round does not re-litigate settled ground.

**The four asymmetries the brief singled out.**

1. **Asymmetric window.** `readBreakerWindow` (`send-breaker.ts:214-232`) is one statement with three
   `FILTER`ed counters: denominator on `sent_at >= NOW() - 7 days`, numerators on
   `bounced_at` / `complained_at` in the same window. The test at
   `send-breaker.integration.test.ts:288` **does** discriminate it from the cohort version: 100
   in-window sends with zero in-window bounces, plus 3 sends aged 9 days whose bounces landed today →
   asserts `sends: 100, hard_bounces: 3` and a trip. A symmetric/cohort implementation yields 0/100 and
   no trip, so that test fails. Correct and load-bearing.
2. **UTC-day boundary.** Both counters (`send-caps.ts:74`, `:90`) carry the trailing
   `AT TIME ZONE 'UTC'`. A `git diff main...HEAD | grep date_trunc` sweep confirms the only remaining
   short-form occurrences are the test fixture (finding 4) and the plan/intake prose (finding 8) — no
   production site dropped it.
3. **Fail-closed read.** `readSendBreaker` (`send-breaker.ts:130-153`) has no try/catch, no `unknown`
   verdict, and a return type of `SendBreakerState` with no third state. Callers audited:
   `page.tsx:19` (propagates to the Next error boundary), `GET route:25` (maps to 500 — a read
   surface, not a send path, and deliberately documented as such), `SendBreakerClient` (browser).
   **No send-path caller exists and none swallows it.**
4. **`ON CONFLICT` inference.** `INSERT … ON CONFLICT ((reset_at IS NULL)) WHERE reset_at IS NULL DO
   NOTHING` (`send-breaker.ts:96`) matches `solicitation_send_breaker_one_open`
   (`110_…sql:141-143`) byte-for-byte. Proven empirically before the module was written (deviations,
   "T5 — `ON CONFLICT ((reset_at IS NULL))` inference") and re-proven every run by
   `send-breaker.integration.test.ts:321` (two evaluations → one row, one finding).

**Migration 110's untouched arms.** Programmatic diff of the two CHECK predicates: the *only*
difference is the two intended withheld members. The `rendered/queued/sending/sent`, `cancelled`,
`failed` and `unknown` arms, their member order, and the outer `IS TRUE` wrapper are 109 verbatim.

**`resolveAccountDailySendCap`.** `Math.min(configured, 10)` with `null → 10`
(`send-caps.ts:23-27`); property-tested over the schema's full `1..50` range
(`send-caps.test.ts:46`). `DEFAULT_DAILY_AUTO_POST_CAP` (`src/lib/auto-approval/policy.ts:25`) is a
separate constant that also equals 10 and is not derived from it, as the intake requires.

**Admin reset route.** `requireAdminWithAal2` first (`reset/route.ts:25`), `withSameOrigin()`
(`:65`), `z.strictObject` with a trimmed non-empty note (`:20-22`), `sql.begin` (`:46`), actor from
`gate.admin.id` (`:47`), `{reset:false}` → 409 `not_tripped` (`:51-56`). Mirrors the unsuspend
precedent exactly. (Assertion gap: finding 2.)

**Nothing sends.** Grepped the whole diff: no `getMessagingAdapter`, no `EmailAdapter`, no
`solicitation_outreach` write that touches `delivery_status`/`sent_at`/`sending_at`, no releaser, no
poller registration beyond the health check, and no flag default changed. `resolvePlatformDailyCap`
and both dispatch counters have **zero production callers** — confirmed by grep and by
`docs/directory.md`'s new rows, which say so explicitly. `SOLICITATION_SEND_ENABLED` is untouched.

**Edit surface.** All 34 changed paths map to an `allowed_edit_surface` entry, including the two
owner-signed amendments (`src/lib/shared/__tests__/helpers/schema-ready.ts`,
`src/components/admin/nav-config.ts`). `docs/currents.md` and `docs/progresstracking.md` are in surface
and untouched — expected, they belong to the step-8 post-merge sweep.

**Invariant checks.**

| Intake invariant | Verdict |
|---|---|
| #15 explicit `sql`/`tx` params, no `@/lib/db/server` import in the two modules | HOLDS (`send-breaker.ts:18`, `send-caps.ts:1` import types only) |
| #13 no `NEXT_PUBLIC_SOLICITATION_PLATFORM_DAILY_CAP` | HOLDS (grep: only `src/lib/config/server.ts:221`, `worker/config/startup-assert.ts:482`) |
| #1 read model + trip write on Railway | HOLDS — only `checks.ts` calls `evaluateSendBreaker`; Next calls `readSendBreaker` only |
| #8 AAL2 + session-fixed actor | HOLDS in code (test gap, finding 2) |
| fail-closed read | HOLDS |
| never self-clears | HOLDS — `resetSendBreaker` is the only writer of `reset_at` |
| at most one open trip, in the DB not app code | HOLDS (`110_…sql:141`, tested `migration-110-…:326`) |
| gate order breaker → ceiling → cap → child | N/A this ticket (see appendix A6) |
| cap dial toward restraint only | HOLDS |
| ceiling fails closed | HOLDS |
| counting basis `queued_at` | HOLDS |
| `solicitation_send_breaker` deny-all RLS, not a `TENANT_TABLES` member | HOLDS (`110_…sql:150`; `scripts/ci/tenant-tables.ts` untouched) |
| 110 additive only | HOLDS in effect; enumeration incomplete (finding 6) |
| two `DEFAULT_*` constants separately owned | HOLDS |

**Promised tests: 37/37 present.** Each title exists verbatim as an `it(…)`. Assertion quality is
faithful in 34 of 37; the three with a gap are findings 2 and 4, plus appendix A5.

**Edge cases: 12/12 addressed.** EC3 (ratio > 1.0) and EC5 (reset while still breached) are handled
structurally but have no dedicated test — see appendix A7/A8; neither is a defect.

**Registry / audit side effects, all verified green.**

- `src/lib/account-offboarding/__tests__/table-disposition.test.ts` — its migration scanner keys on
  `account_id|business_id|user_id|…|created_by` in the CREATE TABLE body or a `REFERENCES
  accounts|businesses`. `solicitation_send_breaker`'s body has `reset_by UUID REFERENCES users(id)`
  and `created_at` — neither matches, so no `TABLE_DISPOSITIONS` entry is required. The deviations
  file's T2-step-5 conclusion is correct.
- `src/components/admin/__tests__/AdminSidebar.test.tsx` — nav row added, 8/8.
- `src/__tests__/eslint-boundaries.test.ts` — passes; `send-breaker.ts` imports `postgres` and
  `HealthFinding` type-only, so no banned runtime import reaches `src/app/**`.
- `scripts/ci/tenant-scope-allowlist.ts` — two new entries + `allowedFiles` on
  `platform-cross-account`, baseline 381 → 383, and the lane's `sqlSnippet` updated for `bounce_kind`.
  Counts are internally consistent.
- `docs/directory.md` — rows for both new files plus folder prose.

---

## Appendix — low-confidence observations (not findings)

**A1. The `src/lib → worker/` type-only import inverts the layering.**
`send-breaker.ts:22` imports `HealthFinding` from
`worker/background/pollers/health-alert/checks`. It is erased at runtime, ESLint permits it, and
`checks.ts` already imports the other way — so it is a *type-graph* cycle only. The deviations entry
"T5 — `HealthFinding` has exactly one owner" already refers this to the standards agent with the right
fix (move the type to `src/lib/shared/`). Nothing to add.

**A2. A trip pages exactly once, ever.**
`evaluateSendBreaker` returns a finding only on the tick that inserts. If `emitHealthFindings`
(`emit.ts:10`, `Sentry.captureMessage`) drops the message, or the worker dies between the INSERT and
the emit, the trip stays open with no page ever re-raised. Post-#900 that means sending is halted
platform-wide and the only remaining signal is someone opening `/admin/solicitation`. This is locked
decision 6 and the "pages ONCE, not every five minutes" property is deliberate — but the failure mode
is real and compounds finding 5 (no worker log line) and finding 7 (no live window view).

**A3. `reset_by` makes a `users` row undeletable.**
`110_…sql:112` — `reset_by UUID REFERENCES users(id)` with default `NO ACTION`, and the
`reset_consistency` CHECK forbids NULLing it. Deleting a user who has reset a breaker raises `23503`.
Only reachable for RepWorth admin users (tenant purge never touches them), so the practical risk is
near zero — but it is an undocumented new constraint on `users` deletion.

**A4. `SendBreakerClient` pulls a server domain module into the client graph.**
`SendBreakerClient.tsx:10-16` (a `'use client'` file) imports four constants from
`@/lib/solicitation/send-breaker`, whose module body also contains `import { v7 as uuidv7 } from
'uuid'` and the three server functions with their SQL. Not an invariant #1 violation (`postgres` is
type-only) and probably tree-shaken, but a constants module (or `src/lib/shared/`) would be the
cleaner seam.

**A5. The RLS test asserts a proxy, not the role.**
`migration-110-…:357` — "has row level security enabled and **denies the anon role**" asserts
`relrowsecurity = true` and zero rows in `pg_policies`. That does imply denial for any non-owner,
non-`BYPASSRLS` role, and it matches the 096 precedent, so it is a fair proxy; it just does not
`SET ROLE anon` and probe.

**A6. The gate order is an intake invariant with no code or test on this branch.**
"Gate order is fixed: breaker then platform ceiling then account cap then per-child" is stated as an
invariant but is explicitly #900's scope per `non_goals`. It is documented in `docs/directory.md` and
`CONTEXT.md` → **Send breaker**, which is the right place for it. Flagged only so a later reviewer does
not read its absence as a miss.

**A7. Ratio > 1.0 is handled but untested.** Nothing special-cases it (it is just a division), and the
`MIN_SENDS` floor makes it unreachable below 100 sends, so the untested case is behaviourally identical
to any other breach.

**A8. "Reset while still breached, next tick re-trips" is proven at the DB level only.**
`migration-110-…:335` proves a second trip inserts after a reset via raw inserts;
no test drives `evaluateSendBreaker` → `resetSendBreaker` → `evaluateSendBreaker`. The one-open partial
index makes the behaviour structural, so this is coverage, not risk.

**A9. The intake's invariant 3 wording is narrower than what shipped.**
"the Next.js admin route **only** orchestrates the reset" — a second, read-only GET route was added
(deviations: "T7 — a GET endpoint was needed for 'refetch on success'"). It is
`requireAdminWithAal2`-gated, reads only `readSendBreaker`, and is required by the intake's own
`user_visible_behavior`. Recorded, not counted as drift.

**A10. `formatRate` is spelled twice** — `send-breaker.ts:242` and `SendBreakerClient.tsx:39`,
identical bodies. Server/client split makes sharing awkward; a divergence would only affect display.
