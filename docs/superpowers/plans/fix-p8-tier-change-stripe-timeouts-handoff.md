# Handoff — F2/P8 bound Stripe calls under tier-change locks

Branch: `fix-p8-tier-change-stripe-timeouts` (worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-p8-tier-change-stripe-timeouts`).

## State: step 8 (SHIP) — ready to ride staging, then PR to main.

### Review verdicts (steps 6–7, all triaged)
- Step 6 codex adversarial: 1 finding (maxNetworkRetries:0 still retries once on
  ECONNRESET/EPIPE). VERIFIED real; owner chose "ship + correct invariant". Fixed
  wording in code comment / intake / plan (worst case ~26s, not ~24s). No behavior
  change. Full triage: docs/reviews/.../adversarial-review.md.
- Step 7 spec & correctness: 0 findings ≥80%. Contract faithfully implemented.
- Step 7 standards & maintainability: 0 findings ≥80% (APPROVE). 4 low-confidence
  appendix notes, no action (minimal-fix). Report: docs/reviews/.../standards.md.
- Gate re-run GREEN after every fix round (.feature/gate-status.json).

### Commits on branch
- ead63b01 intake · 04915df7 implementation · 28882445 wording correction · (+review docs)

### Step 8 lane (RISK=high, db_touching=FALSE → no migration lockstep)
1. Ride staging: push branch onto `staging` (full-stack auto-deploy).
2. Smoke tier-change path on staging (BillingPanel tier change, Stripe test mode).
3. PR to main → confirm CI green → PAUSE for owner merge approval.
4. After merge: pull --ff-only main; ff staging onto main; remove worktree;
   document-feature sweep; domain sweep; increment arch-review merge counter.

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
