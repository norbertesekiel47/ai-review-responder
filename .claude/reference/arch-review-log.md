# Architecture review log

Entropy counter for the `/feature` workflow (feature.md step 8): every merged
feature increments the counter. At **≥ 5 merges** since the last architecture
pass, the orchestrator reminds the user to schedule an architecture review
session (the user's call — never started automatically). A completed pass
resets the counter to 0 and adds a row below.

**Merges since last architecture pass: 1** — last reset to 0 by the
**2026-08-26 pass** (entry at the bottom of this file). Full artifacts:
`docs/reviews/PATHFINDER-2026-08-26/`.

> ## The counting rule is under repair — do NOT hand-count this file until H7 lands
>
> The 2026-08-26 pass measured the prior window at **12** against a stated 8,
> and established that this file **cannot be counted reliably as structured
> today**. Four reasons, all measured:
>
> 1. **Two accepted locations** — the bullet list and the bottom table.
> 2. **No stable key.** Entries appear under PR number, issue number, branch
>    name, or bare prose. `rg '#962'` and `rg '#954'` both returned **0** for
>    merges that counted.
> 3. **The audit's trigger is WIDER than the counting rule.** `ci:merge-ledger`
>    fires on production **OR GOVERNANCE** files; the rule counts production
>    **only**. #957, #960 and #961 were each *required* by CI to add a line and
>    each must **not** increment. They sit in the bottom table beside merges
>    that do count, unmarked. **PR #980 is the newest example** — governance
>    only, correctly left a row, correctly counts zero.
> 4. **"Lines added" is not a unit** — it ranged 1 to 36 per merge.
>
> **The instruction that stood here — "resolve it by COUNTING THE LINES BELOW …
> the lines are the only source that cannot drift" — is UNSOUND and has been
> deleted.** The lines drift relative to the rule by construction, for reason 3.
>
> **The fix (handoff H7):** one owner — the bottom table — keyed by **merge
> SHA**, with a `counts` boolean set by `isProductionFile`
> (`scripts/ci/merge-ledger-audit.ts:87`), a classifier the audit already
> computes on every run and discards. Then the counter is a query, not a
> judgement.
>
> **Correcting the record:** the 2026-08-24 pass reported this counter correct
> for the first time in five passes and credited `ci:merge-ledger`. That audit's
> own header (`merge-ledger-audit.ts:39-43`) explicitly declines to own the
> number. **The audit works exactly as designed; the counter was never in its
> scope.** Six passes, six wrong counts, is the expected output of the current
> design — not a discipline failure.

Prior passes: `PATHFINDER-2026-08-24/`, `-08-22/`, `-08-18/`, `-08-15/`, `-08-10/`.

Merges since the 2026-08-26 pass:

- 2026-08-26 — `chore(tooling)` (#980): destructive-git guard, plan
  pre-validation, `/preflight` skill. **Governance-only — DOES NOT COUNT** by
  this file's own rule (zero non-test files under `src/`, `worker/`,
  `supabase/`). Its ledger row is at the bottom of this file. Recorded here
  explicitly because it is the exact case reason 3 above describes: required to
  leave a trace, required not to increment, and indistinguishable from a
  counting merge until H7 lands. Its own row also names a **sixth**
  enumerated-scope instance for this pass's census — `GOVERNANCE_PATHS` covers
  `.claude/skills/` and `.claude/hooks/` but **not** `.claude/commands/`.

---

Merges since the 2026-08-24 pass — **CLOSED by the 2026-08-26 pass.** Retained
verbatim as record; these are the 8 bullets that stood against a measured 12.

- 2026-08-26 — `fix-967-post-purge-global-optout` (#975): the Solicitation
  lane's unmatched-attribution arm. A suppression-bearing Resend event whose
  `solicitation_outreach` row is gone now writes the recipient's GLOBAL opt-out
  from the SIGNED payload with `accountId: null` and acks, instead of throwing
  into a retry that could never succeed. Full detail in the table row at the
  bottom of this file. **Three notes for the next pass, none of them about the
  fix itself:** (a) the change removed these events from
  `checkFailedInboundEvents`' `status='failed'` set — **silently retiring an
  operator pager, which no gate can detect** and which only the step-7 review
  caught; the replacement is a `captureMessage` at the source, and the general
  rule is now in lab-notes. (b) The `reclassify` WARN fired at 211 vs 90
  estimated production lines while the work had NOT sprawled — 6 of 6 declared
  files, one seam, ~64 executable lines, 55% of the additions comment in a file
  already 55% comment. **The trigger measures a proxy that this repo's comment
  density defeats**; consider splitting the estimate into executable vs comment,
  or the next honest small change will trip it too. (c) `ci:merge-ledger`
  accepts a line in EITHER this bullet list or the bottom table, which is how
  the counter above drifted — see the correction note.

- 2026-08-25 — `feat-landing-mobile-carousel`: phone card rails for landing
  sections 2–5 (owner-directed). New shared `carousel.tsx`/`carousel.css`:
  below 767px the fleet's two tiers, the persona grid, the watchtower grid and
  the committed grid become CSS scroll-snap rails with a dot indicator. The
  four sections went 6,891px → 4,010px at 390px wide, measured. **Desktop is
  untouched by construction** — the rail restyles the container each section
  ALREADY renders rather than adding a wrapper, so no desktop rule moves.
  Four notes for the next pass: (a) the rail selector is 0,2,0 to tie with
  `.rw-lp-fleet-tier[data-tier='watchdog']` and `carousel.css` must stay the
  LAST landing CSS import — a load-bearing ORDER dependency, the second in this
  file after `agent-flip-card.css`'s, and neither is mechanically guarded;
  (b) the slides carry `opacity/transform: !important` because `Staged` gates
  each card on 30% of ITSELF being in view and a peeking card shows ~15% —
  motion writes those inline, so `!important` is the only reach; (c) the dots'
  overflow test measures the SLIDES, never `scrollWidth`, after the committed
  card's `inset: -0.875rem` glow put 570 into `scrollWidth` against a 556
  client width and rendered a hidden dot row into the desktop DOM; (d) adding
  the CSS import pulled `LandingExperience.tsx` into the fallow gate's scope
  and exposed `LandingChrome` at 0% coverage (CRAP 56) — fixed with a real
  test, not a suppression, but it is worth noting that a ONE-LINE import edit
  is enough to surface an inherited complexity finding as a PR blocker.
  4 new files, 13 modified; focus test 17 → 18 controls; landing
  measurements.md + directory.md updated.

- 2026-08-25 — `fix/887-adr-citations`: the no-internal-id posture on the
  Requests surface was cited to **ADR 0012** in four places. ADR 0012 is the
  sentiment-blind withhold enum and says nothing about internal ids; the real
  provenance is the #629 round-2 review, finding F10. A false citation is worse
  than none — it sends the reader to an authority that does not support the
  rule, and the honest conclusion from there is that the rule is unsupported.
  `halt/route.ts` and `approve/route.ts` now cite F10 directly and state that
  they ARE the precedent `regenerate`/`withdraw` cite, so the four route
  comments stop forming a circular reference. Two notes for the next pass:
  (a) the issue named TWO sites and a filename grep found **four** — the extras
  are `approval-routes.test.ts:398` and `docs/directory.md:130`, the latter
  being the interesting one because it conflated two DIFFERENT rules under one
  citation (no star rating, genuinely ADR 0012; no internal id, F10), and the
  half that was right is precisely what made the half that was wrong look
  sound; (b) nothing mechanically ties a comment's ADR reference to that ADR's
  subject, so this class is invisible until someone follows a citation.
  Comment and docs only — no behaviour change, no test change.

- 2026-08-25 — `fix/892-purge-sentinels`: the account purge's tombstone writer
  and its verifier agreed because two humans typed the same strings twice each
  — the 2026-08-18 pass's W7. New `src/lib/account-offboarding/purge-sentinels.ts`
  owns them; both sides compose their own predicate from shared VALUES, keeping
  the writer's `=` and the verifier's `IS DISTINCT FROM` visible at the call
  sites. No shared SQL fragment builder (it would need an `Sql` param and hide
  that asymmetry), and the `SET` clause and `OR`-chain stay two lists.
  **Four notes for the next pass, three of them corrections to the issue:**
  (a) the issue tallies SEVEN duplicated pairs; there are **eight** —
  `accounts.flags = '{}'::jsonb` is absent from its table while its own count
  discussion names `flags` as a restored default. Eight pairs, nine members
  (the email is one pair in two fragments). (b) the operator standardisation
  covers **nine** sentinel comparisons, eight converting — including the two
  `NOT LIKE` sites, which carry no `%`, `_` or backslash and were therefore
  equality checks written as pattern matches. The rule is not stylistic: this
  gate is fail-closed and its predicates sit in an `OR`-chain, where a
  three-valued predicate reads as "not a violation" and OPENS the gate, so `<>`
  made correctness depend on today's `NOT NULL` constraints. (c) the issue
  names two places stating the count wrongly; there are **four** — plus
  `purge-verification.ts`'s `archived_at` comment ("the only NON-residue
  predicate"; it is the only PRESENCE check) and `directory.md`'s claim to
  cover "every column the tombstone `UPDATE` writes", which is false because
  `updated_at` is written and deliberately unverified. (d) **the counts are now
  PINNED** — 28 predicates and their 5/1/22 split in `purge-verification.test.ts`,
  29 writer assignments in `PurgeWorker.test.ts`, both mutation-verified. This
  issue exists because 27 rotted unpinned, and the first cut of the fix
  replaced it with four fresh unpinned numbers; lab-notes "An exact count
  written into a comment is a maintenance trap" caught it in review.
  Runtime coverage cannot catch a missed operator conversion — every column but
  `tone` is `NOT NULL`, so both operators behave identically against a live
  database — so the two new properties read the SQL the module EMITS, not its
  source text. Prerequisite: the suite's `mockSql` was a bare `vi.fn`, so
  introducing `exec.json` crashed 8 tests before they could fail informatively.

- 2026-08-25 — `fix/895-truth-tripwires`: five independent fixes from the
  2026-08-18 pass's H6 bundle — (a) the admin batch panel read
  `HALT_REASON_LABELS[haltReason]` unguarded, and #917's `platform_halt` made
  the **Halt reason** union six-wide, so a browser cached behind that deploy
  rendered `Stopped <date> — undefined`; (c) the purge's suppression contract
  still claimed `recordSuppression` had zero production callers; (d) the
  agent-spine delete comment; (e) `recordFailure`'s log omitted `business_id`
  where its four siblings carry it; (f) `auth-island.css` redeclared 8 Island
  colours and 2 brand fonts, the fonts already diverged — this pass's own X10
  finding. (b) shipped in #920/#900 and was not touched.
  **Three notes for the next pass, all about the issue text being wrong:**
  (i) #895(d) is wrong TWICE. Its "moving `agent_runs` earlier inverts an order
  three other files depend on" is over-broad — `runContentPurgeStage` takes both
  per-business advisory locks ~110 lines ABOVE the delete, so any position after
  the loop preserves `advisory → batches row → agent_runs`. AND the rationale
  already in the file — "deleting runs first would only orphan them" — is
  FALSE: the outcomes delete is scoped by `account_id`, not `agent_run_id`, so
  runs-first would merely NULL the FK (071:71) and still remove every row.
  `PurgeWorker.test.ts` pinned that non-constraint with an index comparison
  while the REAL constraint went unguarded; the assertion is now
  lock-before-runs and the mock returns a business row so the loop executes.
  (ii) #895(c)'s "Resend retries forever" is refuted by the lane's own
  docstring — `verifySignature` 401s every attempt past the 300s window before
  lane dispatch. The real residual is that a post-purge bounce cannot write the
  global row to the **Suppression ledger**, because `loadAttribution` reads the
  **Normalized handle** from our own contact row and the purge deletes it.
  Filed as **#967** (go-live blocker) rather than patched: the obvious fix
  contradicts a tested invariant that the lane never normalizes the
  provider-echoed recipient. (iii) the contract now points at
  `recordSuppression` as the one chokepoint instead of enumerating four call
  sites — a hand-maintained census is the drift that went stale here.
  9 files; four new assertions, each mutation-verified RED before trusting it.

- 2026-08-24 — `feat-landing-sections-revamp`: landing sections 2–7 revamp
  (owner-directed). New shared `Staged`/`StagedLine` primitive (hero-entrance
  grammar page-wide — motion-driven finite beats, pause-rule-immune,
  `initial:false` reduced motion); fleet assembles on arrival (wire draw-in via
  motion `pathLength`, measured elements enter opacity-only) with hover
  wire-highlighting; watchdog rows gain an avatar stage + front rule plate
  (`frontRule` on the shared flip card, teal graduates to a channel token);
  tiers dial is now a circular OPERABLE gauge (v4 — two `aria-pressed`
  buttons, sprung needle via endpoint math after a CSS-rotate-on-SVG origin
  bug); problem section pairs a trimmed essay with a generated ambient diagram
  clip (clip count 8 → 9); future cards open with a generated off-CRT still.
  One header grammar (prose left / instruments centered, shared scales). 19
  production files + `staged.tsx` + 2 asset folders; focus test 14 → 16
  controls; landing DESIGN.md/measurements.md rewritten for all of it.

- 2026-08-24 — `fix-flip-card-touch-latch` (#955): landing flip-card input fix.
  The agent card's `:hover` flip arm is gated to `(hover: hover) and (pointer:
  fine)` — sticky tap-hover latched a flipped card on every touch device: the
  tap that set `data-flipped` back to false left `:hover` holding the card
  flipped, so a second tap could never restore the front. The click toggle is
  gated to non-hover devices for the mirror reason (a desktop click latched
  the card flipped after the pointer left). 2 production files
  (`agent-flip-card.{css,tsx}`); flip-selector contract lines updated in
  landing DESIGN.md + measurements.md.

- 2026-08-24 — `feat-landing-elevation` (#953): landing-page elevation. Sections
  6 (The problem, reputation-wide framing) and 8 (Copilot vs Autopilot, the
  dial-track) built; section 7 deliberately NOT a section — the watchdogs
  section ends with a gold door to `/how-it-works` instead of retelling the
  pipeline. Hero five-beat arrival, bookend push-in/settle on internal zoom
  layers (owner override of part of the 2026-08-16 Linear pass; accent contrast
  re-measured at ~3.35:1 worst case), tiers thumb breathe. 15 production files,
  all `src/components/sections/landing/**` + 2 test files; landing
  DESIGN.md/measurements.md updated (14 focus rings, three infinite animations).

- **#632** — `review_attributed` shadow attribution. Migration 114 adds four
  evidence columns to `solicitation_outreach`; a pure two-rule name matcher
  attributes a newly ingested review to at most one Outreach row and **abstains
  on ambiguity**; a new `solicitation_attribution` outbox topic and worker run
  the lookback off the ingest transaction; the Requests surface gains a 30-day
  section. The metric is **shadow and never billed**. Three notes for the next
  pass: (a) `attribution.ts` is a new **review-subject** spine writer, now in
  `outcome-anchor-pairing`'s `CALLER_ALLOWLIST` with an in-file `reviews FOR
  UPDATE` — the plan imported `recordOutcome` by name and neither it nor four
  review rounds caught the attached lock contract; only the full-suite gate did,
  which is an argument for running it before the last task rather than after;
  (b) the "already attributed" marker is `attributed_at`, never
  `attributed_review_id`, across four sites, because the FK is `ON DELETE SET
  NULL`; (c) migration 114 is **LOCAL-ONLY** — not applied to staging or
  production, so `migration-immutability-guard.sh` does not yet protect it.

> **The counter was CORRECT this time — the first pass in five for which that is
> true.** The 2026-08-24 pass measured its window independently
> (`42a247b1..0278366c`: 13 first-parent merges, 11 counting, 75 production
> files) and got the same answer this log already carried. `ci:merge-ledger`
> (`2f386c52`, PR #935) landed inside that window and is the reason. The
> four-pass streak of hand-corrections — 2026-08-10 (3 missed), -08-15 (#803
> invisible), -08-18 (read 8, measured 11), -08-22 (four missed, incl. #905 at 51
> files) — is **closed**. Do not re-derive that streak next pass; verify the
> current window and move on.

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

- **Architecture pass — 2026-08-24** (windowed: `42a247b1..0278366c`; 13
  first-parent merges, **11 counting**, 75 production files). Artifacts:
  `docs/reviews/PATHFINDER-2026-08-24/`. **Counter reset 11 → 0.**

  **Window shape:** one merge is 64% of it — #950/#631, the Solicitation
  auto-approval lane (48 files, migration 113), landed hours before the pass.
  The rest is the admin consolidation wave (#880/#886/#893/#909, 19 files) and
  the send-lane vocabulary work (#890/#891/#913/#914). Excluded: #948
  (governance-only) and #942 (test-only).

  **Health baseline: 20/20 CI audits, `typecheck` and `lint` all green.**
  Migration lockstep verified by direct `pg_indexes` introspection in **both**
  projects — 112 and 113 fully applied, no drift. The standing 078-absent
  exception was re-introspected in production and is **accurate, not stale**
  (`businesses.subscription_tier` nullable; neither check constraint present).

  **Headline — the notice-family clone, decided.** The family has **six**
  members, not the four the seed claimed (`autonomy-suspended-notice` was
  omitted; `worker/jobs/notification/` is the progenitor). Decision: **bless the
  four-file shape, extract the invariants.** A shared `runNoticeJob` owner is
  explicitly REJECTED — every current member assumes a single `businessId`, and
  the next plausible member (Insights / Governor) needs account-scoped fan-in, so
  extracting today encodes the wrong axis. Three latent bugs, all of the form
  "the fix landed in some copies":
  - **BUG 1** `auto-post-notice` enrolls in `OWNER_DIRECTED_TEMPLATES`
    (`resend.ts:97-99`), so a bounce **sets** `owner_email_bounced` — but it is
    the only member of six that never **reads** it (0 references vs 7–8 in the
    other five). Identified 2026-07-12 as "known follow-up #3a";
    `grep -rn "#3a" docs/` returns one hit, the sentence itself. Six weeks live,
    untracked.
  - **BUG 2** `auto-post-notice` and `escalation-notice` lack the 15-minute
    stale-claim reap the other three have **and** read a claim conflict as a
    harmless dedup. One crash dedup-blocks a channel permanently while the outbox
    reports success — losing the Guardian persona's only owner-facing output.
  - **BUG 3** three members run the provider error classifier on Postgres errors
    and can mark a delivered notice failed. The two newest members carry a
    written warning about exactly this.

  **Second finding — the autonomy control surface is split.** Two independent
  kill-switch families now exist; `AUTO_APPROVAL_ENABLED` has **zero** effect on
  the Solicitation lane. Scoped honestly: `env-vars.md:661` is correct per-flag,
  invariant #3 is **not** violated (that lane does not post to Google), and
  production has none of the flags set — **zero live hazard**. The gap is that
  the runbooks enumerating "the autonomy flags" predate this lane. **Must close
  before #633 flips anything.**

  **Seed 3 REFUTED — a clean result, recorded as such:** the four admin
  consolidations compose cleanly. No file imports from more than one of the four
  seams; three stack in disjoint layers and the fourth (`#886`) is on the owner
  surface, unreachable from any admin route.

  **Prior handoffs: five of nine genuinely closed** (#890, #893, #896, and both
  08-22 next-session PRs). #891 is closed but incompletely adopted — **latent,
  not a live defect**; a first reading called it live and the correction plus its
  reasoning are preserved in `07-handoff-reverification.md` rather than deleted.
  #892, #894 and #895 are untouched across two consecutive windows and
  re-verified still live. If they survive a third, close them as won't-fix rather
  than re-derive them a fourth time.

  **Five DO-NOT-UNIFY entries added**, including a boundary correction: the
  21-line offboarding SELECT appears in **18 files repo-wide**, so it must NOT be
  extracted into the notice family — if extracted it belongs at
  `src/lib/account-offboarding/gate.ts`.

  **Process note:** a follow-up named only in spec prose is not tracked. `#3a` is
  the proof. Suggested rule — a follow-up named in a spec gets an issue number in
  the same PR, or it does not get named.

- **feat — `/feature` run progress + the Claude/Codex review record** (2026-08-23).
  **Governance-only: this merge changes no file under `src/`, `worker/` or
  `supabase/`, so by this log's own rule it does NOT increment the counter,
  which stays at 10.** It lands here because `.agents/skills/` is on the
  `ci:merge-ledger` governance surface — which is the point of that audit: the
  #905 blind spot was merges that leave no trace, not merges that count.
  Six new files under `.agents/skills/feature/`, three edited. A run now prints
  an 8-step ladder at every phase boundary and on resume, and serves a
  loopback-only page carrying that ladder, a findings ledger with ACCEPT/REJECT
  verdicts, and the Claude/Codex review stream; `snapshot` writes the same page
  as an Artifact fragment for a shareable record. **Ownership is the design:**
  `progress.json` holds only the ladder and tracers — `state.json` keeps phase,
  branch, SHAs and review counters, and the gate files keep gate truth, so the
  new file duplicates nothing (pinned by a gate that fails on any `state.json`
  key appearing in `progress.json`). Codex output is never copied: the
  transcript stores a POINTER to the companion's job files, leaving the
  companion the single owner of its verdict, findings and log.
  `lib/feature-snapshot.mjs` is the one merge point for all three readers.
  **Verified under a 31-gate ledger against a real adversarial-review job,
  which found four defects in this code before it landed** — a self-carry guard
  that missed symlinked paths (`resolve` does not follow symlinks while git
  returns the root resolved), a failed `start` that orphaned a listener `stop`
  could never reach, a stale registry that could SIGTERM an unrelated process
  after pid reuse, and a cross-round triage that published a REJECTED finding
  as ACCEPTED. Two of the sweep's own tests were also wrong and are recorded
  because a test that lies is worse than none: a `die` inside a subshell let a
  case print OK with three assertions failed, and the docs-coverage gate probed
  commands by EXECUTING them, so it started real servers on port 7717.
  **Known collision, not resolved here:** `codex/feature-workflow-hardening` is
  a parallel, almost entirely uncommitted hardening of this same skill
  (`tracer-ledger.mjs`, `review-findings.mjs`, `durable-store.mjs`) that would
  give tracers, findings and durable reads a second owner. It edits the same
  three documents. Someone must choose before it lands.

- **refactor #880** — `useAdminActionForm`, and all five admin surfaces migrated
  in one change (2026-08-23; surfaced by #865's branch review, standards axis).
  The `useReducer` + 7-to-9-member action union + switch + `initialState` was
  copied across `ImpersonationStartClient`, `CsvImportClient`,
  `ManualRankingSection`, `PastDueExtensionPanel` and `SolicitationBatchPanel` —
  the five `rg 'submitStart' src/app/admin` returns, matching Pathfinder X7's
  count rather than a guess. **X7's "blocking design decision" was understated
  and is now resolved rather than dodged.** X7 records it as `success: boolean`
  vs `message: string | null`; measured across all five the success channel is
  FOUR things — a boolean flag, a message string (×2), *nothing at all*
  (impersonation navigates away), and a whole `CsvImportReport`. So it is a TYPE
  PARAMETER, not a unified field: `TOutcome` defaults to `never`, which makes
  `succeed` uncallable on the form that has no success, checked by the compiler
  instead of by a comment. Flattening all four to `string | null` would have
  cost the CSV report its structure and given the impersonation form a channel
  it must never populate. **Two things deliberately stay in the surfaces**: the
  fetch (five bodies, five response shapes, five failure sentences — a hook that
  owned them needs a config object per surface, the knobbed-helper shape this
  repo rejects), and `CsvImportClient`'s SECOND error channel
  (`validationErrors`), which is one surface's affordance and would otherwise be
  an array four surfaces never set. Ordering is preserved exactly: `clearOutcome`
  before validating so a refusal shows while the button still reads its idle
  label, and `stop` clearing only `busy` so a `fail` raised inside the body
  survives the `finally`. 16 hook cases; 348 admin tests green and UNTOUCHED.
  **Counts: +1 production merge.**
- **refactor #886** — `ApprovalPanel.tsx`'s lane-write seam extracted to a
  sibling `lane-writes.ts` (2026-08-23; deferred from the #872 branch review,
  standards finding #1 — the only *major* finding on that branch, rejected as a
  blocker THERE and accepted as a follow-up). Unblocked because #865 and #872
  both landed: nothing else edits the file, and there is no locked
  `allowed_edit_surface` to widen. **1,123 → 703 lines**, back under the 1,000
  the thermo-nuclear review treats as a presumptive blocker. What moved is the
  whole `── The write ──` section that already read as a seam — `LaneStatus`,
  `LANE_REFUSAL_COPY`, `NOT_REGENERABLE_COPY`, `postLaneAction`, the four
  `Announce` sentences and `useLaneWrites` (which now owns FOUR writes, and that
  is what pushed the section over). `LaneWriteOutcome`/`LaneRefresh` are exported
  from the new module rather than the panel, and `RequestsClient` imports them
  from there — they are the write's vocabulary, not the panel's. `countPhrase`
  moved with them: the panel's prose reads it too, and leaving it behind would
  make the new module import from its own importer. **The line falls where it
  does on purpose**: the panel's other three hooks (`useExcludedAsks`,
  `usePendingRegeneration`, `useArmedWithdrawal`) are about what is on SCREEN
  and stay; the write seam is about what is on the WIRE. The docblock's "one
  file-local hook each" claim was corrected rather than left true-ish — three
  are file-local, one is not, and the reason is written down. **Behaviour frozen
  and proven so: the requests `__tests__` directory is 83 green, UNTOUCHED** (a
  test needing an edit would have been evidence the move changed behaviour).
  `docs/directory.md` gains the row in the same PR. **Counts: +1 production
- **refactor #909** — the admin gate→parse→400 preamble extracted, AND
  `ci:admin-aal2` widened by one gate shape, in one PR (2026-08-23; follow-up
  B3.11 from #898). `requireAdminJson(request, schema)` composes
  `requireAdminWithAal2` inside `src/lib/auth/admin-mfa-gate.ts` — no new file —
  and `admin/autonomy/unsuspend`, `admin/solicitation/batch/halt` and
  `admin/solicitation/breaker/reset` now call it. **The audit change is the half
  that makes this legitimate**: `GATE_JSON_FN` is a THIRD recognized gate shape,
  credited only when bound by an import that RESOLVES to the canonical module,
  with the fail-closed posture unchanged — a different wrapper from the same
  module is still a finding. **Branch review then found the provenance check
  itself was weaker than its own header claimed**: it matched the trailing path
  segment, so `@/evil/admin-mfa-gate` was credited and any file could mint gate
  credit by choosing a filename. `resolveSpecifier` now maps the `@/` alias onto
  `src/` and resolves a relative specifier against the importing file. Two of the
  audit's OWN fixtures had been spelling relative depths that do not resolve and
  passing on the basename alone — the loose check was already costing accuracy
  before anyone abused it. The identical extraction was built and reverted during #898
  step 8 for want of exactly this half; **the revert was correct**, and the
  lesson recorded in lab-notes [2026-08-21] stands for the next preamble. The
  `.fallowrc.jsonc` acknowledgement is removed and `ci:fallow` is green without
  it (8 changed files, 0 duplication findings). 9 new audit cases pin both
  directions of the widening; 7 new helper cases pin that both 400 shapes and
  the gate's own 401/403/500 arms are byte-identical to what the three routes
  spelled by hand. No route test needed editing — they mock the auth PRIMITIVES,
  which is the shape lab-notes [2026-08-21] prescribed after the first attempt.
  **Counts: +1 production merge.**
- **fix #893** — the admin read fan-out bounded, and the enumerated pins replaced
  by a rule (2026-08-23). **Part 1 grew from two subjects to four**: the ticket
  named `lookupSuppressions` (`suppressions-service.ts:72`) and
  `getAdminNotifications` (`notifications-service.ts:137`); this change also found
  the cost-report rollup branch (`cost-report-service.ts:321`, two templates) and
  `processRow` (`csv-import.ts:301`, THREE reads built from helper calls, so
  nothing in the expression mentioned `sql` twice). All four now sequence; the four
  services' own suites are green untouched, so the fix changed no behaviour.
  **Part 2** is `ci:pool-fanout` (`scripts/ci/pool-fanout-audit.ts`, wired into
  ci.yml's `lint` job and `lefthook.yml`): an AST rule over
  `src/lib/{admin,dashboard,locations}` failing any `Promise` combinator with ≥2
  DB-issuing elements, counting tagged templates, `sql.unsafe(...)` **and calls
  that pass a `Sql` binding** — the third form is what a tagged-template-only rule
  would have missed on subjects B and D. Fail-closed on an unreadable argument;
  the escape is a reasoned per-site pragma with zero uses today. **The four
  existing pins were deliberately NOT widened, and no per-service pin was added** —
  four fixes plus four new pins would rebuild the enumeration one directory
  further apart. **Branch review then found the classifier was ITSELF an
  enumeration, one level down**: it matched a hand-listed set of top-level
  shapes, so a logical operand, a query wrapped in a call, and a query inside a
  thunk each counted ONE and passed. It is now a SUBTREE scan — find the query
  wherever it is — and the thunk carve-out is gone, because `settledInOrder` is
  not a `Promise` combinator and never reached the scan anyway. Three boundaries
  are stated in the audit header rather than implied: the root excludes
  `src/app/**`; the deferred-await form (`const a = getA(sql); const b =
  getB(sql);`) is not covered, because the syntactic proxy for it collides with
  the legitimate fragment builders; and the fail-closed cost is ACCEPTED
  explicitly — a `Promise.all(tasks)` with no DB work in it is reported too,
  because the audit cannot tell it from an unbounded `.map` fan-out. The
  ticket's named `src/app/api/admin/jobs/route.ts:27` exception is a recorded
  DEVIATION, not an omission: that file is outside the root and is one DB call
  plus one Redis call, so the ≥2 rule cannot reach it. **Counts: +1 production
  merge.**
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
- **feat #631** — Auto-approval lane: Autopilot batches behind flag, Judge-gated,
  veto-windowed (2026-08-23, branch `631-auto-approval-lane`, PR #950; **merged
  2026-08-24, squash `0278366c`** — migration 113 applied staging+prod in lockstep
  the same day). Post-PR fallow fix wave added `src/lib/auto-approval/settings-guards.ts`
  (breaks the settings ↔ solicitation-settings cycle — one new single owner of the
  settings write-guards) and two `.fallowrc.jsonc` `ignoreExports` acknowledgments;
  next pass: the notice-family clone shape (4 instances now — escalation/pending-post/
  auto-post/veto) is at the extract-or-bless threshold. One new deep module `src/lib/solicitation/auto-approval.ts` (four-condition
  gate D20 + account-wide Governor read D19, `auto_policy` approval verb at the
  ask-generation finale, **Veto anchor** on first-sent notice, release-time re-check
  with reason-parameterized downgrade split); new `worker/jobs/solicitation-veto-notice/`
  family (pending-post-notice clone); migration **113** (index-only: veto-notice outbox
  in-flight + delivery-claim); `SOLICITATION_AUTO_APPROVAL_ENABLED` (default OFF
  everywhere — lands inert); settings opt-in operations + Solicitation card on
  /settings/auto-approval. Three-round codex plan review (REVISE→REVISE→APPROVED);
  intake re-locked rev 2 mid-plan (anchor semantic, B14/B15 reasons, resend
  OWNER_DIRECTED_TEMPLATES). **Counts: +1 production merge.**
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
| 2026-08-24 | #888 fix (single PR, not a pass) | `scripts/blast-radius.sh` + new `scripts/blast-radius-importers.ts` + subprocess/unit tests under `scripts/ci/__tests__/` | Replaced the blast-radius substring grep with TypeScript-AST specifier matching (tsconfig-alias/relative/`.js`-suffix/`index` resolution against the changed set as strings, so deleted and renamed targets keep their importers), NUL-delimited rename-aware git plumbing feeding both rename paths, and atomic same-directory report writes that preserve the previous report on matcher failure. Review tooling only — no production code path touched. |
| 2026-08-24 | #877 fix (single PR, not a pass) | `scripts/test-db-setup.sh` (single-session driver), `scripts/ci/rls-audit.ts`, `.github/actions/test-db/action.yml`, `live-db-lock.ts` key export, `verify-gate.sh` header, tests under `scripts/ci/__tests__/` | Closed the cross-process provisioning race behind the #865 rls-audit false-FAIL: provisioning now holds the existing `repworth_live_db_integration` advisory lock exclusively IN the psql session that performs its DDL (one driver, `RESET ALL` after every include — migration 103's session-level `search_path` made per-file psql load-bearing), `ci:rls-audit`'s live check holds the shared form and validates a `test_meta.provision` content-hash marker (one actionable line instead of 20+ phantom failures), and CI's test-db composite action delegates to the same script so the recipe has one owner. Bounded guarantee; the full lane-level protocol is ticketed as #958. |
| 2026-08-24 | #918 fix (single PR, not a pass) | new `scripts/ci/env-registry-audit.ts` + `ci:env-registry` wiring (package.json, ci.yml lint, lefthook), §2 of `docs/eservices-variables.md` normalized to one-var-per-row and backfilled, `env-vars.md` slash cells split + 1 flag row added, CLAUDE.md env-var row names both owners | The env-registry house rule gets teeth: three declared-var lanes (config z.object schemas with registered-spread resolution, readFlag call sites resolved through import bindings incl. aliases/namespaces with non-call references failing, raw process.env reads with fail-closed dynamic-key resolution incl. the missing-env probe shape) checked against name-cell-only registry rows — 184 vars incl. 29 flags, zero exceptions, format guards keep the normalization from regressing. |
| 2026-08-25 | #963 fix (single PR, not a pass — found live by #633's staging flip) | `src/lib/solicitation/ask-compliance-lint.ts` (+`'google'` in `PROVENANCE_ALLOWLIST`, `ASK_LINT_VERSION` → `ask_lint_2026-08-25.1`), golden regenerated, regression test added | The send lane was deterministically inert: `ask-prompt-policy` instructs the model to ask for a "Google review" while class 6's provenance rule refused the un-allowlisted mid-sentence token — every real ask withheld `unverifiable_fact` (4/4 on the first live generation, staging batch `01a0399f-175d…`). One-token allowlist widening: the prompt itself asserts the platform, so the model echoing it is prompt-asserted, not model-invented. Lesson recorded: the lint's fixtures never used the product's own core vocabulary. |
| 2026-08-25 | #966 fix (same PR as #963 — both found live by #633's staging flip) | `src/lib/solicitation/dispatch.ts` (+`buildUnsubscribeOneClickUrl`, second mint), `src/lib/messaging/messaging-adapter.ts` (+`unsubscribeOneClickUrl` on `OutboundMessage`), `src/lib/messaging/email-adapter.ts` (header reads the machine url), 3 test fixtures + 2 regression assertions | RFC 8058's `List-Unsubscribe` HTTPS member advertised the Next.js `/u/<token>` HUMAN page, whose POST renders the confirm button and writes nothing — so every provider-automated one-click (Gmail chip, Yahoo, Apple Mail) was a silent 200 no-op while the footer link and mailto worked. Proven on staging three ways (page POST → no ledger row; `/api/u` → row; worker ingress → row + idempotent re-POST). The header now carries `${WORKER_PUBLIC_URL}/ingress/unsubscribe/<token>` (invariant #6: a mail provider is not a browser); `OutboundMessage`'s own docstring already SAID "the Railway ingress form" — the mint had drifted from the spec. The adapter's fail-closed test asserted on the footer url, which is how the wrong endpoint shipped; it now asserts on the machine url, and a new dispatch assertion pins that the machine url never enters the body. |
| 2026-08-24 | #894 fix (single PR, not a pass — executes Pathfinder H5's three ordered steps) | `scripts/ci/tenant-scope-audit.ts` (bridge-binding class), `tenant-scope-allowlist.ts` (−24 entries, baseline 393→369), `tenant-tables.ts` (+`REVIEWED_NOT_TENANT_SCOPED`), `tenant-tables.integration.test.ts` (inverted completeness), 11 Step-1 convention comments incl. the `pending-count.ts` pull-forward | Step 1: the false "audit requires this join" claim corrected; the batch-view convention applied at every `flagged_responses`/`users`/`owner_leads` production site. Step 2: `users` retained as a BRIDGE binding (never a finding) with an `auth_id` anchor and three shapes — the MEASURED primary `accounts.id = users.account_id` (24/25 allowlist entries), the issue's 4th (`owner_user_id`) and generalized 5th (sibling-through-account); measured with `--no-allowlist` before/after (355→331 findings), the 24 newly-proven `supabase-auth-id` entries deleted, the 1 correlated-subquery holdout kept. Step 3: every live `public` table must sit in exactly one of `TENANT_TABLES` or the reviewed list (8 entries, reasons stated; keyed on coverage, not column presence — `solicitation_send_breaker` proves why). |
| 2026-08-26 | #967 fix (single PR, not a pass — one of four triage findings; the other three were documentation or tracker-only) | `worker/ingress/resend/solicitation-lane.ts` (unmatched-attribution policy + payload-recipient fallback), `worker/jobs/account-offboarding/purge-stages.ts` (KNOWN GAP → CLOSED), `CONTEXT.md` (**Solicitation lane** re-anchored), the lane's live-DB suite (+9 cases, 43 green), `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` (D9 veto-anchor amendment) | The purge's suppression contract promised a recipient's GLOBAL opt-out survives an account purge; for one recipient class it could not. `loadAttribution` joins our own `solicitation_contacts` row and the purge deletes it, so a post-purge bounce threw, retried until the 300s signature window 401'd it, and left the opt-out unwritten at `status='failed'`. **Retiring the retry was the owner's call on the measured shape of the problem:** a retry closes only ONE of three unmatched causes, and the other two are permanent — the purge, and a send whose terminal CAS lost (`dispatch.ts` `commitSendTerminal`) and never persisted `provider_message_id` at all. Suppression-bearing events now write the global row from the SIGNED payload with `accountId: null` — the contract's boundary rule stated exactly — and ack; soft bounces and `email.failed` are unchanged (§3.2 intact). **Exactly one address in `to`, or throw**: a global row blocks that person for every tenant, so the lane refuses to guess. Two costs accepted and recorded at the call site: the seconds-wide #630 race loses the outreach `bounced_at` stamp, so the **Send breaker** undercounts one bounce; and the acked payload's recipient address is bounded only by `ArchivalPoller`'s 30-day sweep of `processed` rows — itself a gain, since the old `failed` rows escaped that sweep entirely and retained an address forever. The `:836` normalization invariant is **narrowed, not retired**: while attribution exists the stored contact handle still wins and the payload is never read. Alongside, doc-only: D9's veto anchor recorded as the shipped `MIN(sent_at)` with `failed_at IS NULL`, not `delivered_at` (Telegram returns no delivery receipt) — owner-approved at build, never written down until now. **Process note:** the gate's `reclassify` row fired at 211 vs 90 estimated production lines; measurement showed no sprawl (5 of 5 declared files, one seam, ~64 executable lines added, 55% of the lane's additions being comment in a file already 55% comment), the estimate was corrected in both intake copies and the SMALL PATH held. |
| 2026-08-26 | marketing spacing/motion/copy pass (single PR, not a pass) | `src/app/(public)/_styles/{island,features,how-it-works,pricing}.css`, the three Daylight marketing page component trees, new `src/hooks/useReveal.ts` + `src/components/sections/how-it-works/HeroFlowArtifact.tsx`, `src/components/ui/{HeroWash,Reveal,SiteShell,SiteFooter}.tsx`, `docs/design/island/DESIGN.md` | UI only — no worker, `src/lib`, migration or billing surface. **Five latent defects found by measurement, not by reading:** (1) `.hiw-page p` scores 0,1,1 and out-specified every 0,1,0 class rule on that page — eleven margins computed to zero, including the SHARED footer blurb, which rendered 14px on `/features` and 0px there **from one component**; `:where()` applied, as `features.css` and `pricing.css` already had. (2) `.rw-dl-rv` set `opacity: 0` on the base rule while `.is-in` only ever arrives from React, so every revealed section was blank with JS off; hidden start frames moved inside `@media (scripting: enabled)`, and a scan confirms no unguarded frame remains on a live class. (3) Two reveal hooks with disagreeing thresholds (0.08/−80px vs 0.05/−50px) ran on the same page, and `Reveal` ignored `prefers-reduced-motion` entirely — the one reveal path here that did; merged into `src/hooks/useReveal.ts`. (4) `.feat-ch.is-split` sat on four chapters and was defined nowhere, working only by inheriting `.feat-ch`. (5) Hero copy over the wash failed AA: compositing the blurred poster + both gradients and sampling the darkest 8×8 block gave **2.04:1** for 13px and **2.32:1** for the 18px lede. A veil alone tops out at 4.34 for 62% ink, so the eyebrows moved to soft **as well as** gaining a scrim; the final audit caught one straggler on the unscrimmed right side (4.28 → 6.10). **Scroll-linked motion is `@supports`-gated on purpose** — Firefox stable still flags `animation-timeline` (FF 152, 2026-06) and browserslist resolves iOS Safari 18 / Chrome 109, so the one-shot reveal stays the baseline. A view timeline **cannot** come from a `position: sticky` subject: measured, one constant value across 2,900px of scrolling while pinned, so both ribbons take theirs from a non-sticky ancestor published with `timeline-scope`. **Two test-guard corrections, opposite directions:** `ContactContent.test` asserted `not.toContain('<h3')` as a *proxy* for "no heading skips" — true only while the footer used h4, so it defended the bug and failed on its fix (replaced with a real level-sequence check); `FeaturesContent.test`'s `'Governor pauses Autopilot'` pin was **right** and the rewrite was worse (12 words and another noun between subject and verb), so the copy was fixed and the guard kept. Pricing plan cards moved off two `min-height` guesses to row subgrid — 77px of dead space per card, and the guesses would have broken in the very flag postures they were sized for. The copy pass removed internal vocabulary from `/pricing` that this repo's own `/how-it-works` truth pass had already banned (`unflagged`, "moderation … gates") but never applied there. Dead CSS **unchanged at 77 orphaned classes** (pre-existing old landing design, verified against the merge-base); flagged, not touched. |
| 2026-08-26 | insights remediation (single PR, not a pass) — acts on the /insights report over 183 sessions | `.claude/commands/feature.md` (step 3 pre-validate, step 5 subagent barrier), `.claude/commands/feature-resume.md` (stale-ref reconciliation), new `.claude/skills/preflight/SKILL.md`, `.gitignore`; plus four out-of-repo changes under `~/.claude/` that this row exists to make discoverable | **Half of this change lives outside the repo and leaves no diff here.** New global PreToolUse guard `~/.claude/hooks/destructive-git-guard.py` refuses `git reset --hard` and whole-tree `git add` (22-case suite; parses with shlex rather than grepping, so a command that only QUOTES the string is allowed — a grep-based guard blocks its own documentation); escape hatch `ALLOW_DESTRUCTIVE_GIT=1`. Global CLAUDE.md gained four standing sections (git discipline, gate evidence, design acceptance, secrets). `grill-me-codex` gained a PRE-VALIDATE gate before round 1, backed by `~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` (10-case suite): it resolves every `path:line` citation against HEAD, tests test-shaped paths with `git check-ignore`, and resolves cited commit SHAs incl. a stale `HEAD is <sha>` claim — the three classes that burned rounds 1–3 of past six- and nine-round reviews. `/feature` step 3 now runs the same script before dispatch. **Finding, deliberately NOT fixed here:** `GOVERNANCE_PATHS` in `scripts/ci/merge-ledger-audit.ts` covers `.claude/skills/` and `.claude/hooks/` but NOT `.claude/commands/` — yet the audit's own docstring names #803's deletion from "`/feature`'s step 8", which lives in `.claude/commands/feature.md`. This PR trips the audit only via the new skill directory; a future PR touching feature.md alone would leave no trace. Widening the set was out of the requested scope and is left as an explicit follow-up. |
| 2026-08-26 | **12 counted merges ≥ 5 threshold** across a 21-merge window after `72dc58ac` (the marketing/landing wave #953/#955/#959/#968/#976; the solicitation attribution + suppression trio #954/#964/#975; the three 08-18 carry-forwards #962/#970/#972; plus #969). **The counter itself read 8** | Pathfinder pass, **windowed** (owner's call): 8 features charted — F1 landing composition root, F2 landing motion primitives, F3 landing sections, F6 Island design system, F7 Daylight marketing pages, F8 solicitation attribution, F9 suppression & unsubscribe, F10 ask dispatch, F11 purge & verification. **664 nodes**, every node `file:line`-cited. Three features (F12/F13/F14) recorded as no-chart — comment-only in this window. Plus a cross-feature duplication axis and a **46-guard scope census**. Artifacts `docs/reviews/PATHFINDER-2026-08-26/00-09` | **Headline: the enumerated-scope guard class the 08-18 pass NAMED produced FIVE new findings two windows later, and the pass's own handoffs INVERTED — 3-of-3 landed from 08-18, 0-of-3 from 08-24.** **Guard census, 46 mechanical guards:** 18 Class A (pure enumeration), **25 Class S** — a class this pass names: *derived* discovery **narrowed by a hand-written scan root** — 4 Class C, and **only 6 that detect an EMPTY scan**. Class S is bigger than Class A and is the real problem; `ci:pool-fanout` proves it — the #505 fan-out pins did not disappear when they became a rule, they **became `SCAN_DIRS`**. **NOT the same four guards** as 08-18: one identical, three descended, two new — **the class has grown**. New failure mode named: **exemption transit** — `owner_leads`'s CORRECT Class-B exemption at `tenant-tables.ts:210` silently became an OMISSION in `table-disposition.test.ts`'s required set; nobody erred, and 08-22's proposed two-line `linkedColumnPattern` fix would NOT have caught it. General fix in two steps, **cheaper than the `ci:guard-scope` meta-audit 08-22 deferred and strictly wider**: a `scannedCount === 0` fatal in `ratchet-harness.ts`, plus exporting every `SCAN_DIRS` with one `ci-audit-wiring` case failing on a directory zero audits cover. **The counter is wrong for the SIXTH consecutive pass and this file's own prescribed fix is UNSOUND** — `ci:merge-ledger` fires on production OR governance while the rule counts production only, so #957/#960/#961 were each required to add a line and must not increment; "count the lines" over-counts by construction. The 08-24 pass credited `ci:merge-ledger` with counter correctness; that audit's header explicitly declines the job. **First pass where the MARKETING surface, not the pipeline, is the largest changed area** — `src/components/` took 51% of the window's net growth; 100 files / 17,141 lines, 46% CSS, never charted before. **This log's own CSS claim REFUTED:** `agent-flip-card.css` is import **#1**, not last; there are **three** unguarded order dependencies, not two, and the one that IS guarded (`globals.css:186-189` via `design-scope-purity.test.ts:39-45`) got no credit. **Arrival grammar has SIX spellings of one idea**, four live — proven one system by `carousel.css:112-113` neutralising all three Landing variants with a single `!important`. **Largest duplication measured in six passes:** the `businesses ⋈ accounts` subscription read is **33 sites**, byte-identical predicate, no fragment and no comment — and it **corrects this pass's own F8 flowchart**, which reported five, one a false positive. **#892's verdict QUALIFIED:** #972 owned the tombstone sentinels and stopped one literal class short — writer and verifier still hand-share `'scrubbed:'` ×20 split 10↔10, and because the verifier is a **fail-closed compliance gate**, verifier-side drift converts a failed purge into a **PASS**. **Live defects, each with reachability answered SEPARATELY:** `ProblemSection.tsx:47` branches on `usePrefersReducedMotion` with no mount gate, so every reduced-motion visitor gets the video branch until hydration — and `HeroSection.tsx:48-56`'s own docstring names the bug, having solved it twice privately without extracting it (MEDIUM; `preload="none"` mitigates); `owner_leads` retains owner PII through an account purge; `contacts-repo.ts:103` runs the two-way `Promise.all` #893 reverted elsewhere; `/pricing` freezes `isFoundingWindowOpen()` at build (`pricing/page.tsx:17`) while checkout evaluates at request — **date-bounded, cannot fire before 2027-01-01**. **H3's ordering constraint was VIOLATED** — #633 flipped send-mode on staging and the doc gate never landed; the only two autonomy flags ON in the deployed estate are the two no runbook mentions, the documented "instant kill switch" `AUTO_APPROVAL_ENABLED=false` has **zero reads** in that lane, and a third file H3 never listed — `beta-production-standup.md:143`, the **production** checklist — omits both. **Production risk zero, every flag unset.** **08-24's H1 and H2 confirmed present but re-classified LATENT** (`auto-policy-publish.ts:555-562` + measured Railway flag state) — their prompts' present tense was wrong and is corrected. **F8, the newest subsystem (#954, migration 114), passes EVERY invariant** — outbox, explicit-client, tenant-scope, idempotency, `ON CONFLICT` matching its partial index byte-for-byte. **Seed 6 REFUTED twice independently:** all four locked suppression terms hold. **Migration 114 lockstep verified by introspecting BOTH databases**; the 078 standing exception shows its exact documented prod signature. Gates 21/21 (audit count 20→21 with `ci:env-registry`); `pnpm test` and `ci:fallow:coverage` NOT run — test health at HEAD unmeasured, and no guard-integrity mutation axis this pass. **Method note: the "a citation is not a verification" rule caught an error in the ORCHESTRATOR's own work** — a `head -12` truncation hid the `/pricing` call site and nearly produced a false refutation of a real finding. 9 DO-NOT-UNIFY additions. 10 handoffs H1–H10; `#3a` deliberately NOT carried a third time — folded into H4. |
| 2026-08-26 | feat-qr-review-request (single PR via /feature, RISK=high — roadmap Phase 0 pull-forward, owner decision 2026-08-26) | migration 115 + `events.ts`/`events.test.ts`/`docs/analytics/events.md` (`qr_scan_redirected`), `subscription-status.ts` (+`subscriptionAllowsQrRedirect`), `src/lib/locations/{review-qr.ts,repo.ts}` (+`getQrRedirectRow`), tenant-scope allowlist (+1 `pre-auth-token`, baseline 370), public `src/app/q/[businessId]/route.ts`, `/settings/review-qr` section + print view + `SettingsSidebar` entry, 7 test files carrying the intake's 18 promised titles (2 new live-DB suites), the 106 drift guard handed to a new 115 suite | **Review QR** (CONTEXT.md): per-location printable QR encoding the RepWorth-owned **QR redirect** `/q/<businessId>`, 302 to Google's write-review deep link. Gate = `{active, trialing, past_due}` via the named predicate (owner decision — `past_due` keeps a printed counter code alive mid-grace); every refusal (bad id, missing row, archived, `pending_payment`/`cancelled`, non-canonical place id) serves one byte-identical scanner page, reason-coded in the log only. The destination is CONSTRUCTED from an `isPlaceId`-validated place id — no stored URL, no open redirect, hex CIDs refused (the `buildReviewLink` precedent). Scan counting is a best-effort `qr_scan_redirected` insert AFTER resolve: random event key per scan (a deterministic key would dedupe on `ON CONFLICT` and undercount), ids duplicated into properties because `AnalyticsDispatchPoller` ships only the properties JSON. Plan hardened through three codex plan-review rounds — two orchestrator rejections REVERSED on codex evidence (settings component tests are house standard; the sidebar test exists), two codex factual claims corrected in return, one orchestrator rationale (file-granular allowlist) disproven by codex running the audit — full record in the plan's review appendix + deviations file. Migration 115 stays LOCAL-ONLY until the staging-first promotion. |
| 2026-08-27 | feat-red-team-layer (single PR, not a pass — Phase 1 of three autonomy layers; plan locked by grill then hardened through 10 adversarial Codex rounds to APPROVED) | new `red-team` dual-lane skill (`.claude/skills/red-team/` + `.agents/skills/red-team/` parity mirror) + `mutation-runner.mjs`, new `.agents/skills/feature/scripts/red-team-status.mjs`, two suites under `scripts/ci/__tests__/`, `agent-config-audit.ts` PROJECT_SKILLS, `.gitignore` allowlist pair, `transition-state.mjs`, both `/feature` lanes + both resume workflows, `merge-ledger-audit.ts` GOVERNANCE_PATHS | **Governance only — no production file, so this merge does NOT increment the counter.** `/red-team` is a post-implementation VERIFIER that runs after the gate and review triage and tries to disprove "done": hand-mutation of the changed test surface (no Stryker, no new dependency), fragile-assertion review, doc claims re-resolved against HEAD, missed sibling cases, and operational completeness. **"An open P0 blocks the ship" is now an exit code, not prose** — `red-team-status.mjs` recomputes status and counts from the inventory rather than trusting the sidecar's summary, derives the expected report path from inputs it resolves itself (never from the file under validation), recomputes the merge-base from `fork_sha`, compares `intake_sha256` against the gitignored intake that `git diff` cannot see, fails unless the tree is unmoved since `head_sha` OUTSIDE the run's own two artifacts, and blocks a high-risk open P1 with no resolving authorization; `transition-state.mjs` runs it on `reviewed` beside the gate fingerprint, and BOTH resume workflows revalidate it before trusting an existing `reviewed` phase. Mutations are journaled to `.feature/red-team-journal.json` before they land and restored by a finalizer the INVOKING agent runs, which aborts rather than overwrite content it did not write; each run executes under a paused `sh` supervisor whose PGID and start time are journaled before the release byte, closing the two crash windows the review named (death before release, descendants orphaned after leader exit) — both have tests. Secrets are handled by an env ALLOWLIST plus a separate dotenv rename-swap, because `.env*` is gitignored and process-env scrubbing is defeated by `dotenv-load.ts` reading `.env.local` off disk. **Fold-in, closing the follow-up the 2026-08-26 insights row deferred:** `GOVERNANCE_PATHS` gains `.claude/commands/` — this audit's own header cites #803's deletion from "`/feature`'s step 8", which lives in `.claude/commands/feature.md` and nothing covered. One further governance edit, stated because it widens an exemption: `live-db-suites-audit.ts` gains the runner suite in `NOT_LIVE_DB`. That audit detects a live-DB suite by substring, and the suite NAMES `TEST_DATABASE_POOL_URL` as the subject of an allowlist assertion while opening no connection — the same class as `ci-audit-wiring.test.ts`, already there. 65 new tests; the full local gate green at this SHA. |
| 2026-08-28 | feat-queue-run-orchestrator (single PR, not a pass — Phase 3 of three autonomy layers; Phase 2 /visual-loop deliberately skipped by owner decision; plan locked by grill then hardened through 6 adversarial Codex rounds to APPROVED) | new `queue-run` LANE-DIVERGENT skill pair (`.claude/skills/queue-run/` orchestration + `.agents/skills/queue-run/` classify-and-memo variant) + `queue-state.mjs` state controller, `scripts/ci/__tests__/{queue-state,new-worktree-env}.test.ts`, `agent-config-audit.ts` (PROJECT_SKILLS + new `LANE_DIVERGENT_SKILLS` set), `scripts/new-worktree.sh` (`SKIP_ENV_COPY=1`), `.gitignore` allowlist pair | **Governance/tooling only — no production file, so this merge does NOT increment the counter.** `/queue-run` makes the invoking session the `/feature` ROOT per mechanical issue (owning intent, plan, review, ship; delegating only step-4 implementation — the pipeline's own architecture, restored after review round 2 refuted an executor-runs-everything model), with an explicit five-item external-write authorization bundle (scoped commits, `push -u`, journal-gated `--force-with-lease` on run-owned branches only, draft create, ready) and hard NEVERs: merge, staging, deploys, flags, issue comments. Review-forced structure worth naming: raw issue bodies are QUARANTINED to a credential-free read-only classifier (the push-capable controller consumes only schema-validated seeds — prompt-injection resistance is structural at both ends); high-risk issues (predicate verbatim from `/feature` step 0, approval/auto-approval paths included) are PREPARED but never executed, since the pipeline's high-risk intake sign-off cannot be pre-authorized — this deliberately superseded the owner's grill answer and was re-approved at sign-off; trivial issues PROMOTE to the small lane (the trivial lane creates no intake/state and cannot pass the red-team `reviewed` gate); edit-surface reservations PERSIST ACROSS RUNS under a separate GLOBAL lock and release only on attested merge/closure — run-end release would hand the next run a collision against unchanged main; a non-no-op rebase VOIDS red-team evidence and forces a complete re-pass (the checker's staleness rule, honored rather than fought); resume claims automatic recovery ONLY for six enumerated states and parks every dirty tree ("run-owned dirt" has no deterministic test). `queue-state.mjs` uses a LEASE+token run lock, not PID-liveness — the controller is a session whose tool calls are short-lived processes, so PID rules would mark every lock stale instantly; the reserve/refuse path was restructured after a self-caught defect where `process.exit(2)` inside the lock's callback skipped `finally` and leaked the global lock for its 60s staleness window (now pinned by a test). `SKIP_ENV_COPY=1` (paired with the pre-existing `SKIP_INSTALL=1`) keeps staging/provider credentials out of executor worktrees, closing the window where `pnpm install` lifecycle scripts ran with copied `.env*.local` present; the token ceiling is named an ADVISORY spend threshold (refuse-next-step semantics, no false hard-bound claim). 12 new tests; plan + 6-round debate log in `~/.claude/grill-codex/20260828-002542/`. |
| 2026-08-28 | feat-console-harbor-redesign (single PR — owner-directed full visual redesign of the authenticated Console, direction picked from a three-way board) | `src/app/(authenticated)/_styles/{tokens.css,console.css}`, `(authenticated)/layout.tsx` (Gabarito+Figtree localFont swap; Young Serif woff2 deleted, DM Sans retained — root layout owns it), `DashboardContent.tsx` (hero-row + time greeting), `ReputationHeroBand.tsx` (interpretation headline + gated 8-week mini trend), new `RepPulseCard.tsx` + `kpi/hero-headline.ts` + `src/lib/dashboard/rep-pulse.ts` (+2 test files), `shell/Sidebar.tsx` (AA fix on dark field), rewritten `docs/design/console/DESIGN.md`, register rename in root `DESIGN.md` + `docs/design/README.md` + brand-skill pair (`.claude/` + `.agents/` mirrors), `docs/directory.md` (+1 row), `docs/design/dashboard-redesign/` (source notes, direction board, before/after evidence) | **Warm Editorial → Harbor.** The load-bearing engineering decision: token VALUES changed, token NAMES kept — every component class, `theme.css` utility, and guard survives untouched; Harbor-only names (`--rw-field-deep`, `--rw-hero-*`, `--rw-deep-panel*`, `--rw-coral*`, `--rw-nav-*`, `--rw-hero-line*`, `--rw-radius-canvas`) are additive. The shell becomes a sea-teal field with light nav ink and one floating warm-white canvas (`overflow: clip`, not `hidden`, so the sticky topbar keeps sticking; `background-attachment: fixed` was tried and reverted — it paints only the first viewport). Three special surfaces, one instance each, now a NAMED DESIGN.md rule: gradient hero (conclusion-as-a-sentence via deterministic `computeHeroHeadline`), Rep Pulse gauge (coined 0–100, transparent 70/30 rating/response formula, NULL while ramping — never an invented number; delta reconstructed from the hero's own windowed deltas), inverted deep panel for the exception queue. The hero mini trend is prop-gated to the glance dashboard because the analytics page already renders the full `ReputationTrendChart` — caught by an existing duplicate-text assertion, kept as a structural rule. Every guard-pinned contrast pair recomputed (≥4.5:1, focus ≥3:1) and the new shell pairs (nav 4.65–6.07:1, hero ink 4.58–6.26:1, deep-panel muted 5.02:1) verified before the values landed; `design-doc-token-pin` forced the DESIGN.md rewrite in the same change, which is exactly the drift class it exists to catch. Evidence: same account, same data, before (`main`) and after at 1440px + 390px in `docs/design/dashboard-redesign/evidence/`. Settings/Reviews/Analytics inherit palette+type through the shared tokens; their layout polish is deliberate follow-up. `/impeccable document` owed after merge (generated sidecar lags the new DESIGN.md). |
| 2026-08-28 | feat-console-harbor-surface-polish (single PR — the deliberate follow-up the Harbor row above named: layout polish for the three surfaces that only inherited the retheme) | `src/app/(authenticated)/_styles/{console,past-replies,settings,tokens}.css`, `ReviewFeedCard.tsx` (queue recomposition), `reviews/history/page.tsx`, `EditReplyDrawer.tsx`, `AnalyticsPerLocationView.tsx`, `ChartTooltip.tsx` (+test), `{ReputationTrend,Velocity}Chart.tsx`, `SettingsShell.tsx`, `SettingsSidebar.tsx`, `docs/design/console/DESIGN.md` (wait-badge role rows), before/after evidence in `docs/design/dashboard-redesign/evidence/` | UI only — no worker, `src/lib`, migration or billing surface. **Reviews:** the queue un-nests (cards-in-a-card violated the One Card Rule — each review is now its own Harbor card under a `Waiting on you` head), and the pending state moves from the warning golds to the coral attention family, per the Style Reference's chip triad (pending=coral, posted=teal, auto=violet); the yellow pair's DESIGN.md role narrows to wait states (held badge, medium escalation) in the same change, keeping the token-pin doc truthful. Empty queue and empty analytics become designed content with a doorway link. Three Unicode-glyph icons (drawer ✕, history ▾, analytics 📈) replaced per the inline-SVG rule. **Analytics:** chart headline joins the 18px small-step scale; the tooltip gains a deterministic week-over-week delta line (derived from the plotted points — first point renders none) with the 96→116px width sync test updated; rating/sentiment rows adopt the bar-hover dim-others convention. **Settings:** the rail becomes an intentional pane (own `Settings` heading, hairline divider, padding clearing the 28px canvas corner — the clipped `RESPONSES` label was the visible defect), section cards move to the 20px Harbor card, inputs go recessed-at-rest/white-on-focus per the Form controls spec (both `.input` owners edited in sync; washed panels invert back to white), the save bar becomes the Style Reference's floating pill (its `left` still derives from `--rw-sidebar-width`), and the Billing plan card lands on the deep-panel tokens as that screen's ONE inverted surface. Coarse-pointer and reduced-motion blocks amended in place (count stays 4; `settings-sidebar-link` was a stale selector — the real class is `settings-nav-item`). Island-token fall-throughs in Console CSS fixed where touched (`--rw-teal`, `--rw-cream`). **Known-flaky note:** `autopilot-entitlement-concurrency.integration.test.ts` times out locally at this SHA with or without load, before and after these edits; the identical worker code is green in #987's CI `test` job — environmental, not a regression from this change. **Pre-merge dedupe/dead-code sweep (owner-requested):** the `.input/.textarea` primitives now live ONLY in console.css (the settings.css copy deleted — the two had to be hand-synced); 12 dead rules removed after per-class verification against every ts/tsx source (`.settings-tabs`/`.stab*`, `.plan-stat*`, `.pr-upgrade*`, `.draft-actions`, `.tab-badge`, `.toast-wrap`/`.toast`, `.skeleton-line`, `.set-divider`, a dead `.wizard-actions` selector, settings' duplicate `@keyframes fadeUp`); the `.sub-status-banner` entry animation referenced keyframes `slideIn` that were never defined — it had silently never run; now `slideDown`; `REP_PULSE_*_WEIGHT` un-exported (used internally only); the two tooltip delta builders folded into `weekOverWeekDeltaLabel` (ChartTooltip.tsx). Kept deliberately: `.rating-rows`↔`.brief-list` (5-decl list resets in unrelated domains) and the mini-trend↔full-chart 9-line d3 boilerplate (the two render independently by design). Pre-existing repo-wide findings reported, not touched here: 4 unused files (2 WS8 operational scripts, `landing/reveal.tsx`, `be-ui-tilt-card.tsx`), the admin `ReviewRow` duplicate export, 49 worker/email-template clone groups. |
| 2026-08-28 | Console shell — Source A Part 1 (sidebar, popovers, toasts, tabs, motion) | `Sidebar` · `AccountMenu` · `useMenuPopover` · `LocationPicker` · `TopBar` · toast package · `CardViewTabs` + the two aggregate cards · `SettingsShell` · `console.css`/`settings.css` · `(authenticated)/layout.tsx` | **Sidebar rebuilt around identity, not the logo** (Source A §1 build order): the account control (`AccountMenu` — avatar, owner name, `chevron-updown`) takes the top slot with the location scope beneath it; the RepWorth wordmark demotes to a quiet `.sidebar-brand` at the foot. Settings joins a new **Help** row in a `.nav-section--utility` dock at the base (rule 5), and `/dashboard/reviews/history` becomes reachable from the nav for the first time as a `.nav-child` shown only while the Reviews section is active (rule 6) — a disclosure toggle was rejected for one child. The old `.user-chip` + `.signout-btn` pair is gone; sign-out lives in the account menu. **Sign-out was unreachable below 768px** (the sidebar is `display:none` there and the mobile tab bar has no account tab); `AccountMenu compact` now renders in the top bar as a direct child of `.topbar` so the mobile grid can place it on the heading row. Identity reaches both mounts via a new `OwnerIdentityContext` rather than threading two props through every `TopBar` call site. **`useMenuPopover` extracted** from `LocationPicker` as the single owner of Console menu behavior (outside-click, Escape+restore, Tab-close, roving Arrow/Home/End, focus-on-open); two callers, so it is not an abstraction for one. It exposes `close` AND `closeAndRestoreFocus` deliberately — a navigating item must not have focus yanked back mid-route-change. Every consumer **destructures the result in one read**: `react-hooks/refs` treats any member access on a ref-carrying object as a render-time ref read. **Toast system added** (`ToastProvider`/`ToastRegion`, hand-rolled, in-tree — a portal would leave `.rw-console` and strip every scoped token, per the tokens.css portal audit). Both arms ship together: `success`/`info` are polite `role="status"`, `error` is assertive `role="alert"` and lives twice as long. It **replaced** the settings-only `.saved-toast` pill (which had no failure arm), and `SettingsShell`'s duplicate "Settings saved" `LiveRegion` was deleted so the message is announced once, not twice; the save-**error** LiveRegion stays, because its visible copy is an inline paragraph in each settings client with no live semantics. Settings-save toasts fire on the **rising edge** of `savedFlash`, never a value read. **`CardViewTabs` extracted** with real `tablist`/`tab`/`tabpanel` semantics + roving focus, replacing the two inline-styled `aria-pressed` button pairs in `AggregateVelocityCard`/`AggregateRankingCard` — a mutually exclusive pair announced as two independent toggles; the inline pill container became `.card-view-tabs` (recessed, because it sits ON a card where `.tabs` sits on the canvas). **Two reduced-motion leaks closed**, both invisible to the CSS media query: `VelocityChart`'s inline `transition: 'r 160ms'` on the hover dots now gates on the same `reduced` flag as the rest of that chart, and `EditReplyDrawer`'s spinner gains `motion-reduce:animate-none`. Coarse-pointer and reduced-motion blocks amended in place (count stays 4). **Deliberately NOT done:** the sidebar promo slot (Source A rule 9) stays empty — nothing honest fits yet; a trial card needs `trialEndsAt` at the layout, and a pending-work card would duplicate the badge two rows above. **Deliberately NOT done:** no chart or new data zone was added to `/dashboard`. `ratingBreakdown`, `reviewVelocity` and `latestBrief` all already ship on that page's payload and render nowhere, so the main-region work needs no query — but DESIGN.md's **Two-Second Glance Rule** enumerates what that screen may contain, and adding a chart amends a locked decision. Raised for the owner, not taken unilaterally. Source A rule 18 ("border or background, not both") is recorded as **superseded by the Harbor card** (fill + hairline + shadow), which is a decision of record. |
| 2026-08-28 | Glance dashboard — weekly recap, "why?" line, Rep Pulse decomposition (owner-chosen direction) | `weekly-recap.ts` (new) · `rep-pulse.ts` · `WeeklyRecapCard` (new) · `RepPulseCard` · `ReputationHeroBand` · `DashboardContent` · `NeedsAttentionList` · `console.css` · `docs/design/console/DESIGN.md` | **The Two-Second Glance Rule was amended with owner approval** to admit the weekly recap as zone 2. The rule stays a whitelist, and the amendment records what it still forbids: no review content (that is the Reviews page's object) and no second copy of an Analytics chart. **Direction was chosen against a live payload probe, not from theory.** The staging account is ramping until ~15 Sep (`RAMPING_AGE_DAYS` 21, business created 25 Aug), which suppresses the hero mini trend AND the Rep Pulse score; `latestBrief` is null; and `ratingBreakdown.total` is 1. So three of the four candidate directions rendered nothing and one rendered a single bar. That reshaped the build rather than the choice: the recap is built from `trend` ALONE — which has real shape (0,2,2,2,0,0,0,1) — with `latestBrief` demoted to optional enrichment, so the card is complete on an account whose Insights agent has never run. **`reviewVelocity` is deliberately unused**: it carries the same per-week counts from a second query, and reading both would put two numbers for one fact on one screen with nothing keeping them equal. **The "why" line lives in the recap, not under the hero trend** (its intended anchor is suppressed while ramping), and it states only observations about weeks visible in the sparkline beside it — a gap, a last arrival, a peak — chosen by a fixed ladder, never a rating comparison the ramping rule withholds. **The recap's second stat is a COUNT, not the week's star-equivalent**: the hero directly above already shows an "Average rating" figure, and a sentiment-derived star-equivalent rendered as the same 5.0 in the same place meaning something else — caught in the first screenshot pass, and the reason `RecapWeek.starEquivalent` was then deleted as dead surface. **`repPulseBreakdown` derives its LAST contribution by subtraction**, so the parts always sum to the score on screen; independently rounded parts miss the whole by a point, and numbers that do not add up read as a bug. A property sweep over 800 star/rate pairs pins that. It collapses to one 100-point contribution when the reply rate is unknown, matching the renormalized formula. **The ramping Rep Pulse now names its two inputs and their weights but withholds the values** — showing the arithmetic would let the score be reconstructed, which is what the ramping state exists to prevent; `REP_PULSE_WEIGHTS` was re-exported (un-exported in #988 for having no consumer) so the copy and the formula cannot drift. **Two source-order bugs found by screenshot, not by test:** the recap's breakpoint override sat before the desktop grid it modified, and the Insights violet label modifier sat before the shared micro-label rule — equal specificity, so first-in-file silently lost both times. Both moved after their base rules with the reason recorded inline. Fallow flagged two duplications this change introduced and both were consolidated rather than waived: `.recap-title` now uses the existing `.card-h2-row` primitive, and the three uppercase micro-labels share one rule. Entry stagger re-laid to seven zones (`.section-enter-7` added; `NeedsAttentionList` moved to 5). Also fixed: the hero footer said "1 hours back in your day" — a pre-existing pluralization bug made visible by this change's own evidence. Evidence includes a deliberately labelled `pulse-scored-synthetic-*` capture, because the scored state is unreachable on real data until ~15 Sep; it proves the UI renders and is not a claim about this account. DESIGN.md now also records that the ramping state hides two of the three special surfaces, so a new owner's first three weeks look emptier than the design implies. |
