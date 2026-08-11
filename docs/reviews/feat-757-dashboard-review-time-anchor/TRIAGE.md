# #757 — step 7 review triage (round 1)

Three axes, dispatched in parallel against `git diff f5151902..HEAD`. Full reports beside this file:
`spec-correctness-round1.md`, `standards-maintainability-round1.md`, `adversarial-approach-round1.log`.

**11 findings. 7 fixed, 2 rejected/corrected, 2 routed to follow-up tickets.** No finding required
re-planning; no finding invalidated a locked intake decision.

## Spec & correctness

| # | Sev | Finding | Verdict |
|---|---|---|---|
| S1 | MED | `CONTEXT.md:34` claims in present tense that time-to-respond "carries the companion validity filter" — that filter left the codebase with Stack A | **ACCEPT — fixed.** Entry now states Decision 3 is decided but not currently implemented, and that the rule returns with the metric. |
| S2 | LOW | Same entry names "review volume MoM" (deleted) as an anchored KPI and omits velocity + rating breakdown (the two actually anchored) — self-contradictory against its own closing clause | **ACCEPT — fixed** in the same edit. |
| S3 | LOW | `docs/currents.md:32,45` still names `kpi/service.ts` as the anchor owner and calls the dashboard "still `detected_at`, #757 GA-blocking" | **ACCEPT — routed to step 8.** `currents.md` is owned by the post-merge `document-feature` sweep; editing it here would need a third surface amendment for no gain. |

## Standards & maintainability

| # | Sev | Finding | Verdict |
|---|---|---|---|
| ST1 | MED | `route.test.ts:967,989` — the two file-wide #403 negative controls can't see nested fragments, so three re-anchored predicates silently left the guard that D10 only fixed at one site | **ACCEPT — fixed.** Both sweeps now include fragment texts, so the guard covers the composed predicates again. The most valuable finding of the round: the same blind spot, two sites deeper. |
| ST2 | MED | `service.ts:523,526` — `star_current`/`star_n_current` hand-spell exactly what `reviewTimeWindowFilter` returns while `:540` uses the helper | **ACCEPT — fixed.** Both now compose the helper; expansion is byte-identical so no test churn. Comment added explaining the prior-window pairs are two-sided and cannot. |
| ST3 | MED | `docs/analytics/posthog-dashboards.md:10-11` still routes readers to the deleted `src/lib/kpi/*` and `GET /api/dashboard/kpis` | **ACCEPT — routed to step 8.** Out of surface; a third amendment would trip the abort criteria. Explicitly listed in the step-8 checklist below so it cannot be lost — the reviewer correctly noted it is NOT in the default sweep set. |
| ST4 | LOW | `fragments.test.ts:21` — the single-owner regex matched only `review_date`-first, so `LEAST(detected_at, review_date)` evaded it while `fragments.ts:7` claimed broader coverage | **ACCEPT — fixed.** Regex now matches either argument order. |
| ST5 | LOW | `findOnly` duplicated across two suites; "dead `const find = findOnly` alias" | **PARTIALLY REJECTED.** The alias was **not** dead — `find(...)` had 7 call sites; the finding mis-read a naming indirection as dead code. Collapsed the declaration to `find` and dropped the indirection. **Duplication rejected:** two 7-line copies in adjacent suites; de-duplicating means a new shared test-helper file against this repo's "default is no new file", and the shared harness it would belong in is out of surface. |
| ST6 | LOW | `tenant-scope-allowlist.ts:80` — new trailing comment restated the changelog block four lines above | **ACCEPT — fixed.** Trailing comment removed; the changelog block remains the single owner. |

## Adversarial approach

| # | Sev | Finding | Verdict |
|---|---|---|---|
| A1 | MAJOR | Deleting Stack A rolls back an **active launch-KPI contract** (Spec 11, `docs/superpowers/specs/2026-05-26-wave-3-visibility-ai-safety-design.md:845`), not merely dead code. ADR 0019 + CONTEXT.md preserve the anchor and the validity rule but **not** the deleted metrics' sampling, windowing, status, multiplicity, rounding and empty-state contract. | **ACCEPT as real — no code change on this branch. Follow-up ticket.** Genuinely new information: neither Pathfinder P1 (which adjudicated DELETE three ways) nor the intake grilling checked Spec 11. But rebuilding calendar-month volume MoM + TTR into the rendered payload is new product surface with no consumer — exactly what P1 rejected — and is far outside this intake. The honest resolution is to formally supersede Spec 11's KPI clause and record the deferred contract in full, which is a documentation change of its own. |
| A2 | MAJOR | **Mixed clocks make the selected period internally misleading.** A 100-review import can drive the displayed "last 30 days" response rate toward 0% while contributing few or zero reviews to the adjacent anchored velocity series — inviting a false inference about current responsiveness. | **ACCEPT as real — no code change on this branch. Follow-up ticket.** This challenges ADR 0019 **Decision 2**, owner-adjudicated at #688, and re-anchoring response rate is an explicit `non_goals` entry of this intake. It is also sharper than #688 could have seen: #688 anchored a stack nobody rendered, so this branch is the first time the mixed clock becomes visible to an owner. That makes it a legitimate reopening of D2 — as its own decision, not a silent change here. |

**Why neither adversarial finding blocks the merge:** both concern work this branch deliberately did
not do, and both are strictly better off after it than before. Before: the anchor existed only in an
unrendered stack, so Spec 11's metrics were equally absent from the UI *and* the semantics were
invisible. After: the rendered surfaces are correct, and the two gaps are named, recorded and
ticketed rather than latent.

## Step 8 checklist (carried from this triage)

- [ ] `docs/currents.md` — anchor owner + the stale "#757 GA-blocking" line (S3; `document-feature` sweep covers it)
- [ ] `docs/analytics/posthog-dashboards.md:10-11` — deleted `kpi/*` and route references (ST3; **NOT** in the default sweep set — do it explicitly)
- [ ] File follow-up: Spec 11 KPI clause supersession + the deferred metric contract (A1)
- [ ] File follow-up: reopen ADR 0019 Decision 2 — mixed-clock legibility on one dashboard period (A2)
