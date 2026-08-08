# Adversarial approach review — `feat-695-import-consent-block-reason`

**Axis:** approach / design challenge (RISK = high third axis)
**Runner:** `/codex:adversarial-review --background --base 6a1af53d`
**Codex thread:** `019fe32f-ab5c-7621-91a0-ea4af676531a`
**Round:** 1
**Verdict returned:** `needs-attention`

---

## Findings table

| Severity | file:line | Finding |
|---|---|---|
| medium | `worker/jobs/zernio/job-eligibility.ts:215-217` | The consent-refusal marker is written onto a `completed` `job_outbox` row, which `ArchivalPoller` deletes 7 days after completion — so the "durable" refusal record is purged, and ADR 0016's operator query silently undercounts refusals older than a week. |

Codex summary, verbatim:

> Do not ship: the advertised durable refusal record is automatically deleted after
> seven days, silently defeating the change's observability goal.

> This writes the only durable refusal marker onto a completed job_outbox row.
> ArchivalPoller deletes every completed job_outbox row seven days after completion
> (worker/background/pollers/ArchivalPoller.ts:51-65), and this change deliberately
> adds no other audit, analytics, or alert sink. Consequently, refusals become
> indistinguishable from missing history after seven days, while ADR 0016's
> deployment-window query silently undercounts them.

Recommended next steps, verbatim:

> - Choose and implement an explicit retention policy for import-consent refusal evidence.
> - Update ADR 0016's operator query and limits to reflect the actual retention behavior.

---

## Orchestrator verification — CONFIRMED, with one material correction

The retention claim is **true and independently verified**:

```
worker/background/pollers/ArchivalPoller.ts:58-61
  WHERE (status = 'completed' AND completed_at < NOW() - INTERVAL '7 days')
     OR (status = 'failed'    AND COALESCE(completed_at, created_at) < NOW() - INTERVAL '90 days')
```

A refused `zernio_initial_backfill` row is completed (skip-as-success, never failed),
so it takes the **7-day** arm, not the 90-day one. The marker is a 7-day operational
signal, not an audit record.

**The correction Codex's framing misses:** this is not a defect this branch
introduced. `owner_unreachable` — the precedent this change generalizes, locked in
ADR 0010 — is written to the same column on the same table and has always had the
same 7-day life. The entire `completion_reason` vocabulary is, and has always been,
an operational-window signal. So the finding is not "this change built the wrong
thing"; it is **"this change's language overclaims what the chosen sink provides."**

That distinction decides the fix. What is actually wrong is the word **durable** in
three places — the intake `goal`, the intake `observability` entry, and ADR 0016 —
each of which implies a permanence `job_outbox` does not offer for any reason value.

**Why "add a longer-lived sink" is not the obvious remedy:** the intake locks
`No HealthAlertPoller check, no Sentry capture, no PostHog event — a refusal is the
guard working, not an incident` as an explicit non-goal, and exempting reasoned rows
from archival would couple the shared archival arm to one domain — the precise
coupling ADR 0016 argues against when rejecting a topic-specific trigger on
topic-agnostic infrastructure. Either remedy is a scope decision, not a patch.

**What genuinely survives past 7 days**, and should be named in the ADR instead of
the overclaim:
- `businesses.import_decision` / `import_decision_at` — the consent decision itself,
  which is the record that answers "did we import without consent?"
- The structured worker log line `import consent blocked — skipping backfill`
  carrying `{ reason, business_id }`, under the log sink's own retention — already
  documented as the only per-state record.

## Triage verdict

**ACCEPT (documentation), scope question ESCALATED to owner.** See
`review-triage.md` for the recorded decision.

## Note on the run

Codex's own `vitest` invocation exited 1 during the review; it ran without
`TEST_DATABASE_POOL_URL` exported, so live-DB suites behaved differently than under
the gate. The gate is the authority here: `full` and `--review` runs are both GREEN
at `84e7262a`, with both integration suites executed (9/9 and 5/5, 0 skipped). No
finding was raised off that failed run.
