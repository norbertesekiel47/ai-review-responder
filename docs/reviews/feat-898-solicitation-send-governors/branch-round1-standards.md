# feat-898-solicitation-send-governors — Round 1 Standards & Maintainability Review

**Agent:** Standards & maintainability (step 7)
**Method:** `thermo-nuclear-code-quality-review` skill, plus `codebase-design`
deep-module discipline, a Fowler code-smell baseline, RepWorth `.claude/CLAUDE.md`
standards, and a glossary check against `CONTEXT.md`.
**Diff reviewed:** `git diff main...HEAD` — 34 files, +5,303 / −7.
**Date:** 2026-08-19
**Gate state at review time:** `.feature/gate-status.json` — 30/30 PASS
(`lint`, `typecheck`, `test`, all 21 `ci:*` audits, `build`, 4 live-DB suites,
`promised-tests`, `merge-coverage`, `diff-coverage`).

---

## Verdict

**APPROVE WITH FINDINGS.** No blocker under the skill's approval bar. There is no
file-size explosion, no spaghetti growth in an existing flow, no cast-heavy or
magical contract, no canonical-helper duplication of consequence, and no
architecture-invariant violation. The two new domain modules are correctly
placed, correctly injected (invariant #15), and correctly documented.

Nine findings below. One is Medium and structural (the referred `HealthFinding`
question); one is Medium and operational (trip/page atomicity); the rest are Low.
None of them justifies re-cutting this branch — the two Mediums are the right
shape for a #900 follow-up, and #900 is the module's first real consumer.

The documentation discipline on this branch is, frankly, the best I have reviewed
in this repo. The 29-entry deviations log, the migration header, the
`docs/directory.md` preamble and the three `CONTEXT.md` coinages are exemplary
and should not be diluted by anything below.

---

## Findings table

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | Medium | `worker/background/pollers/health-alert/checks.ts:337` · `src/lib/solicitation/send-breaker.ts:22,92,261` | **REFERRED FINDING — upheld.** `evaluateSendBreaker` returns the worker's `HealthFinding`, so `checkSolicitationSendBreaker` is a pure pass-through (`return evaluateSendBreaker(sql)`) with a 12-line doc comment and nothing to do — the identity-wrapper smell the skill names explicitly. The inverted import is the symptom; the seam being one layer too deep is the cause. **Follow-up ticket for #900, not a fix now.** |
| 2 | Medium | `src/lib/solicitation/send-breaker.ts:102-109` · `worker/background/pollers/health-alert/emit.ts:10-18` | The trip is a durable `INSERT`; the page is one fire-and-forget `Sentry.captureMessage`. `ON CONFLICT … DO NOTHING` makes every later tick return `null`, so the alert is **edge-triggered and fires exactly once**. One dropped Sentry event (quota, transport blip, worker restart before flush) ⇒ solicitation sending halted platform-wide with **no notification and no re-page, indefinitely**. Every sibling check in `runHealthChecks` is level-triggered. |
| 3 | Low | `src/app/admin/solicitation/page.tsx:15` | The page calls `readSendBreaker(sql)` with **no try/catch**, while its sibling GET route catches at `route.ts:32-37`. A failing breaker read is precisely the fail-closed halt scenario; the admin opens `/admin/solicitation` to investigate and gets Next's error boundary instead of the reset control. |
| 4 | Low | `src/app/admin/solicitation/SendBreakerClient.tsx:224-228,187-197` | `initialData` is optional but the only production caller (`page.tsx:30`) always supplies it, so three of the five `QueryResult` branches (`TableSkeleton`, full `ErrorState`, `return null`) are **unreachable in production**; one of the seven tests (`SendBreakerClient.test.tsx:197-215`) exists only to cover that mode. Skill rule 5 — unnecessary optionality. Fixing #3 makes these branches live and correct. |
| 5 | Low | `src/lib/solicitation/send-breaker.ts:251-253` · `src/app/admin/solicitation/SendBreakerClient.tsx:38` | `formatRate` is duplicated byte-for-byte across the alert title and the admin panel — the **same rates, same audience** (the Sentry page links an operator to this page). Fowler: Duplicated Code. Canonical home already exists: `src/components/admin/ui/format.ts`, self-described as "the admin console's single date/number formatter", which has `formatAdminCount` and no rate helper. |
| 6 | Low | `src/lib/auto-approval/policy.ts:24-25` | The deliberate-coincidence guard is **one-sided**. `send-caps.ts:12-15` says "never derive one from the other"; `DEFAULT_DAILY_AUTO_POST_CAP` carries a bare one-line comment with no reciprocal pointer. A future ticket tuning the auto-post cap has no signal that a solicitation constant deliberately mirrors it. *(Verified: neither file imports the other — the no-derivation half holds.)* |
| 7 | Low | `src/lib/solicitation/send-caps.ts:23` vs `src/lib/auto-approval/policy.ts:31` | `resolveAccountDailySendCap` and `resolveDailyCap` — near-identical names, same input shape, **different semantics**: `Math.min(configured, 10)` vs `configured ?? 10`. A consolidation refactor that unifies them silently un-caps the send dial to the schema's admitted 50. |
| 8 | Low | `supabase/migrations/110_solicitation_send_governors.sql:44-63` | `no_postal_address` / `postal_address_mismatch` are added to the `withheld` arm with **no writer anywhere in the repo** — the Dispatch gate that writes them is #630's. Drop item (a) and 110 need not touch `solicitation_outreach_status_reason_consistency` at all. Fowler: Speculative Generality; a safety CHECK widened ahead of its consumer. |
| 9 | Low | `docs/directory.md:~915` · `supabase/migrations/110_...sql:63` | **Glossary gap.** Both bold **Dispatch gate** in the repo's LOCKED-term style, but `CONTEXT.md` has no entry for it — the only mention is inside **Send handoff**'s `_Avoid_` list ("dispatch gate (that last is #630's, a different thing)"), which tells a reader the term is *reserved*, not what it means. |

---

## 1. The referred finding — ruling in full

> `src/lib/solicitation/send-breaker.ts:22` imports `HealthFinding` **type-only**
> from `worker/background/pollers/health-alert/checks.ts`.

### Verdict

**A real defect. Follow-up ticket for #900 — not a fix on this branch.**
Severity: **Medium**. Recorded as finding #1.

### Verifying the direction claim myself

Confirmed, and it is stronger than stated.

```
rg "\.\./worker/" src/ →  40 hits.
  39 are under __tests__/ (mock-sql helpers, purge-stages, failed-hook, …).
  1  is production code: src/lib/solicitation/send-breaker.ts:22.
```

There is no `@/worker` path alias in `tsconfig.json`. So this is the **only**
production edge from `src/` into `worker/` in the repository. Every other edge
runs worker → lib, which is what `checks.ts` itself does three times
(`src/lib/shared/backlog-depth`, `src/lib/shared/logger`, `src/lib/agents/read`).

### "The gate is green" is weaker evidence than it looks

The ESLint rule that lets this through is:

```js
const PARENT_TRAVERSAL_BAN = {
  regex: '^\\.\\./\\.\\.(?!.*/(worker|scripts)/)',
  …
};
```

That exemption exists so **worker files** can traverse into `src/` — it is a
*path-shape* exemption and cannot express *direction*, so it permits the reverse
edge by accident rather than by sanction. Likewise invariant #1 permits
`import type` because the invariant is about *runtime* weight on Vercel, not about
layering. Both gates are green because neither is looking at this question. The
deviations entry is right that no invariant is violated; it is not evidence that
the shape is correct.

### Why it is a real defect and not a non-issue

The proof is already on the branch, and it is not the import line:

```ts
export async function checkSolicitationSendBreaker(sql: postgres.Sql): Promise<HealthFinding | null> {
  return evaluateSendBreaker(sql);
}
```

A 1-line pass-through under a 12-line doc comment. The comment is carrying all
the meaning because the function has none. That is the skill's named smell —
"thin abstractions, identity wrappers, or pass-through helpers that add
indirection without buying clarity" — and its cause is that the **domain module
already did the worker's job**. A worker check with nothing left to do is the
signature of a seam placed one layer too deep.

Two more consequences follow from the same root:

- `breakerFinding()` (`send-breaker.ts:261-283`) hardcodes `key:
  'solicitation_send_breaker_tripped'` and `level: 'error'` — alert-sink
  vocabulary — inside `src/lib/`. The alert key's owner is now a domain module.
- `formatRate` (finding #5) exists in `send-breaker.ts` **only** to build that
  finding title, and is then re-typed in the client. Move the finding-shaping to
  the worker and one of the two copies disappears with it.

So the honest framing is: this is not "a type import in the wrong direction", it
is "the domain module returns a presentation DTO", with the import direction and
the degenerate wrapper as its two visible symptoms.

### Why not fix it now

1. It changes the test contract of a module whose **only real consumer does not
   exist yet**. #900 owns the release decision and will want a verdict type
   anyway. Cutting the verdict shape blind to the consumer risks cutting it twice.
2. This branch is at 30/30 green with 29 triaged deviations and an **exhausted**
   surface-amendment budget (2 of 2, second waived by the owner). A return-type
   change touches `send-breaker.ts`, `checks.ts`, `checks.test.ts`,
   `send-breaker-check.test.ts` and both live-DB suites. That is not a
   fix-in-flight; it is a re-plan.
3. There is **zero runtime risk today**. `import type` is erased; the type-graph
   cycle is inert; nothing on this branch ships the edge to a bundle.

### The ticket, concretely

Filed against #900, which consumes `readSendBreaker` and will want this shape:

- `evaluateSendBreaker` returns a domain verdict —
  `SendBreakerTrip | null` is already the right shape and is already exported.
- `checkSolicitationSendBreaker` maps that verdict to a `HealthFinding` and
  thereby earns its existence; `breakerFinding` and `formatRate` move to
  `worker/background/pollers/health-alert/`.
- The import edge reverses to the normal direction, with **no type duplication**
  — which was the deviations entry's correct objection to the naive fix.
- The alternative the deviations log names (moving `HealthFinding` into
  `src/lib/shared/`) is worse: it makes the alert vocabulary a shared concept in
  order to preserve a seam that should not exist.

**Contingency if the ticket slips:** do not let a *second* production file take
this edge. One documented exception is a note; two is a new layering rule nobody
decided on.

---

## 2. Deep-module analysis (the deletion test)

### `src/lib/solicitation/send-breaker.ts` — **DEEP**

283 lines, ~55% of it comment. Interface: 3 functions, 4 constants, 3 types, 1
const-tuple.

**Deletion test.** Delete the file and the poller, both routes, the page and the
client all break, and each caller must re-acquire:

- the asymmetric send-dated/signal-dated window (a locked, counter-intuitive
  decision with a written rationale);
- the `ON CONFLICT ((reset_at IS NULL)) WHERE reset_at IS NULL` byte-for-byte
  contract, which fails at runtime on the *second* breach if mis-spelled;
- the fail-closed read contract (no try/catch, no `unknown` verdict);
- the PgBouncer JSONB string guard;
- the breach precedence (hard bounce before complaint).

That is a large amount of genuinely hard, hard-won knowledge behind a small
interface. **Deep, and the trap list in `docs/directory.md` is the right
companion.**

**One caveat, already covered by finding #1:** the `HealthFinding` return widens
the interface into another layer's vocabulary. Remove that and the module is
cleanly deep rather than deep-with-an-appendage.

### `src/lib/solicitation/send-caps.ts` — **SHALLOW BUT JUSTIFIED**

94 lines, ~65% comment. 5 exports, no state, no abstraction.

**Deletion test, per export:**

| Export | If deleted, the caller must re-derive | Verdict |
|---|---|---|
| `resolvePlatformDailyCap` | the whole fail-closed parse ladder — `undefined`/blank/non-digit/unsafe-int all ⇒ 0, and `'0'` deliberately indistinguishable from unset | **Earns its keep** |
| `countAccountDispatchAttemptsToday` | the `queued_at` (not `sent_at`) basis **and** the trailing `AT TIME ZONE 'UTC'` — a latent local-day bug that no test could catch (deviations "T4 follow-up") | **Earns its keep** |
| `countPlatformDispatchAttemptsToday` | same trap, plus the tenant-scope allowlist entry | **Earns its keep** |
| `DEFAULT_DAILY_SEND_CAP_ACCOUNT` | the "10, not 25, because it must bind a single batch" reasoning | **Earns its keep** |
| `resolveAccountDailySendCap` | `Math.min(policy.dailySendCap ?? 10, 10)` | **Weakest** — a near-identity over `Math.min`; its value is the *name* and the restraint-only rule, not the arithmetic |

The module is thin, but each export is a **trap-holder**, and in this codebase a
trap-holder with a written WHY is the correct unit. The UTC-boundary export alone
justifies the file: that bug shipped in the plan, survived the fixture, and was
caught only because the expression had one owner to point at.

**Verdict: keep it. Not under-abstracted.**

### Should there be a shared `Governor` abstraction? — **No. The call was right.**

Three independent reasons:

1. `.claude/CLAUDE.md` working rules: *"no abstractions for a single caller."* The
   caller count here is **zero** — #900 is unbuilt. An interface designed against
   an imagined consumer is the textbook Fowler Speculative Generality.
2. The two modules have **genuinely different failure contracts**: the breaker
   fails closed *by throwing* (the throw IS the halt signal); the caps fail closed
   *by resolving to 0*. A shared `Governor` interface would have to erase that
   difference or carry both — either way it makes the design worse, and
   `docs/directory.md`'s preamble already says exactly this ("Collapsing them
   would give one module two failure contracts").
3. The costs are asymmetric — one 7-day full-table aggregate versus a
   single-integer count. A uniform `Governor.check()` invites a caller to run
   them uniformly, which is precisely the thing the split exists to prevent.

The right time to extract the abstraction is when #900 writes the release
decision and can see all four governors in one function. **Concrete beats
speculative here, and the branch chose correctly.**

---

## 3. `SendBreakerClient.tsx` — is it doing too much?

**No.** 278 lines, decomposed into five focused units:

| Unit | Lines | Job |
|---|---|---|
| `MetricsSnapshot` | 73-95 | three `StatTile`s, pure presentation |
| `ResetForm` | 97-141 | owns only the note field's local state |
| `TripPanel` | 143-167 | composes the two above |
| `QueryResult` | 169-222 | the load/error/empty/data ladder |
| `SendBreakerClient` | 224-277 | query + mutation + outcome banners |

That is good decomposition, not a god component. It imports the admin
primitives rather than re-implementing them (`StatTile`, `EmptyState`,
`ErrorState`, `TableSkeleton`, `formatAdminDateTime`, `formatAdminCount`,
`LiveRegion`), and it correctly followed the design docs over the task brief on
Island-vs-Console (deviations "T7 (orchestrator)").

Two real nits, both in the table: the duplicated `formatRate` (#5) and the
optional-`initialData` dead branches (#4). Neither is a size problem.

One structural note not worth a table row: `QueryResult` takes six props and
relays `pending` / `onReset` straight through to `TripPanel` — prop-drilling one
level. Acceptable at this size; if a second control lands on this page, hoist the
mutation state into a small hook rather than widening the relay.

---

## 4. Net-negative bias — is any of this unjustified?

The branch adds ~1,100 production lines and deletes 7. That asymmetry is
*mostly* justified: this is a greenfield subsystem (a new table, a new admin
surface, two new domain modules), and greenfield work has nothing to delete.

Held up to scrutiny, three items and their rulings:

- **Migration 110 item (a)** — vocabulary with no writer. Finding #8, Low. This
  is the one genuinely speculative piece: `no_postal_address` and
  `postal_address_mismatch` are unwritable by any code in the repo, and without
  them 110 would not need to touch that CHECK at all. Defensible (batching a
  constraint replacement is cheap, and the header explains the *shape*), but the
  header never explains why it ships **now** rather than with #630. Widening a
  safety CHECK ahead of its consumer opens a window in which a bug could write
  those values undetected.
- **The GET route** (`breaker/route.ts`) — justified. The deviations log
  documents both options and rejects `router.refresh()` for a stated reason
  (it drops the non-blanking stale-data behaviour). Correct call.
- **`checkSolicitationSendBreaker`** — currently *not* justified as a separate
  function; see finding #1. It becomes justified the moment it does the mapping.

Everything else on the branch is load-bearing.

---

## 5. Comment quality

RepWorth comments carry the WHY, and this branch is above the repo's already-high
bar. Sampled and confirmed excellent: the send-dated/signal-dated asymmetry
(`send-breaker.ts:71-90`), the `ON CONFLICT` byte-for-byte warning (`:97-101`),
the `type`-not-`interface` JSONB rationale (`:36-45`), the trailing
`AT TIME ZONE 'UTC'` explanation (`send-caps.ts:52-64`), the whole of migration
110's header, and `strictObject` at `reset/route.ts:11-18`.

**Comments that restate the code** — two, both minor, neither in the table:

- `SendBreakerClient.tsx:210-211` — "No open trip means there is nothing to reset,
  so no reset control is rendered" restates the ternary two lines below. The
  second clause ("the control exists only where it has an effect") is the WHY and
  would stand alone.
- `send-breaker.ts:108` — `if (!inserted) return null; // a trip was already open
  — do not re-page`. Borderline; "do not re-page" is the WHY and earns it. Keep.

**Missing WHYs on non-obvious decisions** — three:

- `page.tsx:15` — no comment explaining why the page does **not** try/catch when
  its sibling route does. This is exactly the asymmetry finding #3 flags; whether
  the fix is a catch or a comment, one is owed.
- `SendBreakerClient.tsx:226` — `initialData?` is optional with no stated reason.
  It reads as "the caller might not have it", but the only caller always does
  (finding #4).
- `SendBreakerClient.tsx:235-236` — `refetchInterval: 30_000` against a source
  that changes at most once per 5-minute poll cycle. Ten polls per source event
  is a deliberate-looking choice with no note.

**The inverse smell** — `checks.ts:324-336`: a 12-line doc comment above a 1-line
pass-through. The comment is excellent and the *content* should survive; it just
belongs above a function that does something (finding #1).

---

## 6. Glossary compliance — PASS, with one gap

Checked all nine feature terms against `CONTEXT.md`:

| Term | `CONTEXT.md` entry | Code honours it |
|---|---|---|
| Send breaker | ✅ coined #898 | ✅ |
| Send breaker trip | ✅ coined #898 | ✅ |
| Breaker window | ✅ coined #898 | ✅ |
| Outreach row | ✅ | ✅ |
| Solicitation lane | ✅ (amended for `bounce_kind`) | ✅ |
| Sending identity | ✅ | ✅ |
| Halt latch | ✅ | ✅ — kept explicitly distinct |
| Dispatch gate | ❌ **no entry** | — finding #9 |
| Send handoff | ✅ | ✅ |

**The carve-out rule is honoured.** `SendBreakerClient.tsx:40-48` states it in a
comment and the surface obeys it: 35 occurrences of breaker / Tripped / Reset,
and a targeted grep across `src/app/admin/solicitation/**`,
`src/app/api/admin/solicitation/**`, `send-breaker.ts` and `send-caps.ts` found
**zero** instances of "kill switch", "global halt", "pause sending", "resume" or
"paused". The two hits were the CONTEXT-sanctioned phrase "reputation circuit
breaker" and the rule-stating comment itself. Owner-facing "stop" language does
not appear anywhere on this surface.

**Watch item (not a finding):** the surface describes the effect as "halted",
which is the **Halt latch**'s verb. This is sanctioned — `CONTEXT.md`'s own
**Send breaker** entry uses "halted" twice and `_Avoid_`s only the *noun* "global
halt" — but it is the one place the two terms could collapse in a reader's head.
If #900 adds more breaker prose, prefer "tripped" over "halted" where both fit.

---

## 7. RepWorth invariant compliance

| Invariant | Status | Evidence |
|---|---|---|
| #1 Vercel = UI only | ✅ | New routes call domain functions only; `import type` for `postgres` and `HealthFinding` (both erased). No banned runtime import. |
| #2 Transactional outbox | n/a | No outbox topic added; nothing enqueues. |
| #8 Auth scope app-enforced | ✅ | `requireAdminWithAal2` on both routes; `requireAdminPage(…, aal2: true)` on the page, gate-first proved by `page-source.test.ts:66`. |
| #10 Node crypto | ✅ | `uuid`'s v7 for a time-ordered PK — correctly chosen over `randomUUID()` (UUIDv4). #10 governs hashing. |
| #12 Entry points orchestrate | ✅ | `reset/route.ts` is gate → parse → one call → map; no branch near 30 lines. |
| #13 Server-authoritative flags | ✅ | No `NEXT_PUBLIC_*` added; `ci:static-policy` green. |
| #15 Explicit DB client | ✅ | Both modules take `Sql`/`TransactionSql`; neither imports `@/lib/db/server`. `ci:db-imports` green. |
| Tenant scope | ✅ | Two cross-account reads allowlisted with real justifications; baseline 381 → 383 with dated changelog. |
| RLS | ✅ | `solicitation_send_breaker` deny-all, 096 precedent; `ci:rls-audit` green. |
| No `any` | ✅ | One `unknown` → narrowed at the sanctioned PgBouncer JSONB boundary (`send-breaker.ts:146-150`). |
| Directory map | ✅ | Both new `src/lib` files have rows plus a subsystem preamble. |

---

## 8. Things the branch got conspicuously right

Worth recording so the next feature copies them:

1. **The eval-first task order caught a bug no test could.** The trailing
   `AT TIME ZONE 'UTC'` bug survived because the fixture used the same expression
   as the implementation. It was found by a subagent comparing against the cited
   precedent and escalating rather than deviating. That is the strongest argument
   for the eval-first workflow anywhere in the deviations log.
2. **The `ON CONFLICT ((reset_at IS NULL))` inference was verified against real
   Postgres before the module was written**, then pinned by an idempotence test.
   The single riskiest line on the branch, de-risked in the right order.
3. **Subagents stopped at the edit-surface guard four times** instead of working
   around it, and one explicitly rejected a tempting fix (moving the `collect()`
   call below the backlog `try/catch`) that would have passed three tests by
   exploiting mock-queue exhaustion. That refusal is worth more than the fix.
4. **`checks.test.ts`'s positional-queue contract is now stated in the file**, so
   the next person appending a check knows they owe an entry.
5. **The at-most-one-open-trip invariant lives in a partial unique index**, not in
   application code.

---

## Appendix — low-confidence observations (NOT findings)

Below the ≥80% bar. Recorded for the author's judgement; none should be actioned
on this branch.

- **A. `resolveAccountDailySendCap` makes the schema's `1..50` range partly
  dead.** `Math.min(configured, 10)` means an admin who stores 25 or 50 gets 10
  with no signal anywhere. The comment calls this out ("this resolver is what
  makes that harmless"), and there is no settings surface yet, so nobody can
  observe it today. When #900 builds the dial, the UI should either show the
  *effective* cap or the CHECK should narrow to `1..10`.
- **B. The breaker aggregate is the heaviest read in `runHealthChecks` and sits
  in the shared-fate section.** `checkBacklogDepth` is isolated precisely because
  it "reads the DB when the DB is under pressure"; the breaker's full-table
  three-counter aggregate over the only unbounded-growth table has an arguably
  stronger claim to the same treatment. Against it: the file states shared-fate is
  the *intended* contract for core checks, the placement was specified, and the
  denominator has an index. Genuinely a judgement call — flagging so it is a
  decision rather than an accident.
- **C. `evaluateSendBreaker` is the only WRITE in a module called `checks.ts`.**
  Every sibling is a pure read. The naming now under-describes what
  `runHealthChecks` does. Cosmetic today; it is also the boundary that produces
  finding #2, so a rename would follow that fix rather than lead it.
- **D. `readSendBreaker`'s `SELECT` has no `LIMIT 1`.** Correctness rests
  entirely on `solicitation_send_breaker_one_open`. That is a legitimate design
  choice (the DB owns the invariant), and `const [row] =` is safe regardless — but
  a reader has to know the index exists to know the query is bounded.
- **E. `refetchInterval: 30_000` polls ten times per source event** (the poller
  runs every 5 minutes). Harmless for one admin on one page; noted only because
  the number has no comment.
- **F. `QueryResult`'s six props relay two of them straight through.** Fine at
  278 lines; revisit if a second control lands on the page.
- **G. `docs/directory.md`'s preamble is long enough to be a design note.** It is
  excellent content; if the folder grows, it may want to move to `docs/currents.md`
  with a pointer, per the CLAUDE.md shape rule's spirit.
