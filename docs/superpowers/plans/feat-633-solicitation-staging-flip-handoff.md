# Handoff — #633 solicitation send-mode staging flip

Resume with `/feature-resume feat-633-solicitation-staging-flip`.
State lives on disk; this doc points, it does not restate.

- Intake: `docs/superpowers/plans/feat-633-solicitation-staging-flip-intake.json`
- **Evidence + teardown ledger (the resume contract)**:
  `docs/runbooks/evidence/2026-08-24-solicitation-send-mode-staging-flip.md`
- Runbook executed: `docs/runbooks/solicitation-sending-domain.md` (patched twice
  this campaign: §2 DKIM shape, §4 provider)
- Worktree: `../RepWorth-worktrees/feat-633-solicitation-staging-flip` (docs-only)
- Fix worktree: `../RepWorth-worktrees/fix-963-ask-lint-google` → PR **#964**

## Phase

Campaign is **mid-flight**, not blocked. §1–§4 and §7 complete; §6 partly
complete; the Copilot arm is proven end-to-end.

## Live staging state (leave it alone unless resuming)

- Sending identity live: `feedback.staging.repworth.net`, Resend-verified,
  tracking off, DMARC `p=reject`, Postmark staging digests.
- Railway staging: both lane flags ON, `JUDGE_ENABLED=true`, cap **10**
  (seed-gate value — NOT ramp stage 1; raise to 50 only after §6 fully passes).
- Vercel staging: mailto + send flag set **via REST** (D-5: `vercel env add`
  stores empty values on CLI 54.14.5 — always `env pull` to verify).
- Staging branch = PR #964's head (`d007ee80`). **Do not reset staging to main
  while this campaign runs** — the campaign depends on those fixes.
- Business fixture: `01a03992-4210-77cc-8ae2-e1764bf6d29f` "Tanicia Resort".
- Batch A3 `01a039e1-dd42-7133-bd93-fcf0559e80ce`: 4 sent, 3 delivered.
  Two handles now suppressed (global): the Gmail and the Zoho primary.

## Issues opened by this campaign

| # | What | State |
|---|---|---|
| #963 | ask lint withheld every ask (allowlist + Title-Case subjects) | fixed, PR #964, on staging |
| #966 | `List-Unsubscribe` one-click pointed at the human page | fixed, PR #964, on staging |
| #965 | contacts re-upload cascades away ask/outreach history | **open — design decision**, prod-flip input |

## Remaining arms, in the ONE order that works

#965 forces the ordering: any new CSV upload erases A3's outreach rows.

1. **Attribution — DONE except the bounce stamp.** Clean `attributed`
   PROVEN (owner review "Great Atmosphere" → 4 evidence columns +
   `review_attributed` outcome, rule `full_name`). Unsubscribed-stays-
   eligible OBSERVED (candidate_count 4 incl. both suppressed handles).
   `no_candidates` closed as a DOCUMENTED GAP (owner call). Still pending:
   the SES hard bounce onto A3's bounce-arm row (`delivery_delayed`;
   watcher polls `bounced_at`) — it MUST be observed and recorded BEFORE
   batch B's upload (#965 erases the row).
2. **Batch B — everything else at once** (accepts erasing A3); runs only
   after the bounce stamp is recorded:
   - Owner prep: second Google account (display name also
     "Norbert Esekiel", never reviewed this location) signed in and
     ready. NO second alias — owner decision: test design must not mint
     infrastructure per specimen; candidacy is `sent`-based, so the
     second ambiguous row does not need a real mailbox.
   - Flip `SOLICITATION_AUTO_APPROVAL_ENABLED=true` via the `flag-flip`
     skill FIRST (judge already on).
   - CSV B row ORDER is the choreography (drip = 2/tick): rows 1–2 the
     TWO "Norbert Esekiel" contacts — `reviews@` alias (delivers) +
     `norbert-b@no-mx.staging.repworth.net` (fresh no-MX local part;
     reaches `sent`, bounces hours later). **Race control: the ambiguous
     review must be posted PROMPTLY after tick 1, and verify row 2's
     `bounced_at` is still NULL immediately before posting — if the
     bounce lands first, the matcher would wrongly ATTRIBUTE to row 1
     and burn the specimen.** Row 3 the globally suppressed Gmail handle
     (dispatch-gate withhold → the **B3.4** cap-slot observation);
     row 4 deliverable filler (`reviews@` is taken — row 4 may reuse a
     no-MX local part; it exists only to fill tick 2); rows 5–6 halt
     fodder (cancelled, never dispatched).
   - Prove the **auto lane**: `auto_policy` approval + veto notice +
     60-min veto window + release drip with judge available.
   - **Mid-flight halt**: owner clicks "Stop this batch" after tick 2 —
     rows 5–6 cancel, sent rows stay sent.
   - **#966 one-click proof**: POST the `List-Unsubscribe` header URL of
     a NEW batch-B mail (now the worker ingress URL); expect a fresh
     Suppression ledger row.
   - **Ambiguous arm**: after the drip, the second account posts a review
     (name "Norbert Esekiel") → matches both batch-B Norbert rows →
     `ambiguous` logged, nothing attributed.
   - Bounced-EXCLUSION disposition (recommended; owner may veto before
     batch B): stamp proven live on A3, the candidate-query exclusion
     closes as test-covered (`src/lib/solicitation/attribution.ts:231`,
     `attribution.integration.test.ts:609`) rather than coupling batch B
     to a second multi-hour SES bounce.
3. Then: cap → 50 (ramp stage 1) only if §6 is fully green; write the final
   verdict block; execute the teardown ledger rows marked `[ ]`
   (both credential files; the user revokes the Cloudflare token).
4. Ship per step 8 RISK-high: PR #964 merges to `main` with owner approval;
   this docs branch opens its own PR.

## Traps this campaign already paid for

- `vercel env add` stdin stores EMPTY values — verify with `env pull` (D-5).
- Zoho, not Cloudflare Email Routing, owns `repworth.net` mail (D-4).
- Resend now returns ONE DKIM TXT record, not three CNAMEs (D-3).
- Provider placement coverage is Gmail + Zoho only; no Outlook/Yahoo (D-7).
- Gmail placed the ask in **Promotions** — recorded, not a failure.
- A Resend bounce auto-suppresses the address; delete the suppression before
  re-probing that handle.
