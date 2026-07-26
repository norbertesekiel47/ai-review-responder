# Step 7 — Spec & Correctness review · `feat-544-watch-mode-batch-ui`

Reviewer: spec/correctness lane (read-only). Diff under review: `git diff b266ca00..HEAD`
(32 files, +4206 / −34). Contract: `.feature/intake.json`. Plan rev 4:
`docs/superpowers/plans/2026-07-25-544-watch-mode-batch-ui.md`. Triaged deviations:
`docs/superpowers/plans/feat-544-watch-mode-batch-ui-deviations.md`.

**Verification run during this review (evidence, not claims):**

| Command | Result |
|---|---|
| `npx vitest run` over the 6 new/changed suites | **6 files, 66 tests, all pass** (928 ms) |
| `pnpm ci:tenant-scope` | passed — entries 405, baseline 405 (unchanged) |
| `pnpm ci:static-policy` | passed (1024 files) — no new `NEXT_PUBLIC_*` |
| `pnpm ci:db-imports` | passed (strict) — `src/lib/solicitation/batch-view.ts` is not a `db/server` importer |
| `pnpm ci:rls-audit` | static coverage passed |

---

## Findings (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| Medium | `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:263` (copy at `:81-89`) | Every 404 from the batch API is mapped to `kind: 'gone'`, so an unresolvable **location** scope (archived location, foreign/stale `rw_location_scope` cookie — `resolveDashboardLocation` returns `errorResponse('Business not found', 404)` under `uniform-not-found`, `src/app/api/dashboard/policy.ts:117-131`) renders “**Review requests have been switched off for your account**”. The owner is told the feature was disabled when nothing was disabled. |
| Low | `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:53-56` | `user_visible_behavior` #11 — “reachable from the **Requests header** and the empty-state CTA” — is only half implemented. `TopBar` is rendered without its `rightLink` prop (`src/components/dashboard/shell/TopBar.tsx:16`), and neither nav has a Contacts row, so `/dashboard/requests/contacts` is reachable **only** from the `no_batch` CTA (`GhostPipeline.tsx:92`) and the built-state footnote (`BatchReport.tsx:65`). The `building`, `stalled`, `error`, `gone` and aggregate-scope screens have no path to the upload surface at all — including the screen an owner sits on immediately after uploading. |
| Low | `src/app/(authenticated)/dashboard/requests/BatchReport.tsx:185` | The internal `Vertical` enum is rendered verbatim in owner-facing prose: `…past the ${evidence.freshness_window_days}-day window for ${evidence.vertical}`. For an unmapped `businesses.category` (`resolveVertical` → `'other'`, `restraint-policy.ts:37-46`) the sentence reads “past the 30-day window for **other**.”; for a salon it reads “for **personal_care**.” The six withhold codes are deliberately paired with owner-readable labels (`REASON_META`); this second closed enum is not, and no test covers the string. |
| Low | `src/app/api/dashboard/solicitation/batch/reviewed/route.ts:59` (contract at `src/lib/solicitation/batch-view.ts:281-296`) | `markBatchReviewed` documents its return value as the discriminator that stops “a silent 0 [being] indistinguishable from a failure”, but the only caller discards it and answers 204 unconditionally — with no log line. The failure the route’s own comment at `:44-47` names (a caller that omits `?scope=` → three-key UPDATE matches zero rows) therefore produces a healthy-looking 204 and permanently loses the intake’s `reviewed_at` engagement signal with **no** symptom anywhere. The current client is correct (`RequestsClient.tsx:338`, asserted at `requests-client.test.tsx:313`), so this is a missing guard-rail rather than a live bug. |

---

## Contract verification — field by field

### `user_visible_behavior` (13/13)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Requests sidebar row between Reviews and Analytics, only when watch-mode is on | **PASS** | `Sidebar.tsx:101-110` (between the Reviews `Link` at `:94` and Analytics at `:110`); flag arrives as a server prop from `(authenticated)/layout.tsx:167,186`. Tests `Sidebar.test.tsx:136,145`. |
| 2 | `/dashboard/requests` renders the most recent batch: funnel hero above a withheld ledger in precedence order | **PASS** | `readLatestBatch` `ORDER BY created_at DESC, id DESC LIMIT 1` (`batch-view.ts:243-249`); `toGroups` maps over `WITHHOLD_REASONS` (`:127-129`), whose order matches the intake list exactly (`restraint-policy.ts:26-33`). Hero `BatchReport.tsx:74-99`, ledger `:51-60`. |
| 3 | Six codes render verbatim as mono chips with an owner-readable label | **PASS** | `BatchReport.tsx:128` renders `{group.reason}` (the value, never a literal); `REASON_META` is `Record<WithholdReason, …>` so the compiler forces all six keys and none is re-typed as a chip string. Test `batch-report.test.tsx:129`. |
| 4 | Exact total + at most 10 evidence rows + “…and N more” | **PASS** | Total from `(COUNT(*) OVER (PARTITION BY withheld_reason))::int` (`batch-view.ts:163`), sample bounded by `r.rn <= ${EVIDENCE_ROWS_PER_REASON}` (`:190`); `remaining = total − sample.length` at `BatchReport.tsx:122,150`. Tests `batch-report.test.tsx:194` (10 rows + “…and 24 more”), integration `batch-view.integration.test.ts:192` (40 real rows → total 40, sample 10). |
| 5 | Zero-count reason renders as “Nobody this batch” | **PASS** | `toGroups` zero-fills (`batch-view.ts:127-129`); `BatchReport.tsx:136-137`. |
| 6 | `already_reviewed` shows the review date only, never a rating | **PASS** | `BatchReport.tsx:180` renders `formatDay(evidence.review_date)`; `review_id` is deliberately not rendered and the test asserts the id is absent from `container.textContent` (`batch-report.test.tsx:143`). |
| 7 | `velocity_banked` reads as banked, “first in line for the next batch” | **PASS** | `REASON_META.velocity_banked` tone `'bank'` → count noun “banked” (`:38,41-44`); evidence line `:190`. Test `batch-report.test.tsx:209` also asserts the word is in **text**, not colour. |
| 8 | No batch → ghost pipeline + upload CTA, plus one contacts-on-file line when contacts exist | **PASS** | `GhostPipeline.tsx:90-104`; the line is conditional on `contactsOnFile > 0` (`:95`). Tests `requests-client.test.tsx:102` (exact sentence regex) and `:129` (omitted at 0). |
| 9 | `built_at` null → building state, polls at the UploadCard cadence, “still processing” at the ceiling | **PASS** | 2 s / 5 min (`RequestsClient.tsx:28-29`, same values as `contacts/UploadCard.tsx`); `stalled` → `headline(true)` = “Still processing” (`GhostPipeline.tsx:138-140`). Test `requests-client.test.tsx:138` asserts fetch count is frozen after the ceiling. |
| 10 | Built batch with zero asks renders the real funnel with 0 queued | **PASS** | The `totals` CTE is an unfiltered aggregate, so the `LEFT JOIN` chain always yields ≥1 row (`batch-view.ts:172-198`) and `state` stays `'built'`. UI test `requests-client.test.tsx:160` asserts the CTA and “build your first batch” are both absent. Real-DB proof: `batch-view.integration.test.ts:175` seeds three ask-less batches and still gets `state: 'built'`. |
| 11 | Contacts surface moves to `/dashboard/requests/contacts`, reachable from the Requests header and the empty-state CTA | **PARTIAL** | Move done via `git mv` (rename detected on all five files, `contacts-ui.test.tsx` byte-identical). CTA + footnote link present. **Header link absent** — see findings table. |
| 12 | Opening a batch records `reviewed_at` once; nothing clickable changes a decision | **PASS** | `useReviewedPing` fires once per `batchId` and only for `state === 'built'` (`RequestsClient.tsx:46-48,313-332`); the UPDATE is `WHERE … reviewed_at IS NULL` (`batch-view.ts:305`). No mutating control exists anywhere in `BatchReport`/`GhostPipeline` (only `Link`s and the retry/reload buttons). |
| 13 | With watch-mode off, both pages and the batch API 404 and the sidebar row is absent | **PASS** | `requests/page.tsx:14`, `requests/contacts/page.tsx` (unchanged, still `notFound()`), `batch/route.ts:29`, `reviewed/route.ts:39` → `requireContactsWriteAccess` → flag first (`location-scope.ts:53-55`). Test `route.test.ts:104` asserts **no auth work happened**, not just the status code. |

**Scope drift check.** Behaviour in the diff not named in `user_visible_behavior`: the `error`+retry card, the `gone` card, the aggregate-scope “Choose a location” card, the `LiveRegion` completion announcement, and the **MobileTabBar** Requests tab. All five are proportionate affordances rather than new features; the tab-bar addition is the only one that needed an edit-surface amendment, and the amendment is recorded in the branch’s intake (`docs/superpowers/plans/feat-544-watch-mode-batch-ui-intake.json:71` — `src/components/dashboard/shell/Sidebar.tsx` + its test widened to `src/components/dashboard/**`). No hidden feature found.

### `invariants` (9/9)

| Invariant | Verdict | Evidence |
|---|---|---|
| #13 server-authoritative flag, no `NEXT_PUBLIC` companion, Sidebar learns via a server prop | **PASS** | `layout.tsx:167` reads `solicitationWatchEnabled()` server-side and passes `solicitationEnabled` to both navs; `pnpm ci:static-policy` passes (it fails CI on any new `NEXT_PUBLIC_*`). |
| #8 every read scoped by `account_id` **and** `business_id`; aggregate rejected with one 400 | **PASS** | Q1 `WHERE account_id = … AND business_id = …` (`batch-view.ts:246`); Q2 `solicitation_contacts` has no `account_id`, so account scope comes through `JOIN businesses b ON b.id = c.business_id … b.account_id = …` (`:253-255`) — the same join `contacts-repo.ts` uses; Q3 repeats both keys in `ranked`, in `totals`, and again on the ask join outside the CTE (`:167-168, 177-178, 193-194`); the contact join re-asserts `c.business_id` (`:196`). `markBatchReviewed` keys on all three (`:301-303`). Aggregate → one 400 at `location-scope.ts:32-34`, tested for **both** verbs (`route.test.ts:120`). `ci:tenant-scope` passes with the baseline unchanged. |
| #15 `src/lib/solicitation/**` takes `sql` explicitly, never imports the singleton | **PASS** | `batch-view.ts` imports only `type { Sql, TransactionSql } from 'postgres'`; the singleton is imported by the two route handlers only (`batch/route.ts:12`, `reviewed/route.ts:11`). `pnpm ci:db-imports` passes in strict mode. |
| Flag gate precedes auth (404 before 401) | **PASS** | GET: flag check is the first statement, before `withDashboardOwnerRead` (`batch/route.ts:29,31`). POST: `requireContactsWriteAccess` checks the flag **before** `requireWritableOwner` (`location-scope.ts:53-56`). The test asserts the auth mocks were never invoked, which is what actually proves ordering. *(Note: `withSameOrigin` still wraps the POST outside the flag gate — identical to the shipped `contacts/[id]` DELETE and `contacts/uploads` POST, so this is the sanctioned precedent, not a deviation.)* |
| ADR 0012 — no star rating / sentiment / predicted-sentiment anywhere | **PASS** | `rg -i 'star|rating|sentiment'` over the non-test Requests tree returns only ADR-0012 comments and the string `rating not shown, by design`. No `reviews.rating`, `sentiment_*` column, or review-table join exists in `batch-view.ts`. The test is a negative sweep over the whole rendered tree (`batch-report.test.tsx:136-144`), so it can fail on markup nobody targeted. |
| Closed enum rendered verbatim, never coined/renamed/collapsed | **PASS** | Both maps are `Record<WithholdReason, …>` (`BatchReport.tsx:29`, `GhostPipeline.tsx:31`) and both render the enum **value**; `GhostPipeline` iterates `WITHHOLD_REASONS` directly (`:115`). No withhold-code string literal appears as rendered text anywhere in the tree. |
| `reviewed_at` idempotent first-write-wins, never overwrites | **PASS** | `WHERE … reviewed_at IS NULL` (`batch-view.ts:305`). Both guards verified against migration 088’s real constraint `solicitation_batches_reviewed_after_built CHECK (reviewed_at IS NULL OR (built_at IS NOT NULL AND reviewed_at >= built_at))` — `built_at IS NOT NULL` + `GREATEST(NOW(), built_at)` are each load-bearing against it. Live-DB proof at `batch-view.integration.test.ts:256` (second call returns 0 and the stored timestamp is byte-identical) and `:270` (unbuilt batch refuses). |
| Response bounded by construction — 6 × 10 at any scale | **PASS** | Groups are `WITHHOLD_REASONS.map(...)` (always exactly 6); the sample bound is a **bind parameter inside the join**, not a post-filter (`:190`), and contact names are truncated server-side by `LEFT(c.name, 80)` (`:184`). Proven at scale by the 5,000-ask integration test, which asserts `sample.length <= 10` for every group after a full candidate-window read (`batch-view.integration.test.ts:295-346`). |
| Every funnel number derives from `solicitation_asks`, so hero and ledger cannot disagree | **PASS** — see analysis below | |

### `edge_cases` (10/10)

| # | Case | Verdict | Evidence |
|---|---|---|---|
| 1 | Pre-flip uploads → no batch row → ghost state with a contacts-on-file line, never an error | **PASS** (the important one) | `readLatestBatch` short-circuits to `{ state: 'no_batch', contactsOnFile }` and issues **no** ask query (`:260`); the unit test asserts exactly 3 statements were sent (`batch-view.test.ts:156`) and the integration test seeds a contact with no batch and gets `contactsOnFile: 1` (`:230`). UI renders the ghost + the one extra line, with an explicit assertion that no feature-flag wording leaks (`requests-client.test.tsx:124`). |
| 2 | `built_at` NULL (worker not run / mid-build) | **PASS** | `:261-268` → `building`; UI polls, `aria-busy="true"`. |
| 3 | Built batch, zero asks | **PASS** | Covered above (item 10). |
| 4 | Pool > 5,000 — truncation invisible in the owner UI | **PASS** | No pool/candidate-window/truncation field exists in `BatchView`; the read never touches `solicitation_contacts` except for the present-tense count. |
| 5 | Several batches — only the most recent | **PASS** | `LIMIT 1` with the `id DESC` tie-break; the integration test seeds an explicit `created_at` tie with sorted UUIDs so the tie-break is genuinely exercised (`:175-190`). |
| 6 | Aggregate scope selected | **PASS** | Client never fetches (`RequestsClient.tsx:62,191`, test `:190` asserts zero fetches) **and** the server 400s independently. Belt and braces. |
| 7 | `businessId` of another account → uniform-not-found | **PASS** | Route: `exposure: 'uniform-not-found'` → `{"error":"Business not found"}` 404, asserted on the body not just the status (`route.test.ts:132-138`). Defence in depth: `readLatestBatch` under a foreign `accountId` returns `no_batch`/0 and `markBatchReviewed` returns 0 without touching the row (`batch-view.integration.test.ts:238-254`). |
| 8 | `reviewed_at` already set → second view must not move it | **PASS** | Server-side (`reviewed_at IS NULL`) **and** client-side (`pinged` ref keyed by batchId, `RequestsClient.tsx:314`). |
| 9 | `suppressed` can never fire in v1 → explicit zero group, not omitted | **PASS** | `batch-view.test.ts:159`, `batch-report.test.tsx:146`, and the integration test asserts the exact `{reason:'suppressed', total:0, sample:[]}` object off a live read (`:223`). |
| 10 | Upload-validation rejections belong to the upload report | **PASS** | Footnote at `BatchReport.tsx:62-69`; test asserts both the copy and the href (`batch-report.test.tsx:218`). Nothing in the read model can surface a rejection — `solicitation_asks` is the only source. |

### `tests_to_add` (14/14 present verbatim, none vacuous)

| Contract title | Location | Non-vacuous because |
|---|---|---|
| returns 404 before auth when SOLICITATION_WATCH_ENABLED is off | `route.test.ts:104` | asserts the **auth mocks were never called**, so it fails if the gate moves after auth |
| rejects aggregate location scope with 400 | `route.test.ts:120` | exercises GET *and* POST, and asserts the domain functions were not reached |
| returns uniform 404 for a location owned by another account | `route.test.ts:132` | asserts the response **body** (`Business not found`), so a distinguishable 404 fails |
| returns the most recent batch when a location has several | `batch-view.test.ts:85` + integration `:175` | integration seeds a real `created_at` tie so the `id DESC` tie-break is load-bearing |
| returns exact withheld counts per reason and at most 10 evidence rows per group | `batch-view.test.ts:110` + integration `:192` | integration inserts 40 real withholds → `total: 40`, `sample: 10` |
| returns hasBatch false when the location's uploads completed before watch-mode was enabled | `batch-view.test.ts:147` + integration `:230` | asserts the exact `{state:'no_batch', contactsOnFile}` object **and** that no ask query was issued |
| records reviewed_at once and does not overwrite it on a second view | `batch-view.test.ts:264` + integration `:256` | integration re-reads the stored timestamp and asserts it is unchanged |
| renders the six withhold reason codes verbatim | `batch-report.test.tsx:129` | loops `WITHHOLD_REASONS`, so a renamed/collapsed code fails |
| renders no star rating anywhere on the batch screen | `batch-report.test.tsx:136` | negative sweep over `container.textContent` + an `aria-label*="star"` selector sweep |
| renders the ghost pipeline empty state with the contacts-on-file count when no batch exists | `requests-client.test.tsx:102` | anchors the full sentence with `^…$` on the carrying `<p>` |
| renders the building state while built_at is null and stops polling at the ceiling | `requests-client.test.tsx:138` | snapshots the fetch count at the ceiling and asserts it is frozen 60 s later |
| renders a zero-queued funnel rather than the empty state when a built batch has no asks | `requests-client.test.tsx:160` | asserts the empty-state CTA and copy are **absent** — the actual trap |
| renders suppressed as an explicit zero-count group | `batch-view.test.ts:159` and `batch-report.test.tsx:146` | read-model asserts the whole 6-element enum order; UI asserts the “Nobody this batch” region |
| hides the Requests sidebar row when watch-mode is off | `Sidebar.test.tsx:136` | paired with `:145` which asserts **exactly one** row and its position between Reviews and Analytics |

The unit-level `markBatchReviewed` test is a SQL-shape assertion (`reviewed_at IS NULL`, `built_at IS NOT NULL`, `GREATEST(NOW(), built_at)`, bind order) rather than a semantic one — that is acceptable here **only** because the live-DB test at `batch-view.integration.test.ts:256` proves the semantics. Flagging it so the pairing does not get separated later.

### `non_goals` (9/9 respected)

- **Batch history** — no `[batchId]` route, no prior-batch list; `BatchView` has no history field. ✔
- **Expiry / staleness constant** — `relativeBuildTime` is unconditional with no threshold (`BatchReport.tsx:234-246`), asserted by `batch-report.test.tsx:179` (`expired|out of date|stale batch` must be absent). CONTEXT.md was amended to say `expired` is **not** implemented and belongs to send-mode. ✔
- **Queued “would have sent” per-person list** — `ranked` filters `status = 'withhold'`, so no send row can reach the payload; the hero shows the count only. ✔
- **Filter chips / pagination over the ledger** — no filter/page control in `BatchReport.tsx`; `rg 'chip|filter|page'` over `requests.css` returns only `.rq-chip--hold/bank/ghost` styling. ✔
- **Owner actions on decisions** — no approve/reject/override control anywhere. ✔
- **Production flag flip** — nothing in the diff touches infra or env values; the env-vars entry still records the staging flip as #544-owned. ✔
- **Backfilling pre-flip batches** — no backfill path; the ghost state is the answer. ✔
- **poolCount / candidate-window truncation in the UI** — absent. ✔
- **Judge / Governor over withholds** — absent. ✔

### `allowed_edit_surface`

Every one of the 32 changed paths falls inside the surface (with the branch’s recorded amendment widening `src/components/dashboard/shell/Sidebar.tsx` + its test to `src/components/dashboard/**`, and adding `.claude/CLAUDE.md`). `src/app/(authenticated)/__tests__/**` was allowed but unused — no violation.

---

## The specific correctness questions

### 1. Can the main read query return inconsistent numbers? **No.**

`readBuiltBatch` (`batch-view.ts:158-198`) is a single statement. `totals` and `ranked` both scan `solicitation_asks` under the same MVCC snapshot, so `held` and `Σ group_total` are computed from identical row visibility — the tear the plan feared (owner DELETE at `contacts-repo.ts` cascading through `solicitation_asks_contact_business_fk` between two statements) cannot occur. `evaluated = queued + held` is guaranteed by migration 088’s `solicitation_asks_status_reason_consistency`, which admits only `'send'` and `'withhold'`; the same CHECK guarantees `withheld_reason` is non-null and inside the six-code set for every row in `ranked`, so `PARTITION BY withheld_reason` can never produce a NULL bucket the zero-fill would then double-count.

The `::int` casts on all four counters are correct and necessary — `COUNT(*)` and `COUNT(*) OVER` return `bigint`, which postgres.js surfaces as a **string**, silently breaking the `number` contract on `queued`/`held`/`evaluated`/`total`.

**Zero-ask batch:** `totals` is an unfiltered aggregate, so it always produces exactly one row; the `LEFT JOIN ranked` therefore yields one all-NULL-payload row, `toGroups` skips it (`row.reason === null` guard, `:111`), and the caller gets `{state:'built', evaluated:0, queued:0, held:0, groups:[6 zero groups]}`. No empty-result special case is pushed to the caller. **Proven against a live DB**, not only mocks: `batch-view.integration.test.ts:175` reads three ask-less batches and gets `state: 'built'`.

Snapshot scope is also correct in a way worth recording: PostgreSQL takes the REPEATABLE READ snapshot at the **first snapshot-taking statement**, and `SET TRANSACTION` is not one — so Q1/Q2/Q3 genuinely share one snapshot. `SET TRANSACTION` is also correctly the first statement inside `sql.begin()`, which is a hard requirement (Postgres rejects it after any query in the transaction).

### 2. `reviewed_at` — does the client send `?scope=`? **Yes.**

`postReviewed` builds the URL with `withSolicitationScope(REVIEWED_PATH, scope)` (`RequestsClient.tsx:338`), and the test asserts the literal URL `'/api/dashboard/solicitation/batch/reviewed?scope=loc-1'` (`requests-client.test.tsx:313`) — so the round-trip through `SOLICITATION_SCOPE_PARAM` is pinned, and `resolveDashboardRequest`’s reader (`policy.ts:48`) reads the same key. The silent-zero-rows failure mode named in the brief is therefore **not live**. What is missing is a guard-rail if a future caller regresses — see finding 4.

Constraint interaction verified against real DDL: `GREATEST(NOW(), built_at)` plus the two WHERE guards satisfy `reviewed_at IS NULL OR (built_at IS NOT NULL AND reviewed_at >= built_at)` even when the worker host clock runs ahead of the database clock.

### 3. Polling — deadline before `inFlight`, abort on scope change, only while building? **All three hold.**

- Deadline check is at `RequestsClient.tsx:208`, `inFlight` guard at `:214`. Ordering is correct and, more importantly, **regression-tested by the exact scenario it protects**: a fetch that never resolves still reaches the ceiling and shows “Still processing”, with `fetchMock` called exactly once (`requests-client.test.tsx:278-289`).
- One `AbortController` per effect run, aborted in the cleanup (`:235-238`); a late response returns `null` from `fetchLatestBatch` and commits nothing (`:271`). Belt and braces: `phase` is also keyed by scope (`:187`), so a superseded phase reads as `loading` even if a commit slipped through. Tested end-to-end at `:246-276` (asserts `signal.aborted === true` and that `contactsOnFile: 9999` never renders).
- `stop()` fires for every non-`building` outcome (`:226`), so `no_batch`, `built`, `error`, `gone` and `auth` all end the loop. Confirmed by `requests-client.test.tsx:126` (empty screen does not show the building copy) and `:234-244` (a 401 stops after one call).

### 4. Six codes from `WITHHOLD_REASONS`, all six at zero? **Yes.**

Neither component re-types a code as a literal: `REASON_META` / `GATE_COPY` are `Record<WithholdReason, …>` (so the compiler rejects a missing or invented key) and both render `group.reason` / the `WITHHOLD_REASONS` element itself. Zero-count rendering is proven at both layers — read model (`batch-view.test.ts:170` asserts the emitted order equals `WITHHOLD_REASONS` exactly) and UI (`batch-report.test.tsx:225` asserts six “Nobody this batch” regions on an all-zero batch).

---

## Deviations — verified against the code (not re-litigated)

| # | Claim | Matches the code? |
|---|---|---|
| 1 | `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` implemented verbatim; proven on direct Postgres only | **Yes** — `batch-view.ts:237`; the integration test reads `current_setting('transaction_isolation')`/`transaction_read_only` back (`:277-293`), and the local-host guard (`:42-57`) genuinely refuses non-localhost URLs, so the stated limit is real. **The carried action (read isolation through the pooled staging URL before calling the purge race closed) is still open** and belongs in the ship lane. |
| 2 | A `batch_id`-leading index already exists, so no migration; `db_touching` stays false | **Yes** — migration 088 line ~159: `CONSTRAINT solicitation_asks_batch_contact_uniq UNIQUE (batch_id, contact_id)`. The test asserts a `(batch_id…` index still exists with an escalate-don’t-fix failure message (`:396-405`). No migration in the diff. |
| 3 | Q3 reshaped so `ci:tenant-scope` can see the predicates; still one statement | **Yes** — `ranked` selects ids + rank only; payload columns join back at `:181-196`; the tenant keys are re-asserted **outside** any subquery. Still one statement, so the consistency invariant is untouched. `ci:tenant-scope` passes with baseline 405 unchanged. The durable lesson (the audit strips `( SELECT …)`, so CTE bodies are invisible to it) is worth promoting to lab-notes. |
| 4 | GET log is unconditional-skip while building, not first-plus-on-change | **Yes** — `batch/route.ts:47-54`. The `hasBatch`/`askCount`/`sendCount`/`businessId` shape matches the intake’s observability contract exactly, and no review/contact/response text is logged. |
| 5 | The live-DB suite was actually run | **Yes** — the suite exists, is written against real DDL, and its assertions are semantic rather than shape-only. |

Orchestrator decisions also verified: **Task 6 (access-policy rename) was dropped** — `requireContactsLocationScope` / `requireContactsWriteAccess` are indeed now imported by the solicitation route family (`batch/route.ts:18`, `reviewed/route.ts:16-19`) under contacts-flavoured names. That is a naming debt, correctly filed rather than carried; it has no behavioural consequence.

---

## Low-confidence appendix (deliberately NOT in the findings table)

1. **`evidenceLine` can return `undefined` at runtime.** `parseEvidence` validates only the `decision` discriminant (`batch-view.ts:99-102`); if a stored envelope’s `evidence.reason` ever disagreed with the `withheld_reason` column, the exhaustive switch (`BatchReport.tsx:173-191`) would fall through and render a blank evidence line while the declared return type says `string`. Requires a `batch-builder` bug to trigger; noted for awareness only.
2. **A single malformed evidence row 500s the whole screen.** `parseEvidence` throws, `withDashboardOwnerRead` maps it to a 500, and the owner loses the entire report rather than one row. This is a deliberate, documented choice (CLAUDE.md allowlist entry says so explicitly) — recording it only because the blast radius is the whole surface.
3. **`AskRow.decidedAt` is dead payload.** Selected as `a.decided_at::text` (`batch-view.ts:185`) and carried through the API, but never rendered.
4. **Internal ids ship to the browser.** The full evidence envelope (`upload_id`, `review_id`, `prior_batch_id`, `ordering_basis.contact_id`) is serialised into the API response even though `BatchReport` correctly renders none of them. The intake forbids *rendering*, not transmitting, so this is not a violation — but the “no internal ids” guarantee lives only in the component, not in the payload.
5. **`reviewed_at` is behind a *writable* subscription gate.** GET uses `requireOwnerWithAccount`; POST uses `requireWritableOwner`, so a `past_due`-beyond-grace or `pending_payment` owner can read the report but never records `reviewed_at` (the ping 403s into `console.error`). Consistent with the sibling contacts mutation routes and defensible as mutation posture; noted because the intake makes `reviewed_at` the engagement signal.
6. **The funnel has three rungs, not two.** The intake describes “contacts on file → evaluated → queued” and plan rev 4 line 417 says `evaluated → queued`; the implementation renders `evaluated → held → queued` with contacts-on-file as a separate present-tense fact. The separation is explicitly justified in the plan (different denominator) and the extra `held` rung is an improvement, not drift.
7. **Flag-off 404s return JSON `{"error":"Not found"}`** where a genuinely non-existent App Router path returns HTML — a faint fingerprint that the route exists. Identical to the shipped contacts routes, so precedent-consistent.
8. **No redirect from the old `/dashboard/contacts`.** A bookmarked URL now 404s. No live doc or code reference remains (verified by grep across `src/`, `docs/`, `.claude/`; the only hits are historical #541/#544 plan records, which are append-only by design).
9. **`MobileTabBar` now carries five tabs.** Layout/ergonomics on narrow viewports is a standards/design question, not a spec one.

---

## Verdict

**PASS with 4 findings** (1 Medium, 3 Low). Every intake field is honoured: 13/13 behaviours (one partial — the header link), 9/9 invariants, 10/10 edge cases, 14/14 test titles present verbatim and substantively asserting their claims, 9/9 non-goals respected, and the entire diff inside the allowed edit surface. The two highest-risk mechanisms in this feature — snapshot-consistent funnel/ledger derivation and bounded polling with a deadline that survives a hung fetch — are both implemented correctly **and** regression-tested by the exact scenario that would break them.

One carried action from the triaged deviations remains open and is not a code finding: confirm `transaction_isolation` through the **pooled** staging URL before treating the offboarding-purge race as closed.
