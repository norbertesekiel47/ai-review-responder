# Pathfinder 2026-08-18 — process findings

Read-only axis. Adjudicates the workflow layer the 2026-08-10 and 2026-08-15
passes both named as the real site of entropy.

## Verdict

**Still true, and the gap widened.** Every carry-forward item that could be
tested resolved the same way: the *product* apparatus now catches defects before
merge and converts them into filed issues, while the *apparatus itself* ships
uncounted, unreviewed and partly unguarded.

`scripts/verify-gate.sh` is untouched since `fe4dfc12` (2026-08-08).
`scripts/feature-state.sh` is untouched since `d159dabd` (2026-08-03). Carry-forward
items 1 and 3 are not "still open by argument" — they are **byte-identical**.

The window merged **32 first-parent commits**, of which **11 carry production
lines**. The counter reads **8**. Three product merges (#857, #866, #875) got no
sweep and no log entry. Nine further merges rewrote the enforcement surface with
**zero** mentions across 628 lines of arch-review-log.

The 2026-08-15 pass framed PR #803 as an anomaly. It is the norm.

**The one genuine improvement, stated plainly: 7b held.** Seven issues (#877–#880,
#886–#888) were filed this window for out-of-surface findings, including the exact
`ApprovalPanel.tsx` extraction the log called "the first follow-up to file". Notes
are no longer the sink for that class.

## Carry-forward adjudication

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Phase rewind (7 occurrences) | **OPEN — unchanged code** | `verify-gate.sh:413-414` still shells `feature-state.sh set-phase gate_green`, bypassing `transition-state.mjs`; `transition-state.mjs:39` still permits `reviewed → executing`. `git log 03db8633..HEAD` on all three files → **empty**. |
| 1b | "Record `lastGreenGateSha`, stop writing `phase`" | **BLOCKED by design** | `feature-state.sh:49-50` computes `lastGreenGateSha` *only* as a side effect of `PHASE = gate_green`. There is no `set-green` subcommand (`:32-87`). The fix needs a new subcommand — which is why "one line" framing failed twice. |
| 2 | Counter blind to merge classes | **OPEN — worse than reported** | Uncounted with zero log mentions: #843–#846 (design; `globals.css` −2,526 lines, new `(public)/_styles/`, 3 new guards), #847 (new `ci:directory-map`, wired into ci.yml **and** lefthook), #849 (**deletes** `.github/workflows/fallow.yml`, rewrites 196 ci.yml lines and `ci-audit-wiring.test.ts`), #850, #854, #875. Plus uncounted *product* merges #857, #866, #875. |
| 3 | `reclassify` counts specs; WARN not FAIL | **OPEN — unchanged code** | `verify-gate.sh:322-324` excludes exactly `docs/superpowers/plans/*` and `docs/reviews/*`. `docs/superpowers/specs/**` is on neither list. WARN at `:344`/`:351`; `PASSED` flips only on `FAIL` at `:378`. |
| 4 | `shipping-boundaries.md:15` names the staging runbook | **OPEN — not shipped** | Still reads `- push or reset the staging branch`, no method, no pointer. The prior pass's one-line fix was not applied. |
| 7a | Spec locations validated against import bans | **OPEN — nothing shipped** | No such check in `scripts/ci/*` or in `validate-intake.mjs` (18 intake keys, no location/import cross-check). |
| 7b | Out-of-surface fixes ship as ISSUES | **CLOSED in practice, UNMECHANIZED** | 7 issues filed 2026-08-18. But `grep -i issue .claude/skills/document-feature/SKILL.md` → **0 hits**. It held on operator discipline, not mechanism. |
| 5 | #877 — verify-gate races db-provision | **REFUTED as diagnosed; CONFIRMED as a defect** | The gate provisions **serially**: `verify-gate.sh:120-130` runs `pnpm test:db:setup` synchronously and aborts on failure, *before* the first `launch` at `:167`. Real mechanism: `:115-118` exports `TEST_DATABASE_POOL_URL` for **every** row, making `rls-audit.ts:122` a live check on every run, while `:123` provisions only when `db_touching`; and `test-db-setup.sh:45` takes **no lock**. The repo already records the correct cause at `lab-notes.md:19` (#872: *the local test DB is ONE container shared by every sibling worktree*) — sitting unreconciled beside the wrong one. |
| 6 | #878 — staging deploy target drift | **OPEN, correctly filed** | Four staging pushes all returning `target: null`. Not re-verified against Vercel (read-only pass). |
| 7 | Audit census / self-tests | **PARTIAL — 11 AST / 7 text; one audit has no test at all** | `ci:admin-aal2` converted text→AST (H3/#837); `ci:directory-map` arrived as new text (#847). **`ci:agent-config` has no self-test anywhere in the repo.** |
| 8 | `ci:tenant-scope` silent outside `TENANT_TABLES` | **CONFIRMED — a CODE defect, elevated. See P4.** | |

## New findings

### P1. The sweep-miss class reopened upstream — the sweep did not run
The 2026-08-15 mechanization works: all seven sweep commits this window touch
`arch-review-log.md`. But #857, #866 and #875 have **no sweep commit at all**.
The failure moved from "the sweep forgot the file" to "no sweep ran", and the old
fix cannot reach it.

**Cheapest fix**: a required check on the merging PR, not the post-merge sweep —
`ci:merge-ledger`, failing any PR whose diff has non-test lines and adds no line
to `arch-review-log.md`. It cannot be skipped by a sweep that never happens.

### P2. The counter's rule should be "governance surface", not "product lines"
`grep -riE "workflow.surface|non-increment"` across both `document-feature/SKILL.md`
copies and `feature/SKILL.md` → **0 hits**. The prior pass's Option 2 was never
adopted. #849 alone deleted a whole workflow file and rewrote the very test that
exists to stop that drift.

**Cheapest fix**: define a governance path set — `.agents/skills/**`,
`.claude/skills/**`, `.claude/hooks/**`, `.codex/hooks/**`, `scripts/verify-gate.sh`,
`scripts/feature-*.sh`, `scripts/arm-check.sh`, `lefthook.yml`,
`.github/workflows/**`, `scripts/ci/**`, `package.json` — and require a `WORKFLOW:`
line in the arch log in the same PR. Same audit as P1, one path list, two triggers.
This is the cheapest rule that catches PR #803's class: #803 touched only
`.agents/skills/feature/SKILL.md` and the path list catches it with no
line-counting judgement at all.

### P3. `ci:agent-config` — the only audit whose subject is the workflow apparatus — cannot detect a deleted step
`agent-config-audit.ts` (340 lines) asserts hook registration (`:86-120`),
frontmatter keys (`:156`), a skill size **ceiling** (`:144`), relative links
(`:195-207`) and `skills-lock.json` (`:297-307`). **Nothing asserts skill content.**
A ceiling is not a floor — #803's 667→207-line deletion passes. And there is no
`scripts/ci/__tests__/agent-config-audit.test.ts`.

**Cheapest fix**: pin `/feature`'s step list (the `### N.` headings are already
stable at `SKILL.md:55-201`) plus the missing self-test.

### P4. `TENANT_TABLES` has no completeness check — and invariant #4's table is outside it
**Independently verified by the orchestrator.** Four tables carry `account_id`
and/or `business_id` and are absent from `TENANT_TABLES` (43 entries):
`analytics_events`, `flagged_responses`, `impersonation_sessions`, `users`.
`tenant-scope-audit.ts:874-879` `continue`s on any relation not in the list, so
the audit forms **no opinion** on any of them.

`flagged_responses` is **invariant #4's table**. `051_flagged_responses.sql:16-17`
declares `account_id UUID NOT NULL` and `business_id UUID NOT NULL`. **15
production files** query it, four of them owner-facing dashboard routes.

**The orchestrator's addition — this is now a confirmed class, not an incident.**
`src/lib/dashboard/pending-count.ts:29-30` states:

> *"The explicit `JOIN businesses … account_id` scope is what the tenant-scope
> audit requires for an account-wide read."*

**That comment is false.** The audit requires nothing on that table. The scoping
is correct; the stated reason for it is not. This is the identical shape the log
recorded for the `users` join in #882 — *"A reader who trusts a green audit as a
review of a cross-tenant join will be wrong again somewhere else"* — found again,
independently, in a different module, by a different route. Two instances make it
a class.

**Cost to state honestly**: adding these tables is not free.
`src/lib/moderation/held-draft.ts:18-30` documents 16 consumers with four distinct
semantics, two of which are **deliberate cross-tenant reads** (the admin badge
count, and `health-alert/checks.ts`'s threshold COUNT). Listing the table converts
those into allowlist entries that need written reasons. That is the point, not an
objection.

> ### ORCHESTRATOR CORRECTION (added after F8's blast-radius measurement)
>
> **The naive fix is wrong, and P4's framing above understates and misdirects.** F8's agent
> executed the experiment rather than reasoning about it: it copied the audit, extended
> `TENANT_TABLES` with all four tables, patched the analyzer to emit scoped bindings, and
> ran `--no-allowlist`.
>
> **Result: 77 production bindings — 14 provably scoped, 63 would emit a finding, and ZERO
> are live tenant leaks.** Listing the four tables today produces **63 red lines and 0
> security fixes**.
>
> The blind spot is **not the table list**. It is the **bridge vocabulary**:
> `tenant-scope-audit.ts:942` `localScopedBindings` knows exactly three bridges
> (`x.account_id = accounts.id`, `x.business_id = businesses.id`, the
> `account_offboarding_tokens` link). `users` reaches its tenant by a **fourth** shape
> (`accounts.owner_user_id = users.id` — an inbound FK on the *parent*) and a **fifth**
> (`users.account_id = businesses.account_id`). **Adding tables without adding bridges
> converts silence into 40 suppressions.**
>
> Also corrected: `users.business_id` was DROPPED at `034_multi_location_schema.sql:404`, so
> `users` carries `account_id` only.
>
> **What survives P4 intact**, and is the finding worth keeping: the audit is silent on
> those tables, nothing at a call site says so, and `pending-count.ts:29-30` states a
> falsehood about what the audit requires. The *documentation* defect is real and confirmed.
> The *security* implication is not — and this pass would have shipped a handoff that
> generated 63 red lines for nothing if F8 had reasoned instead of measured.
>
> The corrected cheapest fix is two-part and ordered: **(1)** teach `localScopedBindings`
> the fourth and fifth bridge shapes; **(2)** only then invert the completeness query, so
> the tables can be listed without a suppression avalanche.

**Cheapest fix**: invert the existing live-DB query in
`tenant-tables.integration.test.ts:52-58`. It asks "do the listed tables have
these columns"; it must also ask "does any `public` table carry `account_id` or
`business_id` and appear on neither `TENANT_TABLES` nor a named
`REVIEWED_NOT_TENANT_SCOPED` list with a reason string". The inversion also gives
the call-site vocabulary the log asked for.

### P5. #877's filed diagnosis is wrong and the repo carries both diagnoses
Fixing #877 as written changes nothing — the serialization is already there.
Correct cause at `lab-notes.md:19`. `test-db-setup.sh:45` has no `flock` and no
advisory lock; `grep -rn "flock\|pg_advisory" scripts/` returns one unrelated hit.

**Cheapest fix**: `flock` on a fixed lockfile around `test-db-setup.sh`'s DDL,
acquired shared by `rls-audit.ts`'s live arm. Then correct #877's title.

### P6. A lint-on-stop hook cannot distinguish a measurement from a mistake
**Found by this pass, on this pass.** While the guard-integrity axis held
invariant #3's auto-policy conjunct deleted at
`worker/jobs/publisher/auto-policy-publish.ts:489`, the Stop hook
(`typecheck-on-stop.sh`) reported the orphaned `APPROVAL_METHOD` import as an
eslint error and demanded a fix before turn end. The mechanically obvious fix —
delete the unused import — **permanently removes a posting precondition**.

This is not hypothetical: it is the one control in the repo whose remedy, applied
literally, converts a transient measurement into a silent hole in invariant #3.

**Cheapest fix**: have the hook skip when a mutation sentinel file is present, and
have any mutation-running agent create one. Alternatively the hook reports rather
than blocks when the only findings are unused-symbol errors in a file with an
uncommitted single-hunk diff.

## Which review layer catches what

Every row is a defect the log or an issue body records, attributed to the layer
that actually caught it.

| Defect | Caught by | Missed by |
|---|---|---|
| Post-halt refetch re-selects a decoy batch (#865) | **Staging ride** | 3 review agents, 2 live-DB suites |
| Cross-tenant 409-vs-404 oracle (#860) | **Adversarial axis** | **Spec axis — examined and CLEARED** |
| ADR 0020 mispriced its own recourse | **Adversarial axis** + owner | ADR author, plan review |
| Both halt verbs API-reachable on `pending` | Branch review (D9) | The intake's own deferral |
| `closeBatchIfSettled` case-sensitive `subject_id` | Branch review round 1 | tsc, tests, every `ci:*` |
| Requests load-failure copy claims "nothing changed" | **Adversarial axis** round 2 | The shipped tests |
| Pre-escaped `[id]` matches no matcher | **Shipping** | `ci:feature-surface` itself — reported GREEN vacuously |
| verify-gate false RED; staging target drift | **Shipping** | All tooling |
| 15 guards passing for the wrong reason | **Architecture pass** (mutation) | The suite, coverage, CI |
| Imported rows hash differently than live rows | **Architecture pass** (cross-feature charting) | Everything |
| Invariant #9b collapse at `useLocationVoiceForm.ts:196` | **Architecture pass** | tsc, tests, `ci:*` |
| `HealthBadge` duplicated with divergent type safety | **Architecture pass** | fallow's duplication metric (reads 1.1%) |
| `ci:live-db-suites` wired into no gate while docs claimed CI | **Architecture pass** | The PR that added it, its review, CI |
| Absolute-form target defeats the ingress limiter | **Mutation run** + a real-socket test | Every rate-limit test (all `app.inject()`) |
| Migration 100's 4-valued CHECK vs a 3-valued amended ticket | **Post-merge observation** | 3 plan-review + 2 branch-review rounds — all validate the *locked* intake |
| Plan-embedded `run_id` for `agent_run_id` | **Execution** | 3 plan review rounds, lint, tsc, every test |
| Allowlist comment falsely claimed a `users` join was scoped | The **#882 feature's own investigation** | `ci:tenant-scope` (structurally silent), 2 review rounds |
| 17 obsolete parser-limitation allowlist entries | The **audit's own rewrite** | The audit (cannot tell obsolete from live) |

**Reading.** Four layers earn their cost and nothing substitutes for them.

- **The staging ride** is the *only* layer that has ever caught a composition
  defect (write → refetch → render). One datapoint — but no other layer has it.
- **The adversarial axis** is the only layer that has caught an authorization
  oracle the spec axis explicitly cleared, twice. On RISK=high it is the
  highest-yield-per-round control in the log.
- **Mutation checking** is the only thing that has ever caught a vacuous guard —
  17 instances across two passes — and it is automated **nowhere**. It fires only
  when a human or a pass runs it.
- **The architecture pass** is the only layer that catches cross-feature
  duplication, unwired guards and doc-vs-code falsity.

The misses are equally consistent: test suites miss composition and miss
themselves; coverage misses vacuous guards **by construction**; tsc misses every
text-audit blind spot; the spec axis misses authorization oracles; plan review
misses embedded code three rounds running. And **the `ci:*` audits miss anything
outside their hand-maintained inventories** — one shape, appearing as #590, #645,
#859, #662 and P4.

**The sharpest budget conclusion: five of these rows are defects in the tooling,
and shipping caught every one. The apparatus has no layer that reviews the
apparatus.** That is what the architecture pass has been doing by accident, and
it is what P2's counting rule would make deliberate.

**On the follow-up rate — the premise does not survive checking.** #868 did not
repair a #863 miss (issue #858: found in #629's round-1 review, *deliberately* not
fixed there). #875 did not repair #866 (issue #867: *"not a #652 bug — a `/feature`
workflow bug that #652 happened to trip"*, introduced by PR #828). #882 closed
#665/#662, both pre-window. **None of the window's 11 product merges shipped a
defect a later PR had to repair.** Residual risk has moved entirely to composition
(staging-only) and to the apparatus itself (unreviewed).

## Audit census — 11 AST · 7 text · 2 external

Every audit is wired into both ci.yml's `lint` job and `lefthook.yml`, except the
two `fallow` entries (`ci:fallow:coverage` is `CI_ONLY_BY_DESIGN`).

**Text audits**: `ci:tenant-scope` (2,115-line hand-rolled SQL+JS lexer; self-tested
58 KB + live-DB conformance), `ci:rls-audit`, `ci:analytics-events` (thin, 5 cases),
`ci:config-coverage` (thin, 4 cases), `ci:feature-surface` (hardened #875),
**`ci:agent-config` (NO TEST)**, `ci:directory-map` (new #847).

**AST audits**: `ci:admin-aal2` (converted H3/#837), `ci:static-policy`,
`ci:db-imports`, `ci:dropped-columns`, `ci:live-db-suites`, `ci:outbox-seam`,
`ci:outbox-status`, `ci:outbox-topics`, `ci:process-env`, `ci:response-status`,
`ci:reviews-status`.

The prescribed self-tests exist for three of the four originally-named text audits.
The gap is `ci:agent-config`; `ci:analytics-events` and `ci:config-coverage` test
the happy path rather than evasion.

## Confidence and gaps

High confidence on items 1, 3, 4, 7a, 7b, the census, P1–P4 and the counter
arithmetic — all direct file reads or `git`/`gh` state. **P4 was independently
re-verified by the orchestrator**, including the false comment at
`pending-count.ts:29-30`, which the axis agent had not seen.

Gaps: (a) #878 not verified against the Vercel API. (b) The `TENANT_TABLES` scan is
a regex over `CREATE TABLE` + `ALTER TABLE … ADD COLUMN`; **4 is a lower bound**.
(c) Older rows in the layer table draw on the log's own claims; six were traced to
issue bodies or `progresstracking.md` directly. (d) The thin self-tests were
measured for existence, not adequacy. (e) Design PRs #843–#846 were classified from
diffstat, not from a token-level CSS read.
