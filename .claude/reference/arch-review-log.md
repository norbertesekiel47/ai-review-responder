# Architecture review log

Entropy counter for the `/feature` workflow (feature.md step 8): every merged
feature increments the counter. At **≥ 5 merges** since the last architecture
pass, the orchestrator reminds the user to schedule an architecture review
session (the user's call — never started automatically). A completed pass
resets the counter to 0 and adds a row below.

**Merges since last architecture pass: 6** — reset by the **2026-08-22 pass**
(entry below), then #891, #890, #913, #914, #908 and the #910 pull-forwards
counted 2026-08-23 (the #919 seedUpload consolidation, #942, is test-only and
does not count). Full artifacts: `docs/reviews/PATHFINDER-2026-08-22/`.
Prior passes: `PATHFINDER-2026-08-18/`, `-08-15/`, `-08-10/`.

> **Corrected 2026-08-23 from a stale 3.** The counter had missed four merges.
> Two were never counted at the time (#901, #905); two are the #917/#923 pair
> that landed on 2026-08-22 with no increment. The derivation below is written
> out so the next reader can check it instead of trusting it — **this is the
> FOURTH consecutive pass to find this counter wrong by its own rule**, after
> 2026-08-10 (3 missed increments), 2026-08-15 (PR #803 invisible) and
> 2026-08-18 (read 8, measured 11). *Corrected from "THIRD" by the 2026-08-22
> pass (P1): the log's own recurrence counter had the same defect as the thing
> it counts.* Issue **#896** is the mechanical fix; **its Part 1 has now
> landed** as `ci:merge-ledger`, so a merge that changes production or
> governance files and leaves no line here fails CI on the merging PR.
>
> **Rule applied:** a first-parent merge counts when it changes production code
> under `src/`, `worker/` or `supabase/`. Docs-only merges and post-merge sweeps
> do not count. A test-only merge does not count.
>
> | # | Squash | PR | Production files | Counted before? |
> |---|---|---|---|---|
> | 1 | `f6a83bc3` | #901 gate the **Attested postal address** surface on watch-mode | 4 | **no** |
> | 2 | `b873a9a5` | #904 / #898 send governors | 23 | yes |
> | 3 | `9e60617c` | #905 Daylight Gallery II marketing rebrand | 51 | **no** |
> | 4 | `2204e6a6` | #912 / #899 send worker | 18 | yes |
> | 5 | `a321634a` | #920 / #900 release poller | 15 | yes |
> | 6 | `1a8443ce` | #925 / #923 §7.1 refusal, ADR 0022 | 1 + 1 test | **no** |
> | 7 | `2c7bb615` | #926 / #917 `platform_halt`, migration 111 | 8 | **no** |
>
> Excluded and why: `d0cb96dc` (#911) changes test fixtures only; `2ee153b9`
> (#924), `c08fd695` (#928), `f439c9df` (#922), `7d24a7ee` (#921), `53bb0fcf`
> (#916), `8c90da00` (#906), `d3c9d113` (#903) and `9ca15202` (#902) change no
> production file. Sixteen first-parent commits in the window; seven count.
>
> **#905 is the entry that should worry a reader most.** It is 51 production
> files — the largest single merge in the window — and it left no row in this log
> at all. The counter's blind spot is not the small merges it rounds past; it is
> that nothing outside the `/feature` workflow's step 8 ever increments it, so
> any merge that does not run that workflow is invisible by construction.

- **chore #910 pull-forwards** — B3.1 + B3.7 + B3.10 (2026-08-23). B3.1: the
  `HealthFinding` inversion fixed — the interface moved to the zero-import leaf
  `src/lib/shared/health-finding.ts`, so `send-breaker.ts` no longer type-imports
  from the worker tree (the `checkSolicitationSendBreaker` wrapper KEPT deliberately:
  it carries the poller-side contract docs, and the inversion, not the wrapper, was
  the defect). B3.10: `formatRate` twin closed — one owner in
  `src/lib/shared/format-rate.ts` (zero imports, so the client build stays legal),
  both `send-breaker.ts` Sentry titles and `SendBreakerClient.tsx` read it. B3.7:
  the reciprocal deliberate-mirror pointer added at `DEFAULT_DAILY_AUTO_POST_CAP`.
  Full eight-item disposition posted on #910. **Counts: +1 production merge.**
- **perf #908** — Breaker window read model made index-servable (2026-08-23;
  migration 112, applied staging + prod in lockstep, both verified via `pg_indexes`).
  Two partial indexes (`bounced_at`, `complained_at` WHERE NOT NULL); measured on PG 16
  at 1M rows / 35k window: seq scan 28,577 buffers 120.5 ms → BitmapOr 1,139 buffers
  14.2 ms (8.5×), query unrestructured. Corrects migration 110's wrong bitmap-scan
  comment (recorded in 112's header + the feat-898 deviations file — 110 is immutable).
  **Counts: +1 production merge.**
- **feat #914** — Send handoff withholds a location with no canonical place id
  (2026-08-23). `sendHandoffWithheldReason` gains `google_place_id_missing` (NULL or
  a migration-007 hex CID, validated by `isPlaceId`); precedence postal → place id →
  bounce; the batch-builder SELECT widens by one column; `dispatchOutreach`'s throw
  stays as the assertion of an impossible state. No migration — the reason reaches
  only the worker log, like its two siblings. **Counts: +1 production merge.**
- **refactor #913** — provider-agnostic error vocabulary relocated (2026-08-23).
  `RETRYABLE_NETWORK_ERROR_CODES` + `errorStringProperty`/`errorNumberProperty` moved
  from `payments/stripe-error-inspect.ts` to a new zero-import leaf
  `src/lib/shared/error-inspect.ts` — seven importers, four of them non-Stripe
  (solicitation `send-retry`, `import-consent`, `db/transient-error`, `worker/index`).
  Stripe TYPE sets and the coupon classifier stay in payments. Byte-identical move,
  no behaviour change. **Counts: +1 production merge.**
- **feat #890** — the three named delivery-status owners (2026-08-23). The 2026-08-18
  pass's H1, corrected 2026-08-23 from one constant to THREE: `CONTEXT.md:75`'s own
  third-caller trigger had fired (six live spellings of the cancellable set, plus the
  LIVE set and the failed-hook's ARRIVAL set answering different questions). New
  dependency-free leaf `src/lib/solicitation/delivery-status.ts`; five TS call sites
  rewired (`classifyWithdrawal`, `isWithdrawableState`, `useArmedWithdrawal`,
  `AskList`'s gate, `HaltableState`, `isTerminalizableArrival`); the three SQL sites
  stay byte-identical (query-shape pins), now mechanically tied to the constants by
  `delivery-status.test.ts`. **Counts: +1 production merge.**
- **fix #891** — `batchDidClose` positive close predicate (2026-08-23). The 2026-08-18
  pass's H2, corrected 2026-08-23: `!== 'not_settled'` was a wrong proxy carrying a live
  wire defect (`no_send_parent` reported `closed: true` with nothing written). One
  positive enumeration in `outreach.ts`; three routes rewired; the release backstop
  tally deliberately keeps `=== 'closed'` (events, not receipts) with a pointer comment;
  `ApprovalPanel.tsx`'s false verbs-comment corrected. Exhaustiveness-pinned unit suite +
  three route-level `no_send_parent → closed:false` pins. **Counts: +1 production merge.**
- **PR #935** — #896 part 1, `ci:merge-ledger` (2026-08-23). The audit this very row
  satisfies: a PR whose diff changes a non-test file under `src/`/`worker/`/`supabase/`,
  or any path on the governance surface, must add a line here or fail CI on the merging
  PR. **No migration, no flag, no env var, no new dependency.** One script
  (`scripts/ci/merge-ledger-audit.ts`) + 44 unit cases, wired into `package.json`,
  `ci.yml`'s `lint` job and `lefthook.yml`; Dependabot is exempted at the workflow level
  because `package.json` is on the surface and no bot can author a row.
  **Does NOT increment the counter** — it changes no production file, and the audit
  deliberately never touches that number: which merges "count" is the pass's judgement,
  and an audit asserting it on every PR would assert it on the docs-only merges the rule
  excludes. What it enforces is the TRACE.

- **2026-08-22 architecture pass** — windowed on the 17 merges after `54e4d374`
  (7 counting, **77 production files**). 8 features charted, **12 mutations
  executed**, counter reset 7 → 0. Artifacts:
  `docs/reviews/PATHFINDER-2026-08-22/`.

  **Health held for a fifth pass**: 77 B, duplication 1.1%, high-complexity
  functions 122 → 119, churn hotspots 0, LOC +4.3% without added tangle. The one
  metric moving the wrong way is large functions (449 → 463) against
  maintainability 92.2 → 92.1.

  **What it found that the code did not already know.** (1) The send lane's
  *decision* logic is well pinned and its **concurrency and integrity spine is
  not**: the A4 bytes-identity check and BOTH send-path CAS predicates survived
  deletion with the whole lane green, and a whole-repo grep of `src` + `worker`
  returned zero test-file references for `bytes_changed_under_gate`, `cas_lost`
  and `in_flight_elsewhere`. All three failure modes are silent — moderating one
  artifact and sending another, a value-ledger row with no join key behind it,
  and a double send. The pass's own priority hypothesis (guard 5,
  `readSendBreaker`'s fail-closed throw) was **refuted**: it is pinned three
  ways. (2) **X18 — `canonicalBatchId`'s bug is reproduced.**
  `settleGenerationExhaustion` binds one batch id cast-and-case-insensitive and
  raw-TEXT inside ONE transaction, so it locks the batch and misses its send
  parent; the canonicaliser exists precisely because this already shipped once
  in `approval.ts`. (3) **P1 — the counter was wrong for the FOURTH consecutive
  pass**, and this log's own recurrence line said THIRD. (4) **`!== 'not_settled'`
  is a wrong proxy**: halting an all-withheld `built` batch makes both halt routes
  report `closed: true` against `send_closed_at IS NULL`, because
  `'no_send_parent' !== 'not_settled'` is true and that arm is reachable through
  `haltBatch` → `latchHalt`, which passes no failure. (5) **`ci:admin-aal2`'s P2
  parity misses `/admin/solicitation`** — it anchors on a sibling route that does
  not exist for that page, so flipping the page's `aal2` off would pass CI while
  the API route stays gated, and that page reads `solicitation_send_breaker`
  directly via `sql`. (6) **`ci:rls-audit` guards no platform-scoped table** —
  `REQUIRED_RLS_TABLES = TENANT_TABLES`, so neither `solicitation_send_breaker`
  nor four older tables are covered.

  **Two claims in this log were measured wrong.** The **#920 entry below still
  says *"+4 platform-wide predicates under a standing sign-off"*, and that is
  false**: the move is **381 → 383 (#904) → 390 (#920)**, split across two
  merges, seven of them from #920, and all seven are `background-global-scan` —
  only #904's two are `platform-cross-account`. The allowlist's own header
  narrative records all nine correctly; **this log is the artefact at fault.**
  Second: **`#895(b)` was delivered by #920** and `approval.ts:518-524` cites the
  issue by number, while the issue stayed open — the tracker and the source
  disagree about whether it is done.

  **X10 graduated from pattern to rule** — an enumeration that defines a guard's
  SUBJECT SET must be derived from the artefact that produces subjects; an
  enumeration listing only EXEMPTIONS inside a derived scan is legitimate. Seven
  silent instances against ten-plus loud ones, plus one (`SQL_TAG_NAMES`) that
  made the transition in-repo. Phase 2 amended it: apply the classifier to a
  guard's **discriminator and its transitive inputs**, which found two more.

  **The backlog is ONE ranked list of 15 items** (the seven re-verified
  2026-08-18 handoffs merged with this pass's findings, ranked on expected cost
  of not doing it before the next window). Top three: **H8** the three
  send-path integrity tests, **#896** `ci:merge-ledger` + the Stop-hook
  sentinel — the only item that changes the *rate* at which everything else
  accumulates — and **H9** `canonicalBatchId` at `ask-generation.ts`'s two
  entry points.

  **What the next pass should look at.** (a) Whether the three send-path
  integrity tests still go RED under their own mutations — #932 pinned them, and
  a later refactor can silently unpin them again. (b) **`ci:fallow:coverage` has
  no unit-size axis**: `line_count` never appears in any finding's `exceeded`
  field, so a 202-line flat orchestrator with high coverage is invisible to the
  PR gate in any file, forever. (c) Whether `#896`'s ledger actually changed the
  counter's accuracy — three hand-corrections of a hand-kept number is not a
  process that has converged, and this entry is the first one written under it.
  (d) The four false `docs/directory.md` rows, and whether H11's split of
  `readSendBreaker` retired two of them structurally rather than by prose.

  *This entry was re-derived from the pass's artifacts on 2026-08-23 after the
  original local edit was lost before it was committed. The four blocks above
  marked with the #920 correction, X10's rule, findings (4)-(6) and the
  next-pass list were restored from the original text on the same day. The artifacts under
  `docs/reviews/PATHFINDER-2026-08-22/` are authoritative wherever they and this
  summary disagree.*

- **PR #926** — #917 `platform_halt`, the third system **Halt latch** reason (2026-08-22, squash
  `2c7bb615`). **Migration 111** — two CHECK widenings, no data change, applied to staging and
  production and confirmed by introspection 2026-08-23 (three-database hash
  `00cb1b60044b44c408553999433ee2d2`). **No new dependency, no new flag, no new env var.**
  Closes amendment B14's gap by taking its SECOND option: the expiry sweep still runs on the same
  72h clock and the "≤10 days by construction" bound is untouched — only the reason column
  changes. **New single owner:** `resolveWindowHaltReason` decides once per tick which of two
  reasons the sweep writes. **The one architectural fact worth carrying forward:** it introduces
  the FIRST sanctioned `try/catch` around `readSendBreaker`, whose own docstring forbids exactly
  that. The carve-out holds because the operative half of that contract is "and proceeds to send",
  and this read only picks a label — the sending gate in the release phase keeps its throw. That
  is a narrow exception resting on a distinction a future reader can easily miss, so
  `CONTEXT.md`'s **Halt latch** entry and the amendments doc both name it. **What the next pass
  should look at:** whether "label-only read" becomes a pattern with a second instance, at which
  point the distinction needs a mechanical guard rather than three prose statements.
- **PR #925** — #923 the §7.1 refusal, recorded not implemented (2026-08-22, squash `1a8443ce`).
  **No migration, no dependency, no flag.** One production file changed, and only its docstring:
  the substance is **ADR 0022** plus `dispatch-rate-bound.test.ts`, which pins four dials and
  re-derives the solicitation lane's share of Resend's 10 req/s TEAM limit rather than storing it.
  **This is the log's first entry for a merge whose product is a decision**, which is why it
  counts: it spends a spec obligation deliberately and leaves a tripwire so the spending is
  visible. **Known bound, recorded honestly:** the exact-value pin (`toBe(2)`) is the real guard;
  the 1% share ceiling only bites at a per-tick budget of 7 or more, so budgets 3–6 pass the
  arithmetic and are caught by the pin alone.
- **PR #920** — #900 Solicitation release poller (2026-08-23, squash `a321634a`). **No migration**
  (091 and 110 carried every column, CHECK member and index), **no new dependency**, **no flag
  added**. **New env var:** `SOLICITATION_RELEASE_POLL_INTERVAL_MS` (optional, 60s default, one
  extra rejection over its `JUDGE_POLL_INTERVAL_MS` precedent — a value at or below the 45s cycle
  timeout is invalid). **This merge discharges #915's blocker**, not #915 itself: the `unknown`
  sweep now frees a location's one-active-send slot, and `SOLICITATION_SEND_ENABLED` still must
  not be flipped without a separate decision.
  **New single owners:** `runReleaseCycle` for the five-phase order; `latchSystemHalt` as the
  Halt latch's third and actor-less arm (091's halt-consistency CHECK makes that structural);
  `sweepSystemHalt` for both clock-driven sweeps; `capacityStop` for the three capacity gates.
  `closeBatchIfSettled` gained a SECOND caller and deliberately no second implementation.
  **Allowlist baselines moved:** `STEP_PERSONA` (+`approval_downgraded`), `tenant-scope-allowlist`
  (+4 platform-wide predicates under a standing sign-off), `outcome-anchor-pairing.test.ts`
  (a fifth spine caller). **The `reclassify` gate fired at 2.1x its line estimate** and the owner
  chose to proceed as one PR; the branch shipped at 2,302 production lines against an 820 estimate.
  **What the next pass should look at:** (a) the four-registry pattern this feature hit — the
  2026-08-18 pass's X10 "scope is an ENUMERATION" meta-class now has its fifth and sixth
  instances, and #900 needed THREE intake amendments to discover them, which is a planning
  defect the counter cannot see; (b) **the `fallow` PR gate has no local counterpart in the
  feature workflow** — `verify-gate.sh` runs 28 checks and not that one, so #900's decomposition
  (`runReleasePhase` 205 → 135 lines, two clone groups removed) happened AFTER three review
  rounds, against code the reviewers had signed off; (c) `release.ts` shipped at 1,739 lines with
  a single export, a shape the standards reviewer examined and explicitly declined to flag —
  worth re-testing now that it has a second reader; (d) the false-rationale class, promoted to
  lab-notes this merge with EIGHT instances, all of them claims about a module's own internals.

- **PR #912** — #899 Solicitation send worker (2026-08-22, squash `2204e6a6`). **No migration**
  (110 carried it), **no new env var**, **no new dependency**, **no flag added** — but
  `SOLICITATION_SEND_ENABLED` changed meaning: from this merge it genuinely sends, and issue
  **#915** records that it must not be flipped until #900's `unknown` sweep ships.
  **New single owners:** `applyDispatchGate` for amendment B6's order and the withheld-reason
  mapping; `classifySendFailure` for D12c; `lintInputFromSnapshot` for which stored values feed
  the lint (previously derived from live data inside `ask-generation.ts`, which quietly broke the
  byte-for-byte **Owner approval** contract at dispatch). **First production caller** of the
  `getMessagingAdapter()` seam — exercised without widening it by one field, which is the
  evidence map decision 14's narrowness condition held. **Allowlist baselines moved:**
  `outcome-anchor-pairing.test.ts` gained two non-review-subject spine callers (the third and
  fourth solicitation modules to need it).
  **What the next pass should look at:** (a) that allowlist is now a four-entry enumeration with
  a hand-written lock analysis per entry — the same "scope is an ENUMERATION" meta-class the
  2026-08-18 pass logged as X10, now with a fourth instance; (b) `dispatch.ts` is 2,001 lines and
  `runDispatchTx`/`commitSendTerminal` are the two functions that grew fastest under review
  pressure; (c) `completeOutboxNoop` is deliberately duplicated between the generation and
  dispatch lanes with `src/lib/shared/outbox.ts` named as its real owner — a third copy is the
  signal to hoist; (d) whether #900 landing makes the `in_flight_elsewhere` resume path's three
  detectors collapse to one.

Incremented to 2 by **#912** (#899 solicitation send worker, 2026-08-22) — below the
≥ 5 threshold, so no pass is due. **#911** merged the same day and is deliberately NOT
counted: it changed two test fixtures and zero production lines, and this log's own
window measure is "first-parent commits **with production lines**". Recorded here rather
than left implicit, because the 2026-08-18 pass's headline finding was that the counter
had been wrong by its own rule and nobody had checked.

**That pass measured the counter itself and found it wrong by its own rule.** The
window held **32 first-parent commits, 11 with production lines**; the counter read
**8**. #857, #866 and #875 got no post-merge sweep at all, and **nine further merges
rewrote the enforcement surface with zero trace in this file** — including #849,
which deleted `.github/workflows/fallow.yml` and rewrote `ci-audit-wiring.test.ts`,
the test that exists to stop that drift. The 2026-08-15 pass framed PR #803 as an
anomaly; it is the norm. Handoff **H7** proposes the fix (`ci:merge-ledger`, two
triggers, run on the MERGING PR because "the sweep did not run" is the failure mode).

Superseded counter text, retained for the record: the pre-pass line read *"8 — PAST
THE ≥ 5 THRESHOLD"*, with a caveat that #857 and #866 might make it 10. The measured
figure is 11. Reset by
the **2026-08-15 pass**
(table row below). Full artifacts: `docs/reviews/PATHFINDER-2026-08-15/`. The
window's merge list, retained for the record: #793, #805, #821, #827, #831, #833
(entries below). **Not counted, and correctly so** — #830 (marketing copy),
#822/#819/#817 (docs). **Logged by that pass as a workflow-surface change the
product counter is structurally blind to: PR #803** (`0e1a5d41`, *"chore:
optimize Codex agent configuration"*) rewrote `.agents/skills/feature/SKILL.md`
from 667 to 207 lines and **deleted step 8 outright** — the surface three
separate architecture-pass prescriptions were aimed at. See
`docs/reviews/PATHFINDER-2026-08-15/05-process-findings.md` §3.

**Handoff-execution PRs are NOT counted (policy, made explicit 2026-08-16).**
The six PRs that executed this pass's handoffs — **#836** (H1), **#837** (H3),
**#840** (H6), **#838** (H2), **#839** (H4), **#841** (H5), merged in that order —
do not increment the counter. A pass's own prescriptions landing cannot be the
entropy that triggers the next pass, or every pass becomes self-triggering; and
these PRs are net entropy-negative by construction (owners consolidated, guards
pinned, one audit hardened). This was already the practice — the 2026-08-10
pass's #785/#787/#788/#815/#816 were likewise never counted — but it was never
written down. It applies **only** to PRs whose entire content is a recorded
handoff from `04-handoff-prompts.md`; a handoff PR that grows unrelated scope
counts as a normal merge. Landing record: `docs/reviews/PATHFINDER-2026-08-15/`
+ each PR body.

- **PR #904** — #898 **Send governors**: the schema and three governors #899/#900
  stand on (2026-08-21, squash `b873a9a5`). **Architecturally: one migration, one
  new TABLE, two new `src/lib/solicitation/` modules, one new admin page + two
  routes, one new `HealthAlertPoller` check — no new dependency, no new env var,
  no new flag, no new top-level directory.** Migration **110** was applied to
  staging **and** production in lockstep on merge day (all three databases
  byte-identical, `3e644c28…`), so it leaves **no standing exception** — the prod
  exception list still names only 078.

  What it adds to the map: **`solicitation_send_breaker` is the first
  platform-scoped table with no `account_id`** — deliberately not a
  `TENANT_TABLES` member and not in `TABLE_DISPOSITIONS`, carrying deny-all RLS
  instead, because the event it records is platform-wide and `account_audit_log`
  is account-scoped. **That table IS its own audit record.** Also: `checks.ts`
  gains its **first WRITER** (every other check reads), isolated in its own
  try/catch so a constraint violation or lock wait cannot discard the nine
  findings collected before it. Three new LOCKED CONTEXT.md terms (**Send
  breaker**, **Send breaker trip**, **Breaker window**), and the **Solicitation
  lane**'s declared write surface widened by exactly one column (`bounce_kind`).

  **What the next pass should look at.** (1) **`ci:admin-aal2` vs `fallow` are in
  direct tension over the admin-route preamble** — this branch built the
  extraction, failed the AAL2 audit on all three routes, and reverted; follow-up
  **B3.11** carries the extraction plus the gate-shape change together, and that
  is an architecture decision, not a lint fix. (2) **Three governors ship with no
  consumer** — the breaker trips and pages but nothing reads it on the send path
  until #900, so the whole surface is inert-by-construction and its first real
  exercise is someone else's branch. (3) **`readBreakerWindow` still seq-scans**
  (follow-up B3.8); 110's `sent_at` index cannot serve an OR-of-three, and the
  migration's own comment claiming a bitmap scan is wrong — 110 is immutable and
  at head, so the correction lives in the deviations file. (4) **B3.9**: the
  level-triggered re-page rides a first-seen Sentry rule, so a multi-day halt
  notifies twice then goes quiet — the alerting half of "an open breaker is a
  STATE" is not actually delivered yet. (5) The **11 follow-ups B3.1–B3.11** are
  the largest single-branch backlog this log has recorded; worth asking whether
  that is healthy decomposition or deferred debt.

- **PR #883** — #872 **Ask withdrawal**: the owner's post-approval recourse at
  ask granularity (2026-08-18, squash `094d71b9`). **Architecturally: one
  migration, one new verb, one new route, one new sibling component — no new
  concept, no new dependency, no new env var or flag, no new top-level
  directory.** Migration **109** widens 108's cancel arm by `owner_withdrawn`
  and was applied to staging **and production** in lockstep on merge day (all
  three databases verified byte-identical), so it leaves **no standing
  exception** — the prod exception list still names only 078. What it adds to
  the map: `withdrawAsk` becomes the **fifth** human-triggered verb in
  `src/lib/solicitation/approval.ts`, and the ADR-0021 decision that it does
  **not** share #865's private `latchHalt` (the latch writes `halted_at` on the
  batch; withdrawal writes nothing there) — same discipline, separate body, with
  a duplicated `delivery_status IN ('rendered','queued')` predicate now in two
  places. **That duplication is the thing for the next pass to look at**: the
  Codex adversarial review flagged it as a drift watch rather than a defect,
  and a third caller would make it a real seam question. Two other standing
  items for the next pass, both recorded with owner-visible reasoning rather
  than fixed here: (a) `ApprovalPanel.tsx` crossed **1,000 lines** (982 →
  1,109) and its pre-existing `── The write ──` section (~415 lines, now four
  lane writes) is the extraction candidate — deferred because the file was
  being edited by #865 concurrently and the new file fell outside the locked
  edit surface; **this is now unblocked and is the first follow-up to file**;
  (b) `WithdrawalDecision` parallels `WithdrawAskResult` by design (a pure,
  plan-locked decision type whose `withdraw` arm is deliberately data-free),
  kept after review. Baselines unmoved: tenant-scope 381, no allowlist entries
  added, `ci:directory-map` complete.

- **PR #882** — #665 purge-verifier blind spots + #662 suppressions-console
  receipt/actor (2026-08-18, squash `fe21d02d`). **Entropy-negative: it removed
  a detector blind spot and a false statement about an audit's reach, adding no
  concept.** No migration, env var, flag, dependency or new file; ~45 production
  lines across three files. **Counted** — it has production lines, which is the
  line #869's *not counted* entry actually draws, not the commit-type prefix
  (cf. `fix(858)`/#868, counted).
  **What changed architecturally.** `purge-verification.ts`'s `businesses`
  residue predicate went from 17 columns to 27 — the five migration-099 postal
  attestation columns the issue named, plus `category`, `tone`,
  `stripe_customer_id`, `stripe_subscription_id` and `archived_at`, which no
  issue had named. The read side now covers **every** column the tombstone
  `UPDATE` in `worker/jobs/account-offboarding/purge-stages.ts` writes. That
  write/read pair is now closed, and closing it is the point: the verifier runs
  *inside* the finalize transaction and **throws**, so it is a gate, not a
  report.
  **New shape worth a pass's attention.** Two predicates are not residue checks
  and read as exceptions to the branch's rule — `tone IS DISTINCT FROM` its
  schema default (the tombstone RESTORES rather than nulls) and
  `archived_at IS NULL` (the tombstone SETS it). A third kind of column in this
  branch would be the signal that the predicate list wants a declarative
  column→expectation table instead of one hand-maintained `OR` chain. It does
  not want one yet at 27.
  **Allowlist baseline unchanged at 381.** The
  `solicitation_suppression_corrections` entry's `sqlSnippet` was re-pinned only
  to stay byte-exact after `lookupSuppressions` gained a `LEFT JOIN users`.
  **Concept corrected, not added:** that entry's comment had claimed the `users`
  join was "structurally scoped and needs no exception". It is not — `users` is
  absent from `TENANT_TABLES`, so `ci:tenant-scope` forms no opinion and no
  exception is *possible*. **The next pass should treat this as a class, not an
  incident:** the audit is silent on every table outside `TENANT_TABLES`, and
  nothing distinguishes "reviewed and exempt" from "never in scope" at a call
  site. A reader who trusts a green audit as a review of a cross-tenant join
  will be wrong again somewhere else.
- **PR #876** — #865 admin **Halt latch** surface (2026-08-18, squash
  `9136d778`). **Entropy-negative where it matters: it gave a dead enum arm its
  writer without adding a concept.** `admin_halt` had been a permitted
  `halt_reason` CHECK member with no code path able to write it, and the
  owner-facing copy for it had already shipped — so this closed a gap rather
  than opening a surface. No migration, no env var, no feature flag, no
  dependency; every value already existed in migrations 091 and 108.
  **New single owner:** `latchHalt` in `src/lib/solicitation/approval.ts` — one
  private body for both halt arms (`haltBatch`, `adminHaltBatch`), owning the
  CAS, the cancellations, the audit row, the spine step and
  `closeBatchIfSettled` in that order. This is the shape the codebase already
  prefers (cf. `closeBatchIfSettled` itself) and it means a third halt writer
  (`send_window_elapsed`/`batch_expired`, still unbuilt, #630) has one obvious
  place to land. **Concept tightened, not added:** both halt verbs now refuse
  `pending`, closing an API-reachable lifecycle hole the intake had explicitly
  deferred — the deferral rested on UI reachability standing in for API
  reachability, which is a reasoning error worth watching for elsewhere.
  **New second read model** on `batch-view.ts` (`readAdminBatchSummary`) whose
  ordering deliberately diverges from `readLatestBatch`'s — two read models over
  one table with different selection policies is a real cost, and it is now
  documented in three places because two separate defects came from that
  divergence being implicit.
  **What the next pass should look at:** (a) `src/lib/solicitation/approval.ts`
  keeps growing — it now holds four public verbs plus the shared latch, and
  #872 will add another; ask whether the halt lane wants its own module.
  (b) The `useReducer` admin-form shape is now duplicated across FIVE admin
  surfaces (#880) — the abstraction is earned and the duplication is the kind a
  pass should force. (c) **Two workflow-infrastructure defects were found by
  this ship, not by the tooling itself** — `verify-gate.sh` racing
  `db-provision` (#877, and it clears on retry, so it self-conceals) and the
  staging deploy target drift (#878). Both are the "surface the product counter
  is structurally blind to" class this log already flagged for PR #803.
  (d) The staging ride caught two defects that three review agents and two
  live-DB suites all missed, because they existed only in the composition of
  write → refetch → render; that is evidence about the *review apparatus*, not
  about this branch.

- **PR #873** — #860 per-ask **Ask regeneration** surface (2026-08-18, squash
  `0f81b9e7`). **Entropy-negative in concept, entropy-positive in one file, and
  it makes a headline product guarantee unconditional.** No migration, env var,
  flag or dependency. Ships **INERT** — `SOLICITATION_SEND_ENABLED` is unset in
  every environment (verified on the Railway staging worker at merge), so the
  route 404s and no control renders; the staging verification was a NEGATIVE one.
  **Concept CLOSED:** #629's deviation D3. `regenerateAsk`'s four-state set
  collapses to the predicate `isRegenerableBatchState(state) => state === 'built'`
  (ADR **0020**, narrowing cross-spec amendment B2), so **Owner approval**'s
  byte-for-byte guarantee loses its conditional in `CONTEXT.md` and in code —
  enforced twice, at the pre-check and at the locked re-check under `FOR UPDATE`.
  **Concept COINED:** **Ask regeneration** (`CONTEXT.md`).
  **`approval.ts` gained a third owner verb** (`requestAskRegeneration`) and is
  now the module the next pass should weigh: three verbs, and the round-1 review
  asked directly whether it was becoming a junk drawer (verdict: still coherent).
  Its shared `lockBatchForAction` now returns `{batch, state}` and is the single
  owner of the lock+derive preamble — the three verbs keep DIFFERENT failure
  expressions on purpose (two return `not_found`, one THROWS, because postgres.js
  commits on a normal return and the enqueue has already written its outbox row).
  **ADR 0020 was amended by its own PR's review** — the Consequences section
  originally priced the post-approval recourse as "a real ergonomic cost"; the
  adversarial axis showed, and the owner verified, that halting never clears
  `solicitation_asks.status='send'`, so `MIN_GAP_DAYS` + `stale_visit` lose the
  whole cohort for that visit. The ADR now says its own pricing "was wrong". The
  cheaper recourse is **#872** (post-approval per-ask withdrawal), filed, not
  built.
  **What the next pass should look at:** (a) `ApprovalPanel.tsx` — ~980 lines,
  a 21-key copy catalogue over four unions; cognitive complexity was taken 16 → 10
  by four extractions, but the file-size question is untouched and was deliberately
  NOT bundled into a gate fix; (b) **`RequestsClient` sits at cognitive 15,
  exactly on fallow's threshold** — pre-existing, untouched, and the next hook or
  JSX conditional added there fails CI; (c) `LaneRefresh`'s naming altitude —
  `replace`/`in_place` name the PARENT's render mechanism and the tell is that
  `Exclude<LaneRefresh, 'none'>` has to exist; a verb-level vocabulary
  (`terminal`/`returns`/`reporting`) would need no `Exclude` (round-2 kept this
  below the findings bar as a rename with no wrong call site); (d) the
  three-axis review's own yield — the **adversarial axis caught a cross-tenant
  409-vs-404 oracle that the spec axis examined and CLEARED**, which is the
  strongest single datapoint this log has for keeping the third axis on
  RISK = high.
- **PR #870** — #859 `ci:tenant-scope` reads query blocks (2026-08-17, squash
  `649c43b5`). **Entropy-negative in production, entropy-positive in tooling,
  and it moves a security-gate baseline.** No migration, env var, flag or
  dependency. `scripts/ci/tenant-scope-audit.ts` rewritten 942 → 2,076 lines —
  a hand-rolled PostgreSQL lexer + query-block analyzer + JS template lexer in
  ONE file (the next pass should ask whether it wants a `scripts/ci/lib/`
  split: sql-lexer / js-lexer / analyzer). **New single owner:
  `TENANT_SCOPE_COLUMNS` in `scripts/ci/tenant-tables.ts`** — the per-table
  scope-column map, schema-asserted by a new read-only live-DB suite; the FIRST
  live-DB suite under `scripts/ci/__tests__/`. **`ALLOWLIST_BASELINE` 397 →
  381** (17 obsolete parser-limitation entries out, 1 honest admin entry in).
  **Deleted concept:** "the audit cannot see inside a subquery" — #629's D7
  workarounds in `approval.ts` and `batch-view.ts` reverted to natural SQL, and
  the trap stops shaping production query structure. **What the next pass
  should look at:** (a) the one-file size of the audit; (b) the 66 allowlist
  entries that are now statically provable but kept for their trust-boundary
  reasons — a candidate for a "provable" category or a pruning pass;
  (c) whether the analyzer's fail-closed boundaries (unqualified correlated
  columns, sibling-only correlation) are costing authors real allowlist churn.
- **PR #868** — #858 `closeBatchIfSettled` canonicalises its batch id
  (2026-08-17, squash `d9ea8801`). **Entropy-neutral, seam-strengthening.** No
  migration, env var, flag or dependency; +8 production lines. Closes the
  per-caller-fix seam #863's entry flagged as "under strain": the single owner
  of Settled-batch closure now defends itself against a TEXT `subject_id`
  compare, so #630's releaser tick joins as a third caller with no
  canonicalisation obligation. Entry-point canonicalisation in `approval.ts`
  stays (defence in depth, not duplication).
- *Not counted:* **PR #869** (#861, test-only, zero production lines) — same
  policy as docs/marketing PRs.

  > **Counter caveat carried forward:** **PR #866** (#652, `redeemUnsubscribeToken`
  > owns its transaction) merged 2026-08-17 with **no entry here** either, so the
  > count now excludes TWO production merges (#857, #866). If both should have
  > counted, the true figure is **6**, past the ≥ 5 threshold. Surfaced for the
  > owner; not back-filled by this sweep.

- **PR #863** — #629 owner approval lane (2026-08-17, squash `71b1bd88`).
  **Moderate entropy, and it CLOSES more concept than it opens.** Migration
  **108** (widens 091's `solicitation_outreach_status_reason_consistency` cancel
  set by one member, `owner_excluded`) — applied to staging and production in
  lockstep the same day. No env var, no flag, no dependency; net **+2,474
  production lines**, tests ~4× that — a DB-contract feature in the #643 band,
  which is what fired `reclassify` (D14).
  **New single owner: `src/lib/solicitation/approval.ts`** — `approveBatch` and
  `haltBatch`, the owner arm of the **Halt latch**. It deliberately does NOT own
  batch terminalization: both verbs call the existing `closeBatchIfSettled` in
  `outreach.ts`, so the **Settled batch** join keeps one owner and #630's
  releaser tick becomes a third caller of the same function rather than a
  parallel implementation. **New route seam** `_shared/scoped-batch-route.ts`
  collapses three batch routes onto one runner.
  **What the next pass should look at:** (a) **#858** — `closeBatchIfSettled`'s
  case-sensitive `subject_id` compare, fixed here for two verbs only; a
  single-owner function with a per-caller correctness fix is a seam under
  strain, and #630 adds the third caller. (b) **#859** — `ci:tenant-scope`
  subquery blindness forced SQL reshaping in BOTH `approval.ts` and
  `batch-view.ts` (D7); the audit is now shaping production query structure,
  which is the tail wagging the dog, and fixing it moves `ALLOWLIST_BASELINE`.
  (c) The send lane now spans `approval.ts`, `outreach.ts`, `batch-view.ts`,
  `batch-builder.ts` and `ask-generation.ts` with #630 still to land — worth
  asking whether `src/lib/solicitation/` wants sub-structure before, not after.
  (d) `admin_halt` remains a CHECK member with **no writer** — a live-but-dead
  enum arm, still unfiled. **RESOLVED: filed as #865, shipped in PR #876
  (2026-08-18); `latchHalt` + `adminHaltBatch` are its writer.**

  > **Counter caveat, surfaced rather than absorbed:** **PR #857** (#651
  > unsubscribe redemption pool) merged 2026-08-17 and has **no entry here**, so
  > the count below excludes it. If that was an omission rather than a policy
  > call, the true figure is **3**, not 2. Flagged for the owner; not
  > back-filled by this sweep, which has no standing to write another feature's
  > architectural summary.

- **PR #853** — #657 Messaging adapter seam + solicitation Sending identity +
  Resend **Solicitation lane** (2026-08-17, squash `ad185edb`). **Entropy-positive
  and knowingly so: a new top-level seam with ZERO production callers.** No
  migration, no dependency; net **+976/−76 production lines**, tests **+2377**
  (2.4× production — a DB-contract feature, the #643 band).
  **New folder `src/lib/messaging/`** — three files: `messaging-adapter.ts` (the
  one-method `MessagingAdapter` interface + `getMessagingAdapter()` lazy
  singleton), `email-adapter.ts` (`EmailAdapter`, the whole §7.1 envelope), and
  `lane-tag.ts` (the `lane`/`solicitation` discriminant, **import-free by design**
  so the webhook ingress does not transitively load the Resend SDK). Mirrors
  `src/lib/publishing/review-publisher.ts`. **This is a hypothetical seam** (map
  decision 14) — #630's dispatch worker is its first caller. *The next pass should
  ask whether that caller arrived, and if not, whether the seam earned its keep.*
  **New folder `worker/ingress/resend/`** — `bounce-classifier.ts` (moved
  byte-for-byte out of `resend.ts` to break an import cycle; the three functions
  keep ONE owner of "what counts as permanent") and `solicitation-lane.ts` (the
  tag-discriminated lane, one transaction owner via `withAttribution`).
  **Three new env vars**, all server-only and fail-closed:
  `SOLICITATION_RESEND_API_KEY`, `SOLICITATION_SEND_FROM_ADDRESS`,
  `SOLICITATION_PLATFORM_DAILY_CAP`, boot-asserted by
  `assertSolicitationSendEnv()`. **No new feature flag** — the lane deliberately
  has no flag gate (glossary rule DR1: `SOLICITATION_SEND_ENABLED` masters
  *sending* only). **Allowlist baseline moved 392 → 397** (one attribution SELECT
  counted per-table, plus three signal UPDATEs; all `provider-ingress`).
  **Widened, not forked:** `getEmailHeaders` gained a fail-closed `'solicitation'`
  category (typed so a missing URL is a *compile* error, runtime throw kept as
  defence in depth) and `sendEmail` gained an optional `client` — the 10s timeout
  and idempotency plumbing keep one owner. **Three CONTEXT.md terms coined:**
  Messaging adapter, Sending identity, Solicitation lane.
  **Ships inert**: `SOLICITATION_SEND_ENABLED` is off everywhere and no Outreach
  row carries a `provider_message_id` until #630 sends, so the lane's discriminant
  cannot match in prod. *Next pass should also check the two follow-ups this left:
  the `provider_message_id` index (#630 owns it) and whether #630 closed the
  unmatched-attribution retry window at source.*

- **PR #833** — portal audit PR 3, Overview spec-alignment (2026-08-15, squash
  `51ad51eb`). **Entropy-negative: a duplicated query collapsed to one owner and a
  module deleted.** No migration, flag, env var, or dependency; net **+21 production
  lines** (+578/−557) across 22 non-docs files, tests net +647.
  **New single owner** `src/lib/admin/business-summary.ts` — the base query
  (`businesses` ⋈ `accounts` ⟕ `responses`), the conditional unfiltered COUNT, the
  metrics follow-up scoped to the ids actually returned, `buildBusinessSummary`, and
  `RESPONSE_METRICS_WINDOW_DAYS`; ONE exported function
  `getBusinessSummaries(sql, opts?)`. **Concept deleted:**
  `src/lib/admin/businesses-list-service.ts` + its test (no shim — internal admin APIs,
  no external consumers), and `getAdminBusinessesList` with it.
  `overview-service.ts` 344 → 189 lines, keeping only the 5 system-health queries,
  `deriveEmailHealth`, and the At-risk list selection. **New shared component**
  `src/components/admin/ui/HealthBadge.tsx` (peer of `StatusBadge`, single owner of
  churn-level presentation) — the run's one owner-approved edit-surface amendment.
  **Response shapes changed** without a compat shim: `GET /api/admin/overview` returns
  `atRisk[]` for `businesses[]` and drops `limit`/`offset`; `GET /api/admin/businesses`
  gains the metric fields. **Allowlist baseline moved twice** — 400 → 403 while both
  modules held the queries, then 403 → **396** when the duplicates were deleted.
  Two new `CONTEXT.md` terms: **Business summary**, **At-risk list**.
  **This closes the three-PR portal audit remediation spec** (#827 §3 → #831 §4 →
  #833 §5). The #827 entry asked that the three be weighed together, since PRs 2 and 3
  carry the structural weight — **they now can be**; that is the single highest-value
  thing for the next pass to look at in this window.
  **What the pass should scrutinise.** (1) A *recorded, deliberate* limitation now
  sits on the admin landing page: Overview loads every business row and ranks in
  TypeScript, because `computeChurnRiskScore` has no SQL superset (§5.1). It is
  trivial at the 250-location **Capacity target** and the rejected alternative is
  named — but it is the kind of thing a capacity review should re-date rather than
  inherit. (2) A spec-locked constant location turned out to be **illegal**
  (`APP_LEAF_IMPORT_BAN` blocks `src/lib/**` → `@/app/**`), which is the third
  instance in three PRs of "a prescribed fix falls outside what the discovering
  change may legally touch" — after #827's `.claude/skills/**` and `config/server.ts`
  cases. The class is now well-evidenced enough to be worth a structural answer.
  (3) Step-7 review found **two guards passing for the wrong reason** in one branch
  (a concurrency test whose mock skipped the guarded query; a comparator tier that
  lost its only pin in a test split) — both invisible to coverage and to a green
  suite, both caught only by mutation-checking. Worth asking how many older guards
  have the same shape.

- **PR #831** — portal audit PR 2, channel-route unification (2026-08-15).
  **Entropy-negative on duplication, entropy-positive on one guard.** No
  migration, flag, env var, dependency; net **−15 production lines** (+685/−700)
  against +1160/−52 test. Twelve mobile-channel enrollment routes (2 portals × 2
  channels × 3 actions) collapsed onto 3 shared runners
  (`src/app/api/_shared/channels/{start,action}.ts`) + 2 portal-specific
  **Channel actor** resolvers (`resolve-actor.ts`, term coined in `CONTEXT.md`);
  six owner routes went from 39–84 lines each to ~22-line shims. Closes the
  owner→admin module dependency completely (mechanically re-proven every gate
  run), and gives the WhatsApp deep link + the two flag/env modules one owner
  each in `src/lib/notifications/channels/`.
  **The one item a pass should weigh:** the admin MFA gate moved from
  *structural* to *configuration*. Before, `runAdminChannelStart/Cancel/Disable`
  were admin-only helpers calling `requireAdminWithAal2` unconditionally, so an
  admin route could not skip step-up. Now the runners are portal-agnostic and
  call `config.resolveActor` — a per-route value — so `tsc` cannot reject a
  mis-binding, and the compensating control is `ci:admin-aal2`, a text scan.
  Hardened here (reads comment-stripped code; denies `resolveOwnerActor` in
  admin routes; cases (m)/(n)/(o)) but its floor is real: an aliased import
  still clears it. The adversarial reviewer's structural remedy (branded actor
  capabilities / portal config factories) was **rejected as out-of-scope for a
  review round**, deliberately and on the record —
  `docs/reviews/refactor-channel-route-unification/adversarial-approach-codex.md`.
  **This is the class of decision an architecture pass exists to re-open.**
  PR 3 of the same spec (Overview spec-alignment, §5) is **not built** — its
  duplication is still live in `overview-service.ts` + `businesses-list-service.ts`
  — so the three-PR set should be weighed together, as #827's entry asked.
  **Not counted: PR #830** (marketing copy deslop, 2026-08-15) — runtime `.tsx`
  and copy-constant edits only, no structural surface, same reasoning as #700.
  Flagged rather than absorbed so the pass can disagree.

- **PR #827** — portal audit PR 1, correctness (2026-08-15). **Low entropy:
  read-path and route-constant fixes only.** No migration, flag, env var,
  dependency, or new file; 84 production / 263 test lines. Owner sign-out
  redirect corrected (`/admin/login` → `/login`, the first test that path has
  ever had); admin Telegram blank-username fallback aligned with the owner
  route; two DB fan-outs sequentialised (`admin/businesses/[id]/page.tsx`, and
  the competitors page via a new `loadRivalPickerViews` in
  `src/lib/competitors/named-rival.ts`); auto-approval threshold labels given
  one owner in `src/lib/auto-approval/types.ts` — the two
  `AutoApprovalReadinessBlockReason` maps deliberately NOT merged (different
  registers, both exhaustive over one union). Three fixed-width fan-outs
  annotated as deliberately left alone (spec §3.6). **Entropy-negative on
  duplication**, but it is PR 1 of 3 from one spec
  (`docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md`) — PR 2
  (channel-route unification, 12 routes) and PR 3 (Overview spec-alignment) carry
  the real structural weight and should be weighed together when the pass runs.
  **Two workflow-layer defects surfaced and were fixed/recorded, not absorbed:**
  the edit-surface guard could not match ANY Next.js dynamic route segment (bash
  `[[ == $glob ]]` read `[id]` as a character class) — fixed in **PR #828** with
  lockstep tests against its `feature-surface-audit.ts` mirror; and
  `verify-gate`'s `reclassify` row counts `docs/superpowers/specs/**` as
  production, tripping the re-classification trigger on a branch carrying its own
  spec (reported 481 production lines against a real 84) — **still open**.
  **One finding deliberately deferred to PR 2:** `src/lib/config/server.ts:224`
  still documents the `??` vs `||` divergence this PR closed; the file was
  outside the locked surface and PR 2 removes the divergence structurally. This
  is the same "prescribed fix falls outside the discovering feature's surface"
  class the 2026-08-10 pass flagged for `.claude/skills/**` — **second
  instance**, worth the pass's attention.

- **PR #821** — admin invite funnel (2026-08-14). **Heavy entropy: schema +
  billing + auth in one branch.** Two migrations (**105**
  `accounts.checkout_attempt_coupon_id` + a rewrite of
  `accounts_checkout_attempt_complete_check`; **106** one analytics event name),
  one new env var (`BETA_COMP_COUPON_ID`, server-only, no `NEXT_PUBLIC_*`
  companion), one flag **re-scoped** rather than added
  (`SELF_SERVE_SIGNUP_ENABLED` now gates only anonymous account-minting), and no
  new dependency. Deletion was a first-class deliverable: the 4-section admin
  form, `pending_payment_admin_handoff`, `PendingAdminHandoffScreen`, the admin
  prefill route, and `/api/dashboard`'s hardcoded `paymentUrl` are all gone.
  New single owners worth the pass's attention: `resolveFunnelEntry`
  (`src/lib/onboarding/funnel-entry.ts`) replaced **three** disagreeing
  destination deciders, and the coupon decision now rides the immutable
  `checkout_attempt_*` snapshot rather than a live env read. Tenant-scope
  allowlist stayed at 400 (one snippet refreshed twice). **Four surface
  amendments** (D-1, D-8, D-11, D-18) — past the stated abort threshold, each
  owner-approved. `reclassify` WARN at 4.1× the production-line estimate,
  adjudicated as estimate error, not lane error (D-11).
  **For the pass:** (a) `create-business.ts` still holds two ~115-line
  near-duplicate insert paths whose 21-column order is comment-synchronized —
  deliberately deferred, filed as
  `docs/future-plans/2026-08-14-unify-create-business-insert-paths.md`, and it
  writes the rows `onboarded_by`/coupon-eligibility/cleanup-poller all read;
  (b) `businesses.onboarded_by` now carries a **fourth** meaning (comp
  eligibility) on top of provisioning attribution, trial eligibility, and the
  cleanup-poller exclusion — a step-7 adversarial finding argued for replacing it
  with a dedicated entitlement and was rejected as `non_goals[2]`, so the
  overload is knowingly retained and is the single most likely thing to bite next;
  (c) prod is gated — 105 cannot be applied where 077 has not been.
- **PR #805** — #790 response-rate period framing (2026-08-12, squash
  `db4dd4a1`). UI copy/placement only: no KPI arithmetic, query, API, migration,
  env var, flag, dependency, schema, worker, or ingestion change. Keeps response
  rate on `detected_at`; adds one shared owner-facing denominator explanation to
  the per-location and All-Locations cards; amends ADR 0019 Decision 2.
- **PR #793** — #757 Review-time anchor on the rendered dashboard (2026-08-11,
  squash `17f60e2c`). Read-path only: no migration, env var, flag, or dependency.
  Applies the ADR-0019 anchor at the rendered plug lines in
  `src/lib/dashboard/{service,aggregate-queries}.ts` and deletes Stack A
  (`src/lib/kpi/service.ts` + `GET /api/dashboard/kpis`, zero consumers);
  `kpi/types.ts` remains, `src/lib/kpi/fragments.ts` is the new single owner,
  and the tenant-scope allowlist moved 408 → 401. Follow-ups: **#789**
  (Spec 11/metric restoration), **#790 resolved by PR #805**, and **#791**
  (All-Locations combined velocity month-name sorting).

> **Answers to three of the next pass's own scope questions, observed while shipping #757 — the pass should start from these rather than re-deriving them.**
>
> - **Scope item (1) — did #757 land P1 as specified? YES, with ONE recorded reversal.** One stack, `kpi/fragments.ts` as single owner (test-pinned), Stack A deleted, `kpi/types.ts` kept. **P1 asked for FOUR fragments; only TWO were extracted** — once Stack A is deleted, `detectedAtWindowFilter` and the TTR validity filter have **zero composers** (Stack B's response rate stays literal per ADR 0019 D2, which P1 itself forbids touching, and Stack B has no duration metric). Owner-adjudicated at intake, recorded as deviation D3 and in ADR 0019. Not drift — but the pass should confirm it agrees.
> - **Scope item (2) — did the sweep-miss mechanization end the missed-increment class? NO: IT NEVER SHIPPED.** `.claude/skills/document-feature/SKILL.md` still does not mention `arch-review-log.md` in its "What to update" table (`grep -c arch-review-log` → 0), so the mandatory log row the pass prescribed does not exist. The class has now failed **three times as prose** (#712, #716, #746) and the fix that was supposed to mechanize it was never applied. This increment was written by hand from the handoff doc's step-8 checklist, not by the skill — i.e. the class is still live and the next miss is a matter of who resumes without that checklist.
> - **Scope items (2) and (4) re-observed while shipping PR #821 — both classes are still live, and both fired again.**
>   - **(2) The mechanization has now SHIPPED — PR #823, 2026-08-14.** `.claude/skills/document-feature/SKILL.md`'s "What to update" table now carries an `arch-review-log.md` row, triggered "Always, on a MERGED feature", specifying the counter increment and the entry shape; the skill also records *why* the row exists so a future editor does not tidy it away. Before that, the class had claimed four features — #712, #716, #746, and #821 (whose increment was written **by hand** from a handoff checklist, because the skill did not ask for it). The prescribed fix survived **two** architecture passes unapplied, most likely because it always fell outside the locked edit surface of whichever feature discovered it: `.claude/skills/**` was outside #821's surface, and that branch had already spent four owner-approved amendments. It took a separate docs PR to land — which is the transferable lesson. **The next pass should verify the row is still present and that increments since #821 were made by the skill rather than by hand.**
>   - **(4) The gate's phase rewind fired three more times.** Same mechanism: `verify-gate.sh` calls `set-phase gate_green` on success unconditionally, so every gate run after review completion rewinds `reviewed` → `gate_green`. During #821's step 7 it fired after the review-fix gate, after the D-13 verification gate, and after the doc-sweep gate; each was repaired by hand with `set-phase reviewed`. Running total: **seven occurrences across five features** (#675, #677 ×2, #757 ×2, #821 ×3). The repair is cheap and the failure is loud, which is exactly why it keeps being tolerated rather than fixed — but it also means `phase` is not trustworthy as a resume signal unless the resuming session re-derives it, which `feature-resume` does.
> - **Scope item (4) — did the step-8 fallow preflight and the gate's phase-write removal ship? NEITHER.** `scripts/verify-gate.sh` still excludes `ci:fallow*` (lines 7, 195) with no step-8 preflight anywhere in the feature skill; and the gate still writes `phase` unconditionally (`feature-state.sh:50` is guarded, but `verify-gate.sh` calls `set-phase gate_green` on success), so running the gate after review completion rewinds `reviewed` → `gate_green`. **That rewind fired twice more during #757's ship** — once on resume, once after the evidence commit — and both times had to be repaired by hand with `set-phase reviewed`. Now four occurrences across three features (#675, #677 ×2, #757 ×2). The fallow half caused no incident here only because the branch happened to be clean.

Prior reset by the **2026-08-10 pass** (table row below). That pass reconciled the two flagged undercounts — **#712 counts** (its sweep PR #713 was never merged), **#716 counts, weighted entropy-negative** (verified dead-column cleanup) — making the true pre-reset figure **24 (4.8×)**. Full artifacts: `docs/reviews/PATHFINDER-2026-08-10/`. The window's merge list, retained for the record: (#758 — #688 KPI Review-time anchor, 2026-08-10 — read-path KPI re-anchor, no migration/flag/env var/dependency; `reviewTimeAnchor` fragments + TTR validity filter in `src/lib/kpi/service.ts` (interface unchanged), ADR 0019, tenant-scope allowlist re-pin ×3 (baseline 408); step-7 review spawned GA-blocking **#757** — `GET /api/dashboard/kpis` has ZERO consumers and the visible dashboard aggregates (`src/lib/dashboard/`) still bucket on `detected_at`, a pre-existing gap the pass should weigh when it reconciles the KPI surface; the flagged undercount conditionals below shift again with this +1: if #712 counts the figure is 23 (4.6×), if both #712 and #716 count it is 24 (4.8×); #749 — #731 deferred maintainability bundle, 2026-08-09 — four-item behaviour-preserving maintainability bundle out of #678's step-7 review, no migration/flag/env var/dependency and no new file; `toCardRow`'s seven `isOrphan` ternaries → one dispatch to two private mappers returning `Required<Pick<ReviewsListRow, …>>` in `src/lib/past-replies/replies-view.ts` (ADR 0018 addendum), the Reviews list's two `COUNT(*)` denominators + `AVG` merged into ONE `LEFT JOIN` + `COUNT(*) FILTER` query in `src/lib/past-replies/load-replies.ts` (three snapshots → one), `peekRegenBudget` deleted from `src/lib/costs/tracker.ts` in favour of `peekRegenBudgetBatch([id])` with the D-F fail-open posture preserved, and the retired `PAST_REPLIES_VIEW_ENABLED` dropped from the publisher edit-existing-reply suite; tenant-scope allowlist 409 → 408 (two entries out, one in); `reclassify` fired on the TEST bucket after the fix round (490 vs 230, 2.13×) — step 0 re-run, lane unchanged, recorded in the deviations log; the flagged undercount conditionals below shift again with this +1: if #712 counts the figure is 22 (4.4×), if both #712 and #716 count it is 23 (4.6×); #746 — #730 owner-facing open-flag predicate consolidation, 2026-08-10 — behaviour-preserving read-path consolidation out of #678's step-7 review (#725 inventory), no migration/flag/env var/dependency and no new file; `openFlagExistsSql` added to `src/lib/moderation/held-draft.ts` as the one owner of the read-side `status = 'open'` literal, with `hasOpenFlag` re-expressed on it, and 7 inline spellings across 6 owner-facing files collapsed onto the fragment (`reviews/[reviewId]/draft-status`, `past-replies/load-replies.ts`, `dashboard/service.ts`, `dashboard/aggregate-service.ts`, `dashboard/pending-count.ts` ×2, `agents/read.ts` — the last an anti-join → `NOT EXISTS` rewrite); the 8 deliberately-distinct consumers (admin disposition/queue/badge, health-alert backlog, offboarding purge lane, the producer) were left alone by design, `purge-verification.ts` most load-bearingly — it counts ALL statuses and consolidating it onto an `'open'`-filtered predicate would have been a correctness bug, not a cleanup; **this entry was MISSED at merge** — PR #748, its own post-merge sweep, touched `lab-notes.md`, `currents.md` and `progresstracking.md` but not this file, so the counter read 20 when it should have read 21 (reconciled 2026-08-10, #710 closing PR). This is the THIRD instance of the same missed step after #712 and #716; #743 — #728 persist-boundary content-freshness gate + generation-cache provenance, 2026-08-09 — ADR 0017 implementation on the response-generation persist boundary, no migration/flag/env var/dependency; lane-independent skip-the-INSERT gate in `worker/jobs/response-generation/persist.ts` + `stale_review_content` completion reason (`OUTBOX_COMPLETION_REASON`) + `CachedGeneration.reviewContentHash` provenance binding in `src/lib/responses/generator.ts`; reclassify fired at ship (430 prod lines > 2×140, lane already heaviest — recorded in the deviations log); the flagged undercount conditionals below shift again with this +1: if #712 counts the figure is 21 (4.2×), if both #712 and #716 count it is 22 (4.4×); #741 — #727 row-state axes + action projection, 2026-08-09 — Reviews-list affordance remodel, invariant-#4-adjacent, no migration/flag/env var/dependency; six-valued `row_state` deleted for the two-axis model + Action slot in `src/lib/past-replies/replies-view.ts`, ADR 0018, shared `ReplyPanel` extraction in `PastReplyCard.tsx`; the flagged undercount conditionals below shift again with this +1: if #712 counts the figure is 20 (4.0×), if both #712 and #716 count it is 21 (4.2×); #735 — #726 legacy Past Replies hold gates, 2026-08-09 — invariant-#4 approval-path change, no migration/flag/env var/dependency; 4 route-handler gates + 2 tenant-scope sqlSnippet updates (baseline unchanged at 409); the flagged undercount conditionals below shift with this +1: if #712 counts the figure is 19 (3.8×), if both #712 and #716 count it is 20 (4.0×); #733 — #729 Generate transaction extraction, 2026-08-09 — behaviour-preserving refactor, no migration/flag/env var, no new dependency; route→module move (`src/lib/reviews/on-demand-generate.ts`), tenant-scope allowlist −3 entries (baseline 409), one-line `statusArraySql` widening; #720 — #706 live-DB helper scan, 2026-08-08 — CI/test tooling, no runtime surface, no migration/flag/env var, one CI script plus its test file; #714 — #695 import consent enforcement locus + durable block reason, 2026-08-08 — worker + outbox seam, no migration/flag/env var, ADR 0016 + one generalized writer; #708 — #697 import consent analytics sink, 2026-08-08 — observability only, no migration/flag/env var, one catch block; #705 — #694 live-DB DDL detector, 2026-08-08 — CI/test tooling, no runtime surface; #640 — #625 consent ledger, 2026-08-01; #647 — #643 suppression ledger, 2026-08-03; #654 — #644 unsubscribe opt-out, 2026-08-03; #659 — #645 manual suppression paths, 2026-08-05; #682 — #674 importReview keystone, 2026-08-05; #685+#686 — #673 import-consent schema, migrations 100+101, 2026-08-05; #689 — #675 consented-import selection, 2026-08-06; #691 — #677 import offer + decision API, 2026-08-07; #698 — #679 import consent worker guard + migration 102, 2026-08-08; #701 — #696 verify-gate row identity, 2026-08-08 — workflow tooling, no runtime surface; #702 — #672 on-demand generation cost policy, `BURST_MAX` 5→10, 2026-08-08). **Correction:** the #698 entry previously read "map #667 complete" — it is not. #698 completed the *consent enforcement* spine; the map still owes **#678** (Reviews list, now fully unblocked) and **#680** (closing cleanup migration). PR **#700** (#671 reviews list surface) is deliberately **not counted** — docs-only, zero runtime lines, so it adds no architectural entropy. **Possible undercount, flagged not absorbed (2026-08-08):** PR **#712** (#678 Reviews list + On-demand generation, merged `e447ee5b`) carries substantial runtime surface — 71 files, ~9.3k insertions across `src/lib/past-replies/`, a new `/api/dashboard/reviews/[reviewId]/generate` route, `src/lib/costs/tracker.ts` and two publisher files — yet appears in no entry above and has no post-merge sweep commit on `main`. The #695 sweep did **not** add it, to avoid double-counting if that feature's own step 8 is still pending; if it is not, the true figure is **17** and the overdue multiple is 3.4×. Whoever runs the architecture pass should reconcile this first. **Second possible undercount, flagged not absorbed (2026-08-08):** PR **#716** (#680 legacy backfill counters DROPPED, merged `7b5718c1`) appears in no entry above either. What is observable: 16 files, ~1.6k insertions; a schema change — `supabase/migrations/103_drop_legacy_backfill_counters.sql` drops four columns from `zernio_backfill_runs` and has been applied to **both** Supabase projects in lockstep; it is the declared point of no return for the Consented Review Import epic (#667), after which ADR 0015 §4's revert-only backout no longer suffices; and its own record states **zero production TypeScript changes**. Its own post-merge sweep, PR **#718** (`0b3a1d20`), touched `lab-notes.md`, `review-ingestion.md`, `currents.md` and `progresstracking.md` but **not this file**, so the omission looks like a missed step rather than a deliberate exclusion — unlike PR #700, which is recorded above as deliberately not counted. Its true architectural weight is not assessed here: a migration that only drops already-dead columns and a migration that reshapes a live contract are not the same entropy, and deciding which this is belongs to the pass, not to the counter. If #716 counts, the figure is **17** (3.4×); if both #712 and #716 count, **18** (3.6×).

Scope the NEXT pass should cover: (1) execution status of the 2026-08-10 handoffs — H2 (imported-row hash bug), H3 (STRUCTURAL_GATES, invariant #3), H4 (one-owner sweep), H5 (mechanical bundle), H6 (doc-truth) — and whether **#757** landed the one-stack KPI consolidation as specified in `03-unified-proposal.md` P1; (2) whether the sweep-miss fix (mandatory `arch-review-log.md` row in `document-feature`'s table) actually ended the missed-increment class — it failed three times as prose before being mechanized; (3) **PR #713** disposition (rebase, drop its superseded log hunk, merge the rest — it holds #678's only build record); (4) whether the step-8 fallow preflight and the gate's phase-write removal (05-process-findings §4–5) shipped; (5) the DO-NOT-UNIFY register (`03-unified-proposal.md` P4) — confirm nothing on it was "cleaned up".

> **ADJUDICATED 2026-08-10:** every "Added by" section below was weighed by the
> 2026-08-10 pass — verdicts (CLOSED / FIX / PROTOCOL / DEFER) live in
> `docs/reviews/PATHFINDER-2026-08-10/05-process-findings.md`; the FIX items are
> handoffs H2–H6 in `04-handoff-prompts.md`. Retained below as historical record
> only — do not re-weigh.

Added by #647 (#643), for the next pass to weigh — three workflow-mechanism
findings, none blocking, all recorded in `lab-notes.md` under "2026-08-03":

- **`verify-gate.sh` does not own its DB precondition.** An intake could declare
  `pnpm test:db:setup` — which DROPs schema `public` — as a `verification_command`,
  and the gate launches those in parallel with the `test` row. It produced a fully
  spurious RED. Candidate fix: run DB provisioning serially before the fan-out, or
  reject destructive commands from `verification_commands`.
- **`migration-immutability-guard.sh` keys on the migrations-log head, not on
  "applied".** Every in-place amendment of a local-only migration is a false
  positive, and this workflow produces that shape whenever the migrations-log task
  runs before the ship lane. Candidate fix: a per-entry applied marker.
- **`reclassify` counts workflow artifacts against the implementation they
  describe.** #643 fired at 2.94× with production code at 435 lines and 37/37 files
  in-surface; 1,537 of the counted lines were the plan, deviations, intake and
  handoff. Candidate fix: exclude `docs/superpowers/plans/**`, and budget
  production and test volume as two separate estimates.

Also carried, not a code finding: the RISK=high lane's staging ride makes
`git merge --ff-only main` structurally impossible afterwards — `main` gets a
squash commit while `staging` carries a real merge, so reconciling needs a
verified-identical-trees `reset --hard` + `--force-with-lease`. This will recur on
every high-risk feature; feature.md step 8's post-merge instruction should say so.

Added by #654 (#644), for the next pass to weigh. **The staging-reconcile item above
recurred exactly as predicted** — `staging` ended 61 ahead / 1 behind after the squash
merge and needed `reset --hard origin/main` + `--force-with-lease`. Second occurrence, so
it is no longer a hypothesis; `deployment-guide.md` step 5 does document the reset, but
feature.md step 8 still says "fast-forward `staging` onto `main`", which is the instruction
that cannot work. One code finding and two workflow-mechanism findings:

- **`inject`-only suites are structurally blind to the raw request line — and one such
  blind spot was hiding a live limiter bypass for all five ingress providers.** Absolute-form
  request targets (RFC 9112 §3.2.2) resolve normally through `find-my-way` while leaving
  `request.url` absolute, defeating the decoded-path arm of the ingress-scope test; a
  mutation run reported the surviving arm as dead logic because `app.inject()` normalises
  the target and every rate-limit test in the repo goes through it. Closed for #644 with a
  real-socket test. **The pass should ask what else assumes a normalised request line** —
  signature verification, path-prefix auth checks, and the WAF-adjacent rules are the
  candidates, and none of them has a raw-socket test today.
- **`feature-cleanup.sh` silently cleans nothing when run from inside a feature worktree.**
  It derives `MAIN_ROOT` from its own cwd and then skips `[ "$WT" = "$MAIN_ROOT" ]`, so the
  worktree you are standing in — the one that just merged — is the one it cannot remove. It
  reports SKIP/KEEP rows for everything else and exits 0, which reads as success. Candidate
  fix: resolve `MAIN_ROOT` from `git worktree list`'s first entry (the real main checkout)
  rather than `rev-parse --show-toplevel`, or refuse to run from a non-main checkout.
- **feature.md step 8's post-merge sweep is described as impossible from the shipping
  session, and it is not.** #643's lab note concluded the sweep "must run from the main
  checkout AFTER `feature-cleanup.sh` removes the worktree". That route was unavailable here
  (main checkout on an unrelated branch; cleanup skips its own worktree). Parking
  `.feature/intake.json` and branching the shipping worktree off `origin/main` satisfies both
  guard rules — same checkout for containment, no intake for arming — and needs no
  launch-time env var. Candidate fix: document park-and-branch as the sanctioned route, and
  note that the branch must come off `origin/main`, since local `main` lags every squash merge.

Added by #659 (#645), for the next pass to weigh. **The staging-reconcile item is now
on its THIRD consecutive occurrence** (#647, #654, #659) — it is not a hypothesis and
not bad luck, it is what the high-RISK lane structurally produces. #659 additionally
hit the *inverse* shape: `staging` was left holding an OLDER auth tree than `main`
because a second branch rode staging mid-flight and landed on main as a squash, so
"reconcile" meant moving staging **forward**, not discarding work. feature.md step 8
still says "fast-forward `staging` onto `main`". Two workflow findings and one
code-shaped finding:

- **A refactor can blind a static security audit, and the type checker will not
  notice.** Extracting the three admin suppressions routes' shared preamble into a
  `withAal2JsonBody` wrapper typechecked, passed every route test, and turned
  `ci:admin-aal2` RED on all three routes — that audit is a file-level TEXT scan for
  `requireAdminWithAal2`, so three genuinely gated routes read as ungated. The audit
  exposes a `GATED_SHARED_HELPERS` allowlist that would have silenced it; taking it
  would have traded a greppable gate for a shorter file. **The pass should ask which
  other `ci:*` audits are text scans whose premise a legal refactor can void** —
  `ci:static-policy`, `ci:tenant-scope` and `ci:outbox-seam` are all string-matching
  audits over source, and none has a test proving it still fires after its target is
  wrapped, aliased, or re-exported.
- **`fallow` is a CI-only gate and nothing local tells you so.** `verify-gate.sh`
  runs 28 checks and not this one; CLAUDE.md says `ci:fallow` "gates nothing", which
  is true of that script but not of `fallow.yml`'s `ci:fallow:coverage`, which is a
  PR check. #645 was fully green locally through two review rounds and failed fallow
  the first time a PR existed. Candidate fix: either add fallow to `verify-gate.sh`
  or say plainly in CLAUDE.md that a green local gate does not predict the fallow
  check.
- **Local `fallow` and CI `fallow` disagree, and the local one invents findings.**
  Without `--coverage`, CRAP is estimated from export references; locally that
  reported `ContactRow` as HIGH (63.6 CRAP) while the coverage-informed CI run did
  not flag it at all. Anyone refactoring to satisfy local fallow is chasing a number
  CI does not compute. Candidate fix: make `ci:fallow` refuse to run without a
  coverage file, or label estimated findings as non-gating in the output.

Added by #682 (#674), for the next pass to weigh. **The staging-reconcile item is now
on its FOURTH consecutive occurrence** (#647, #654, #659, #682) — `staging` ended 21
ahead / 1 behind and needed the `deployment-guide.md` §5 `reset --hard origin/main` +
`--force-with-lease`. feature.md step 8 *still* says "fast-forward `staging` onto
`main`". Four occurrences is no longer a finding to weigh; it is a one-line doc fix
that keeps being deferred. Three findings, all about **checks that cannot see what
they claim to check**:

- **`describeWithDb` asserts nothing about the schema, and the convention text reads
  as though it does.** CLAUDE.md says live-DB suites "**assert** their schema
  (`assertSchemaReady`) instead of applying migrations", which is a statement about
  the *convention*; `src/__tests__/helpers/describe-with-db.ts` only gates on
  `TEST_DATABASE_POOL_URL`. #674's plan asserted the helper "handles the schema
  assertion" and shipped a suite with no assertion; the nearest precedent
  (`read.integration.test.ts`) has the same gap, so copying the neighbour propagates
  it. 32 suites do call it, so the convention is real but unenforced. **The pass
  should ask whether `ci:live-db-suites` — which already parses every live-DB suite —
  should require an `assertSchemaReady` call**, and whether the requirement should be
  checked against what the transaction under test *writes* rather than what the suite
  reads (#674 shipped a first fix asserting 071 for tables it reads, missing
  `agent_runs.parent_run_id` from 088 that the code under test writes).
- **`ci:live-db-suites` enumerates via `git ls-files` and is blind to untracked
  files, and its pass output cannot evidence otherwise.** A new suite audited before
  staging passes vacuously; and because `scripts/ci/live-db-suites-audit.ts` prints
  filenames only in its failure branch, no passing run can ever show *which* files it
  inspected. This is the #590 "checks that appear to run but exercise nothing" class,
  in a check added to close that class. Candidate fix: print the inspected count on
  success, and fail when a `*.integration.test.ts` in the working tree is untracked.
- **Plan-embedded code is a third-class citizen of every quality gate.** Three plan
  review rounds on #674 accumulated a wrong column name (`run_id` for `agent_run_id`),
  a missing assertion, a dead type cast, and a vacuous audit step — none visible to
  lint, tsc, or any test, because a plan is prose to every tool in the repo. It is
  then executed nearly verbatim by a subagent. **The pass should ask whether plans
  containing fenced `sql`/`typescript` blocks deserve any mechanical check at all** —
  even just extracting identifiers and grepping them against the migrations would have
  caught the one defect that would have stopped the keystone's only live-DB suite from
  running.

Added by #685/#686 (#673), for the next pass to weigh. **The staging-reconcile item
reached its FIFTH occurrence** (#647, #654, #659, #682, #685) — same divergence, same
`reset --hard` + `--force-with-lease`, this time additionally blocked by the harness
permission classifier so the owner ran it by hand. feature.md step 8 still says
"fast-forward". One new finding:

- **A locked intake has no channel for ticket amendments posted after its lock.**
  #670's resolution amended #673's enum to three values ~17 minutes after #673's
  intake was signed; three plan-review rounds and two branch-review rounds later,
  migration 100 shipped the four-valued CHECK to both environments, corrected same-day
  by migration 101 (#686). Every review validates against the intake — by design —
  so an amendment that only lives on the ticket is structurally invisible. **The pass
  should ask where the re-read belongs** (plan sign-off and the step-8 preflight are
  the candidates in the lab-notes entry) and whether the amendment protocol should
  REQUIRE the amending session to open a PR against the running feature's intake
  copies rather than posting a comment and hoping.

Added by #691 (#677), for the next pass to weigh. **The staging-reconcile item
reached its SIXTH occurrence** (#647, #654, #659, #682, #685, #691) — same
divergence, same `reset --hard` + `--force-with-lease`. feature.md step 8 still
says "fast-forward `staging` onto `main`", which **cannot** work after a squash
merge: `main` gets one new commit whose parent is the old `main`, so the branch
tip is not an ancestor and `--ff-only` always fails. This is not an
environment quirk to be re-diagnosed each ship; it is the deterministic
consequence of squash-merging, and the workflow text is simply wrong. **The pass
should decide whether step 8 says "reset `staging` to `main`" outright**, and
whether the tree-equality check (`git rev-parse origin/staging^{tree}` ==
`origin/main^{tree}`) that makes the force-push provably content-neutral belongs
in the workflow as a required precondition. Two further findings:

- **The `fallow`-outside-the-local-gate class reached its THIRD consecutive
  occurrence** (#659, #689, #691), each costing a post-open fix commit, a gate
  re-run, and — on RISK=high branches — a staging re-ride. The #689 lab note
  already prescribes running `pnpm ci:fallow` before opening the PR; prescribing
  it in lab-notes has now failed twice. **The pass should ask whether the
  step-8 preflight should RUN it** rather than document it, given
  `verify-gate.sh` deliberately excludes `ci:fallow*` and that exclusion is
  correct on its own terms. Note the clone half has a surface-budget
  interaction: fallow matches clones repo-wide, so the reported partner can sit
  outside the branch's surface and "fix it there" costs an amendment.
- **`verify-gate.sh` and the /feature workflow both own `.feature/state.json`'s
  `phase`, and the gate's write is unconditional.** Running the gate after
  review completion rewinds `reviewed` → `gate_green`, which makes a resumed
  session re-enter step 7 and open a review round against feature.md's cap on
  already-reviewed code. Hit twice in the #677 ship session. This is the mirror
  of #675's opposite trap (the phase had to be *held* at `executing`). **The
  pass should decide who owns that field** — a gate that only ever advances, a
  gate that writes `lastGreenGateSha` but never `phase`, or an explicit
  `--phase` flag.

| Date | Trigger | Scope reviewed | Outcome |
|------|---------|----------------|---------|
| 2026-07-17 | baseline (log created) | — | counter initialized |
| 2026-07-24 | 8 merges ≥ 5 threshold (#508, #514–#516, #551, #554, #561, #564) | Solicitation subsystem (restraint policy, ingest lane, planned executor #543) + the reliability wave | 6 findings, no blockers. **S1** csv_ingest advisory-lock key has two independent owners (`acquireCsvIngestLock` vs the inline literal in `worker/jobs/csv-ingest/failed-hook.ts:63`) — a rename silently splits the lock and the suite stays green; export one owner. **S2** `contact_csv_uploads` terminalization written 3× (ingest.ts:343, ingest.ts:377, failed-hook.ts:75); fold into one module during #543, which adds a 4th writer to that tx. **S3** (#543, pre-build) the working-tree D4 revision creates the batch row with `built_at = NULL` and filters owner reads to built rows, but D4 still forbids a status column and an expiry poller — a build that exhausts retries is permanently invisible with nowhere to record the failure. **S4** (#543, pre-build) D2's fan-out is bounded only by `MAX_DATA_ROWS`=5,000 → ~15k inserts in one job/tx; `BATCH_CAP`=25 caps sends, not evaluations. **R1** the single-replica invariant now carries 4 load-bearing mechanisms (`assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, overage OVERAGE-F1, and — new in #515 — the in-process LLM circuit breaker) with zero mechanical guard; `railway.toml` has no `numReplicas` and nothing fails if one appears. **R2** outbox enqueue seam covers 13 typed helpers vs 28 production files hand-writing `INSERT INTO job_outbox`; `ci:outbox-topics` checks only the topic literal. Tracked already, not re-raised: #555 (restraint-policy date fail-open), #565 (contacts-lane complexity). Health: maintainability 92.3, duplication 1.6%, zero scope findings in repo-wide `fallow health` (local CRAP unavailable — `coverage-final.json` dated Jul 16 predates every reviewed PR). |
| 2026-07-27 | 5 merges ≥ 5 threshold (#570, #571, #574, #575 — map-#528 completion wave; #583) + the #585/#586/#588/#589 debt sweep | map-#528 wave (run-engine executor, rival picker, Requests watch-mode, competitor delta digest), the debt sweep's four closures, and the CI/measurement surface (`ci:*` audits, fallow gate, `.claude/reference/*` allowlists) | 4 new findings, no blockers. **Carried-forward closures all confirmed.** R1 closed by #586 — `railway-replicas` rule at `scripts/ci/static-policy-audit.ts:790` + `worker/config/replica-identity.ts` wired from `worker/index.ts`/`worker/sentry.ts`; *detection without enforcement is the right posture* — Railway injects a per-replica id but no replica count, so no process can assert it is alone, and the one mechanically blockable path (config-as-code) IS blocked. #587 correctly scopes the residue. R2 closed by #588 — *verdict holds*: 15 typed helpers vs 29 files writing raw `INSERT INTO job_outbox`, and `src/lib/shared/job-outbox-status.ts` documents why a fragment seam would have been actively wrong (a bind parameter inside `ON CONFLICT … WHERE` defeats partial-index inference), so guarding the vocabulary is the correct seam. S1/S2 closed by #565 (`acquireCsvIngestLock` exported at `ingest.ts:380`; single terminal writer at `ingest.ts:394`). S3 shipped as built *with an answer* — `worker/jobs/solicitation-batch/failed-hook.ts` records an exhausted build on the run spine via `failSolicitationBatchRun`, so it is not "nowhere recorded"; not re-raised. **New: #590** (HIGH) `ci:live-db-suites` (`package.json:39`) is wired into neither `.github/workflows/ci.yml` nor `lefthook.yml` — the only one of 15 — while CLAUDE.md and #585's commit body both claim CI enforcement; the general defect is that the `ci:*` set is hand-spelled in three places with nothing forcing agreement, and `scripts/verify-gate.sh:60` already derives it correctly in the one place that does. This is the mechanism behind the #581 class (local vs gating signal divergence). **#591** (HIGH) `RankingTrackingWorker.test.ts:23` / `WeeklySummaryWorker.test.ts:34` fork the shared `createMockSql()` harness for a body-specific `jsonb_array_elements` string sniff, justified by a false claim that `vi.hoisted` cannot reach a shared helper (`worker/__tests__/helpers/mock-sql.ts:8-14` documents the async-import form; `judge-store.test.ts:3-7` uses it; 100 files consume it). **#592** (LOW) `sql-tag-scan.ts:17` omits the `exec` SqlExecutor spelling that the fragment builders now use — no violation today, expired precondition. **#593** (LOW) `solicitation_asks.evidence` discriminant enforced by a throw in `batch-view.ts:94` with no CHECK at `088:155`. Already tracked, not re-raised: #581, #582 (verified still open — `purge-stages.ts:256` deletes `contact_csv_uploads` unlocked), #587. Health: score 77 B, maintainability 92.2 (good), duplication 1.7%, 0 churn hotspots, dead files 0.3%; 14 refactoring targets (3 high), 153 high-complexity functions. Repo-wide CRAP is **not quotable** per #581 — fallow matched Istanbul coverage for only 5,665 of 24,082 functions, so unmatched functions are estimated from export references. |
| 2026-08-10 | 24 merges ≥ 5 threshold (4.8× — reconciled from the quoted 22 by counting #712 and #716; the Consented Review Import epic #667 + maps #710, suppression #643–#645, KPI anchor #688) | Pathfinder pass over the entropy window: 7 features charted (F1 Review import, F2 Import consent, F3 On-demand generation, F4 Reviews list, F5 held-draft seam, F6 persist boundary, F7 suppression/unsubscribe — 301 flowchart nodes, every node file:line-cited), 20 within-feature + 10 cross-feature duplication findings, 11 process items adjudicated. Artifacts: `docs/reviews/PATHFINDER-2026-08-10/00-05` | **Headline: the code held its shape; the entropy was in the workflow layer.** Health 77 B → 77 B, maintainability 92.2 → 92.2, duplication 1.7% → **1.3%**, churn hotspots 0 → 0 across 24 merges — while the process layer accumulated 3 missed counter increments, 6 staging-reconcile incidents (doc-fixed pre-pass), 3 fallow-surprise PRs, 2 phase rewinds, and 1 wrong-CHECK migration from the intake-amendment gap. **KPI verdict (P1):** ONE stack — Stack B composes extracted ADR-0019 anchor fragments (`kpi/fragments.ts`) at 14 verified plug lines; `getLocation/AccountKpiSummary` + `GET /api/dashboard/kpis` DELETED (zero consumers, verified ×3); `kpi/types.ts` kept (9 importers); #757 rendered fully mechanical. **1 behavioral bug found (H2):** imported rows hash differently than live rows (`zernio-ingest-shared.ts:425-453` vs `computeContentHash`) → spurious content-changed lane on later updates. **Invariant-#3 hardening (H3):** structural auto-approval candidacy spelled ×3 with nothing forcing agreement → STRUCTURAL_GATES table. One-owner sweep (H4): `zernio://` template ×7/5 files, `review_exceptions` ON CONFLICT ×2, one JS in-flight hand-spell. Mechanical bundle (H5) + doc-truth (H6). DO-NOT-UNIFY register (P4) records 8 verified-deliberate specializations incl. the row-lock preambles and the PgBouncer-guard non-finding. Process verdicts (05): sweep-miss → mandatory log row in `document-feature`; gate stops writing `phase` (records `lastGreenGateSha`); step 8 RUNS `pnpm ci:fallow` (0.6s measured); audit self-tests for the 4 text-scan audits; `ci:live-db-suites` evidence-completeness; intake amendments become PRs against intake copies, never comments. |
| 2026-08-15 | 6 merges ≥ 5 threshold (#793, #805, #821, #827, #831, #833 — the portal-audit spec #827→#831→#833 weighed together as its #827 entry asked) | Pathfinder pass, **windowed not repo-wide** (owner's call): 6 features + 1 seam charted — F1 admin business console, F2 owner dashboard portal, F3 owner settings, F4 Channel actor seam, F5 onboarding funnel, F6 Checkout attempt, S1 auth gate seam. **671 nodes / 3,908 lines**, every node `file:line`-cited. 8 within-feature + 6 cross-feature duplication findings, 4 enforcement-surface findings, 1 invariant violation, 15 guard-integrity instances, 10 process items adjudicated. Artifacts: `docs/reviews/PATHFINDER-2026-08-15/00-06` | **Headline: the prior pass's prescriptions were ALL executed — H1–H6, a first for this log — and the code held its shape again** (health 77 B → 77 B, maintainability 92.2 → 92.2, duplication **1.3% → 1.1%**, 0 churn hotspots across 6 merges, 3 of them structural refactors). **The pass's largest finding is test-integrity, not architecture: 15 guards pass for the wrong reason** (`06-guard-integrity.md`), each confirmed by mutation against the full 862-file/11,340-test suite; **5 sit on invariant #3's auto-policy gate chain** sharing ONE root cause (the suite pins every gate collaborator to ALLOW and never overrides), incl. the judge verdict — which CLAUDE.md calls a posting precondition. Orchestrator independently reproduced A1. Two (`ResponsePublisherWorker.test.ts:239`,`:250`) are worse than untested: their titles claim the coverage. One (E3, `business-summary.ts:235`) is a live correctness bug on regression — it feeds `approval_rate`, hence every churn score. **40 of ~55 mutations correctly killed**; the auto-approval matrix pins all 11 block reasons (product of prior handoff H3). **Mirror class claimed, then REFUTED on same-day execution:** the pass asserted live-DB-only pins were inert in CI; H6's census found CI's `test` job has run the live-DB lane since #244 (91 suites measured) — the observations held, the conclusion misread the local `test:integration` list as CI's coverage. H6's real yield: that CI gate was **unpinned** (four YAML lines un-gate 92 suites, CI stays green) — now pinned in `ci-audit-wiring.test.ts`. **Enforcement:** #831's structural→configuration MFA conversion re-opened as asked — `ci:admin-aal2`'s floor is FILE-scoped not verb-scoped, **an unused import satisfies its allow rule**, and it does not cover admin pages at all (`requireAdminPage`'s `aal2` defaults false, 8/16 opt in); `MFA_ENFORCEMENT_ENABLED` is Off so per-route binding is the only live AAL2 layer. Residual risk bounded honestly as **availability, not escalation** (proxy prefix + `requireRole` backstop); the dangerous variant is admin mutations moving off `/api/admin`. CLAUDE.md's "an aliased import would still clear it" **corrected** — a same-file alias TRIPS the deny rule; the real evasion needs a renaming re-export (→ H3). **Duplication:** #833 and #831 each built a correct owner and stopped one file short — `HealthBadge` exists twice with **different type safety** (shared = compile error on a new level, private copy at `BusinessDetailClient.tsx:33` = silently green), churn math doubled, trial eligibility spelled twice **and disagreeing**, `onboarded_by`'s primary-scoped subquery spelled 3× (one **unscoped** — latent not live, guarded by a precondition two modules away). **Doc-truth:** `onboarded_by` has **6 read sites / 5 meanings** vs CLAUDE.md's "three"; "Health presentation has ONE owner" is false as written. **Invariant #9b collapse** found at `useLocationVoiceForm.ts:196` (flag dropped from the mode check). **Process:** sweep-miss mechanization CLOSED (last 3 increments written by the skill); **new class — PR #803, uncounted, deleted the `/feature` skill's entire step 8** (667→207 lines), the surface the fallow preflight, the staging-reconcile fix and the arch-log increment all targeted; the increment survived only because #823 had relocated it days earlier. Phase rewind still live at 7 occurrences — and `transition-state.mjs` LOOKS like the fix but is bypassed AND its matrix permits the rewind anyway. `reclassify`/specs still open (WARN, not FAIL). "Prescribed fix outside legal surface" split into TWO classes with different answers (7a validate spec locations vs import bans; 7b out-of-surface fixes ship as ISSUES, not log notes — the evidence being that notes failed 4× before #823). Audit census: 10 AST / 7 text. 6 handoffs H1–H6. |
| 2026-08-18 | 8 counted merges ≥ 5 threshold — **measured as 11 by the counter's own rule**, across a 32-commit window (the solicitation send lane #657/#651/#652/#629/#858/#859/#860/#865/#872 + #665/#662; the uncounted three-tier design system #843–#846; the uncounted CI/tooling surface #847–#850/#854/#867) | Pathfinder pass, **windowed** (owner's call): 9 features charted — F1 approval lane, F2 Requests surface, F3 admin console, F4 email lane, F5 unsubscribe, F6 design system, F7 marketing, F8 CI enforcement, F9 purge verifier. Two extra axes: guard-integrity (42 mutations) and process. Artifacts `docs/reviews/PATHFINDER-2026-08-18/00-06` | **Headline: the code held its shape a FOURTH time — health 77 B → 77 B, maintainability 92.2 → 92.2, duplication 1.1% → 1.1%, 0 churn hotspots, high-complexity functions 153 → 122 — and three of this pass's own findings would have been WRONG if reasoned instead of measured.** (1) **F8 refuted the fix the pass was about to prescribe**: adding the four missing tables to `TENANT_TABLES` produces **63 red lines and 0 security fixes** (measured by copying the audit and running `--no-allowlist`); the real gap is the **bridge vocabulary** — `localScopedBindings:942` knows 3 shapes, `users` needs a 4th (`accounts.owner_user_id = users.id`, inbound FK on the parent) and a 5th. H5 is therefore three ORDERED steps. (2) **F3's boundary was wrong**: the import closure of its two halves intersects in **zero domain modules**, and the trust models diverge at the read layer (the Send panel page runs at plain admin, `aal2` defaults false; suppressions passes `aal2:true`) — SPLIT. (3) **W4 refuted "five verbs share a body"**: the repetition is silhouette, three already-extracted lines. **Guard integrity: H1's fixes HELD** — 14 of 15 prior findings genuinely pinned, 0 regressed, the five on invariant #3's gate chain closed; of 26 new-guard mutations **25 killed, 1 survived** — `latchHalt`'s `halted_at IS NULL` CAS (`approval.ts:479`), credited by three tests that never reach it because both arms refuse at the caller's state guard first. **Duplication:** the cancellable set has **SIX** spellings (the log said two) and `CONTEXT.md:75`'s own "a THIRD caller is the signal to extract" trigger has fired; `batchDidClose` is spelled 4× in 2 forms and that split already falsified `ApprovalPanel.tsx:562-563`; the purge writer and verifier share **seven** hand-typed sentinel literals. **New bug found (X9):** `suppressions-service.ts:72` runs a 2-wide `Promise.all` on the singleton `sql` against `DB_POOL_MAX=3`, contradicting `admission.ts:26-31` by name, missed because four fan-out pins enumerate their subjects. **Meta-class (X10):** four independent guards whose scope is an ENUMERATION — `ci:tenant-scope`, `ci:admin-aal2`, `design-scope-purity` (hence `auth-island.css:5-15`, Island palette redeclared outside every watched directory **with the fonts already diverged**), and the fan-out pins. **F9:** the OR-chain is **28** predicates, not 27; `tracked_keywords:144` uses `<>` where the identical column class at `:120` uses `IS DISTINCT FROM`. **P6, found by this pass ON this pass:** the Stop hook demanded the orphaned import left by a live mutation be fixed — and the obvious fix permanently deletes an invariant-#3 posting precondition. **Follow-up rate for the window: ZERO** — no product merge shipped a defect a later PR had to repair; residual risk has moved entirely to composition (staging-only) and to the apparatus itself, which has no layer that reviews it. 7 handoffs H1–H7. |
| 2026-08-22 | 7 counted merges ≥ 5 threshold across a 17-merge window after `54e4d374` (the solicitation send lane #901/#904/#912/#920/#925/#926 + the Daylight Gallery II rebrand #905); the counter itself read **3** and was hand-corrected to 7 in #929 the same evening | Pathfinder pass, **windowed** (owner's call): 8 features charted — F1 release cycle, F2 dispatch, F3 send breaker, F4 halt latch, F5 marketing chrome, F6 Gallery II section pages, F7 watch-mode postal gate, F8 tenant-scope allowlist. Plus a guard-integrity axis (**12 mutations, none skipped**) and a process axis. Artifacts `docs/reviews/PATHFINDER-2026-08-22/00-08` | **Headline: the code held its shape a FIFTH time — 77 B, duplication 1.1%, high-complexity functions 122 → 119, 0 churn hotspots across +7,177 LOC — and the pass's own priority hypothesis was REFUTED by measurement.** Guard 5 (`readSendBreaker`'s fail-closed throw), flagged in the brief as the likely highest-severity finding, is pinned **three** ways. **The real finding inverts the shape of the lane:** the send lane's DECISION logic is well pinned (gate order survives two independent swaps, governor order caught by a four-round differential, the outbox status contract caught by a CI audit) while its **concurrency and integrity spine is not** — the A4 bytes-identity check and BOTH send-path CAS predicates survived deletion with the whole lane green, and a whole-repo grep of `src` + `worker` returns **zero** test-file references for `bytes_changed_under_gate`, `cas_lost` and `in_flight_elsewhere`. Severity order 6 > 2b > 2a. **X18: `canonicalBatchId`'s bug is reproduced** — `settleGenerationExhaustion` binds one id `::uuid` and raw-TEXT in ONE transaction, locking the batch and missing its send parent, while `closeBatchIfSettled` forty lines later lowercases internally and finds it; the canonicaliser exists because this already shipped once. **DO-NOT-UNIFY:** the send-parent QUERY is legitimately two functions (*ACTIVE parent* vs *LATEST parent*) — unify the canonicalisation only. **Process (P1): the counter was wrong for the FOURTH consecutive pass and this log's own recurrence line said THIRD**; four merges were missed in one window (#901, #905, #925, #926), #905 being 51 production files with no row at all. **P2:** #895(b) was delivered by #920 and the source cites the issue by number while the tracker still shows it open. **P6 from the prior pass recurred:** the Stop hook demanded the orphaned import a live mutation left behind be fixed — and it exists in TWO hook copies, not one. Backlog delivered as ONE ranked list of 15 items. |
