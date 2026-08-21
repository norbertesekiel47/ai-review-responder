# feat-898-solicitation-send-governors — Round 2, verification only (spec & correctness + standards & maintainability)

**Remit:** did each accepted round-1 fix land and do what it claims, and did any fix introduce a
new defect? No new fronts against unchanged code — anything else is in the appendix, marked
**NEW — UNTRIAGED**, and does not enter the findings table.

**Commits verified:** `eafe6760`, `cceb0677`, `d6882a0f`, `fa941fb6`, `a6e060a8`, `a54ec75f`
(plus `590d0cc1`, the gate-blocker record).

**Read:** `branch-round1-spec.md`, `branch-round1-standards.md`, `round1-triage.md`, the deviations
tail (entries `R1-B2.1` → `R1 follow-up 2`), every production and test file touched by the six fix
commits, and the four documentation artifacts they edited.

**Verification run (read-only):**
`REPWORTH_DISABLE_LIVE_DB_SUITES=1 npx vitest run src/lib/solicitation/__tests__/send-caps.test.ts
src/lib/solicitation/__tests__/send-breaker.test.ts src/app/api/admin/solicitation
src/app/admin/solicitation worker/background/pollers/health-alert/__tests__`
→ **11 files passed, 104 tests passed, 13 skipped (live-DB).**
`.feature/gate-status.json` is stamped after `a54ec75f` and reports 30/30 PASS including `build`
and `tenant-scope` — the two rows `590d0cc1` recorded as red on `d6882a0f`.

**Headline:** every accepted code fix landed and is correct. **The defects this round are all
documentation and operator-facing copy that the code fixes invalidated and nobody moved.** Two
behaviours were deliberately reversed on this branch (paging edge → level; reset now bounds the
window) and six artifacts — including the admin panel's own on-screen help text, a LOCKED
`CONTEXT.md` term, the operator runbook and the intake's own edge-case list — still describe the
pre-fix behaviour. One promised observability line was assigned to a sibling agent and silently
dropped.

---

## Part 1 — per-finding verdicts

| Round-1 finding | Verdict | One line |
|---|---|---|
| spec-1 / B1.3 — `checks.ts` "No writes" + un-isolated write | **VERIFIED FIXED** | Header names the single writer (`checks.ts:7-14`); call wrapped in try/catch degrading to `health_check_error:solicitation_send_breaker` warning (`checks.ts:466-475`); still sequential, still in position, no `Promise.all`. |
| spec-2 / B1.5 — actor assertion missing | **VERIFIED FIXED** | `reset-route.test.ts:96-102` now drives an accepted body and asserts `toHaveBeenCalledWith(expect.anything(), { actorUserId: ADMIN_ID, note: … })`; title unchanged. |
| spec-3 / B1.4 — unrecognised bounce fails open | **VERIFIED FIXED (both halves, both pinned)** | Lane: `resolveBounceKind` returns NULL for an unrecognised type (`solicitation-lane.ts:305-312`); breaker: `bounce_kind = 'hard' OR bounce_kind IS NULL` (`send-breaker.ts:324-327`). Tests `#42` (lane, `'Undetermined'` + empty payload) and `#43` (breaker, 3 unclassified / 100 sends with a fixture guard asserting `classified: 0`) each fail alone. |
| spec-4 / B1.6 — UTC fixture non-discriminating | **VERIFIED FIXED** | Fixture re-spelled session-independently (`send-caps.integration.test.ts:111-119`) and the case pins `SET LOCAL TIME ZONE 'America/New_York'` (`:264-269`). Worked through: short form's boundary lands at 04:00Z/05:00Z, fixture row at 00:00Z → dropped → count 1, assertion is 2. Discriminating at every hour of the day. |
| spec-5 / B1.7 — two promised log lines absent | **HALF FIXED — see R2-3** | Trip line present and aggregate-only (`send-breaker.ts:136-149`). **Admin-reset line still absent everywhere**, and not recorded as deferred. |
| spec-6 / B1.8 — rollback omits index + constraints | **VERIFIED FIXED** | `.feature/intake.json` `rollback_plan` and `.claude/reference/migrations-log.md` (110 entry) both name `idx_solicitation_outreach_sent_at` and both `bounce_kind` CHECKs. |
| spec-8 / B1.9 — plan/intake carry the SHORT UTC form | **VERIFIED FIXED (for the UTC form) — see R2-5** | Plan `:909`, `:928` and intake `edge_cases[11]` now carry the long form; `auto-approval.ts:231` re-checked and it does spell the trailing conversion, so the corrected precedent claim is true. |
| std-3 / B1.10 — `page.tsx` unguarded read | **VERIFIED FIXED** | `page.tsx:65-70` try/catch → `reportCaughtError('admin/solicitation/page', …)`, dropping `initialData` so the client renders its own retry — the `/admin/costs/page.tsx:32` precedent exactly. Side benefit: round-1 std-4's three "unreachable" `QueryResult` branches are now live. |
| std-9 / B1.12 — no **Dispatch gate** glossary entry | **VERIFIED FIXED** | `CONTEXT.md:85` — bolded term, boundary rule, the seven items the child runs, B14's move, `_Avoid_` list, provenance. House style throughout. |
| std-1 / B3.1 — `HealthFinding` inversion | **DEFERRED-AS-AGREED** | `send-breaker.ts:23` unchanged and still the repo's only production `src/ → worker/` edge (grep confirms 1 hit outside `__tests__`); type-only. Deferral recorded in `round1-triage.md` B3.1 and again in the deviations `R1-B1.3` entry ("remains open alongside B3.1"). |
| std-5 / B1.11 — `formatRate` duplication | **OPEN-AS-AGREED, but the WARNING COMMENT IS ONLY ON ONE SIDE — see R2-4** | The client copy carries the full why-not-import explanation (`SendBreakerClient.tsx:19-30`). The server copy's comment (`send-breaker.ts:363-374`) still asserts the reverted state. |
| B1.1 (adv-3 / std-2) — edge-triggered paging | **CODE VERIFIED FIXED; DOCS REGRESSED — see R2-2** | Probe-first + `openTripFinding` with a stable per-reason title and the same routing key (`send-breaker.ts:106-111`, `:412-424`); idempotence test re-pointed at the ROW with the title kept verbatim. |
| B1.2 (adv-4) — unbounded scan | **VERIFIED FIXED** | Real `WHERE` on the three-way OR sharing the `GREATEST(…)` bound (`send-breaker.ts:331-333`); 110's wrong index rationale recorded for a follow-up rather than edited into an immutable migration; tenant-scope `sqlSnippet` re-keyed, 383/383. |
| B2.1 (adv-1) — recovery arithmetically unreachable | **CODE VERIFIED FIXED; DOCS + UI COPY REGRESSED — see R2-1** | `GREATEST(NOW() - 7d, MAX(reset_at))` on the `WHERE` and all three `FILTER`s (`send-breaker.ts:306-333`), end-to-end test `#39` asserts both halves (reset clears → next eval null; 100 fresh sends at 3% re-trip). |
| **`a54ec75f` — thresholds as props (the riskiest late change)** | **VERIFIED** | See the dedicated section below. |
| Promised-tests contract (43) | **VERIFIED, one title overstates — see R2-7** | All 43 titles present verbatim. The six added in the fix rounds are honest except `#41`. |

---

## Part 2 — findings a fix introduced or left behind

Confidence ≥ 80%, `file:line`, concrete failure scenario or named standard.

| # | Severity | file:line | Finding |
|---|---|---|---|
| R2-1 | **High** | `docs/runbooks/solicitation-sending-domain.md:419-426`, `:397-398`, `:465-466` · `docs/directory.md:910-911` · `src/app/admin/solicitation/SendBreakerClient.tsx:163-165` · `.feature/intake.json` `edge_cases[4]` | **B2.1 reversed reset semantics in code; every operator-facing description of a reset still states the pre-fix behaviour**, including the admin panel's own on-screen help text. |
| R2-2 | Medium | `CONTEXT.md:83` · `docs/runbooks/solicitation-sending-domain.md:371-372` | **B1.1 made paging level-triggered; a LOCKED glossary term and the runbook's "What a trip looks like" section still promise it pages once per trip.** |
| R2-3 | Medium | `src/app/api/admin/solicitation/breaker/reset/route.ts:44-62` · `src/lib/solicitation/send-breaker.ts:225-239` | **The second half of spec-5 / B1.7 was not done and was not recorded as deferred.** The intake's promised admin-reset log line exists nowhere. |
| R2-4 | Medium | `src/lib/solicitation/send-breaker.ts:363-374` | **A doc comment left behind by the `a6e060a8` revert asserts three things that are all now false**, and specifically claims the duplication std-5 names is closed. |
| R2-5 | Medium | `docs/superpowers/plans/2026-08-19-solicitation-send-governors.md:1063-1105` | **The plan's module source still carries four superseded shapes** — the exact "a resumed session re-derives the bug from the plan" hazard spec-8 / B1.9 was accepted on. Only the two UTC lines were corrected. |
| R2-6 | Low | `src/app/admin/solicitation/SendBreakerClient.tsx:35-39` vs `:265` | The new prop doc claims the thresholds "are NOT re-declared here"; the `EmptyState` copy 230 lines below hardcodes `the last 7 days`. |
| R2-7 | Low | `worker/background/pollers/health-alert/__tests__/checks.test.ts:505` (title) vs `:518-520` (injection point) | Promised test `#41` is titled *"isolates a send-breaker-**write** failure"* but injects the rejection on the breaker's **read** probe; no write-specific failure mode is exercised. |

---

### R2-1 — the reset's behaviour changed; every description of it did not

`readBreakerWindow` now bounds every counter at `GREATEST(NOW() - 7 days, MAX(reset_at))`
(`src/lib/solicitation/send-breaker.ts:306-333`). Immediately after a reset the window therefore
holds only post-reset activity, `classifyBreach`'s `BREAKER_MIN_SENDS` floor suppresses any verdict
until 100 fresh sends accumulate, and **the next poller tick cannot re-trip.** The branch's own
promised test `#39` asserts exactly that: `expect(await evaluateSendBreaker(tx)).toBeNull()`
immediately after `resetSendBreaker` (`send-breaker.integration.test.ts:483-484`).

Six artifacts still state the opposite:

| Site | Text | Status |
|---|---|---|
| `docs/runbooks/solicitation-sending-domain.md:419-426` | "**Resetting a still-breached window re-trips on the next poller tick, and that is by design.** … the next `evaluateSendBreaker` re-measures honestly and trips again if the breach still stands. Read a same-day re-trip as 'the window has not recovered yet'…" | FALSE |
| `docs/runbooks/…:397-398` (§8.3 step 4) | "A reset with the ceiling untouched is a reset that will re-trip." | FALSE |
| `docs/runbooks/…:465-466` (§8.5, **added by `cceb0677`**) | "Resetting without rolling the ceiling down re-trips, and each re-trip restarts the clock on a fresh 72 hours of approvals." | FALSE |
| `docs/directory.md:910-911` | "…and why resetting a still-breached window re-trips by design" | FALSE |
| `src/app/admin/solicitation/SendBreakerClient.tsx:163-165` | on-screen: "Resetting a still-breached window is allowed and re-trips on the next health check, by design." | FALSE — **shipped UI copy** |
| `.feature/intake.json` `edge_cases[4]` | "An admin reset while the window is still breached is permitted and the next poller tick re-trips honestly; the runbook says so" | FALSE, and contradicts promised test `#39` in the same file |

**Failure scenario.** An on-call operator follows §8.3 → §8.4 during a real trip, resets, and
observes no re-trip. The runbook and the panel both told them a still-breached window re-trips, so
they read the silence as "the window recovered" and let the ramp continue — while the true state is
a deliberate 100-send half-open probe on a list that has not been fixed. The inverse error is
equally available: an operator who believes a reset is a free probe uses it to "check" whether the
breach still stands, and instead zeroes the measurement.

**This was assigned and dropped, not overlooked as unknown.** The `R1-B2.1` deviations entry states:
*"runbook §8.3/§8.4 now describe a procedure that WORKS; the sibling agent owns the doc rewrite."*
`cceb0677` (07:39, after the 07:37 code fix) touched that runbook — it appended §8.5 and left
§8.2/§8.3/§8.4 untouched, then added a §8.5 bullet repeating the same superseded claim.

**Not in scope to fix here.** Recorded with the precise site list so one pass closes all six.

---

### R2-2 — level-triggered paging vs a LOCKED term that still says "once"

`evaluateSendBreaker` probes for an open trip first and returns `openTripFinding` on **every** tick
while one stands (`send-breaker.ts:106-111`), with the same routing key and a stable title so Sentry
collapses the repeats into one issue. Promised tests `#38` and `#40` pin it.

- `CONTEXT.md:83` (**Send breaker trip**, a LOCKED term): "…so a second breached poller tick is an
  `ON CONFLICT DO NOTHING` no-op: **the breaker pages ONCE per trip, not every five minutes for as
  long as the breach stands.**" The clause before the colon is still true (the *write* is a no-op);
  the conclusion after it is now false, and `CONTEXT.md` is the repo's authoritative glossary.
- `docs/runbooks/solicitation-sending-domain.md:371-372` (§8.2 "What a trip looks like"):
  "**It pages once, not every tick.** The trip insert conflicts on the one-open-trip partial index,
  so a second breached tick is a no-op."

**Failure scenario.** On-call sees `solicitation_send_breaker_tripped` accumulating events every five
minutes, checks §8.2, is told the breaker pages once — and spends the trip window investigating a
non-existent alerting bug instead of the deliverability breach. The B1.1 change was made *because*
one dropped page could hide a platform-wide halt; leaving the docs asserting the old contract
re-creates that ambiguity at the human layer.

---

### R2-3 — the promised admin-reset log line does not exist and is not deferred

`.feature/intake.json` `observability[2]`:

> "Structured log line on admin reset naming the actor user id and the trip row id, plus the durable
> `solicitation_send_breaker` row carrying `reset_at`, `reset_by` and `reset_note`"

The durable-row half ships. The log half does not: `grep -rn "logger\|console\."
src/app/api/admin/solicitation/breaker/` returns nothing, and `resetSendBreaker`
(`send-breaker.ts:225-239`) has no logger call — the module's only `logger` use is the trip line at
`:136`. The route's only logging is `internalError` on the catch path (`reset/route.ts:61`).

The `R1-B1.7` deviations entry closes with *"The admin-reset line is the sibling agent's."* The
sibling agent (`cceb0677`) touched `reset-route.test.ts` and never `reset/route.ts`. There is no
deviations entry, intake amendment, or triage row recording the omission — so, unlike std-1 and
std-5, this one has no paper trail at all.

**Failure scenario.** A platform-wide halt is cleared. The only record is a `solicitation_send_breaker`
row; nothing correlates the reset to a request, a session, or a time in the log stream, so the
reset cannot be joined to whatever else that admin did in the same window during a post-incident
review. The precedent the intake itself cites for this discipline —
`src/app/api/admin/solicitation/batch/halt/route.ts` (`logger.log('admin_batch_halted', …)`) — does log.

---

### R2-4 — a stale comment now claims the duplication is closed

`d6882a0f` exported `formatRate` from `send-breaker.ts` and added the doc comment justifying it.
`a6e060a8` reverted the export (it broke `pnpm build`) and left the comment. `a54ec75f` then removed
the client's four value imports. The comment at `src/lib/solicitation/send-breaker.ts:363-374` now
reads, over a **non-exported** function:

> "**ONE owner** for how a breaker rate is rendered (std-5 / B1.11). … **Exported** rather than
> re-spelled in the client — SendBreakerClient **already imports four constants from this module**,
> so this adds no new coupling."

Three claims, three falsehoods: it is not exported (`:372`); the client imports nothing at runtime
from this module (`SendBreakerClient.tsx:17` is `import type`); and std-5 is deliberately still open,
so `formatRate` has two owners, not one.

**Failure scenario.** This is the exact instruction the round-1 brief asked to be protected against —
the client copy carries a full warning (`SendBreakerClient.tsx:19-30`), but a maintainer editing the
*server* rate format reads "ONE owner" at the site they are editing, changes the decimal places, and
never looks for the client twin. The Sentry page and the admin panel then disagree about whether the
threshold was crossed — which is the concrete harm std-5 named. Fix is to replace the comment with
the client's version of the reasoning, pointed the other way.

---

### R2-5 — the plan still teaches four superseded shapes

spec-8 / B1.9 was accepted on the rationale that a resumed session reads the plan body as source of
truth. The fix corrected the two `date_trunc` lines (`:909`, `:928`) and one doc comment. The
breaker's module source in the same plan is untouched and now carries **four** shapes the branch
deliberately abandoned:

| Plan line | Shape | Superseded by |
|---|---|---|
| `:1063-1065` | "a second breached tick is a no-op and **pages once, not every five minutes**" | B1.1 |
| `:1078` | `if (!inserted) return null;   // a trip was already open — do not re-page` | B1.1 |
| `:1091-1104` | `readBreakerWindow` with **no `WHERE`**, only aggregate `FILTER`s | B1.2 |
| `:1091-1104` | window lower edge is `NOW() - BREAKER_WINDOW_DAYS`, **no `MAX(reset_at)` bound** | B2.1 |
| `:1097-1098` | `WHERE bounce_kind = 'hard' AND bounced_at >= …` — **no NULL arm** | B1.4 half 2 |

**Failure scenario.** #900 resumes from this plan (it is the checked-in decomposition), copies
`readBreakerWindow` as the template for its releaser's read, and re-ships the seq-scan, the fail-open
NULL-kind exclusion and the unreachable-recovery arithmetic in one move — with the branch's own
tests passing, because they test `send-breaker.ts`, not the plan. Either correct the five snippets or
mark the block `SUPERSEDED — see the deviations file`, the remedy spec-8 itself proposed.

---

### R2-6 — the client re-declares the window length it says it does not re-declare

`SendBreakerClient.tsx:35-39` (added by `a54ec75f`):

> "They are **NOT re-declared here**. `send-breaker.ts` remains the single owner of the four numbers
> … A local copy would let the screen and the governor disagree."

`:265`, in the same file: `detail="Solicitation sending is running. The health check re-measures the
**last 7 days** on every tick."` — a hardcoded `BREAKER_WINDOW_DAYS`. The text predates `a54ec75f`;
the *claim* that contradicts it does not. `thresholds.windowDays` is already in scope two components
up. Cosmetic in effect (the string is not enforced anywhere), incorrect as a stated invariant.

---

### R2-7 — promised test `#41`'s title names a write failure; the test injects a read failure

Title (`.feature/intake.json` `tests_to_add[40]`, `checks.test.ts:505`):
*"isolates a send-breaker-**write** failure: earlier findings survive and the failure becomes a warning"*.

The positional stub places `new Error('deadlock detected')` at the **breaker open-trip probe**
(`checks.test.ts:519-520`, and the test's own comment says so: *"the failure has to land on ONE
specific call (the breaker's probe)"*). Because the probe runs first and short-circuits, the window
aggregate and the `INSERT` are never dispatched, so none of the write-specific failure modes B1.3
was written for — `23505`, a lock wait on `solicitation_send_breaker_one_open`, an `ON CONFLICT`
inference error — is exercised.

The **isolation** the title's second clause promises is genuinely proved (`:530-541`: the earlier
`flagged_open_backlog` finding survives, the failure becomes a `warning`), so the behaviour is
covered; only the first clause overstates. Retitling is not possible without breaking the
`promised-tests` byte match, so the honest close is to queue two successful reads and reject on the
third dispatch (the INSERT), leaving the title true.

---

## Part 3 — `a54ec75f` (thresholds as props), audited hardest

| Check | Verdict | Evidence |
|---|---|---|
| The four numbers still have exactly ONE owner | **PASS** | Declared once at `send-breaker.ts:31-34`. `page.tsx:28-33` composes `BREAKER_THRESHOLDS` from them; the client declares only the `BreakerThresholds` **interface** (`SendBreakerClient.tsx:41-46`), no literals, and `thresholds` is a **required** prop with **no default** (`:279-291`) — so there is no silent second copy and no fallback branch. `grep` for `0.02`/`0.003`/`BREAKER_MIN_SENDS` across the client returns nothing. |
| Rendered copy unchanged | **PASS** | `TRIP_REASON_PROSE` → `tripReasonProse(reason, thresholds)`; the split into `tail` reassembles byte-identically (`Hard bounces exceeded 2.00% of sends over the last 7 days. Solicitation sending is halted platform-wide.`). All three `StatTile` label/sub strings are the same templates with `BREAKER_*` → `thresholds.*`. The exhaustive `Record<BreakerTripReason, string>` is preserved inside the function, so a third trip reason is still a compile error. |
| No other client component in the diff has a runtime edge into `src/lib/solicitation/` | **PASS** | `SendBreakerClient.tsx` is the diff's only `'use client'` file. Swept all 12 pre-existing client components that name `@/lib/solicitation/*`: 10 are `import type`; the two runtime imports (`WITHHOLD_REASONS` from `restraint-policy.ts`, `UPLOAD_STATUSES` from `upload-status.ts`) reach modules with no module-scope side effect. None is in this diff. |
| `page-source.test.ts`'s guard catches a regression to value imports | **PASS** | `:147-151` iterates `client.match(/^import[\s\S]*?from '[^']*';$/gm)` and requires any statement naming `@/lib/solicitation/send-breaker` to start `import type `. Traced against the three regression forms: a plain value import fails; a **mixed** `import { type X, CONST }` fails (it does not start `import type `); the multi-line form is matched by the lazy `[\s\S]*?`. A bare side-effect import has no `from`, so the lazy match runs on to the next statement and still fails the assertion — accidentally correct, but correct. `:118-127` independently asserts the prop equals the four real constants (the mock spreads `importOriginal`, so those are the enforced values), and `SendBreakerClient.test.tsx:65-70` sources its `THRESHOLDS` fixture from the module so the literal copy it asserts (`"2.00%"`, `"7 days"`, `"100 minimum"`, `"0.30%"`) is now checked against the enforced numbers. |
| Build regression actually closed | **PASS** | `.feature/gate-status.json` (stamped after `a54ec75f`) reports `build: PASS`, closing the `590d0cc1` blocker. |

**Residual, stated not counted:** the guard is scoped to `SendBreakerClient.tsx` by filename. A
future second client component under `src/app/admin/solicitation/` inherits no protection. That is a
scope limit of the fix, not a defect in it.

---

## Part 4 — the 43-test contract, spot-checked

All 43 titles in `.feature/intake.json` `tests_to_add` exist verbatim as `it(…)` (the
`promised-tests` gate proves presence; this pass checked whether the six added during the fix rounds
say what their tests do).

| # | Title | Assertion honesty |
|---|---|---|
| 38 | "the breaker keeps paging while a trip is open even after the window falls back under the threshold" | **Honest.** Seeds an open trip with an entirely empty outreach table — the extreme form of "under the threshold" — and asserts an `error` finding titled `STILL halted` with `still_open: true`. |
| 39 | "a reset bounds the window so recovery is reachable and post-reset sends are still measured" | **Honest, and the strongest test added.** Both halves asserted: post-reset `evaluateSendBreaker` → `null` with 0 open trips, then 100 fresh sends at 3% re-trip with `sends: 100, hard_bounces: 3`. Either half alone would be a different bug and the comment says so. |
| 40 | "checkSolicitationSendBreaker re-pages on every tick while a trip stays open" | **Adequate.** A single tick is driven here; "every tick" is carried by test `#13`, where two consecutive evaluations both return findings. Covered across two suites rather than in the named one. |
| 41 | "isolates a send-breaker-write failure…" | **Overstates — R2-7.** |
| 42 | "the solicitation lane leaves bounce_kind NULL for an unrecognised provider bounce type" | **Honest.** Two shapes (`{bounce:{type:'Undetermined'}}` and `{}`), asserts `bounced_at` set, `bounce_kind` NULL, `provider_error` still `bounced:soft:…`, and the ledger untouched — pinning that suppression semantics did not move. |
| 43 | "the breaker counts an unclassified bounce with the hard bounces" | **Honest, and defensively built.** Seeds *only* unclassified bounces (zero `hard` rows), asserts the seeded shape (`classified: 0`) before asserting behaviour, so it cannot pass through the plain `= 'hard'` filter. |

`edge_cases[4]` is now the one place in the intake that contradicts the intake — see R2-1.

---

## Appendix — NEW, UNTRIAGED

Not entered in the findings table; unchanged code or scope beyond this round's remit.

**A1. `readBreakerWindow`'s three-way `OR` still cannot use the index.** The `R1-B1.2` deviations
entry says so itself: with only `sent_at` indexed, an `OR` of three predicates cannot form a
`BitmapOr`, so a seq scan remains the likely plan. Recorded there for a follow-up; the `WHERE` is
still correct and necessary. No action this round.

**A2. §8.3's step-ordering rationale is now weaker than its instruction.** "Roll the ceiling down
before resetting" is still good practice (it bounds future volume during the 100-send probe), but the
reason the runbook gives for it — that a reset without it re-trips — is the R2-1 claim. Whoever fixes
R2-1 should supply the replacement rationale rather than delete the step.

**A3. `checks.test.ts:520` declares `const sql: any`.** Against CLAUDE.md's no-`any` rule in the
abstract, but consistent with three pre-existing `any` stubs in the same file (`:15`, `:583`, `:587`),
and the sibling `send-breaker-check.test.ts:32` shows the `unknown`-narrowing alternative. Not raised
as a finding: the new line matches its file's established convention.

**A4. `resetSendBreaker`'s `reset_at = NOW()` is the window's new lower edge.** Inside one
transaction `NOW()` is fixed, which is what makes test `#39`'s `sentDaysAgo: 0` land exactly on the
boundary. In production the reset and the next poll are separate transactions, so the semantics are
the intended ones. Noted only so a later reader does not mistake the test's tight boundary for a
production assumption.
