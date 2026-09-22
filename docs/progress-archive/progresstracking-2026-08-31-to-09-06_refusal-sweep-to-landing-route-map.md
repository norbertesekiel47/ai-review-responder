# RepWorth — Progress Tracking (archive: 2026-08-31 → 2026-09-06, Refusal ledger sweep → Landing route map)

> Archived verbatim from `docs/progresstracking.md` on 2026-09-21 to keep the live file under its 12,000-word cap. Newer entries stay in [../progresstracking.md](../progresstracking.md).

---

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
