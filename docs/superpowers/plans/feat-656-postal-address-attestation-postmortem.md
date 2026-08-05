# Post-mortem — #656 intake v1

**Trigger:** step-5 abort criteria (2nd `allowed_edit_surface` amendment), reached
at plan review round 1. **Owner call 2026-08-03:** re-issue the intake as a
step-1 correction rather than tear down a docs-only branch and re-run grilling
whose decisions were correct. No implementation code existed; the six commits
were intake, plan, deviations, handoff and the review reports.

**What survives untouched:** every decision locked during grilling — the
`settings/profile` surface, withhold-the-handoff-not-the-build, migration 099
behind #645, no-FK attested-by, no new `WITHHOLD_REASONS` member. Those are
recorded on ticket #656 and map #617 and are not reopened. **What failed was the
intake as an artifact**, not the intent it encoded.

## What intake v1 got wrong

**1. Test titles drifted from the migration renumber.** D1 moved the migration
098 → 099 and updated the glob, the goal and the rollback plan — but not the
three `migration 098 …` entries in `tests_to_add`. `promised-tests` matches
titles **verbatim**, so the gate could never have gone green. *Lesson: a
renumber is a find-and-replace across the whole intake, and `tests_to_add` is
the field that silently breaks the gate rather than the code.*

**2. A surface amendment never reached the arming copy.** D4 added
`worker/jobs/solicitation-batch/index.ts` to the committed intake, but
`feature-setup.sh` was not re-run, so `.feature/intake.json` never got it. The
guard would have blocked the owner-approved edit at execution time. *Lesson:
editing the committed intake is not the amendment — **re-arming** is. Every
intake edit ends with `feature-setup.sh`, and the check is
`python3 -c "...'path' in json.load(open('.feature/intake.json'))['allowed_edit_surface']"`,
not "I edited the file".*

**3. The surface was declared from the production files, not the test files.**
It listed `src/lib/solicitation/__tests__/**` but not
`src/lib/shared/__tests__/**` — where the repo's live-DB convention (#573)
*requires* migration-shape suites to live. Same for
`worker/jobs/solicitation-batch/__tests__/**`, whose exact-log fixture Task 6
necessarily breaks. *Lesson: walk the planned test files and add their
directories to the surface at intake time; the convention decides where a suite
lives, not the author.*

**4. A decision that overrode a locked spec was recorded only outside the spec
directory.** The §7.6.1 / §2.4 override (withhold the handoff, don't block the
build) was agreed with the owner and written to ticket #656 and map #617 — but
`docs/superpowers/specs/` still tells a reader "no batch produced." The reviewer
read the spec, found the contradiction, and was right to. *This is the #643
lesson recurring in a new shape: it is not enough for a decision to be recorded
somewhere durable; it must be recorded where the next reader will look, which
for a spec override is the binding amendments doc.*

## What the plan got wrong, and the common cause

Four citations were false: a deviation that said something else (D2), an
"existing assertion" that does not exist, a "flag-stubbing helper" that does not
exist, and `acquireLiveDbLock` attributed to the wrong file. Each came from
writing the plan from memory of files read earlier in the session rather than
re-opening them at the moment of citation.

The same cause produced the substantive bug: Task 4 cited
`/api/settings/route.ts`'s auth trio while claiming to follow
`/api/settings/competitors/route.ts`, which actually uses `requireSettingsOwner`
+ `withSameOrigin` + an explicit `businessId`. And `requireOwnerAccess` returns
cookie-resolved **`currentLocationId`**, not `businessId` — so the plan would
have shown one location and written another in multi-location accounts.

*Lesson: cite from the open file, not from recall. The cited-artifact check
exists because this failure mode is invisible to plan-internal review — the plan
was perfectly self-consistent and still wrong.*

## What the review caught that no amount of self-review would have

The all-or-nothing CHECK enforces tuple **completeness**, not that the
attestation covers the **current bytes**. An address-only `UPDATE` on an already
attested row leaves all four columns non-NULL and passes. `attestPostalAddress`
being well-behaved constrains no other writer — a migration, an admin fix, a
future bulk update. The stale-attestation defect the whole feature exists to
prevent was reachable through the schema the feature added to prevent it.

Intake v2 answers it in the schema rather than in a convention: an
attested-bytes digest column inside the same all-or-nothing tuple, CHECKed
against `sha256` of the stored address, so an address-only update fails closed.

## Process notes worth keeping

- Two `rg -rn "a|b"` recon commands were malformed (`-r` is ripgrep's *replace*
  flag). One returned empty output briefly read as a real answer. **An empty
  ripgrep result is only evidence if the flags were right.**
- The first `codex exec` dispatch hit the harness 10-minute wall mid-run and
  produced no verdict. Long adversarial reviews belong in the background with
  stdin closed from the start.
- Round 1 was worth its cost several times over: three Criticals, one of which
  (#2) was pure bookkeeping invisible to any reasoning-only review, and one of
  which (#3) was a genuine design hole.
