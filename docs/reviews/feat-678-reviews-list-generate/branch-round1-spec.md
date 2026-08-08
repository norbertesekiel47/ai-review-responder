# Branch review round 1 — Spec & correctness (#678)

**Scope:** diff `13212b5588b96de2a5c8fcd0430cc95d70271e50..b0fed11171650aacd25d98ce986752a862b042bc`
(24 commits, 64 files). Read-only review. Axis: does the diff faithfully implement
`.feature/intake.json` and ticket #678?

**Verdict summary:** the contract is implemented. All 52 locked test titles exist
verbatim and (with the one exception below) assert what they claim; every
`user_visible_behavior` bullet is delivered; every named invariant traces clean;
0 of 64 changed files fall outside `allowed_edit_surface`; no `non_goal` creep.
Three low-severity findings, none blocking.

---

## Findings table (≥80% confidence)

| Severity | file:line | Finding |
|---|---|---|
| Low | `src/lib/past-replies/__tests__/reviews-list.test.ts:244`, `:392` | Both pagination titles "prove" the OFFSET with `expect(mainQuery(calls).values).toContain(PAGE_SIZE)`, which the `LIMIT ${PAGE_SIZE}` bind already satisfies on its own; nothing in the branch asserts `OFFSET = (page-1)*PAGE_SIZE`. The `consecutive Reviews-list pages are disjoint…` title feeds page 1 and page 2 two independently-authored fixtures, so its disjointness assertion cannot fail if the OFFSET were dropped entirely. |
| Low | `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:112-146` | The Generate door has no orphan (`recover`) guard. An orphan review — `post_after_delete_failed_*` failed sibling, no `posted` row, no non-terminal row, no in-flight outbox row — passes all four in-tx checks, so a same-origin POST enqueues a draft. Once the worker persists it, `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts:113` returns 409 `newer_draft_exists`, blocking the recovery path the intake edge case ("offering Generate would race the /retry and /restore-original recovery path") exists to protect. Delivered as a query/UI-layer rule only. |
| Low | `CONTEXT.md:31` | The rewritten **On-demand generation** glossary entry still cites `generate-draft.ts:106` for the `version > 1` regen-budget guard. The guard is at `worker/jobs/response-generation/generate-draft.ts:107`; deviation D5 explicitly ruled "cite 107; do not correct the code to match the doc". The sibling citation on the same line (`:109` for the Lua INCR) is correct. |

---

## Field-by-field intake walkthrough

### `user_visible_behavior` — 11/11 delivered

| # | Bullet | Evidence |
|---|---|---|
| 1 | Tab bar reads `Needs Action` / `All Reviews`, renders unconditionally | `ReviewsTabs.tsx:29-35` (literal `All Reviews`, no `historyEnabled` prop); `reviews/page.tsx:8` drops the flag read |
| 2 | Every review, grouped `Unanswered` then `Answered`, newest-first, 50/page | `load-replies.ts:194-300` (LEFT JOIN + `ORDER BY (resp.id IS NOT NULL), r.review_date DESC, r.id DESC`), `replies-view.ts:5` `PAGE_SIZE = 50`, `groupReplies` `:238-249` |
| 3 | Never-replied → `Generate`, expands inline with `Approve & post` | `PastReplyCard.tsx:267-282` → `InlineGeneratePanel.tsx:39-80` |
| 4 | Already-replied → `Regenerate` into `EditReplyDrawer`, `N of 3 today`, disabled at 3/3 | `PastReplyCard.tsx:404-425` (`disabled={exhausted}`, `{used} of {limit} today`); drawer opened by `PastRepliesClient.tsx:316` |
| 5 | Pending non-held draft → `Draft ready` cross-link, no `Generate` | `replies-view.ts:108` → `PastReplyCard.tsx:225-244` |
| 6 | Moderation-held → muted `Under review`, no Generate/text/cross-link | `PastReplyCard.tsx:246-265`; `approved_text` is NULL for a held row because it is sourced from the posted `resp` LEFT JOIN, so held text never crosses the wire |
| 7 | In-flight generation → `Generating…`, no button, survives refresh | `pending_gen` LATERAL `load-replies.ts:259-266` → `row_state='generating'` → `InlineGeneratePanel resumeGenerating` → `useInlineGenerate.ts:95-96` |
| 8 | Orphan sits in `Unanswered` with recovery card, no `Generate` | `deriveRowState` `:106`; `groupReplies` `:246` groups everything ≠ `regenerate` under Unanswered; `PastReplyCard.tsx:209-223` |
| 9 | Provenance badges on answered rows | `provenanceBadge` `:123-141`; copy map `PastReplyCard.tsx:75-80` matches the intake strings verbatim |
| 10 | Tiles Total / Unanswered / Answered / Avg rating over ALL reviews | `PastRepliesClient.tsx:160-172`; `AVG` query `load-replies.ts:333-337` has no `responses` join |
| 11 | 429 `rate_limited` / 429 `regen_limit_reached` | route `:54`, `:97` delegating to `dashboard-regen-rate-limit.ts:67`, `:110` |

Behaviour in the diff that no bullet names: the **`held` sixth row state** and its
`Under review` marker (owner-ratified deviation D9, `user_visible_behavior` bullet 6
was added for it — so it *is* named), and the drop of `historyEnabled` from
`ReviewsContent`/`reviews/page.tsx` (deviation D16(c) — mechanical consequence of
retiring the flag; brushes the "no change to Needs Action beyond the tab label"
non-goal but changes no Needs Action behaviour). Nothing else.

### `invariants` — 8/8 hold

1. **#3 no unapproved posting.** `persist.ts:86-90` requires
   `originLane === LIVE_INGEST_NEW`; `on_demand_generate` therefore takes the
   `structurallyBlockedDecision` branch (`persist.ts:202`), which returns
   `approved: false` unconditionally (`auto-approval.ts:306-307`) and throws if
   called for a real candidate (`:301-305`). `evaluateAutoApprovalCandidate`
   carries the same `bad_origin_lane` block at `auto-approval.ts:334` as
   defence in depth. Verified **through the real function**: the third title in
   `on-demand-lane.property.test.ts:155-210` calls `persistResponseAndNotify`
   with `AUTO_APPROVAL_ENABLED=true`, `version:1` and **`suppressNotification:false`**
   (deliberately isolating the lane as the only guard) and asserts no
   approve-UPDATE, no `PUBLISH_RESPONSE`/`PENDING_POST_NOTICE` enqueue, no
   `approval_audit_log` insert, no `businesses … FOR UPDATE`. No second guard was
   added anywhere (ticket #678's explicit instruction).
2. **#2 transactional outbox.** `generate/route.ts:158` calls the typed helper
   `enqueueGenerateResponse(tx, …)` inside the route's own `sql.begin` (`:101`).
   No raw `INSERT INTO job_outbox`, no post-commit enqueue. The in-flight status
   set is re-spelled byte-for-byte in both new SQL sites
   (`generate/route.ts:141`, `load-replies.ts:264`); `ci:outbox-status` and
   `ci:outbox-seam` are green in the gate.
3. **#8 tenant scope.** Both new routes run the same ownership proof
   (`reviews ⋈ businesses` on `b.account_id` + `b.archived_at IS NULL`) as the
   first DB statement (`generate/route.ts:61-76`, `draft-status/route.ts:38-49`)
   and 404 `review_not_found` without touching draft text. The generate tx then
   re-locks `reviews … AND business_id = ${businessId} FOR UPDATE`. The
   draft-status draft read additionally binds `resp.business_id`. All four list
   queries bind `r.business_id = ${locationId}`; the `resp` LEFT JOIN and the four
   LATERALs reach `responses` only through `review_id = r.id`, which is already
   scoped. D13/D14 allowlist bookkeeping landed (`ALLOWLIST_BASELINE = 412`,
   3 new `load-replies.ts` entries + 3 new `generate/route.ts` entries);
   `ci:tenant-scope` PASS in the gate.
4. **#13 server-authoritative flags.** No `NEXT_PUBLIC_*` companion added;
   `editRepliesEnabled()` is read server-side in `history/page.tsx:62` and passed
   as a prop. `ci:static-policy` PASS.
5. **#15 explicit DB client.** `load-replies.ts:86` keeps `sql: Sql`; the module
   does not import `@/lib/db/server`. Composition roots are `history/page.tsx`
   and the two new route handlers. `ci:db-imports` PASS.
6. **#1 Vercel = UI only.** No `openai`/`bullmq`/`postgres` runtime import enters
   `src/app/**`; the only new external call in the render path is
   `peekRegenBudgetBatch` (Upstash `mget`). `lint` (which runs
   `eslint-boundaries.test.ts`) PASS.
7. **Regenerate publish stays behind `EDIT_REPLIES_ENABLED`.** `AnsweredControls`
   returns `null` when `!editRepliesEnabled` (`PastReplyCard.tsx:381`), and the
   seven `past-replies/*` routes still gate on `editRepliesEnabled()` — which is
   now the raw `EDIT_REPLIES_ENABLED` read. Generate's publish path (`/approve`,
   `/edit`) is ungated, as specified.
8. **Fail-open.** `peekRegenBudgetBatch` swallows its own `mget` rejection and
   returns an empty `Map` (`tracker.ts` catch), the caller carries a second catch
   for a synchronous `getCacheRedis()` throw (`load-replies.ts:360-372`), and the
   card treats a missing entry as UNKNOWN (`regenBudget?` optional,
   `PastReplyCard.tsx:404,419`). Both directions pinned by tests.

### `edge_cases` — 12/12 handled

| Edge case | Handled at | Test-covered? |
|---|---|---|
| Non-terminal response groups Unanswered but renders `Draft ready`, never `Generate` | `replies-view.ts:108` | YES (`reviews-list.test.ts:247`, `past-reply-card-states.test.tsx:126`) |
| In-flight outbox row → `Generating…` | `load-replies.ts:259-266` | YES (`reviews-list.test.ts:262`) |
| Discard retains the row at `superseded`, next Generate is v2 and charged | `generate/route.ts:151-155` | YES — **live Postgres**, through the real discard route (`generate-version.integration.test.ts:229`) |
| 3/3 counter refuses a first Generate | `generate/route.ts:97` | YES (`route.test.ts:346`) |
| Ingested reply dated after activation → `Replied on Google` | `provenanceBadge:131-136` | YES (`reviews-list.test.ts:489`) |
| Orphans never offered Generate | `deriveRowState:106` + card | YES at the query/UI layer; **NOT** at the route (finding 2) |
| Both COUNTs and the orphan query move with the JOIN | `load-replies.ts:308-329`, orphan query deleted | YES (`reviews-list.test.ts:296` asserts exactly 4 data queries) |
| `totalPages` from all reviews | `load-replies.ts:386` | YES (`reviews-list.test.ts:230`, integration `:171`) |
| Stale budget peek across UTC midnight | inherent; refresh corrects | inspection only (accepted by design) |
| Redis down → empty map, buttons enabled | `tracker.ts` catch | YES (`regen-budget-batch.test.ts:116`, `past-reply-card-states.test.tsx:114`) |
| Cross-account Generate 404s without leaking | `generate/route.ts:61-76` | YES (`route.test.ts:252`; also `draft-status` `:151` asserts zero read-pool calls) |
| Archived location not generatable | `AND b.archived_at IS NULL` | YES (`route.test.ts:264` asserts the predicate is inside the ownership proof) |

### `tests_to_add` — 52/52 present verbatim, 51/52 assert their claim

Programmatic check over `src/**`, `worker/**`, `e2e/**`, `scripts/**`: **0 missing**.
All eight new/changed suites run green locally (82 tests), and the two live-DB
integration rows are PASS in `.feature/gate-status.json`.

I read every title's body. Notes on the ones worth calling out:

- **Genuinely strong:** the `persistResponseAndNotify …` title (real function, not
  the mirrored predicate), `discarding a v1 Generate draft …` (real transaction,
  real discard route, asserts *retention* — the fact the whole cost policy rests
  on), `GET draft-status never returns response_text or ready for a
  moderation-held response` (asserts `idle`, absence of the property, absence of
  the literal text, and that the hold came from `flagged_responses`), and
  `an orphan row keeps its failed_response_id and superseded text after the
  single-query merge` (pins all six fields the deleted `toOrphanCardRow` carried,
  which is what makes round-2 Defect A unrepeatable).
- **Weaker than its title:** `consecutive Reviews-list pages are disjoint …`
  (finding 1). It does assert intra-page uniqueness, the ≤PAGE_SIZE cap, and that
  orphans are inside the window — but the *disjointness* claim is a property of
  the two fixtures, not of the code.
- **Wording drift, not weakness:** `PastReplyCard renders Regenerate with the
  remaining regeneration count…` asserts the rendered string is `1 of 3 today`,
  i.e. the **used** count. That matches the intake's own copy spec
  (`user_visible_behavior`: "`N of 3 today`") and the D16(a)-repaired counts, so
  the implementation is right and only the title's word "remaining" is loose.
- **D16(a) repair audited:** the three `getByText` → `getAllByText(...)
  .toHaveLength(2)` conversions in `past-reply-card-states.test.tsx:183-185` are
  strictly stronger than the originals (which threw
  `getMultipleElementsFoundError` and asserted nothing), and the anchors
  `/^unanswered$/i` / `/^answered$/i` prevent the substring collision. Title
  unchanged. Legitimate.

### `allowed_edit_surface` — clean

64 changed files, **0 outside** the (twice-widened) surface, and every declared
pattern is used. The two widenings are the owner-ruled bookkeeping entries D13
(`scripts/ci/tenant-scope-allowlist.ts`) and D17 (the five live docs); the
amendment budget stands at 1 of 2. `ci:feature-surface` PASS. The two intake
copies (`.feature/intake.json` and
`docs/superpowers/plans/feat-678-reviews-list-generate-intake.json`) are
byte-identical.

D17's deliberate carve-out holds: `worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts`
still sets/restores `PAST_REPLIES_VIEW_ENABLED` in three places
(`:46`, `:78`, `:329-332`) and still carries the "Edit routes require BOTH flags"
comment (`:75`). Behaviour-neutral (the suite also sets `EDIT_REPLIES_ENABLED=true`,
which is now the whole predicate), and the file is out of surface. Folded to #680
as documented.

All five D17 docs were actually rewritten — verified by reading the diff, not the
deviations prose: `deployment-guide.md:155`, `gbp-api-application.md:66-69`,
`edit-existing-replies-testing-runbook.md:18-24`, `eservices-variables.md:120-122`,
`adr/0015:49-59` (a dated superseding note, Context §11 left as historical record).

### `non_goals` — no creep

| Non-goal | Status |
|---|---|
| New page/route for the list | No new page; `reviews/history` widened in place. The two new **API** routes are required by `tests_to_add` and `user_visible_behavior`, so they are the contract, not creep |
| No Needs Action change beyond the tab label | `ReviewsContent`/`reviews/page.tsx` lose the `historyEnabled` prop only — no behavioural change (D16(c)) |
| No second auto-approval guard | Confirmed: only the existing `persist.ts:86-90` predicate; the branch adds one enum member |
| No change to `generate-draft.ts`'s `version > 1` guard | File not in the diff |
| No change to `BURST_MAX` / `HOUR_MAX` | `dashboard-regen-rate-limit.ts` not in the diff |
| No publish-transport change | `ResponsePublisherWorker.ts` diff is the flag-import rename only |
| Generate publish not routed through `past-replies/publish` | `useInlineGenerate.ts:189-200` POSTs `/approve` and `/edit` |
| No `DAILY_COST_LIMIT_CENTS_*` change | `.env.example` diff touches only the two flag comments |
| No rating band inside Unanswered | `groupReplies` sorts by date only |
| `EDIT_REPLIES_ENABLED` not retired | Kept; now the sole reader in `flags.ts` |

---

## Verified clean (so round 2 need not re-cover)

- **F3 single-query merge.** Diffed the deleted orphan query
  (`13212b5:load-replies.ts:163-206`) against the new LATERALs. The old predicate
  `JOIN LATERAL(post_after_delete_failed_* failed) … AND NOT EXISTS(posted)` is
  exactly `(orphan_sidecar.id IS NOT NULL AND resp.id IS NULL)` (`:190`); the
  superseded LATERAL is character-for-character the old one. `toCardRow:186-212`
  carries the full `toOrphanCardRow` mapping — `failed_response_id`,
  `response_id ← orphan_failed_response_id`, `failed_posting_error`,
  `approved_text ← superseded_text`, and `posted_at`/`approval_method`/`version`
  nulled. An orphan therefore appears exactly once, as `recover`, with the two
  fields `PastReplyCard.tsx:309` and `:437` need to offer recovery at all.
- **Row uniqueness under the LEFT JOIN.** `responses_one_posted_per_review`
  (migration `031_edit_existing_replies.sql:41-43`, partial unique on
  `review_id WHERE status='posted'`) guarantees the `resp` join cannot fan out;
  all four LATERALs are `LIMIT 1`. So exactly one row per review per page, and
  the page slice agrees with the `EXISTS`/`NOT EXISTS` denominators.
- **Grouping predicate agrees with the SQL sort key.** `row_state === 'regenerate'`
  ⟺ `response_id !== null` (because `is_orphan` implies `resp.id IS NULL`), which
  is the same boolean the `ORDER BY` leads with — so the JS split cannot
  re-order across the page boundary. `Array.sort` stability preserves the
  `r.id DESC` tiebreak inside equal dates.
- **Invariant #4, all three surfaces.** The inline `EXISTS (SELECT 1 FROM
  flagged_responses f WHERE f.response_id = … AND f.status = 'open')` at
  `load-replies.ts:237-242` and `draft-status/route.ts:69-71` is semantically
  identical to `hasOpenFlag` (`src/lib/moderation/held-draft.ts:35-41`) — same
  table, same two predicates, same existence semantics; only the client type and
  the `::uuid` cast differ. D6's justification (in-tx `TransactionSql` signature,
  un-composable into a LATERAL or an `sqlRead`) checks out. `deriveRowState:108`
  branches `held` on the *same* test as `draft_ready`, so a held draft can never
  reach `generate`. The `held` card renders no text and no affordance; held draft
  text never crosses the wire at all (it lives on the non-terminal row, and
  `approved_text` is sourced from the posted `resp` join). The poller returns
  `{status:'idle'}` and the client stops polling (`useInlineGenerate.ts:143-147`).
- **`Generate` cannot double-spend on a held draft.** A held draft is
  `pending_approval` ∈ `NON_TERMINAL_STATUSES`, so `generate/route.ts:123-135`
  409s `draft_already_exists`.
- **Origin-lane blast radius.** Every branch site on `origin_lane` in `src/` and
  `worker/` is a `=== LIVE_INGEST_NEW` test (`persist.ts:88`, `:478`,
  `auto-approval.ts:297`, `:334`); `KNOWN_ORIGIN_LANES`
  (`job-outbox-helpers.ts:32`) is derived from `GENERATE_RESPONSE_ORIGIN_LANES`,
  so the new member is accepted on the way in and tolerated as `null` by a
  reverted worker (matching the stated rollback plan).
- **`editRepliesEnabled()` semantic change against its callers.** The three
  worker call sites (`process-review.ts:293`, `ResponsePublisherWorker.ts:198`,
  `failed-hook.ts:81`) previously called the *raw* read, so their predicate is
  unchanged. The three `past-replies` routes previously called the composite, so
  their gate loosens from `VIEW && EDIT` to `EDIT` — which is exactly S4's
  intent, and `flags.test.ts:67-88` pins that exactly one function is exported.
- **`runDashboardReviewAction` is account-scoped, not cookie-scoped**
  (`http-routes.ts:166-177`), so the Generate→`/approve` publish path works for a
  review in a sibling location — consistent with the deliberate cross-location
  resume the `draft-status` route ships.
- **Docs.** All five new production files are in `docs/directory.md`
  (`InlineGeneratePanel`, `useInlineGenerate`, both routes, the history page
  entry). No new top-level directory; `_styles/past-replies.css` is a
  modification, not an addition. CONTEXT.md's **Reviews list** / **On-demand
  generation** entries match the built behaviour term-for-term (`ReviewRowState`
  precedence, `ProvenanceBadge` values, the `held` state, the two door routes);
  no code renames a glossary concept.

---

## Low-confidence appendix (NOT findings)

- **`toCardRow` no longer nulls `external_reply_ingested_at` for orphan rows**
  (the deleted `toOrphanCardRow` did). Traced every consumer: `Provenance`
  short-circuits on `isOrphanRecovery` before reading it
  (`PastReplyCard.tsx:309-319`), `EditReplyDrawer` and `useEditReplyDraft` never
  read it, and `provenance_badge` is computed but never rendered for a `recover`
  row. No observable consequence today; it is a latent difference a future
  refactor could surface.
- **`deriveRowState`'s parameter type declares `failed_response_id` but the body
  never reads it** (`replies-view.ts:98-111`). Harmless; flagged only because a
  reader may assume the delete-failed sidecar participates in precedence.
- **`draft-status` returns `{status:'ready', response_text}` for any
  `NON_TERMINAL` status, not just `pending_approval`.** Unreachable in practice
  (the panel only mounts for `generate`/`generating`), and an `approved` row is
  still the owner's own draft, so no invariant bends.
- **A live-ingest generation in flight also renders `Generating…`** — `pending_gen`
  matches any `generate_response` outbox row for the review, not only
  `on_demand_generate` ones. Honest and arguably correct; noted because the state
  name suggests owner initiation.
- **`EXTERNAL_REPLY_IMPORT_ENABLED=false` + live-lane ingest of an
  externally-answered review** would surface that review as Unanswered with a
  `Generate` button. Checked and dismissed: the consented Review import lane
  imports answered rows **unconditionally**
  (`zernio-ingest-shared.ts:201-203,243`), so the import destination is unaffected;
  the residual is the pre-existing live-lane posture that already feeds Needs
  Action, not something #678 introduces.
- **`pnpm test:integration` still hard-gates only the publisher suite**, so the
  two new `*.integration.test.ts` files run only via the `/feature` verify gate or
  a whole-repo `pnpm test` with the DB awake — the CLAUDE.md "existing-but-not-run
  suite" hazard. Both rows are PASS in `.feature/gate-status.json`, so this is a
  standing repo-level process observation, not a branch defect.
