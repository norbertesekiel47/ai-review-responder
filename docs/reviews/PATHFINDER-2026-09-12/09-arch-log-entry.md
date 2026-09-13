# Arch-log entry — Pathfinder 2026-09-12

Apply this in the artifacts PR. **Two edits** to
`.claude/reference/arch-review-log.md`.

**No sequencing hazard.** `gh pr list --state open` shows two PRs — #1134 and
#1133, both Dependabot workflow bumps. `gh pr diff <n> --name-only` for each:
neither touches this file. Unlike the 2026-08-26 pass, the reset can be
applied directly.

---

## Edit 1 — the header

Replace the counter paragraph (`:298-300`), the "⚠️ THE THRESHOLD IS CROSSED"
block (`:302-316`) and the prior-passes line with the following. **Keep the
"counting rule is under repair" note** — H7 did not land, this pass measured
that it did not, and every one of its four reasons still holds at HEAD. Update
only its measurement and add the new evidence.

```markdown
**Merges since last architecture pass: 0** — reset by the **2026-09-12 pass**
(entry at the bottom of this file). Full artifacts:
`docs/reviews/PATHFINDER-2026-09-12/`.

> ## The counting rule is STILL under repair — do NOT hand-count this file
>
> The 2026-09-12 pass measured the prior window at **83** against a stated
> **21** — a 177-merge window, the largest yet, and the **seventh consecutive
> wrong counter**. H7 (filed 2026-08-26) did not land; the error grew from 4
> to **62** in seventeen days.
>
> All four reasons the 2026-08-26 pass measured still hold at HEAD:
>
> 1. **Two accepted locations** — the bullet list and the bottom table.
> 2. **No stable key.** Entries appear under PR number, issue number, branch
>    name, or bare prose.
> 3. **The audit's trigger is WIDER than the counting rule.** `ci:merge-ledger`
>    fires on production **OR GOVERNANCE**; the rule counts production
>    **only**. **17 merges in the 2026-09-12 window** were each *required* by
>    CI to add a line and must *not* increment. They sit in the table beside
>    counting merges, unmarked.
> 4. **"Lines added" is not a unit.**
>
> **This file predicted its own failure twice inside that window**, which is
> the strongest evidence yet that the defect is structural rather than one of
> discipline: `:306-316` ("*recovered MECHANICALLY rather than by reading this
> file*") and the 2026-09-03 bullet ("*The count lags reality — #1069, #1071,
> #1073, #1074, #1075, #1097, #1098 and #1099 all merged with production
> changes and no entry… reconciling them is the next architecture pass's
> job*"). The reconciliation was **62, not 8**. The bullet list stopped being
> maintained entirely after 2026-09-04 — the last **39** counted merges
> (#1140 → #1270) have no bullet at all, including the whole Admin split wave
> and Owner Operator Run A.
>
> **One refinement the 2026-09-12 window adds:** only **3 of 83** counting
> merges had a comment-only production diff. **80 of 83 changed executable
> code.** The file rule over-counts by **3.6%** — cheap. Keep the file rule.
>
> **The fix is unchanged (H2, formerly H7):** one owner — the bottom table,
> keyed by **merge SHA**, with a `counts` boolean set by `isProductionFile`
> (`scripts/ci/merge-ledger-audit.ts:96`). `classifyDiff` (`:111-117`) already
> computes it on every run and discards it. Then the counter is a `grep -c`,
> and the governance-only rows classify themselves.
> `docs/reviews/PATHFINDER-2026-09-12/04-handoff-prompts.md` H2.

Prior passes: `PATHFINDER-2026-08-26/`, `-08-24/`, `-08-22/`, `-08-18/`, `-08-15/`, `-08-10/`.

Merges since the 2026-09-12 pass:

_(none yet)_
```

Then open the new list and close the old one. **The old bullets are RETAINED
verbatim** — that is this file's own precedent (the 2026-08-26 pass did
exactly this to the 08-24 list at `:566`), and deleting a record because it
proved unreliable is the wrong direction. Replace the single line
`Merges since the 2026-08-26 pass:` with:

```markdown
Merges since the 2026-09-12 pass:

_(none yet)_

---

Merges since the 2026-08-26 pass — **CLOSED by the 2026-09-12 pass.** Retained
verbatim as record; these are the 21 bullets that stood against a measured
**83**, and they stop at 2026-09-04 — the last 39 counted merges (#1140 →
#1270) left no bullet at all. The full 83-row classified table, plus the 17
governance-only and 77 docs/test-only merges, is in
`docs/reviews/PATHFINDER-2026-09-12/SCOPE.md`.
```

---

## Edit 2 — the bottom table row

Append after the `2026-09-11` row:

```markdown
| 2026-09-12 | **83 counted merges ≥ 5 threshold across a 177-merge window after `40e79e6a8`** — 8.4× the prior window. Themes: the Admin split + ten-page legacy retirement (#1213–#1268, 24 merges); the Refusal ledger (#1008–#1129, 13); the Console/Harbor redesign + the 223-file UX remediation (#987–#1138, 16); the marketing rebalance + the 66-file copy sweep (#1140–#1233, 10); offboarding/billing (#1070–#1151, 5); **Owner Operator v1 Run A (#1270)**; the agent-context split (#1135); outbox/perf/worker-health (#1069–#1175, 8). Migrations **115–120**. The counter itself read **21** | Pathfinder pass, **windowed** (owner's call): **9 features charted, 635 nodes**, every node `file:line`-cited — F1 Owner Operator Run A (119), F2 Admin transport seam (73), F3 legacy retirement + Admin API contract (31), F4 Refusal ledger (67), F5 Console/Harbor (80), F6 marketing rebalance (68), F7 offboarding purge (87), F8 outbox/perf/health (56), F9 Review QR (54). #1135 recorded as no-chart: 30 production files, **4 changed code lines**. Artifacts `docs/reviews/PATHFINDER-2026-09-12/00-09` | **Headline: the counter is wrong for the SEVENTH consecutive pass, by 62 — and this file predicted it twice inside its own window** (`:306-316`, and the 2026-09-03 bullet's *"eight unrecorded merges… reconciling them is the next architecture pass's job"* — the reconciliation was 62). The bullet list stopped being maintained after 2026-09-04; the last **39** counted merges have no bullet. Refinement: only **3 of 83** counting merges were comment-only, so the file rule over-counts by **3.6%** — keep it. **`ci:merge-ledger` did exactly what it is built to do on all 100 triggering merges and no merge was blocked; the number was never in its scope** (`merge-ledger-audit.ts:38-43`). **PRIORITY FINDING for Owner Operator Run B, which starts now:** `/api/operator` is **absent from `isProtectedOwnerApiRoute`** (`src/lib/shared/protected-routes.ts:47-59`), so proxy branch 6's AAL2 gate never runs for an Operator route — **LATENT on two grounds** (flag unset; `getAalGate` short-circuits when `mfaEnforcementEnabled()` is false) and the routes are **not** unguarded (`withSameOrigin` + `requireWritableOwner` give role, `account_id`, writable-subscription and the offboarding gate) — **the missing piece is MFA only, and Run B's two POST routes change the same rows `PATCH /api/settings/voice` changes from behind that bar.** Also for Run B: `patchAutoApprovalSettingsInTransaction` exists in **four spec references and zero code** (`settings.ts:199` is narrowed to `Sql` and opens its own `sql.begin`; the transaction-aware pieces are module-private) — **Run B is blocked**; `hasImpersonationCookie` is duplicated byte-for-byte at `operator/turns/route.ts:97` and `settings/auto-approval/route.ts:116` and Run B would make it four. **The intake's "reuse the dashboard payload" premise is REFUTED field by field** — posted count and location list are **absent**, rating band is **shaped wrong** (all reviews, not pending drafts); Run A already reuses the *granular helpers* and that is correct. **The arch log's own "six domain terminals emit logs only" is misleading as compressed** — all six write the turn row AND complete the outbox row in one tx; the claim holds only for the alerting channel, and the true write-nothing exit is the lease-lost branch (`AgentTurnWorker.ts:367-372`). **Only LIVE behavioural divergence in the pass:** two private copies of `isRetryableStripeError` **shadow the #1126 owner by the same identifier** (`teardown-stripe.ts:121`, `AccountOffboardingReactivationResetPoller.ts:175` vs `stripe-retry-policy.ts:61`), both missing its socket-code branch, both on routinely-reached paths. **`boundedErrorClass` 5→4 CONFIRMED**, and the three private copies are byte-identical to each other and weaker than the export. **`worker/index.ts` 1,006 / `job-outbox-helpers.ts` 1,027 CONFIRMED**; 16 production files exceed 800 lines. **Standing obligations: 0 of 6 landed, 1 partial** — and the mechanism is now a controlled experiment (08-18's issue-numbered H1–H7 = #890–#896, 3 of 3 landed; 08-24's and 08-26's prose handoffs, 0 of 6 across two windows). The sharpest instance: `table-disposition.ts` **was edited on 2026-09-12 by #1270** and `owner_leads` still was not added — nobody erred, the requirement lived only in a review document. **This pass therefore files its own issues.** The notice family stayed at 6 members but the **claim contract grew 2 → 5** (`delivery.ts:84/113/143/194/278`, no shared helper) and both 08-24 bugs persist — `worker/jobs/auto-post-notice/` has **zero** bounce handling while its own email template names the flag. **`businesses ⋈ accounts` grew 33 → 48 sites / 46 files**, nothing extracted. **First pass where a production root SHRANK** — `src/app/` net **−3,750 lines**, 66 files deleted. Four stale prose claims measured, incl. **CLAUDE.md:47's "18 of 32 topics" (actually 37)**. **Two `docs/directory/*.md` pages sit at EXACTLY the 3,000-word cap** with `ci:directory-map` requiring rows — no warning band. **Migrations 115–120 verified in lockstep by introspecting BOTH databases** (26 fingerprint rows, all byte-identical). Gates **22/22 green** (audit count 21→22, `ci:admin-contract` added); `pnpm test` **not run**. fallow: health **77 B**, duplication **1.3%**, maintainability 92.1, 489 large functions, 161 high-complexity (the worst six are in `scripts/`, not production). 17 handoffs H1–H10 with a ready-to-run `gh issue create` block. |
```

---

## Node-count derivation

For the "635 nodes" figure, so the next pass can check it.

| Feature | Nodes |
|---|---:|
| F1 Owner Operator Run A | 119 |
| F2 Admin transport seam | 73 |
| F3 Admin retirement + contract | 31 |
| F4 Refusal ledger | 67 |
| F5 Console / Harbor | 80 |
| F6 Marketing rebalance | 68 |
| F7 Offboarding purge | 87 |
| F8 Outbox / perf / health | 56 |
| F9 Review QR | 54 |
| **Total** | **635** |

Counted the same way the 2026-08-26 pass counted its 664: **flow nodes only**
— numbered decision points, calls and terminals. Mermaid subgraph titles and
edge labels are excluded. A crude bracket-token grep returns a higher number
for the same reason that pass recorded (664 flow nodes vs 760 bracket
tokens). **Quote 635.**

## Counter derivation

Reproducible at any time:

```bash
# import the audit's own classifier; classify every first-parent merge
git rev-list --first-parent 40e79e6a8..6edacd0b0   # 177
# for each: git diff --name-only <parent1>..<sha> | filter isProductionFile
#   -> 83 counted · 17 governance-only · 77 docs/test-only
```

`isProductionFile` is `scripts/ci/merge-ledger-audit.ts:96`; `isTestFile` is
`:88`. The script this pass used is not committed — the point of H2 is that
the number should be a query against the ledger, not a script against git.
