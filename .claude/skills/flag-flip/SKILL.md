---
name: flag-flip
description: Use when enabling or disabling any RepWorth feature flag in staging or production — especially the autonomy flags (TRIAGE_ENABLED, ESCALATION_ENABLED, JUDGE_ENABLED, GOVERNOR_ENABLED, AUTO_APPROVAL_ENABLED, AUTOPILOT_PURCHASABLE) — before changing any env var value on Railway or Vercel.
---

# Flag Flip Workflow

Feature flags are server-authoritative (invariant #13) and several autonomy
flags have hard couplings — flipping one from memory is how outages happen.
`.claude/reference/env-vars.md` is the single authoritative source for every
flag's semantics, preconditions, and couplings. **Read the flag's entry there
before every flip. No exceptions, including flips you've done before.**

## Workflow

1. **Read the flag's `env-vars.md` entry** — semantics, default, rollout notes, couplings.
2. **Check ordering** (autonomy flags only). The go-live order is fixed (design doc §8.4): `TRIAGE_ENABLED` → `ESCALATION_ENABLED` → `JUDGE_ENABLED`+`GOVERNOR_ENABLED` (together) → `AUTO_APPROVAL_ENABLED` → `AUTOPILOT_PURCHASABLE`. Staging before production at every step. Never enable a later flag while an earlier one is off.
3. **Verify hard couplings** before flipping ON:
   - `AUTO_APPROVAL_ENABLED=true` is inert-to-dangerous without `JUDGE_ENABLED=true` — the publisher treats a disabled/unavailable judge as a posting blocker and downgrades auto-policy rows to owner review.
   - `AUTOPILOT_PURCHASABLE=true` additionally requires the independent-authorization checklist in `docs/runbooks/ws8-tier-cutover.md` (WS4+074 live, WS6+076 live, WS7 eval green, cadence limits documented, intentional `AUTO_APPROVAL_ENABLED=true`).
   - `JUDGE_ENABLED`/`GOVERNOR_ENABLED` staging enablement presumes migration 076 and the suspension drill.
   - Flipping `TRIAGE_ENABLED` **off** weakens the auto-approval triage veto for newly ingested reviews — re-check `AUTO_APPROVAL_ENABLED` posture first.
4. **Exact values only**: worker startup accepts literal `true`/`false` and rejects anything else. No `NEXT_PUBLIC_*` companions, ever (CI-enforced).
5. **Set it everywhere it's read**: Railway worker env AND (if a Next.js server route reads it) the matching Vercel env, in the SAME environment (staging = Railway staging service + Vercel staging custom env). Verify with the Railway/Vercel MCPs after writing, and remember Vercel needs a redeploy to pick up env changes.
6. **Smoke the affected lane** after the flip (staging runbooks under `docs/runbooks/` — e.g. `channels-staging-smoke-test.md`, the agentic E2E runbooks for autonomy flags).
7. **Record the flip**: environment, flag, value, UTC time, and why — in the runbook evidence file for the campaign, or the ops log the user designates.

Kill-switch direction (→`false`) is always permitted and takes effect on the
next job/boot — but steps 1, 5, and 7 still apply (couplings like the
TRIAGE→auto-approval veto interaction bite in the OFF direction too).

## Explicit user overrides

When the user explicitly requests an out-of-order or all-at-once flip, do NOT
silently substitute the staged path — and do NOT silently obey either. Present
a one-line risk summary (which orderings/couplings the request violates), ask
to confirm, then honor their decision. In **production**, confirm per flag even
after a blanket instruction; in staging one confirmation for the batch is fine.

## Common mistakes

- Flipping on Railway but forgetting Vercel (or the reverse) — the two read paths disagree until both are set.
- Enabling `AUTO_APPROVAL_ENABLED` with the judge off and concluding auto-posting is "broken" — it's the designed downgrade path.
- Treating the ordered flip as staging-only — production repeats the same order, one flag at a time, with smokes between.
- Setting `TRUE`/`1`/`yes` — worker boot rejects non-exact values and refuses to start.
