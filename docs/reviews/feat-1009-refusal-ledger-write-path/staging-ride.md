# Staging ride — #1009, the Refusal ledger's write path

**Branch** `feat/1009-refusal-ledger-write-path` at `68bf2e0b` ·
**Railway** project `repworth`, environment `staging` ·
**Supabase** `RepWorth-staging` (`kubdiqdhqbhwmqfditeg`) ·
2026-08-31 UTC.

**No migration applied.** 116 is already in staging and production.

---

## 1. Deploy — the eleventh `ArchivalPoller` arm, proven by a clean cycle

Deployment `9a063904` SUCCESS, worker booted at `00:18:01Z`.

```
[INFO] Starting  logger="ArchivalPoller" data={"interval_ms":86400000}
[INFO] Nothing to archive  logger="ArchivalPoller"
```

**Why that second line is the evidence and not a formality.** The eleven arms
share ONE `try/catch`, so a broken eleventh arm aborts the whole cycle and
silently stops sweeping `job_outbox`, `api_costs`, `agent_runs` and five others.
That is the exact hazard #1004 named when it ruled this arm could not ride slice
1 and gated #1009 on 116's PROMOTION rather than its merge. A complete cycle
against a real `refusal_events` table is the proof the arm is sound.

`AutonomyGovernorScheduler` also started clean.

## 2. What the smoke first FOUND — the lane cannot fire on staging as configured

`GOVERNOR_ENABLED=false`. The scheduler starts and never evaluates, so the write
site could not fire by that path. Recorded because it is a fact about staging's
posture, not about this branch.

Also confirmed: **`REFUSAL_LEDGER_ENABLED` is absent** from staging's variables —
correct for a default-ON flag, matching `LLM_CIRCUIT_BREAKER_ENABLED`'s
treatment, and evidence that T6's registry decision was right.

## 3. Flag flips — owner-confirmed, `flag-flip` skill followed

The skill's ordering check was run and the deviation surfaced before any write:
the documented go-live order is `TRIAGE` → `ESCALATION` → `JUDGE`+`GOVERNOR` →
`AUTO_APPROVAL`, and staging already had `JUDGE_ENABLED=true` with `TRIAGE` and
`ESCALATION` both off. Enabling `GOVERNOR` extended that existing deviation. Its
own pairing rule — *enable together with `JUDGE_ENABLED`* — was already
satisfied. Owner confirmed the batch, including the disclosed side effect that a
suspension enqueues an owner notice and an admin alert.

| UTC | Flag | Value | Why |
|---|---|---|---|
| `00:56:07Z` | `GOVERNOR_ENABLED` | `true` | let the deployed worker reach the write site |
| `00:58:33Z` | `REFUSAL_LEDGER_ENABLED` | `false` | prove the kill switch |
| `01:01:54Z` | `GOVERNOR_ENABLED` | `false` | **restored** |
| `01:01:54Z` | `REFUSAL_LEDGER_ENABLED` | *deleted* | **restored** — absent is the correct posture for a default-ON flag |

Railway staging service only. Vercel was not touched: no Next.js route reads
either flag.

## 4. Seed — a real Governor breach

`agent_outcomes`: five `reply_edited_by_owner` rows, no `reply_approved_no_edit`
→ edit rate **5/5 = 1.0**, clearing `GOVERNOR_MIN_SAMPLE` (5) and
`GOVERNOR_EDIT_RATE_THRESHOLD` (0.5). Plus one armed `reply`/`posting` policy
(`auto_approve_min_star = 4`), since the account's only policy was
`solicitation`/`sending` and unarmed.

Every seeded id carried the marker `0109de11-0000-7000-8000-…` so teardown was
exact.

## 5. The write site — the deployed worker, a real Supabase

```
[INFO] autonomy_admin_alert sent      trigger=governor_edit_rate
[INFO] autonomy_suspended_notice sent channel=email  sent=1
```

The row it wrote:

| Column | Value | The rule it proves |
|---|---|---|
| `refusal_source` | `autonomy_suspended` | the lane |
| `refusal_code` | `governor_edit_rate` | C4 — verbatim, never normalised |
| `refusal_category` | `autonomy_paused` | the vocabulary map |
| `vocabulary_version` | `refusal_vocab_2026-08-30.1` | frozen at write |
| `business_id` | **NULL** | **C3** — account-wide, the parent effort's fan-out defect |
| `subject_type` / `subject_id` | **NULL / NULL** | **C1, C2** — this lane points at nothing |
| `all_refusal_codes` | **NULL** | **C5** — NULL, never `'{}'` |
| rows | **exactly 1** | one per account, never one per location |

**And the one that carries #1006:**

```
refusal_events.occurred_at    2026-08-31 00:57:31.991243+00
account_audit_log.created_at  2026-08-31 00:57:31.991243+00
timestamps_identical          true
```

Identical **to the microsecond**, read `::text` on both sides. That equality is
the substitute #1006 accepted instead of a `suspension_event_id` column, and it
is what would break the day a site passed a JS `Date` (postgres.js truncates
microseconds, #520). Proven here against a deployed worker rather than a local
fixture.

## 6. The kill switch — byte-identical, proven

With `REFUSAL_LEDGER_ENABLED=false`, the seeded breach was re-armed by clearing
`suspended_at` directly. **Not** by writing an `autonomy_unsuspended` audit row:
the candidate query takes `window_start` as
`GREATEST(now-7d, MAX(autonomy_unsuspended.created_at))`, so an unsuspend row
would have moved the window past the seeded outcomes and produced no breach.

```
[WARN] refusal ledger disabled — no decisions are being recorded
       logger="refusals:write" data={"flag":"REFUSAL_LEDGER_ENABLED"}
[INFO] autonomy_suspended_notice sent  sent=1
```

Final counts:

| | |
|---|---|
| suspension audit rows | **2** |
| notices sent | **2** |
| `refusal_events` rows | **1** |

**The second suspension completed in full and wrote no ledger row.** Policy
suspended, audit written, notice sent — identical to the behaviour before the
ledger existed. That is the intake's "byte-identical when off" claim, measured.

The `[WARN]` line is also the design from red-team RT-8/A-02 working as
intended: the **structured log line is the durable signal**, emitted first and
outside the Sentry guard, because `captureMessage` returns on queue rather than
delivery.

## 7. Teardown — staging restored

| | Before | After |
|---|---|---|
| `refusal_events` | 0 | **0** |
| `autonomy_suspended` audit rows | 0 | **0** |
| `auto_approval_policies` | 1 (solicitation/sending) | **1** (same row) |
| suspended policies | 0 | **0** |
| `agent_outcomes` | 18 | **18** |
| suspension notices in outbox | 0 | **0** |
| `GOVERNOR_ENABLED` | `false` | **`false`** |
| `REFUSAL_LEDGER_ENABLED` | absent | **absent** |

## 8. What this ride did NOT prove

- **The per-location fan-out guard, at scale.** The staging account has ONE
  business, so "exactly one row" could not distinguish one-per-account from
  one-per-location here. Test 16 does — it seeds MULTIPLE businesses locally,
  which is why the assertion is `exactly one` rather than `at least one`.
- **Any lane except `autonomy_suspended`.** The other ten write sites are
  #1010–#1013 and do not exist yet.
- **Alert routing.** Neither Sentry signal reaches a paging channel (red-team
  RT-1, accepted-risk). The `[WARN]` line above went to the structured log,
  which is exactly why that log line is the primary transport.
