# Handoff — feat/542-restraint-policy

**Current step:** 8 (ship, normal lane). Steps 0–7 complete: both plan tasks committed (`ad9b8c07`, `57753095`), gate GREEN twice, dual review triaged (5/5 accepted, fixed in `eda6f1a5` — verdicts in `docs/reviews/feat-542-restraint-policy/triage.md`; surface amended with sign-off to add `docs/directory.md`). Remaining: commit intake/handoff/triage docs, push, PR to main (flag MIN_GAP_DAYS=30 plan-time decision in body), CI green, merge, post-merge sweep.

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-542-restraint-policy` (hooks armed; ARM CHECK passed — guard exit 2, stop-gate exit 2).

**Classification:** RISK normal · SURFACE backend · SIZE normal. Ticket-seeded from wayfinder map #528, ticket #542.

Read in order; do not restate:
1. Intake contract (signed off): `docs/superpowers/plans/feat-542-restraint-policy-intake.json` (+ armed copy `.feature/intake.json`)
2. Plan (complete code inline): `docs/superpowers/plans/2026-07-23-restraint-policy-module.md`
3. Spec of record: `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md` + `docs/adr/0012-sentiment-blind-withhold-enum.md`
4. Glossary: `CONTEXT.md` §"Restraint policy — locked 2026-07-23"
5. Deviations (created only if execution hits surprises): `docs/superpowers/plans/feat-542-restraint-policy-deviations.md`

**Key locked resolutions (already signed off — do not re-litigate):**
- Pure module, NO `sql` param (ticket #542's invariant-#15 note superseded by spec §5.1 purity).
- Exports: `evaluateAsk` (five gates), `evaluateBatch` (adds `velocity_banked`), `resolveVertical`, closed enums, versioned constants. Evidence fields snake_case verbatim from spec §4.
- `MIN_GAP_DAYS = 30` plan-time decision (spec gap) — flag in PR description.
- Spec footnote: `no_consent` (like `suppressed`) cannot fire in v-watch (#535 attestation blocking) — Task 2 Step 3.

**Remaining:** Task 1 → Task 2 (sequential, same files) → step 5 gate (`scripts/verify-gate.sh`) → step 7 dual review (normal risk: skip step 6) → step 8 normal lane (push, PR to main, CI green, merge).
