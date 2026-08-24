# Health baseline — 2026-08-24

Measured at `main` @ `0278366c` before any subagent work. Every line below is a
command that was actually run, not an inference.

## Static gates — 20 / 20 PASS

`ci:tenant-scope`, `ci:rls-audit`, `ci:analytics-events`, `ci:static-policy`,
`ci:response-status`, `ci:admin-aal2`, `ci:config-coverage`, `ci:process-env`,
`ci:reviews-status`, `ci:outbox-topics`, `ci:outbox-status`, `ci:db-imports`,
`ci:feature-surface`, `ci:agent-config`, `ci:live-db-suites`, `ci:outbox-seam`,
`ci:dropped-columns`, `ci:directory-map`, `ci:merge-ledger`, `ci:pool-fanout`.

`pnpm typecheck` — PASS.
`pnpm lint` — PASS.

Not run in this baseline: `pnpm test`, `ci:fallow:coverage`. The fallow gate is
fed by the `test` job's coverage artifact and a bare `fallow audit` does not
predict it in either direction, so a cheap local run would be misleading. The
#950 PR run is the authoritative signal for both and it was green at merge.

**Reading this correctly:** a fully green static baseline is what makes the
findings in this pass interesting rather than alarming. Nothing below is a
broken gate. Everything below is a structural question that no gate asks.

## Migration lockstep — seed 6 CONFIRMED CLEAN

Two migrations landed in this window. Both are index-only. Verified by
introspecting `pg_indexes` directly in both projects rather than trusting a
migrations table — the method the lab-notes "Migration lockstep audit" entry
prescribes.

Production `udeyaqnvpojbwgoaxwdg` · Staging `kubdiqdhqbhwmqfditeg`.

| Index | Migration | Prod | Staging |
|---|---|---|---|
| `idx_solicitation_outreach_bounced_at` | 112 | present | present |
| `idx_solicitation_outreach_complained_at` | 112 | present | present |
| `idx_jo_solicitation_veto_notice_inflight` | 113 | present | present |
| `notification_deliveries_solicitation_veto_notice_claim` | 113 | present | present |

No drift. Lockstep holds for this window.

## The standing 078 exception — RE-VERIFIED, NOT STALE

CLAUDE.md carries a standing exception: migration 078, and only 078, is absent
in production pending the WS8 cutover. That file also warns that a stale copy of
this very sentence is what made past sessions contradict each other, and asks
for re-introspection rather than trust.

Re-introspected in production at this pass:

- `businesses.subscription_tier` — `is_nullable = YES`
- `accounts_subscription_tier_check` — does not exist
- `businesses_subscription_tier_check` — does not exist

That is exactly the documented signature of "078 absent". **The exception as
written in CLAUDE.md is accurate.** No correction needed this pass.

## Entropy counter

Stands at **11** against a threshold of 5. This pass resets it to 0 and adds a
row to `.claude/reference/arch-review-log.md`.

`ci:merge-ledger` (landed `2f386c52`, PR #935, in this window) now fails a
merging PR that rewrites the production or governance surface and leaves no line
in the log. This is the first pass to run with that audit live — which means it
is the first pass whose counter should be trustworthy by construction rather
than by hand-correction. The four previous passes each found the counter wrong
by its own rule.
