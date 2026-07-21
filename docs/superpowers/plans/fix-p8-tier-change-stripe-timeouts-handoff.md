# Handoff — F2/P8 bound Stripe calls under tier-change locks

Branch: `fix-p8-tier-change-stripe-timeouts` (worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-p8-tier-change-stripe-timeouts`).

## State: step 4 (EXECUTE) — plan signed off, plan adversarially APPROVED (codex).

## Read these (do NOT restate; open on demand)
- Intake contract: `.feature/intake.json`
- Plan: `docs/superpowers/plans/fix-p8-tier-change-stripe-timeouts-plan.md`
- Ticket: `docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md` §F2
- Target: `src/lib/accounts/tier-change.ts` (`stripeOptions` :370, `mutateStripe`
  :374, `subscriptions.retrieve` :612, `applyTierChangeInTx` :644)
- Test precedent: `src/lib/accounts/__tests__/tier-change.test.ts` (getStripe vi.fn mock)
- fast-check style: `src/lib/reviews/__tests__/sentiment.test.ts`

## Locked decisions (owner-signed)
- Per-call RequestOptions override (no 2nd client). Bound `{ timeout: 8_000,
  maxNetworkRetries: 0 }`, one authoritative constant. No new recovery path.

## Remaining steps
- [x] 0 classify (high/backend/normal) · 1 grill (deltas) · 2 setup+ARM · 3 plan+codex-APPROVED
- [ ] 4 execute (T1 TDD subagent)
- [ ] 5 verify gate (`scripts/verify-gate.sh`)
- [ ] 6 adversarial review (RISK=high) — user runs `/codex:adversarial-review`
- [ ] 7 unified two-axis review
- [ ] 8 SHIP: ride `staging` first → PR to `main` → pause for merge approval

## Notes
- `.feature/intake.json` is gitignored; committed with `-f`.
- Shell cwd resets to parent between Bash calls — always `cd` into worktree.
