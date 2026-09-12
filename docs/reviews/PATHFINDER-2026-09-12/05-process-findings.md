# Process findings — Pathfinder 2026-09-12

---

## 1. HEADLINE — the counter is wrong for the **seventh** consecutive pass, by 62, and the log predicted it twice inside this window

### The measurement

`.claude/reference/arch-review-log.md:298` reads **21**. The window measures
**83**.

Derived mechanically, not by reading the log: all 177 first-parent merges in
`40e79e6a8..HEAD` were replayed, each first-parent diff listed, and every path
run through **the audit's own classifier** — `isProductionFile` imported from
`scripts/ci/merge-ledger-audit.ts:96`, not re-implemented. Full table in
`SCOPE.md`.

| Pass | Read | Measured | Delta |
|---|---:|---:|---:|
| 08-18 | 8 | 11 | +3 |
| 08-22 | 3 | 7 | +4 |
| 08-24 | 7 | 7 | **0 — the only correct one** |
| 08-26 | 8 | 12 | +4 |
| **09-12** | **21** | **83** | **+62** |

### The log convicts itself, twice, inside this window

This is the part that makes the finding different from the previous six. It
is not a discovery; it is a **confirmation the log itself scheduled.**

- `arch-review-log.md:306-316` — *"The number moved 3 → 9 on 2026-09-01, and
  six of those merges were never recorded here… The six were recovered
  MECHANICALLY rather than by reading this file, because the H7 note is right
  that it cannot be hand-counted."*
- `arch-review-log.md:427-431` — *"**The count lags reality** — #1069, #1071,
  #1073, #1074, #1075, #1097, #1098 and #1099 all merged with production
  changes and no entry in this section… **Eight unrecorded merges, not
  reconciled here: reconciling them is the next architecture pass's job, not
  this change's.**"*

**This is that pass. The reconciliation is 62, not 8.**

And the bullet list stopped being maintained entirely after 2026-09-04: **the
last 39 counted merges (#1140 → #1270, 2026-09-06 onward) have no bullet at
all** — the whole Admin split wave and Owner Operator Run A.

### What `ci:merge-ledger` did and did not catch

**It caught everything it is built to catch, on all 100 triggering merges.**
83 production + 17 governance merges were each required to add a line to the
ledger, and **no merge in the window was blocked for missing one**. By its own
contract the audit is green and honest. Its header says so:
*"It never reads or writes the counter number"* (`merge-ledger-audit.ts:38-43`).

**It did not catch — and structurally cannot catch — the counter drifting by
62.** The number is a separate artefact from the lines, and nothing derives
one from the other. The four reasons the 08-26 pass named
(`arch-review-log.md:318-344`) all hold at HEAD, unrepaired: two accepted
locations; no stable key; the audit's trigger (production **OR** governance)
is wider than the counting rule (production **only**); "lines added" is not a
unit.

**This is exactly the design working as specified, producing a wrong number.
Seven passes, six wrong counts, is the expected output. It is not a discipline
failure and should stop being written up as one.**

### One refinement the window offers on the rule itself

Only **3 of 83** counting merges have a comment- or blank-only production
diff (`9c2f12fbb` #1147, `91094be2d` #1136, `715b88f58` #1070). Three more
changed ≤ 6 code lines. **80 of 83 changed executable production code.** The
counting rule is a *file* rule, not a *behaviour* rule, and this window prices
that choice: **the overcount is 3.6%.** Cheap. Keep the file rule.

(And #1070 — 40 comment lines, 0 code — earned its ledger line honestly: it
moved a load-bearing correctness claim about a cross-replica lock from tribal
knowledge into `worker/index.ts:452-459`. See F7.)

### Recommendation

H2, unchanged from the 08-26 pass's H7: one owner (the bottom table), keyed by
**merge SHA**, with a `counts` boolean from `isProductionFile` — a classifier
`classifyDiff` (`merge-ledger-audit.ts:111-117`) already computes on every run
and discards. Then the counter is a `grep -c`, and the 17 governance-only
merges classify themselves instead of sitting unmarked beside counting ones.

---

## 2. The agent-context split (#1135) — landed, enforced, and already at cap in two places

`85e531512` created **18 `.claude/rules/*.md`**, **18 `docs/context/*.md`**,
**24 `docs/directory/*.md`** and **20 lab-notes pages**.
`src/__tests__/reference-shape.test.ts` (215 lines) enforces every cap row via
`CAP_SETS` (`:83-153`). `npx vitest run src/__tests__/claude-md-shape.test.ts
src/__tests__/reference-shape.test.ts` → **2 files, 264 tests, all PASS.**

`.claude/CLAUDE.md` is **4,575 / 6,000 words (76%)** — comfortable.

**But three files are at or within 0.2% of their cap**, and two of them are
`docs/directory/*.md` pages the `ci:directory-map` audit **requires rows to be
added to**:

```
3000 docs/directory/lib-platform.md          ZERO headroom
3000 docs/directory/lib-reviews-responses.md ZERO headroom
2995 docs/context/refusal-ledger.md          5 words
```

Two more are above 90%: `docs/agents/context-layout.md` 1,078/1,200 and
`docs/progresstracking.md` 10,963/12,000.

**The layer is working. The gap is that it has no warning band** — a `<=`
assertion tells you at 3,001, not at 2,850, and the fix is a page split plus a
Pages-table update, which is not what a feature author expects to do.
→ **H9-B.** Full analysis in `02-duplication-report.md` X8.

---

## 3. The CI audit surface grew by exactly one, and the wiring test still holds it

The 08-26 pass recorded **21** `ci:*` audits in the `lint` job. There are now
**22**. Diffing the two lists: exactly one added —
**`ci:admin-contract`** (`becdb113d`, #1190/#1232).

`package.json` holds **24** `ci:*` entries: the 22 plus `ci:fallow`
(`UNGATED_BY_DESIGN`) and `ci:fallow:coverage` (`CI_ONLY_BY_DESIGN`, run in
ci.yml's `fallow` job). `lefthook.yml:21-80` mirrors all 22.
`src/__tests__/ci-audit-wiring.test.ts` (238 lines) is still the enforcer and
its two exception tables match CLAUDE.md's description exactly.

**And `ci:admin-contract` is worth naming as a design success.** Its
generator shares **one route-walk and one gate-shape recogniser** with
`ci:admin-aal2` (`scripts/ci/admin-contract-audit.ts:6` imports
`describeRouteHandlers`/`collectRouteFiles` from `admin-aal2-audit.ts:561-598`,
`:688-699`). Two audits over the same subject with two walkers is the classic
drift source; this one avoided it on the first try.

`ci:rls-audit` runs twice — in `lint` (self-skips without a DB) and live in the
`test` job (`ci.yml:279`). By design; counted once.

**No new top-level directory in 177 merges.**
`git ls-tree -d --name-only 40e79e6a8` vs `HEAD` is an **empty diff**.
`docs/admin-api/` is under `docs/`, is generated by
`admin-contract:generate` (`package.json:32`), and is **committed, not
gitignored** (`git check-ignore -v docs/admin-api/README.md` exits 1) — which
is what makes the byte-for-byte drift check possible.

---

## 4. The `/feature` workflow's own gates — one real mechanism gap, one correct block, one false-green

Searched `docs/superpowers/plans/*-deviations.md` across the window.

**A real gap, self-caught: the edit-surface guard is not binding on
Bash-routed writes.** `feat-1092-nav-sidebar-children-deviations.md:44-72`
(2026-09-03) — `arm-check.sh` reported ARMED, but
`.claude/hooks/edit-surface-guard.sh` is a `PreToolUse` hook on
`Edit`/`Write`/`MultiEdit` **only**, so that session's Bash-routed writes
bypassed it entirely and three new test files landed outside the declared
surface undetected. **The hook's own header documents this as a known gap**,
and the session caught it at the step-4 spot check and enforced the surface by
hand for the rest of the run. Worth recording plainly: *the guard is a
convention enforced by a hook on three tools, not a property of the
workspace.*

**A correct block, not a misfire.**
`feat-898-solicitation-send-governors-deviations.md:82-92` (2026-09-08) —
`schema-ready.ts` was not in `allowed_edit_surface`, the guard blocked the
edit, and it was resolved by a surface amendment with sign-off. Intake
under-scope, working as designed.

**A false-green worth generalising.**
`feat-1087-import-offer-arrangement-deviations.md:399-404` (2026-09-04) — a
local `fallow audit --gate new-only` reported complexity 0 while the branch
added render branches. The session's own lesson, quoted because it is the
right one: *"A local gate that green-lights a branch is not the CI gate when
it deliberately omits a job… reproduce `fallow` the only way that predicts it
— `pnpm test:coverage && pnpm ci:fallow:coverage` — before pushing."*
**This pass hit the same shape:** `pnpm ci:fallow` on a clean tree reports
*"0 changed files vs origin/main"* and passes vacuously. It is a diff gate,
and none of this pass's fallow numbers came from it
(`00-health-baseline.md` §6).

**The `reclassify` WARN fired at least ten times in-window** —
`admin-invite-funnel-deviations.md:30` ·
`feat-1087-import-offer-arrangement-deviations.md:249` ·
`feat-1178-mint-admin-deviations.md:95` ·
`feat-1182-admin-reset-deviations.md:75` ·
`feat-1183-admin-transport-seam-deviations.md:115` ·
`feat-1184-admin-get-fold-deviations.md:174` ·
`fix-1171-job-outbox-rls-deviations.md:166` ·
`perf-1082-exhaustion-refusal-batch-deviations.md:10` ·
`feat-1092-nav-sidebar-children-deviations.md:170` ·
`feat-898-solicitation-send-governors-deviations.md:689`.
**This is as-designed** — a scope-growth signal, not a false positive — and
this pass explicitly does **not** repeat the 08-26 pass's "two false blocks in
one window" framing. Ten WARNs across a 177-merge window is a signal firing
at roughly the right rate.

**One adjacent tooling bug, fixed in-window.** The bash-write guard's `sed`
rule misread `-i` inside a *search pattern* as the in-place flag (2026-08-30,
#1008), fixed in both the `.claude/` and `.codex/` copies and pinned by
`scripts/ci/__tests__/bash-write-guard.test.ts`
(`.claude/reference/lab-notes/ci-tooling.md:5`).

---

## 5. Migration lockstep — CONFIRMED CLEAN for 115–120, by introspection

Both live Supabase projects were queried read-only via the Supabase MCP on
2026-09-12 — prod `udeyaqnvpojbwgoaxwdg`, staging `kubdiqdhqbhwmqfditeg` —
with `SELECT` only against `pg_class`, `pg_indexes`, `pg_constraint` and
`information_schema.columns`.

Two independent fingerprints, both across all eight tables touched by
migrations 116–120 plus the 115 constraint:

1. **Object presence, RLS state, `md5(indexdef)` × 8,
   `md5(pg_get_constraintdef(oid))` × 1** — 18 rows.
2. **Column fingerprints** — `md5(string_agg(column_name || data_type ||
   is_nullable || coalesce(column_default,'-') ORDER BY column_name))` per
   table — 8 rows.

**All 26 rows are byte-identical across the two projects.** RLS is `on` for
all eight tables on both. **Migrations 115–120 are in full lockstep.**

CLAUDE.md's standing statement about 077/078 was deliberately **not**
re-derived — the file's own rule says never to, and it is right: a stale
version of that sentence is what made earlier sessions contradict each other.

---

## 6. The handoff-landing pattern did not invert this time — it collapsed, and the mechanism is now a controlled experiment

`07-handoff-reverification.md` §F is the finding; this is what it means.

| Pass | Handoff form | Issue-numbered? | Landed |
|---|---|---|---|
| 08-18 | H1–H7 | **Yes — #890–#896, all closed** | **3 of 3 tracked items** |
| 08-24 | H1–H3 prose | No | **0 of 3** |
| 08-26 | H1–H10 prose (top 3 as PR 1/2/3) | No | **0 of 3** (1 partial) |

Two windows, one of them **177 merges long**, and **zero prose handoffs
landed**. The one variable that differs is whether the item existed in the
issue tracker.

**The 08-26 pass saw this and recommended the fix — and the recommendation was
itself a prose handoff, so it did not land either.**
`grep -rn -i "gets an issue\|named in a spec\|handoff gets"` over
`.claude/CLAUDE.md`, `.claude/rules/`, `.claude/commands/feature.md`,
`.claude/skills/`, `docs/agents/`, `AGENTS.md`, `lefthook.yml`,
`scripts/ci/` hits **only** the review artifacts and
`arch-review-log.md:861-862`, where it sits as a *"Process note / Suggested
rule."* Never promoted into governance.

**The sharpest single instance is H9-C.** The 08-26 pass asked for one row in
`TABLE_DISPOSITIONS` for `owner_leads`. On **2026-09-12**, PR #1270 edited
`src/lib/account-offboarding/table-disposition.ts` — to add the four Owner
Operator tables — and `owner_leads` was not added. **Nobody erred.** The Owner
Operator author had no reason to know, because the requirement lived in a
review document and nothing in the file, the test, or CI could mention it.

**What this pass does differently:** `04-handoff-prompts.md` ends with a
ready-to-run `gh issue create` block for all 17 handoffs, and the arch-log
entry records that **filing them is part of shipping the pass**. A
recommendation that must itself be remembered is the failure class it
describes.

---

## 7. Sequencing — no hazard, checked before the reset

```
$ gh pr list --state open --json number,title,isDraft,headRefName
#1134  chore(deps): bump anthropics/claude-code-action 1.0.208 → 1.0.219
#1133  chore(deps): bump millionco/react-doctor 2.2.8 → 2.2.9
```

Two open PRs, both Dependabot, neither draft. `gh pr diff <n> --name-only` for
each: #1134 touches only `.github/workflows/{claude-code-review,claude}.yml`;
#1133 touches only `.github/workflows/react-doctor.yml`. **Neither touches
`.claude/reference/arch-review-log.md`.**

**No sequencing hazard.** Unlike the 2026-08-26 pass, whose artifacts PR
collided with a concurrently-staged arch-log edit in the same working tree,
this pass's counter reset can be applied directly.

---

## 8. Method notes — two places the rules earned their keep

**"A citation is not a verification" caught nothing wrong this time, and that
is itself the result.** Nine load-bearing subagent claims were re-run
independently by the orchestrator: the 48-site `businesses ⋈ accounts` count ·
the five `claim*Delivery` functions · the four `boundedErrorClass` bodies ·
the three `isRetryableStripeError` implementations · the absent bounce
handling in `worker/jobs/auto-post-notice/` · `errorResponse`'s 75 uses and
zero admin uses · the two at-cap directory pages · `docs/directory.md:39` and
`:115` · `FeatReceipt`'s three consumers. **All nine re-resolved.** The rule
still cost almost nothing to apply and would have caught it if one had not.

**"Is it wrong?" and "is it reachable?" as separate questions changed two
verdicts.** U1-A would read as a security hole if the two questions were
merged — `/api/operator` really is outside the owner-API MFA allowlist. Asked
separately, it is **LATENT on two independent grounds** (the flag is off, and
`getAalGate` short-circuits when `mfaEnforcementEnabled()` is false), and the
routes are not unguarded — they carry same-origin, role, `account_id`,
writable-subscription and the offboarding gate. **The finding survives at full
strength as a sequencing requirement for Run B, and is not an incident.** The
same split downgraded the auto-post bounce gap from LIVE to
*LIVE-in-code, LATENT-in-effect*.

**And one correction the pass made to itself.** The first reading of the arch
log's *"six domain terminals emit logs only"* accepted it. Reading the six
sites showed all of them write the turn row **and** complete the outbox row in
one transaction; the claim is true only about the **alerting channel**, and
the genuinely write-nothing exit is the lease-lost branch at
`AgentTurnWorker.ts:367-372`, which the spec correctly excludes from the six.
**The compressed sentence in the arch log understates what those paths
persist**, and a Run B author reasoning about what a failed turn leaves behind
would be misled by it. Corrected in F1.

---

## 9. What this pass did NOT measure

1. **`pnpm test` was not executed.** The live-DB lane needs
   `TEST_DATABASE_POOL_URL` and a container at migrations head 120, and a
   silently-skipping live-DB suite produces a false pass. **Test health at
   HEAD is unmeasured** — the same gap the 08-26 pass declared.
2. **`ci:fallow:coverage` was not run** — it consumes the `test` job's
   coverage artifact.
3. **Live flag values on Railway and Vercel were not read.** Every
   reachability verdict depending on a deployed value says so and cites the
   **code default** instead (`src/lib/config/flags.ts:21-23`, `:28`).
4. **Only migrations 115–120 were introspected.**
5. **No mutation testing.** Every "no guard catches this" claim rests on
   reading the guard's own scope literal, not on an experiment.
6. **`src/app/**` directory-doc rows were spot-checked, not audited.**
   `ci:directory-map`'s `SCAN_DIRS` is `['worker','src/lib']`, so after 66
   production-file deletions a stale `docs/directory/app-*.md` row fails no
   audit. This pass found two stale rows in the **index**
   (`docs/directory.md:39`, `:115`) and verified the **per-page** docs were
   cleaned correctly for all 18 deleted `src/components/admin/**` files — but
   did not walk every `src/app/` row.
7. **Whether any of the six standing obligations was deliberately declined by
   the owner.** Nothing in the tree records such a decision, but its absence
   is not proof one was not made.
