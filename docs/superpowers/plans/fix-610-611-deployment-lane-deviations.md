# Deviations — fix-610-611-deployment-lane

Departures from the plan of record (`fix-610-611-deployment-lane.md`, revision 5)
and the locked intake, recorded as they happen. None of these is a scope change;
each is either a correction to plan prose or a faithfulness improvement inside an
already-agreed ticket. A genuine scope change would be a surface amendment
(budget: 1 of 2 used, both spent in adversarial round 1).

## T1

### D1 — the plan says 18 test titles for T1; the intake lists 17

`fix-610-611-deployment-lane.md:218` says
`(18 titles: 5 lane-name, 7 requiresProductionConfig, 2 deploymentLaneFields, 3 safety-property, 1 Sentry lane-value mapping)`.
That breakdown sums to 18 but double-counts: the Sentry lane-value mapping title
is itself one of the three counted as "safety-property". The intake's
`tests_to_add[0:17]` — the locked contract the gate matches literally — lists
**17** titles for `src/lib/config/__tests__/deployment-lane.test.ts`, decomposing
as 5 lane-name + 7 `requiresProductionConfig` + 2 safety-property + 1 Sentry
lane-value + 2 `deploymentLaneFields`.

**Resolution:** the intake wins; T1 shipped 17. Independently confirmed by the
spec reviewer. Plan prose error only — the intake was never wrong, and the total
of 38 titles across all tickets is unaffected.

### D2 — two stale line numbers in the plan's call-site map

The plan's map (`fix-610-611-deployment-lane.md:153-169`) cites:

| plan says | actual |
|---|---|
| `worker/config/fastify-options.ts:11` log level | the signature is `:11`; the expression is **`:13`** |
| `src/lib/shared/logger.ts:32` `error_stack` gate | `:32` is `function serializeError`; the gate is **`:38`** |

Found independently by both the spec and code-quality reviewers. The other ten
sites in the map were verified exact.

**Resolution:** T1's test file no longer carries line numbers for these sites at
all — each of the twelve encoded sites now names its **enclosing function**,
which survives the edits T2/T3 are about to make to those same files. The plan
doc's map is left as-is (it is a historical record of the locked plan); T3's
dispatch prompt carries the corrected pointers directly, so no implementer reads
the stale numbers.

### D3 — T1 encoded each site's FULL original expression, not just its `NODE_ENV` term

The plan's call-site map lists only the changing `NODE_ENV` term per site. T1's
safety-property tests (titles 13/14) instead transcribe each site's complete
original expression as it appears in the tree, including the
`MOCK_EXTERNAL_APIS` conjuncts at `startup-assert.ts:56/71/87`,
`src/lib/config/worker.ts:250`, and `OnboardingDemoWorker.ts:55` (the last via
`isMockMode()`, which is exactly `MOCK_EXTERNAL_APIS === 'true'`).

**Resolution:** kept. Strictly more faithful than the plan's abbreviation, and
the safety property still holds for all twelve sites. The spec reviewer verified
every transcription against the real source and confirmed no site carries an
env term the union fails to model — other than the deliberately-excluded
`AccountOffboardingPurgePoller.ts` (`VERCEL_ENV`), which title 12 pins.

### D4 — `lane_source` is omitted, not defaulted, when neither variable is set

The interface in the plan is `deploymentLaneFields(env?): Record<string, string>`
returning `{ deployment_lane, lane_source }`. The plan does not say what
`lane_source` should be when neither `RAILWAY_ENVIRONMENT_NAME` nor `NODE_ENV`
is set (lane resolves to the `'development'` default).

**Resolution:** the key is omitted rather than given a third invented source
name, matching `replicaIdentityFields()`'s documented only-defined-values
convention (`worker/config/replica-identity.ts:77-79`). `'development'` in that
case is a default, not a reading, so naming a source for it would be a lie.
Pinned by title 17.

### D5 — code-quality review findings accepted, and one declined

Review returned 3 Important + 5 Minor. Accepted: the single-owner refactor for
the precedence rule (an internal `resolveLane`, public surface unchanged at
three exports); the two stale site references (D2); a note that the
`fastify-options` site receives its value as a **parameter** from
`worker/index.ts:177` rather than reading `process.env`, so T3's migration there
changes the caller; pinning that trimming actually trims (not merely that blanks
are treated as absent — `value || undefined` would otherwise pass all 17 tests
while returning `'  staging  '`, a distinct Sentry environment); making title 9's
"deployed Vercel build" fixture genuinely distinct from title 8's; covering the
zero-argument path that production actually uses; and mirroring test 13's
non-vacuity comment onto test 14.

Declined: collapsing the `DeploymentLaneEnv` docblock into a cross-reference to
`ReplicaEnv`. Local rationale is worth its space.

### D6 — two of the review's own claims were corrected by measurement

Both corrections came from the implementer mutation-testing the fixes rather
than trusting a green suite, and both are recorded because the *reasoning*
mattered more than the patch:

1. **The trimming gap was misdiagnosed in the review (and in my triage).** The
   stated mutant — `trimmedOrUndefined` → `value || undefined` — was *already*
   caught, by title 4's `'   '` case. The real surviving mutant was **trim to
   detect, return untrimmed**, which passed all 17 titles before the fix and
   fails after it. The finding was genuine; only its stated failure mode was
   wrong.
2. **Covering the zero-argument path in title 3 alone would not have closed the
   hole it was meant to close.** A typo like `RAILWAY_ENVIRONMENT` for
   `RAILWAY_ENVIRONMENT_NAME` still yields `'development'` when nothing is set,
   so a both-unset assertion passes under exactly that mutant. Only a *positive*
   read kills it. The implementer therefore added a second stubbed assertion
   inside title 1, whose text ("prefers RAILWAY_ENVIRONMENT_NAME over NODE_ENV")
   is where such an assertion is honest. Accepted — it broadens the instruction
   rather than narrowing it, and the mutation result argues for it. No new
   titles; still exactly 17.

### D7 — one residual closed rather than deferred

The quality re-review approved T1 with a single measured Minor: mutating
`platformLaneEnv`'s **`NODE_ENV`** read to a wrong name survived all 17 titles
(the `RAILWAY_ENVIRONMENT_NAME` half was pinned by D6's title-1 stub). The
reviewer judged it non-blocking — both worker call sites run on Railway, where
`RAILWAY_ENVIRONMENT_NAME` is always set — and proposed deferring it to T2.

**Resolution:** closed inside T1 instead, as three lines within locked title 2.
It is the same class of bug as the one D6 proved matters, and deferring a
three-line test into a ticket that edits a different file would have left it
homeless. Verified by mutation, not by green.

Because sibling tickets were committing concurrently by then, this landed as a
**new commit rather than an amend** — amending `732da539` would have rewritten
history underneath T2/T3/T5.

## Step 5 — gate

### D17 — SURFACE AMENDMENT #2 (of 2): `scripts/verify-gate.sh`

The first gate run came back **RED on `promised-tests`**, listing 10 of the 38
locked titles as missing. Neither cause was a missing test:

1. **Eight T4 titles** live in `scripts/ci/__tests__/static-policy-audit.test.ts`.
   The gate's matcher (`verify-gate.sh:149`) grepped only `src worker`, so it
   never looked there — while the intake's own `allowed_edit_surface` explicitly
   sanctions that path. The intake and the gate disagreed. All eight tests
   existed, all 136 tests in that suite passed, and `pnpm ci:static-policy` was
   green across 1038 files.
2. **Two T1 safety-property titles** contain an apostrophe. Written
   single-quoted, it had to be escaped (`that site\'s`), and the gate matches
   with a **fixed-string** grep — so the locked title never matched, though the
   runtime name was correct and both tests passed.

Cause 2 was fixed in-surface (`56332bd2`): both titles switched to double quotes
so the apostrophe stays unescaped. No behaviour change.

Cause 1 required editing `scripts/verify-gate.sh`, which was **not** in the
allowed surface — surface amendment **#2 of 2**, which the handoff designates as
step 5's abort trigger. Escalated to the human rather than taken unilaterally;
**approved**, on the grounds that the gate was objectively wrong and the fix is
one word that benefits every future feature. The grep now searches
`src worker scripts`, and the rationale plus the unescaped-apostrophe
requirement are recorded in the script's own comment so the next author does not
rediscover either the hard way.

**The amendment budget is now exhausted. Any further surface change must abort
to a step 0 re-plan.**

### D18 — reclassify WARN accepted, not re-planned

The gate WARNed that the actual diff (2172 changed lines) exceeds 2× the
intake's `estimated_diff_size` (545), which is feature.md's re-classification
trigger. Escalated with the breakdown; **approved to proceed**.

| slice | changed lines |
|---|---|
| code (`src/`, `worker/`, `scripts/`) | **1030** — 1.9×, *under* the trigger |
| docs (ADR, runbooks, glossary, env-vars, `.env.example`) | ~287 |
| planning artefacts (intake, plan, handoff, this file) | **855** |

The overrun is accounting, not scope creep: the estimate covered the code and
the listed doc edits but never counted the planning artefacts the workflow
itself mandates, and the code slice is under the trigger on its own. The
migrated site count is exactly the 12 the plan specified — no unplanned feature
work landed. The code overrun above estimate is tests being more thorough than
projected (T1's suite alone is ~270 lines).

### D19 — step 6 dual review: Spec clean, Standards clean of hard violations

Standards axis: **0 hard violations**, 4 judgement calls. It independently
confirmed invariants #1, #13 and #15 hold, and that `src/lib/shared/logger.ts`
is reached only by server route handlers — so the `process.env` read it gained
never enters a client bundle.

Spec axis: **0 findings**. Independently confirmed the purge poller is
byte-for-byte unchanged, all 12 mapped sites migrated, precedence and union not
collapsed, and every production-lane test uses the real #611 configuration
(`NODE_ENV` deleted, `RAILWAY_ENVIRONMENT_NAME='production'`) rather than
`NODE_ENV='production'`, which would have passed against the old code.

Of the 4 judgement calls, two were accepted and two declined:

- **Accepted:** the module header restated ADR 0013's reasoning without citing
  it — the one touched artefact that did not trace back. Header now points at
  the ADR and says the ADR owns that reasoning.
- **Accepted, but see D20:** `deploymentLaneFields()`'s return type narrowed
  from `Record<string, string>` to a declared `DeploymentLaneFields`.
- **Declined:** the boot log carrying the same Railway value under both
  `railway_environment` (from the pre-existing `replicaIdentityFields`) and
  `deployment_lane`. The two are semantically different — raw variable versus
  resolved lane — and `replica-identity.ts` is outside this change's scope.
- **Declined:** renaming `buildFastifyOptions`' `productionConfigRequired`
  parameter to `quietLogging`. The plan asked for the parameter to name "the
  decision it now carries", which is exactly `productionConfigRequired`;
  `quietLogging` would leak Fastify's local concern into the caller's
  vocabulary.

### D20 — a review finding was accepted on a rationale that turned out to be false

The Standards axis argued the `Record<string, string>` return type made
`laneProof`'s `!source` branch **invisible to the compiler**, because `source`
would type as plain `string`.

**That was wrong, and it was verified after the fact rather than taken on
trust.** This repo sets `noUncheckedIndexedAccess: true` (`tsconfig.json:8`), so
destructuring a `Record<string, string>` already yields `string | undefined`. A
probe compiling `const s: string = oldSource` under the project's own flags
errors with `TS2322` — proving the branch was always compiler-visible. There was
no type hole.

The narrowing to a declared `DeploymentLaneFields` interface was **kept anyway**,
on two smaller but genuine grounds that the review did not state:

1. `lane_source` is now typed as the `LaneSource` union rather than bare
   `string`, so an invalid source value fails to compile.
2. A key rename now breaks the build; under `Record<string, string>` a renamed
   `deployment_lane` would have silently produced `undefined`.

Recorded because the reasoning matters more than the diff: the change is right,
the argument originally given for it was not.

## T2 (`52997537`)

### D14 — the ticket set up a contradiction; the implementer dissolved it

T2's brief required two things that collide: reword the `:57` error message (its
`NODE_ENV=production cannot run with MOCK_EXTERNAL_APIS=true` text stops being
accurate once the predicate is the lane union, since it can now fire with
`NODE_ENV` unset), **and** change no pre-existing test expectation (the hard
tripwire). But an existing test asserts
`/NODE_ENV=production.*MOCK_EXTERNAL_APIS=true/`.

**Resolution:** a `laneProof()` helper renders the proof as `${source}=${lane}`.
When the source *is* `NODE_ENV` that reproduces the old string byte-for-byte, so
the pre-existing expectation still passes; on the Railway lane it reads
`RAILWAY_ENVIRONMENT_NAME=production`, which is accurate. Both constraints hold
with no expectation rewritten. The contradiction was mine, not the plan's.

### D15 — `isProd` renamed to `httpsRequired` at `assertWorkerPublicUrlFormat`

The local no longer describes its value once the predicate is the lane union —
it gates whether `https` is required, not whether the process is "in production".
Rename accepted.

### D16 — three additions beyond the ticket's letter, all forced

1. **`NODE_ENV` added to the `assertZernioPublishingEnv` KEYS list.** Locked title
   6 requires deleting `NODE_ENV` in that block, but it was not in that block's
   save/restore list — so the deletion would have leaked into every later
   `describe`. Exactly the flakiness class the `RAILWAY_ENVIRONMENT_NAME`
   sanitisation exists to prevent.
2. **A `deleteEnv(key: string)` helper**, for the same `TS2704` read-only
   `NODE_ENV` reason T3 hit independently (see D9). Routes through `ProcessEnv`'s
   index signature, matching the file's existing `setEnv` and `for (const k of KEYS)`
   loops.
3. **Four doc comments reworded.** The brief said to leave the `:181` prose alone.
   The implementer kept the `NODE_ENV` *text* but corrected the predicate each
   comment describes, arguing that "fires only when NODE_ENV=production" sitting
   above a lane-keyed guard is a stale-comment bug. Accepted — the instruction
   was about not counting prose as a migration site, not about preserving wrong
   comments.

`assertChannelsTelegramEnv` uses a whole-`process.env` snapshot rather than a
`KEYS` list; left untouched, since it has no lane dependency and a full-env
restore cannot leak.

## T3 (`562711f1`)

### D8 — `worker/index.ts` needed two lines, not the one the ticket allowed

T3's surface permitted "one line" in `worker/index.ts` (the `buildFastifyOptions`
call site). It took two: the call site, plus appending `requiresProductionConfig`
to the **existing** `deployment-lane` import that T1 added on line 70. A second
`import` statement from the same module would have tripped `no-duplicate-imports`.
Correct call; the diff is exactly those two lines and nothing else.

### D9 — `vi.stubEnv` was rejected for these three suites, with a reason

The controller suggested `vi.stubEnv` or the dynamic-key harness to work around
`TS2704` (`@types/node` declares `NODE_ENV` read-only, so `delete process.env.NODE_ENV`
is a type error; the existing `startup-assertion.test.ts` only escapes it because
its loop deletes via a *dynamic* key, not because of any exemption).

T3 used neither verbatim: `vi.stubEnv` writes to `state().metaEnv`, and these
suites needed synchronous wholesale env control. Each of the three got a local
4-line `setEnvVar(name, value)` helper routing through `ProcessEnv`'s index
signature — the same mechanism as the existing loop, just named. No `any`, no
double cast. Also discovered: `NODE_ENV` is typed **required** as well as
read-only, so a `{...} as NodeJS.ProcessEnv` object literal fails `TS2352` too.

Residual: three near-identical `setEnvVar` helpers now exist. Deduplicating them
would need a new shared `__tests__/helpers/` file outside T3's edit surface, so
it was left. Worth folding together if a fourth suite needs it — noted, not a
defect.

### D10 — `--no-verify` on T3's commit was a verified no-op

T3 committed with `--no-verify` to stop a hook running lint/tests across siblings'
half-finished trees, and flagged it as a bypassed gate. Confirmed harmless:
`lefthook.yml` defines **only** a `pre-push` hook, so there was no commit-time
hook to bypass. Nothing was skipped.

## T5 (`50d46e81`)

### D11 — "five inert boot gates" was imprecise; the ADR states it correctly

The plan and the issue narrative say #611 left *five* production-only boot gates
"returning early and inert". Evaluating each original predicate with `NODE_ENV`
unset (the live production configuration) shows that is loose:

| site | in production | actually |
|---|---|---|
| `assertAdminNotificationEmail` `:188` | `undefined !== 'production'` → return | **inert** |
| `assertAlertSinkEnv` `:208` | `undefined !== 'production'` → return | **inert** |
| `warnMissingProductionEnv` `:229` | `undefined !== 'production'` → return | **inert** |
| `assertStripeWorkerEnv` mockSkip `:71` | first conjunct true, but `MOCK_EXTERNAL_APIS === 'true'` is false | **not** skipped — the assert still ran |
| `assertCoreInfraEnv` mockSkip `:87` | same | **not** skipped — the assert still ran |

So exactly **three** were unconditional no-ops. The two mock-skips survived on an
*unrelated* setting, not because the gate worked — which is a weaker guarantee
than "it was fine", and worth stating precisely.

Two further nuances the count also obscured: `assertProductionMockModeEnv` (`:56`)
was inert in the opposite direction — its `NODE_ENV === 'production'` enforcement
could never fire, so it could not have caught `MOCK_EXTERNAL_APIS=true` in
production; and `assertWorkerPublicUrlFormat` (`:295`) was not inert but
**degraded**, accepting an `http` origin where production should require `https`.

**Resolution:** T5's sharper wording is kept in ADR 0013 in preference to the
plan's "five". Verified independently against the pre-migration file.

### D12 — ADR 0013 describes T4's CI rule in the present tense

T5 wrote the ADR assuming T4 lands in the same PR. If T4 is dropped or narrowed,
that paragraph and the `.env.example` framing need a follow-up edit. Tracked here
so it cannot be forgotten if T4's scope moves.

### D13 — `.env.example` gained a deployment-lane warning beyond the ticket's letter

The ticket required only a #614 reference at the purge-override entry (which was
left otherwise intact, as instructed). T5 additionally added a
`Deployment lane (platform-injected — DO NOT SET HERE)` note, judging that copying
`RAILWAY_ENVIRONMENT_NAME` into a local `.env` is a real silent footgun — it flips
`requiresProductionConfig()` true locally and suppresses `error_stack`. Accepted;
the ticket explicitly left that call to the implementer's judgement.
