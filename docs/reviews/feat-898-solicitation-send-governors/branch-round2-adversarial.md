# feat-898 solicitation send governors — adversarial axis, round 2 (VERIFICATION ONLY)

Scope: did each accepted round-1 adversarial fix land, does it do what it claims,
and did any fix introduce a new defect. **No new fronts opened against unchanged
code** — anything noticed outside that remit is in the appendix, untriaged.

Read: `branch-round1-adversarial.md`, `round1-triage.md`, `git log main..HEAD`,
the five fix commits (`eafe6760`, `cceb0677`, `d6882a0f`, `a6e060a8`, `a54ec75f`)
plus `fa941fb6`/`590d0cc1`, the deviations tail (entries `R1-B2.1` … `R1 follow-up 2`),
and the final state of every file they touch.

Independent checks run (not taken from the gate file):

- `pnpm typecheck` — clean.
- `pnpm ci:tenant-scope` — 383/383, baseline 383.
- `npx vitest run --project integration send-breaker.integration.test.ts resend-solicitation-lane.integration.test.ts` — **46/46 pass** against the live test DB.
- `EXPLAIN` of the final `readBreakerWindow` statement against PostgreSQL 16.14.
- `SELECT GREATEST(now() - interval '7 days', NULL::timestamptz) IS NOT DISTINCT FROM (now() - interval '7 days')` → `t`.
- `.feature/gate-status.json` is stamped 2026-08-19T15:13:28Z, ~5 min **after** HEAD (`a54ec75f`, 15:08:22Z), and reports every row PASS including `build` and `tenant-scope`. The two `d6882a0f` gate blockers are genuinely closed.

---

## Verification table

| Round-1 finding | Verdict | One line |
|---|---|---|
| **adv-1 / B2.1** — recovery arithmetically unreachable | **VERIFIED FIXED** (residual: R2-1) | `GREATEST(NOW() - 7d, MAX(reset_at))` lands on the `WHERE` and all three `FILTER`s; recovery is genuinely reachable and the abuse bound holds — but the numerators are still not bounded by the *send's* window membership, so the post-reset probe scores trailing pre-reset signals against a 100-send denominator. |
| **adv-2 / B2.3** — a trip cancels every in-flight batch | **VERIFIED FIXED** (documentation) | Runbook §8.5 ("What a trip costs the batches already in flight") and B14's matching paragraph both state the accepted horn, name the rejected alternative and why, and hand the `platform_halt` reason to #900. |
| **adv-3 / B1.1** — edge-triggered paging | **VERIFIED FIXED** for the dropped-event hole; **NOT FIXED** as liveness (R2-3) | Probe-first + `openTripFinding` on every tick closes the dropped-Sentry-event hole, and the `!inserted` race is bounded to one poll interval. But the re-page title is deliberately constant and lands on a **first-seen** Sentry rule, so the operator receives one extra notification, then silence. |
| **adv-4 / B1.2** — seq-scan of the whole table | **PARTIALLY FIXED** | The `WHERE` is real and semantically a strict superset of the three `FILTER`s, so no contributing row is excluded. `EXPLAIN` on PG 16.14 confirms it is still a `Seq Scan on solicitation_outreach` — the OR-of-three cannot form a `BitmapOr` with only `sent_at` indexed. The deviations record exactly this and defer it; the perf harm the finding described is unchanged. |
| **adv-5 / B1.3** — the write in a "No writes" module | **VERIFIED FIXED** | Module header names the single writer and forbids a second; the call is wrapped in `try/catch` degrading to `health_check_error:solicitation_send_breaker` at `warning`; it stays sequential, in position, and outside any `Promise.all` (#505). A breaker write failure no longer discards the nine findings above it. |
| **adv-6 / B2.2** — decision 2 unachievable | **VERIFIED FIXED** | Amendment **B14** exists, amends **B6** in place (item 3 → "checked at release, not here", numbering preserved for citation stability), and resolves the CAS problem at the root — the check now runs *above* the `rendered → queued` transition, so "the row stays `rendered`" becomes true rather than aspirational. Coherent with B6 item 7 (same shape, already release-level) and does not touch B13's subject. `CONTEXT.md` **Dispatch gate**, `docs/directory.md` and `.feature/intake.json` non-goal all updated to match. |
| **adv-10 / B2.4** — `LEAST(configured, 10)` deletes §4.3's escape valve | **VERIFIED FIXED** (documentation) | B14's closing section states plainly that B3's resolver is the locked mechanism, that §4.3's prose is stale, and that 091's `11..50` range is **inert** — accepted, displayed, silently clamped — so nobody re-adds a knob believing the existing one works. |
| **spec-3 / B1.4** — fail-closed bounce path (BOTH halves) | **VERIFIED FIXED** | Half 1: `resolveBounceKind` (`worker/ingress/resend/solicitation-lane.ts:308-314`) returns `null` for any type outside the recognised-soft set; `extractBounceType` already lowercases, and `'unknown'`/`'undetermined'` both fall through. Half 2: `readBreakerWindow`'s numerator is `bounced_at >= window_start AND (bounce_kind = 'hard' OR bounce_kind IS NULL)`. 110's `bounce_kind_pairing` CHECK admits the NULL-kind-with-`bounced_at` state. Both halves pinned by tests, each carrying a comment naming the other half and stating that neither is safe alone. |

### Did the five commits break each other?

No. `src/lib/solicitation/send-breaker.ts` is coherent at HEAD: one statement,
one `bounds` CTE, the `GREATEST` bound applied consistently to the `WHERE` and to
all three `FILTER`s, the B1.4 numerator branch present, `formatRate` back to
module-private (its only caller is `breakerFinding`, so no dead export), and the
tenant-scope allowlist `sqlSnippet` re-keyed to match byte-for-byte (383/383).
The `d6882a0f` intermediate state's two blockers — the stale allowlist snippet
and the client-chunk build break — are both closed, the latter by removing the
runtime edge (props) rather than relocating the constants, with a source-level
regression guard in `page-source.test.ts`.

---

## Findings — things a fix broke or left short

| # | Severity | Where | Finding |
|---|---|---|---|
| R2-1 | high | `src/lib/solicitation/send-breaker.ts:304-334` | The reset bounds the **denominator** but not the numerators' send membership, so the half-open probe measures trailing pre-reset signals against 100 fresh sends. The deviations file asserts the opposite twice. |
| R2-2 | high | `CONTEXT.md:83`, `:84`; `docs/runbooks/solicitation-sending-domain.md:334`, §8.2, §8.3, §8.4; `docs/runbooks/beta-launch-alerting.md` §1; `.feature/intake.json` `edge_cases[4]` | Eight statements across four documentation owners — two of them **LOCKED** CONTEXT terms and the platform-halt response procedure — still describe the pre-fix behaviour and are now false. |
| R2-3 | medium | `src/lib/solicitation/send-breaker.ts:395-424` + `docs/runbooks/beta-launch-alerting.md:139` | The level-triggered re-page uses a deliberately **constant** title and routes under a **first-seen** Sentry rule, so it yields exactly one extra notification and then goes silent — the anti-pattern the same runbook documents two bullets away for rule 4. |

---

### R2-1 — HIGH — the reset bounds the denominator, not the numerators' cohort

`readBreakerWindow`, final state (`src/lib/solicitation/send-breaker.ts:313-333`):

```sql
COUNT(*) FILTER (WHERE o.sent_at >= b.window_start)                       AS sends
COUNT(*) FILTER (WHERE o.bounced_at >= b.window_start AND (...))          AS hard_bounces
COUNT(*) FILTER (WHERE o.complained_at >= b.window_start)                 AS complaints
```

After a reset at `R`, `window_start = R`. `sends` counts only rows with
`sent_at >= R`. Neither numerator carries any condition on `sent_at`, so a row
**sent before `R`** whose `bounced_at` / `complained_at` lands **after `R`** is
counted in the numerator while its send is absent from the denominator. That is
the design's deliberate signal-dating asymmetry — correct for the rolling
7-day window, where the two cohorts are the same size — carried unmodified across
a boundary where they are not.

**Concrete failure scenario (the `complaint_rate` arm, which is the one with the
long signal lag).**

1. 7-day window: 5,000 sends, 20 complaints (0.40% > 0.30%) → trip at `T0`.
2. Operator diagnoses for six hours, rolls `SOLICITATION_PLATFORM_DAILY_CAP` down
   per §8.3, resets at `R = T0 + 6h`.
3. Sending resumes against a re-verified list. Over the next several hours the
   100 fresh sends accumulate with **zero** complaints of their own.
4. FBL complaints arrive when a recipient clicks "spam", which happens over days
   after delivery — so the pre-reset 5,000-send cohort keeps producing them after
   `R`. **One** such complaint gives `complaints = 1`, `sends = 100` → **1.00% >
   0.30%** → re-trip on the next tick, with a page reading "complaint rate 1.00%
   over 100 sends" built from a numerator that denominator never sent.
5. The operator resets again; the cycle repeats until the pre-reset cohort's
   complaint tail dries up — days, not one reset.

The failure is bounded (each reset discards the signals that landed before it, so
recovery is *reachable*, unlike round 1) but the documented single-reset recovery
is not reliable for `complaint_rate`, and the ratio being reported to the operator
is not a meaningful rate.

**Two recorded claims are false as written.** The deviations entry `R1-B2.1`
(`docs/superpowers/plans/feat-898-solicitation-send-governors-deviations.md`)
states: *"the next 100 post-reset sends are measured honestly"*, and *"Accepted
consequence, stated plainly: late-landing signals from PRE-reset sends no longer
count."* Late-landing signals from pre-reset sends **do** count — that is exactly
what signal-dating means and the SQL has no clause excluding them. The same claim
is repeated in the module doc comment at lines 279-294.

**The fix's own test cannot catch it.** `a reset bounds the window so recovery is
reachable and post-reset sends are still measured` seeds the pre-reset cohort with
`bouncedDaysAgo: 1`, so the pre-reset *signals* are also before `R`. The case that
matters — `sent_at < R AND bounced_at >= R` — is not exercised anywhere in the
suite.

**Shape of the resolution (owner's call, not a preference).** Either add
`AND o.sent_at >= b.window_start` to the two signal `FILTER`s — which is the
cohort measure the design deliberately rejected globally, and would have to be
justified as "cohort inside the post-reset probe, signal-dated in the steady
state" — or leave the arithmetic and correct the two claims plus the runbook, so
the operator is told that a reset taken while signals are still landing will
re-trip and why. What is not defensible is the current pairing: SQL that counts
the old cohort's tail, next to prose that says it does not.

*Confidence: very high on the mechanism (read from the SQL and confirmed against
the test fixtures). High on the scenario — with a 0.30% threshold and a 100-send
floor, a single trailing complaint is sufficient.*

---

### R2-2 — HIGH — four documentation owners still describe the pre-fix behaviour

`eafe6760` changed two observable behaviours (paging cadence, post-reset window)
and `cceb0677`/`d6882a0f` changed a third (unclassified bounces count as hard).
None of the documentation owners were updated. The deviations entry `R1-B2.1`
explicitly delegates it — *"runbook §8.3/§8.4 now describe a procedure that WORKS;
**the sibling agent owns the doc rewrite**"* — and the rewrite never happened;
`cceb0677` added §8.5 only.

Stale statements, all present at HEAD:

| File | Statement | Why it is now false |
|---|---|---|
| `CONTEXT.md:83` (**Send breaker trip**, LOCKED) | "the breaker pages ONCE per trip, not every five minutes for as long as the breach stands" | `evaluateSendBreaker` returns `openTripFinding` on **every** tick while a trip is open. |
| `CONTEXT.md:84` (**Breaker window**, LOCKED) | window described as `sent_at` / `bounced_at` / `complained_at` "in the window", and "Hard bounces are counted from `bounce_kind = 'hard'`" | No mention of the reset lower edge; the numerator now also counts `bounce_kind IS NULL`. |
| `docs/runbooks/solicitation-sending-domain.md:334` (§8.1 table) | "hard bounces \| `bounce_kind = 'hard'`, `bounced_at` inside the window" | Same two omissions, in the operator's primary read model table. |
| §8.2 | "**It pages once, not every tick.** The trip insert conflicts on the one-open-trip partial index, so a second breached tick is a no-op." | The insert is no longer even reached while a trip is open — the probe short-circuits first and pages. |
| §8.3 step 4 | "A reset with the ceiling untouched is a reset that will re-trip." | A reset now clears the window, so the next tick **cannot** trip until `BREAKER_MIN_SENDS` fresh sends accumulate. |
| §8.4 | "Resetting a still-breached window re-trips on the next poller tick, and that is by design … the next `evaluateSendBreaker` re-measures honestly and trips again if the breach still stands. Read a same-day re-trip as 'the window has not recovered yet', not as a bug in the reset." | Precisely inverted. The next tick returns `null` (asserted by the new test: `expect(await evaluateSendBreaker(tx)).toBeNull()`), and a later re-trip now means something different — see R2-1. |
| `docs/runbooks/beta-launch-alerting.md` §1, breaker bullet | "It pages **once per trip**, not once per tick" | Same as §8.2. |
| `.feature/intake.json` `edge_cases[4]` | "An admin reset while the window is still breached is permitted and the next poller tick re-trips honestly; the runbook says so" | Same. The intake was updated for B14 and for the UTC boundary, and gained `tests_to_add[38]` for the reset bound, so it now carries the new test **and** the contradicting old edge case. |

**Why this is high and not cosmetic.** §8 is the written response procedure for a
platform-wide halt that §8.5 says costs approved batches every hour it stands. At
3am the operator is told (a) to expect exactly one page — so a stream of Discord
messages reads as a misconfiguration rather than as the halt still standing — and
(b) to read a re-trip after reset as normal, when post-fix a re-trip after reset
is a *new* signal that means the trailing cohort is still landing. Both readings
send the operator the wrong way. Repo doctrine is one authoritative owner per
fact; there are currently two owners saying opposite things about three facts.

*Confidence: very high. Every line was read at HEAD and compared against the code
it describes.*

---

### R2-3 — MEDIUM — the level-trigger delivers one extra page, then silence

`openTripFinding` (`src/lib/solicitation/send-breaker.ts:412-424`) reuses the
finding `key` and gives the re-page a **stable** title, on the stated reasoning
that "Sentry groups `captureMessage` by its text, so a stable title collapses the
repeat into one issue that keeps receiving events". That is true, and it is what
the configured routing rule turns into silence.

`docs/runbooks/beta-launch-alerting.md:139`, rule 1:

| # | Rule name | _If_ filter | _When_ trigger | Level |
|---|---|---|---|---|
| 1 | `health-alert → discord` | `subsystem` equals `health_alert` | issue is **first seen** | `error` + `warning` |

`emitHealthFindings` (`worker/background/pollers/health-alert/emit.ts:10-18`) has
no dedupe and no frequency logic — one `captureMessage` per finding per tick. So
over a multi-day halt the operator receives:

1. the trip event (title A) → new issue → **Discord notification**;
2. the first re-page (title B, constant) → new issue → **Discord notification**;
3. every subsequent re-page, every 5 minutes for days → same issue, **no
   notification** (the trigger is `first_seen`, not a frequency condition).

The runbook itself names this failure mode, two bullets above the breaker entry,
as the reason rule 4 is the odd one: *"The capture title is a constant, so every
occurrence … groups into ONE Sentry issue. A new-issue rule would therefore fire
exactly once, ever, and then stay silent through the very repetition that is the
actionable signal."* The breaker's re-page has exactly that shape and is routed by
a first-seen rule.

**What the fix does and does not buy.** The hole adv-3 named — *one* dropped
Sentry event producing a silent permanent halt — is genuinely closed: if the trip
event is lost, the next tick's differently-titled message creates an issue and
fires; if the first re-page is lost, the tick after it creates the issue instead.
That is a real improvement and it is why adv-3 is marked fixed above. What is not
delivered is the property the fix's own comment claims — "the finding now reports
that state on every tick, the way every sibling check in `runHealthChecks` does".
The finding is emitted every tick; it is *delivered* twice.

**Cheap resolutions** (owner's call): a second Sentry rule for
`finding:solicitation_send_breaker_tripped` on a frequency condition (rule 4's
shape) — a documentation change, no code; or decay the re-page title on a slow
cadence (hour bucket) so a fresh issue opens hourly rather than every five
minutes; or emit the re-page at a decayed tick count rather than every tick and
pair it with a frequency rule. The distinguishing property to preserve is the one
adv-3 stated: an open breaker is a **state**, and a first-seen rule can only
report an **event**.

*Confidence: high. Rule 1's trigger is written in the runbook, the title's
constancy is written in the code comment as a deliberate choice, and Sentry
groups `captureMessage` by message text.*

---

## Appendix — NEW, UNTRIAGED (not this round's business)

Recorded because they were noticed while verifying, not raised as findings.

- **`std-5` / B1.11 (`formatRate` duplicated) is a bucket-1 ACCEPT that ended as a
  follow-up.** `a6e060a8` reverted the dedup and `src/app/admin/solicitation/SendBreakerClient.tsx:30`
  keeps its own copy, now with a comment explaining why it must not be imported
  from `send-breaker.ts`. The honest fix (a shared formatter in
  `src/components/admin/ui/format.ts`) is named and deferred. Standards axis's item.

- **`src/lib/solicitation/send-breaker.ts` now has a module-scope side effect.**
  B1.7's `const logger = createWorkerLogger('[SendBreaker]')` (line 25) drags
  `node:async_hooks` into any client chunk that runtime-imports the module. The
  new `page-source.test.ts` guard is narrow by construction: it checks only
  imports of `@/lib/solicitation/send-breaker` in that one client file. Nothing
  stops a future client component importing a *different* `src/lib` module that
  also instantiates a worker logger. ESLint invariant #1 does not cover
  `@/lib/shared/logger`.

- **Migration 110's immutable comments still assert the pre-B14 mechanism.** The
  file header (`supabase/migrations/110_solicitation_send_governors.sql:7-11`) and
  the live `COMMENT ON CONSTRAINT solicitation_outreach_status_reason_consistency`
  both say item 3 has no member "because … the child gate DEFERS (**the row stays
  'rendered'**)". B14 changed that mechanism. The comment's *conclusion* (no CHECK
  member needed) survives, so this is a stale rationale in the database rather than
  a wrong constraint; closing it needs a COMMENT-only follow-up migration.

- **`docs/directory.md:928`'s `send-breaker.ts` "Traps:" list** names three traps
  and none of them is the reset-bounded window or the level-triggered re-page —
  the two most surprising properties the module now has.

- **The `bounds` CTE is inlined and its scalar subquery re-planned six times.**
  `EXPLAIN` on PG 16.14 shows six `InitPlan` aggregates over
  `solicitation_send_breaker`, one per reference to `b.window_start`. All six are
  evaluated once each under the same snapshot, so they cannot disagree, and the
  table is tiny — harmless today, worth knowing for whoever revisits the plan when
  the follow-up index lands.

- **adv-5(b) is untouched and now compounds with adv-4's residual.** The trip path
  still fails **open** — the new `try/catch` degrades a breaker-check failure to a
  `warning` finding and the cycle continues — while `readSendBreaker` fails closed.
  Since the aggregate is still a full seq scan of an append-only table inside a
  30 s cycle bound, the most likely future failure is a statement timeout on that
  one check, which now means "no trip this cycle" with a single first-seen warning
  page. Both halves were explicitly left open by the triage (adv-5's option ii,
  and B1.2's deferred index question); noted only because the two residuals meet.
