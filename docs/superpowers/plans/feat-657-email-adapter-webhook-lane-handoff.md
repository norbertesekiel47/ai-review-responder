# feat-657 — handoff

**Ticket:** #657 — Email adapter (MessagingAdapter seam) + dedicated sending domain + Resend webhook lane
**Branch:** `feat-657-email-adapter-webhook-lane`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-657-email-adapter-webhook-lane`
**Lane:** RISK=high · SURFACE=backend · SIZE=normal · db_touching=true (writes, **no migration**)
**Phase:** `plan_approved` — next step is 4 (EXECUTE)

## Read these, in this order. Do not restate them here.

1. `.feature/intake.json` — the locked contract and the drift detector
2. `docs/superpowers/plans/2026-08-16-657-email-adapter-webhook-lane.md` — the plan, 7 tasks
3. `docs/superpowers/plans/feat-657-email-adapter-webhook-lane-deviations.md` — D1–D4, three review rounds
4. `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` §1, §2, §5, §7.1, §7.3, §9
5. `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` — A/B
6. `CONTEXT.md` → "Solicitation (send-mode)" and "Solicitation suppression & unsubscribe"

## State

- Enforcement **ARMED** (`scripts/arm-check.sh`). No surface overlap with other worktrees.
- `allowed_edit_surface` **never amended**. Amendment count **0** of the 2 budget.
- Plan review: **3 rounds, cap reached.** Codex session `01a00d4d-6fa7-72e3-b275-583f8a89dc99`.
  Final verdict was `REVISE`; all 13 findings across the three rounds were verified
  against the repo and **accepted outright** — none was a disagreement. Fixes are
  applied and committed. **No round 4 runs.** The owner's go-ahead substitutes for
  `APPROVED` (workflow step 3, rule 4).
- Three commits on the branch, all docs. **No production code written yet.**

## Two spec deviations, both owner-approved 2026-08-16

1. §5.3's `email.delivered → delivered_at` is **dropped** — no such column on
   `solicitation_outreach`, and this ticket carries no migration.
2. **No index** on `provider_message_id` — follow-up, owned by #630, which is the
   ticket that produces rows.

## The three things most likely to be got wrong

1. **`solicitation_contacts.email` IS the Normalized handle.** There is no
   `normalized_handle` column on that table (migration 086). A query naming one
   throws at runtime on every solicitation webhook event. This is what plan review
   round 1 caught.
2. **The lane's write surface is deliberately narrow.** Only `bounced_at`,
   `complained_at`, `provider_error` and the Suppression ledger. Never
   `delivery_status`, `sent_at` or `unsubscribed_at`.
3. **`SOLICITATION_SEND_ENABLED` gates sending, never the ingress** (glossary rule
   DR1). Do not add a flag gate to the webhook lane.

## Dispatch order for step 4

Task 1 alone first — its completion is the enforcement spot check (diff
`git status --porcelain` against `allowed_edit_surface`; an out-of-surface file means
STOP). Then Tasks 2, 3 and 6 in parallel — no blocking edges, disjoint file sets.
Then Task 4, then Task 5, then Task 7.

## Gate

`scripts/verify-gate.sh`, then `--review` for the last run before step 7. Export
**both** `TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL` first — live-DB suites
self-skip silently without them, and a skip is not a pass.
