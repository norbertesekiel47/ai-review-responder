# F1 Owner-Unreachable Escalation — Standards & Maintainability Review

Reviewer: Standards & Maintainability. Review-only, no code edits.
Diff: `git diff main...HEAD` (merge-base `880435ba`).
Tool: `thermo-nuclear-code-quality-review` skill.

## Scope reviewed

Production code (docs treated as process artifacts):
- `worker/background/pollers/NotificationFailoverPoller.ts` (largest change — the `processOwnerUnreachable` arm)
- `worker/background/pollers/health-alert/checks.ts` (`checkOwnerUnreachable`)
- `src/lib/shared/outbox.ts` (`markOutboxOwnerUnreachable`) + `src/lib/shared/outbox-completion-reason.ts`
- `worker/jobs/notification/NotificationWorker.ts`
- `src/lib/config/worker.ts`, `src/lib/shared/worker-types.ts`
- `scripts/ci/tenant-scope-allowlist.ts`
- `supabase/migrations/083_outbox_owner_unreachable.sql`
- `CONTEXT.md` glossary entry

## Overall verdict

Solid, precedent-respecting work. The new failover arm faithfully follows the
existing `tryClaimAlert` / `sendInternalEmail` / `recoverFailoverCorrelationId` /
advisory-lock / in-flight-exclusion patterns. The `markOutboxOwnerUnreachable`
helper cleanly deepens `outbox.ts` (reuses the shared `dispatchedRow` CAS
predicate and `warnOutboxNoop` no-op logging). The glossary term
"Owner-unreachable outcome" is properly coined in `CONTEXT.md` and used verbatim
across every symbol (`owner_unreachable`, `checkOwnerUnreachable`,
`processOwnerUnreachable`, `markOutboxOwnerUnreachable`, key `owner_unreachable`,
failover reason `owner_unreachable_retry`) — **no invented synonyms**. The
migration is well-bounded (`lock_timeout='3s'`, additive nullable column, reuses
migration-082 indexes). No `any`, no silent catches, early returns, descriptive
names, `createWorkerLogger` used, no raw review/response text logged.

The one genuine maintainability hazard is the triplicated owner-unreachable SQL
predicate (below).

---

## Findings

### 1. [MEDIUM] Owner-unreachable outcome predicate is triplicated across production SQL sites

The domain concept CONTEXT.md names as a single thing — the **Owner-unreachable
outcome** ("`pending_approval`, aged past the floor, latest *completed*
`send_notification` `completion_reason='owner_unreachable'`, and no
`approval_request` delivery ever landed") — is expressed as a ~15-line correlated
subquery predicate in **three** production sites:

- `worker/background/pollers/NotificationFailoverPoller.ts:184-202` — candidate scan
- `worker/background/pollers/NotificationFailoverPoller.ts:220-233` — advisory-locked re-check (verbatim re-expression of the same predicate, inside the same function)
- `worker/background/pollers/health-alert/checks.ts:483-500` — `checkOwnerUnreachable`

The most egregious copy is B vs C: the candidate `WHERE` and the locked-re-check
`EXISTS(...)` restate the identical correlated `ORDER BY jo.created_at DESC LIMIT 1`
completion-reason subquery + the `approval_request` anti-join **within one
function body**. (The re-check must genuinely re-run under the lock — the
candidate row is stale — but it can reuse a shared *predicate fragment*; only the
execution must repeat, not the SQL text.)

This is a direct hit on `engineering.md`: "Keep one authoritative representation
for each piece of system knowledge … business rules … should derive from or
trace to one owner." Here the concept has one authoritative *prose* owner
(CONTEXT.md) but three authoritative *implementations*. A future change to the
definition (e.g. a fourth exclusion, or a change to which deliveries clear it)
must be applied identically in three raw-SQL spots or the health signal and the
actor silently diverge.

Remedy: extract a Postgres.js fragment builder (e.g.
`ownerUnreachablePredicate(exec, ageFragment)`) returning a composable `exec`-built
`WHERE` fragment, and share it across all three sites. The tenant-scope-allowlist
snippets would update alongside — that is the audit doing its job, not an
obstacle.

Counter-argument (why MEDIUM, not HIGH): the all-failed and stale arms in this
same file already inline-duplicate their own predicates (the `4h` floor + JOINs +
in-flight `NOT EXISTS`), so the new arm follows *local precedent* rather than
introducing a novel anti-pattern. It is still worth fixing because this predicate
is subtler (a correlated latest-row subquery whose NULL-safety and ordering are
load-bearing) and now lives in two subsystems, not one.

---

## Low-confidence appendix (speculative "might be nicer" — NOT returned)

- **`4h` floor is a magic literal, unlinked to the health config.** The poller
  hardcodes `INTERVAL '4 hours'` (candidate + re-check), while
  `checkOwnerUnreachable` uses `ownerUnreachableAgeS` (default `14400`s = 4h,
  env-overridable). Same semantic threshold, two unlinked representations: raising
  `HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S` to reduce alert noise leaves the poller
  still acting + emailing admin at 4h. `4 hours` also appears 6× in this file with
  no named constant. Follows existing all-failed/stale precedent, so arguably
  by-design (health = alert threshold, poller = action threshold), but a named
  `OWNER_UNREACHABLE_FLOOR` shared by both would remove the drift risk.

- **Arm asymmetry in `runFailoverPollerOnce`.** Arm 3 was extracted into
  `processOwnerUnreachable` (good — better than precedent), but arms 1 & 2
  (all-failed, stale) remain ~100-line inline blocks. The file is now 528 lines
  (was 361) — still well under the 1k threshold, but extracting arms 1 & 2 to
  match arm 3 would make `runFailoverPollerOnce` a clean 3-line orchestrator and
  let each arm own its own SELECT + loop.

- **`processOwnerUnreachable` is ~130 lines** mixing candidate scan + locked
  re-check + admin-email construction. Cohesive, but the admin-email block
  (lines 270-294) could be a named helper to shorten the function.

- **`markOutboxOwnerUnreachable` returns `void`** while its siblings
  `markOutboxCompletedIfOwned` / `markOutboxFailed` return `boolean`. The caller
  (`NotificationWorker`) doesn't couple domain state to the CAS result, so `void`
  is defensible, but the asymmetry is a minor surprise.

- **New arm correctly types `reviewer_name: string | null` and coalesces (R3-D);
  the pre-existing all-failed/stale arms type it as non-null `string`** and call
  `escapeHtml(row.reviewer_name)` directly — a latent null-throw the new arm
  avoids. Pre-existing, out of this diff's scope, but the inconsistency is now
  visible in one file and worth a follow-up.

- **`tx.json(payload as never)`** (line 252) — the `as never` cast looked like a
  smell but is an **established codebase idiom** (~20 sites: publisher, offboarding,
  zernio, response-generation). Not a finding; noted so it isn't re-raised.

- **`checkOwnerUnreachable` is `collect()`ed normally**, not isolated like the
  backlog check. Correct — only the backlog check needs isolation (it reads under
  load); the owner-unreachable probe is a bounded index scan.
