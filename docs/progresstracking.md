# RepWorth — Progress Tracking

> **Human changelog — newest at the bottom.** This is the detailed build history.
> Agents looking for current state should read [currents.md](currents.md); for
> load-on-demand detail read [.claude/reference/](../.claude/reference/).
>
> **Older history is archived** to keep this file readable (live entries start at
> "2026-08-21 — #898", 2026-08-21):
> - [progress-archive/progresstracking-2026-04_sprints-1-to-6.md](progress-archive/progresstracking-2026-04_sprints-1-to-6.md) — Sprint 1 → Sprint 6 (2026-04-06 → 2026-04-17)
> - [progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md](progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md) — Channels → Multi-location (2026-04-20 → 2026-05-22)
> - [progress-archive/progresstracking-2026-05-to-08_ci-keystone-to-ask-withdrawal.md](progress-archive/progresstracking-2026-05-to-08_ci-keystone-to-ask-withdrawal.md) — CI Keystone → Ask withdrawal (2026-05-24 → 2026-08-18)

---

## 2026-08-21 — #898: **Send governors** — the schema and the three governors #899/#900 stand on (PR #904)

Wayfinder map #617, child of #630. Design of record:
`docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` §3.2A/§3.2B/§3.3/§3.4/§4,
`…-send-mode-executor-approval-design.md` D19/D20, and
`…-send-mode-cross-spec-amendments.md` **B3/B6/B13/B14** (the amendments doc wins on conflict).
Plan: `docs/superpowers/plans/2026-08-19-solicitation-send-governors.md` — 8 tracer tasks,
eval-first (Task 1 was 30 failing tests that ARE the spec).

**Nothing in this PR sends mail.** #899 builds the send worker and #900 the release-side
consumer that actually refuses to send while a trip is open. This ticket holds the migration
slot and the read models so those two land without a migration between them. Today the breaker
can trip, page and be reset; nothing reads it on the send path.

**What shipped.**

| Governor | File | Behaviour |
|---|---|---|
| Send caps | `src/lib/solicitation/send-caps.ts` | platform ceiling resolver + per-account daily cap, UTC-day dispatch counters |
| Send breaker | `src/lib/solicitation/send-breaker.ts` | 7-day window read model, one-open trip latch, fail-closed read, admin reset |
| Bounce discrimination | `worker/ingress/resend/solicitation-lane.ts` | records `bounce_kind` beside `bounced_at` |

Plus migration **110** (two withhold members, `bounce_kind` + two CHECKs + a partial index,
the `solicitation_send_breaker` latch table with deny-all RLS), the `HealthAlertPoller` check
that is the breaker's ONLY tripper, `/admin/solicitation` (Island system, AAL2) with its reset
route, and `docs/runbooks/solicitation-sending-domain.md` §8 as the operational procedure.

**Seven decisions locked in grilling**, none re-litigable on a later branch: `bounce_kind` is a
new column rather than a `provider_error` prefix match (`recordFailure` COALESCEs `failed:<reason>`
into that column, so an `email.failed` before an `email.bounced` would mask a real hard bounce —
fail-OPEN on a governor specified fail-CLOSED); the `withheld` CHECK gains exactly two members and
dispatch-gate item 3 deliberately gets none (a lapsed subscription DEFERS, `send_window_elapsed`
terminalizes); the latch is append-only with a one-open partial unique index, not a mutable
singleton; the window basis is asymmetric (denominator send-dated, numerators signal-dated —
errs toward tripping); `HealthAlertPoller` trips and pages while #900's releaser is a pure reader,
accepting one poll interval of trip latency; no new runbook file; and the reset lives on a new
`/admin/solicitation` page rather than folded into `/admin/autonomy`.

**Review: 2 rounds, 23 findings (6 high) then verification-only. 11 follow-ups filed (B3.1–B3.11).**
Three defects are worth remembering, because in each case the test and the implementation shared
the same wrong assumption and no amount of reading would have found them:

1. **UTC-day boundary** — the fixture used the same expression as production, so both were wrong
   together. Found by a subagent escalating rather than silently deviating.
2. **Breaker recovery** — the asymmetric window was tuned to err toward tripping and never checked
   in the other direction. Fixed once (denominator only), then properly in round 2 with TWO floors:
   `signal_floor` (rolling 7d, dates the numerators) and `reset_floor` (bounds rows by `sent_at` on
   BOTH sides). The first fix's own test seeded `bouncedDaysAgo: 1` and structurally could not see
   the gap — a single trailing complaint read as 1.00% against a fresh denominator and re-tripped a
   legitimate recovery, making recovery arithmetically unreachable.
3. **Edge-triggered paging** — the plan specified the bug as a feature and the eval test asserted
   it, so one dropped Sentry event meant a silent permanent platform-wide halt. Now level-triggered:
   the poller probes for an open trip FIRST and re-pages every tick under a constant title.

**Staging ride** (`docs/runbooks/evidence/2026-08-21-898-send-governors-staging.md`) — complete.
Migration 110 applied to staging and verified by introspection. **9-assertion latch smoke**, all
PASS, including the module's exact `ON CONFLICT ((reset_at IS NULL)) WHERE reset_at IS NULL`
against the real index — the clause that fails at *runtime*, on the second breach, if it ever
drifts. **13-assertion admin smoke** through an authenticated AAL2 browser session, all PASS; the
actor guarantee proved stronger than designed, since the route schema is `strict` and rejects a
body carrying `reset_by` with 400 rather than ignoring it.

**The ride's most useful evidence was accidental.** The 898 code sat on the staging worker for two
days while the database was still pre-110, so the breaker check queried a table that did not
exist. It logged its `health_check_error` warning finding on every one of five `HealthAlertPoller`
ticks and never crashed, then went silent on the first tick after 110 applied. That is a live proof
of both halves of the round-1 isolation fix — the failure class that used to take the whole cycle
down and discard the nine findings collected before it — under real conditions rather than a
harness. Staging was left clean: 0 breaker rows, 0 open trips, 0 outreach rows.

**One red PR, worth recording.** CI failed on `fallow`, the one gate `verify-gate.sh` deliberately
excludes (`ci:fallow*` is `CI_ONLY_BY_DESIGN`). Two findings: an unused export, and the
`gate → parse → safeParse → 400` preamble as a 3-instance clone. **The extraction was built and
reverted.** A `requireAdminJson(request, schema)` in the canonical gate module cleared fallow,
lint, typecheck and build — and failed `ci:admin-aal2` on all three routes, which is that audit's
stated design: it is a fail-closed allowlist of recognized gate SHAPES, and "a gate hidden behind
an imported wrapper is not visible to this audit and does not count." Clearing it would have meant
widening a security control to satisfy a duplication linter, after both review rounds closed.
Acknowledged in `.fallowrc.jsonc` with the blocking reason recorded; follow-up **B3.11** carries the
extraction AND the gate-shape change together, under one review. Kept from the reverted attempt:
`BREAKER_TRIP_REASONS` became a union type (un-exporting it merely handed the finding to ESLint as
"assigned a value but only used as a type"), and `reset-route.test.ts` now mocks the auth PRIMITIVES
rather than `requireAdminWithAal2` — it claimed to mirror the autonomy suite but mocked one level
shallower, which is why that route survived the refactor untouched while six promised tests here
went 401. It still passes after the revert, which is the proof it was a real fix.

**Surface amendments: 4 against a budget of 2**, all owner-approved — `schema-ready.ts`, the
`nav-config.ts` row, the cross-spec amendments doc, and `.fallowrc.jsonc`. None was scope sprawl;
all four were files the work structurally owed. Two of them are the same recurring shape, now in
lab-notes: every new admin page owes a `nav-config.ts` row and every new migration owes a
`schema-ready` requirement, and both are filesystem-walked so the obligation is invisible in the
file you are actually writing.

**Promotion.** Migration 110 applied to **production before the merge**, which is 109's reasoning
verbatim: the change is additive and #898 ships no writer for either new withheld reason, so a
widened CHECK is inert — whereas merging first would have opened the exact window staging proved
survivable but which there is no reason to open in prod. Pre-flight showed prod at 109 with **0**
rows in `solicitation_outreach`, so the no-backfill proof held there too, and confirmed the **078
standing exception untouched** before and after. All three databases agree byte-for-byte:
`md5(pg_get_constraintdef(...)) = 3e644c28c60a3d6135ed3eea7acee224` on prod, staging and local head.
Lockstep complete, no standing exception. All send flags remain OFF.

---

## 2026-08-22 — #899 Solicitation send worker (PR #912, squash `2204e6a6`)

**The first code in this repo that can put a real email in front of a real customer.** Merged
inert: `SOLICITATION_SEND_ENABLED` is off everywhere, and issue **#915** records that it must
stay off until #900 ships. **No migration** — #898's 110 carried this family's schema work.

### Files

New: `src/lib/solicitation/dispatch.ts` (2001), `src/lib/solicitation/send-retry.ts` (181),
`worker/jobs/solicitation-send.ts` (41), `worker/jobs/solicitation-send/failed-hook.ts` (346).
Modified: `run-spine.ts` (+52 — two `STEP_PERSONA` keys plus `findActiveSolicitationSendBatchRun`),
`queue-names.ts` (+5), `worker-types.ts` (+15), `worker/index.ts` (+26), `worker/queues.ts` (+5),
`ask-compliance-lint.ts` (+44 — the new `lintInputFromSnapshot` mapper), `ask-generation.ts` (+34/-23
— routed through it), `outcome-anchor-pairing.test.ts` (+42 — two new spine callers allowlisted),
`CONTEXT.md`, `docs/directory.md`, the cross-spec amendments doc. Tests: 3,602 lines across five suites.

### Shape

`tx1` (stale-attempt guard → advisory lock → batch row → outreach row → seven-item **Dispatch gate**
→ consent snapshot → **Lazy child** → token mint → CAS `queued`→`sending`), then the provider call
with **no lock held** and bounded in-process retry, then `tx2` committing five terminal facts at once
(CAS, child terminal, `solicitation_sent`, outbox completion, `closeBatchIfSettled`).

### Decisions (ten locked; six recorded upstream as amendment **B15**)

1. Slow gate items (re-lint, re-moderation) run **above** `tx1` — a ~10s provider call must not be
   held under the batch lock. `tx1` verifies a digest of the bytes those verdicts saw, so the
   **Owner approval** byte-for-byte contract is checked, not assumed.
2. Retry is **in-process only**. A fresh process never re-sends: the raw unsubscribe token existed
   only in memory (invariant #5), so no correct message can be rebuilt.
3. A flag-off **defers**; 091/110 carry no `flag_off` withheld reason.
4. The dispatch moderation verdict never overwrites `moderation_status` (render provenance, B1).
5. Review link is `writereview?placeid=…`, and **throws** on a null or non-canonical place id —
   migration 007's legacy hex CIDs would mint a URL resolving to nothing.
6. `QUEUE_NAMES.SOLICITATION_SEND` ships with the consumer; the typed helper ships with its
   producer (#900), which is B10 clarified for the post-decomposition world.

### Review — one round, three axes; four defects fixed

**Two reviewers independently found the same bug:** `tx1` short-circuited only on `cancelled` and
`sending`, so any other status walked the whole gate and committed writes. A never-released
`rendered` row would have been silently terminalized `withheld` (091's CHECKs accept it), and on a
gate pass the token row committed before the CAS failed — after which #900's later legitimate
release would hit `token_conflict` and refuse that contact **forever**.

Also fixed: the exhaustion hook wrote `failed`/`send_exhausted` for a `sending` row (D12d's
lie-with-teeth — it can email someone twice), `tx2` emitted `solicitation_sent` even when its
terminal CAS matched nothing (losing the only bounce-attribution key), and the gate trusted a byte
immutability only a domain module enforces. Plus a glossary violation, a stale directory row, a
tautological property assertion, and a fifth copy of `boundedErrorClass`.

Reports and triage verdicts: `docs/reviews/feat-899-solicitation-send-worker/`.

### Gotchas found (promoted to lab-notes 2026-08-22)

`timeout(1)` is absent on macOS and its absence looks like success · `solicitation_suppressions`
and `job_outbox` carry no tenant columns · hard-coded restraint-policy fixture dates are time bombs
(detonated mid-feature, fixed in #911) · `docs/analytics/events.md` owns event keys, not the code ·
local `fallow` cannot predict its own CI gate · every new run-spine caller owes three allowlist
edits · `sending_at` and `sending_started_at` are different columns with different owners.

### Follow-ups

**#913** relocate the provider-agnostic error vocabulary out of `src/lib/payments/`.
**#914** Send handoff should withhold a location with no canonical place id.
**#915** enablement blocker: #900 before any flag flip.

## 2026-08-23 — #900 Solicitation release poller (PR #920, squash `a321634a`)

`SolicitationReleasePoller` — the one Postgres-state-driven loop that drives the send lane.
Five phases in a fixed order, every 60s. **No migration**: 091 and 110 already carried every
column, CHECK member and index this feature writes.

Lane: RISK = high · SURFACE = backend · `db_touching: true`. Rode `staging` first (Railway
deploy verified: worker boots clean, poller registers at the 60s default, three cycles land
exactly 60s apart, zero errors, and staging holds no send-mode rows so the zero counts are
honest rather than a silent skip).

### The five phases

1. **`unknown` sweep (D12d)** — an Outreach row wedged in `sending` past 60 minutes with no
   in-flight outbox row terminalizes `unknown`, terminalizes its **Lazy child**, joins, and
   raises a Sentry alert. This frees the location's one-active-send slot under 091's
   `solicitation_batches_one_active_send_per_business`, which is **#915's blocker**.
2. **`send_window_elapsed`** — a batch past its 72h send window is latched with no actor.
3. **`batch_expired` (B7)** — a batch never approved inside its 7-day approval window, same
   latch. Makes `STALLED_THRESHOLD_SEND_BATCH_DAYS` (11) unreachable rather than unlikely.
4. **Release** — the four send governors in amendment B6's fixed order (Send breaker →
   platform ceiling → account cap → per-child), then the `rendered → queued` CAS and one
   `solicitation_send` job per row. **The only phase `SOLICITATION_SEND_ENABLED` gates.**
5. **Backstop join** — a second CALLER of `closeBatchIfSettled`, never a second implementation.

### Files

| File | What it owns |
|---|---|
| `src/lib/solicitation/release.ts` (new, 1,739 lines) | `runReleaseCycle`, `sweepSystemHalt`, `runAccountArm` / `runBatchArm`, `capacityStop`, the P1–P4 predicates. |
| `worker/background/pollers/SolicitationReleasePoller.ts` (new) | Composition root only. Owns `sql`, the interval, the guarded-poll scaffolding. |
| `src/lib/solicitation/approval.ts` | + `latchSystemHalt`, the Halt latch's third and actor-less arm. |
| `src/lib/shared/job-outbox-helpers.ts` | + `enqueueSolicitationSend` (B10). |
| `src/lib/agents/run-spine.ts` | + `approval_downgraded` in `STEP_PERSONA`. |

### Decisions worth keeping

- **The poller does NOT read `SOLICITATION_SEND_ENABLED`, departing from its `JudgeSweepPoller`
  precedent.** The flag gates phase 4 inside the domain module. Gating the cycle would stop the
  sweeps, so a batch flipped off mid-drip would keep its `queued` rows forever and 091's index
  would block that location permanently — the wedge #915 exists to close.
- **`latchSystemHalt` applies NO guard list.** The human arms refuse `halted`, `closed` and
  `pending` because an actor is owed an answer; a clock is owed nothing, so `latchHalt`'s
  `halted_at IS NULL` CAS is the whole of its idempotence.
- **Two isolation units, each the unit its work belongs to.** Account for the two per-account
  gate reads; batch for everything inside. Without the inner unit one poisoned batch discarded
  the account's whole remaining tick every tick — #915's wedge narrowed, not closed.
- **The account cap is checked BEFORE the subscription** (B6's closing paragraph). Both gates
  refuse; only the reported reason differs, and getting it wrong sends the operator to the
  wrong dial.

### Env vars

`SOLICITATION_RELEASE_POLL_INTERVAL_MS` — optional, 60s default. Parsed like
`JUDGE_POLL_INTERVAL_MS` with one extra rejection: a value at or below the 45s
`CYCLE_TIMEOUT_MS` is invalid, because `GuardedPollOptions` requires the per-cycle deadline
to sit below the interval.

### Review

19 accepted findings across 3 rounds (12/5/2 found; 11/5/2 accepted; 13 fixed, 5 deferred to
#919, 1 rejected). Round counters hit the cap at 3/3. The rejected finding was module shape:
the standards agent — whose axis it is — examined the single-export file and declined to flag
it; the adversarial agent asserted the opposite without naming a seam.

Reports and triage verdicts: `docs/reviews/feat-900-solicitation-release-poller/`.

### Step 8 cost two extra CI cycles, and both are worth recording

- **CI run 1: `fallow` red** on three new findings — `runReleasePhase` CRITICAL (cyclomatic 25,
  cognitive 58, 205 lines) and two clone groups, all one root: the three capacity gates
  re-spelled at three nesting depths. Fixed by `capacityStop` + `ReleaseCounters` + extracting
  the two arms (205 → 135 lines), and by unifying the two sweeps into `sweepSystemHalt`.
  **This discharged round 1's Finding 2, which had been accepted and deferred to #919** — so
  that deferral shrank. A fourth finding, clone `dup:ddc3f485` in `approval.ts`, was proven
  pre-existing on `main` and needed nothing.
- **CI run 2: `test` red — the clock, not the code.** That run spanned 23:59:14 → 00:01:34 UTC.
  Three fixtures seed "an attempt already made today" as `NOW() - '5 minutes'`; the account cap
  counts on a UTC-day predicate, so after midnight the row lands in yesterday and the cap stops
  binding. Fixed with an opt-in `queuedWithinUtcDay` clamp, proven by reproducing the exact
  assertion and clearing it on the same clock.

### Gotchas found (promoted to lab-notes 2026-08-22/23)

Eight false rationales on one branch, every one a claim about the module's own internals ·
a lint suppression is a claim, so delete it and re-run before keeping it · any fixture meaning
"already happened today" must be clamped inside the UTC day · `prettier --write` reformats the
whole file because this repo has no prettier config · the `fallow` PR gate IS reproducible
locally, but only with **both** `TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL` exported ·
a cross-account spine-writing loop owes FOUR governance registries · the reclassify trigger
measures the diff, not the lane · `it.fails` is not evidence without a sensitivity probe.

### Follow-ups

**#917** B14's gap — a halt-aware send window OR a distinct `platform_halt` reason.
**CLOSED by #926 (2026-08-22), and it took the SECOND option**: migration 111 widened 091's
halt-reason CHECK and 110's outreach disposition CHECK to admit `platform_halt`, adding it to
the REASON list and deliberately not to the ACTOR list, so it is a third actor-less
`SystemHaltReason` needing no new actor semantics. The halt-aware window was NOT built and must
not be revisited casually: B14's argument against it stands — holding batches past their window
blows past the "≤10 days by construction" bound `STALLED_THRESHOLD_SEND_BATCH_DAYS = 11` derives
from. The sweep still runs on the same 72h clock; `resolveWindowHaltReason` reads the breaker once
per tick and picks which reason it writes, through the ONE sanctioned `try/catch` around
`readSendBreaker` — label-only, because a rethrow would stop the sweep and reopen #915's wedge.
**#923** the §7.1 yield-to-transactional obligation — **split out of #917 on 2026-08-22**, because
implementing #917's send window would have closed it silently. Different trigger, different fix.
**CLOSED by ADR 0022**: the refusal is recorded rather than the yield built. Two per minute against
ten per second is not contention (~0.33% of the team limit; ~0.6% at §3.3's 5,000/day ceiling), and
`dispatch-rate-bound.test.ts` pins the four dials that would invalidate that.
**#918** no CI audit enforces the `env-vars.md` registry row.
**#919** `seedUpload` hand-copied in six test files · no `CONTEXT.md` term for the release lane ·
the sub-default configured-cap gap · the subscription gate's structural shape · and new: extract
a shared `lockBatchForHalt` preamble for `haltBatch`/`adminHaltBatch`.
**#915** CLOSED by this merge (verified: 60-min grace > the watchdog's 15-min re-pend; `unknown`
counts as possibly-contacted structurally, because `over_contacted` keys on `solicitation_asks.status`
and the terminalization never writes that table). **Its content was the BLOCKER, not the enablement
decision** — an earlier draft of this line said otherwise and was wrong. The flip itself is governed
by design doc §8.4 + the `flag-flip` skill and currently has **no tracking issue**.


## 2026-08-24 — #631 Auto-approval lane (PR #950, squash `0278366c`)

The Solicitation send lane's Autopilot path: `auto_policy` batch approval at the
ask-generation finale (four-condition gate D20 + account-wide Governor read D19 +
opt-in policy row; owner-won race is a quiet outcome), the Veto notice family
(`worker/jobs/solicitation-veto-notice/` — email/Telegram/WhatsApp, batch-scoped,
`solicitation_veto_notice` template/topic, claim-before-send on migration 113's
unique partial indexes), the Veto anchor release phase (SQL-side `MIN(sent_at)`
over non-bounced rows + granted window from the latest `batch_approved` spine step,
fail-closed per D9), the release-time re-check (`findAutoDowngradeReason` — narrower
than the approval gate by design: B14 subscription HOLDS, B15 master flag STOPS),
`ReleaseCycleReport.autoDowngradedByReason`, the `veto_window_granted` spine step,
and the `/settings/auto-approval` Solicitation opt-in card. Flags:
`SOLICITATION_AUTO_APPROVAL_ENABLED` (new, default OFF) behind
`SOLICITATION_SEND_ENABLED`; `WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID` unset ⇒
WhatsApp arm skips cleanly.

Process: 3-round Codex plan review (REVISE→REVISE→APPROVED), intake re-locked rev 2
(anchor = first provider-accepted `sent_at`, Reply-lane port), 44 promised tests,
branch review spec/quality/adversarial (A2 accepted narrowly → `failed_at IS NULL`
on the anchor scan; A1/A4 rejected with positions recorded; A3 → issue #949).
Post-PR fallow fix wave (`22986fb2`): `settings-guards.ts` extracted to break the
settings ↔ solicitation-settings cycle, 3 de-exports, 7 stale suppressions deleted
(fallow now traces interface dispatch — lab note 2026-08-24), `releaseBatchRows`
split from `runBatchArm`, WhatsApp veto byte-pin tests added. Migration 113 applied
staging-first then prod (introspection-verified both). CI note: migration-092's
plan-shape test flaked once (planner Sort-vs-index coin flip; lab note) — clean on
rerun. Staging rode the exact tree pre-merge and was realigned to `main` post-merge
(`reset --hard` + `--force-with-lease` per the runbook). Deviations ledger:
`docs/superpowers/plans/631-auto-approval-lane-deviations.md` (fully closed).

## 2026-08-26 — Review QR: per-location printable QR → Google write-review page (PR #982, squash `43afb2b7`)

feat-qr-review-request (single PR via /feature, RISK=high — roadmap Phase 0
pull-forward, owner decision 2026-08-26). Per-location printable QR encoding the
RepWorth-owned **QR redirect** `/q/<businessId>`
(`src/app/q/[businessId]/route.ts`), 302 to Google's write-review deep link. The
destination is CONSTRUCTED from the `isPlaceId`-validated place id — no stored
URL, no open redirect, hex CIDs refused (the `buildReviewLink` precedent). Gate =
`subscriptionAllowsQrRedirect` (`{active, trialing, past_due}`; owner decision —
`past_due` keeps a printed counter code alive mid-grace); every refusal (bad id,
missing row, archived, `pending_payment`/`cancelled`, non-canonical place id)
serves one byte-identical scanner page, reason-coded in the log only. Scan
counting is a best-effort `qr_scan_redirected` insert AFTER resolve: random
event key per scan (a deterministic key would dedupe on `ON CONFLICT` and
undercount), ids duplicated into properties because `AnalyticsDispatchPoller`
ships only the properties JSON. Owner surface: `/settings/review-qr`
(`ReviewQrClient` + `PrintButton`) + print view
`/settings/review-qr/print/[businessId]` + `SettingsSidebar` entry. Supporting:
`src/lib/locations/review-qr.ts` + `getQrRedirectRow` (`repo.ts`), migration 115
(widens the `analytics_events` `event_name` CHECK; constraint-only on the 106
pattern), tenant-scope allowlist +1 `pre-auth-token` (baseline 370), 7 test
files carrying the intake's 18 promised titles (2 new live-DB suites; the 106
drift guard handed to a new 115 suite).

Process: plan hardened through three Codex plan-review rounds — two orchestrator
rejections REVERSED on Codex evidence, two Codex factual claims corrected in
return, one orchestrator rationale (file-granular allowlist) disproven by Codex
running the audit; full record in the plan's review appendix + deviations file
(`docs/superpowers/plans/feat-qr-review-request-deviations.md`).

Post-merge (2026-08-26/27): migration 115 promoted staging-first
(`kubdiqdhqbhwmqfditeg` 2026-08-26) then prod (`udeyaqnvpojbwgoaxwdg`
2026-08-27), verified by reading `pg_constraint` back on both. WAF rule 3c
`qr-redirect-per-ip-enforce` (path prefix `/q/`, ANY method, 30 req/60s per IP →
429) published + burst-verified 2026-08-27 (40-request burst: exactly 30×404
then 10×429) — adversarial finding A2, accepted ops gate. Staging smoke needed
Vercel Protection Bypass for Automation — the staging custom domain is still
intercepted by Deployment Protection despite `all_except_custom_domains` (lab
note 2026-08-26).

---

## 2026-08-30 — #1008 **Refusal ledger** slice 1: migration 116 `refusal_events` (PR #1019, squash `80f68f86`)

**Why:** map #994's first slice. The parent effort (`feat/refusal-log`) tried to
DERIVE the Refusal surface from seven existing tables and could not order it —
two of the seven lanes carry no immutable timestamp of their own, and
`account_audit_log` has no location key, so joining it through `businesses`
multiplied one account-wide suspension by the location count. #1001 locked a
recorded table instead. This slice ships that table and nothing else.

**What was done:**

1. **Migration 116** — `refusal_events`: 12 columns, 5 CHECK constraints, 3
   indexes, deny-all RLS. UUIDv7 worker-supplied PK, no DB default: the writer
   mints the id inside the deciding transaction. `occurred_at` is
   writer-supplied and is the single retention clock; `created_at` is the insert
   stamp and deliberately NOT a retention candidate — the skew between them is
   the only diagnostic that would prove a writer stamping `occurred_at` wrong.
2. **C5 was corrected against the locked shape, and the defect was real.** With
   `refusal_code = 'winner'` against `all_refusal_codes = ARRAY['different',
   NULL]`, `= ANY(…)` finds no TRUE and one NULL so it returns NULL, the arm
   collapses to NULL, and **a CHECK is satisfied by NULL** — Postgres accepted a
   row lying about its own precedence. Two clauses close it:
   `array_position(all_refusal_codes, NULL) IS NULL` and an outer `IS TRUE`.
   Reproduced against a live database with two `TEMP` tables before a line of
   the fix was written; live-fired again on staging at promotion and REJECTED.
3. **C1's wrapper cannot be proven by inserting a row** — the standalone
   `refusal_source` CHECK rejects an unmapped lane first — so its test reads
   `pg_get_constraintdef`, and asserts the deparsed `ELSE NULL::boolean` is
   PRESENT. Asserting its absence tests pg's deparser: Postgres normalises a
   `CASE` with no `ELSE` into one, and the test failed for exactly that reason
   on its first run.
4. **A forced-consequence chain nobody declared up front.** A new tenant table
   forces `TENANT_TABLES` (**two structures**) → `docs/security/rls-inventory.md`
   → `TABLE_DISPOSITIONS` → a `verificationQuery` arm **and** an account-scoped
   DELETE in `runContentPurgeStage`, because **no cascade reaches this table**.
   That chain spent the run's second surface amendment and tripped the
   workflow's abort criterion as a false positive (deviation D13, owner
   sign-off). Promoted to the `new-migration` skill in #1023.
5. **The chain changed the ship order.** #1008 prescribed merge-then-promote on
   the premise that no deployed code names the table; the purge DELETE broke it.
   A `42P01` there aborts the purge transaction and `PurgeWorker` terminalizes
   the offboarding after bounded retries. Final order — CI green → staging DDL →
   staging ride → owner approval → **production DDL → merge**.

**Two P0s, both found after the gate was green, both the same class:**

- `purge-verification.test.ts` mocked `sql` to fabricate `[{violation_count: 2}]`
  and asserted SQL **text**, so its `refusal_events` case could not fail for the
  behaviour it was named for. Two mutants passed everything: narrowing the WHERE
  to hide account-wide rows, and renaming the count alias so `countViolations`
  reads `undefined ?? 0`. Either ships a verification reporting a **clean purge
  over surviving tenant data**.
- **The fix for the first one carried the second.** It varied the fixture along
  one axis and was measured only against the two known mutants, so a temporal
  narrowing still survived — every fixture row was written with `NOW()`.

The root cause is the fixture, not the query: a fixture holding a dimension
CONSTANT cannot catch a predicate that narrows on it. The live-DB arm now varies
tenant, location, time and subject and asserts an exact count; eight mutants
measured, eight killed. `owner-offboarding-staging-dry-run.md:98` recorded this
same mock-drift class as launch-blocking on 2026-06-08 and recommended exactly
this test — these were instances three and four.

**Verification:** gate GREEN 28/28 including `--review` diff-coverage and both
live-DB suites; red-team CLEAR (25 findings, 0 open, 22 fixed, 2 accepted-risk
under AUTH-1008-01 → issue #1016, 1 rejected). Migration promoted to staging and
production 2026-08-30 in lockstep, verified by introspection on both and proven
IDENTICAL by `md5(pg_get_constraintdef)` and `md5(indexdef)`.

**Left open, deliberately:** the adversarial approach review never completed
(dispatched twice, killed with zero output — its record-vs-derive and
JSONB-vs-child-table challenges are unanswered); **31** tables carry
`must_be_absent` against only **3** live-DB verification arms, so the same
mutants would survive on the others; and where the first Refusal write site
lands (#1009 vs #1010) was left unsettled by deviation D16 — the artifacts split
3-to-3 and #1009's PR is what knows.

> **D16 is now closed by #1009.** The FIRST Refusal write site lands in #1009:
> `autonomy_suspended`, one site, inside `suspendAccountAutonomy`, shipped with
> the insert helper; the other ten across #1010–#1013. The count never broke
> the tie and could not — the deciding evidence sits outside the artifacts
> counted here, in two decisions that predate all of them: #1004 locked the
> slice order verbatim (slice 2 = helper + kill switch + `autonomy_suspended`),
> and #1009's ticket body §5 is headed "First caller — `autonomy_suspended`
> (1 site)". The "#1010–#1013" reading came from #1008's intake `non_goals`,
> which enumerated what #1008 excluded — true about #1008, silent about #1009.

> **Ledger gap, noted not fixed:** this file's prior entry is 2026-08-26. PRs
> #990, #992, #993, #1015, #1017, #1018, #1020, #1021, #1022 and #1023 have no
> entry. Backfilling other features' history from outside their sessions would
> be guesswork, so it is recorded here instead of silently invented.


## 2026-08-31 — #1009 **Refusal ledger** slice 2: the write path (PR #1031, squash `dbc66c61`)

Slice 2 of 7 of map #994. Ships the one insert helper, its kill switch, the
retention arm, and the **first Refusal write site** — and settles the decision
#1008 deliberately deferred.

**What landed**
- `src/lib/refusals/vocabulary.ts` — the two closed axes (**seven** lanes,
  **eight** categories) mirroring migration 116's CHECK members, the four
  subject types, `REFUSAL_VOCABULARY_VERSION`. Harvested from the parked
  `feat/refusal-log` and corrected: that branch had six and seven.
- `src/lib/refusals/write.ts` — **the ONE insert helper** owning the whole
  `refusal_events` statement, on `writeAccountAuditLog`'s model, plus the
  default-ON `REFUSAL_LEDGER_ENABLED` kill switch.
- `src/lib/auto-approval/suspension.ts` — `autonomy_suspended`, the first write
  site, inside the existing transaction.
- `worker/background/pollers/ArchivalPoller.ts` — the eleventh retention arm on
  `REFUSAL_LEDGER_RETENTION_DAYS = 180`, plus its tenant-scope exemption.
- `worker/background/schedulers/AutonomyGovernorScheduler.ts` — a Sentry sink
  inside the existing containment `catch`.
- Both flag registry rows, two `docs/directory.md` rows, and the D16 sweep.

**No migration.** 116 was already in staging and production.

**D16 settled.** #1008's artifacts split 3-to-3 on where the first write site
lands, and it named this PR as the change that would know. The deciding evidence
was never the count — it is #1004's verbatim slice order and #1009's ticket body
§5, two locked decisions predating every copy in the dispute.

**What the review layers cost and bought.** Plan ×3, branch ×1 (three parallel
axes), red team ×3 — 31 findings. The three that mattered:
1. **The input type accepted illegal states.** Two axes found it independently.
   The plan had rejected a per-lane union because "a TypeScript copy would be a
   second authority" over the CHECKs — which conflates STORAGE authority with
   API shape. Now a mapped type over `RefusalSource`: a mis-paired lane is a
   compile error, not a `23514` aborting a deciding transaction.
2. **Three plan rounds designed on a Sentry behaviour the SDK does not have.**
   `captureMessage` returns on queue, buffers, and swallows transport failures,
   so every version of the cooldown rested on a false premise. Only a CODE
   review could catch it — a plan does not name a version.
3. **CI caught a defect the local gate structurally could not see.** The gate
   runs CHANGED integration suites; `AutonomyGovernorScheduler.integration.test.ts`
   was untouched while the production file beside it changed, and
   `refusal_events`' account FK (no `ON DELETE`, by design) blocked its teardown.
   CI named one path; the file had three.

**Staging ride.** Both the write site and the kill switch proven on the deployed
worker: one row, `business_id NULL`, `occurred_at` equal to the audit row's
`created_at` **to the microsecond**; then with the flag off, two suspensions and
two audit rows against ONE refusal row. Flags and seeded data restored exactly.
Evidence: `docs/reviews/feat-1009-refusal-ledger-write-path/staging-ride.md`.

**Known gap, accepted with owner authorization:** neither new Sentry signal
reaches a paging channel. Pre-existing, shared with every `warning`-level
capture in the repo, and both tags are now on `beta-launch-alerting.md`'s
pending checklist.

**Documented override:** `red-team-status.mjs` refuses this branch on one
structural ground — `round must be 1 or 2` — because the owner-authorized RT-8
fix voided round 2's evidence and the attestation round is over cap. Every other
check passes. The attesting agent declined to falsify the round number. Full
record: deviations D26.

29 promised tests, all active. 27 deviations, all ACCEPT.

---

## 2026-08-30 — #994 **Refusal ledger**: the five remaining lane category maps (PR #1034, squash `95597c4b`)

A prerequisite carved OUT of slices 3, 4 and 5 rather than duplicated inside
them. `#1010`, `#1011` and `#1012` ran concurrently as a swarm, and all three
needed the same maps; landing them once ahead of the swarm is what stopped three
branches from racing for one file.

Files: `src/lib/refusals/vocabulary.ts`, `src/lib/shared/worker-types.ts`,
`src/lib/solicitation/approval.ts`, `worker/jobs/publisher/auto-policy-downgrade.ts`,
`docs/directory.md`.

## 2026-08-31 — #1012 **Refusal ledger** slice 5: the `auto_post_revoked` lane (PR #1043, squash `220f0364`)

One write site in `worker/jobs/publisher/auto-policy-downgrade.ts`, plus the
`account_id` widening the lane forces. One of the three slices run concurrently.

## 2026-08-31 — #1011 **Refusal ledger** slice 4: the `outreach_withheld` RENDER lane (PR #1042, squash `7349acc6`)

Four writers, and the clock moved to **decision time**. That move is what later
made shared instants ordinary rather than freakish: both settle paths stamp
every row with one shared `decidedAt`, which is why #1049 had to add `, o.id`
under `selectRenderedOutreach`'s LIMIT — a non-unique ORDER BY with a LIMIT
returns an arbitrary slice.

`outreach_withheld` is the ONE lane carrying two category maps, RENDER and
DISPATCH, because its two writers decide different things at different moments.

## 2026-08-31 — #1010 **Refusal ledger** slice 3: the three solicitation lanes, and the set-based arm (PR #1044, squash `2ef07b4f`)

`ask_withheld`, `batch_halted` and `outreach_withheld`/dispatch, plus
`writeRefusalEvents` — the second statement in the module #1001 made the single
owner of this table.

**The set-based arm is not an optimisation; it is a correctness requirement.**
The ticket said "none is high-volume" and that is false for `ask_withheld`:
`loadCandidateWindow` bounds the cohort at `MAX_DATA_ROWS` = 5000 and a rebuild
re-evaluates the whole accumulated pool, so looping the single-row helper would
put up to 5,000 sequential round trips inside the transaction holding the
per-Business advisory lock. One `jsonb_to_recordset` INSERT instead, with the
`ON CONFLICT … WHERE subject_id IS NOT NULL` predicate re-spelled BYTE-FOR-BYTE
and **no affected-row-count assertion** — under `DO NOTHING` a subject stored by
an earlier call legitimately lowers the count.

New production file: `src/lib/solicitation/attribution-display.ts` (row landed
in the same PR).

## 2026-08-31 — #1049 **Refusal ledger**: the post-merge sweep (PR #1049, squash `15e9f0cb`)

The debt the three concurrent slices deferred, paid in one change. Four
artifacts still said the ledger had ONE writer and that five maps had no caller;
both became false when the swarm merged. `REFUSAL_LEDGER_FLAG` is now exported
from the module that reads it, retiring the literal six test files each
re-spelled.

**The sharpest item was not a ledger question.** `evaluateAsk`'s
`already_reviewed` gate is correct and unreachable (`toCandidate` hard-codes
`matchedReview: null`), and reading the UI turned a dead-gate smell into a FALSE
PROMISE: `GhostPipeline.tsx` told the owner *"Customers who already reviewed you
are never asked again."* The copy was corrected to say the capability is coming;
the gate was left alone, because the gate is not the defect. Producer is #1048.

## 2026-08-31 — #1013 **Refusal ledger** slice 6: `held_draft` + `policy_gate_held` (PR #1055, squash `9d26c5a3`)

The LAST write slice. Both sites sit inside the ONE `sql.begin` that carries
invariant #4's moderation-hold atomicity.

**The vocabulary is now closed and complete**, verified in
`src/lib/refusals/vocabulary.ts`: seven lanes, eight owner-facing categories,
seven lane category maps. `held_draft` is the one lane with **no map at all**,
because it has no code axis (constraint C4).

**The ticket's own "Volume" section is FALSE against this code, and the branch
does not implement it (deviation D4).** It and #1003 both claim that with
`AUTO_APPROVAL_ENABLED` off, every draft on a policy-configured account writes
an `autonomy_paused` row. The flag off makes `auto_approval_disabled` a
STRUCTURAL gate, so `isAutoApprovalCandidate` is false,
`resolveAutoApprovalDecision` returns `runtimeState: null`, and NO policy row is
read — "on a policy-configured account" is unknowable on the exact path the
claim describes. Owner ruled the narrowing is inherited verbatim.

`isGenuineAutoCandidate` is the deliverable nobody asked for: the fallback log
and the ledger write must select identical drafts or the intake's reconciliation
query is meaningless, so the three conditions became one type predicate.

**Operational consequence for the go-live, and it is now #1014's problem.**
`AUTO_APPROVAL_ENABLED` is off in production, so `policy_gate_held` writes ZERO
rows there until position 4 of the ordered flip — not few, zero. Only
`held_draft` is live at merge, and the staging ride with the flag off proved
half this slice (deviation D12). #1014's **Coverage start** cannot be honest for
that lane on merge ordering alone; raised on the ticket.

## 2026-09-01 — #1013 **Refusal ledger**: the post-merge sweep (PR #1060)

The step-8 sweep for #1013. Governance only — no file under `src/`, `worker/`
or `supabase/`.

- **D10 fixed.** `red-team-status.mjs`'s `makeGit` trimmed the WHOLE porcelain
  output, so the first line lost the leading space of its ` M ` status field and
  `line.slice(3)` returned a path one character short. The exclusion for the
  report's own two files compares exact paths, so it could never match line 1 —
  the checker failed on the artifact it had just written, and only ever on the
  first line, which is why a second modification hid it.
- **`equivalent` added to the red-team inventory outcomes (D11).** A claim about
  the MUTANT, which does not block; `inconclusive/oracle` stays a claim about the
  ORACLE and blocks exactly as before. The row must carry its proof in `reason`
  and may not reference a finding. An ABSENT `counts.equivalent` reads as zero so
  older sidecars still validate; no other count gets that latitude.
- **D8 promoted** to `execution-lanes.md` as wave rule 4: every read-only review
  axis reads a COMMITTED SHA, never the working tree. Rules 1-3 protect the tree
  and none of them protects a concurrent reader while red team mutates it.
- **D9 promoted** to lab-notes: `git checkout -- <path>` restores the FILE, not
  the MUTATION, and destroyed uncommitted review fixes twice.
- **The entropy counter moved 3 → 9, and six merges had been lost, not one.**
  Each already had a bottom-table row, so the loss was in the bullet list and the
  headline alone. Recovered MECHANICALLY, by replaying every merge commit since
  #1009's and classifying on whether `git show --name-only` names a non-test file
  under `src/`, `worker/` or `supabase/`. The ≥ 5 threshold was crossed at #1043
  and nobody was told.

Four mutants planted against the new tests, four killed. Suite 49 passed (was 41).

**Deferred, not done: realigning `staging`.** A second live session held the
parent checkout throughout, mid-§4.8 drill with the staging worker stopped, and
a force-push to `staging` redeploys the full stack. `origin/staging` is still
`5358bd82` — 25 ahead of and 2 behind `main`, so `--ff-only` aborts and the
runbook's reset path applies.

---

## #1105 — an unmapped block reason raises its own operator signal (PR #1122, merged 2026-09-04)

Closes the blind spot #1079 left standing by construction. With
`REFUSAL_LEDGER_ENABLED` off, guard 4 returns before `resolvePolicyGateRefusal`
can throw — correct, and unchanged. The cost was that an **unmapped** block
reason then produced nothing at all: the resolver never ran, and
`wouldRecordRefusal` is `every(mapped && non-null)`, so an unmapped member made
it false too. An operator could not tell a deliberately-off ledger from a broken
category map behind one.

`unmappedBlockReasons` (private, `persist.ts`, beside `wouldRecordRefusal`)
filters with `Object.hasOwn`; `noteUnmappedBlockReasons` (`write.ts`) is a pure
transport — one structured log line plus a Sentry event at `error`, tagged
`fault=unmapped_block_reason`, CONSTANT message with the codes in `extra`,
latched per code and bounded at `UNMAPPED_SIGNAL_CAP` with one overflow marker.
Two production files, ~76 executable lines. No schema, no dependency, no module.

**Four adversarial passes, 33 findings, and the code was never the weak part.**
Every P0 was a test or a document:

- The unfiltered argument survived **59/59** — every lane case fed an
  all-unmapped set, where filtered and unfiltered are the same array.
- **The `UNMAPPED_SIGNAL_CAP` bound did not exist.** Four documents asserted it;
  the code tested the Set's size and then added every code. The
  correctly-bounded mutant survived **31/31**, because every emission path reads
  that size through a value that saturates at the cap.
- **An assertion that passed on the clock**: `toContain(String(cap))` with
  `cap = 8`, satisfied by the ISO timestamp. The mutant died at 07:37 and
  survived at 08:07.
- Alert rules 7 and 8 paired a CONSTANT capture title with a first-seen trigger,
  which would have made the per-code signal invisible after its first fire.

Two locked intake decisions were reversed by findings, on owner sign-off: the
process-wide latch became per-code and bounded, and the dynamic Sentry message
became a constant.

**Seven false self-claims shipped and caught**, one more than #1082 — including
the twin-mention failure committed inside the fix for a finding about twin
mentions. Lessons in `.claude/reference/lab-notes.md` (2026-09-04).

**Accepted risk, owner-authorized:** V-F3. Its blocking sites were fixed and
verified; the third twin and the new §4 acceptance drill that followed were not.
Residual risk is a stale count in one runbook section, not behaviour.

**Merge order:** landed before PR #1121, which must renumber its own `rule 7`.

**Deferred, not done: realigning `staging`.** `origin/staging` is 54 ahead of
and 1 behind `main`, so `--ff-only` aborts and the runbook's reset path applies —
but those 54 carry PR #1121's in-flight ride, and a force-push would destroy that
branch's staging deployment while it is still open. Owner decision pending.

---

## #1083 — Ledger attribution moves onto the writer's side of the seam (PR #1129, 2026-09-04)

Five of the seven **Refusal** lanes surfaced a ledger fault to Sentry as an
ordinary job failure. #1079 had fixed two by wrapping their CALL SITES, and the
ticket proposed extending that to the remaining seven. **This did the opposite.**

A fault in `INSERT INTO refusal_events` is a property of *that statement*, and
`write.ts` is its only owner (#1001). While attribution was a caller's job it sat
on the far side of a seam that already existed — which is exactly why five lanes
omitted it and nothing stopped a sixth. The deletion test settles it: remove
`withLedgerAttribution` and the write-fault half reappears nowhere, the
resolve-fault half at exactly one call site.

So `captureLedgerWriteFault` (module-private, both write arms) takes the write
fault — **zero new interface members, zero new parameters, all seven lanes by
construction, and not one lane file edited**. `persist.ts` gives up work rather
than taking it on: its `held_draft` wrapper deleted, the survivor narrowed to the
`policy_gate_held` resolve, its single-value `lane` parameter removed.

Not a behaviour change: every capture rethrows the **same error instance**. This
is the propagating side of "facts propagate, observations swallow", not an
exception to it. #1079's kill-switch containment intact.

**What review bought — two P0s, both the same underlying error.** An assertion
describing what the code does rather than what it must never do:

1. `refusal_codes: inputs.map(r => r.refusalCode).join(',')` — gate prose,
   unbounded, one per row — **survived 146/146 green**. The payload was asserted
   by PRESENCE, which cannot fail on an added key. Both arms now compare an exact
   sorted key list.
2. The write fault and the vocabulary fault were **byte-identical in every tag**
   on `policy_gate_held`, separated only by `extra` — which a Sentry alert rule
   cannot filter on. Both now carry `fault=ledger_write` /
   `fault=ledger_vocabulary`.

Also: the set arm carried no tenant identity, so a rolled-back write left an
operator "this lane failed for N rows" and nothing to join on — now
`{ row_count, account_id, account_count }`, answered with the account rather than
the batch, because a batch id needs a parameter and a parameter is something a
caller can omit.

**One rejected finding, owner decision**: no latch or cap on the capture. The
module's two existing latches stop unbounded issue-GROUP scattering — their keys
are distinct codes. This capture has one exception shape across seven bounded
lanes, so Sentry groups it into a single counted issue, and a latch would hide
whether an `error`-level write fault is still happening mid-incident.

**A rationale nobody multiplied out**: `refusal_lanes` was duplicated into
`extra` on the grounds that a Sentry tag truncates at 200 characters. All seven
lanes joined is **108**. It reached a LOCKED `CONTEXT.md` entry, a docblock, a
test comment and the plan before three review axes caught it independently.

Evidence: 17 eval titles (12/5) · plan gate 3 Codex rounds → APPROVED · review
wave 4 axes, 25 findings, 24 fixed · red team 2 rounds, 45 mutations, 29 killed,
**CLEAR** · live-DB 39/39.

**The sidecar's `head_sha` was repointed four times** and each is disclosed
(D12, D13). `main` moved three times mid-ship; the production diff hashed
identically across every rebase (`65880ba7`), so red team's rounds describe
exactly this code. Round 3 is refused by hard cap, which is why the repoint
exists at all.

Follow-up: **#1127** — whether a ledger-attributed abort should short-circuit the
retry ladder instead of re-spending the LLM draft and the moderation call. The
`fault` tags added here are what make it answerable with data.

**Deferred, not done: realigning `staging`.** The ride merged at `55ed16e4`; the
re-sync waits on this PR merging, and `origin/staging` also carries other
branches' in-flight rides.

## 2026-09-05 — Restraint evidence fixes #1076/#1077/#1048 (local, pre-merge)

Owner approved persistent historical coverage disclosure, explicit archival
truncation disclosure, and narrow same-location outreach attribution.

- `RestraintReport.tsx`: retains a conditional historical policy-hold warning
  after automatic posting is on, with no fabricated activation timestamp.
- `src/lib/refusals/read.ts`: reads one sentinel beyond the 200 archival-event
  cap and returns `archivedPeriodsTruncated`; `RestraintContent.tsx` validates
  the required field. The report qualifies omitted periods and uncertain starts.
- `batch-builder.ts`: supplies `matchedReview` from retained, dated, non-deleted
  review evidence tied to prior outreach at this account/location. The existing
  policy precedence and atomic ask/run/refusal persistence remain authoritative.
- `GhostPipeline.tsx`: explains the retained-evidence scope rather than promising
  that all previous reviewers can be identified.
- Existing component, API, and live-database suites cover the cap boundary,
  omitted periods, malformed payloads, attribution evidence, tenant boundaries,
  deletion/date edge cases, precedence, and retry behavior.

Plan skeptic's accepted correction: provider soft deletion preserves the review
row and attribution FK, so use the existing `REVIEW_STATUS.DELETED` exclusion
as well as requiring an extant row. No new schema, dependency, environment
variable, or category is needed. `CONTEXT.md` records the precise scope.
This entry describes local work; verification results and unresolved browser
or review prerequisites belong to this branch's review record, not a ship claim.

## 2026-09-06 — Marketing pages rebalanced to the five jobs (local, pre-merge)

Owner asked for the landing, how-it-works, and features pages to stop reading
as a review-response tool and give even weight to responses, review requests
(Solicitor + Review QR), the analytics dashboard, the briefs, and the
agentic reputation-system positioning. Owner chose present tense for Solicitor
(committing to the production flag flip) and structural changes over copy-only.

- Landing: `src/components/sections/landing/jobs/` (JobsSection, jobs.css,
  jobs-copy.ts) — the five-jobs ledger; copy files revised; Solicitor
  `status: 'live'`; `PRODUCT_BLURB` and page metadata widened.
- Features: `FeatQr`, `FeatSolicitor`, `FeatDashboard`, `FeatRestraint` added;
  `FeatInsights` widened to weekly + monthly; chapters renumbered into five
  job groups; ribbon and index generalized to variable group sizes.
- How it works: `LOOPS` band + three FAQ entries; hero and lede reframed.
- Docs: PRODUCT.md "Shipped today" (Solicitor, Review QR, dashboard, briefs),
  BRAND-KIT §4/§6/§11/§14, CLAUDE-PROJECT-SETUP rule 1, landing DESIGN.md
  contracts + component entry, measurements.md file list, brand-story.md.
- Tests: FleetSection (no NEXT tag), new JobsSection test, FeaturesContent
  and HowItWorksContent assertions for the new chapters and band.

## 2026-09-06 — Landing section 5 became the route map

Owner asked for the "Where this is going" cards to become an interactive
illustrated roadmap in the spirit of an antique survey map: shipped work lit,
the forward roadmap (`docs/roadmap/2026-08-26-forward-roadmap.md`) dimmed.
Owner decisions: the two old cards absent from the roadmap (Social media, Fake
review disputes) ride as fog stops; Runway generates the ground and the
landmarks.

- `future/FutureSection.tsx`, `future.css`, `future-copy.ts` rewritten;
  `future-route.ts` added (Catmull-Rom road). Fifteen stops in three states,
  one `useInView` arming signal, `pathLength` draw-in, alternating label sides,
  glass detail card, phone trail ≤ 900px.
- Assets: chart ground + ten landmark cutouts (Runway nano-banana-pro against
  the agent stills; PIL flood-fill cutouts because the Runway cutter dropped
  every second object). `off-crt.jpg` deleted.
- Tests: new `FutureSection.test.tsx` (buttons, aria, one-open-at-a-time,
  tense/marker/ordering contract, route geometry); focus-ring row for
  `.rw-lp-future-stop`. Docs: DESIGN.md § Future + motion rows,
  measurements.md (four Future measurements + assets), `staged.tsx` comment.
- Verified in the browser at 1440 and 390 with Playwright: every stop accepts a
  hover at its centre, focus opens the card, no card open at rest.

Owner review on staging, same day (three rounds): (1) the chart was cramped
inside the 75rem column → it is full-bleed on a 20:9 stage; (2) the flat road
still read cramped → a serpentine (crest, trough, rise) with hand-chosen
label sides; (3) the ground looked low-resolution → `sizes="100vw"` (it had
said 75rem, so a 1920px chart fetched a ~1200px variant), the ground upscaled
2× and shipped at 3840px, `images.qualities` gains 88, landmarks served
`unoptimized`; and the ink gap before the closing band → the section drops
its bottom padding and the chart's fade is the hand-off.
Round four: every TV grew ~15%, and the unbuilt stops stopped naming their
features — each shows a short hint ("A second chance") and one teasing
future-tense sentence; the phase markers and the legend's "not available
yet" stay, and the stop-to-phase mapping lives in `future-copy.ts`.
Round five: clouds past the horizon (two screen-blended plates, drifting).
Rode `staging` throughout for owner review; merged to `main` via PR.
## 2026-09-06 — Admin MFA audit trail #468 (local, pre-merge)

- Migration 117 `admin_audit_log`: actor-keyed admin control-plane trail,
  deny-all RLS + client-role REVOKE, two indexes, no-action FK, keep forever.
- `writeAdminAuditLog` beside `writeAccountAuditLog` in `src/lib/audit/log.ts`.
- `factorStatusBefore` (pure, over `user.factors`) in `src/lib/auth/mfa.ts`.
- MFA challenge route: one memoised actor lookup; audit routed by role
  (admin / owner / unroutable → Sentry); `mfa_factor_enrolled` vs
  `mfa_challenge_succeeded`; `factor_status_before` on every verify payload.
- Tests: 11 new route cases (admin path, enrollment vs step-up, unroutable,
  best-effort), helper unit tests, and the read-only live suite for 117.
- Registries/docs: `REVIEWED_NOT_TENANT_SCOPED`, migrations-log (head 117 +
  retention row), rls-inventory, directory rows, MFA reset runbook § Audit.
- Plan reviewed by Codex (gpt-6-astra), 4 rounds → APPROVED; the review moved
  the factor lookup off the network and added the REVOKE + live suite.

## 2026-09-06 — Route map: the header becomes the map's title (local, pre-merge)

Owner rejected the seam between the dial section and the route map. The
section now has no padding from 1280px up: the chart starts at the section's
top edge, fades up from ink over a title band (top 36%), and the header —
eyebrow, heading, lead, closing quote, legend — sits over that band inside
the reading column. The stage grew to 2000×1440 so the road stays under the
title; below 1280px the header stacks above the chart as before.

## 2026-09-06 — Route map: the phone trail is an accordion (local, pre-merge)

Owner: "not optimized for the phone, it stretches for so long, not functional".
Below 900px each stop is one row (glyph, marker, name, chevron); a tap opens
the hint under it, one at a time. Touch handling fixed alongside: the hover
path ignores touch pointers, blur closes only when focus leaves the list, and
focus opens a row only when no pointer caused it. Section height at 390px:
~2,300px → ~1,500px.

## 2026-09-07 — `job_outbox` deny-all RLS, migration 119 (#1171, PR #1175, squash `7a1484a9`)

**The defect.** `job_outbox` was the only table of the 54 in schema `public`
whose `relrowsecurity` differed between the Supabase projects: production true,
staging **false**, zero policies on both, with `anon` and `authenticated`
holding all 8 privileges on both. RLS off plus `anon` INSERT is not a
disclosure bug alone — `OutboxPoller` dispatches whatever rows it finds without
asking who wrote them, so anyone holding the public staging anon key could
enqueue an Outbox job. `anon` also held TRUNCATE, which row policies do not
restrain.

**Provenance.** Migration 107's deferred half. Production (2026-04-05) shipped
with the Supabase `ensure_rls` DDL event trigger; staging (2026-05-30) was
provisioned after Supabase dropped it. 107 removed the generator and
deliberately left its past output for a reviewed migration of its own.

**Shipped.**

- `supabase/migrations/119_job_outbox_rls.sql` — one transaction:
  `SET LOCAL lock_timeout = '5s'`, a `DO` block issuing
  `ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY` **only when
  `relrowsecurity` is false**, `REVOKE ALL … FROM anon, authenticated`, a
  `COMMENT ON TABLE`.
- `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts` —
  the boundary's guard, five cases.
- `scripts/ci/live-db-suites-audit.ts` — the suite joins
  `MIGRATION_SHAPE_FILES`.
- No production TypeScript, no env var, no feature flag, no dependency.

**Why the ALTER is guarded.** `ATExecSetRowSecurity` has no early-out and
`AT_EnableRowSecurity` takes `ACCESS EXCLUSIVE`, so an unconditional statement
would block every write to the busiest table in the schema — on production, to
set a flag already set. `REVOKE` takes no relation lock. Measured: under a
concurrent `AccessShareLock` holder the guarded file completes in ~53–64 ms,
against ~5,070 ms to `lock_timeout` unconditional. On the production apply the
guard correctly skipped: its first real exercise.

**Why `BEGIN` + `SET LOCAL`.** `SET LOCAL` is effective, no session GUC leaks,
the lock window is minimal, and the ALTER and REVOKE become atomic. 109 and 114
are the precedent — 10 of the 11 `SET LOCAL` migrations wrap; 088 is the sole
unwrapped file and the only source of the "can only be used in transaction
blocks" warning that briefly misled the first draft.

**Applied, and lockstep proven by hash.** Staging 2026-09-07T11:42Z, production
2026-09-07T12:0xZ, byte-identical SQL, staging first, verified by introspection
and never the ledger. One identical query over all 54 `public` tables on each
project — `relname | relrowsecurity | relforcerowsecurity | relacl | policy
count`, ordered and md5'd — returns `3404cf07434a4d4ad9670f62ce573556` on
**both**; the `job_outbox` row alone hashes `40ec5814b6fcc41430af78ddf13d101a`
on both; the table comment is byte-identical (md5 `7b88d544…`, 228 bytes). On
both projects: `anon` + `authenticated` 16 privileges → **none**;
`service_role` 8 → 8 unchanged; owner 8 → 8 unchanged. Post-apply the OWNER read
rows WITH RLS enabled on both (46 staging, 4 production) — the direct proof that
RLS does not block the worker, which is the single assumption the migration
rests on.

**Registries: none change.** `job_outbox` stays `REVIEWED_NOT_TENANT_SCOPED` and
out of `TENANT_TABLES` (owner decision, taken after measurement).
`TENANT_TABLES` membership also switches on `ci:tenant-scope`, which demands an
`account_id`/`business_id` predicate on every binding; the table carries neither
column and 55 files under `src/` + `worker/` bind it in SQL. `ci:rls-audit`
therefore does not cover this table, and the suite is the guard.

**The review, which is the story of this branch.** Five independent red-team
passes plus four review axes returned findings across seven rounds. **Nine P0s
were found and every one was in the test, never in the migration** — which all
five passes independently confirmed correct.

| Pass | P0 | Root cause |
|---|---|---|
| 1 | owner-privilege arms unfalsifiable | the container owner is a superuser; `has_table_privilege` is a constant for one |
| 2 | `GRANT … TO PUBLIC` escaped | the ACL guard filtered on grantee NAME; PUBLIC is OID 0 |
| 3 | column grant to an inherited role escaped | the intersection two arms left open |
| 4 | three lexical evasions | `/**/`, `--` inside a string literal, comment-as-evidence |
| 5 | off-target DDL passed | the case read one table; `GRANT` on another sailed through |

Pass 4's verdict ended the pattern: *the approach is wrong, not merely
incomplete — a hand-rolled regex approximation of a SQL lexer keeps losing to
the next construct nobody enumerated.* The guard was rebuilt to **execute** the
migration: degrade `job_outbox` to the pre-119 posture, assert that vulnerable
state exists so the case cannot pass vacuously, apply the checked-in file
verbatim through `db.unsafe`, then assert RLS, force, policies, client
privileges, that the owner and `service_role` are **unchanged against the
before-reading**, and that **no other table in `public` moved**. Every vector
from all five passes is re-run and killed.

Four axes independently killed one false claim: that production had "run this
exact posture for five months". It had run the RLS half only and still held the
client grants, so the empirical argument never covered the REVOKE — the one
statement that could break the worker. The rollback plan was also wrong in a
way worth remembering: it would have run `DISABLE ROW LEVEL SECURITY` on
production, dropping it BELOW its own pre-119 baseline and manufacturing the
staging vulnerability there mid-incident. It is now per-environment.

**Workflow record.** Two surface amendments of two used, both with stated
reasons: `arch-review-log.md` (required by `ci:merge-ledger`) and
`live-db-suites-audit.ts` (the apply-and-assert rebuild). The `/feature`
`reviewed` transition was **not** set and was not forced — `red-team-status.mjs`
correctly refuses it, because each pass's fixes moved the tree past the sidecar
it was written against and the intake was amended twice. The five passes'
reports under `docs/reviews/red-team/1171-*/` and the four axis reports under
`docs/reviews/fix-1171-job-outbox-rls/` are the evidence instead. Full
deviation record: `docs/superpowers/plans/fix-1171-job-outbox-rls-deviations.md`
(D1–D21).

**Not done, tracked as #1176.** 21 production and 20 staging tables still carry
client-role grants behind deny-all RLS — including `auto_approval_policies` and
the agent run-spine tables — and `anon` holds TRUNCATE on **49 of 50** tables.
Inert today for the same reason production's `job_outbox` was inert, except for
TRUNCATE, which that argument does not cover. The issue also carries the
`rls-inventory.md` reconciliation and six sibling suites that repeat a
whitespace-literal guard weakness.

## 2026-09-10 — chosen marketing landing and final polish (local, pre-merge)

Final render follow-up: `hero/hero.css` now makes the hero copy immediately visible under reduced motion, even before hydration. The existing hook's transition update did not cancel an entrance already in progress. The source record is the 2026-09-10 frontend lab note; the final browser driver checks both pre-hydration and hydrated computed styles.

Implemented the owner-selected F3 narrative with F1's Working Atlas on the public landing route, preserving the original hero, CTA and footer. The selected composition and its defining details are recorded in [chosen-design.md](brand-asset-library/collections/2026-09-final/chosen-design.md), with the four-way design history and media provenance beside it.

The working tree's route supplies `FinalMiddle` F3 plus `FinalRoadmap` F1 to `LandingExperience`. Previous iterations added the chosen problem/fleet/agent/job/supervision sections and generated five job films plus lever/activity footage. Owner corrections fixed the watchdog arch's media containment, mapped Copilot left and Autopilot right, skipped Autopilot's stationary source lead-in, and rendered the roadmap's three chapter crops from the original 3840px image at 1.75× zoom.

The last refinement changes `final-iteration/final.css`, `synthesis/loop/index.tsx`, both synthesis media helpers, `footer/LandingFooter.tsx` and composition comments in `LandingExperience.tsx`. The mobile CRT index now sits below the curved frame with four 44px controls. The sticky screen fits short viewports; selection uses its measured bottom and responds to resizing. Headings balance, small supporting text is more readable, original media failures keep their stills, and the reduced-motion footer mask changes without interpolation. No extra visitor controls or dependencies were added.

Verification artifacts include the selected interaction/responsive reports, seven-section desktop and phone captures, and the new `verify-polish.mjs` / `polish-results.json` for all public navigation, keyboard agent controls, original media failure and a simulated lead-intake error/retry/success journey. The latter intercepts the request; it sends no real lead or email. Source checks and exact browser coverage are documented in the collection. Native Computer Use/WebKit are unavailable; Chromium results do not claim Safari coverage. This is a local implementation record, not a merge or production deployment. No feature flag, schema, backend behavior or architecture merge counter changed.

**Cleanup (same day, local).** The exploration code moved out of the tree. Deleted: the four `design-*` comparison routes; `sections/landing/{directions,exploration-v2,synthesis,final-iteration}/` (the agent's `design-loop/` notes included); the comparison-only assets in `public/landing-*`; and the superseded original middle sections with their helpers (`staged.tsx`, `carousel.tsx/.css`, `agent-flip-card.tsx/.css`, `future/future-route.ts`) and those helpers' tests. The selected sections now live in their own folders — `problem/`, `fleet/`, `personas/`, `jobs/`, `watchdogs/`, `tiers/`, `future/` — each with one stylesheet; `section-scopes.css` holds the two shared type scopes, and `LandingExperience.tsx` renders the sections without a `story` slot. The variant overrides (M1/L1/L2/F3) and the `final.css` refinements are folded into the base rules with the same result. Section media moved to `public/fleet/`, `public/jobs/` and `public/tiers/` (checksums unchanged); the lever files lost their reversed names. Evidence: a production build captured at eight viewports (360–1800px, reduced motion) before and after — all 128 scroll slices are pixel-identical, no request fails, and the only state-capture differences trace to film decoding and the removed `#final-roadmap` scroll margin (reapplying it reproduces the baseline exactly). The section tests were rewritten for the new components.

**Stale-code pass (same day).** A per-module import check and a CSS rule check against the live staging page found what the first cleanup orphaned. Removed: `fleet/fleet-copy.ts` and the pre-existing unused `reveal.tsx`; the `.rw-lp-glass` block and the unused `--rw-lp-section-gap` token in `landing-experience.css`; the old section headings and labels in five copy files; and the data fields no section reads (personas `publishes`/`status`, jobs `tone` with its `data-tone` attribute, the old map's stop coordinates and legend). Stale comments now match the page — including the pause rule's (no keyframe animation remains under `sections/landing/`). The landing DESIGN.md and measurements.md describe the current sections and assets; their dated notes stay as history.

## 2026-09-11 — retire legacy Security and Runbook (#1200)

After the owner's #1224 Page parity approval and Admin app PR #3 merge (`0104047b69aa774e1ebd8a4f70c6f4ef93d82fd2`), removed the two legacy pages, Security's client/tests, the runbook-only consent tests, their sidebar entries, palette pin, and inventory rows. Kept the unrelated past-replies empty-state check. Repaired Jobs' obsolete runbook link with the approved plain-text direction to the Admin app; no early `ADMIN_APP_URL` read. All API routes, shared MFA hooks, impersonation, and synthetic gate-audit fixtures are untouched. The owner accepted the port evidence limitations on #1224; this retirement adds no claim of Computer Use verification, which remains unavailable.
