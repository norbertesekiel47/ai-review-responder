# Evidence — Solicitation watch-mode staging flip (map #528 destination)

**Date:** 2026-07-26 ~00:40 UTC · **Environment:** staging only · **Flag:** `SOLICITATION_WATCH_ENABLED=true`

## What was flipped, where

| Surface | Where | Value | Set by | Verified |
|---|---|---|---|---|
| Railway staging worker (`repworth-worker`, env `staging`) | service env var | `true` | #544 session (recorded in its ride commits) | `railway variables` shows `SOLICITATION_WATCH_ENABLED=true` (2026-07-26) |
| Vercel staging custom env | project env var | `true` (encrypted) | #544 session (~2h before promotion) | `vercel env ls staging` lists the var |

No `NEXT_PUBLIC_*` companion exists (invariant #13; `ci:static-policy` enforced).
The flag is NOT an autonomy flag — watch-mode takes no public action — so the
§8.4 ordered go-live sequence does not apply. **Production remains OFF/unset.**

## Deploy that carried it live

- `staging` branch reset onto `main` at `464426c5` (squash-merge protocol,
  precedent: #472 map) — force-with-lease push, 2026-07-26 00:37 UTC.
- Railway staging worker deploy: **SUCCESS**; boot log clean
  ("readiness cure complete — background loops staggered, workers resumed"),
  poll cycles nominal, zero boot errors.
- Vercel staging deploy: **Ready** (git-sourced `target:staging`).

## Migrations at this point (staging AND prod, lockstep verified by introspection)

084, 085, 086, 087, 088, 089 — all present in both projects. Prod head = 089.

## What this means

Wayfinder map #528's destination is reached: both probes (Competitor Delta
digest line + Voice Report Card) are on `main`, and the Solicitation agent is
live on staging in watch-mode — real batches from owner-uploaded CSV
candidates, per-candidate send/withhold decisions with evidence, nothing sent.

## Remaining smoke (needs an SSO-authenticated browser — owner)

External curl cannot pass Vercel SSO on staging. Owner UI pass when convenient:
1. `/dashboard/requests` renders (Requests nav visible in sidebar + mobile bar).
2. Upload a small CSV at `/dashboard/requests/contacts` → report renders,
   batch appears after the build job (funnel hero, verbatim withhold chips,
   no star ratings anywhere).
3. Opening the batch writes `reviewed_at` (visible in the digest/analytics lane).

> **Executed 2026-07-26 02:42–02:59 UTC — all three items PASS.**
> Full evidence in "Owner UI smoke" below; verdict at the end of this file.

---

# Owner UI smoke — 2026-07-26 · **VERDICT: PASS**

**Ran:** 2026-07-26 02:42 → 02:59 UTC · **Operator:** owner-authenticated browser (Claude in Chrome)

## Environment

| Item | Value |
|---|---|
| Environment | **staging only** — shared, live |
| UI | `https://staging.repworth.net` |
| Supabase (staging) | `kubdiqdhqbhwmqfditeg` (RepWorth-staging) |
| Supabase (prod) | `udeyaqnvpojbwgoaxwdg` — **NEVER touched this run** |
| Worker | Railway `repworth-worker`, env `staging` |
| git SHA at start | `8881029d` |
| Signed-in owner | Norbert Liverpool · account `019f877f-…-7ab4548ff259` |
| Location under test | **Tancia Resort** · business `019f877f-…-7018319c5513` · category `Resort` |
| Posture | Watch-mode: nothing is sent. No flag or env-var changes. No prod access. |

**Derived gate constant:** category `Resort` matches no `VERTICAL_KEYWORDS` entry
→ vertical `other` → `FRESHNESS_WINDOW_DAYS.other = 30`. At `decided_at` =
2026-07-26 UTC, a visit on/after 2026-06-26 is fresh; on/before 2026-06-25 is
`stale_visit`.

## Preflight

| Check | Result | UTC |
|---|---|---|
| Staging dashboard loads, owner authenticated | ✅ | 02:40 |
| `SOLICITATION_WATCH_ENABLED` already `true` on both surfaces (read-only, not changed) | ✅ (per table above) | 02:40 |
| Prod Supabase untouched | ✅ by construction | — |
| **Pre-existing solicitation state recorded (see D-1)** | ⚠️ non-empty | 02:39 |

### Baseline before this run (SQL, staging)

```sql
SELECT (SELECT count(*) FROM solicitation_contacts) AS contacts,
       (SELECT count(*) FROM solicitation_visits)   AS visits,
       (SELECT count(*) FROM solicitation_batches)  AS batches,
       (SELECT count(*) FROM solicitation_asks)     AS asks,
       (SELECT count(*) FROM contact_csv_uploads)   AS uploads;
-- [{"contacts":40,"visits":40,"batches":1,"asks":40,"uploads":1}]

SELECT status, withheld_reason, count(*) FROM solicitation_asks GROUP BY 1,2;
-- send/null 25 · withhold/stale_visit 8 · withhold/velocity_banked 7
```

Prior batch `019f9ba5-5ef7-754b-8f3c-36a616682601` (built 2026-07-25 23:38 UTC,
already `reviewed_at`), sourced from upload `019f9ba5-375a-7013-91b3-84c4931b58fb`.

## Deviations

- **D-1 (02:39 UTC) — pre-existing contact pool, not created by this run.** The
  location already carried 40 contacts / 1 built batch from a run ~3 h earlier.
  `batch-builder.ts` pools **every contact of the business**
  (`WHERE c.business_id = …`), not just the uploading file's rows, so this run's
  funnel is scoped to the accumulated pool and **cannot** equal the smoke CSV's
  row counts. Absorbing this by deleting the prior 40 rows was rejected: they are
  another run's fixture in a shared env, and the brief is "touch nothing beyond
  the smoke". Instead the expected per-gate arithmetic over the combined pool is
  stated in advance (below) and verified against the actual build.

## Teardown ledger

Every fixture this run creates. Rows are added at creation time.

| # | Fixture | Identifier | Removal | Done |
|---|---|---|---|---|
| T-1 | 6 smoke contacts (+ their visits, asks) | `solicitation_contacts` where `email LIKE 'smoke+%@example.com'` OR `phone = '+14155559904'` | UI per-contact delete on `/dashboard/requests/contacts`; CASCADE removes visits + asks | [x] 02:58 UTC — verified 0/0/0 |
| T-2 | Contacts CSV upload row | `contact_csv_uploads` row created by this run (filename `smoke-contacts-20260726.csv`) | Left in place deliberately — it is the audit record of the upload and has no send-side effect; `raw_csv` is already NULLed at terminalization | n/a |
| T-3 | Solicitation batch + asks built from T-1/T-2 | `solicitation_batches` row created this run | Asks CASCADE-delete with T-1's contacts; the empty batch row is left as the audit record | n/a |
| T-4 | Local scratch CSV | `…/scratchpad/smoke-contacts-20260726.csv` | Delete at end of run | [x] 02:59 UTC — removed |

**No flags flipped, no env vars changed** — so the ledger has no flag rows.

## The smoke CSV

9 data rows, all obviously-fake contacts, designed so each gate and each ingest
outcome is exercised by construction. `todayUtc` at ingest = 2026-07-26.

| Row | Handle | `last_visit_date` | Intent | Expected |
|---|---|---|---|---|
| 1 | `smoke+1@example.com` | 2026-07-26 (today) | today's visit is not "future" | create → `send` |
| 2 | `smoke+2@example.com` | 2026-07-24 | fresh | create → `send` |
| 3 | `smoke+3@example.com` | 2026-07-20 | fresh | create → `send` |
| 4 | *(phone only)* `+14155559904` | 2026-07-22 | handle-only-phone row | create → `send` |
| 5 | `smoke+5@example.com` | 2026-03-10 | 138 d, clearly stale | create → `stale_visit` |
| 6 | `smoke+6@example.com` | 2026-05-01 | 86 d, clearly stale | create → `stale_visit` |
| 7 | `not-an-email` | 2026-07-23 | validation rejection | **rejected** `invalid_email` |
| 8 | `smoke+4@…` + `+14155559904` | 2026-07-21 | merges an email into row 4's phone-only contact | merge, +1 visit |
| 9 | `smoke+1@example.com` | 2026-07-26 | same contact + same date | **duplicate visit** |

### Expected batch arithmetic, stated BEFORE the build (D-1 pool of 40 + 6 new)

| Cohort | n | Gate reached | Reason |
|---|---|---|---|
| Prior batch's 25 `send` rows | 25 | `over_contacted` | prior send 2026-07-25, gap 1 d < `MIN_GAP_DAYS` 30 |
| Prior batch's 8 `stale_visit` rows | 8 | `stale_visit` | visits Mar 25 – May 20, still > 30 d |
| Prior batch's 7 `velocity_banked` rows | 7 | `send` | fresh (Jul 19); banked rows carry no prior **send** ask |
| Smoke rows 1–4 | 4 | `send` | fresh |
| Smoke rows 5–6 | 2 | `stale_visit` | 138 d / 86 d |
| **Total** | **46** | — | **send 11 · stale_visit 10 · over_contacted 25 · everything else 0** |

## Results

### Step 1 — NAV · ✅ PASS (02:40)

- `/dashboard` loads authenticated as Norbert Liverpool / Tancia Resort.
- **Requests** present in the sidebar between Reviews and Analytics.
- **Requests** present in the mobile tab bar: the live a11y tree exposes the
  bottom `navigation` landmark containing Home / Reviews / **Requests** /
  Analytics / Settings (`MobileTabBar.tsx` renders it behind `solicitationEnabled`,
  so its presence is itself proof the server-authoritative flag is on).
- `/dashboard/requests` renders the batch screen — **not** a 404.

### Step 2 — UPLOAD · ✅ PASS (02:43–02:44)

**Attestation is blocking — verified three ways, before the real upload:**

1. With a file chosen and the box unchecked, **"Upload CSV" is disabled**
   (`canSubmit = file !== null && attested`).
2. Clicking it produced **no state change** — the button never entered
   `Uploading…`/`Processing…`.
3. DB proof that nothing was POSTed: `SELECT count(*) FROM contact_csv_uploads`
   → **1** (unchanged baseline) at 02:43 UTC.

Then checked the box → upload accepted → `Processing…` → terminal report:

| Tile | Value | Expected |
|---|---|---|
| Contacts created | **6** | 6 ✅ |
| Contacts merged | **1** | 1 ✅ |
| Visits added | **7** | 7 ✅ |
| Duplicate visits | **1** | 1 ✅ |
| Rejected rows | **1** — row `7`, "Invalid email" | 1 ✅ |

Contact list moved 40 → **46 total**. The merge is visible in the list: Smoke
Four renders with **both** `smoke+4@example.com` and `+14155559904`.

### Step 3 — BUILD · ✅ PASS (02:44)

Railway staging worker (`railway logs --environment staging --service repworth-worker`):

```
[INFO] csv ingest completed
  data={"upload_id":"019f9c4f-7702-754a-9e14-7e6db7a2a042","contacts_created":6,
        "contacts_merged":1,"visits_added":7,"duplicate_visits":1,"rejected_total":1,
        "solicitation_batches_created":1,"build_solicitation_batch_jobs_enqueued":1,
        "rejected_invalid_email":1}

[INFO] solicitation batch build finished
  data={"status":"built","batch_id":"019f9c4f-7fa1-7427-8e6b-8a7d3d88fbf2",
        "outbox_attempt":1,"selected_count":46,"pool_count":46,"truncated_count":0,
        "send_count":11,"withhold_count":35,
        "withheld_by_reason":{"no_consent":0,"suppressed":0,"already_reviewed":0,
                              "stale_visit":10,"over_contacted":25,"velocity_banked":0}}
```

PII contract holds: counts and reason histograms only — no name, email, phone,
note, or raw CSV text in either line.

DB confirmation:

```sql
SELECT id, built_at::text, reviewed_at::text FROM solicitation_batches ORDER BY created_at DESC LIMIT 1;
-- 019f9c4f-7fa1-7427-8e6b-8a7d3d88fbf2 | 2026-07-26 02:44:47.998+00 | NULL

SELECT status, COALESCE(withheld_reason,'—'), count(*) FROM solicitation_asks
 WHERE batch_id = '019f9c4f-7fa1-7427-8e6b-8a7d3d88fbf2' GROUP BY 1,2;
-- send | —              | 11
-- withhold | over_contacted | 25
-- withhold | stale_visit    | 10
```

**Log, DB, and the pre-stated arithmetic agree exactly.** `truncated_count = 0`
(`pool_count` 46 < `MAX_DATA_ROWS`), and `velocity_banked = 0` is correct —
11 eligible ≤ `BATCH_CAP` 25.

### Step 4 — SCREEN · ✅ PASS (02:45)

| Requirement | Observed |
|---|---|
| Funnel hero | **46** candidates evaluated · **35** held back · **11** would have been sent — matches the build log; plus "46 contacts on file" as a present-tense fact |
| Withhold codes as **verbatim** mono chips | `no_consent` `suppressed` `already_reviewed` `stale_visit` `over_contacted` `velocity_banked` — all six, verbatim, in the closed enum's precedence order, each with a plain-English gloss beside it |
| `suppressed` as an explicit **zero-count** group | "`suppressed` · Marked never-contact · **0 held back** · *Nobody this batch.*" — likewise `no_consent`, `already_reviewed`, `velocity_banked` |
| Validation rejection **only** in the footnote | Footnote: "Rows that failed validation when you uploaded the file never reached these checks and are not held back — they are listed in the upload report." Row 7 appears **nowhere** in the ledger; 46 asks for 46 contacts |
| **NO star rating anywhere** (ADR 0012) | Full page-text sweep and an accessibility-tree sweep for star icons / numeric ratings / sentiment indicators both returned **nothing**. `already_reviewed` is empty this batch, so no review-date line rendered either |
| Watch-mode posture | "Watch-mode · nothing sent" pill on the hero |

Evidence lines render the policy constants faithfully, e.g.
`Visited Mar 10, 2026, 138 days ago · past the 30-day window for your trade.`
and `Already in a batch on Jul 25, 2026 · 30-day minimum gap between asks.`
Both smoke stale rows appear under `stale_visit`; the 10-row sample cap plus
"…and 15 more" renders correctly for the 25-row `over_contacted` group.

**Incidental cross-check:** the 30-day window and the "your trade" label were
derived statically from `category = 'Resort'` → no keyword match → vertical
`other`, *before* the batch was built; the UI independently rendered the same.
Static reading and live behavior agree.

### Step 5 — REVIEWED · ✅ PASS (02:46–02:48)

`reviewed_at` was **NULL** immediately after the batch screen first rendered.
Root cause was not a defect: `useReviewedPing` is deliberately gated on
`document.visibilityState === 'visible'` ("a hidden tab does not ping … the
signal has to mean somebody looked"), and the automation window was minimized —
confirmed in-page as `{visibility: "hidden", hasFocus: true}`.

This produced a **stronger** result than a plain open would have, because both
halves of the gate were observed:

| Moment | `visibilityState` | `reviewed_at` |
|---|---|---|
| Batch screen rendered, window minimized | `hidden` | `NULL` — ping correctly withheld |
| Window brought to the foreground | `visible` | **`2026-07-26 02:47:59.495634+00`** — written by the real client effect |

`reviewed_at` (02:47:59) > `built_at` (02:44:47), satisfying migration 088's
`solicitation_batches_reviewed_after_built` CHECK.

**Idempotent / first-write-wins**, verified two ways:

1. Second visit (full page reload of `/dashboard/requests`) → `reviewed_at`
   **unchanged** at `02:47:59.495634+00`.
2. The exact guard predicate of `markBatchReviewed()` evaluated read-only:

```sql
SELECT count(*) AS rows_a_second_ping_would_update
  FROM solicitation_batches
 WHERE id = '019f9c4f-7fa1-7427-8e6b-8a7d3d88fbf2'
   AND account_id = '019f877f-2352-722c-94e6-7ab4548ff259'
   AND business_id = '019f877f-2352-722c-94e6-7018319c5513'
   AND built_at IS NOT NULL AND reviewed_at IS NULL;
-- 0
```

A second ping matches **0 rows** → returns 0 → the timestamp cannot move.
See D-2 for the residual limit on this step.

### Step 6 — CLEANUP · ✅ PASS (02:53–02:58)

All six smoke contacts removed through the **owner UI** per-contact delete
(in-page confirm step → "Delete permanently"; no native dialog involved).
Contact count walked 46 → 45 → 44 → 43 → 42 → 41 → **40**, the exact pre-run
baseline.

```sql
WITH smoke_ids(id) AS (VALUES (…6 contact uuids…))
SELECT (SELECT count(*) FROM solicitation_contacts c JOIN smoke_ids s ON s.id=c.id)          AS contacts_left,
       (SELECT count(*) FROM solicitation_visits  v JOIN smoke_ids s ON s.id=v.contact_id)   AS visits_left,
       (SELECT count(*) FROM solicitation_asks    a JOIN smoke_ids s ON s.id=a.contact_id)   AS asks_left,
       (SELECT count(*) FROM solicitation_contacts
         WHERE email LIKE 'smoke+%' OR phone = '+14155559904')                               AS by_handle_left,
       (SELECT count(*) FROM solicitation_contacts)                                          AS total_contacts_now,
       (SELECT count(*) FROM solicitation_asks
         WHERE batch_id = '019f9c4f-7fa1-7427-8e6b-8a7d3d88fbf2')                            AS smoke_batch_asks_now;
-- contacts_left 0 · visits_left 0 · asks_left 0 · by_handle_left 0
-- total_contacts_now 40 · smoke_batch_asks_now 40
```

**CASCADE confirmed on both edges:** the 7 visits and the 6 asks went with their
contacts, and the batch's ask count fell 46 → 40 via
`solicitation_asks_contact_business_fk` — the exact cascade `batch-view.ts`
documents as the reason its funnel and ledger must come from one statement.

## Deviations (final)

- **D-1 (02:39 UTC) — pre-existing contact pool.** As logged above. Absorbed by
  stating the expected per-gate arithmetic in advance; the build matched it
  exactly. Net effect was *beneficial*: the prior batch's 25 sends are the only
  reason `over_contacted` was observable at all, and this run therefore covered
  five of the six reason codes' render paths (four as zero-count groups).
- **D-2 (02:48 UTC) — second-visit ping not observed end-to-end.** The window
  returned to `hidden` before the reload's ping could fire, and an attempt to
  invoke the route directly from the page was blocked by the operator's tool
  policy. Idempotency is therefore proven by the guard predicate (0 matching
  rows) plus an unchanged timestamp across a reload, rather than by an observed
  second HTTP POST. The server contract is single-statement and fully covered by
  `batch-view` integration tests; recorded here for completeness, not as a gap
  that blocks the verdict.

## Unproven paths

None blocking. Watch-mode's remaining unexercised gates are unreachable **by
construction**, not by omission, and each is contract-tested:

- `no_consent` — the #535 attestation is blocking, so every uploaded candidate is
  covered (verified again this run: upload is impossible unattested).
- `suppressed` — no suppression-ledger source exists in v-watch (send-mode scope).
- `already_reviewed` — the builder passes `matchedReview: null` in v-watch.
- `velocity_banked` — needs > `BATCH_CAP` (25) eligible candidates; this run had
  11. It *was* exercised by the prior batch (7 banked), visible in this file's
  baseline section.

## Verdict

**PASS** — 2026-07-26 02:59 UTC.

- All 6 smoke steps PASS; the three "Remaining smoke" items at the top of this
  file are closed.
- Deviations: 2 (D-1, D-2), both documented above, neither product-shaped.
- Bugs filed: **none** — nothing behaved incorrectly at any step.
- Teardown: **complete and verified by query**, not assumption (T-1, T-4 ticked;
  T-2/T-3 are deliberate audit records with no send-side effect).
- Final staging state (02:59 UTC), stated in full rather than as "clean":

  ```sql
  -- contacts 40 · visits 40 · batches 2 · asks 80 · uploads 2
  ```

  Contacts and visits are back to their exact pre-run values. The extra batch,
  40 asks and upload row are this run's **retained audit records** (ledger T-2 /
  T-3): the smoke batch now holds only the 40 pre-existing contacts' asks, its
  own 6 having cascaded away. They carry no send-side effect and `raw_csv` was
  NULLed at terminalization.
- No flag or env-var was read-modified; **production Supabase was never queried**.
- Nothing was sent to any customer — watch-mode posture held throughout.

## Production flip

## Production flip

Deliberately NOT done. Rides the production bring-up (§8.4 posture); when it
happens: set the var on prod Railway worker + Vercel production env, redeploy,
same smoke. No ordering dependency on the autonomy flags.
