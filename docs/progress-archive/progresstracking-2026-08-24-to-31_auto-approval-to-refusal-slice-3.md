# progresstracking.md — archived history 2026-08-24 → 2026-08-31

Archived verbatim from [../progresstracking.md](../progresstracking.md); never edited or summarised.

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
