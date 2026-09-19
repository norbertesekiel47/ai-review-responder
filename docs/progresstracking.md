# RepWorth — Progress Tracking

> **Human changelog — newest at the bottom.** This is the detailed build history.
> Agents looking for current state should read [currents.md](currents.md); for
> load-on-demand detail read [.claude/reference/](../.claude/reference/).
>
> **Older history is archived** to keep this file readable (live entries start at
> "2026-08-24 — #631", 2026-08-24):
> - [progress-archive/progresstracking-2026-04_sprints-1-to-6.md](progress-archive/progresstracking-2026-04_sprints-1-to-6.md) — Sprint 1 → Sprint 6 (2026-04-06 → 2026-04-17)
> - [progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md](progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md) — Channels → Multi-location (2026-04-20 → 2026-05-22)
> - [progress-archive/progresstracking-2026-05-to-08_ci-keystone-to-ask-withdrawal.md](progress-archive/progresstracking-2026-05-to-08_ci-keystone-to-ask-withdrawal.md) — CI Keystone → Ask withdrawal (2026-05-24 → 2026-08-18)
> - [progress-archive/progresstracking-2026-08-21-to-23_send-governors-to-release-poller.md](progress-archive/progresstracking-2026-08-21-to-23_send-governors-to-release-poller.md) — Send governors → Solicitation release poller (2026-08-21 → 2026-08-23)

---

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

## 2026-09-11 — retire legacy business pages (#1202)

After the owner's #1226 Page parity approval and Admin app PR #10 merge (`44452f060f78c691cc81188b6bbd05a6d3be82c1`), removed the three legacy business pages and co-located components/hooks/tests. Pruned their navigation/exclusion, palette/star-file pins, runtime page-gate imports and inventory; retained shared breadcrumb and surviving-page coverage. Overview, Jobs and Autonomy keep business facts and recovery actions but replace retired links with plain text and Admin app guidance, without an early `ADMIN_APP_URL` read. API routes, shared widgets, impersonation and synthetic gate fixtures remain unchanged. The port's approved Disconnect route substitution and exact main-app link/account ID addition are explicit scope decisions, not hidden route parity. Computer Use is unavailable; the owner's accepted port evidence remains fixture comparisons.

## 2026-09-11 — Admin home cutover and Overview retirement candidate (#1192 + #1201)

Applied the approved batch after #1202: server-only `ADMIN_APP_URL` feeds the eleven redirect/default sites and both retained sidebar brand anchors. Trusted external password-login defaults and successful end-impersonation returns use full document navigation; the existing untrusted `from`/`next` restrictions remain. The exact gated `/admin` proxy relay gives MFA an internal return path and keeps expired challenges in the Admin login flow. Both actual end-button render paths receive the server-provided destination, without changing impersonation API/session semantics.

Removed only the legacy Overview page/client/co-located tests and affected navigation/file pins. All APIs, shared UI, nav-counts and the ten remaining page retirements stay in place for their ordered tickets. Added harmless test/build CI URL fixtures and both environment inventories. The [staging campaign ledger](runbooks/evidence/2026-09-11-admin-home-cutover-staging-evidence.md) owns deployment provenance and remaining verification; the candidate still requires the single review pass, one red-team pass and staging release before merge. Computer Use remains unavailable; no source-login browser verification or production rollout is claimed here.

## 2026-09-11 — Owner Operator **Run A**: the turn pipeline (`feat/owner-operator-run-a`)

The first code for the **Owner Operator**, the conversational surface an owner will use to configure RepWorth by talking. Spec of record: `docs/roadmap/2026-09-11-owner-operator/README.md` (§15 carries the matching review-log entry); glossary: `docs/context/owner-operator.md`. **Inert on arrival** — `OWNER_OPERATOR_ENABLED` is server-only, default off, and unset in every environment.

**What shipped.** Migration **120** — `agent_conversations`, `agent_turns`, `agent_proposals`, `agent_unsupported_requests`, deny-all RLS, and the hard-delete offboarding disposition with its `runContentPurgeStage` arm. The `agent_turn` outbox topic, queue and typed helper (a plain INSERT: `job_outbox` has no generic in-flight index, 004/018 are per-topic). `src/lib/responses/voice-settings.ts`, the shared transactional voice writer, with `highlight_facts` and the settings-route extension. The v1 catalog — three reads, four voice proposables, one capture. The model-output schema, the semantic validator and the **Pasted-review scrub**. The `owner_operator` LLM task (reply-generation pair, `maxTokens: 1200`, `temperature: 0.2`; the MODEL question stays open at the checkpoint). The **Turn claim** / predecessor-wait / **Fenced completion** protocol and `AgentTurnWorker`. The POST turn route and the two account-scoped owner reads. ADR 0005's flag-on LLM envelope moved 11 → 12 for the third gated lane, at concurrency 1.

**NOT built, deliberately:** the screen, Apply, Decline, receipts, the consequence line, asymmetric friction, the three auto-approval operations, and any executor. `requires_confirmation` is therefore always false in Run A, because no registered operation widens autonomy. All of that is Run B.

**Two design facts worth keeping.** The **Context snapshot** has no *field* that could hold review text, response text or a reviewer name — `sampleResponses` is excluded by type, not filtered — so a leak is a compile error rather than a missed branch. And a zero-row fenced UPDATE means the lease was lost: discard the model output and exit, never retry and never touch the outbox row, which belongs to the attempt that holds the lease.

**Process.** Plan hardened over three Codex rounds (round 3 APPROVED with one untriaged note, carried into T5). Two surface amendments: #1 pulled the pre-existing `src/app/api/settings/voice/__tests__/route.test.ts` into T2's lease, because extracting the writer moved the behaviour 8 of its cases pinned; #2 created `docs/directory/lib-owner-operator.md`, because `lib-platform.md` and `lib-reviews-responses.md` were both at exactly 3,000 words and the eleven new `src/lib` rows had nowhere else to go. Full record: `docs/superpowers/plans/feat-owner-operator-run-a-deviations.md`.

**Before any flip:** migration 120 must be applied in that environment FIRST — `runContentPurgeStage` names the four tables unconditionally and raises `42P01` at plan time without them — and BOTH lanes read the flag, so it is set in Vercel AND Railway.

## 2026-09-12 — Owner Operator Run A merged (#1270, squash `d8e3f334f`): fresh red-team run, `agent_turn` alert path, migration 120 on both databases

**Merge and promotion.** PR #1270 squash-merged at 10:55Z with every required check green (`fallow` included, which had failed at the previous head until the fallow-gate refactor `15bc4a4aa`). Migration 120 applied to production `udeyaqnvpojbwgoaxwdg` with the file's SQL in one transaction and verified by introspection against staging: four relations, RLS on / FORCE off, 0 policies, no `anon`/`authenticated` privileges, seven `pg_get_constraintdef` strings byte-identical, three indexes. `staging` realigned to `main` by one server-side force-with-lease push of `d8e3f334f` over `493c65970` (no local `reset --hard` needed).

**Before the merge — session 2 of the `/feature` run.** `origin/main` was taken BEFORE the adversarial pass (one docs-only commit; the PR was `BEHIND`, so the update was owed at merge time anyway and taking it first costs one gate run, not a second red-team pass). Fresh red-team run because the closed three-round run was voided by the fallow refactor and by intake amendments #3/#4: round 1 at `5b223e33f` — 1 P0, 7 P1, 1 P2; fixes in `3a377f656`; round 2 re-killed every guarded line (the round-1 lease survivor now fails three tests); round 3 (owner-authorized, doc-only) closed two wording defects. **Surface amendment #5** added `worker/background/pollers/health-alert/checks.ts`, its unit test and `docs/runbooks/beta-launch-alerting.md` so the alert path could be fixed in the same PR. Final status CLEAR at `7583062a4` with the round-2 scope rule applied explicitly (237 never-executed rows `excluded`, reason on each row). `reviewed` was set by hand under owner authorization after `transition-state.mjs` refused on a summary section in the deviations file that had no `**Verdict:**` line; the re-verification diff (two doc files, zero code past the red-team head) is recorded in the deviations closeout entry.

**Open, non-blocking.** Red-team P2-4 (runbook triage step names `turn_id`; the Sentry event carries `outbox_id`); the rule-11 Sentry alert for `subsystem:worker_job` + `queue:agent_turn` is documented but NOT built — required before `OWNER_OPERATOR_ENABLED` goes on anywhere. Both ride Run B's first docs commit.

**Lessons promoted to lab notes (`history/2026-09.md` 2026-09-12):** the red-team runner's 3-round cap plus "an amended intake voids the sidecar"; the round-2 inventory scope rule; the deviations auditor reads every `## ` section; `pnpm ci:fallow:coverage` is the CI signal, not `ci:fallow`.

## 2026-09-13 — Owner Operator Run B merged (#1273, squash `34857b73b`): Apply, Decline, receipts, the Operator screen; fresh red-team run over the CI fixes

**Merge and promotion.** The branch rode `staging` first as a plain fast-forward to `f96b1a879` (02:05Z): the Railway staging worker redeployed (SUCCESS at 02:07Z; `/ready` 200 with `postgres`, `queue_redis`, `cache_redis` ok) and the Vercel `staging` custom environment built READY at `staging.repworth.net` — build and boot proof with the flag off, which is all a flag-off ride can prove. PR #1273 squash-merged at 02:13Z with every required check green (`fallow` and `react-doctor` included). `staging` realigned to `main` at `34857b73b` by a `--force-with-lease` push of the merge commit (no local reset). Worktree removed by `scripts/feature-cleanup.sh`; the run's `.feature/` ledgers were archived before removal. No migration; no env var; no flag flip anywhere.

**What landed (production).** `src/lib/agents/operator/apply.ts` (`applyProposal`: contract check before any lock; one transaction locking the `businesses` row then the proposal; `revalidateActor` under the locks; the three-way text **Version token** compare; the operation's own fields through the shared voice writer; `buildReceipt` writing the server-owned **Receipt** in the same transaction; sibling pending Proposals marked `stale`; repeat Apply returns the stored Receipt), `version-token.ts`, `declineProposal`; `src/app/api/operator/gate.ts` (`requireOperatorWriter` / `requireOperatorProposalWriter`, order flag → same-origin → writable owner → impersonation → uuid) serving `turns` and `proposals/[id]/{apply,decline}`; the conversation read's `?locationId=`, `connectionStatus`, `location_not_found` and per-turn `unsupported`; the Operator screen under `src/app/(authenticated)/dashboard/operator/` (server page `notFound()` when off; `OperatorClient` decomposed into `useOperatorConversation`, `useTurnPoll` with a module-level `startTurnPoll`, `useProposalWrites`, `useTurnSubmission`, `useOperatorUrl`; `ProposalCard` + `ProposalState`, `ReceiptView`, `SummaryPanel`, `TurnBody`, `wording.ts`, `operator.css`); the `operator` `NavSection` and the six-tab mobile bar gated by a server prop; one `hasImpersonationCookie` (`src/lib/admin/impersonation/cookie.ts`); `/api/operator` on `isProtectedOwnerApiRoute`. Tests: 51 promised titles plus the review-round additions, two fast-check properties, `apply.integration` and `reads.integration` live-DB suites, `e2e/operator.spec.ts` with its SQL worker stand-in.

**Review.** Plan locked by owner call after three Codex rounds (11 + 7 + 1, all accepted). Wave at `dba7af671`: spec 7, standards 13, Codex adversarial 3, red team 11 (P0: the docs claimed Sentry rule 11 BUILT; it was not). Fix commits `64f9de864` / `aa7fd157a` / `cd4710b4b`; red-team rounds 2–3 closed CLEAR at `ef9b3a7ca` with RT-12 accepted as risk (AUTH-3). Rejected with evidence: RT-09, RT-10, RT-14; standards F7; F11 later REVERSED by CI's fallow duplication gate (the `gate.ts` helper, surface amendment #4).

**After `reviewed`.** The first CI run failed `fallow` (10 unused exports, 6 complexity findings, 3 route-preamble clones) and React Doctor (`effect-needs-cleanup` on a self-rescheduling poll timer). Fixed in `99975e2e9` and `79f695d53`. Those two commits touched production files after the red team closed, so a resumed session (`/feature-resume`) preserved the closed run as `…-fec8cf-rounds1-3/`, rotated the journal and ran a FRESH three-round red team scoped to `git diff ef9b3a7ca..79f695d53 -- src` under the owner's verbatim authorization. Round 1: RT-B2 **P0** (the Receipt's `before` could be swapped for the after-state; the only assertion was `not.toHaveProperty('updatedAt')`), RT-B1/RT-B3/RT-B4 P1, RT-B5/RT-B6 P2 — all fixed in `77ce88f04` (tests plus one `useMemo`) and `13433a583`. Round 2: all six re-measured and killed; `INCOMPLETE_ORACLE` on B1-27. Round 3 (owner-authorized, "I authorize a third round scoped to the 11 skipped rows and RT-B7 (B1-27)."): RT-B7 pinned by a new case (`94e4a1a26` — a read that answers after the turn finished resumes the newer running turn); the 11 skipped rows all killed; **CLEAR** at `e11aeceda` — 88 rows, 62 killed, 0 inconclusive, 0 skipped-budget. One new P2 left open for T8: RT-B8 (the S3 refetch in `adoptAcceptedTurn` has no discriminating case). Session 2 cost ≈ 160M input tokens / 308K output / 6.5 h on top of session 1's 120M / 265K / 8.1 h.

**Open, owed by the T8 follow-up PR.** Sentry rule 11 in `repworth-staging` and `repworth-production` (NOT BUILT — the API refused for want of `alerts:write`); the staging flip of `OWNER_OPERATOR_ENABLED` through the `flag-flip` skill; p50/p95 of `completed_at - created_at` on staging; the `worker/jobs/agent-turn/constants.ts` tune; spec §12.1 checkpoint and §15; RT-B8's test. Still open from Run A: red-team P2-4 (runbook triage hop via `outbox_id`), spec §14 CA1 (OutboxPoller stranded turn) and CA4 (predecessor-wait clock).

**Lessons promoted to lab notes (`history/2026-09.md` 2026-09-13):** run `pnpm ci:fallow:coverage` and React Doctor BEFORE the review wave on a UI-bearing branch; the red-team checker's `authorizations` admits only finding-resolving records and a third round needs the words "third round"; revert a mutant with `finalize`, never a second `mutate`; the base-tier auth harness cannot sign an owner into any `/dashboard/*` page; the plan prevalidator reads hex runs on any line carrying a git word.

## 2026-09-13 — Owner Operator T8 merged (#1276, squash `099409ae2`): the staging flip, the first live turn and its fix, rule 11, RT-B8, the §12.1 checkpoint

**The flip.** Preconditions checked (migration 120's four tables on staging by introspection; Sentry rule 11 built; the merged PR's RLS/tenant-scope audits green), then `OWNER_OPERATOR_ENABLED=true` on staging on both lanes, owner-run because the harness reserves feature-flag writes: Railway worker 02:59Z (deploy SUCCESS 03:01Z, `/ready` green) and the Vercel `staging` Custom Environment 03:03Z through the REST API (`vercel env add` cannot target a Custom Environment) plus a redeploy (READY 03:04Z). Production stays off.

**The first live turn failed.** 03:11Z, `model_output_invalid` on BOTH pinned providers, two attempts each. Reproduced locally in minutes with the production prompt and a Tanicia-shaped snapshot: gpt-4o-mini answered `{scope_check, unsupported: "…"}`, claude-haiku `{operationId, proposedValue}` in a code fence. Cause: nothing declared the output shape — the LLM seam sends system + user text, hands no JSON schema to a provider, and validates with zod only after the completion arrives; prompt `2026-09-11.2` said "matching the declared schema" and declared nothing. Fix (`11e9b9940`): `OUTPUT_SHAPE` in the system prompt spelling `OperatorModelOutputSchema` (version `2026-09-13.1`); every proposable declares `inputShape`, projected as `allowedOperations[].input`; `prompt.test.ts` pins every key and segment type read from the schema (fails when the block is removed); `catalog.test.ts` pins each `inputShape` to the strict schema's keys. Re-verified live against both models, ridden to staging at 03:26Z.

**The §12.1 drive (after the fix, owner Tanicia Resort Testing).** Item 1 PASS: turn 2 in 8.95 s → `set_tone` Proposal with the full before/after → Apply → Receipt (`appliedAt 03:28:50.999Z`, before "professional and friendly", after "warm and brief", actor, verbatim request, turn reference), `businesses.tone` read back. Item 3 PASS: reload during "Preparing your plan" resumed the turn from the URL; repeat Apply answered 200 with the same `appliedAt`; resend under one `clientTurnKey` returned the same ids, a different text under it 409. Item 4 PASS: a touched `businesses.updated_at` → `stale` with Refresh plan; unknown id → 404; a bumped `contract_version` → `contract_changed`. Items 5 and 7 rest on the suites (claim race; Origin — staging's SSO gate answers from outside a browser). Items 2, 6, 9 wait on review traffic, a second location, the owner. Item 8: the auto-approval Apply path estimated in §13 at 14–16 h. Item 10: five completed turns — p50 8.38 s, p95 9.5 s, max 9.64 s, 3.3–5.5 s of each the outbox claim wait; reasons over 7 days: completed 5, `model_output_invalid` 1 (pre-fix). Constants unchanged with the floors recorded in `constants.ts`. The tone was restored through the Operator (a fourth Receipt).

**Also.** Sentry rule 11 built in both projects through the new alert builder (staging `3984512`, production `3984518`), verified via the API. Red-team RT-B8 closed (`dc1bf7b75`). Merged at 03:44Z; `staging` realigned to `main`.

**Open.** The auto-approval proposables and their transaction-aware writer (§13); the seam's missing structured-output contract and a live keyed eval case per structured task (§14); the OutboxPoller items CA1/CA4 from Run A.

**Lessons promoted to lab notes (`history/2026-09.md` 2026-09-13, T8):** a schema the model was never told is a prompt promise, not a contract — the keyless eval harness and the mocked unit suites cannot see it; the first live turn on staging is the first real test of any LLM task's shape.

## 2026-09-13 — Owner Operator Run C verification and release reference (#1278)

**Implementation.** The seven-operation catalog now includes the three policy dials. The shared policy writer participates in Operator Apply's transaction; account-before-proposal locking, parent/override tokens, exact stored confirmation phrases and fresh readiness checks precede the write. Immutable receipts preserve actual old/new rules, recomputed 30-day consequences, imported/unknown exclusions and retained approval-grant counts. Console (Harbor) cards expose those facts. Initial ingestion records provenance on the existing run spine; structured tasks deliver their registered schemas to both providers. No migration or production flag change accompanies this work.

**Verification.** Candidate `a8b934a69434476ce41d056c0d846b03129fe994` passed the full review gate: 15,911 tests passed, 11 skipped, with build, E2E and the required audits green. The fourth red-team report is CLEAR: 1,001 retained rows, 445 killed, 7 equivalent and 549 excluded. Its new work used 126 of 150 authorized local launches: 56 kills, 7 equivalents and 153 exclusions; the earlier report history remains intact. The final prompt correction and reviews used Codex under the owner's instruction against external Opus delegates; earlier implementation attribution remains in the historical feature evidence.

**Staging.** The first candidate failed account-off planning; that attempt remains recorded as FAIL. Prompt `2026-09-13.4` corrected the semantic failure. Matched UI/worker deployments of the reviewed candidate then passed three fresh real turns: all-locations off, Cafe clarification with Salon selected, and the weekend scheduling request. The ten-review fixture counted 8 included, 1 imported and 1 unknown; Apply persisted one audit, and the pending second tab returned the same receipt without another write. Actual 390px/1440px captures, stored state and all 25 zero-result cleanup checks are in the [acceptance evidence](runbooks/evidence/2026-09-13-owner-operator-run-c-evidence.md). The first Apply was desktop; the replay was mobile. No responses or connections were created. Staging retained-veto alert 3985600 is saved; live delivery was not exercised.

**Release boundary.** PR #1278 merged at 2026-09-13T19:22:35Z, squash `280d1b0137f4f5a3e2cd613abe7464238d0f665e`, after required CI passed with15,911tests/11skipped. Its tree matches the reviewed candidate. Both post-merge staging deployments pin that squash. The fresh390px Apply at19:30:09Z persisted eligibility5→0of8, veto15/cap2, retainedVeto0 and one audit; the receipt survived1440px reload. All25post-merge cleanup checks were zero at19:33Z, and the exact completed queue job and Auth identity were removed. Production remains off; §12.1's remaining human/traffic checkpoints and the COO owner-pilot record are unchanged. The provenance, semantic-eval and mutation-oracle lessons are recorded in the September lab history.

## 2026-09-14 — Owner Operator Run D merged (#1291, squash `fb91cd2f4a3769f5ac35227cf58751720d83b381`)

**Implementation.** CA1 couples winning outbox exhaustion to its stored tenant/conversation/turn through `reconcileTurnForFailedOutbox`. Live and contended claims defer safely; accepted or expired claims terminalize in the same transaction. The D-A1 correction makes aged exhausted `agent_turn` rows left in `dispatching` after rollback eligible for the existing watchdog. CA4 makes `releaseTurnClaim` fence both turn token and outbox attempt, including delivery before enqueue acknowledgement; healthy waits refresh liveness, and delay failures still reject for retry. `dispatch_exhausted` renders durable recovery wording and a new-conversation action. No migration, dependency, new production module, production enablement or flag change was made.

**Verification and review.** Final candidate `f2586bd101c22fecbce09c3f1ed64d9740d1a465` passed the full local gate: 15,978 tests passed / 11 skipped and 60 E2E passed / 108 skipped, with fingerprint `fa984d05f14ef341881978afeb38afb3247d1374c75d1426f1068d79e0ec8fc1`. Spec and standards reviews approved; accepted D-PS-1/2/3, D-A1 and prepared-runner D-RUN1 were fixed. Native Codex's final round-2 report is CLEAR: 278 retained identities, 102 killed, 176 excluded, no findings or waived risk. The second pass measured 92 cases with 191/200 launches; all 95 mutations were restored. The owner-approved final recording exception preserves the completed work grant in permanent admission history and leaves the risk-waiver list empty; it changed no checker or product source. The branch includes the explicitly bounded D verifier safeguards and their regression coverage. [Review reports](reviews/codex-owner-operator-run-d/) and [adversarial record](reviews/red-team/codex-owner-operator-run-d-7749f8/findings.md) retain provenance and limits.

**Staging and limits.** The original campaign's actual 390px/1440px journeys covered next-draft tone, pinned location and durable recovery. The owner's early close yielded 24/24 completed turns over 19h50m14.857381s (p50 6.838317s; p95 16.10373645s), explicitly `full_24_hours_elapsed=false`. The tone prompt was reconstructed from source inputs; its literal placeholder signoff remains a recorded quality limitation. The corrected candidate `091d86bc778480dfd3c2cbc9fbbf61017392bbe0` then ran on Railway `113ceb47-ac01-49fb-8f6d-fd50741c0b04` and Vercel `dpl_E9ncrTWQ96hvov9pmYxXPdsFGofM`. The actual deployed watchdog produced a matching terminal pair at 2026-09-14T19:17:47.567765Z; independent ten-scope cleanup was all zero at 19:18:21.401216Z. That fixture exercised the durable rollback state without model work, Auth creation, live outage injection or an alert-delivery drill. Original fixtures and follow-up fixtures were removed. [Evidence](runbooks/evidence/2026-09-13-owner-operator-run-d-evidence.md) owns detailed cleanup and post-merge deployment records.

**Release.** Required CI passed for the merged feature head. Architecture counter 1→2; a pass is not yet due. The separate documentation closeout precedes E. §12.1 item 9 remains BLOCKED-human; production enablement remains a human decision.

## 2026-09-15 — Owner Operator Run E #1293 merged; post-merge deployment/readiness PASS

Candidate `ba0c65bb3a3665ed10a6441d27917802819ad4c1` implements receipt-derived
Restore, Rules timeline, clear override and fenced durable policy refusals.
Corrective fixtures strengthen13 existing cases; finite verifier additions retain
the frozen388 records / 776 launches, earlier findings and round 2's 1,600-launch cap.
Closed semantic-warning diagnostics were independently corrected to a scalar
field retained by the actual logger, without prompt/validation/retry/billing changes.
The [E evidence](runbooks/evidence/2026-09-15-owner-operator-run-e-evidence.md)
records qualified J1–J7 PASS and exact cleanup:67 public rows, Auth/session scopes,
7 observed queue jobs and campaign tabs/viewport closed by approximately 10:34Z.
The original J5 failed turn remains separate from successful later recovery;
J6's direct GET key is uncaptured and blank J7 images are not visual proof.
Migration 121 applied in both projects; alert 3993328 is configured, delivery unproven.
Parent ba0c65bb full gate passed: 16,218 DB / 11 skipped, 14,903 ordinary /
1,316 skipped; build/E2E/checks PASS. Report-only fb66d15d changes two files
(195 insertions / 7 deletions), leaving application/test/configuration unchanged.
Final certification CLEAR: 2,437 identities = 361 killed + 2,076 excluded;
12 fixed / zero open / zero waivers. Round2 finalized 802 launches / 401 pairs;
record400's target-selection miss and same-ID second-attempt401 kill are retained.
Required CI34962247726 passed, deploy-install validly skipped; optional Fallow
failed (eight complexity findings / two clone groups). E2E34962247838 passed
30 / 54 skipped; Doctor34962247896 passed. Local post-report verification did
not pass: first four timeouts, then ten with 14,893 passed / 1,316 skipped in
1,280.09s; remaining wrapper checks stopped. The owner [approved the bounded exception](reviews/codex-owner-operator-run-e/release-verification-approval.md), accepting passing GitHub checks and the earlier full local pass on identical application code without declaring the failed local wrapper green.
Feature #1293 merged as `d4a96f3205bc1061cd03f6fe0bceb0eabb546ebf` at 2026-09-15T16:39:27Z.
Matched post-merge deployments and [post-merge readback](runbooks/evidence/owner-operator-run-e-2026-09-15/postmerge-readback.json) passed at d4a96f3: Railway SUCCESS16:49:36.554Z, Vercel READY16:42:55.421Z with staging alias, `/ready` HTTP20016:49:55.515Z, PostgreSQL/both Redis OK and named flags unchanged (production Operator UNSET). This documentation closeout publishes the remaining records; GitHub retains its PR and merge identity.
Architecture records 2→3 once for this feature; docs do not count. D docs #1292/30896acb closed the dependency;
its shortened observation and human pilot/production decisions are unchanged.

## 2026-09-19 — #1329 merged (#1337, squash `48ba6e4fb`): both release-scan fairness arms made exact; three red-team rounds

**What shipped.** The **Release cycle**'s P4 candidate scan (`selectReleaseCandidates`,
`src/lib/solicitation/release.ts`) is `ORDER BY approved_at ASC LIMIT 50` with both
account-level gates evaluated AFTER it, so an account the cycle always refuses held
candidate slots for its batches' whole 72h send window while every other account
released zero. #900's `capped_accounts` closed that for one gate, approximately. Now
both arms are exact:

- `account_unentitled` (new): a correlated `NOT EXISTS` on `accounts` binding
  `FULL_ACCESS_SUBSCRIPTION_STATUSES` — a new export in
  `src/lib/shared/subscription-status.ts` over which `subscriptionGrantsFullAccess`
  is now implemented. One owner, so SQL and TypeScript cannot disagree and `trialing`
  cannot be starved.
- `capped_accounts` (repaired): stops keying on `DEFAULT_DAILY_SEND_CAP_ACCOUNT`. The
  cycle reads configured caps once per tick (`readResolvedAccountCaps`), resolves each
  through `resolveAccountDailySendCap`, and binds `(account_id, cap)` pairs via
  `unnest`; the arm compares `COUNT(*) >= COALESCE(r.cap, <resolver's null branch>)`.
  `LEAST(configured, 10)` still has exactly one spelling, in TypeScript.

Both exclusions are counted from the same `eligible` CTE in amendment B6's order — the
second count carries `AND NOT account_capped`, so an account refused by both gates is
ONE withhold under `account_cap` — and both survive a tick with zero candidate rows via
the `LEFT JOIN … ON TRUE`.

**Files.** `release.ts` (arms, `readResolvedAccountCaps`, `capBindArrays`, retained
`readAccountDailySendCap`, second withhold count) · `subscription-status.ts` (+ the
exported array) · `scripts/ci/tenant-scope-allowlist.ts` (+2 entries, `ALLOWLIST_BASELINE`
380 → 382) · `release.integration.test.ts` (53 → 68 executed cases) ·
`subscription-status.test.ts` (+1 pin). No migration, flag, dependency or new writer.

**Two premises the review destroyed.**

1. **#900 round 2's "unreachable today" was false at HEAD.** It deferred the sub-default
   cap because "no TypeScript writes `daily_send_cap`". `upsertSolicitationAccountDefault`
   (`src/lib/auto-approval/solicitation-settings.ts`) writes it via
   `PATCH /api/settings/auto-approval`, `DailySendCapSchema` admits 1..50, and LOWERING
   the dial is an exposure contraction that passes no readiness gate — so only the
   autonomy flags stood between the gap and production. Found by building the tripwire
   meant to guard the premise; it fired on the settings lane immediately, and was then
   deleted as pointless once the arm became exact.
2. **A snapshot cannot authorize a send.** The first cut ALSO deleted the per-account cap
   read and served the gate from the tick's snapshot, arguing arm and gate could then
   never disagree. Codex review showed the cost: nothing downstream re-checks the cap,
   so an owner contracting the dial mid-tick was obeyed one tick late. The read stays.
   The arm is a DISCOVERY bound; the gate is the AUTHORIZATION. The lane therefore issues
   ONE statement more per tick, not fewer — three documents claimed the opposite and were
   corrected. A second review axis simultaneously asked to finish the de-duplication,
   which would have deepened the regression; reading the whole findings table before
   fixing anything is what caught it.

**Review: 4 axes, 3 red-team rounds, 16 findings.** Round 1 (wave): Codex `REVISE` + 2 P0,
4 P1, 3 P2. Round 2 found **two new P0s in round 1's fixes** — `pnpm lint` broken by the
fix itself (a dead import after both uses were replaced; `lint` is a required check), and
the restored gate read's `WHERE` unpinned, where dropping `account_id` or
`location_id IS NULL` each survived 66 green cases. Round 3 (owner-granted, because
`round-start` caps rounds at two and round 2's fixes moved HEAD past the pass that
reviewed them) held all 14 fixes and found one more P1 — in the orchestrator's own
authorization entry, which failed the checker's schema. Final status CLEAR: 24 inventory
rows, 15 fixed, 1 P2 open by choice (the duplicate-row `throw` guards a state migration
074's unique index makes impossible).

**Two tests that proved nothing, and how.** The "lockstep pin" derived its expectation
from `subscriptionGrantsFullAccess`, which is now implemented OVER the array under test,
so dropping `TRIALING` moved both sides and passed; it now pins against literals. The
cap-gate case expected `released: 2` under the default `perTickBudget`, which is also 2,
so the BUDGET satisfied the assertion; it now passes `perTickBudget: 10`. Reaching either
per-account gate at all needs a mid-tick change, and the seam is subtle: `runAccountArm`
reads the cap BEFORE counting attempts, so the cap case drives its change from a SIBLING
account's count while the lapse case correctly uses its own. Five mutants were re-measured
after fixing; each fails exactly the case named for it.

**Staging.** Rode `staging` at `5d10e341b` before the PR. The worker booted and the
release cycle logged `Release cycle complete` with `releasePhaseStoppedBy: null` and
`itemFailures: 0` — so the scan actually ran, and the `unnest` bind with BOTH arrays
empty (the production case) executed without error. Staging realigned to `main` after
merge; `staging == main` at `48ba6e4fb`, zero drift.

**Two process traps, both already documented as lab notes.** `gh pr checks` reported no
failures while **no CI run existed at all** — the draft→ready transition raced the push
and the surviving run carried `draft: true`, whose jobs skip; merging `origin/main`
produced a `synchronize` event and the real run (all checks green, `test` included).
And `red-team-status.mjs` binds its evidence to a TREE, so appending to the triage record
after the final round broke the `reviewed` transition — everything except the sidecar must
be committed before the last round opens.

**Named residual.** These arms exclude ACCOUNT-level refusals only. A mid-drip
`auto_policy` batch held by a failed auto condition still holds its slot until P2
terminalizes it at 72h (`release.ts:1854`, `applyDowngradeSplit` returns `held` and
changes nothing), so the candidate window is not generally starvation-free — a cursor or
rotation is a separate ticket. `release.ts` is 2121 lines and `selectReleaseCandidates`
its most complex function; extracting `release-candidates.ts` is justified and deferred
because the tenant-scope allowlist is FILE-keyed and would re-key all seven release
entries in a PR `refactor/616` is already touching.

**Shipped with one known red row.** The local `pnpm test` fails one unrelated
pre-existing case (`red-team-mutation-runner.test.ts`, filed as #1334) which passes in
CI; the owner's call was to ship on CI's verdict for that row rather than mix a tooling
fix into a high-risk solicitation PR. Every other local row was green.
