# Branch review round 1 — Standards & maintainability (#678)

**Scope:** `feat-678-reviews-list-generate` diff since `13212b5588b96de2a5c8fcd0430cc95d70271e50`
(24 commits, 64 files, ~7,000 insertions).
**Method:** `thermo-nuclear-code-quality-review` skill against the branch diff, with the
`codebase-design` deep-module vocabulary applied per seam. Read-only on code.
**Lane:** repo standards (`.claude/CLAUDE.md`), deep-module discipline, Fowler smells,
`CONTEXT.md` glossary, anti-slop. Spec-correctness and approach-design are sibling agents'.

Everything below was read in full before it was cited. The gate is green at this HEAD;
nothing here is a lint/typecheck finding.

---

## Findings (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | Medium | `src/lib/past-replies/load-replies.ts:359-372` | The `try/catch` around `peekRegenBudgetBatch` is **unreachable dead code**. `tracker.ts:411` calls `getCacheRedis()` *inside* its own `try`, so the "synchronous `getCacheRedis()` throw before the MGET is even issued" that this catch documents (`:352-356`) is already caught there; `reviewIds.map(regenBudgetKey)` cannot throw, so the function has no rejection path at all. The false rationale is recorded twice — here and at `tracker.ts:398-400` (D10). |
| 2 | Medium | `src/components/dashboard/reviews/PastReplyCard.tsx:308-359` | The `isImported` prop and its rendering branch are **dead** once `provenance_badge` is server-derived. `provenanceBadge()` (`replies-view.ts:131-137`) returns a non-null badge for **every** row with `external_reply_ingested_at !== null`, so the fallback at `:343` is reachable only when `isImported === false` and `approval_method` is neither `auto_policy` nor `owner`. The `Imported` arm (`:346-349`) and `<AutoApprovedBadge>` (`:356`) can therefore never render. `isImported` is threaded through `:54, :127, :140, :183, :198, :214` and computed a third time at `:332`/`:335`, plus once more at the call site (`PastRepliesClient.tsx:312`). This is the superseded path kept alongside its replacement — i.e. the compatibility shim the comment at `:321-325` asserts it is not. |
| 3 | Medium | `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:87-93` | The writable-subscription / offboarding gate is checked **only before** `sql.begin` and never re-asserted inside the locked tx. The three sibling doors in the same directory (`approve`, `edit`, `regenerate`) get an in-tx re-assert from the canonical `runDashboardReviewAction` (`src/lib/approval/http-routes.ts:220-223`), whose comment states the reason verbatim: *"the pre-tx check above can go stale if an offboarding is confirmed between it and this commit. Token + callback approval paths re-check the same way."* Failure scenario: an offboarding confirmed inside the window commits a chargeable `generate_response` outbox row for a blocked account. |
| 4 | Medium | `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:100-176` | 76 lines of transaction business logic (lock, three 409 guards, `MAX(version)`, enqueue, logging) inline in a route handler. Named standard: CLAUDE.md working rules — *"Route handlers, server actions, and worker boot files orchestrate only: parse input, call one module function, return output — no business logic"* — and invariant #12. The three sibling routes in the SAME directory delegate: `regenerate/route.ts` is **47 lines** end to end (`:34-43` is the whole body) via `runDashboardReviewAction` + `regenerateBySession`. Cost already paid: 3 extra `ci:tenant-scope` allowlist entries (D14, `tenant-scope-allowlist.ts:1299-1320`) that the siblings do not need because their scope proof is visible in one query. The judo move is a `runDashboardReviewGenerate` seam in `http-routes.ts` + `generateFirstDraftBySession` in `approval/service.ts`, matching the three neighbours exactly — `runDashboardReviewAction` cannot be reused as-is because its `responses` lookup 404s on a never-replied review, which is a reason to deepen that module, not to bypass it. |
| 5 | Medium | `src/components/dashboard/reviews/PastReplyCard.tsx:309` ↔ `src/lib/past-replies/replies-view.ts:106` | The card **re-derives orphan-ness** (`!!row.failed_response_id && row.posted_at === null`) instead of reading the server-derived `row_state === 'recover'` it already has. This contradicts the branch's own stated rule in two places — `PastReplyCard.tsx:33-37` ("DERIVED SERVER-SIDE … the card renders it, it never computes one (D-D)") and `:173-179` ("six states, no derivation"). The two predicates agree today only because every `'posted'` write also sets `posted_at` (`worker/jobs/publisher/mark-posted.ts:106`, `worker/jobs/zernio/zernio-ingest-shared.ts:498`); `responses.posted_at` is NULLable in the schema (`001_initial_schema.sql:220`) and nothing enforces the coupling. |
| 6 | Low-Med | `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:61-69` ↔ `.../draft-status/route.ts:38-46` | The tenant-ownership proof (`reviews ⋈ businesses … AND b.account_id = … AND b.archived_at IS NULL`) is duplicated verbatim across the two new routes — the second file's comment even says *"identical shape to the generate door"*. A tenant-scope proof is the one kind of duplication that must not be allowed to drift; it belongs in one exported helper (the `requireDashboardReviewOwner` module is its natural home). |
| 7 | Low-Med | `src/lib/past-replies/replies-view.ts:173-213` | `toCardRow` merges two row shapes behind **seven** `isOrphan ? … : …` ternaries (`:184, :192, :193, :195, :198, :201, :202`) in a 27-line function. `rowState` is already computed at `:178`, so dispatching to two small mappers deletes every ternary. This is a net loss against the pre-#678 code, which had a dedicated `toOrphanCardRow` (see D15/D8) — the row source merged, but the *mapping* did not have to. |
| 8 | Low-Med | `src/lib/past-replies/load-replies.ts:308-337` | Three separate `FROM reviews WHERE r.business_id = $1` queries (two `COUNT`s + one `AVG`) run in `Promise.all`, i.e. on three pooled connections and therefore three independent READ COMMITTED snapshots. A publish committing between them makes `unansweredTotal + answeredTotal` inconsistent, so `totalPages` (`:386`) can be off by one — an empty trailing page, or a row on the last page unreachable — and a section header can read "N of M" with N > M, the exact class the deleted orphan reconciliation used to guard (`PastRepliesClient.tsx:72-75`). One `COUNT(*) FILTER (WHERE …)` + `AVG` query removes the skew, one table scan instead of three, and one allowlist entry instead of two. Blocked today by the eval's `expect(dataQueries).toHaveLength(4)` (`reviews-list.test.ts:305`) — file it with the Q3 item below. |
| 9 | Low | `src/lib/past-replies/replies-view.ts:100` | `deriveRowState`'s parameter shape requires `failed_response_id`, and the body (`:106-110`) never reads it. A required-but-unused field in a contract every caller and every test fixture must satisfy. |
| 10 | Low | `src/lib/costs/tracker.ts:370-377` vs `:402-432` | `peekRegenBudget` and `peekRegenBudgetBatch` duplicate the `used / limit / remaining` derivation **and carry opposite failure contracts** — the single-key peek throws (its caller catches, `dashboard-regen-rate-limit.ts:95-104`), the batch swallows. Every caller must know which one it is holding. This is the **widening** the module was meant to avoid: the deepening move is one contract, `peekRegenBudget(id)` delegating to `peekRegenBudgets(ids)`. |
| 11 | Low | `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:104` | The outbox in-flight set is spelled as three hand-written TS string comparisons rather than the canonical `OUTBOX_IN_FLIGHT_STATUSES` (`src/lib/shared/job-outbox-status.ts:34`). Invariant #2's byte-for-byte exemption is explicitly about **SQL literals** inside `ON CONFLICT … WHERE` predicates (see that module's header, `:8-20`) — it does not cover a TS comparison, and `src/lib/reviews/import-offer-view.ts:160` is the canonical TS usage. (Copies a pre-existing spelling at `past-replies/draft-status/route.ts:96-98`, so this is propagation of local debt, not invention.) |
| 12 | Low | `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:38-46` | The tenant proof runs on the **write** pool `sql` while the two body reads correctly use `sqlRead`, on the branch's hottest endpoint (polled every 1.5 s per expanded row — `useInlineGenerate.ts:44`). The precedent it inherits (`past-replies/draft-status/route.ts:63-65`) justifies write-pool only for the *shared* `resolveOwnerScope` helper ("shared helper, not threaded onto sqlRead"); this is an inline query with no such constraint. |
| 13 | Low | `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:109,120,132,145,175,179` | `NO_STORE_HEADERS` is attached to 2 of 8 responses here (`:74`, `:91` only), while the sibling `draft-status/route.ts` attaches it to 7 of 8 (missing on the 500 at `:118`). No rule distinguishes the two sets, so a reader cannot tell which omissions are deliberate. |
| 14 | Low | `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:16-19` | The header asserts the origin lane is *"the ONLY thing excluding it from `isAutoApprovalCandidate`"*, but `worker/jobs/response-generation/persist.ts:88-91` also requires `!suppressNotification`, and this route sets `suppressNotification: true` (`:164`). Two structural exclusions, not one — a comment that invites a future reader to delete the wrong guard, in the file that carries invariant #3's "do not add a second guard here" instruction. |
| 15 | Low | `src/lib/past-replies/replies-view.ts:166` | New doc comment cites `PastReplyCard.tsx:157` and `:201`; the actual sites are `:309` (`isOrphanRecovery`) and `:383`/`:437` (the `failed_response_id` gates). Both citations went stale when T7 grew the file after T5 wrote the comment — the same fabricated/stale-citation class D3 names as a controlled failure mode. |
| 16 | Low | `src/app/(authenticated)/dashboard/reviews/history/PastRepliesClient.tsx:194` | Glossary: `aria-label="Search past replies"` keeps a **banned alias** ("Past Replies") in assistive-technology copy on the surface this branch renamed to *All Reviews* / **Reviews list** (`CONTEXT.md:30` — *Avoid*: Past Replies, the archive, History tab). Every other visible label in this file was updated in the same commit (`Total replies` → `Total reviews`, section titles, empty copy), so this is an omission rather than a decision. |

---

## Verdicts on the four referred questions

### Q1 — `PastReplyRow.row_state: string` + the single cast (D16(b))

**Verdict: the eval's `ListRow` should have been retyped to `ReviewRowState`. The cast is
defensible as shipped, but it is the weaker of the two options and should be reversed in #680.**

The TS2430 mechanism is real: `past-reply-card-states.test.tsx:30-33` declares
`interface ListRow extends PastReplyRow { row_state: string; provenance_badge?: string | null }`,
and an interface cannot widen an inherited member. So the two options are exactly as stated.

What tips it:

1. **`ListRow` is neither a locked title nor an assertion.** It is a fixture-typing
   helper. D16(a) already established — and the orchestrator ratified — that eval
   *scaffolding* may be repaired when it makes a title unsatisfiable, and that "the
   locked-title check still reports 0 missing of 52" is the test that matters. Retyping
   `ListRow` clears the same bar for strictly less cost than weakening a production type.
2. **The widening cost two casts and a defensive arm, not one.** `PastReplyCard.tsx:190`
   (`row.row_state as ReviewRowState`) is the documented one; `:84`
   (`PROVENANCE_LABEL[badge as ProvenanceBadge] ?? null`) is the undocumented second, and
   its `?? null` exists purely to absorb an unknown-string badge that `ProvenanceBadge`
   structurally excludes. `provenance_badge?: string | null` also became *optional* on the
   exported wire type, which is what makes finding #2's dead fallback path typecheck.
3. **The `never` guard is narrower than the deviations note claims.** `const unreachable:
   never = state` (`:286`) catches an **added** union member — that part is preserved and
   is genuinely good. It does not catch a caller passing `row_state: 'oops'`, which at
   runtime reaches `default` and `return unreachable` renders the raw string into the
   card. Under `row_state: ReviewRowState` that class is impossible from typed callers.

The mitigation is real (server-side `ReviewsListRow` keeps the strong type, the cast is
one line at the wire boundary with a comment), so this is not a blocker. It is a #680
item: retype `ListRow`, delete both casts and the `?? null` arm.

### Q2 — Three spellings of "the draft is held" (D6)

**Verdict: the deferral is sound and the three spellings are semantically identical.
One caveat, and it is bigger than the thing being deferred.**

Semantics compared side by side:

- `hasOpenFlag` — `SELECT 1 FROM flagged_responses WHERE response_id = $1::uuid AND status = 'open' LIMIT 1`, `rows.length > 0` (`src/lib/moderation/held-draft.ts:34-42`).
- List LATERAL — `EXISTS (SELECT 1 FROM flagged_responses f WHERE f.response_id = resp2.id AND f.status = 'open')` (`load-replies.ts:237-242`).
- Poller — the same `EXISTS`, keyed on `resp.id` (`draft-status/route.ts:68-71`).

Identical predicate. The `::uuid` cast is a no-op against a `uuid` column, and
`EXISTS`/`LIMIT 1` are the same question. The only difference is lock context — `hasOpenFlag`
is an in-tx post-`FOR UPDATE` release gate, the two new ones are unlocked reads — and that
difference is **correct**, not accidental: a read path must not take a row lock, and D6's
refusal to wrap a poll endpoint in `sql.begin` for a boolean is right.

The count is also right. `rg` over non-test, non-script sources returns only three
`flagged_responses … status = 'open'` predicate sites plus two admin/health `COUNT(*)`
aggregates (`src/lib/admin/flagged-service.ts:84`, `src/lib/admin/nav-counts-service.ts:20`,
`worker/background/pollers/health-alert/checks.ts:138`), which answer a different question
and should not join the consolidation.

Deferral cost is one `flagged_responses.status` vocabulary change touching three sites
instead of one — low, bounded, and #680 is filed. Accept.

**The caveat #680 should carry with it:** the pre-existing sibling poller
`src/app/api/dashboard/past-replies/draft-status/route.ts:103-135` returns `response_text`
for any `pending_approval` draft with **no held check at all**. So after this branch there
are two draft-status routes with divergent invariant-#4 display semantics, and the older,
laxer one is the one that has been in production. It is not a release path (the release
paths do gate through `hasOpenFlag` inside `runDashboardReviewAction`), so this is text
disclosure rather than an unapproved post — but it is a larger item than the three
spellings and belongs in the same ticket.

### Q3 — `statusArraySql` used at the routes, inlined in `load-replies.ts`

**Verdict: yes, production shape is being dictated by a test double — and no, it does not
matter here. Fix the assertion, not the query.**

The mechanism is confirmed. `reviews-list.test.ts:96-107` builds `fakeSql` as a plain
tagged-template function that pushes every invocation onto `calls`; `:305` asserts
`expect(dataQueries).toHaveLength(4)`. `statusArraySql(db, …)` issues its own `db\`…\``
(`response-status-sql.ts:19`), which would register a fifth call **and** interpolate a
`Promise` rather than a fragment into the outer template. So the helper genuinely cannot be
used under that double.

Why it is nonetheless harmless:

- The inline form is **byte-identical** to what the helper emits — `statusArraySql`'s own
  docstring says it "Reproduces the codebase's existing `${[...GROUP] as string[]}::text[]`
  array-binding convention exactly" (`:5-8`).
- It is an established production convention with two pre-existing sites outside this
  branch: `worker/jobs/live-draft-guard.ts:34` and
  `worker/background/pollers/ZernioRecentReviewPoller.ts:225`.
- `ci:response-status` only flags **hardcoded** status literals; a spread of an imported
  group is explicitly not descended into (`scripts/ci/response-status-audit.ts:99-104`), so
  both spellings pass the audit that owns this rule.

What *does* matter is that the assertion is a **call count on a template-tag double**, which
couples the query's internal composition to a test for a non-behavioural reason. The next
person who wants a shared SQL fragment in that query — the #680 held-predicate consolidation
from Q2 is exactly that person — hits the same wall and will reach the same "don't use the
helper" conclusion. The file already has the right idiom one screen earlier: `mainQuery()`
at `:169` filters on `/AS\s+review_id/` and asserts `toHaveLength(1)` — a *row-producing
query* count, which is what the title actually means. Re-express `:305` the same way and
finding #8's single-query collapse also unblocks.

### Q4 — `peekRegenBudgetBatch` catches internally AND its caller catches (D10)

**Verdict: neither defence in depth nor a swallowed error — the caller's catch is
unreachable, and its documented justification is factually wrong.**

`peekRegenBudgetBatch` invokes `getCacheRedis()` **inside** its own `try`
(`tracker.ts:411`: `raw = await getCacheRedis().mget(...keys)`), so the one case the caller
claims to cover — "a synchronous `getCacheRedis()` throw before the MGET is even issued"
(`load-replies.ts:352-356`) — is already caught there. (`getCacheRedis()` *can* throw
synchronously: `getCacheRedisOptions` does `new URL(process.env.REDIS_CACHE_URL!)` at
`redis-cache.ts:8`. It just cannot escape.) The only other statement outside the try is
`reviewIds.map(regenBudgetKey)`, which cannot throw. The function therefore has **no
rejection path**, and `load-replies.ts:359-372` is 13 lines of dead code — finding #1.

It is not a *silent* catch: both sites log `regen_budget_peek_failed` on the shared stream,
so the repo's "no silent catches" rule is satisfied and the fail-open direction (empty map →
no counter → Regenerate stays enabled) is correct and well argued.

Two ways to resolve, both fine, pick one owner:
- delete the caller catch (`load-replies.ts:359-372`) and the false rationale in both files; or
- hoist `const redis = getCacheRedis()` above the try in `tracker.ts` so the caller's catch
  becomes live — which then also fixes the contract asymmetry in finding #10, since
  `peekRegenBudget` already behaves that way.

The deeper issue D10 surfaced but did not name: the module now exports **two peeks with
opposite failure contracts**. That is the widening; one contract is the deepening.

---

## Verified clean

- **No `any`, no `@ts-ignore`, no `eslint-disable`** anywhere in the added TS/TSX
  (`git diff | grep -E '^\+.*(as any|: any|@ts-ignore|eslint-disable)'` → empty).
- **Invariant #15** holds: `load-replies.ts:85` takes `sql: Sql` explicitly and imports no
  DB singleton; `replies-view.ts` is pure. The composition roots
  (`history/page.tsx:29-35`, the two route handlers) pass it down.
- **Invariant #1** holds: `PastReplyCard.tsx:10` and `PastRepliesClient.tsx:9` import
  `RegenBudgetStatus` from `@/lib/costs/tracker` as **`import type`** (erased), so no
  runtime `ioredis` reaches the client bundle.
- **Invariant #2** holds at the enqueue: `generate/route.ts:158` writes the outbox row via
  the typed helper `enqueueGenerateResponse` inside the same `sql.begin` that took the
  review lock. The two SQL in-flight-set spellings (`route.ts:141`, `load-replies.ts:264`)
  are the sanctioned byte-for-byte re-spelling.
- **Invariant #3** holds structurally: `GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE`
  is a new lane value only, and `persist.ts:88-91` already requires `LIVE_INGEST_NEW`; no
  second guard was added, per the ticket. (See finding #14 for the comment inaccuracy.)
- **Invariant #4** holds on both new surfaces: `draft-status/route.ts:79-84` returns `idle`
  and never the held text; `deriveRowState` (`replies-view.ts:108`) tests `held` on the
  same branch as `draft_ready` so a held draft cannot reach `generate`.
- **Invariant #13** holds: `PAST_REPLIES_VIEW_ENABLED` retired with no `NEXT_PUBLIC_*`
  companion introduced; `editRepliesEnabled()` remains a server-only read passed as a prop
  (`history/page.tsx:62`).
- **Lock ordering** respected: the Generate tx takes `reviews … FOR UPDATE` first
  (`route.ts:103-107`), matching the global anchor documented at `http-routes.ts:206-212`.
- **Grouping/ordering agree**: SQL orders on `(resp.id IS NOT NULL)` (`load-replies.ts:299`)
  while `groupReplies` splits on `row_state === 'regenerate'` (`replies-view.ts:246-247`);
  since `deriveRowState` returns `regenerate` iff `!is_orphan && response_id !== null` and
  `is_orphan` implies `resp.id IS NULL`, the two predicates are equivalent. The `r.id DESC`
  tie-break (F7) is present, and the TS re-sort is stable so it cannot undo it.
- **Flag collapse is complete in code**: `flags.ts` exports exactly one function and all
  six call sites (`process-review.ts:295`, `ResponsePublisherWorker.ts:198`,
  `failed-hook.ts:81`, the three past-replies routes) moved in the same change.
- **No file crosses 1,000 lines.** Largest movers: `PastReplyCard.tsx` 299 → 491,
  `PastRepliesClient.tsx` 370 → 422, `load-replies.ts` 257 → 388, `replies-view.ts`
  166 → 249, `tracker.ts` 376 → 432, `past-replies.css` 388 → 556.
- **Allowlist bookkeeping is precise**: `ALLOWLIST_BASELINE` 414 → 412 with 8 stale entries
  deleted and 6 added, each carrying a reason string reused from the named precedent
  (`tenant-scope-allowlist.ts:51-64, 1274-1320`), and the snippets generated from the
  audit's own normalizer rather than transcribed.
- **Glossary**: `Reviews list`, `On-demand generation`, `Origin lane`, `Needs Action` are
  used correctly throughout the new code and the `CONTEXT.md` entries were updated to
  as-built. The only alias hit is finding #16.

---

## Low-confidence appendix (not in the table)

- **`fail_sidecar` and `orphan_sidecar` are near-identical 8-line LATERALs**
  (`load-replies.ts:209-217`, `:272-280`) differing only in the `posting_error LIKE` prefix.
  A single LATERAL returning both prefixes with a discriminating column would halve it, but
  it would also make the `is_orphan` expression less legible. Judgement call; I lean toward
  leaving it.
- **`canEdit(hasPaidTier: boolean): boolean { return hasPaidTier; }`**
  (`replies-view.ts:69-73`) is an identity wrapper. It pre-dates this branch (it had more
  parameters before #678 collapsed the gap/historical gate) and it does name a policy, so
  deleting it is arguably a loss of intent. Flagging only because the thermo-nuclear rubric
  names identity wrappers explicitly.
- **`response_id` carries the *failed* response id on an orphan row**
  (`replies-view.ts:192`) — one field name, two meanings, disambiguated only by
  `row_state`. Pre-existing behaviour carried forward from the deleted `toOrphanCardRow`,
  and the doc comment is honest about it, so not a regression. Worth a rename
  (`action_response_id`?) whenever #680 touches this mapper.
- **Guard ordering in the Generate door**: `enforceRegenBudgetForReview` (`route.ts:97`)
  runs before the tx, so a review that already has a posted reply *and* an exhausted daily
  budget gets `429 regen_limit_reached` rather than `409 already_answered`. Both refuse, so
  the outcome is right and the message is merely less informative.
- **`readJsonSafe` swallows without logging** (`useInlineGenerate.ts:69-75`). Client-side,
  and the `null` flows into `serverMessage(body, fallback)` so the user still sees a
  message; it also mirrors `useEditReplyDraft.ts:172`. Not worth changing.
- **`useInlineGenerate`'s effect depends on the whole `state` object** (`:162`). I traced
  the transitions and could not construct a churn or double-poll: `tick` re-arms its own
  timer without a `setState`, and every other transition either leaves `generating` or is
  guarded by the `state.kind !== 'generating'` early return. Noting only because
  whole-object effect deps usually are a bug.
- **`PastReplyCard`'s `regenerate` and `recover` cases share an identical wrapper**
  (`:194-207` vs `:210-222`) differing only in the trailing control. Collapsible, but the
  explicit duplication keeps the switch readable as a rendering contract. Marginal.
- **The property test hand-copies `isAutoApprovalCandidate`**
  (`on-demand-lane.property.test.ts:27-35`). The file names this risk itself and adds a
  third title that runs the real `persistResponseAndNotify`, and `persist.ts` was outside
  the edit surface. Adequate as-is.
