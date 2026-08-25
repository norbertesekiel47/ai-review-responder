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

1. **Attribution (must be first — needs A3's surviving `sent` rows).**
   Owner leaves a real Google review on the Tanicia Resort location under a
   name matching a seeded contact. Then verify: 4 evidence columns on the
   outreach row + one `review_attributed` outcome on the Lazy child. Also
   exercise `ambiguous` (needs seeding — `MIN_GAP_DAYS` blocks the natural
   path), `no_candidates` (out-of-window), and the bounced/complained
   exclusion. Note the locked rule: **unsubscribed stays eligible** — the two
   suppressed handles above are the specimen.
2. **Batch B — everything else at once** (accepts erasing A3):
   the **auto-approval lane** (flip `SOLICITATION_AUTO_APPROVAL_ENABLED=true`
   via the `flag-flip` skill FIRST — judge is already on, which is why the
   Judge flip preceded it), the **mid-flight halt** arm, and the **#966
   one-click proof** (POST the new mail's header URL; expect a ledger row).
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
