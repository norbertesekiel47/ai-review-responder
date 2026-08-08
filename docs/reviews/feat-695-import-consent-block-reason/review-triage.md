# Step-7 review triage — `feat-695-import-consent-block-reason`

**Round 1 of max 3** (`branchReviewRounds = 1`). Three parallel axes against fork
point `6a1af53d`. Gate was GREEN (`--review`, 25/25) at `84e7262a` before dispatch.

| Axis | Verdict | Report |
|---|---|---|
| Spec & correctness | **PASS** — 3 Low, zero High/Medium | `review-spec-correctness.md` |
| Standards & maintainability | **PASS** — 1 Medium, 1 Low | `review-standards.md` |
| Adversarial approach (Codex) | **needs-attention** — 1 Medium | `review-adversarial.md` |

---

## Accepted and FIXED in round 1

| # | Axis | Finding | Fix |
|---|---|---|---|
| F1 | Standards (Medium) | `job-eligibility.test.ts` — a false comment justified a **dead recorder**: `mockMarkOutboxCompleted` was wired into the module mock but never invoked (this suite exercises only `guardImportConsent`, which uses the reason writer on the block path and completes nothing on the accepted path). Its sole effect was forcing `reason?:` optional — structurally re-arming the D5 shape. | Plain mock demoted to a bare `vi.fn()` stub with a truthful comment; `reason` is now **required** on `completionCalls`. A regression to the plain writer now leaves the array empty and the assertions throw. |
| F2 | Spec (Low) | Guard docblock (`job-eligibility.ts:165`) and five sites in the live-race suite — including the **tripwire's failure message** — still named `markOutboxCompleted` for a call site this branch changed. An engineer greps that string on a CI failure and finds nothing. | All six rewritten to `markOutboxCompletedWithReason`. Comment/message strings only; no executable code touched (verified by `git diff -U0`). |
| F3 | Spec (Low) | `assertSchemaReady` listed only `MIGRATION_100_IMPORT_CONSENT`, but the four new tests read/write `job_outbox.completion_reason` from migration **083**. A behind-head DB would fail opaquely instead of loudly — the exact failure mode the convention exists to prevent. | Added `MIGRATION_083_OUTBOX_OWNER_UNREACHABLE`, matching the sibling suite (`NotificationFailoverPoller.integration.test.ts:176`). |

Verified after fixes: `pnpm typecheck` clean; `job-eligibility.test.ts`,
`job-eligibility.integration.test.ts` (5 passed, **0 skipped**) and
`ZernioBackfillWorker.test.ts` all green.

## Accepted, DEFERRED to the step-8 post-merge sweep (out of surface)

| # | Axis | Finding | Why deferred |
|---|---|---|---|
| F4 | Spec (Low) + Standards (Low) | Five durable docs still name the deleted `markOutboxOwnerUnreachable` or the stale `markOutboxCompleted(tx, …)` claim: `docs/directory.md:964`, `.claude/reference/review-ingestion.md:223` (+`:215`), `.claude/reference/migrations-log.md:1861`, `docs/currents.md:722` & `:226`, `docs/progresstracking.md:892` & `:1830`. | **All five are outside `allowed_edit_surface`.** Adding them would be surface amendment **#2**, which step 5 defines as an abort trigger (post-mortem + tear down the branch). Tearing down a green branch over stale prose is disproportionate; the repo has a precedented post-merge doc sweep for exactly this class. |

**F4 carries a real hand-off risk the spec agent flagged and this file exists to
neutralise:** `docs/currents.md` and `docs/progresstracking.md` are named targets of
the step-8 `document-feature` sweep, but **`docs/directory.md` and
`.claude/reference/review-ingestion.md` are not** — and `review-ingestion.md` is
precisely where `.claude/CLAUDE.md` routes an agent for this subsystem. Without an
explicit hand-off, nothing owns them. The full list above must be pasted into the
step-8 sweep and into the PR description.

## Escalated to the owner — scope decision, not a patch

| # | Axis | Finding |
|---|---|---|
| F5 | Adversarial (Medium) | The `import_consent_blocked` marker lives on a `completed` `job_outbox` row, which `ArchivalPoller.ts:60` deletes 7 days after completion. The ticket's goal says refusals become **"durably queryable"**; they are queryable for 7 days. |

Independently verified. See `review-adversarial.md` for the full analysis, including
the material correction to Codex's framing: `owner_unreachable` (ADR 0010), the
precedent this generalizes, has always had the identical 7-day life, so the entire
`completion_reason` vocabulary is an operational-window signal. The branch did not
build the wrong thing — its **language overclaims what the sink provides**.

Both remedies Codex proposes are scope changes, not fixes: a longer-lived audit sink
contradicts the locked non-goal *"no HealthAlertPoller check, no Sentry capture, no
PostHog event — a refusal is the guard working, not an incident"*, and exempting
reasoned rows from archival couples the shared archival arm to one domain — the very
coupling ADR 0016 rejects for topic-agnostic infrastructure.

**RESOLVED — owner decision, 2026-08-08: correct the language, do not expand scope.**

The word *durable* is removed from the ticket's claim in five places and replaced
with an explicit operational-window statement — ADR 0016 (three sites, including a
new third bullet under "Operator query, and its limits" spelling out that the query
can only ever see the last 7 days), `CONTEXT.md` **Import consent**, spec §5.3, and
**both** intake copies (`goal` + `observability[0]`, verified byte-identical and
valid JSON afterwards). No implementation change: the code was right, the claim was
not. Recorded as deviations **D8**; an intake-field correction, so the surface
amendment budget stays at **1 of 2**.

The ADR now names what actually outlives the window — `businesses.import_decision` /
`import_decision_at` plus the structured log line — so an operator reading it during
an investigation is pointed at a record that still exists.

---

## Findings rejected

None. No axis produced a finding that survived verification and was then rejected;
the three Low findings deferred at F4 are accepted-but-out-of-surface, not rejected.

## Round protocol

Round 1 complete. Rounds 2–3 remain available and are **verification-only** — a
fresh agent per axis that had accepted findings, briefed with that axis's table plus
the fix commits, verifying each fix landed and introduced nothing new. New unrelated
findings go in a report appendix, untriaged.
