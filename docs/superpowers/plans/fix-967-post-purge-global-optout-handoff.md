# Handoff — `fix-967-post-purge-global-optout`

Phase: **reviewed**. Gate: **GREEN** (28/28, `--review` mode, at `e0c4bc3b`).
Next: step 8, RISK=high ship lane.

## What this branch is

One of four triage findings. The other three needed no code:

| Finding | Disposition | Where it landed |
|---|---|---|
| #967 post-purge bounce loses the global opt-out | **fixed here** | this branch |
| #965 wrong diagnosis | re-triaged to an investigation ticket | GitHub #965 (retitled + rewritten + comment) |
| Veto window spec mismatch | one amendment | `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` §D9, on this branch |
| #949 Judge health gap | verified, already tracked, no change | GitHub #949 (comment) |

## Read these, do not restate them

- Intake contract (the spec): `.feature/intake.json`, audit copy at
  `docs/superpowers/plans/fix-967-post-purge-global-optout-intake.json`
- Review findings + low-confidence appendix:
  `docs/reviews/fix-967-post-purge-global-optout/spec-correctness-review.md`
- Triage verdicts (round 1 of max 3, no round 2 needed):
  `docs/reviews/fix-967-post-purge-global-optout/triage-round-1.md`
- Blast radius: `docs/reviews/fix-967-post-purge-global-optout/blast-radius.md`
- Glossary term this change re-anchored: `CONTEXT.md` → **Solicitation lane**

## Commits

- `b09764f8` intake contract (harness)
- `abca7cfd` the fix
- `3f91b239` typecheck narrowing + corrected estimate + intake amendment #1
- `e0c4bc3b` review round 1 fixes

## Decisions locked by the owner, do not re-litigate

1. **Fallback acks, it does not retry.** A retry closes only one of three
   unmatched causes; two are permanent. Cost accepted: the seconds-wide #630
   race loses the outreach `bounced_at` stamp and the Send breaker undercounts
   one bounce.
2. **Exactly one recipient entry in `to`, or throw.** Zero, two-plus, non-string
   and unparseable all throw. A global row blocks that person for every tenant.
3. **`.claude/reference/arch-review-log.md`** added to the edit surface
   (amendment #1, owner-approved) so `ci:merge-ledger` passes.
4. **The `reclassify` overrun was recorded, not acted on** (211 vs 90 production
   lines). Measurement showed no sprawl: 6 of 6 declared files, one seam, ~64
   executable lines added, 55% of the lane's additions being comment in a file
   already 55% comment. Estimates corrected in both intake copies.

## Step 8 remaining

1. **Ride staging.** Land on `staging`, which auto-deploys both the Railway
   staging worker and the Vercel staging Custom Env. **Needs owner
   confirmation — it is a deploy.**
2. **Smoke it.** There is no natural way to produce a post-purge Resend event on
   demand. The realistic probe is a manually signed `email.complained` to the
   staging worker's Resend ingress carrying a `lane: solicitation` tag, an
   `email_id` matching no outreach row, and a `to` address: expect **200**,
   one `solicitation_suppressions` row with `scope='global'` and
   `account_id IS NULL`, `inbound_events.status='processed'`, and a Sentry
   `solicitation_suppression_without_attribution` warning. The 503 path is
   covered by the same request with `to` omitted.
3. **PR to `main`**, all checks green, then **pause for explicit merge
   approval**.
4. No migration. Nothing to apply to either Supabase project at promotion.

## After merge

- `git pull --ff-only` on local `main`; realign `staging` per
  `deployment-guide.md` §"Re-sync staging" (this branch rides staging and the
  PR will squash-merge, so the branches diverge — `git reset --hard origin/main`
  + `--force-with-lease`, **not** a sync merge).
- `bash scripts/feature-cleanup.sh` (dry run first).
- The arch-review-log row is **already written** by this branch. Do not add a
  second one; the counter increment is the pass's business, not this merge's.
- Lesson worth promoting to lab-notes: an ack that removes events from
  `inbound_events.status='failed'` silently retires `checkFailedInboundEvents`
  as a pager. Any future change that turns a failing ingress path into an
  acking one owes a replacement alert at the source.
