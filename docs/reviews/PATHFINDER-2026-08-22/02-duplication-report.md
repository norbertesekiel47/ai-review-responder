# Pathfinder 2026-08-22 — cross-feature duplication report

Phase 2. Within-feature leads live in each chart's own "Duplication leads"
section; **this report is the cross-boundary judgement.** Every claim below was
re-read at `74aee92a` by the Phase 2 agent, not copied from a chart — **ten
Phase 1 leads were refuted or corrected** in the process (§4).

Verdicts: `UNIFY` · `LEGITIMATE` · `LEAVE` (real duplication, fix costs more than
the drift) · `REFUTED`.

## X12. `closeBatchIfSettled` — 13 callers, one implementation — **LEGITIMATE**

Definition `outreach.ts:330`. Callers: `approval.ts:455/:608/:1344` ·
`ask-generation.ts:865/:997/:1171/:1488/:1682` · `dispatch.ts:1187/:1386` ·
`release.ts:458/:708` · `failed-hook.ts:266`.

**Convergence, not divergence.** Three properties make one implementation correct
for every lane: it takes the batch lock **itself** (`:335-348`), so no caller owes
it one; `send_closed_at IS NULL` (`:405`, `:420`) gates every write below, so a
second arrival is inert; and it branches on the **resolved disposition**, never on
`input.failure` being present (`:449-459` gives the failure mode of the
alternative). The `not found` throw at `:351` is live for exactly one caller —
`release.ts:458`, whose ids come from a scan run outside the transaction.

**One new caveat neither F1 nor F4 states.** `outreach.ts:392`
`if (!input.failure) return { status: 'no_send_parent' }` is **reachable from
`latchHalt`** (`approval.ts:608`), which passes no failure, on a `built` batch with
no send parent. `approveBatch:322-325` documents that such batches exist;
`haltBatch:675` permits halting `built`. **That reachability is what turns X13
from a style finding into a wire defect.**

## X13. The close-settled predicate — five sites, three forms — **UNIFY** (now with a demonstrable defect)

| # | Site | Form |
|---|---|---|
| 1 | `api/admin/solicitation/batch/halt/route.ts:91` | `result.close.status !== 'not_settled'` |
| 2 | `api/dashboard/solicitation/batch/halt/route.ts:45` | same |
| 3 | `api/dashboard/solicitation/batch/withdraw/route.ts:43` | same |
| 4 | `api/dashboard/solicitation/batch/approve/route.ts:60` | `result.close !== null` |
| 5 | `release.ts:465` | `result?.status === 'closed'` |

**F4 and the handoff agent are BOTH right, about different things.** F4 is right
that `release.ts:465` asks a different question — it counts events for
`PhaseTally.handled`, and `already_closed` is a race loser, `not_settled` a live
batch (`:442-445` argues this correctly). The handoff agent is right that **its
correctness is caller-local prose**: `closed_without_parent` is excluded not
because the tally wants it excluded but because `runBackstopJoin` passes no
`failure` and therefore cannot reach that arm. Nothing mechanical holds that.

**The new evidence that settles the ranking: form 1/2's `!== 'not_settled'` is
WRONG for a reachable input.** `'no_send_parent' !== 'not_settled'` is `true`, so
**halting an all-withheld `built` batch makes both halt routes report
`closed: true` while `send_closed_at IS NULL`.** Reachability verified end to end
(X12).

**Severity today is latent, not live** — `ApprovalPanel.tsx:637` reads `closed`
and `:707` consumes it only in `withdrawnAnnounce`, and `withdrawAsk:1326` throws
when there is no send parent, so the one verb that reads the field cannot reach
the bad input. **But the halt routes ship the wrong boolean over the wire now, and
#886 proposes to extract exactly the code that reads it.**

**The owner:** `batchDidClose(close)` in `outreach.ts`, defined as a **positive
enumeration** — `'closed' || 'closed_without_parent' || 'already_closed'` — which
makes `no_send_parent` fall out correctly instead of relying on `!== 'not_settled'`
being a proxy. `release.ts:465` keeps its own `=== 'closed'` with a one-line
comment naming it a **tally, not a receipt**.

> **#891's ticket text must be corrected before anyone works it.** It prescribes
> a single predicate for five sites. **The right shape is one predicate for four
> and an explicit non-adoption note for the fifth.**

## X14. Delivery-status subsets — three questions, seven spellings — **UNIFY (three constants, not one)**

*Cancellable* `('rendered','queued')` — **six**: `approval.ts:569`, `:1300`,
`batch-view.ts:957` (SQL) · `approval.ts:1185`, `ApprovalPanel.tsx:980`,
`AskList.tsx:306` (TS).
*Live* `('rendered','queued','sending')` — `approval.ts:1320`, and it is migration
091's own index predicate at `091:413`.
*In-flight-dispatched* `('queued','sending')` — **the seventh, confirmed**:
`failed-hook.ts:90` `isTerminalizableArrival`, with `:84-88` giving the reason
`rendered` is excluded.
A fourth subset exists at `ask-generation.ts:887`.

**Three distinct subsets argue FOR the extraction, not against it.** The prior
pass's anti-pattern warning was *"folding them makes one constant answer three"* —
**that is an argument against ONE constant, not against a shared owner.** Three
named exports make the three questions nameable and distinguishable, which is
exactly what six anonymous inline spellings prevent. **The current state IS the
failure mode the warning describes, achieved by not extracting.**

Shape: `src/lib/solicitation/delivery-status.ts` exporting
`CANCELLABLE_DELIVERY_STATUSES`, `LIVE_DELIVERY_STATUSES`,
`DISPATCHED_ARRIVAL_STATUSES`, each with a one-line docstring naming its question.
The three SQL spellings stay literal; the four TypeScript spellings import.

**Do not** derive any of the three as the complement of
`TERMINAL_DELIVERY_STATUSES` — its complement is the *live* set, a different
question, and `failed-hook.ts:84-88` gives a domain reason `rendered` must be
excluded from *arrival* that no set algebra expresses.

## X15. Terminal-attempt predicate — **UNIFY.** F2's "three copies" is **REFUTED: there are five**

The `'failed'`-EVENT form `job.attemptsMade >= maxAttempts`, **byte-identical,
four copies**: `worker/jobs/solicitation-batch/failed-hook-shared.ts:22-28`
`isExhaustedJob` (**exported**) · `worker/jobs/judge/failed-hook.ts:44-57` ·
`worker/jobs/solicitation-send/failed-hook.ts:93-106` ·
`worker/job-failure-sink.ts:38-44`. **The middle two carry a verbatim eight-line
comment, identical down to the phrase "do not unify them."** Plus the catch form
(`shared/outbox.ts:211-216`) and three ad-hoc spellings with three different
defaults (`?? 3`, `?? 5`, `?? 1`).

**Every copy obeyed the "do not unify" instruction — which is about event-form vs
catch-form — and then independently re-implemented the event form, because the
instruction says what not to merge and never says where the event form lives.**

Three pieces of decisive evidence:
1. **`solicitation-send/failed-hook.ts:49` already imports `boundedErrorClass`
   from `'../solicitation-batch/failed-hook-shared'`** — the same module, in the
   same import statement it would need — and then re-implements `isExhaustedJob`
   44 lines later. **The folder boundary that module claims has already been
   crossed by this exact file, for this exact module.**
2. `failed-hook-shared.ts:5-10` says the module exists because *"Two copies of
   'how do we decide a job is exhausted' is two places to get it wrong; the
   duplication was caught by the fallow clone detector on #628."* **The fix worked
   for two copies and the class then recurred four more times outside the folder.**
3. **`job-failure-sink.ts:24-26` states it was directed to reuse the shared helper
   and declined** — correctly, because it was pointed at `isTerminalAttempt` (the
   catch form). **Nobody pointed it at `isExhaustedJob`. The right owner existed
   and was invisible.**

**A separate defect in the shared catch-form helper.** `shared/outbox.ts:215`:

```ts
return job.attemptsMade >= maxAttempts || job.attemptsMade + 1 >= maxAttempts;
```

`a >= m` implies `a+1 >= m`, so **the first disjunct is dead**. The disjunction
makes the function *look* like it handles both contexts — which is exactly the
misreading `job-failure-sink.ts:24` had to write six lines of prose to escape.

**This is the item the window made worse: three copies to five in one window.**

## X16. `boundedErrorClass` — one name, **two bodies, two security postures** — **UNIFY**

*Body A* — `err.name.slice(0, 100)`, no shape validation:
`csv-ingest/failed-hook.ts:94-97` · `judge/failed-hook.ts:39-42` ·
`job-failure-sink.ts:59-62`.
*Body B* — `err.constructor.name` + `/^[A-Za-z][A-Za-z0-9_$]{0,99}$/`:
`solicitation-batch/failed-hook-shared.ts:36-41` (exported, three importers).

**They compute different things.** `err.name` is a writable instance/prototype
property; `err.constructor.name` is the class. For any error class that sets
`name` — the repo has several (`EmailSendTimeoutError`,
`CostInfraUnavailableError`) — **the two answers differ. Four call sites logging
under one identifier produce two different values for the same error.**

**And the divergence runs the wrong way.** `failed-hook-shared.ts:33-35` states
Body B's safety property: *"a hostile or exotic error type cannot inject structure
into the log line."* `job-failure-sink.ts:55-56` states the threat —
*"`Error.name` is attacker-influenceable on a custom class"* — **and then does
nothing beyond a 100-char slice.** The threat model is written at a site that does
not defend against it, in a repo where the hardened version already exists three
directories away, and where CLAUDE.md's logging rule says string args are logged
verbatim.

`job-failure-sink.ts:53-58` explicitly reasons about *"diverging from the sibling
helper readers will compare this against"* — **it identified the wrong sibling.**

## X17. UTC-day boundary — four byte-identical spellings across two lanes — **UNIFY**

`send-caps.ts:74`, `:91` · `release.ts:1528` ·
**`worker/jobs/response-generation/auto-approval.ts:231`** — outside the
solicitation lane entirely.

`send-caps.ts:52-61` says outright that it copied `auto-approval.ts:231`, and
why: the trailing `AT TIME ZONE 'UTC'` is load-bearing because `date_trunc` over a
naive timestamp coerces via the session `TimeZone`, which nothing pins.

**The tests provably cannot catch the drift.** `send-caps.ts:59-61` records it:
*"Found in #898 review — the fixture used the same expression, so every test
passed either way."* **A fixture that re-spells the production expression is
symmetric with it under any mutation.**

The repo has the remedy twice, both with headers that pre-authorise this move:
`held-draft.ts:57` `openFlagExistsSql` (#730, three consumers across three
features) and **`src/lib/kpi/fragments.ts` (#688/#757, ADR 0019), created for this
exact shape** — *"it exists for LOCALITY of one load-bearing spelling…
`fragments.test.ts` fails if any non-test source file outside this one spells the
anchor."*

`fragments.ts:11-16` also states the constraint that makes it audit-safe and that
this case satisfies: the fragment spells no `FROM`/`JOIN` and no tenant predicate,
so `ci:tenant-scope` (which reads raw template text) still sees every caller's
scope written out literally. **Ship the test with the fragment — it is the only
thing that makes this stick, given the fixture blind spot.**

## X18. Send-parent lookup — **UNIFY the canonicalisation, NOT the query.** `canonicalBatchId`'s bug is reproduced

Seven sites. Three bind `subject_id` Postgres-side (`r.subject_id = b.id::text`,
always canonical); two lowercase in TypeScript (`run-spine.ts:486`,
`outreach.ts:334`); **two bind it raw** — `ask-generation.ts:1434` and `:1637`.

**The query is legitimately two functions.** `run-spine.ts:486` asks *"is there an
ACTIVE send parent"* (`status='running'`, no ordering); the rest ask *"the LATEST
send parent"* (`ORDER BY started_at DESC LIMIT 1`). **Leave the query shapes.**

**The canonicalisation is a live, reproduced bug.** `approval.ts:135-152`
`canonicalBatchId` exists *because this already shipped*:

> *"`isValidUuid` — the validator the routes use — accepts upper case, so a
> mixed-case request id matched the batch row (`b.id = $1::uuid`) and MISSED that
> batch's send parent: `approveBatch` threw a 500 and `haltBatch` silently dropped
> its `batch_halted` step. Canonicalise ONCE at the entry point."*

**`settleGenerationExhaustion` uses the same `input.batchId` both ways in one
transaction:** `ask-generation.ts:1590` `WHERE id = ${input.batchId}::uuid` (cast,
case-insensitive → batch found, lock taken) and `:1637`
`AND subject_id = ${input.batchId}` (raw TEXT → parent missed). The consequence is
silent: `:1656` writes `agentRunId: parent?.id ?? null` on every filled hole and
the generation steps are skipped — **while `closeBatchIfSettled` 40 lines later
lowercases internally and DOES find the parent. Two readers of the same key, in
the same transaction, disagreeing.**

`ask-generation.ts` contains **zero** `canonicalBatchId` calls and zero
`.toLowerCase()`. It is safe today only because `loadBatchContext:200-210`
round-trips the id through Postgres — **a two-hop accident, not a guard, and
`settleGenerationExhaustion` does not use `ctx` at all.**

Fix: export `canonicalBatchId` from a leaf and call it at `ask-generation.ts`'s two
entry points. **Two lines.**

## X19. `completeOutboxNoop` — **LEAVE the hoist; UNIFY the second in-file spelling**

Two bodies, byte-identical modulo names, different interfaces. **The hoist answer
is unchanged — two copies, threshold not met.**

**But the fold-in's stated justification is empirically FALSE.**
`dispatch.ts:1865-1866` reads *"The exact-attempt guard now lives in
`completeOutboxNoop`"*, and `:1868-1870` **immediately re-spells the guard and the
literal.** So the claim "the only code that depends on it" is wrong within its own
file. **The drift has not changed the hoist answer, but it has invalidated the
argument used to justify creating the second interface.**

Cheap local fix: a private `requireExactAttempt(handle)` that both `:439-441` and
`:1868-1870` call. One literal, one file, no cross-module move. The
`shared/outbox.ts` hoist waits for the third copy, exactly as `:430-432` says.

## X20. The reveal primitive — **UNIFY 1+2+3, leave 4** (two corrections to F6)

| # | Site | Note |
|---|---|---|
| 1 | **`src/components/ui/Reveal.tsx:6`** | **NOT `sections/how-it-works/Reveal.tsx`. No such file exists.** It is already in the shared UI directory. |
| 2 | `sections/features/useReveal.ts:4` | hook |
| 3 | `sections/how-it-works/StatCards.tsx:79-93` | inline, `rootMargin '-60px 0px'`, no threshold |
| 4 | `sections/landing/reveal.tsx:48` | `motion/react`, **different design system — leave** |

**Correction 2:** `Reveal` is consumed by **`(public)/pricing/PricingContent.tsx:7`**
as well as `HowItWorksContent.tsx:8` and `JudgeArtifact.tsx:3`. **It already spans
two of F6's three lanes and already sits at the address a consolidation would
target.**

**F6's empirical argument is CONFIRMED, with a +2 line correction.**
`Reveal.tsx:9-28` has no reduced-motion branch (import list at `:3` is
`useEffect, useRef, useState, type ReactNode` only). `how-it-works.css:300` gates
`JudgeArtifact`'s verdict dot on `.rw-dl-rv.is-in` — a class `Reveal` never flips
under reduced motion — **forcing the compensating rule at `how-it-works.css:389`,
not `:387`**, inside the `@media (prefers-reduced-motion: reduce)` block opened at
`:377`. **Without it the verdict dot is permanently `scale(0)` for a
reduced-motion visitor — an element that never appears at all.**

**The asymmetry that proves the mechanism:** `features.css:602` also compensates
inside a reduced-motion block, but in the *opposite* direction — suppressing an
animation that `.is-in` *did* start. **That is what compensating for `useReveal`
looks like. `how-it-works.css:389` is what compensating for `Reveal` looks like.**

## X21. `island.css:1276` — **a DECLARED seam — UNIFY (split the file)**

Line `1276` is literally
`/* ---------- Shared marketing primitives (.rw-dl-*) ---------- */`. Below it: 85
selector lines over **43 unique class names**, the largest family in the file.

**Consumers of `.rw-dl-rv`, counted mechanically:** 11 files under
`sections/features/` (12 occurrences) + `components/ui/Reveal.tsx` + 1 test.
**Zero in F5's own chrome** — `rg -c "rw-dl-"` over `SiteNav.tsx`,
`SiteFooter.tsx`, `SiteShell.tsx`, `MarqueeBackground.tsx` returns nothing at all.

Three facts make it a seam rather than an acceptable shared layer:
1. **It is already labelled as one** — the section comment names the boundary, the
   concern and the prefix.
2. **The consumer sets are disjoint.** Not one F5 chrome component touches a
   `.rw-dl-*` class.
3. **Ownership is inverted in the cascade.** F6's page CSS extends
   `.rw-dl-rv.is-in` from five places, and `how-it-works.css:353` declares
   `.rw-pill.is-disabled` — a modifier on an `island.css` primitive, declared in a
   page file, **consumed by a different page**. A shared layer that page files
   extend upward into and declare modifiers for is not a stable layer; it is a
   file that outgrew its name.

Split is mechanical: `(public)/_styles/daylight-primitives.css` for `:1276-1591`,
one new `@import` **appended, not inserted** (`design-scope-purity.test.ts:152-194`
pins presence + ascending order + position-after-`:root`). **This is the
prerequisite for F5 and F6 ever being changeable independently.**

## X22. The FAQ accordion — **CSS half REFUTED; JSX half UNIFY**

**The CSS half is REFUTED. There is no fork.** `pricing.css:231-277` is the
trial-posture line and the Compare matrix — no FAQ rules.
`rg "rotate\(45deg\)|grid-template-rows: 0fr"` across all four `_styles/*.css` +
`globals.css` returns **two hits, both in `island.css`**. `pricing.css` has no
`.pr-faq-icon`; its only FAQ rules are `:307-315`, a grid wrapper plus a
**descendant override of the shared primitive**, and `pricing.css:10` says so.
*(Also: `pricing.css` is **387** lines, not the 332 in SCOPE.md seed 21.)*

**The JSX half is CONFIRMED and exact.** `HowItWorksContent.tsx:370-396` and
`PricingContent.tsx:483-509`: same `useState(0)`, same `useId()` base, same
`${base}-faq-panel-${i}` scheme, same `aria-expanded`/`aria-controls` wiring, same
toggle, same six class names, same markup.

**It IS cross-feature.** The finding is not "two pages have similar JSX" — it is
that **`island.css:1484-1531` is a fully-specified design-system primitive with no
React counterpart, so every consumer re-implements the 26-line controller.** The
stylesheet is F5's, the consumers are F6's, and the seam is X21's. **The route is
already proven by `Reveal`** — a shared `.rw-dl-*` class hoisted to
`components/ui/` and consumed from both `(public)/pricing/` and
`sections/how-it-works/`. Owner: `src/components/ui/Faq.tsx`.

## X23. The `selfServe && trial` conjunction — **UNIFY the READ.** A tenth surface is already wrong

Nine spellings confirmed (seven identical, one object-property, one with
**reversed operands** at `(public)/page.tsx:19`).

**The render half genuinely cannot be hoisted. Verified.** `(public)/layout.tsx`
is 30 lines and `:9-16` states the landmark contract forbidding a layout-level
`<main>`. **An App-Router layout receives `children` as an already-materialised
node across the RSC boundary — no props injection, no server-side context.** And
the render trees genuinely differ across three islands, two of which render no
footer. **F5's verdict is right.**

**The read half has an exact in-repo precedent that already burned on this bug.**
`payments/plan-activation.ts:150-160` `isTrialEligible` is the **SINGLE OWNER** of
trial eligibility, and `:120-149` records precisely this failure:

> *"The two checkout entry points … spelled this independently and DISAGREED: the
> funnel's copy carried only the first and last term. Both now call this."*

**Its first two conjuncts are `trialEnabled() && selfServeSignupEnabled()` — the
same conjunction the marketing chrome now spells nine times.** And `:146-148`
pre-answers the shape question: it reads its own flags rather than taking them as
arguments, because they are server-authoritative and *"this function is the
policy, not a pure mapping over caller-supplied config."*

**F5's hypothetical tenth surface is not hypothetical — it exists and is wrong
today.** `(public)/demo/[slug]/not-found.tsx:4-6` reads `selfServeSignupEnabled()`
and **computes no conjunction**; `DemoStatusIsland.tsx:52` defaults
`trialEnabled = false` and forwards it at `:56`. Its sibling `page.tsx:49` **does**
compute it. **With the trial on, an expired demo link renders "Create account"
while every other public surface renders "Start free trial" — the same component,
the same route segment, two answers.**

Owner: `publicSignupPosture()`, modelled on `isTrialEligible`, reading its own
flags. **Ten callers, zero render changes, and it fixes `not-found.tsx` on
adoption.**

## X24. The batch tenant-triple lock — **LEAVE**

Five sites. What repeats is **three WHERE lines plus one `FOR UPDATE OF b`**.
Everything around them differs irreducibly — four different projections and
**four different not-found policies** (throw / undefined / false / null / throw),
each stated at its site. Extracting three lines behind a parameter encoding "which
not-found contract am I under" is the `held-draft.ts:17-30` failure mode the prior
pass's W6 register already rejects.

## X25. Migration 091's one-active-send predicate — **REFRAMED; LEAVE**

F1's "five spellings" is wrong. **Only one site spells the bare predicate** —
`release.ts:499-501`, and `:466-470` names it as byte-for-byte the index
deliberately, because P5's whole job is to re-scan the exact set the index keys
on. **The other four are strict supersets serving different questions**, each
adding a different clock or CAS arm. **One predicate plus four supersets is not
five copies.**

F1's leads 4 and 5 — the `<=`/`>` boundary complementarity asserted at `:988-989`
and enforced by nothing — are the real residue, and they are **intra-F1**.

## X26. Stale `docs/directory.md` rows — **LEAVE the audit; fix the rows**

| Row | Claim | Reality |
|---|---|---|
| `:919` | *"`readSendBreaker` gets no try/catch"* | `release.ts:945-956` wraps it — **in the file this row describes** |
| `:931` | *"exactly the two system reasons"* | Three since 111; `approval.ts:119` already says three |
| `:934` | *"no try/catch and no `unknown` verdict"* | Three catching call sites |
| `:1210` | *"27 columns … two are not residue checks"* | `SET` writes **29**; the OR-chain carries **28**; and `tracked_keywords <> '[]'::jsonb` is a **third** restored-default predicate |

**Answering the question directly: yes, `ci:directory-map` is structurally unable
to catch this class.** `directory-map-audit.ts:13-16` declares exactly two checks —
COVERAGE and STALENESS — and **both are path-level. Nothing reads a row's
description cell.** All four rows have correct paths pointing at files that exist,
so they pass by construction and would continue to pass if every word were false.

**Two qualifications.** `:939` (missing `lintInputFromSnapshot`) is **not a defect
by the map's own contract** — one row per *file*, not per export. **Count four
stale rows, not five.** And the three `readSendBreaker` rows are **one edit**:
F3's proposed structural split (`assertSendAllowed` vs `readSendBreakerState`)
would make both rows *unwritable* wrongly, which beats editing prose that will go
stale again.

---

## Additions to the DO-NOT-UNIFY register

Written to survive re-discovery by the next pass.

| Pair | Why it stays separate | Evidence |
|---|---|---|
| **`isTerminalAttempt` (catch form) vs the event form** | Two BullMQ contexts: `'failed'` listeners see `attemptsMade` already incremented, processor catch blocks do not. Merging makes the sink fire one attempt early. **Untouched by X15, which unifies the four event-form copies and leaves the catch form alone.** | `shared/outbox.ts:211-216` · `job-failure-sink.ts:19-37` |
| **`findActiveSolicitationSendBatchRun` vs the six latest-parent lookups** | *"Is there an ACTIVE parent"* vs *"the LATEST parent"*; different locking posture. **Unify only the id canonicalisation (X18), never the query.** | `run-spine.ts:477-491` vs `outreach.ts:376-388` |
| **The five batch tenant-triple locks** | Four different projections, four different not-found policies. A shared helper needs a parameter meaning "which not-found contract am I under". | X24 |
| **`release.ts:499-501` vs its four supersets** | One predicate, four strict supersets each adding a different clock. `:466-470` states the byte-for-byte index identity is deliberate. **Do not "de-duplicate" a superset onto its subset.** | X25 |
| **`release.ts:465` `=== 'closed'` vs `batchDidClose`** | A **tally** vs a **receipt**. `already_closed` belongs in neither count. **Do not fold the backstop into X13's shared predicate.** | `release.ts:442-445` |
| **`landing/reveal.tsx:48` vs the Daylight reveal** | Different design system, `motion/react` under `LazyMotion strict`, and a stated constraint that it must not put a transform on an ancestor. Shares only the word "Reveal". | `sections/landing/reveal.tsx:14-15` |
| **`(public)/layout.tsx` and the nine chrome renders** | RSC gives a layout no props injection into `children`; three different islands, two with no footer. **Hoist the flag READ only.** | `(public)/layout.tsx:9-16` |
| **`ci:directory-map`'s two path checks** | Coverage + staleness are path-level by design. **Do not propose a "row-content audit"** — make the underlying facts unwritable-wrongly instead. | `directory-map-audit.ts:13-16`, `:35-37` |

---

## Refuted or corrected Phase 1 leads

1. **F6 D4 CSS half — REFUTED.** No FAQ fork in `pricing.css`. One declaration
   site repo-wide. **Both pages correctly use one CSS owner.**
2. **F6 D1 + the brief — `how-it-works/Reveal.tsx:6` REFUTED as a path.** The
   component is `components/ui/Reveal.tsx:6`, already hoisted, already consumed by
   `/pricing`.
3. **F2 lead 12 — "three copies" REFUTED. There are five**, plus three ad-hoc
   spellings and an exported owner nobody imports.
4. **F1 lead 3 — "five spellings" REFUTED/REFRAMED** (X25).
5. **SCOPE.md seed 8 — CONFIRMED REFUTED** (F3's finding, independently
   re-verified): five call sites, three catching, two predating #926.
6. **F5 — the `.rw-dl-rv` descendant selectors: count right (five), line numbers
   wrong.** Actual `how-it-works.css:300`, `features.css:359`, `:426`, `:501`,
   `:602`.
7. **F6 — the compensating rule is at `how-it-works.css:389`, not `:387`.** Claim
   correct, line off by two.
8. **SCOPE.md seed 21 — `pricing.css` is 387 lines, not 332.**
9. **`00-features.md` §5 — `closeBatchIfSettled` "two of the 13" for the dispatch
   lane. Three** (§6's banked finding has it right; the §3/F1 row does not).
10. **F5 lead 11 — CONFIRMED.** `(public)/layout.tsx:14` documents a
    `SiteShell islandAs="main"` prop that does not exist; `rg islandAs` returns one
    hit, the stale comment itself.

---

## X10 verdict — **graduated to a rule**, with a granularity amendment

Three instances were independently re-classified using F8's own discriminator.

- **`ALLOWED_NEXT_PUBLIC` — AGREE, Class B.** Deny-by-default scan; the set is an
  exemption list. `static-policy-audit.ts:36-38` states the intent.
- **`PURGE_VERIFICATION_TABLES` — "B on top of A".** Derived by
  `TABLE_DISPOSITIONS.filter(needsPurgeVerification)` and iterated fail-closed —
  loud, **for anything already in `TABLE_DISPOSITIONS`**, which is F8's own A7 with
  a demonstrated live miss. **A derivation is only as loud as the enumeration it
  derives from.**
- **`ci:outbox-status` — two answers depending on where you point it.** Applied to
  statements it is emphatically B. Applied to its **discriminator** —
  `OUTBOX_DISTINCTIVE_STATUSES = ['dispatching','dispatched']`
  (`job-outbox-status.ts:52`) — it is A: a group naming a future fourth in-flight
  status *alone* is invisible, silently. **And the module reasoned only about the
  opposite risk** — `outbox-status-audit.ts:38-40` argues condition (2) exists so a
  future table borrowing the word `dispatched` cannot enrol itself, a
  false-*positive* concern. **Nobody reasoned about the false negative.** Same
  structure as Class C, **without the second-side derivation that closes it.**

**Verdict: X10 has graduated from pattern to rule, and F8's formulation is correct
as written.** Amendment:

> The classifier must be applied to a guard's **discriminator and its transitive
> inputs**, not only to the list the guard visibly iterates. A guard whose subject
> set is derived is Class B only if **every** enumeration on the path from artefact
> to subject is also Class B.

**That raises F8's floor rather than weakening the rule.** F8 called seven "a
floor"; applying the classifier one level deeper on two randomly-picked guards
produced two more. It also **re-ranks F8's mechanical checks: item 3 (widen
`linkedColumnPattern`, two lines) rises**, because it is the input every
purge-side derivation inherits its blind spot from.

---

## Confidence and gaps

**High confidence** — every claim is a line read at `74aee92a`, and every negative
claim comes from an exhaustive grep whose full output was inspected.

**Medium confidence.** X13's *severity*: `closed` was traced to
`ApprovalPanel.tsx:637` → `:707`, but `RequestsClient.tsx` and the admin panel's
consumption were not read — **if either reads it, the finding upgrades from latent
to live.** X18's *reachability*: the two bindings and the silent consequence are
verified, but the `generate_solicitation_asks` payload was not traced back to its
enqueue site, so **whether a mixed-case `batchId` can currently reach it is
unproven.** X16's blast radius: the two bodies differ, but which error classes set
`name` differently from `constructor.name` was not enumerated.

**Gaps.** **No test file was read and no suite was run in Phase 2** — every "the
tests cannot catch this" claim is inherited from a source docstring or from
reading an audit's check list. `island.css` read in four excerpts plus a census.
`features.css:171-482` and `pricing.css:37-226` unread. **The X10 census is not
this agent's** — three instances sanity-checked; F8's ~20-candidate classification
stands unaudited beyond those.
