# Step 6 — Codex adversarial review (2026-07-30)

Target: branch diff against `origin/main` (fork point `2c8b021a`, 37 commits, ~7074 lines).
Runtime: `codex-cli 0.145.0` via the plugin companion, `--base origin/main`, adversarial framing
pointed at the five approach-level decisions the orchestrator judged most challengeable.

**Codex verdict: `needs-attention` — "No-ship."** 4 High, 1 Medium.

> "The design embeds a deadlocking temporal contract, under-constrains both lifecycle models,
> and leaves purge/redaction safety dependent on future caller discipline."

## Orchestrator triage: 4 ACCEPT, 1 REJECT

Every citation was verified against the tree before triage — this ticket's own round-1 lesson is
that a review's citations are hints, not facts. All four accepted findings verified TRUE. One
finding re-litigates an owner-locked deferral.

---

### F1 — ACCEPT (High). Failure-first closure is an ABBA deadlock, and an aborted failure tx records failure as success.
`src/lib/solicitation/outreach.ts:219-230`

**Verified by tracing the two lock orders:**

- The contract T5 shipped (deviations entry 11) requires the caller to record the failure on the
  send parent **before** calling `closeBatchIfSettled`. `failSolicitationBatchRun` →
  `transitionRunToTerminal` → `UPDATE agent_runs` — so that transaction takes the **run** row
  lock first, then `closeBatchIfSettled` takes `solicitation_batches FOR UPDATE`. Order:
  **run → batch**.
- A concurrent last-child close or the releaser backstop calls `closeBatchIfSettled` alone:
  `solicitation_batches FOR UPDATE` first (`outreach.ts:279`), then `agent_runs` via
  `recordStep`/`completeRun` (`:330`, `:343`). Order: **batch → run**.

Two live paths, opposite orders, same two rows — textbook ABBA. This is the same defect class T8
was created to eliminate for the advisory/row pair, reintroduced one layer up.

**The second half is worse than the deadlock.** If Postgres aborts the failure transaction as the
deadlock victim, the surviving closer observes no `error->>'code'`, derives `exhausted`, CASes
`send_closed_at`, and terminalizes the parent `completed`. A retry cannot repair it: the CAS and
`transitionRunToTerminal` both no-op on the second pass. A failed batch is permanently recorded as
a successful one.

**This also disproves a justification I wrote.** Deviations entry 15 (the anchor-pairing carve-out)
asserts "no holder of such a lock ever waits on `solicitation_batches`". F1 is a counterexample:
the failure-first caller holds the `agent_runs` row lock and then waits on exactly that. The
carve-out's *conclusion* may still hold — the reviews lane is a different pair — but its stated
reasoning is wrong and must be rewritten, not merely re-asserted.

**Fix (Codex's, accepted):** make **batch → run** the sole order and collapse the temporal contract
into one operation that takes the disposition explicitly — lock the batch, record the parent error,
close, terminalize, atomically. This retires an unenforceable ordering contract in favour of a
signature that cannot be called wrongly, which is what round-3 finding 4 was reaching for and did
not finish.

### F2 — REJECT for #624 (High as written). Advisory lock does not protect an in-flight provider send from purge.
`worker/jobs/account-offboarding/purge-stages.ts:270-309`

**Technically correct and already the locked position of record.** `pg_advisory_xact_lock` is
transaction-scoped; #630's dispatch commits `sending` and releases before the provider call, so
purge can delete a committed `sending` row mid-flight. #624 builds no send worker and cannot
demonstrate, test, or close this.

This was resolved with the map owner across two plan-gate rounds: **#624 defines the contract,
#630 is bound to it** — the trap is named at `acquireSolicitationBatchLock`, ADR 0014 records the
committed-state requirement, and amendment **B11** makes it #630's obligation. The plan states it
as out of scope "by construction … so a subagent does not try to build it." Rejecting it here is
not a disagreement on the engineering; it is honouring a decision already taken.

**But Codex's framing is a genuine improvement on B11 and should be folded in.** B11 currently
binds #630 to the lock order plus committed-`sending` visibility. Codex sharpens the requirement:
purge must, after acquiring its advisory locks, **detect committed `sending` claims and durably
defer or fail** — visibility alone still leaves purge free to proceed. It also specifies the test:
claim commit → paused provider call → purge refusal → terminal completion. **Recommend amending
B11 with that stronger obligation and test spec** (docs-only, `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md`
is on-surface).

### F3 — ACCEPT (High). Timestamp-only batch state accepts impossible lifecycle histories.
`supabase/migrations/091_send_mode_spine_lifecycle.sql:142-159`

**Verified — the `solicitation_batches_send_ordering` CHECK enforces only three things:**

```
sending_started_at IS NULL OR approved_at IS NOT NULL      -- sending implies approval
sending_started_at IS NULL OR sending_started_at >= approved_at
send_closed_at     IS NULL OR built_at     IS NOT NULL     -- closure implies built
```

Nothing ties `approved_at` to `built_at`. So **an approved-but-unbuilt batch is legal** — and it
enters the `solicitation_batches_one_active_send_per_business` partial unique index, whose
predicate is `approved_at IS NOT NULL AND send_closed_at IS NULL AND halted_at IS NULL`.
`deriveBatchState` then reports it `approved`, because precedence places `approved` above `built`.
Also legal: approval earlier than build, an orphan `veto_deadline_at`, and closure timestamps
preceding the events they close.

The "no `status` column" decision (D2) is defensible *only* if the database owns the full
transition graph. Right now derivation **masks** contradictions rather than preventing them, and a
future approval bug could approve content that does not exist yet.

Codex did not dispute the deliberate omission of "closed implies approved" — that carve-out is
correctly reasoned in the migration's own comment (`generation_failed` and B7 expiry both close
never-approved batches). The gap is the *other* implications.

**Fix:** add the missing implication and chronology CHECKs, with NULL-safe `IS TRUE` wrapping per
this migration's established idiom, and integration tests asserting each impossible history is
rejected.

### F4 — ACCEPT (High). Outreach status and lifecycle timestamps can contradict.
`supabase/migrations/091_send_mode_spine_lifecycle.sql:260-315`

**Verified, with one correction to Codex's characterization.** Codex says `delivery_status` is
"constrained only against `disposition_reason`". Not quite —
`solicitation_outreach_body_presence` *does* couple redaction to `sent_at` ("redaction means gone
AND sent"). But both concrete holes are real:

1. **`delivery_status='sent'` with `sent_at IS NULL` is legal.** Nothing requires the timestamp.
   The redaction sweep selects on `sent_at < NOW() - 90 days`, so such a row is never a candidate
   and **keeps its body forever** — the retention guarantee silently does not apply to it.
2. **A live `rendered` row with a stale `sent_at` is legal, and the sweep will redact it.** T6's
   predicate filters on `sent_at` and `body_redacted_at` only, never `delivery_status`. Redacting
   it satisfies `body_presence` (redacted ⇒ `sent_at` present ✓) and produces a **bodyless live
   attempt** that can never send and never settle — wedging its batch.

**Fix:** a total status↔timestamp consistency-and-ordering CHECK, plus tests proving `sent`
requires `sent_at` and a non-sent live row can carry neither `sent_at` nor `body_redacted_at`.
Constraining the data is the better fix than filtering in the sweep, because the sweep is not the
only future reader.

### F5 — ACCEPT (Medium, and arguably the most user-facing). Redaction leaves the source PII readable forever.
`worker/background/pollers/ArchivalPoller.ts:251-265`

**Verified end to end:**

- `interpolation_inputs JSONB NOT NULL` (`091:185`) is on the retained row.
- Its specified shape carries `contact_first_name` and `visit_note`
  (`docs/superpowers/specs/2026-07-28-ask-generation-design.md:499-504`).
- The sweep nulls **only** `rendered_subject` and `rendered_body` (`ArchivalPoller.ts:262`).

So after 90 days we delete the rendered sentence and keep the first name and the visit note it was
rendered from. `CONTEXT.md`'s **Body redaction** entry states the objective as "data minimization
on third-party PII held on the contact's behalf" — that objective is not met. The rendered prose is
the *derivative*; `interpolation_inputs` is the *source*.

**Fix:** redact `interpolation_inputs` in the same UPDATE, or split reproducibility data so only
hashes/versions/non-PII classifications survive the window. Note the column is `NOT NULL`, so
redaction must write `'{}'::jsonb` or the column must become nullable — a schema decision, so this
lands with F3/F4 rather than as a poller-only change.

---

## Consequences for the workflow

**This does not meet the abort criteria.** No locked *intake* decision is invalidated: F1 corrects
the mechanism of `closeBatchIfSettled` (which round-3 finding 4 had already left unfinished), and
F3/F4/F5 add constraints and a redaction target. The feature's goals, surface, and tracer-bullet
decomposition all stand. This is fix-forward, not tear-down.

**Migration 091 can be amended in place — it has never been applied outside the local test DB.**
Staging and prod are both at 090, so F3/F4/F5's schema work belongs *in* 091, not in a corrective
092. Operational constraint: `migration-immutability-guard.sh` treats 091 as applied (because
`migrations-log.md` records head 091), so **the session that lands these edits must be launched
with `MIGRATION_GUARD_DISABLE=1`** — the escape hatch the map owner already approved for exactly
this case and which the handoff documents.

**Ordering for the fix round:** F1 first (it is a design change and F3/F4 tests will be written
against the corrected interface), then F3/F4 together as one 091 amendment with F5's
`interpolation_inputs` decision folded in, then re-run step 5, then step 7.

**Step 7 is deliberately NOT yet run.** An approach-level finding of F1's severity is exactly the
case step 6 exists to catch before the two review agents spend their budget on an interface that
is about to change.
