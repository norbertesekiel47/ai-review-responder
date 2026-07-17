# Deviations / coordination notes — fix/prod-hardening-guards

- [2026-07-16] **Parallel uncommitted workstream in the parent checkout** touches
  `worker/queues.ts` (adds `llmJobOptions` with `attempts: 5` for the
  `generate_response` queue + `OUTBOX_WATCHDOG_STALE_MS` 15min default),
  `.claude/CLAUDE.md` (same cost-guard gotcha bullet Task 3 edits),
  `scripts/ci/tenant-scope-allowlist.ts`, and several dashboard routes.
  Consequences for this branch:
  - **Task 3 wording:** do NOT hardcode "3 attempts" in the new comment or the
    CLAUDE.md gotcha replacement. Phrase the bound as "bounded by the
    `generate_response` queue's BullMQ attempts budget" so it stays true when
    the parallel 5-attempt change lands. (On this branch's base, code truth is
    `attempts: 3` for all queues — worker/queues.ts:38.)
  - **PR time:** expect a one-line merge conflict on the CLAUDE.md cost-guard
    bullet (it is a single long line and the parallel stream edits it too);
    resolve by combining both edits (their retry/watchdog numbers + our
    guardrail-retry parenthetical).
  - **Task 8:** if `ci:tenant-scope` needs an allowlist entry for the
    `inbound_events` health query, base it on the branch's committed
    allowlist, not the parent's uncommitted version.
- [2026-07-16] `.feature/` is not gitignored repo-wide; all commits must use
  explicit `git add <paths>` (plan already does). Follow-up: add `.feature/` to
  `.gitignore` in a separate change (out of this branch's declared surface).
