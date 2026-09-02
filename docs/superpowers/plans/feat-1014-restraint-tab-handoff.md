# feat/1014-restraint-tab — handoff

A resumed session bootstraps from THIS file, then the paths it names. It never
needs the prior transcript. Nothing below is restated from another file; every
row is a pointer.

**Resume with:** `/feature-resume feat/1014-restraint-tab`

---

## Where the run is

| Fact | Value |
|---|---|
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1014-restraint-tab` |
| Branch | `feat/1014-restraint-tab` |
| Fork point | `b55b0782` — main was taken and merged at `3716d253` BEFORE the wave opened |
| HEAD at this handoff | `a818e7ec` (this doc's own commit moves it by one — re-derive) |
| Classification | `size=standard · risk=high · surface=ui` |
| Phase | **`gate_green` — steps 0–5 DONE, step 6 review triage DONE, step 7.5 is next** |
| Gate | **GREEN**, `lastGreenGateSha = a818e7ec`, fingerprint current |
| Main drift | 0 at time of writing |
| Amendments | **2 of 2 — SPENT.** A third needs a new owner sign-off and the tooling refuses without one. |
| Plan review rounds | 3 of 3 — spent |
| Tracers | 8 of 8 done |

## ⚠ THE ONE THING BLOCKING THE TRANSITION

`node .agents/skills/feature/scripts/red-team-status.mjs` exits non-zero:
status `OPEN_P0`, with F5–F8 recorded as open P1s.

**Every one of those findings is fixed in `84f821ab`.** The sidecar does not know
that, because it is red team's own artifact and records round 1's state.

**Do NOT hand-edit the sidecar to say "fixed".** The honest close is a fresh
red-team round against current HEAD, which re-checks its own findings instead of
trusting a claim. That is step 7.5's job and it owns the `reviewed` transition.

Round 1's report and sidecar (committed, read them before re-running):
`docs/reviews/red-team/feat-1014-restraint-tab-e8a3c4/{findings.md,findings.json}`

---

## The files that own this run

| What | Path |
|---|---|
| Intake (LOCKED; amended twice) | `docs/superpowers/plans/feat-1014-restraint-tab-intake.json` |
| Plan (8 tracers) | `docs/superpowers/plans/2026-09-01-1014-restraint-tab.md` |
| Deviations **D1–D8, all verdicted ACCEPT** | `docs/superpowers/plans/feat-1014-restraint-tab-deviations.md` |
| Review wave reports (5 axes) | `docs/reviews/feat-1014-restraint-tab/` |
| Blast radius (pinned at the frozen fork) | `docs/reviews/feat-1014-restraint-tab/blast-radius.md` |
| Screenshots, 390px + 1440px, 7 states | `.feature/screenshots/shots/` — **gitignored**, regenerate with the two scripts beside them |
| Glossary (LOCKED) | `CONTEXT.md` § Refusal ledger — now including **Coverage start**, coined by this run |
| Ticket | `gh issue view 1014` — and its ONE comment, which corrects the body |

---

## What the review wave found, and why it mattered

Five axes in one parallel dispatch against a frozen SHA: spec/correctness,
standards, security/tenancy, UI/accessibility, red team. **31 findings against a
green gate** — none of them reachable by a deterministic check.

**The most important result is a negative one.** Security found **no tenancy
defect**: scoping is correct in all six statements and defended at two
independent layers. That was the run's top risk reason.

Four findings were HIGH and all are fixed:

1. **Two of the three links went nowhere.** `/dashboard/contacts` has no route,
   and the held-draft link was wrong twice — no `/dashboard/reviews/[id]` page
   exists, and `subject_id` is a `responses.id`, not a `reviews.id`. Three
   promised tests asserted the broken hrefs, so **the eval encoded the bug**.
   The read now projects `reviewId`; `subject_resolves` is gone.
2. **The read ignored `REFUSAL_LEDGER_ENABLED`.** Kill switch off ⇒ the tab
   printed a confident empty window. The route now ships `ledgerRecording`.
3. **Four mutations survived the whole suite** — link authority by lane, both
   window bounds, the cross-location guard. Five new live-DB cases close them.
4. **No `LIMIT`, and `total = entries.length`**, against a lane that can write
   5,000 rows in one batch. `ENTRY_LIMIT` caps the list; `total` is its own
   `COUNT`.

Two findings were REJECTED with reasons recorded in the review log: per-file
`docs/directory.md` rows (contradicts that file's rule at line 16 and **D8**),
and the adjacent optional positional params (the deliberate additive choice that
keeps `ReviewsContent` untouched).

## Four owner decisions this run is built on

Taken 2026-09-01, not reopenable without a new sign-off:

1. **Ship the row cap now** — `ENTRY_LIMIT`, a separate `COUNT`, and a stated
   truncation line.
2. **Surface the kill switch** — `ledgerRecording` on the payload plus a
   disclosure line, symmetric with the existing policy-gate line.
3. **Dates follow the Console's `en-US`**, not the `en-GB` first shipped.
4. **Accessibility fixes only** from the UI axis (UA-5, UA-6, UA-8).

**Deferred to follow-up tickets by that same decision:** a retry affordance on
the shared error card (UA-4) and lifting the analytics window into the URL
(UA-7). Both change behaviour on two surfaces beyond this ticket. Open them at
step 8 alongside the post-flip Coverage-start ticket the intake declares a
non-goal.

---

## Next actions, in order

1. **Re-run the red-team pass against current HEAD** (step 7.5). It must
   re-verify F1–F8 itself. `red-team-status.mjs` must exit 0 before anything
   else — a `reviewed` phase with a stale sidecar is refused by design.
2. **If it finds anything, fix, re-run the FULL gate, and repeat.** Never a
   `--fast` run as evidence.
3. **Transition to `reviewed`** — step 7.5 owns it, not step 6.
4. **Step 8 ships.** RISK=high, so the plan's ship order applies.

## Step 8 needs the owner — two items

1. **Realign `staging` BEFORE the ride.** It is diverged from `main`;
   `git merge --ff-only main` aborts after a squash merge, and the runbook's
   answer is `git reset --hard origin/main` + `--force-with-lease`. **Ask the
   owner for the exact command** — do not guess. A ride against a diverged tip
   proves nothing. Re-measure the divergence first; the numbers in the older
   handoff are stale.
2. **No migration to promote.** 116 is already on both Supabase projects.

**Authoritative state lives on disk, never in a summary.** Re-read
`.feature/state.json`, `.feature/progress.json` and `.feature/gate-status.json`
rather than trusting any prose — including this table if it disagrees with them.
