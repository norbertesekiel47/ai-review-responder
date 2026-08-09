# Consented Review Import — staging proof (epic #667, gate for #680)

**Date:** 2026-08-08, 21:25–21:29 UTC
**Why this exists:** #680 (DROP the four legacy `zernio_backfill_runs` counters) carries a hard
precondition — *every epic ticket merged **and proven on staging** (#673–#679)*. The epic ships with
no feature flag, so `git revert` is its only backout, and migration 103 is the point where that
backout stops being sufficient (ADR 0015 §4). This run is that proof, captured before 103 is written.

**Code under test:** staging branch head `e447ee5b` (= `main`, incl. #678 and #679). No deploy was
needed — staging already tracked current `main`. Open PR #713 at the time of the run is docs-only.

**Environments**
- Staging Supabase `kubdiqdhqbhwmqfditeg`; production Supabase `udeyaqnvpojbwgoaxwdg`
- Staging worker `/ready` → `{"status":"ready","checks":{"postgres":"ok","queue_redis":"ok","cache_redis":"ok"}}`

## Subject

Account `norbertliverpool+e7@gmail.com` → business **Terry Business**
`019fd4b6-6fef-708c-b2b4-ef30917ef39b`, `trialing`/`copilot`. Chosen as the cleanest slate:
`import_decision = 'pending'`, no offer, **0** `zernio_connections`, **0** reviews, **0** backfill runs.

`zernio_connections_one_active_per_business` is UNIQUE on `business_id` only — **not** on
`zernio_location_id` — so the same Google location may back a second RepWorth account. No second
real GBP location was required.

## Walkthrough and per-step assertions

### 1. Connect (21:25:07 UTC) — offer minted, nothing imported

| assertion | observed | ticket |
|---|---|---|
| `zernio_connections.status` | `active`, location `3900285370405997311` | — |
| `import_decision` | **`pending`** — connect does not decide | #673 |
| `import_offer_expires_at` | `2026-08-15 21:25:07Z` = connect **+ 7 days** | #677 |
| backfill runs | **0** | #676 |
| reviews | **0** | #676 |

The Import offer rendered on the dashboard: *"We can pull in your 100 most recent Google reviews
from the past year… Nothing gets posted — you choose what to reply to. This is a one-time import,
available for the next 7 days."*

**Chokepoint guard observed.** A `zernio_initial_backfill` outbox row for this business sat at
`completed` while runs and reviews were both 0 — `guardImportConsent` (#679) fail-closed
no-op-completing an enqueue that never had `accepted` consent. This also explains the pre-run
staging ratio of **9 completed `zernio_initial_backfill` rows against 1 backfill run**: those are
no-op completions, not lost imports.

### 2. Accept (21:26:00 UTC) — decision recorded, fresh enqueue

| assertion | observed |
|---|---|
| `import_decision` | **`accepted`** |
| `import_decision_at` | `2026-08-08 21:26:00.904Z` |
| new outbox row | `zernio_initial_backfill` **`dispatched`** @21:26:01 (the pre-consent row stays `completed`) |

### 3. Import (21:26:06 → 21:26:20 UTC, 14s) — run `019fe344-d080-722c-96ae-715edb3f400f`

| column | value |
|---|---|
| `run_reason` | `initial` |
| `imported_count` | **29** |
| `skipped_count` | 0 |
| `oldest_skipped_create_time` | NULL |
| `gap_processed_count` / `historical_processed_count` | **0 / 0** |
| `gap_skipped_count` / `historical_skipped_count` | **0 / 0** |

**This is the fact #680 turns on:** current code writes nothing to the four columns migration 103
drops. The legacy four are frozen at DEFAULT 0 exactly as migration 100's dual-write-contract note
predicted the post-#675 world would look.

### 4. KEYSTONE — imported reviews draft nothing (#674)

| assertion | observed |
|---|---|
| imported reviews | 29 |
| `generate_response` enqueued **by review id** | **0** |
| `generate_response` enqueued repo-wide since connect | **0** |
| `api_costs` rows for the business | **0** |
| reviews in `pending` status | 0 |

11 `responses` rows were created during the import window. They are **imported existing Google
replies, not AI drafts**: `status='posted'`, `approval_method` NULL, `llm_provider`/`llm_model`
NULL, **0 tokens**, `posted_at` set — the answered half of #675's "answered + unanswered"
selection. Zero LLM spend for the entire import.

### 5. Reviews list (#678)

`/dashboard/reviews/history` — *"All Reviews · Every review for Terry Business — unanswered first."*

| tile | value |
|---|---|
| Total reviews | 29 |
| Unanswered | 18 |
| Answered | 11 |
| Avg rating | 4.4 |

- Unanswered section headed `Unanswered · 18 of 18`, sorted ahead of answered — **18 `Generate`
  doors**, each row reading *"NO REPLY YET / This review has no reply on Google."*
- Answered rows show **11 `Regenerate` doors** — one per imported reply, exactly matching the 11
  posted responses — each labelled **"Posted by you before joining"** with the original Google
  reply date, and carrying the daily budget indicator **"0 of 3 today"**.
- `Needs Action` tab was **empty** — the UI-visible form of #674: an import creates no approval work.
- Dashboard receipt after import: *"Imported 29 reviews. They're in your reviews list."*; KPIs moved
  to 4.4★ and **38% response rate** (= 11/29, consistent with the imported replies).

### 6. On-demand generation (#678) — the contrast that proves the gate

One `Generate` click on the "Rajdeep das" row:

| assertion | observed |
|---|---|
| outbox | `generate_response` @21:28:55 → **`completed`** |
| response | `019fe347-8cf9-76b8-baa5-618037db1541`, `pending_approval` |
| model | `openai` / `gpt-4o-mini-2024-07-18` (the pinned ID) |
| tokens | 311 prompt + 46 completion |

**29 imported reviews produced 0 generations; one explicit click produced exactly 1.**

## Reconciliation preflight — the #680 gate itself

The naive predicate is **wrong** and must not be used: post-#675 rows carry all four legacy counters
at 0 while `imported_count` is non-zero, so `collapsed <> legacy sums` flags a perfectly healthy row.
Both staging rows flag under it. The ticket comment's actual semantics are a two-branch disjunction —
a row is only suspect if it *did* legacy work AND its collapsed values disagree:

```sql
SELECT count(*) FROM zernio_backfill_runs
WHERE NOT (gap_processed_count = 0 AND historical_processed_count = 0
           AND gap_skipped_count = 0 AND historical_skipped_count = 0)
  AND (imported_count <> gap_processed_count + historical_processed_count
    OR skipped_count  <> gap_skipped_count  + historical_skipped_count);
-- ABORT the migration if this returns anything other than 0.
```

A pre-#675 run that did real work but recorded zero legacy counters would be misclassified into the
post-#675 branch — it cannot exist, because the pre-#675 worker dual-wrote both column sets in the
same UPDATE, so non-zero collapsed implies non-zero legacy.

**Result, post-run, both projects:**

| env | runs | naive predicate | **two-branch predicate (the gate)** | post-#675 zero-legacy rows | total imported |
|---|---|---|---|---|---|
| staging `kubdiqdhqbhwmqfditeg` | 2 | 2 flagged (both false positives) | **0** ✅ | 2 | 58 |
| production `udeyaqnvpojbwgoaxwdg` | 0 | 0 | **0** ✅ | 0 | 0 |

## Verdict

**PASS.** The consented-import loop works end-to-end on current `main`: offer minted at connect and
not before, consent gate holds closed until `accepted`, the chokepoint guard no-op-completes
unconsented enqueues, import stores 29 reviews and drafts nothing, the reviews list sorts
unanswered-first with working Generate/Regenerate doors, and on-demand generation produces exactly
one draft per click. Both environments return **0 abort rows** under the two-branch reconciliation
preflight, so migration 103 may DROP the four legacy counters.

## Unrelated defect observed (NOT a #680 blocker)

Terry Business carries ~24 `onboarding_drip` outbox rows in `failed` status (one `dispatched`).
Pre-existing on staging, unrelated to the import path, and outside this ticket's surface. Filed here
so it is not lost; it needs its own ticket.
