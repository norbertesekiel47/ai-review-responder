# Current Implementation Map

This file explains what is actually built in the repository today, how it maps to the implementation plan, and what is left to build.

> **State map — newest at the top.** Plain-English per-feature summaries of what is
> true now. This is NOT a build log (that's [progresstracking.md](progresstracking.md))
> and NOT a file inventory (that's `.claude/reference/` + [docs/directory.md](directory.md)).
> Older snapshots are archived — see the pointer further down.

Last updated: 2026-08-11 (#757 Review-time anchor on the RENDERED dashboard SHIPPED — PR #793, squash `17f60e2c`; Quick summary immediately below. Prior entry: #688 KPI Review-time anchor SHIPPED — PR #758, squash `b9fe3c5f`. Earlier: #719 follow-up trio SHIPPED — #736 watchdog `last_error` preservation, PR #753 squash `a3d63b90`; #738 durable drip-skip record, migration 104, PR #754 squash `5307e7f1`; #739 `ci:dropped-columns` audit, PR #755 squash `e97617a2`. Earlier: Onboarding drip dropped-column repair #719 SHIPPED — PR #740, squash `0ae7e0e7`. Earlier: Deferred maintainability bundle #731 SHIPPED — PR #749, squash 6b02910a, **four behaviour-preserving items, one user-visible fix: no migration, no env var, no flag, no new dependency, no schema change, no new file**: (1) `toCardRow`'s seven `isOrphan ? … : …` ternaries collapse into ONE dispatch on the Posted-reply axis to two private mappers, `orphanReplyFacts` / `liveReplyFacts` (`src/lib/past-replies/replies-view.ts`), both returning `Required<Pick<ReviewsListRow, …>>` — `Required<>` is the whole point, because `version` / `failed_response_id` / `failed_posting_error` are OPTIONAL on `PastReplyRow`, so a bare `Pick` would let a mapper silently drop `failed_response_id` and make recovery unreachable (#678 round-2 Defect A); omission is now a `TS2741` at the mapper's own return, not a review catch (ADR 0018 addendum). Card key set unchanged (18); the mappers are private, so the six pinned titles go through `toCardRow`. (2) The **only user-visible change**: the Reviews list's two group denominators and its average star rating no longer come from three snapshots. Two `COUNT`s + an `AVG` in a `Promise.all` could observe three states — a reply posted between the unanswered and answered `COUNT`s made a review invisible to *both*, deflating `totalPages` so the page rendered more rows than its own "N of M" admitted — and are now ONE query whose partition is closed arithmetically: `LEFT JOIN responses p ON p.review_id = r.id AND p.status = 'posted'` + `COUNT(*) FILTER (WHERE p.review_id IS NULL / IS NOT NULL)` (`src/lib/past-replies/load-replies.ts`). Both round-1 review axes independently found the first shipped shape — a `CROSS JOIN LATERAL (SELECT EXISTS …)` read by both FILTERs — to be a large read regression resting on a **false** planner claim in its own rationale comment (Postgres pulls the single-row LATERAL up and plans one correlated SubPlan per reference: ~81–261× planner cost, ~137× buffer accesses, 2.5–13× exec at 20k reviews), accepted and fixed in-branch; the LEFT JOIN cannot multiply rows because `responses_one_posted_per_review` (migration 031) is `UNIQUE (review_id) WHERE status='posted'`, which is the same index and the same join shape the file's main row source already treats as load-bearing. (3) `peekRegenBudget` is DELETED — the two advisory peeks carried OPPOSITE failure contracts (one threw and its caller caught, one swallowed and logged) and duplicated the used/limit/remaining derivation, while the single-key one had exactly one caller and nothing varying behind it; that caller now calls `peekRegenBudgetBatch([reviewId])` (`src/lib/shared/dashboard-regen-rate-limit.ts`), an absent MAP entry is the single fail-open path, and the shared `regen_budget_peek_failed` warn (now carrying `subject_count`, which discriminates the route's single-review path from the page-sized batch) is the only peek-failure signal. **D-F posture unchanged** — the authoritative per-review daily cap is still the worker's Lua `INCR`. (4) The retired `PAST_REPLIES_VIEW_ENABLED` is gone from the publisher edit-existing-reply suite (three set/restore sites + a comment claiming both flags are required); `EDIT_REPLIES_ENABLED` was already the sole gate since #678. Tenant-scope allowlist **409 → 408** (two orphaned `COUNT` entries out, one merged entry in; `sqlSnippet` derived by reusing the audit's own `extractSqlTemplates` — it never prints SQL). Item 4 of the original five is MOOT: #727 deleted `row_state`/`ReviewRowState`, so there is nothing to retype. 14 locked eval titles authored before implementation; 0 gate-fail rounds, 0 surface amendments; **every one of D3–D7 was a defect in the plan's verification commands, not in the implementation**. Review round 1 accepted six findings across both axes — incl. deleting a permanently-vacuous privacy test and re-homing its guarantee as an unconditional assertion in `regen-budget-batch.test.ts` — and round 2 verified all six fixed with no new fronts. Nine durable lessons promoted to lab-notes, the highest-value one being **never measure a feature's diff against `origin/main`; use `git merge-base origin/main HEAD`** (#747 merged mid-run and inflated the production bucket to 3,075 lines / 15×, which would have argued for teardown; the true figures were 290 prod / 430 test). No staging ride — RISK=high escalation considered and declined, because staging exists to exercise the worker, queue, webhooks and migrations, none of which this branch touches. **This was the last implementation ticket on wayfinder map #710** — every item on that map is now merged. Earlier: Owner-facing open-flag predicate consolidation #730 SHIPPED — PR #746, squash 5936468d, **semantics-preserving refactor: no migration, no env var, no flag, no new dependency, no schema change, no new file**: every owner-facing spelling of "this response has an OPEN moderation flag" now composes ONE fragment — `openFlagExistsSql(db, ref)` on `src/lib/moderation/held-draft.ts`, the semantic owner of "is this draft held" (#725 deliverable, #710 item 4). 8 inline spellings across 7 files migrated: projected `AS held` (D9 — both draft-status routes + the Reviews-list LATERAL) and filtered `AND NOT` (dashboard service/aggregate/pending-count ×2, and `getReviewTimeline`'s anti-join rewritten to `NOT EXISTS`); `hasOpenFlag` re-expressed on the same fragment with signature + call sites untouched, so the correlated `response_id` + `status='open'` semantics are spelled exactly once. The `'open'` literal stays a LITERAL inside the fragment on purpose (partial-index inference, migration 051); the internal alias `fr` is reserved (doc + mechanical scan). The 8 deliberately-distinct consumers (admin flagged surfaces, health-alert backlog, offboarding purge lane, producer) are byte-untouched with the divergence rationale on the owner module, and CONTEXT.md's draft **Moderation hold** entry is sharpened: any disposition off `open` closes held-ness; only `approved_for_owner_review` also re-notifies. Enforcement is mechanical, not prose: title-#11 source-scan (per-file invocation minimums, pending-count = 2) + an owner-tree sweep (no `FROM|JOIN flagged_responses` in production files under the four owner-facing trees, comment-stripped) + a reserved-`fr`-ref scan. Blast radius lesson: the fragment's BUILD calls broke 21 tests in 5 ordered-mock suites in two waves (lab-notes); all 7 route/action suites now share the fragment-aware double pattern, and `worker/__tests__/helpers/mock-sql.ts` was already fragment-aware (flattening). Two owner-ratified surface amendments (glob respelling + 2 blast-radius test files); tenant-scope allowlist: 6 sqlSnippets regenerated in place, baseline 409. Three-axis branch review (spec PASS / standards APPROVE / codex adversarial needs-attention → both highs closed mechanically in-branch); staging ridden at `58b9973a` clean. **Merge order vs #740 FLIPPED by owner call** — #746 landed first; #740 (feat-719) remains OPEN and conflicted, rebases onto this. Fast-follows recorded in the deviations log: shared fragment-aware SQL test double (rule-of-three at boundary), repo-wide `flagged_responses` audit script, dashboard `route.test.ts` decomposition, `statusArraySql(sql,…)` client hygiene in the reviews draft-status route, and env-shaped local failures in the migration-056 RLS + WS8 concurrency integration suites (ticket-worthy — forced two `--no-verify` staging pushes). Earlier: Content-freshness gate + generation-cache provenance #728 SHIPPED — PR #743, squash 8ee889ff, **no migration, no env var, no flag, no new dependency, no schema change**: ADR 0017 is implemented — `persistResponseAndNotify` (`worker/jobs/response-generation/persist.ts`) now re-reads `review_content_hash` under the review `FOR UPDATE` lock its transaction already takes as its FIRST statement and, when the loaded hash and the current hash are both non-null and differ, **skips the INSERT entirely**: the job completes (never fails) with the one-owner completion reason `stale_review_content` (`OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT`, `src/lib/shared/outbox-completion-reason.ts` — locus corrected from the ADR's `worker-types.ts` citation, because `job_outbox.completion_reason`'s typed owner is `OUTBOX_COMPLETION_REASON`), writing NOTHING so the `(review_id, version)` slot stays free for the colliding fresh job; the structured log line in persist.ts is the observability signal. A null hash on either side passes — freshness check, not provenance proof. The gate runs before the lane split (all origin lanes: `on_demand_generate`, `regenerate`, `backfill`, both live-ingest lanes); `evaluateAutoApprovalCandidate` stays byte-identical as defense in depth (D-H). The adversarial branch review found the gate deterministically DEFEATED by the `(reviewId, version)` idempotent-generation cache — live-ingest's same-version replacement job legitimately shares the key, was served the stale cached draft, and its own gate then compared the current hash against itself — so the same PR binds cache identity to content provenance (owner Option A, surface amendment #2): `CachedGeneration.reviewContentHash` (`src/lib/responses/generator.ts`), cache-read accepts ONLY strict equality with the current attempt's loaded hash (`null===null` for legacy entries), provenance-less/mismatched entries rejected + cleared best-effort, `generate-draft.ts` threads `ctx.loadedReviewContentHash` into `GenerationOptions`, and the avoid-facts guardrail's direct cache overwrite stamps the same provenance so the documented retry economy survives. persist.ts returns a typed outcome from the `sql.begin` callback + `resolveAutoApprovalDecision` extracted (fallow); reclassify fired at ship (430 actual prod lines > 2×140) — assessed, lane already heaviest, recorded in the deviations log. Follow-up #744: `scripts/verify-gate.sh` must export `DATABASE_POOL_URL` alongside `TEST_DATABASE_POOL_URL` (lab-notes). Earlier: Row-state axes + action projection #727 SHIPPED — PR #741, **no migration, no env var, no flag, no new dependency, no ingest change**: the Reviews list's six-valued `row_state` enum and `deriveRowState` are DELETED, replaced by the #723-locked two-axis model + action projection (ADR 0018, `docs/adr/0018-row-state-axes-projection.md`). `deriveAxes` (`src/lib/past-replies/replies-view.ts`) derives the **Posted-reply axis** (`reply_state`: `none`/`posted`/`orphan` — owns the Unanswered/Answered grouping and the reply panel) and the server-internal **Replacement-draft axis** (`draft_state`: `none`/`generating`/`ready`/`held`, intra-axis precedence held > ready > generating > none), which **never crosses the wire** — invariant #4 as structure, the client cannot leak what it never receives. `deriveRowAction` projects the full 3×4 cross-product onto the **Action slot** (`row_action`: `generate`/`generating`/`draft_ready`/`regenerate`/`recover`/`none`); the wire carries `reply_state` + `row_action` only. One behavioural delta: **posted×held silently withdraws Regenerate** while keeping the live Google reply visible — the old chain tested `response_id` before `draft_held`, so a posted reply with a moderation-held replacement rendered the `EditReplyDrawer` affordance (the map #710 item-1 affordance hole). The invariant is *a held draft never projects an affordance of its own*: `none`×held and `posted`×held → `row_action 'none'`; `orphan`×held keeps `recover` because recovery addresses the orphan incident, not the draft (affordance-vs-execution wording in ADR 0018 — executing recovery against any non-terminal sibling still 409s `newer_draft_exists`). `none`×held keeps today's "Reply on hold" panel, reconstructed client-side from `(none, none)`. Shared `ReplyPanel` extraction in `PastReplyCard.tsx`; CONTEXT.md **Reviews list** glossary rewritten; 17 pinned tests incl. a 12-cell render oracle and live-DB open/unflagged/closed negative controls. This is the affordance half of map #710 item 1 (#726 shipped the server half; #730 owns the predicate consolidation). **Staging resync deliberately SKIPPED at merge** — #719 still rides staging, which re-anchors when #719 lands. Earlier: Legacy Past Replies hold gates #726 SHIPPED — PR #735, **no migration, no env var, no flag, no new dependency**: invariant #4 now binds on every handler in `src/app/api/dashboard/past-replies/` — the three legacy draft routes (4 handlers) refuse to surface or act on a moderation-held draft, mirroring the publish gate. Poller `draft-status` returns `{ status:'failed', error:'held_for_review' }` (200, never text/id) via the D6 inline correlated `EXISTS`; POST `/draft` returns 409 `held_for_review` with NO `existing` payload and its existing-draft SELECT now takes `FOR UPDATE` (post-lock gate per the `held-draft.ts` contract — codex plan-round-1 HIGH catch); PATCH and DELETE on a held row refuse 409 (DELETE stays idempotent-204 for every non-held case; PATCH gated as an approved ticket delta beyond the ticket's three named sites). Tenant refusals always win over heldness; closed flags behave byte-identically to before. This discharges the **launch blocker for flipping `EDIT_REPLIES_ENABLED` in production** (map #710 item 1, server half — #727 owns the affordance half, #730 the predicate consolidation). 8 promised tests incl. a fast-check property over `NON_TERMINAL_STATUSES` and SQL-shape assertions; tenant-scope allowlist: 2 sqlSnippet fingerprints updated in place (baseline stays 409). Codex adversarial branch review returned no-ship on the poller shape; rejected as re-litigation of the locked grilling decision — both positions in `docs/reviews/feat-726-legacy-hold-gates/triage-verdicts.md`. Earlier: Generate transaction extraction #729 SHIPPED — PR #733, **behaviour-preserving refactor: no migration, no env var, no flag, no new dependency**: the ~77-line **On-demand generation** transaction moved out of `reviews/[reviewId]/generate/route.ts` into the deep module `src/lib/reviews/on-demand-generate.ts` (`onDemandGenerateTx(tx, …)` → typed refusal union; route stays the composition root per invariants #12/#15); the three sibling reads are natively business-scoped now, so their 3 tenant-scope allowlist entries are deleted (`ALLOWLIST_BASELINE` 412→409); one-line `statusArraySql` widening to accept `sql`/`tx` (postgres.js `TransactionSql` is NOT assignable to `Sql`); HTTP contract byte-for-byte identical — the only intentional observable delta is the `on_demand_generate_enqueued` log line now firing post-commit. Both #678 suites survived as the characterization eval with zero assertion changes. Earlier: Live-DB helper scan #706 SHIPPED — PR #720, **CI/test tooling only, no runtime surface, no migration, no env var, no flag, no new file, no new dependency**: `ci:live-db-suites` now audits every `.ts`/`.tsx` under `__tests__/`, not just the `*.test.ts`/`*.test.tsx` files vitest runs — four `git ls-files` pathspecs instead of two, which adds the 13 non-suite helper files the audit had never opened. This closes the one bound #694 filed against itself. Postgres.js routes a nested `Query` substitution through `fragment()` and splices it in as raw SQL **text**, not as a bind value, so a helper can export `` sql`ALTER TABLE …` `` and a suite can execute it as `` sql`${addCheck}` `` with no DDL text of its own — #694's AST walk visits the *producing* node, which is correct, but only within a file it actually opens. The **enforcement unit is now split**: R1 **naming** applies to suites only (it is a claim about which vitest project a file lands in, and a helper renamed `*.integration.test.ts` would run as an empty suite), while R2 **run-time DDL** and the lock check apply to every live-DB **file**, because "does this statement take ACCESS EXCLUSIVE" is true wherever the statement was written. Helpers get their own reachability marker — an import of `postgres`, in either the `from 'postgres'` or the inline `import('postgres').Sql` spelling — because a helper is HANDED its handle and so names none of the suite-shaped `LIVE_DB_MARKERS`, but cannot avoid TYPING it; deliberately not offered to suites, where a mock-shaping type import is not evidence of reaching a database and would fire R1 across files that touch no DB. `src/lib/shared/__tests__/helpers/apply-migration-074.ts` was the single real occurrence — it runs `db.unsafe(readMigration074Sql())`, had never been audited, and is now on `MIGRATION_SHAPE_FILES` **and** lock-enforced against its own `withMigration074ApplyLock` (mutation-proved: rename or delete the helper and `unlocked-ddl` appears). The exported shape is unchanged — 1 interface + 2 functions, same arity, same three-member `rule` union — with only the names corrected (`auditLiveDbSuite`→`auditLiveDbFile`, `listTestFiles`→`listAuditedFiles`, `LiveDbSuiteFinding`→`LiveDbFileFinding`, and the two internal allowlists to `*_FILES`). Two bounds remain and are stated in the module: a fragment built outside `__tests__/` entirely (a `src/` module a suite imports), and the `e2e/` Playwright lane, which owns its own database lifecycle. Two review rounds, every finding accepted: round 1's findings across both axes resolved into **nine fixes** — eight prose, one behavioural (the marker's inline-import spelling); round 2 found **five more, every one of them a defect introduced by a round-1 fix**, and all five prose, so the comment-stripped audit script is byte-identical across the round-2 commit. Earlier: Legacy backfill counters DROPPED #680 SHIPPED — PR #716, **migration 103 staging+prod lockstep**: the closing ticket of the Consented Review Import epic (#667) and the DROP half of the locked counter collapse. `zernio_backfill_runs` loses `gap_processed_count`, `historical_processed_count`, `gap_skipped_count` and `historical_skipped_count`; `imported_count`, `skipped_count` and `oldest_skipped_create_time` survive with their 100-era shape and their existing row values. **Zero production TypeScript changes** — the worker stopped writing the legacy four at #675 and nothing else read them, so two of the ticket's four scope bullets (sweep the worker, narrow the tenant-scope allowlist) were already discharged by inspection at 0 diff and recorded as deviations. The gate is an **EXECUTABLE preflight inside the migration**, not a query documented for an operator to remember: a guard that never fires is indistinguishable from a working one on clean data — both report zero abort rows — so only an executable guard whose FAILING branch is tested can be trusted. It counts the four legacy columns through `to_regclass` + `pg_attribute` (search_path-relative, deliberately NOT a `table_schema='public'` literal, so the shape suite can execute it verbatim against a `pg_temp` shadow): **0 → return** (keeps 103 re-runnable), **4 → reconcile**, **any partial state → RAISE**. The **naive predicate is wrong, and staging proved it at apply time** — `collapsed = legacy sums on every row` false-positives on a healthy post-#675 row, and the apply-window preflight returned `unreconciled_two_branch=0` alongside `unreconciled_naive=2`: the naive form would have aborted the migration on both healthy rows. `SET search_path = public, pg_temp` is **session-level, deliberately not `SET LOCAL`** — outside a transaction block `SET LOCAL` is a warning-only no-op, and this repo applies migrations with plain `psql -f`, so it would have governed nothing while reading exactly like its own remedy (caught only on the third adversarial review round). **103 is the epic's POINT OF NO RETURN**: reverting a pre-#675 PR against a post-103 schema raises 42703, so ADR 0015 §4's revert-only backout stops being sufficient from here — buying that clean revert window for the whole build-out is precisely what splitting the collapse achieved. Shape suite pins the migration's executable text EXACTLY and executes its own `DO` block against a pre-103 replica to prove BOTH branches; mutation-verified in both directions. Four adversarial plan-review rounds (10 → 7 → 2 → 0 findings, blockers 1 → 2 → 0 → 0); all 19 findings accepted after verification against disk, none ever rejected. Earlier: Import consent enforcement locus + block reason #695 SHIPPED — PR #714, **no migration, no env var, no flag**: ADR 0016 weighs and **declines** `job_outbox`-boundary enforcement of **Import consent**. A `CHECK` constraint or `BEFORE INSERT` trigger would have to re-spell the derived-expiry predicate (`importConsentStateSql`) in PL/pgSQL inside a migration — unenforced drift plus a two-environment deploy coupling against the one predicate spec §5.3 gives a single owner; `job_outbox` is topic-agnostic infrastructure shared by 32 topics; and an insert-time gate cannot see consent that changes between enqueue and dispatch, so `guardImportConsent` survives either way (the proposal buys two enforcement points, not one). The **observability half** of the same review finding DID ship: a refused `zernio_initial_backfill` row now completes with `job_outbox.completion_reason='import_consent_blocked'` (column from migration 083 — **no new migration**), so a policy refusal is separable by SQL from a genuine completed import, where before the only trace was the log line plus the ABSENCE of a `zernio_backfill_runs` row. `markOutboxOwnerUnreachable` is **DELETED** and generalized into `markOutboxCompletedWithReason(exec, outboxId, reason, attempt?)` (returns `void`) so the outbox seam stops growing one writer per reason — `owner_unreachable`'s persisted wire value is unchanged. The marker is an **operational-window signal, NOT an audit record**: `ArchivalPoller` deletes completed `job_outbox` rows 7 days after `completed_at`, and a refusal completes rather than fails, so it takes the 7-day arm — the same life `owner_unreachable` has always had (ADR 0010), a property of the sink and not of this ticket. What outlives the window is `businesses.import_decision` / `import_decision_at`. There is **no backfill of historical rows**, so a NULL outside the post-deploy window means "genuine import OR pre-deployment refusal" — ADR 0016's operator query carries a `created_at >= '<deploy timestamp>'` bound for exactly that reason. ONE marker covers all four refusal states: it records THAT a refusal happened, and the per-state detail (`pending`/`declined`/`expired`/`missing`) lives only in the structured log line, because re-reading `businesses` afterwards can disagree or find nothing. **Nothing reads it in code** — no poller, no alert, no admin surface; a refusal is the guard working. `guardZernioJobEligibility`'s three skips deliberately keep `completion_reason` NULL. Proven on staging: a hand-inserted row for a `pending`-consent location completed in 3.5s carrying the marker, with zero `zernio_backfill_runs` and zero reviews imported. Earlier: Reviews list + on-demand generation #678 SHIPPED — **no migration**: `dashboard/reviews/history` is widened in place into the **Reviews list** (Unanswered-then-Answered over *all* reviews, `LEFT JOIN`), the tab bar reads `Needs Action` / `All Reviews`, and each row renders ONE server-derived `ReviewRowState` — `recover` → `regenerate` → `held` → `draft_ready` → `generating` → `generate` (remodelled at #727 into the two axes + Action slot, ADR 0018 — the lead entry above) — so a moderation-held draft (invariant #4) surfaces neither text nor affordance. `Generate` expands inline against the new `POST/GET /api/dashboard/reviews/[reviewId]/{generate,draft-status}` doors on the `on_demand_generate` origin lane, which is **structurally excluded from auto-approval** (owner-only, always). The gap/historical split is gone, surviving only as a per-row `ProvenanceBadge`. **`PAST_REPLIES_VIEW_ENABLED` is RETIRED** — deleted, not flipped, because the list is the consented **Review import**'s only destination and the flag would have let `accepted` consent coexist with a `notFound()`; remove the var from Railway + Vercel, and re-add it before any revert of this PR boots. `EDIT_REPLIES_ENABLED` survives as the sole gate on the live-Google mutation. Known follow-ups filed as **#710** (held-draft exposure in the legacy Past Replies draft lane — pre-existing invariant #4 gap; the Generate/live-ingest race's blast radius is content staleness, not merely wasted spend; extract the Generate transaction out of the route). Earlier: Import consent analytics sink #697 SHIPPED — PR #708, **no migration, no env var, no flag**: the swallowed **Import offer** / **Import decision** analytics emission now has a *durable* sink. `emitConsentEvent`'s savepoint (#679) converted a connect outage into a lost metric and a `warn` — but `createWorkerLogger.warn` writes to stdout and nothing reads it, while this project's documented paging route is Sentry, so persistent migration-102 drift could undercount both one-shot events indefinitely with nothing alerting. It now also `captureMessage`s at `level: 'warning'` tagged `subsystem: import_consent_analytics` + `event_name`, carrying exactly three fields (`business_id`, `event_name`, error text — never the event `properties`). `warning` not `error` because the caller committed and only a metric was lost; the actionable pattern is **repetition**, so both routing docs now specify an event-frequency alert condition rather than "a new issue is created" (the title is a constant, so everything groups into ONE Sentry issue and a new-issue rule would fire once, ever). The capture carries **its own** `try`/`catch` and the `warn` sits deliberately **outside** it: `createImportOffer` runs inside `finalizeConnectionTx` and `select-location/route.ts` rethrows anything that is not `23505`, so an escaping capture is the #679 connect outage re-opened one layer out — and moving the warn inside that guard would delete the last sink on exactly the path where Sentry is unreachable. Both bounds are pinned by tests, verified by **five mutations** each turning only its intended title red. Nothing about the savepoint or the `errorStringProperty(error,'code')` narrowing changed; a code-less error (a mis-wired handle) still rethrows, now **before** any capture, so a wiring bug can never masquerade as schema drift in the alert channel. Proven on staging by inducing the real `23514` without touching the schema — an event name the live CHECK rejects, inside an aborted transaction — landing Sentry issue `REPWORTH-STAGING-S` with the routable tag and leaving zero rows behind. **Residual ops gap:** the Sentry→Discord rule for the new tag is not configured yet, so the signal is durable but not paged; both `docs/runbooks/beta-launch-alerting.md` §1 and `docs/launch-checklist.md` carry the checklist item. Earlier: Live-DB DDL detector #694 SHIPPED — PR #705, **CI/test tooling only, no runtime surface, no migration**: `ci:live-db-suites`' rule R2 ("no run-time DDL in a live-DB suite") keyed on an *incidental marker* — `text.includes('supabase/migrations') && text.includes('.unsafe(')` — so any suite executing DDL without naming a migration path passed clean. Three did; one forced a transaction abort with a temporary CHECK constraint dropped in a `finally`, a vitest timeout skipped the `finally`, and the stranded constraint blocked every sibling suite enqueuing `zernio_initial_backfill` — **14 spurious failures across three suites**. Detection is now AST extraction of **executed SQL** (every tagged template + `.unsafe()` call), with the verb match run over extracted text only, so a DDL verb in a regex literal, a `toContain` assertion, a comment or an unexecuted constant no longer counts. Deliberately **no tag-name allowlist**: `sql()` is the plurality of templates in these suites and is a `CallExpression`, so reusing `SQL_TAG_NAMES` would have repeated this ticket's own bug one layer down (#592's shape); `sql-tag-scan.ts` is imported for `lineHasPragma` only and left byte-identical so the four SQL vocabulary audits keep their scope. The scan found **seven** real DDL sites, not the three the ticket named: two bootstrap `ALTER TABLE`s replaced by `assertSchemaReady(MIGRATION_083_…)`, one temp-constraint abort replaced by the shared non-DDL `abort-injection.ts` helper, two `auth.uid()` RLS probes allowlisted as **DDL-probe suites** (both already locked — but `migration-091` was on *no* allowlist, so its lock enrolment had never once been checked), and three pg_temp sites pragma'd `-- live-db-ddl-ignore`. **That ticket's one known bound is CLOSED at #706 — PR #720, the lead entry above.** Earlier: Verify-gate row identity #696 SHIPPED — PR #701, **workflow tooling only, no runtime surface**: the `/feature` step-5 gate could report **PASS for a suite that failed**. A row's name is simultaneously its status slot, its `.feature/logs/<name>.log` and its coverage directory, and both dynamic row names were derived by truncating to 40 characters — `import-consent.integration.test.ts` is *exactly* 40 slug characters, so every `import-consent-*` sibling collapsed onto it. `row_slug` (`scripts/gate-rows.sh`) now truncates for readability and identifies by an appended hash, and `launch()` asserts uniqueness at registration so a collision can never resolve silently. The #679 workaround — renaming the extracted suite — is retired as a live constraint. Earlier: Import consent worker guard #679 SHIPPED — PR #698, **migration 102 staging+prod lockstep**: the last consent hole in the Review import is closed, and the release constraint #675 and #677 both carried is **DISCHARGED**. `ZernioBackfillWorker` now runs a fail-closed pre-flight — it proceeds only on `import_decision='accepted'`, and `pending`, `declined`, derived `expired` and a missing `businesses` row all no-op-complete with a logged reason, so the admin/hand-inserted path is covered at the one chokepoint every enqueue producer shares (ADR 0015 §3's accepted gap, D8's "admin path included"). Enforcement is no longer producers-only. The guard is a SEPARATE function from `guardZernioJobEligibility`, not a `jobKind` branch, so live-ingest independence is structural rather than a runtime flag a future edit can flip; its whole body runs inside `sql.begin` with `SELECT … FOR UPDATE` + `markOutboxCompletedWithReason(tx, …)` (plain `markOutboxCompleted` until #695) because without that serialization an owner's accept can race the guard into silent permanent data loss. Migration 102 also registers the two **Import offer** analytics events #677 deferred (`import_offer_created`, `import_decision_recorded`), both emitted from inside their writing transaction under a SAVEPOINT so a rejected insert costs a metric, never an owner's decision. Every skip is skip-as-success — the outbox row is completed, never failed or retried, so a declined import cannot churn the queue forever. Proven on staging with six assertions: all four block reasons against real hand-inserted rows (zero `zernio_backfill_runs`, zero reviews each), `accepted` still importing (`imported=29 skipped=0 pages=4`), and both analytics events landing through their real writers. Earlier: Import offer #677 SHIPPED — PR #691, **no migration**: the consented Review import is now **owner-gated end to end**. An **Import offer** is minted server-side at the subscribe+connect junction with a `now() + 7 days` deadline, surfaced by `ImportOfferBanner` through `GET/POST /api/dashboard/import-offer`, and answered once — terminally, first-write-wins. All **four** enqueue producers (connect finalize, Stripe activation resume, reactivation catch-up, the decision route) now gate on `import_decision='accepted'` under the `businesses` row lock and share ONE `enqueueInitialImport`, replacing three hand-copied guards that had already diverged. Absorbs #676. Proven on staging through the browser: self-heal minted a deadline, the junction predicate correctly refused a same-named location with no active connection, accept → enqueue → dispatched in ~3s → `importing` → worker completion with a matching correlation_id, and the re-run stayed insert-only (zero duplicate reviews). **Release constraint DISCHARGED at #679 (PR #698) — the fail-closed worker pre-flight has landed, so enforcement is no longer producers-only and a hand-inserted row can no longer import without consent.** Earlier: Consented review import #675 SHIPPED — PR #689, **no migration**: `ZernioBackfillWorker` is now the consented Review import executor — the newest **100** reviews inside the 12-month **Import window**, upper-bounded by the **Live-ingest cutoff** (`connected_at − 5 min`) so lane ownership is disjoint *by construction* and the #674 lost-draft hazard is structurally impossible. Nothing is auto-drafted (zero `job_outbox` writes from the import); answered reviews land as list rows with imported `posted` responses; the gap/historical counter split is dead — collapsed `imported_count`/`skipped_count` only (the frozen legacy columns were DROPPED by migration 103 at #680). Pagination is loud: `ZERNIO_IMPORT_MAX_PAGES` cap-out with target unmet fails terminally, never truncates silently. Proven twice on staging (imported=29 skipped=0, dirty-ordering best-effort lane fired live). **Release constraint DISCHARGED at #679 (PR #698) — the fail-closed `import_decision='accepted'` worker pre-flight has landed.** Earlier: Manual suppression paths #645 SHIPPED — PR #659, **migration 098 staging+prod lockstep**: the Suppression ledger is now writable *and fixable* by humans. Admin manual entry (§7.3) and the audited **Correction path** (§8.2) behind AAL2 at `/admin/suppressions`; owner do-not-contact mark/clear (§7.5/§7.6) on `/dashboard/requests/contacts`. A correction is ONE data-modifying CTE, so a removal cannot commit without its audit record — and a blank "why" aborts the whole statement, leaving the opt-out in place. An owner may never clear a `global` row: the control is not rendered at all. Proven end-to-end on staging through the browser. Earlier: Unsubscribe opt-out #644 SHIPPED — PR #654, **no migration**: the Suppression ledger now has its first writer. RFC 8058 one-click ingress on Railway + the `/u/<token>` recipient landing path on Vercel, both live and both proven on staging with `SOLICITATION_SEND_ENABLED` **off** (DR1). Two live pre-existing limiter bypasses closed as side effects — percent-encoded ingress paths and absolute-form request targets — affecting Stripe, Resend, Telegram, Twilio and Zernio alike. `SESSION_COOKIE_SECRET` is now boot-asserted on deployed worker lanes and **deliberately unset on Railway prod** until the Solicitation agent ships; that worker has never successfully deployed, so the gate has nothing to crash-loop. Earlier: Suppression ledger #643 SHIPPED — PR #647, migrations 096–097 staging+prod lockstep: the opt-out record exists and cannot be laundered by delete-and-re-upload, but **nothing writes to it yet** — #644/#645/#627 land the first writers, so zero suppression rows is the expected steady state. Earlier: Consent ledger #625 SHIPPED — PR #640, migrations 093–095 staging+prod lockstep, the `consent_attested` tautology and the §1.2 re-upload trap are dead. Earlier: Solicitation watch-mode SHIPPED — wayfinder map #528 destination reached: PRs #554/#561/#564/#570/#571/#574/#575, migrations 084–089 staging+prod lockstep, `SOLICITATION_WATCH_ENABLED=true` live on staging; architecture review 2026-07-24 completed with 6 findings, counter now 4. Earlier: Restraint policy module — PR #551: first Phase 2 Solicitation code merged, pure sentiment-blind `evaluateAsk`/`evaluateBatch` in `src/lib/solicitation/`; arch-review counter hits the 5/5 threshold. Earlier same day: Agentic staging E2E campaign — PRs #518–#522: WS1–WS8 proven end-to-end on staging against a LIVE Google profile (Phases A–D), three launch-blocking bugs found by live testing and fixed (#518 trial checkout `payment_status`, #519 onboarding page/route flag drift, #520 governor re-suspension immunity), Zernio go-live gate CLOSED (no limits, pay-per-use), prod schema verified through 083 (078 deliberately awaits the WS8 cutover), production stack deliberately NOT stood up until launch. Earlier: 2026-07-21 Reliability follow-ups P4/P8/P9 — PRs #514–#516: bounded Stripe calls under tier-change locks, LLM provider circuit breaker, owner-unreachable escalation + migration 083; the 10-finding pre-production reliability report fully closed. Earlier: 2026-07-20 Production reliability guards #508 — seven pre-production hardening guards P1/P2/P3/P5/P6/P7/P10 merged via PR #508. Same day: Scalability verification remainders #511 — boot-enforced summed LLM worker-slot cap + migration 082 failover indexes, merged via PR #511. Earlier: 2026-07-15 WS8 Copilot/Autopilot tier wiring implemented on the execution branch; integration-owner PR/review/remote rollout still pending. Earlier: 2026-07-06 Modularity A+ campaign COMPLETE — db-imports singleton importers 105→0, the DB-injection convention + LLM-task seam are permanent CI-enforced invariants, PRs #438–#456; see the [exit re-audit](audits/2026-07-06-modularity-aplus-exit-audit.md). Earlier: 2026-06-26 Modularity-audit remediation COMPLETE; 1-Month Free Trial #362 2026-06-22; Beta-launch alerting gate #354 2026-06-20; Channels go live + auto-approved post FYI 2026-06-14→15; Multi-location launch hardening 2026-06-11.)

## Quick summary — #757 Review-time anchor on the rendered dashboard (2026-08-11, PR #793)

#688 anchored a KPI stack **nothing rendered**. #757 moves the anchor onto the
surfaces owners actually see and deletes the unrendered stack, so there is now
exactly ONE KPI path instead of two with different clocks.

Concretely: a consented Review import used to spike the import week — 100 reviews
landing today drew one tall bar and no history. The dashboard now buckets those
reviews into their **true weeks** on the Review-time anchor
`LEAST(review_date, detected_at)`, so an import instantly yields a real historical
trend. Proven on staging: five reviews imported today with review dates 7/14/21/28/45
days back render as five distinct non-zero weeks with the import week at **zero**.

Re-anchored: review velocity, rating breakdown, average star and the 8-week sentiment
trend per-location; velocity and rating breakdown in the All-Locations aggregate.
Deliberately still on `detected_at` (ADR 0019 Decision 2): response rate, the aggregate
`windowedReceived`/`windowedResponded` counters, the MonthlyImpactWorker digest. An
import is account activity, and imported unanswered reviews are meant to drag the rate.
**No migration, no env var, no flag, no new dependency.**

The new shape:
- `src/lib/kpi/fragments.ts` — **NEW**, the single owner of `reviewTimeAnchor` /
  `reviewTimeWindowFilter`. A test pins that the anchor is spelled nowhere else, so a
  future hand-spelled `LEAST(...)` fails CI rather than quietly forking the definition.
- `src/lib/kpi/service.ts` + `src/app/api/dashboard/kpis/` — **DELETED**. Zero consumers.
  `src/lib/kpi/types.ts` survives; its window vocabulary has many importers.
- `src/lib/dashboard/service.ts` + `aggregate-queries.ts` — compose the fragments. The
  aggregate anchor stays inside `LEFT JOIN … ON`; in `WHERE` it degenerates to an inner
  join and locations with no reviews lose their zero-filled series.
- `scripts/ci/tenant-scope-allowlist.ts` — 408 → **401**. Seven entries existed only for
  the deleted file; two survivors were re-pinned because entries are keyed on normalized
  raw SQL text, so re-anchoring a query silently invalidates them.

Carried forward, not fixed here: **#789** (formally supersede Spec 11's launch-KPI clause;
the deleted metrics' full behavioral contract is preserved in ADR 0019's addendum),
**#790** (reopen ADR 0019 Decision 2 — one dashboard period now mixes a `detected_at`
response rate with a review-time volume series, and this branch is the first time that
mixed clock is owner-visible), **#791** (All-Locations *combined* velocity sorts
alphabetically by month name — pre-existing since PR #28, found by the staging smoke).

## Quick summary — #688 KPI Review-time anchor (2026-08-10, PR #758)

> **Superseded by #757 (2026-08-11, PR #793).** Two claims below are no longer true:
> `src/lib/kpi/service.ts` is **deleted** — the anchor's owner is now
> `src/lib/kpi/fragments.ts` — and the dashboard no longer "still buckets on
> `detected_at`". The GA gate this block transfers to #757 is **closed**. Kept as the
> dated record of what #688 shipped; read the #757 summary above for current state.

The GA-gating decision ticket #688 (map #667, Consented Review Import) is
resolved and shipped: the reputation KPIs — review volume MoM, 8-week
sentiment trend, average star — now bucket on the **Review-time anchor**
`LEAST(review_date, detected_at)` (ADR 0019; CONTEXT.md glossary term), so a
consented Review import lands in its true months/weeks and instantly yields a
real historical trend instead of a +100 spike in the import month. Workflow
KPIs deliberately keep detection-time semantics: response rate still counts
imported unanswered reviews (the #675 nudge reasoning), and the
MonthlyImpactWorker digest is untouched. Average time-to-respond gains the
validity filter `approved_at >= detected_at`, killing the negative-TTR class
(a reconciled pre-existing Google reply carries its ORIGINAL timestamp —
staging had 16 rows down to −2.9 years). `LEAST` over `COALESCE` because
Postgres LEAST ignores NULLs (NULL `review_date` falls back) and clamps a
clock-skewed future `review_date` that would otherwise vanish from the
trend's `generate_series` LEFT JOIN. **No migration, no import discriminator
column, no flag, no copy change.**

The new shape:
- `src/lib/kpi/service.ts` — `reviewTimeAnchor` / `reviewTimeWindowFilter`
  lazy fragments (one owner of the anchor); six query sites re-anchored
  (star/volume/trend × location/account scope); TTR validity predicate in
  `ttrHandledWindowFilter`. Exported interface unchanged (pure deepening).
- `src/lib/kpi/__tests__/service.anchor.integration.test.ts` — live-DB eval
  suite: 8 promised tests committed red-first (4 red / 4 regression pins) +
  an account-scope consistency pin.
- `scripts/ci/tenant-scope-allowlist.ts` — 3 trend snippets re-pinned
  (baseline 408, zero growth; the audit pins exact raw template text).
- `docs/adr/0019-kpi-review-time-anchor.md` — decision of record
  (supersedes the #675 intake's "accept as-is" holding position).

**GA gate transferred to #757**: the step-7 review confirmed
`GET /api/dashboard/kpis` has **zero consumers** — the dashboard owners
actually see (ReputationHeroBand via `src/lib/dashboard/service.ts`,
velocity/rating breakdown via `src/lib/dashboard/aggregate-queries.ts`)
still buckets on `detected_at`, a gap that predates #688's branch. #757
(GA-blocking) applies the anchor there and adjudicates the consumer-less
KPI route.

## Quick summary — #719 follow-up trio: #736 + #738 + #739 (2026-08-10, PRs #753/#754/#755)

The three tickets #719's step-7 review filed, landed as three independent PRs the next day.

- **#736 — the Watchdog terminalizer preserves per-job `last_error`** (PR #753, squash
  `a3d63b90`). `OutboxPoller`'s terminalizer used to overwrite `last_error` unconditionally
  with `'Stale dispatched entry exceeded max_attempts'` — destroying the bounded error class a
  failed-hook had recorded with the exact generic message that let #719 read as routine for
  three months. Now `COALESCE(NULLIF(last_error, ''), <generic>)`: a non-empty per-job error
  survives, the reclaim text is a fallback only. Honors the csv-ingest PII contract by
  construction (the terminalizer persists nothing new) and keeps the generate-asks
  retryable-exhaustion `last_error` through both watchdog arms. The watchdog phase is now the
  exported seam `runOutboxWatchdogRecovery(db, staleSecs, logger)` (mirrors
  `runOnboardingDripCycle(db, asOf)`), proven value-level by a new live-DB suite
  (`OutboxPoller.watchdog.integration.test.ts`).
- **#738 — scheduler-side drip staleness skips leave a durable record** (PR #754, squash
  `5307e7f1`, **migration 104**). The staleness cap's two enforcement points are now equally
  durable: the scheduler stamps `skipped_at`/`skip_reason='drip_too_stale'` on
  `onboarding_drip_log` — chosen over a `job_outbox` marker because ArchivalPoller deletes
  completed outbox rows after 7 days (a tombstone there would evaporate AND re-mint forever),
  while the drip log is never archived and is one row per pair. The stamp replaces the GRACE+1
  one-day reporting window as the candidate-query dedup, so a backlog already past the window
  at deploy is recorded once instead of skipped silently. Outer-window removal is re-mint-safe
  because archival (7d) strictly exceeds grace (3d) — load-bearing, documented in code +
  CONTEXT.md. Operator query: `SELECT business_id, drip_type, skipped_at FROM
  onboarding_drip_log WHERE skip_reason = 'drip_too_stale'`. Applied staging-then-prod in
  lockstep 2026-08-10 (details: migrations-log 104 entry). Staging live-observed the designed
  backstop: the #719-era dead-claim pair stays excluded by its completed outbox row until
  archival frees it (~Aug 16), then gets its permanent record.
- **#739 — `ci:dropped-columns`** (PR #755, squash `e97617a2`). The forward guard against the
  #719 class: replays `supabase/migrations/*.sql` into a dropped-at-head ledger (6 columns
  today) and scans src/ + worker/ SQL tagged templates with **relation-anchored** matching
  (qualified refs via table name or bound alias; bare refs only in single-relation templates —
  `business_id` legitimately lives on many other tables). Interpolations/comments/strings are
  blanked same-length so JSONB keys never flag and findings carry real lines. Escape pragma
  `dropped-column-ignore` (zero uses). Wired in package.json + ci.yml lint job + lefthook;
  `ci-audit-wiring.test.ts` passes unchanged. Green on main at merge; mutation-probed against
  the literal #719 query shapes.

## Quick summary — Onboarding drip dropped-column repair (2026-08-10, PR #740)

**The onboarding drip email now sends. It had not sent to anyone for three months.**

Migration 034 dropped `users.business_id` on 2026-05-10. Three live queries kept reading it
and threw Postgres `42703` on every run. `handleOnboardingDrip` threw *after* claiming its
`onboarding_drip_log` row and *before* sending, so the `onboarding_drip` topic had **never
once reached `completed`** in its life. Two faults hid it and made it worse: the scheduler
re-minted an **Outbox job** for every failed pair each cycle (93 rows at planning, 101 by
ship), and `worker/index.ts` reported job failures as a Sentry *breadcrumb* rather than
`captureException` — so a hard, deterministic, every-single-run crash raised no issue at all.

Three repairs, no migration, no schema change, no env var, no feature flag:

- **The queries.** `ownerHasDashboardAuth` + `buildDashboardUrl` collapse into one
  `resolveDashboardUrl` joining the post-034 path `businesses.account_id → users.account_id`.
  `u.role = 'owner'` and the account join are both load-bearing and both live-tested. The dead
  day_30 business-scoped-admin branch is deleted (the signed-off behaviour change) — note its
  original justification, "admins carry `account_id IS NULL`", turned out to be **false**:
  migration 034 §5d backfills `users.account_id` with no role filter.
- **Two bounds on the scheduler.** The **Drip staleness cap** (3-day grace, sends *at* the
  boundary and skips past it) and a rolling **churn cap** (max 3 failures / 24h). The cycle
  gained an injected `asOf` seam and now *throws* where it swallowed — a swallowed `42703`
  was indistinguishable from a correct skip, which made every negative test vacuous.
  Enforced at **two** points: the producer, and a fail-closed chokepoint in the handler that
  runs before the drip-log claim and completes with `completion_reason='drip_too_stale'`.
- **The Job-failure sink** (`worker/job-failure-sink.ts`). Raises a real Sentry issue on the
  terminal attempt, tagged `{subsystem, queue, topic}`. It writes nothing to `job_outbox` —
  failed-hooks own that surface. (The rationale at ship time was that the **Watchdog**
  overwrote `last_error` unconditionally; #736 has since fixed the Watchdog to preserve a
  non-empty `last_error`, but the sink stays Sentry-only by design.)

**The new shape**

| File | Role |
|---|---|
| `worker/jobs/summary-report-helpers.ts` | `resolveDashboardUrl` — the one post-034 location→owner join, three call sites |
| `worker/jobs/OnboardingDripWorker.ts` | consumes it; owns `DRIP_STALENESS_GRACE_DAYS` + the fail-closed staleness chokepoint |
| `worker/background/schedulers/OnboardingDripScheduler.ts` | `runOnboardingDripCycle(db, asOf)` — churn + staleness bounds; imports the cap from the worker |
| `worker/job-failure-sink.ts` | **new** — terminal BullMQ failure → Sentry issue |
| `src/lib/shared/sentry-scrub.ts` | now redacts `exception.values`, which it never covered |
| `src/lib/shared/outbox-completion-reason.ts` | new `DRIP_TOO_STALE` member |

**Verified on staging, not just in tests.** Two day_1 drips sent at 10:57:53 UTC with Resend
message ids, `onboarding_drip_log.sent_at` non-NULL, outbox rows `completed`, zero new failures.
The third location was correctly held by the churn cap at **13 failures in 24h** — so both new
bounds are demonstrated live. That third location permanently loses its day_1: the churn cap
holds it until the failures age out, by which time the staleness cap has closed. Both caps
worked exactly as designed and one owner still lost one email — the concrete shape of #738.

**Two review findings worth carrying:** the sink originally gated on `isTerminalAttempt`, which
is the *catch-block* predicate and fires an attempt early in a `'failed'` **event** listener
(`worker/jobs/judge/failed-hook.ts` already said "do not unify them"); and `scrubSentryEvent`
never covered `exception.values`, so promoting failures from breadcrumbs to issues was briefly
a PII regression. Both fixed before merge.

Follow-ups — **all three shipped 2026-08-10**: **#736** (watchdog preserves per-job
`last_error`, PR #753), **#738** (durable scheduler-side skip record, migration 104, PR #754),
**#739** (`ci:dropped-columns` audit, PR #755). Detail in the Quick summary at the top of this
file.

## Quick summary — Deferred maintainability bundle (2026-08-09, PR #749)

#678's step-7 review filed five maintainability items and deferred all of
them. #727 made one moot (it deleted `row_state` outright), so #731 lands the
remaining four as one run. Three are behaviour-preserving by construction;
the second one fixes a real, silent, user-visible defect.

The new shape:

- `src/lib/past-replies/replies-view.ts` — `toCardRow` no longer merges two
  row shapes behind seven `isOrphan` ternaries. It dispatches once on the
  Posted-reply axis to `orphanReplyFacts` / `liveReplyFacts`, both returning
  `Required<Pick<ReviewsListRow, …>>`. The `Required<>` is load-bearing:
  three of those fields are optional on `PastReplyRow`, so a bare `Pick`
  would let a mapper drop `failed_response_id` and make recovery silently
  unreachable — the exact fragility #678's round-2 review flagged. Dropping
  it now reports `TS2741` at the mapper's return (ADR 0018 addendum).
- `src/lib/past-replies/load-replies.ts` — **the one user-visible fix.** The
  two group denominators and the average star rating were three separate
  snapshots in a `Promise.all`; a reply posted between the unanswered and
  answered `COUNT` made a review invisible to both, deflating `totalPages`
  so the page rendered more rows than its own "N of M" admitted. They are
  now ONE query: `LEFT JOIN responses p … AND p.status = 'posted'` +
  `COUNT(*) FILTER (WHERE p.review_id IS NULL / IS NOT NULL)`, a partition
  closed by arithmetic rather than by timing. The first shipped shape used a
  `CROSS JOIN LATERAL (SELECT EXISTS …)` on a false planner premise and was
  replaced in-branch after both review axes measured it (lab-notes).
- `src/lib/costs/tracker.ts` + `src/lib/shared/dashboard-regen-rate-limit.ts`
  — `peekRegenBudget` is deleted. Two peeks carried opposite failure
  contracts (one threw, one swallowed) over a duplicated
  used/limit/remaining derivation; the single-key one had one caller, which
  now calls `peekRegenBudgetBatch([reviewId])`. An absent **map** entry is
  the single fail-open path (an absent *key* still means "unused" — inverting
  those two would disable every Regenerate during an Upstash outage), and the
  shared `regen_budget_peek_failed` warn carries `subject_count` so the
  route's single-review path stays distinguishable from the page-sized batch.
  The advisory posture is unchanged: the authoritative per-review daily cap
  is still the worker's Lua `INCR`.
- `worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts` —
  the retired `PAST_REPLIES_VIEW_ENABLED` is gone (three set/restore sites
  plus a comment claiming both flags were required). `EDIT_REPLIES_ENABLED`
  has been the sole gate since #678.
- `scripts/ci/tenant-scope-allowlist.ts` — `ALLOWLIST_BASELINE` **409 → 408**
  (two orphaned `COUNT` entries out, one merged entry in).

Behaviour is pinned by 14 eval titles authored verbatim before any
implementation, including three live-Postgres denominator-partition titles.
This was the last implementation ticket on wayfinder map #710.

## Quick summary — Owner-facing open-flag predicate consolidation (2026-08-09, PR #746)

Eight places spelled the same SQL by hand: "this response has an OPEN
moderation flag" — the predicate behind invariant #4's owner-facing surface
(a held draft never shows its text or an affordance). Every hand copy was a
chance to drift; #725's research drew the line between the owner-facing
spellings (consolidate) and the deliberately-distinct consumers (leave
alone), and #730 is the build half.

The new shape:

- `src/lib/moderation/held-draft.ts` — owns `openFlagExistsSql(db, ref)`, a
  composable Postgres.js fragment (statusArraySql house pattern); the
  `'open'` literal and the reserved internal alias `fr` are documented
  constraints; `hasOpenFlag` is re-expressed on the fragment; the module
  header inventories the four distinct-consumer categories that must NOT
  consolidate (admin, health alerting, purge lane, producer).
- Projected composition (`… AS held`, D9): `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts`,
  `src/app/api/dashboard/past-replies/draft-status/route.ts`,
  `src/lib/past-replies/load-replies.ts` (Reviews-list LATERAL).
- Filtered composition (`AND NOT …`): `src/lib/dashboard/service.ts`,
  `src/lib/dashboard/aggregate-service.ts`, `src/lib/dashboard/pending-count.ts`
  (both spellings), `src/lib/agents/read.ts` (`getReviewTimeline`,
  anti-join → NOT EXISTS).
- Mechanical guards in `src/lib/moderation/__tests__/held-draft.test.ts`:
  per-file invocation minimums, owner-tree sweep (no inline
  `FROM|JOIN flagged_responses` in production files under the four
  owner-facing trees), reserved-`fr`-ref scan, and a `.todo`-survivor scan.
- CONTEXT.md **Moderation hold** sharpened: flag-release (any disposition
  off `open`) vs re-notification (`approved_for_owner_review` only).

Behavior is byte-identical — pinned by 11 promised tests landed before the
refactor, including a live-DB fast-check property proving projected and
filtered visibility agree across every flag-status combination.

## Quick summary — Content-freshness gate + generation-cache provenance (2026-08-09, PR #743)

A `generate_response` worker loads review text, spends seconds-to-minutes in
the LLM call, and only then persists. In that window live-ingest can commit
new review text and enqueue its replacement job at the SAME
`(review_id, version)` — so the surviving `pending_approval` draft could
answer text the customer had since changed. #678 deferred this on the premise
"a wasted LLM call, not corruption"; ADR 0017 records why that premise is
false and reverses the deferral. #728 is the implementation.

The new shape:

- `worker/jobs/response-generation/persist.ts` — the **content-freshness
  gate**: under the review `FOR UPDATE` lock (already the transaction's first
  statement), re-read `review_content_hash`; both non-null and different →
  **skip-the-INSERT** and complete the job with `stale_review_content` + a
  structured log line. Nothing is written, so the version slot stays free for
  the colliding fresh job. A null hash on either side passes (legacy pre-hash
  reviews must still generate). Runs before the lane split — every origin
  lane; the auto lane's stricter hash gate in `evaluateAutoApprovalCandidate`
  is untouched defense in depth. The `sql.begin` callback now returns a typed
  outcome (the `InitialPhaseOutcome` precedent) instead of an outer flag.
- `src/lib/shared/outbox-completion-reason.ts` —
  `OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT`, the token's one owner.
  The ADR cited the `worker-types.ts` skip-reason precedent; that precedent
  is log-only, while this value is written to `job_outbox.completion_reason`
  — locus corrected in the deviations log, spelling unchanged.
- `src/lib/responses/generator.ts` + `types.ts` — **cache provenance**:
  `CachedGeneration.reviewContentHash`; a cache hit is accepted ONLY on
  strict equality with the current attempt's loaded hash (`null===null`
  legacy pass); provenance-less or mismatched entries are rejected and
  cleared best-effort. Without this the `(reviewId, version)`
  idempotent-generation cache handed the stale draft to live-ingest's
  same-version replacement job and the gate compared fresh-to-fresh —
  adversarial-review NO-SHIP, fixed in the same PR (owner Option A,
  amendment #2). Deliberately NO clear-on-skip: the provenance check is the
  one owner of cache validity.
- `worker/jobs/response-generation/generate-draft.ts` — threads
  `loadedReviewContentHash` into `GenerationOptions` and stamps provenance
  on the avoid-facts guardrail's direct cache overwrite (left provenance-less
  it would be rejected by every later read, turning the documented
  retry-hits-cache economy into a fresh re-spend).
- `worker/jobs/ResponseGeneratorWorker.ts` — maps the persist outcome to
  `markOutboxCompletedWithReason(sql, outboxId, STALE_REVIEW_CONTENT,
  attempt)`.
- CONTEXT.md carries the locked **Content-freshness gate** glossary term.
  Tests: `content-freshness-gate.integration.test.ts` (stale-content
  direction, two-client FOR-UPDATE lock serialization, all-lanes coverage,
  structured-log-line assertion) + `generate-draft-cache-provenance.test.ts`
  (real generator + real cost-guard over a Map-backed cache, mocked LLM
  SDKs) + persist/handler unit additions.

Follow-up: **#744** — `scripts/verify-gate.sh` resolves
`TEST_DATABASE_POOL_URL` but not `DATABASE_POOL_URL`, so a changed
integration suite that transitively imports the `src/lib/db/server`
singleton dials vitest.setup's dummy `localhost:5432`; export BOTH to the
test DB when invoking the gate until the script owns it (lab-notes).

## Quick summary — Row-state axes + action projection (2026-08-09, PR #741)

The Reviews list no longer collapses "what exists on Google" and "where a
replacement draft stands" into one six-valued `row_state`. #678's
`deriveRowState` precedence chain tested `response_id` before `draft_held`, so
a posted reply with a moderation-held replacement returned `regenerate` and
rendered the `EditReplyDrawer` affordance — the map #710 item-1 hole. #727
models the two facts as the orthogonal axes #723 locked and projects a single
action onto the wire (ADR 0018).

The new shape — derivation all in `src/lib/past-replies/replies-view.ts`:

- `deriveAxes` → the **Posted-reply axis** (`reply_state`: `none` / `posted` /
  `orphan`; owns the Unanswered/Answered grouping and the reply panel) + the
  **Replacement-draft axis** (`draft_state`: `none` / `generating` / `ready` /
  `held`, precedence held > ready > generating > none). `draft_state` is
  server-internal — it NEVER crosses the wire, so invariant #4 is structure,
  not client discipline.
- `deriveRowAction` → the **Action slot** (`row_action`: `generate` /
  `generating` / `draft_ready` / `regenerate` / `recover` / `none`), total
  over all 12 cells of the 3×4 cross-product. The wire carries `reply_state`
  + `row_action` only.
- `PastReplyCard.tsx` renders the slot through a shared `ReplyPanel`
  extraction; `held` never reaches the browser — the "Reply on hold" panel is
  reconstructed from `reply_state 'none'` + `row_action 'none'`.

One behavioural delta: **posted×held silently withdraws Regenerate** while
keeping the live Google reply visible. `orphan`×held keeps `recover` — the
affordance addresses the orphan incident, not the draft; *executing* recovery
against any non-terminal sibling still 409s `newer_draft_exists` (the
migration-029 index protection). This is the affordance half of map #710
item 1: #726 shipped the server half, #730 owns the predicate consolidation.

## Quick summary — Legacy Past Replies hold gates (2026-08-09, PR #735)

A moderation-held draft (invariant #4) is now unreachable through the legacy
Past Replies draft lane. Before this, three routes with zero
`flagged_responses` references would hand the owner held text plus Resume /
Discard affordances; only `/publish` carried the gate.

The new shape — four gates at the same locus as the publish gate:

- `src/app/api/dashboard/past-replies/draft-status/route.ts` — completed-poll
  lookup carries an inline correlated `EXISTS … status='open'` (D6 read-path
  spelling; `held-draft.ts` stays the semantic owner). Held →
  `{ status: 'failed', error: 'held_for_review' }`, never text, never an id.
  Tenant re-checks run first, so a cross-tenant caller learns nothing — not
  even heldness.
- `src/app/api/dashboard/past-replies/draft/route.ts` — the existing-draft
  branch locks the response row (`FOR UPDATE`, new) then calls
  `hasOpenFlag`; held → 409 `held_for_review` with no `existing` payload.
- `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts` — PATCH
  and DELETE both gate post-lock; held → 409, row untouched. DELETE keeps
  idempotent-204 for every non-held case.

Why it matters: this was the **launch blocker for `EDIT_REPLIES_ENABLED` in
production** (absent in prod today; `true` on staging). Deliberately NOT
here: the Reviews-list affordance remodel (#727) and the owner-facing
predicate consolidation (#730) — these four call sites migrate with #730
later by design.


Ticket #729 (wayfinder map #710, item 3). A behaviour-preserving design
correction: the **On-demand generation** `Generate` door's ~77-line transaction
no longer lives inline in the HTTP entry point. `POST
/api/dashboard/reviews/[reviewId]/generate` is now a pure composition root —
auth, rate limits, ownership proof, `sql.begin`, result→HTTP mapping — and the
transaction body (review lock, in-tx TOCTOU writable re-check,
posted/non-terminal/orphan exclusions, in-flight-outbox exclusion,
`MAX(version)+1` allocation, atomic `enqueueGenerateResponse`) is a deep module
with a one-function interface returning a typed refusal union. Invariant #3 is
untouched by design (map #710's D-H: no second auto-approval guard); the
`on_demand_generate` Origin lane pinning moved with the code, comments intact.

The new shape:

- `src/lib/reviews/on-demand-generate.ts` — `onDemandGenerateTx(tx, { reviewId,
  businessId })` → `OnDemandGenerateResult`; receives `tx` explicitly, never
  imports `@/lib/db/server` (invariant #15).
- `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts` — composition
  root only (invariant #12); HTTP contract byte-for-byte identical, including
  the pre-existing NO_STORE_HEADERS asymmetry. Only intentional observable
  delta: `on_demand_generate_enqueued` now logs post-commit.
- `scripts/ci/tenant-scope-allowlist.ts` — the three sibling reads are natively
  business-scoped in the module, so their 3 tenant-root-lookup entries are
  DELETED (`ALLOWLIST_BASELINE` 412→409, history narrative updated).
- `src/lib/shared/response-status-sql.ts` — `statusArraySql` widened one line
  to accept the caller's `sql`/`tx` client (postgres.js `TransactionSql` is NOT
  assignable to `Sql` — sibling interfaces; `SubscriptionSql` precedent).
- Eval: new 9-test module suite (`src/lib/reviews/__tests__/on-demand-generate.test.ts`,
  committed RED first); both #678 suites kept as the characterization eval with
  zero assertion changes.

## Quick summary — Live-DB helper scan (2026-08-08, PR #720)

**In one line:** `ci:live-db-suites` now reads every `.ts`/`.tsx` under
`__tests__/`, not just the suites vitest runs, so run-time DDL built inside a
test *helper* is caught in the file that builds it.

**What is true now.** The audit's file set is every git-tracked
`*.test.ts`/`*.test.tsx` **plus** every `.ts`/`.tsx` under a `__tests__/`
directory — four `git ls-files` pathspecs instead of two, which adds the 13
non-suite helper files the audit had never once opened. The two rules no longer
share an enforcement unit:

- **R1 (naming)** — a live-DB suite must be named `*.integration.test.ts` —
  applies to **suites only**. It is a claim about which vitest project a file
  lands in, and a helper renamed that way would just run as an empty suite.
- **R2 (no run-time DDL)** and the lock check apply to every live-DB **file**,
  suite or helper, because "does this statement take ACCESS EXCLUSIVE" is true
  wherever the statement was written.

**Why the widening was needed.** Postgres.js routes a nested `Query`
substitution through `fragment()` and splices it in as raw SQL *text*, not as a
bind value. So a helper can export `` sql`ALTER TABLE …` `` and a suite can
execute it as `` sql`${addCheck}` `` — the suite carries no DDL text of its own,
and #694's AST walk, which correctly visits the *producing* node, never opened
the producing file. Both would audit clean while the tree took ACCESS EXCLUSIVE
on `job_outbox`.

**How a helper is recognised as reaching the DB.** A helper is *handed* its
handle, so it names none of the suite-shaped `LIVE_DB_MARKERS` (the env var, or
an import of the resolve/gate/lock/schema-ready modules). What it cannot avoid
is *typing* that handle, so the helper marker is an import of `postgres` — in
either spelling: the `from 'postgres'` clause and the inline
`import('postgres').Sql` type, which carries no `from` clause and is already
this tree's idiom for handing a fake handle to something. It is deliberately
**not** offered to suites: a mock-shaping type import is not evidence that a
suite reaches a database, and admitting it would fire R1 across the tree on
files that touch no DB.

`src/lib/shared/__tests__/helpers/apply-migration-074.ts` was the one real
occurrence — it runs `db.unsafe(readMigration074Sql())` and had never been
audited. It is now on `MIGRATION_SHAPE_FILES` **and** lock-enforced against its
own `withMigration074ApplyLock`.

**The new shape**

| file | what it is |
|---|---|
| `scripts/ci/live-db-suites-audit.ts` | file set widened to four pathspecs; `isSuite` splits the enforcement unit; `HELPER_DB_MARKER` is the helper-only reachability route. Exported shape unchanged — 1 interface + 2 functions, same arity, same three-member `rule` union — only the names stop lying: `auditLiveDbSuite`→`auditLiveDbFile`, `listTestFiles`→`listAuditedFiles`, `LiveDbSuiteFinding`→`LiveDbFileFinding`, plus the two internal allowlists `MIGRATION_SHAPE_SUITES`→`MIGRATION_SHAPE_FILES` and `DDL_PROBE_SUITES`→`DDL_PROBE_FILES` |
| `scripts/ci/__tests__/live-db-suites-audit.test.ts` | 43 tests — the helper fixtures authored red against the new interface, and the pin on the inline `import('postgres')` spelling |
| `src/lib/shared/__tests__/helpers/apply-migration-074.ts` | **unchanged file, newly audited** — the single helper the widened scan actually catches |

**Two bounds remain**, both stated in the module: a DDL fragment built outside
`__tests__/` altogether (a `src/` module a suite imports), and the `e2e/`
Playwright lane, which owns its own database lifecycle.

**No** migration, **no** env var, **no** feature flag, **no** new file, **no**
new dependency, and no runtime surface — the whole change is one CI script and
its test file.

Three durable lessons in `lab-notes.md` under **2026-08-08 — #706**: the
technical one (an AST walk that visits the producing node is only as wide as its
file set), plus the two process lessons this ticket paid for — absolute claims
written about a narrow text-presence check, and the documentation multiplier on
a guard module whose prose is its spec.

## Quick summary — Legacy backfill counters dropped (2026-08-08, PR #716)

**In one line:** the four dead `gap_*`/`historical_*` counters are gone from
`zernio_backfill_runs`, which closes the Consented Review Import epic (#667).

**What is true now.** A backfill run row has exactly three counter columns:
`imported_count`, `skipped_count`, `oldest_skipped_create_time`. The four legacy
columns do not exist on either Supabase project — naming one raises 42703. They
had been frozen at DEFAULT 0 since #675; migration 103 removed them.

**Why it was a separate migration.** Migration 100 added the collapsed counters
and deliberately *kept* the legacy four, so that `git revert` of any epic PR
never left the deployed worker writing to a dropped column. That bought a clean
revert window for the epic's whole build-out. 103 spends it: **this is the point
of no return.** Reverting a pre-#675 PR against a post-103 schema now raises
42703, so ADR 0015 §4's revert-only backout is no longer sufficient.

**The interesting part is the gate.** Dropping a column destroys its values, so
the migration will not run against data whose collapsed counters disagree with
the legacy ones it is about to delete. That check is a `DO` block *inside* the
migration rather than a query in the header for an operator to remember —
because on clean data a broken guard and a working guard produce identical
evidence (zero abort rows), so a documented query proves nothing. It counts the
four columns: 0 → return (so 103 stays re-runnable), 4 → reconcile, any partial
state → raise.

The predicate is a two-branch disjunction, not the obvious `collapsed = legacy
sums`. The obvious form is wrong: a healthy post-#675 row carries a non-zero
`imported_count` with all four legacy counters at 0, so it reads as a mismatch.
Staging settled it at apply time — the preflight returned `unreconciled_two_branch=0`
and `unreconciled_naive=2`, meaning the naive form would have aborted the
migration on two perfectly good rows.

**The new shape**

| file | what it is |
|---|---|
| `supabase/migrations/103_drop_legacy_backfill_counters.sql` | lock, pinned `search_path`, the `DO` preflight, one four-column `ALTER` |
| `src/lib/shared/__tests__/migration-103-drop-legacy-backfill-counters.integration.test.ts` | pins the migration text exactly; runs its own guard against a `pg_temp` replica to prove both branches |
| `src/lib/shared/__tests__/migration-100-import-consent.integration.test.ts` | retargeted 7 → 3 columns; now proves only that the ADD half survived |
| `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` | legacy-counter guards KEPT, retitled to name 103 |

**No** env var, **no** feature flag, **no** production TypeScript change.

## Quick summary — Import consent enforcement locus + block reason (2026-08-08, PR #714)

**In one line:** we wrote down *why* the consent check lives in the worker rather
than in the database, and made a refused import visible in SQL for a week instead
of only in a log line.

### What prompted it

The adversarial review of #679 asked a fair question. `job_outbox` is a chokepoint
every producer shares — product code, the admin manual-SQL re-enqueue path, any
future producer — and it sits *before* dispatch rather than after. So why not
enforce **Import consent** there with a `CHECK` constraint or a `BEFORE INSERT`
trigger, and delete the per-worker guard? #695 files that challenge rather than
re-planning it.

### The answer: no trigger, no constraint, no migration

ADR 0016 declines it, and the decisive argument is not "business logic doesn't
belong in a trigger". It is that a trigger must **re-spell the derived-expiry
predicate** — `pending AND import_offer_expires_at <= now()` — in PL/pgSQL inside a
migration, and spec §5.3 exists to give that predicate exactly one owner
(`importConsentStateSql`). Stated honestly, because overstating it is how an ADR
loses its authority: a later migration *can* `CREATE OR REPLACE` the function, so
this is unenforced drift plus a two-environment deploy coupling, not literal
impossibility. Two more reasons: `job_outbox` is topic-agnostic infrastructure
shared by 32 topics, and an insert-time gate cannot see consent that changes
between enqueue and dispatch — so `guardImportConsent` survives either way and the
proposal buys two enforcement points to keep in sync, not one.

### What did ship: the observability half

A refused `zernio_initial_backfill` row now completes carrying
`job_outbox.completion_reason = 'import_consent_blocked'`, so a policy refusal is
separable by SQL from a genuine completed import. Before this, the only trace was
the log line plus the *absence* of a `zernio_backfill_runs` row. The column has
existed since migration 083, so there is no new migration.

**Read the marker's limits before trusting a query against it:**

- **It is an operational-window signal, not an audit record.** `ArchivalPoller`
  deletes completed `job_outbox` rows 7 days after `completed_at`, and a refusal
  completes rather than fails, so it takes the 7-day arm — the same life
  `owner_unreachable` has always had (ADR 0010). That is a property of the sink,
  not of this ticket. What outlives the window is `businesses.import_decision` /
  `import_decision_at`, plus the log line under the log sink's own retention.
- **No backfill of historical rows.** Refusals from before this change also carry
  NULL, so outside the post-deploy window NULL means "genuine import OR
  pre-deployment refusal" — ADR 0016's operator query carries a
  `created_at >= '<deploy timestamp>'` bound for exactly that reason.
- **ONE marker for all four refusal states.** It records THAT a refusal happened;
  the per-state detail (`pending` / `declined` / `expired` / `missing`) lives only
  in the structured log line, because re-reading `businesses` afterwards can
  disagree (a `pending` refusal the owner then accepts) or find nothing at all.
- **Nothing reads it in code** — no poller, no alert, no Sentry capture, no admin
  surface. A refusal is the guard working correctly, not an incident.

The new shape:

- `docs/adr/0016-import-consent-enforcement-locus.md` — the declined alternative,
  its consequences, and the operator query with its three stated limits
- `src/lib/shared/outbox.ts` — `markOutboxOwnerUnreachable` is **deleted** and
  generalized into `markOutboxCompletedWithReason(exec, outboxId, reason, attempt?)`
  (returns `void`), so the outbox seam stops growing one writer per reason
- `src/lib/shared/outbox-completion-reason.ts` — new `IMPORT_CONSENT_BLOCKED`
  member plus the exported `OutboxCompletionReason` union the writer takes
- `worker/jobs/zernio/job-eligibility.ts` — `guardImportConsent` stamps the reason
  on the SAME `tx`, inside its unchanged `sql.begin` + `businesses … FOR UPDATE`
- `worker/jobs/notification/NotificationWorker.ts` — call-site swap only;
  `owner_unreachable`'s persisted wire value is unchanged

**Deliberate non-goal:** `guardZernioJobEligibility`'s three skips (missing row,
archived location, failed subscription guard) still use plain `markOutboxCompleted`
and keep `completion_reason` NULL. They are not policy refusals.

## Quick summary — Reviews list + On-demand generation (2026-08-08, PR #712)

**In one line:** the owner can now see *every* review for a location on one page, and ask for a reply on any of them.

### What changed for an owner

`dashboard/reviews/history` used to show only reviews that already had a reply. It now shows all of them, and it is called the **Reviews list**. The tab reads `All Reviews` instead of `History`.

Rows are grouped `Unanswered` first, then `Answered`, newest first inside each group, 50 per page. Each row offers exactly one action, chosen by the server:

| Row state | What the owner sees |
|---|---|
| `generate` | `Generate` — expands the row inline to the draft with `Approve & post` |
| `regenerate` | `Regenerate` — opens the two-pane drawer, because publishing there **replaces** a live Google reply |
| `draft_ready` | a `Draft ready` cross-link to **Needs Action**, no Generate |
| `held` | a muted `Under review` marker — no button, no draft text, no cross-link |
| `generating` | `Generating…`, and it survives a page refresh |
| `recover` | the existing orphan recovery card, never Generate |

Answered rows carry a provenance badge so an owner never wonders where a reply came from: `Posted by you before joining`, `Replied on Google`, `Auto-approved`, `You approved`.

### The new shape

| File | Role |
|---|---|
| `src/lib/past-replies/load-replies.ts` | the single row source — `LEFT JOIN` + 4 LATERALs (live draft + its held flag, in-flight outbox, orphan sidecar, superseded text). The separate orphan query is **deleted**: under `LEFT JOIN` its `NOT EXISTS` disjointness was false, so orphans would have rendered twice and merged into every page. |
| `src/lib/past-replies/replies-view.ts` | `deriveRowState` (six states, precedence not preference) + `provenanceBadge`. The card **renders** a state; it never computes one. |
| `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts` | the Generate door — rate limit → tenant lookup → writable-subscription → budget peek → in-tx guards → `enqueueGenerateResponse` |
| `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts` | polls by `reviewId` (not `outbox_id`, which a refresh loses), account-scoped, **not** gated on `EDIT_REPLIES_ENABLED` |
| `src/components/dashboard/reviews/useInlineGenerate.ts` | the client state machine: POST → poll → settle |
| `src/lib/shared/worker-types.ts` | one new **Origin lane**, `on_demand_generate` |

### Why a Generate draft can never auto-post

`isAutoApprovalCandidate` requires `live_ingest_new`. A Generate draft is version 1, so the **Origin lane is what excludes it** — structurally, not by a second guard the ticket explicitly forbade. `suppress_notification: true` is belt-and-braces. The protection is the whole typed chain: producers must supply a typed lane, the enqueue helper serialises it, and an unknown runtime value normalises **fail-closed** to `null`.

### Flag change

`PAST_REPLIES_VIEW_ENABLED` is **retired — deleted, not flipped**. Once the Reviews list is the consented **Review import**'s only destination, the flag would let `import_decision='accepted'` coexist with the imported reviews landing on a `notFound()`. `EDIT_REPLIES_ENABLED` is kept: it gates the live-Google mutation, a larger risk, and is now its sole gate.

**Revert precondition:** reverting restores the flag *read*, so the var must exist before a reverted build boots. Production and staging carry it; **Vercel Preview does not**.

### Known gaps — filed as #710, do not assume settled

The legacy Past Replies draft lane returns moderation-held draft text with no hold check (pre-existing; #678 made it visible by getting its own poller right), `deriveRowState` gives a posted reply precedence over a held replacement draft, the deferred Generate/live-ingest race can persist a draft for stale review text, and the held-draft predicate has ≥8 hand-spelled sites rather than the 3 recorded.

---

## Quick summary — Import consent analytics sink (2026-08-08, PR #708)

**In one line:** when the counter for "we offered an import / the owner answered"
fails to record, somebody now finds out.

### What was actually wrong

A previous fix (#679) made a good trade. Recording those two counters happens
*inside* the transaction that connects a Google Business Profile, and if the
recording failed it used to take the whole connection down with it — no owner
with an active subscription could connect at all. #679 wrapped the recording so a
failure costs only the number, never the connection.

The bill for that trade was never paid. The failure was written to the server's
log output, and **nothing reads that log**. The alerting this project actually
uses is Sentry. So if the counter started failing — the realistic cause is a
database update we forgot to apply — it could quietly under-report **forever**
and no one would know. The numbers would just be wrong, and they'd look fine.

### What changed

The failure is now also sent to Sentry, tagged so an alert can be pointed at it.
Three things about how, each deliberate:

1. **It's a "warning", not an "error".** Nothing broke for the customer — the
   connection worked, the owner's answer was saved, only the tally was lost. This
   should be something an operator reads, not something that wakes them at 3am.
2. **The signal is repetition, not the first event.** All of these reports look
   identical to Sentry, so they pile into one entry. An alert set to "tell me
   when this is new" would fire once and then never again — exactly wrong. Both
   alerting documents now say to alert on *frequency* instead.
3. **The alert cannot break the thing it's watching.** Sending to Sentry is
   itself wrapped, because a reporting failure escaping here would recreate the
   original connect outage. The log line stays *outside* that wrapper, so if
   Sentry is unreachable there is still one record left.

### The new shape — what got added

```text
# No new files. One catch block and its documentation:
src/lib/reviews/import-consent.ts   ← the guarded Sentry capture beside the existing log line

# Two alerting documents gained the same checklist item (the tag to route on):
docs/runbooks/beta-launch-alerting.md   ← §1, with the "alert on frequency" reasoning
docs/launch-checklist.md                ← the pre-first-customer inventory

# Tests: 4 new titles in an existing suite
src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts
```

### One thing to remember

**The signal is durable but not yet paged.** Creating the Sentry alert rule is a
dashboard action nobody has done — until it exists, the failures are recorded and
searchable but will not reach Discord. That checklist item is in both documents
above. Everything else was proven against the real staging stack, including
deliberately making the recording fail (without changing any database schema) and
watching the tagged issue arrive.

## Quick summary — Live-DB DDL detector (2026-08-08, PR #705)

CI/test tooling, not product. No runtime code, no migration, no flag. Sibling of
#696: both are checks that other features' correctness claims rest on.

`ci:live-db-suites` rule R2 forbids run-time DDL in a live-DB suite, because
DDL's ACCESS EXCLUSIVE locks deadlock sibling suites in concurrent vitest
processes (40P01, #573). It was implemented as a **proxy for the thing** — the
file happening to name `supabase/migrations` next to a `.unsafe(`. The proxy held
only as long as the correlation did, and nothing tested the correlation.

The cost was not hypothetical: a suite forced a transaction abort by adding a
temporary CHECK constraint to `job_outbox` and dropping it in a `finally`. **A
vitest timeout skips the `finally`.** The constraint stranded on the shared test
container and blocked every suite that enqueues `zernio_initial_backfill` — 14
spurious failures across three suites, none of them code defects.

The new shape:

| File | What it owns now |
|---|---|
| `scripts/ci/live-db-suites-audit.ts` | AST extraction of **executed SQL** — every tagged template and `.unsafe()` call — with the DDL-verb match over extracted text only, SQL comments blanked to equal-length whitespace so offsets survive. Fail-closed on an unreadable `.unsafe()` argument, including a template whose substitution stands where a statement begins. `DDL_PROBE_FILES` joins `MIGRATION_SHAPE_FILES`; both are lock-enforced. Same exported shape — deepened, not widened. (Constants renamed from `*_SUITES` at #706, which widened the audited set to every `.ts`/`.tsx` under `__tests__/`, helpers included, and renamed all three exports: `auditLiveDbSuite`→`auditLiveDbFile`, `listTestFiles`→`listAuditedFiles`, `LiveDbSuiteFinding`→`LiveDbFileFinding`.) |
| `src/lib/shared/__tests__/helpers/abort-injection.ts` | **New.** `abortingExecutor(base, poison)` — a Proxy over a real `Sql` that runs the writer's transaction then poisons it with a REAL Postgres error. Holds no schema, takes no ACCESS EXCLUSIVE, strands nothing on timeout. Two callers. |
| `src/lib/shared/__tests__/helpers/schema-ready.ts` | `MIGRATION_083_OUTBOX_OWNER_UNREACHABLE` — the two suites that bootstrapped that column with `ALTER TABLE … IF NOT EXISTS` now assert it, so a behind-head DB fails loudly instead of self-healing. |

**No tag-name allowlist**, and that is the load-bearing design call: `sql()` is
the plurality of tagged templates in these suites and its tag is a
`CallExpression`, so reusing `SQL_TAG_NAMES` would have shipped this ticket's own
defect one layer down (#592's shape). `sql-tag-scan.ts` is imported for
`lineHasPragma` only and left byte-identical.

Seven real DDL sites, not the ticket's three — three fixed, two allowlisted, three
pragma'd, four already correct. `migration-091` had been executing probe DDL on
no allowlist at all, so its lock enrolment had never been checked.

The bound this ticket filed — DDL in a fragment built inside a `__tests__/`
helper — is **CLOSED at #706, PR #720**. Full record in the *Live-DB helper
scan* section above.

Durable lessons in `lab-notes.md` under **2026-08-08 — #694**, plus two topical
entries: Postgres.js splicing a nested `Query` as raw SQL (not a bind value), and
why an exact count in a comment is a maintenance trap.

## Quick summary — Verify-gate row identity (2026-08-08, PR #701)

Workflow tooling, not product. No runtime code, no migration, no flag — but it
is the check every other feature's "GATE: GREEN" claim rests on, so it is state
worth knowing.

`scripts/verify-gate.sh` gave each dynamic row a name by truncating a string to
40 characters. That name is not just a label: it is the row's slot in the
results table, its `.feature/logs/<name>.log`, and — for integration rows — its
coverage directory. Two inputs sharing a 40-character prefix therefore shared
all three. `src/lib/reviews/__tests__/import-consent.integration.test.ts` is
**exactly** 40 slug characters, so every `import-consent-*.integration.test.ts`
sibling collided with it. #679 hit this and worked around it by renaming its
extracted suite.

The visible symptom was a spurious RED (two vitest processes racing one coverage
directory to an `ENOENT`). The reason it was worth its own ticket is the other
direction: **a shared status slot can record PASS for a suite that FAILED.**

The new shape:

| File | What it owns now |
|---|---|
| `scripts/gate-rows.sh` | **New.** `row_slug` — readable truncated prefix + a 6-char hash of the full input, so truncation is for reading and the hash is for identity. `assert_unique_row_name` — a collision can never resolve silently. Its own sourceable file because bash has no in-file unit-test seam: sourcing `verify-gate.sh` runs the gate. |
| `scripts/verify-gate.sh` | Both slug sites route through `row_slug` (the integration row **and** the `verification_commands` row — the ticket named only the first). `launch()` asserts uniqueness before registering; the rejected-destructive-extra path, which never reaches `launch`, asserts its own. `gate_abort()` is now shared with the db-provision failure path and is defined **above** everything that can fail, including the `source` line. |
| `scripts/ci/__tests__/gate-rows.test.ts` | **New.** 10 tests. Three run the *real* `launch`/`gate_abort` bodies extracted from `verify-gate.sh`; one runs the real gate with its library removed. Mutation-verified — six mutations, all killed. |

Renaming a suite to dodge the prefix is no longer a constraint. Three durable
traps from this one are in `lab-notes.md` under **2026-08-08 — #696**: a
"is it wired?" test asserting source *text* is the same defect class as the bug
it guards; `exit` in a *sourced* bash file kills the caller (here, before the
gate could overwrite a stale-green `gate-status.json`); and `"${ARR[@]}"` on an
empty array is fatal under `set -u` on bash 3.2, which is what
`/usr/bin/env bash` is on macOS.

## Quick summary — Reviews list surface + on-demand cost policy decided (2026-08-08, PRs #700/#702)

Both remaining **decision** tickets on map #667 are resolved, so **#678 — the
Reviews list — is fully unblocked** and is the last implementation ticket before
the closing cleanup (#680). Neither decision invented machinery; both resolved
into things the codebase already had.

**#671 — the Past Replies archive BECOMES the Reviews list** (PR #700, docs
only). `dashboard/reviews/history` is widened in place — it neither stays as a
distinct surface nor retires, which also closes the map's long-standing "fate of
the Past Replies archive" fog. Two asymmetries in shipped code decided it rather
than taste: imported **answered** reviews already land in History today
(`ZernioBackfillWorker.ts:364` → `reconcileExternallyAnsweredReview({
consentedImport: true })` writes the `posted` row `load-replies.ts:117` selects)
while imported **unanswered** reviews land on **no surface at all**; and
`dashboard/reviews` is an action *queue*, not a list — `ReviewFeedCard.tsx:59-66`
filters to `pending_approval` off a `LIMIT 10` cached payload, so an imported
review can never appear there. The core change is consequently `JOIN` →
`LEFT JOIN`. Seven decisions in spec §6.3a: `Needs Action` survives distinct (a
pending-draft row appears in **both**, as a `Draft ready` cross-link with no
`Generate`); the gap/historical split is deleted for a per-row provenance badge;
`PAST_REPLIES_VIEW_ENABLED` is **retired at #678** (else `accepted` consent could
coexist with a `notFound()`) while `EDIT_REPLIES_ENABLED` is kept; `PAGE_SIZE`
stays 50; unanswered first then newest-first within; `Generate` inline,
`Regenerate` in a two-pane drawer whose primary action reads *Replace reply on
Google*.

**#672 — on-demand generation cost policy** (PR #702, **no migration**). The
mechanism already existed in full: the per-owner rate limiter, the per-review
regen budget and the per-business/global cost reservation are **already
composed** in `reviews/[reviewId]/regenerate/route.ts` — the same route #669
named as the Generate door's target — so #678 inherits the stack by wiring. "Per-
review cap or per-account cap?" resolves to **both, already built**, with the
per-account axis denominated in **cents, not clicks**. Four decisions in spec
§6.3b: **C1** the first `Generate` is free by construction — `generate-draft.ts:106`
charges only `version > 1`, so the axis self-arms into *one free draft then three
charged regenerations per review per day*, and the guard stays because it is what
stops the live lane's own auto-draft from eating the owner's budget; **C2**
`BURST_MAX` **5 → 10** with `HOUR_MAX` held at 30 — the hourly layer is the spend
bound (30 × the 15¢ reserve ≈ $4.50/hr) and the burst layer only stops a
click-storm, so worst-case hourly spend does **not** move; **C3** all three doors
share ONE counter, so alternating `Generate`/`Regenerate` cannot double
throughput; **C4** live-lane starvation is **real** — on-demand and live ingest
share `cost:daily:{businessId}:{date}` and exhausting it *terminally drops* a
draft (`alertCostCapExhausted` pages Sentry, gate B3) — but is resolved as a
**ceiling-sizing constraint** recorded on `DAILY_COST_LIMIT_CENTS_COPILOT` /
`_AUTOPILOT`, not a reserved floor nobody can tune without production data.
**Still open operationally: both ceilings are required-with-no-default and
remain unset — they must be chosen before GA.**

## Quick summary — Import consent worker guard (2026-08-08, PR #698)

#677 made every **product** path ask for consent. #679 makes the *worker* refuse
to run without it — which is a different guarantee, and the one that actually
holds when something skips the product path.

Until now a `zernio_initial_backfill` row inserted by hand — by an admin, by a
future producer nobody remembered to gate, by a bug — imported a customer's
review history with no consent on record. ADR 0015 §3 accepted that gap
explicitly, on the reasoning that production holds zero customers. That
reasoning expires the moment a real customer onboards, which is why this was the
release constraint #675 and #677 both carried. It is now discharged.

**The guard proceeds only on `accepted`.** `pending`, `declined`, derived
`expired` and a missing `businesses` row all no-op-complete with a logged
reason. Because every enqueue producer converges on this one worker, the
chokepoint covers the admin path too — D8's "admin path included" now holds
structurally rather than by convention.

**Three decisions worth knowing before you touch it:**

- **It is a separate function, not a `jobKind === 'backfill'` branch inside
  `guardZernioJobEligibility`.** A merged guard would have two callers, one of
  which must never reach consent code. Splitting makes live-ingest independence
  structural instead of a runtime branch a future edit can flip.
- **The whole body runs inside `sql.begin` with `SELECT … FOR UPDATE` and
  `markOutboxCompletedWithReason(tx, …)`** (plain `markOutboxCompleted` here until
  #695 added the block reason) — correctness, not tidiness. Without
  serialization the guard reads `pending` from an in-flight row, the owner
  accepts, the acceptance's in-flight dedup sees that row and inserts no
  replacement, and the guard then completes it: `accepted`, no completed run, no
  runnable outbox row. Silent permanent loss for a customer who said yes.
  `FOR UPDATE` is a no-op outside `sql.begin()` under transaction pooling, so
  both halves are load-bearing. Lock order is business-before-outbox, matching
  all four other writers.
- **Expiry is derived in Postgres via the shared `importConsentStateSql`
  fragment**, imported and never re-spelled — which is why the query must alias
  `businesses` as `b`. Reading the deadline into JS would be a second spelling
  of the predicate *and* would drag a `Date` across the boundary postgres.js
  truncates to milliseconds.

**Every skip is skip-as-success.** The outbox row is completed — never failed,
thrown, or retried — so a declined or expired import cannot churn the queue
forever.

Migration **102** also registers the two **Import offer** analytics events #677
deferred here (its non-goals forbade a migration): `import_offer_created` and
`import_decision_recorded`, both emitted from inside their writing transaction
under a SAVEPOINT. That savepoint matters more than it looks — before it, an
unapplied 102 raised `23514` inside `finalizeConnectionTx`, and
`select-location/route.ts` rethrows non-`23505`, so a missing migration broke
Google Business Profile connect *entirely*. It now costs a lost metric and a
`warn`. The deploy ordering is still load-bearing, not optional (**#697** is the
missing durable sink for that swallowed warning).

**The new shape:**

| File | Role |
|---|---|
| `worker/jobs/zernio/job-eligibility.ts` | `guardImportConsent` — the fail-closed gate; still owns `guardZernioJobEligibility` for both Zernio workers |
| `worker/jobs/zernio/ZernioBackfillWorker.ts` | call site, before the run-row INSERT |
| `src/lib/reviews/import-consent.ts` | the two savepoint-wrapped emissions, in the writers |
| `supabase/migrations/102_import_consent_analytics_events.sql` | the CHECK allowlist superset |
| `src/app/admin/runbook/page.tsx` | A5 re-enqueue now conditioned on `accepted` |

Filed, not fixed here: **#694** (a `ci:live-db-suites` detector keying on an
incidental marker), **#695** (enforce at the `job_outbox` boundary instead of
per-worker), **#696** (`verify-gate.sh` truncating row slugs to 40 chars so
colliding rows share a status file — **CLOSED at PR #701**, see the summary at
the top of this file), **#697** (the swallowed emission reaches no durable or
paged sink).

## Quick summary — Import offer (2026-08-07, PR #691)

#675 made the import consented and bounded but left nobody able to say yes.
#677 ships the asking: the **Import offer**, and the decision that answers it.

**The offer is created at the junction, server-side, in a transaction** — not
lazily on first render. `createImportOffer` proves BOTH junction halves in its
own SQL (activation non-NULL **and** an active `zernio_connections` row),
because the callers do not check, so the helper must. The deadline is
`now() + 7 days` **at creation**; there is no junction anchor — anchoring was
self-invented, produced two High findings across two review rounds, and was
deleted by owner adjudication.

**An offer is answerable only while it exists and is live.** The guarded
transition requires `pending AND import_offer_expires_at IS NOT NULL AND
> now()`. That `IS NOT NULL` is load-bearing: migration 100 defaults every
business to `pending` with a NULL deadline, so the default is deliberately NOT
an offer — without the guard a direct POST could manufacture consent for a
location nothing was ever offered for.

**The banner carries `offer → importing → outcome → gone`** and sources its own
state from `GET /api/dashboard/import-offer`, never the Redis-cached dashboard
payload — otherwise a declined offer would keep re-rendering for the whole TTL.
The GET also **self-heals**: if the junction-time write failed, the first
dashboard render repairs it, and a repaired offer starts a fresh 7 days.

**The new shape**

| File | Role |
|---|---|
| `src/lib/reviews/import-consent.ts` | single owner of the derived-expiry predicate and every consent write; also the one `enqueueInitialImport` |
| `src/lib/reviews/import-offer-view.ts` | the banner's read model, scoped to `run_reason='initial'` |
| `src/app/api/dashboard/import-offer/route.ts` | GET (state + self-heal) / POST (accept \| decline) |
| `src/components/dashboard/account-state/ImportOfferBanner.tsx` | the prompt; copy locked verbatim |
| `finalize-tx.ts`, `stripe/shared.ts`, `archive-location-tx.ts`, `add-location-tx.ts` | the four gated producers + consent lineage |

**Consent is inherited on re-add, but never a live deadline.** Re-adding a
location whose archived row declined or let the offer expire does not re-offer
the import. The past deadline IS copied so the new row still derives expired; a
**live** deadline is left NULL so the new row earns a fresh offer at its own
junction — copying it would have presented an answerable offer for a location
with no connection.

**Closed at #679 (PR #698):** enforcement was at the four producers, not at the
one chokepoint every path shares, so a hand-inserted `zernio_initial_backfill`
row still imported without consent. `guardImportConsent` now covers that
chokepoint. The offer's analytics events also moved to #679 — the
`analytics_events.event_name` CHECK needed a migration this ticket's non-goals
forbade — and shipped there as migration 102.

## Quick summary — Consented review import (2026-08-06, PR #689)

#673 built the consent schema, #674 made `importReview` draft-free. #675 makes
the import itself **consented and bounded**: `ZernioBackfillWorker` is rewritten
from the auto-drafting 50-cap backfill into the consented Review import
executor.

**Selection is a pure function over the Import window.** `selectImportWindow`
keeps reviews whose `createTime` falls in `[now − 12 months, live-ingest
cutoff)`, sorts newest-first, and takes at most 100 — whichever of the ceiling
or the floor binds first wins. The upper bound is the point: everything at or
above the cutoff (`connected_at − 5 min grace`) belongs to the live lane
(webhook + recent poller), everything below it to the import. The two lanes are
**disjoint by construction**, so a review the import stores can never be one
the live lane owed a draft for — the #674 lost-draft hazard died structurally,
not by guard.

**Nothing is auto-drafted.** Unanswered reviews store via `importReview` — no
`generate_response`, no notifications, no `job_outbox` writes at all. Answered
reviews become list rows via `reconcileExternallyAnsweredReview({
consentedImport: true })`: review row + imported `posted` response, regardless
of `EXTERNAL_REPLY_IMPORT_ENABLED`.

**Counters collapsed, pagination loud.** Runs write only `imported_count` /
`skipped_count`; the four `gap_*`/`historical_*` counters froze at 0 from #675
and were **DROPPED by migration 103 at #680** (2026-08-08, both projects) — they
no longer exist, and naming one raises 42703. Paging is capped by
`ZERNIO_IMPORT_MAX_PAGES` (default 6);
cap exhaustion with the target unmet fails the outbox row **terminally**
(`ZernioImportPaginationCapExhaustedError` + Sentry, `completed_at` stays NULL
so ops can bump the cap and re-enqueue) — the old worker truncated silently. A
non-descending provider page disables both early stops and the run pages to
feed end, best-effort (observed live on the staging sandbox — that lane is the
norm there, not the exception).

**The new shape:**

- `worker/jobs/zernio/ZernioBackfillWorker.ts` — the import executor +
  `selectImportWindow` (pure) + the terminal cap error
- `worker/jobs/zernio/zernio-ingest-shared.ts` — `liveIngestCutoff` (single
  owner, shared with the recent poller), reconcile's `consentedImport` option,
  `phiGateAndImportExternalReply`
- `worker/background/pollers/ZernioRecentReviewPoller.ts` — delegates its
  recency boundary to `liveIngestCutoff` (grace complementarity)
- `CONTEXT.md` — **Import window** and **Live-ingest cutoff** glossary terms
- Release constraint **DISCHARGED**: the enqueue gates shipped at **#677**
  (PR #691, which absorbed #676) and the fail-closed
  `import_decision='accepted'` pre-flight at **#679** (PR #698).

## Quick summary — Manual suppression paths (2026-08-05, PR #659)

#643 built the Suppression ledger, #644 gave recipients a way in. #645 gives
**humans** a way in — and, crucially, a way to fix a mistake without inventing a
re-subscribe.

**Three manual paths, two very different acts.**

- **Admin manual entry** (§7.3). Someone replies "stop emailing me" to the
  mailbox instead of clicking the link. An admin records it at
  `/admin/suppressions` — `scope='global'`, `source='admin_manual'`, with a
  required *originating message reference* so the entry is auditable ten business
  days later. Re-entering the same address is a **no-op success**, not an error:
  first-write-wins means the state is already correct.
- **The Correction path** (§8.2). The one that needed the most care. An admin
  typo, or a `provider_suppressed` mirror that came from the transactional side,
  produces a suppression that is simply *factually wrong* — and "no re-subscribe,
  ever" without a fix path means the answer to "please put me back" is "we
  cannot, ever", which is a worse story than the rule was avoiding. So: admin-only,
  audited, framed everywhere as **error correction, never re-subscribe**. No owner
  entry point, no recipient entry point, no self-serve anything.
- **Owner do-not-contact** (§7.5/§7.6). An owner marks their own customer
  "don't contact" on `/dashboard/requests/contacts`, and can clear it again. This
  writes `scope='account'` — never `global`, because a global row would let one
  owner silently degrade every other tenant's reach with no recipient having
  spoken.

**The two acts are deliberately not interchangeable.** A Correction is a
compliance record and lands in `solicitation_suppression_corrections`
(migration 098). Owner clearing is an owner changing their mind about their own
customer and lands in `account_audit_log`. Different act, different sink. An
owner may **never** clear a `global` row, and the UI does not render the control
for one at all — not greyed out, absent.

**Why a correction cannot lose its audit record.** `correctSuppression` is a
single data-modifying CTE whose `DELETE … RETURNING` feeds the `INSERT`. The
removal cannot commit without the record even if a call site forgets a
transaction, and a row that is already gone returns `not_found` rather than
writing an orphan. The record snapshots the removed row's handle, account,
original creator and note — the evidence that the assertion being corrected was
legitimate when it was made. `reason` is `NOT NULL` with a
`reason ~ '[^[:space:]]'` CHECK, so a blank "why" aborts the whole statement and
**the opt-out survives** (a tab-only reason defeats the obvious
`length(btrim(...)) > 0` spelling — one-argument `btrim` strips spaces only).

**The new shape**

| Path | What it is |
|---|---|
| `supabase/migrations/098_solicitation_suppression_corrections.sql` | The §8.2 audit sink. No FKs — a compliance record must outlive every referent it names. RLS deny-all, zero policies. |
| `src/lib/admin/suppressions-service.ts` | `lookupSuppressions`, `recordAdminManualSuppression`, `correctSuppression` (the one CTE). Cross-tenant, `ci:tenant-scope`-allowlisted. |
| `src/app/admin/suppressions/{page,SuppressionsClient}.tsx` | The §7.2 servicing surface under **Safety**, AAL2-gated. Fetches nothing on load — there is deliberately no browsable list of every opted-out recipient. |
| `src/app/api/admin/suppressions/{route,lookup/route,correct/route}.ts` | Three POSTs. Lookup is a POST *for a read* on purpose: §9.5 forbids logging the raw handle and a query string is logged by construction. |
| `src/app/api/admin/suppressions/_guard.ts` | Shared body parsing only. The AAL2 gate stays spelled out in each route so `ci:admin-aal2` can still see it. |
| `src/app/api/dashboard/contacts/[id]/suppression/route.ts` | Owner POST (mark) / DELETE (clear), both through `withScopedContact`. |
| `src/lib/solicitation/suppression.ts` | Gains the §7.4 display seam — a closed four-key object, so `account_id` and `source` cannot reach an owner surface. |

**Flags:** none. Deliberately not flag-gated — a statutory 10-business-day
obligation behind a feature flag is a violation waiting for a flag flip.

## Quick summary — Unsubscribe opt-out path (2026-08-03, PR #654)

The Suppression ledger #643 built now has its **first writer**. A recipient who
wants out can actually get out, by either of the two routes the law and the mail
ecosystem expect — and both work today even though nothing is sending yet.

**Two entry points, one outcome.** A mail client's one-click button POSTs to
`/ingress/unsubscribe/<token>` on the Railway worker (RFC 8058); a human clicking
the link in the message lands on `/u/<token>` on Vercel, reads a sentence, and
presses one button. Either way the result is the same `scope='global'` row in
`solicitation_suppressions` — the two differ only in the `source` they record.

**The ordering is the whole design: claim first, then suppress.** One statement —
`UPDATE … SET redeemed_at = NOW() WHERE token_hash = $1 AND redeemed_at IS NULL
RETURNING account_id, normalized_handle, channel` — is the single write-ordering
primitive, and the suppression is written from the provenance *that statement
locked*. Doing it the other way round lets a replayed spent link silently undo an
audited Correction path removal, and lets a concurrent account purge write a row
carrying stale provenance.

**A spent token is not proof of a live suppression.** `redeemed_at IS NOT NULL`
proves only that it was *once* redeemed. The Correction path can remove the row
afterwards, so the spent branch reads the ledger explicitly; with no live global
row the outcome is `already_redeemed_not_suppressed`, which mints no receipt and
deliberately does **not** re-suppress.

**Nothing claims success without checking.** The success page is gated by a
server-minted HMAC **and** a live ledger read taken during that same render —
necessary and sufficient are different things here. Three separate adversarial
findings were all one root cause: asserting a fact about mutable ledger state
from evidence decoupled in time from it. An unknown, malformed or already-used
token gets the **Neutral page** — one identical render, so no caller can tell the
three apart.

**Honest failure over a comfortable lie.** A token that does not resolve returns
`503`, not a success-shaped no-op, because reporting success on a mint race is
precisely the lost opt-out this work exists to prevent. Forged tokens are
self-authenticating failures — they open **no database connection** on either
surface.

**Two live bypasses closed on the way past**, both pre-existing and both affecting
Stripe, Resend, Telegram, Twilio and Zernio equally: percent-encoded ingress paths
(`/%69ngress/resend`) and absolute-form request targets. The second was invisible
to the entire test suite because `app.inject()` normalises the request target;
it took a raw-socket test to see it.

### The new shape

| Path | What it owns |
|---|---|
| `src/lib/solicitation/unsubscribe.ts` | Token mint/gate/hash, the claim-first redemption, the Success receipt, the boot assertion |
| `worker/ingress/unsubscribe.ts` | RFC 8058 one-click route, the 60s unknown-token aggregate, the single-flight |
| `worker/ingress/rate-limit.ts` | Both ingress-scope arms + the statutory exemption |
| `worker/config/fastify-options.ts` | Request-serializer + censor so a raw token never reaches a log or Sentry |
| `src/app/(public)/u/[token]/page.tsx` | Button / success / Neutral render states |
| `src/app/api/u/[token]/route.ts` | Form POST → 303, mints the receipt |
| `src/lib/shared/sentry-scrub.ts` | Generalised path redaction covering encoded spellings |

**Not built, deliberately:** nothing mints these tokens yet — that is #630, the
sender. `SOLICITATION_UNSUBSCRIBE_MAILTO` is unset, so the Neutral page omits the
mailto line rather than advertising an address nobody services; setting it creates
a §7.2 daily servicing obligation. Follow-ups **#651** (dedicated bounded DB pool)
and **#652** (`redeemUnsubscribeToken` owns its transaction) are filed with context.

## Quick summary — Suppression ledger: schema + domain core (2026-08-03, PR #647)

A recipient's opt-out is now a **record the system holds**, not a flag on a contact
row that a re-upload can wipe. `solicitation_suppressions` (migration 096) stores one
row per opt-out keyed on the **normalized handle per channel** — never on the contact
row id — so deleting a contact and re-uploading the CSV cannot launder it. Rows are
first-write-wins: a `complaint` arriving after an `unsubscribe_link` leaves the earlier
row alone, because the state is already correct and the history belongs in the provider
webhook records. There is **no expiry, ever** — a TTL on an opt-out is a compliance
violation with a cron job attached.

Two scopes, and the distinction is about *who spoke*, not how widely it applies.
`global` is the recipient's own opt-out (or the mail ecosystem's on their behalf) and
holds across every tenant, which is defensible because all mail leaves one shared
sender. `account` is the owner's own do-not-contact list. Making `account` rows global
would let one owner silently degrade another's reach with no recipient having said
anything, so the pairing is enforced by a database CHECK rather than convention. When
both match, **global wins** — reporting the account row would let an owner clear it,
watch the contact stay suppressed, and have no idea why.

**Nothing writes to the ledger yet.** The writer (`recordSuppression`) ships with zero
production callers on purpose: its `ON CONFLICT` predicates must match two partial
unique indexes byte-for-byte, and shipping it alongside the indexes proves that against
a real database instead of three tickets later. #644 (redemption), #645 (manual paths)
and #627 (webhook sources) land the first real callers. **Zero suppression rows and
zero `solicitation_suppressed` events is the expected steady state, not a failure.**

The batch build already *reads* it. `loadCandidateWindow` stamps each candidate with
its suppression state via a LATERAL join and `evaluateAsk` owns the withhold decision —
**populate, do not pre-filter** — so the shipped `suppressed` gate is live code from
day one rather than a branch that never executes. And attestation never overrides
suppression: consent is the owner asserting a relationship, suppression is the
recipient revoking one, and the second outranks the first permanently.

Unsubscribe tokens (`solicitation_unsubscribe_tokens`, same migration) are a dedicated
table rather than a column on the ask, so redemption still works after the sender is
gone. Only the SHA-256 hash is stored, now enforced by a format CHECK rather than
asserted in a comment. Through an account purge the row **survives with its provenance
scrubbed to NULL** — the mechanism outlives the account that minted it, because
honouring the opt-out matters and knowing which dead account sent it does not.

**The new shape**

| Path | Role |
|---|---|
| `supabase/migrations/096_solicitation_suppressions.sql` | Both tables: 2 partial uniques, 2 account-leading indexes, source/scope CHECK pairing, provenance-scrub implication, `token_hash` format CHECK, RLS deny-all |
| `supabase/migrations/097_suppression_analytics_events.sql` | Registers `solicitation_suppressed` + `solicitation_suppressed_at_dispatch` in the event-name CHECK |
| `src/lib/solicitation/suppression.ts` | Domain core — closed enums, `suppressionMatchSql` (sole owner of the lookup), first-write-wins `recordSuppression` |
| `src/lib/solicitation/batch-builder.ts` | Populate seam — LATERAL join stamps `candidate.suppression` |
| `worker/jobs/account-offboarding/purge-stages.ts` | Retention: global rows survive with `account_id`, account rows hard-delete, token provenance scrubbed |
| `src/lib/account-offboarding/purge-verification.ts` | Two-armed verification incl. the cross-account tripwire |

## Quick summary — Consent ledger: attestation v2 + per-handle consent state (2026-08-01, PR #640)

Solicitation consent is now a **ledger lookup, not a tautology**. Before #625, every
contact whose upload carried an attestation counted as "consented" (`consent_attested`
was always true) — and re-uploading a CSV whose visits all deduped left contacts
permanently ineligible (the spec §1.2 trap). Now: uploading a CSV writes one
`solicitation_consent` row per retained email (inside the same ingest transaction),
send-eligibility means "covered by an attestation version in
`SEND_ELIGIBLE_ATTESTATION_VERSIONS`" (v2 only — the new checkbox text actually names
email sending and opt-outs), and a re-upload upgrades consent even when every visit
dedupes. Contacts with no ledger row (the whole pre-#625 cohort, no backfill by
decision) or only-v1 coverage withhold `no_consent` with typed case (a)/(b) evidence.
Consent rows hard-delete with their contact and on offboarding purge (explicit sweep —
businesses are tombstoned, so the FK cascade never fires on purge); revocation stays
in #621's suppression ledger. Staging-proven end-to-end (14-point smoke on PR #640),
migrations applied to both Supabase projects in lockstep.

The new shape:

- `supabase/migrations/093_solicitation_consent.sql` — the ledger (RLS deny-all, monotone upsert scope, no user FK); `094_consent_analytics_events.sql` — event_name CHECK gains the two consent events; `095_consent_business_index.sql` — compliance-delete index
- `src/lib/solicitation/attestation.ts` — v2 text + `SEND_ELIGIBLE_ATTESTATION_VERSIONS`
- `src/lib/solicitation/ingest.ts` — `upsertConsent` (§4.2 guarded monotone upsert, the ledger's only writer) + `consentEligibleEmail` (§7.1 deletability guard) + the two analytics events
- `src/lib/solicitation/batch-builder.ts` / `restraint-policy.ts` — ledger-derived consent, `no_consent` case (a)/(b) evidence, policy `.3`
- `src/lib/solicitation/contacts-repo.ts` — contact delete sweeps consent by handle in-tx
- `worker/jobs/account-offboarding/purge-stages.ts` (+ `purge-helpers.ts`, `table-disposition.ts`) — explicit `solicitation_consent` purge sweep, `must_be_absent` verification

## Quick summary — Solicitation watch-mode shipped: map #528 destination reached (2026-07-26, PRs #554–#575)

Phase 2a of the Solicitation roadmap (design doc §9.2) is COMPLETE. The agent
runs end-to-end on staging in watch-mode: owner uploads a customer CSV (with
blocking consent attestation) → the run engine builds a batch as parent/child
runs on the spine → the restraint policy decides send/withhold per candidate
with typed evidence → the owner sees the decisions on the Requests screen —
and **nothing is sent**. Both warm-up probes are also live. What is true now:

- **Probes**: the weekly digest carries a Competitor Delta line (review-count
  gap vs a Named rival — owner-picked via the settings Rival picker, else a
  deterministic Auto-default), reading `competitor_snapshots` persisted from
  the SAME SerpAPI calls `RankingTrackingWorker` always made; the Voice Report
  Card at `/settings/voice` shows five evidenced register traits derived from
  the owner's own reply edits (zero new data collection).
- **The new shape**: `src/lib/solicitation/` (restraint-policy, contacts-csv,
  ingest, batch-builder, batch-view, flags) · `src/lib/competitors/`
  (named-rival) · `worker/jobs/csv-ingest/` + `worker/jobs/solicitation-batch/`
  (each with failed-hooks) · `src/app/(authenticated)/dashboard/requests/`
  (funnel-hero batch screen + contacts page) · run spine widened with
  `parent_run_id`, `solicitation_batch`/`solicitation_ask` kinds, persona
  `solicitation`, outcome `solicitation_batch_built` (ADR 0011) ·
  `solicitation_batches`/`solicitation_asks` as the authoritative decision
  records (survive 180-day run archival).
- **Migrations 084–089** applied to staging AND prod in lockstep, all
  introspection-verified. Flag: `SOLICITATION_WATCH_ENABLED=true` on staging
  only (evidence: `docs/runbooks/evidence/2026-07-26-solicitation-watch-mode-staging-flip.md`);
  prod stays off until the production bring-up.
- **Sentiment-blindness is structural** (ADR 0012): the withhold enum has no
  `recent_negative`, evidence carries no star ratings, and the Requests UI
  renders `already_reviewed` with a date but never a rating.
- **Deferred debt, tracked**: #555 (restraint-policy date fail-open — gates
  send-mode), #565 (complexity/consolidation bundle), #567/#568 (arch-review
  R1/R2), #569, #572, #573. Next effort: the send-mode map (§9.3), opened only
  after watch-mode engagement signal (reviewed_at pings, rival picks, uploads).

## Quick summary — Restraint policy module: first Phase 2 Solicitation code (2026-07-23, PR #551)

The restraint policy module from wayfinder map #528 is merged — the first
implementation code of Phase 2 (Solicitation watch-mode), building exactly the
design locked in #533 (PR #548) and ADR 0012. What is true now:

- **`src/lib/solicitation/restraint-policy.ts`** — a pure, deterministic,
  sentiment-blind decision module with zero imports (no DB, no clock, no LLM).
  `evaluateAsk` runs the five per-candidate gates in first-match precedence
  (`no_consent → suppressed → already_reviewed → stale_visit → over_contacted`);
  `evaluateBatch` adds the batch-relative `velocity_banked` gate (cap 25,
  most-recent-visit-first banking, UUIDv7 row-ID tie-break); `resolveVertical`
  maps owner-typed `businesses.category` text to the closed 8-vertical enum
  driving per-vertical freshness windows. Every withhold carries a typed
  evidence snapshot (spec §4 field names verbatim, `policy_version` +
  `decided_at` envelope, contact ID only — never PII, never a star rating).
- **Nothing consumes it yet**: #543 (run-engine batch builder) wires it in;
  #537 (batch screen prototype) renders its decisions. In v-watch,
  `no_consent` and `suppressed` cannot fire (the #535 attestation is blocking;
  there is no suppression ledger) — both are contract-tested so the enum stays
  stable for send-mode.
- **`MIN_GAP_DAYS = 30`** (over-contacted gap) is a plan-time day-one constant
  — the spec locked the evidence shape but no value; it lives in the same
  tunable table as the freshness windows and batch cap.

The new shape:
- `src/lib/solicitation/restraint-policy.ts` — the module (only file, deep interface)
- `src/lib/solicitation/__tests__/restraint-policy.test.ts` — 34 tests: per-reason contracts, precedence peeling, UTC boundary cases, fast-check invariants
- footnote in `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md`; entry in `docs/directory.md`; workflow artifacts in `docs/superpowers/plans/feat-542-*` + `docs/reviews/feat-542-restraint-policy/`

## Quick summary — Agentic platform staging-proven; launch gates closed (2026-07-22→23, PRs #518–#522)

The full agentic stack (WS1–WS8) was proven end-to-end on the staging full stack
against a **live Google Business Profile**, and the go-live gate list collapsed
to launch-day items. What is true now:

- **Staging E2E campaign PASS, Phases A–D** (evidence:
  `docs/runbooks/evidence/2026-07-21-…` + `2026-07-22-…`): Copilot full loop
  (live ingest → draft → owner `/approve` → real Google post, spine-attributed);
  Guardian triage + escalation on live reviews; Autopilot autonomy happy path
  (policy auto-approve → 15-min veto window → **real unattended Google post** →
  judge verdict 43s later) plus all three fail-safe drills (moderation absolute
  veto, judge-down downgrade, governor suspend → AAL2 admin unsuspend); Phase D
  purchasability (12/12 WS8 smoke, real Autopilot checkout + upgrade, trust-dial
  settings-UI writes incl. gate-closed 409, publish-time downgrade).
- **Three launch-blocking bugs found by live testing, all fixed + merged:**
  #518 — every card-up-front trial signup stranded `pending_payment`
  (`trialContractMatchesLease` rejected Stripe's `payment_status='paid'` for the
  $0 setup invoice and auto-cancelled the valid trialing sub); #519 — onboarding
  page/route flag drift (route read raw `onboardingDemoEnabled()` while the page
  used `shouldUseDemoWizard` → 409 loop for trials without a location); #520 —
  the governor could never re-suspend an account after its first unsuspension
  (JS-Date ms truncation vs timestamptz µs — see the lab note + CLAUDE.md gotcha).
- **Zernio gate CLOSED** (`docs/runbooks/zernio-automated-posting-limits.md`):
  automated posting permitted, **no rate limits, pay-per-use per account** — so
  all pacing is ours (caps/veto-window/jitter are mandatory, never removable),
  and Zernio API volume is a COGS line (pricing unit still to pin down).
- **Prod schema verified by introspection:** 071–077 + 079–083 present; **078
  deliberately absent** until the prod WS8 cutover (0 rows in prod
  `accounts`/`businesses`). **Production stack intentionally not stood up** —
  build-first strategy; one bring-up session at launch (worker + Redis + env
  matrix + webhooks + Stripe Prices + 078 + smoke).
- **The audit trail is in `main`:** design doc **§8 "As-built status"** is the
  entry point for future agents (CLAUDE.md's Where-things-live table routes
  there), plus 4 runbooks + 2 evidence records; `.scratch/` is gitignored.

The new shape:
- `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §8 — as-built overlay + go-live gate table
- `docs/runbooks/agentic-staging-copilot-autopilot-e2e.md`, `agentic-staging-phase-d-purchasability.md`, `owner-uat-agentic-staging.md`, `zernio-automated-posting-limits.md`
- `docs/runbooks/evidence/2026-07-21-…` + `2026-07-22-…` (the proof)
- `worker/ingress/stripe/checkout-completed.ts` — trial contract accepts `paid` | `no_payment_required` (#518)
- `src/app/api/onboarding/business/route.ts` — `shouldUseDemoWizard` parity with the page (#519)
- `src/lib/auto-approval/governor.ts` + `worker/background/schedulers/AutonomyGovernorScheduler.ts` — ms-truncated staleness check + logged skip path (#520)

Next: owner UAT (runbook ready) → Phase 2 design cycle (run engine +
Solicitation agent — entry points in design doc §8.5); production bring-up at launch.

## Quick summary — Reliability follow-ups P4/P8/P9 (2026-07-21, PRs #514–#516)

The last three findings from the 10-finding pre-production reliability report
(P1/P2/P3/P5/P6/P7/P10 shipped earlier as PR #508 — see the next section). With
these merged, the report is **fully closed**. What is true now:

- **A slow Stripe response can no longer pin the tier-change locks (P8, #514).**
  Every Stripe call made while the tier-change advisory locks + `FOR UPDATE` are
  held is bounded to **8s with retries disabled**, and mutating calls keep their
  deterministic `tier-change:<account>:<op>:<step>` idempotency keys — an
  ambiguous timeout is recovered by the Stripe webhook/reconciler path, never by
  retrying under the lock. Worst-case lock hold drops from ~60s+ to ~26s
  (stripe-node 22.2.0 still performs ONE internal retry on a socket reset even
  with `maxNetworkRetries: 0`; timeouts — the target case — do not retry).
- **A downed LLM provider no longer costs every job a full primary timeout
  (P9, #515).** An in-process, per-provider circuit breaker sits inside the
  `src/lib/llm/` seam: 5 consecutive transient failures trip it open for 30s,
  then one half-open probe. Open primary ⇒ immediate failover to the fallback
  (skipping the ~30s primary timeout); both providers open ⇒ retryable
  `TransientLLMError`, never a terminal draft loss. Default **ON**; kill switch
  `LLM_CIRCUIT_BREAKER_ENABLED=false` restores byte-identical prior behavior.
  Sentry warns only on trip and recovery; open↔half_open churn is
  structured-log-only.
- **An owner with zero verified channels is no longer a silent dead end
  (P4, #516 + ADR 0010).** A `send_notification` that completes with no
  verified enrollments now records
  `job_outbox.completion_reason='owner_unreachable'` (migration 083, applied
  staging + prod in lockstep). `checkOwnerUnreachable` alerts durably past a
  4h age **floor** (keeps firing until the draft resolves — unlike the windowed
  zero-delivery check, which is now de-conflated), and a third
  `NotificationFailoverPoller` arm retries the notification under an advisory
  lock (at-most-once) and sends a 24h-deduped admin email.

The new shape:

- `src/lib/llm/circuit-breaker.ts` — breaker state machine (epoch-correlated
  admission tokens); consulted in `src/lib/llm/run-task.ts`; kill-switch
  accessor `src/lib/llm/flags.ts` (via new `readFlagEnabledByDefault` in
  `src/lib/config/flags.ts`)
- `src/lib/shared/outbox-completion-reason.ts` + `markOutboxCompletedWithReason`
  (`src/lib/shared/outbox.ts`) — the owner-unreachable marker (migration 083).
  Shipped here as `markOutboxOwnerUnreachable`; generalized to the reason-taking
  writer at #695, with the persisted `owner_unreachable` value unchanged
- `worker/background/pollers/NotificationFailoverPoller.ts` — owner-unreachable
  arm (advisory-locked retry + admin email)
- `worker/background/pollers/health-alert/checks.ts` — `checkOwnerUnreachable`
  (latest-completed-reason predicate, 4h floor) + de-conflated zero-delivery
- `worker/jobs/notification/eligibility.ts` — shared `resolveEligibleChannels`
  for the three notice workers
- `src/lib/accounts/tier-change.ts` — `STRIPE_UNDER_LOCK_REQUEST_OPTIONS`
  (8s / 0 retries), the single owner of the under-lock bound

## Quick summary — Production reliability guards (2026-07-20, PR #508)

A pre-production review surfaced 10 prioritized reliability findings; this PR
shipped the seven mechanical, low-blast-radius guards (P1, P2, P3, P5, P6, P7,
P10). P4/P8/P9 rode the mapped follow-up branch
([followup map](superpowers/plans/2026-07-16-prod-hardening-followup-map.md))
and shipped 2026-07-21 as PRs #514–#516 — see the section above.
What is true now:

- **One review's failure bookkeeping can no longer kill the worker (P1).** The
  zernio ingest `'failed'` hook is wrapped in a last-resort never-rethrow guard,
  and its coupled terminal writes (`review_exceptions` + outbox) run **CAS-first
  inside `sql.begin`** via `withOwnedTerminalTransition` — only the attempt that
  owns the outbox terminal transition commits the coupled rows; a stale attempt
  writes nothing; the crash guard never splits a rolled-back coupled tx.
- **Worker-side Supabase admin/storage calls are bounded at 10s; identity
  mutations are NOT (P2, refined in adversarial review).** `src/lib/db/server.ts`
  now exports two clients: `supabaseServer` stays unbounded (an ambiguous
  timeout on a committed Auth signUp/invite would orphan an identity), while
  the new `supabaseServerBounded` (`boundedSupabaseFetch`, 10s) serves the
  offboarding purge wiring and `CleanupAbandonedSignupsPoller` so a hung
  Supabase call can't pin a BullMQ slot forever.
- **Transient failures during the avoid-facts guardrail regen now RETRY instead
  of dropping a paid draft (P3 — owner override of the documented anti-respend
  carve-out).** One predicate (`isTransientGenerationError`) re-throws all three
  transient classes from both guardrail catch layers → BullMQ retry (the primary
  hits the idempotent cache on retry; a Redis outage can re-spend, bounded by
  the queue's attempts budget — owner-accepted). Budget/cost-cap decisions stay
  terminal.
- **Unlistened `'error'` events no longer restart the worker (P5).**
  `attachEmitterErrorLogger` (`worker/emitter-errors.ts`) is attached to every
  BullMQ Queue, every Worker, and the probe Redis client: structured log +
  Sentry warning with a per-source 60s count-and-suppress window (a Redis
  outage is one report per source per minute, not an alert storm).
- **Fastify ingress is bounded (P6).** `buildFastifyOptions`
  (`worker/config/fastify-options.ts`): requestTimeout 30s, keepAlive 60s,
  connection 10s, bodyLimit 5 MB — slow-loris/slow-body clients can't exhaust
  the single Railway worker and block Stripe/Zernio webhooks.
- **Health-alert blind spots closed (P7).** The failed-outbox check now watches
  `generate_response` too, and a new check alerts on
  `inbound_events.status='failed'` rows (Stripe/Zernio processing bugs are no
  longer masked for days by provider-side retries).
- **The dashboard degrades per-widget instead of 500ing (P10, refined in
  adversarial review).** Per-location: the business lookup stays fatal; every
  other query settles independently and degrades to its per-widget fallback,
  always reported to Sentry. Aggregate: exactly two reads stay fatal (locations
  list + the slice wave's baseline anchor read — degrading the anchor would
  render an all-zeros misreporting dashboard); each slice read (counters,
  velocity, rating breakdown, ranking, briefs, pending approvals), the billing
  row, and the account recent-reviews feed degrade per-query under
  `widgetOrFallbackFor('dashboard/aggregate')`.

The new shape: `worker/emitter-errors.ts` (non-fatal emitter sink) ·
`worker/config/fastify-options.ts` (ingress bounds) ·
`worker/jobs/zernio/ingest-failed-hook.ts` (`withOwnedTerminalTransition`) ·
`src/lib/db/server.ts` (`supabaseServer` / `supabaseServerBounded` split) ·
`worker/jobs/response-generation/generate-draft.ts` (`isTransientGenerationError`
guardrail retry) · `worker/background/pollers/health-alert/checks.ts`
(+`generate_response`, +`inbound_events`) ·
`src/lib/dashboard/{service,aggregate-service,aggregate-queries}.ts`
(`widgetOrFallback` / `widgetOrFallbackFor` degradation). Spec:
[2026-07-16-prod-hardening-guards-design.md](superpowers/specs/2026-07-16-prod-hardening-guards-design.md);
deviations: [fix-prod-hardening-guards-deviations.md](superpowers/plans/fix-prod-hardening-guards-deviations.md).

## Quick summary — Scalability verification remainders (2026-07-20, PR #511)

Closed the last two pre-launch scalability-verification items:

- **Boot-enforced summed LLM worker-slot cap.** `assertSummedLlmWorkerSlots`
  (`worker/config/startup-assert.ts`), called at the LLM-worker registration
  site in `worker/index.ts`, fails worker boot if the summed **non-flag-gated**
  LLM worker-slot concurrency exceeds **9** (`generate_response`=5 +
  `generate_demo`, `weekly_summary`, `send_monthly_impact`,
  `onboarding_demo_response`=1 each), or if the flag-gated `judge_verdict`
  exceeds 1. It reads EFFECTIVE `worker.opts` (same pattern as
  `assertSingleConcurrencyWorker`), so a future edit that widens a concurrency
  fails the boot instead of silently blowing the ADR-0005 LLM-concurrency
  envelope. Enforcement only — no concurrency VALUE changed. `generate_demo`
  was previously missing from the #490 inventory; ADR 0005's addendum is
  amended to match (cap 9, `generate_demo` counted).
- **Failover-poller indexes (migration 082).** Two partial indexes so
  `NotificationFailoverPoller` stops seq-scanning at scale:
  `idx_jo_send_notification_by_aggregate` on `job_outbox (aggregate_id,
  created_at DESC) WHERE topic = 'send_notification'` (the
  `recoverFailoverCorrelationId` lookup) and
  `idx_responses_pending_approval_created` on `responses (created_at) WHERE
  status = 'pending_approval'` (both global sweeps). Applied to staging + prod
  Supabase in lockstep; staging + prod `EXPLAIN` confirm the index path (the
  responses index supplies the `ORDER BY`, no Sort node). No INCLUDE columns
  yet — deferred to a production EXPLAIN per the evidence rule.

The new shape: `worker/config/startup-assert.ts` (`assertSummedLlmWorkerSlots`
alongside `assertSingleConcurrencyWorker`) · `worker/index.ts` (the assert call
after the six LLM-worker registrations) · `supabase/migrations/082_failover_lookup_indexes.sql`
· cap semantics owned by `docs/adr/0005-beta-launch-posture.md` + `CONTEXT.md`
glossary.

## Quick summary — WS8 launch-safety correction (2026-07-15, execution branch; PR pending)

WS8 now owns exactly one durable Checkout attempt per pending account. The
attempt freezes the selected tier, immutable variant, Price IDs, cents/quota,
quantity, trial/tax shape, customer email, and return URLs before Stripe Session
creation. Same-attempt retries therefore cannot drift under a deploy or flag
change. Reselecting a plan expires the prior open Session first; stale,
non-entitled, or non-binding completion cancels/remediates its unexpected
subscription before any status or billing snapshot can activate. Successful
completion replay performs no billing mutation but still repairs the deprecated
tier mirror.

Stripe status projection also has one linearization anchor: resolve the account
without a row lock, acquire that exact account's entitlement lock, then lock and
recheck the same account/provider lineage. Canonical status transactions never
wait on the publisher's business-row anchor. Instead they durably enqueue
`stripe_subscription_mirror_sync`; its worker uses business rows → entitlement
ordering and converges the deprecated status/activation mirror. Deterministic
three-actor tests cover both publisher-first and tier-first wait orders.

The commercial prices, founding contract, and quiesced
077 → strict code → 078 rollout are unchanged. No PR, remote migration, Stripe
mutation, env mutation, deployment, or reserved integration-owner action has
been performed by the executor.

## Quick summary — WS8 Copilot/Autopilot tier wiring (2026-07-15, execution branch; PR pending)

RepWorth now has one commercial tier model in code: Copilot ($29 list / $19
founding, $15 extra location) and Autopilot ($69 / $49, $20 extra location),
monthly only and one included location. Owners choose explicitly. The immutable
account `price_variant` follows founding customers through tier changes, while
billing screens and invoice math read the cents/quota stored on the account
instead of silently re-pricing from today's registry.

Autopilot is also a runtime authority boundary, not just a checkout label.
Copilot cannot receive `auto_policy` approval; the publisher rechecks access at
the final side-effect boundary and downgrades queued autonomy after access loss.
Trust-dial expansions require server-confirmed Autopilot readiness, while every
contraction remains available. Trialing still receives full product access via
the shared subscription predicate.

The database rollout is deliberately two-stage. Migration 077 expands the
schema and, on first apply only, normalizes the quiesced zero-live-account data
to a complete Copilot/list snapshot. Strict code deploys and smokes before
migration 078 installs NULL-safe Copilot/Autopilot-only constraints. The
provider-wide Stripe blocker and
[`ws8-tier-cutover.md`](runbooks/ws8-tier-cutover.md) enforce the single order;
no staging/production migration, Price creation, env mutation, deployment, or
PR is performed by this branch execution.

The new shape:

```text
src/lib/accounts/{tier-config,tier-snapshot,tier-change}.ts
  → two-tier snapshots, immutable variants, serialized complete writes
src/lib/payments/{price-tier-map,founding-window,tier-purchasability}.ts
  → six retained launch Prices + strict deadline + composed Autopilot gate
worker/ingress/stripe/apply-subscription-state.ts
  → single subscription-status owner; variant mismatch preserves billing data
worker/jobs/publisher/ + src/lib/auto-approval/
  → grant-time, settings-time, and publish-time autonomy enforcement
supabase/migrations/077_* + 078_*
  → quiesced expand/normalize, then strict contract
scripts/{verify-stripe-price-parity,ws8-stripe-cutover-preflight}.ts
  → all-six provider parity + provider-wide subscription/Session blocker
docs/runbooks/ws8-tier-cutover.md
  → staging-first quiesce → zero → 077 → strict code → smoke → 078 → resume
```

## Quick summary — Modularity A+ campaign complete (2026-07-06, PR #438–#456)

In simple words: a follow-on **codebase-health** campaign (no customer-visible change) that took the five modularity questions from A−/B+ up to **A on four and A+ on "are dependencies explicit?"**. The two things the June audit had *deliberately left* as residuals are now closed, permanently:

1. **Every module now gets its database client handed to it, instead of reaching for a global.** Business-logic code used to `import` the shared `sql`/`supabaseServer` clients directly (105 files did). Now those modules take `sql` as an explicit parameter; only the "entry points" (routes, worker registrations, pollers) hold the real client and pass it down. A CI guard (`ci:db-imports`) enforces this **strictly** — root status is even derived from what `worker/index.ts` actually registers, so a stray helper can't sneak the global back in. This makes any module trivially testable in isolation (pass a mock) and is now a stated architecture invariant (#15).

2. **All AI-model calls go through one small seam.** Generation and insights used to construct OpenAI/Anthropic clients inline. Now they call `runLlmTask(...)`; the provider adapters, per-task pinned models, fallback, and cost-guard live in `src/lib/llm/`. Swapping or adding a model provider is an adapter change, not a caller rewrite.

Nine domain sweeps, **zero behavior regressions, zero migrations**, clean staging rides throughout. The strict guard + the seam are the permanent proof — this is convention now, not a one-time cleanup. Full grades, the 105→0 arc, and the per-PR ledger are in the [exit re-audit](audits/2026-07-06-modularity-aplus-exit-audit.md); the #1 follow-up it names is the worker crash-net "zombie-pool" liveness-escalator (a separate resilience PR).

## Quick summary — Modularity hardening complete + worker resilience + dep security (2026-06-26, PR #397–#400)

In simple words: this was **codebase-health** work, not a customer feature. A heavy modularity audit had graded the codebase against five questions ("can I change one feature without touching unrelated files? test a module alone? …"). The weak spots are now fixed, so the codebase answers a confident **yes** to all five. Same behavior, cleaner structure — nothing a customer sees changed.

Three things landed:

1. **The publishing path is now swappable (the `ReviewPublisher` seam, #397).** Posting a review reply used to be hard-wired to one provider (Zernio) across ~7 worker files — adding the parked direct-Google path would have been a rewrite. Now publishing goes through a small interface (`publishReply` / `editReply` / `deleteReply` / `getReply`) with Zernio as the **first adapter**; a future Google-Business-Profile path is a *second adapter*, not a rewrite. Pure refactor, zero behavior change, proven by the existing publisher tests + a new concurrency test. This closed the last "replace a component" gap from the audit.

2. **A transient database hiccup no longer kills the whole worker (#399).** A brief Postgres statement-timeout at boot could surface as an un-awaited error and the worker's crash-net would exit the **entire** process — killing every in-flight job across all 24 queues + 20 background loops over one blip. Now the worker **recovers** from a clearly-transient DB error (it logs + retries next cycle), while a *sustained* storm still escalates to a restart, and real bugs still crash. (The scheduler that triggered it already caught its own errors — the bug was the crash-net's blast radius, so the fix protects every loop.)

3. **Security patches + hygiene (#398, #400).** Single-sourced a duplicated channel helper (Stage-6 hygiene); patched the cleanly-fixable Dependabot advisories (form-data HIGH, undici HIGH, esbuild) — **respecting** the repo's own supply-chain hardening (7-day release quarantine + no-downgrade trust policy) by deferring the few bumps it intentionally blocks.

### The new shape — what got added

```text
src/lib/publishing/review-publisher.ts        ← NEW: the ReviewPublisher interface + ReviewRef/ReviewLocator + getReviewPublisher() factory (the seam).
src/lib/publishing/zernio-review-publisher.ts ← NEW: first adapter; owns the Zernio connection lookup, review-id resolution, page-cache. A GBP adapter is the second.
worker/transient-rejection-governor.ts        ← NEW: duration-based governor — survive a brief DB blip, escalate a SUSTAINED storm to a crash+restart.
src/lib/db/transient-error.ts                 ← MOVED here from worker/jobs/billing/; adds isCrashNetRecoverableDbError (an explicit, conservative allowlist for the worker crash-net).
src/app/api/admin/channels/_shared/flag-off.ts← NEW: single source for the disabled-channel 404 (telegram + whatsapp re-export it).

# The 6 publisher worker call-sites now go through the seam (no direct zernioClient in the publish path):
worker/jobs/publisher/{ResponsePublisherWorker,review-lookup,post-reply,verify-posted,publisher-error-handlers,edit-publish}.ts
worker/index.ts  ← the unhandledRejection crash-net now classifies transient-DB errors via isCrashNetRecoverableDbError + the governor.
```

### Where the five audit questions landed (both residuals since CLOSED by the A+ campaign)

The audit's full campaign was Stages 1–6: Stages 1–4 (prior sessions, #376–#396) introduced the **typed config layer** (env reads owned in one place, CI-guarded) and routed **all feature flags** through per-feature `flags.ts` accessors; Stages 5–6 (this session) added the publishing seam + hygiene. Grades at the close of that remediation (2026-06-26): Q1 modify-without-touching **A−**, Q2 test-in-isolation **A−**, Q3 single-responsibility **A−**, Q4 dependencies-explicit **B+** (was the weak C+), Q5 replace-a-component **A−**.

Two residuals were left open at that point (documented, low-priority, not blocking): the `sql`/`supabaseServer` DB singletons remained ambient, and the LLM provider fallback remained inline (`callOpenAI`/`callAnthropic`). **Both were subsequently CLOSED by the Modularity A+ campaign (2026-07, PRs #438–#456)** — see [`docs/audits/2026-07-06-modularity-aplus-exit-audit.md`](audits/2026-07-06-modularity-aplus-exit-audit.md):

- **DB singletons → explicit-parameter injection.** Every domain module under `src/lib/**` + every worker helper now receives its DB client (`sql`/`supabaseServer`, or `tx` inside a transaction) as an explicit parameter; only **composition roots** import `@/lib/db/server`. The db-imports importer set went **105 → 0** (baseline deleted) and the **strict `ci:db-imports` guard** (registration-derived worker roots, AST-parsed from `worker/index.ts`) makes regression structurally impossible.
- **Inline LLM calls → the `src/lib/llm/` task seam.** `LLMProvider` adapters + the `LLM_TASKS` registry + `runLlmTask` as the single executor; both reply generation and review-insight summaries route through it.

Net effect per the exit audit: **Q1 A, Q2 A, Q3 A, Q4 A+ (the campaign's headline), Q5 A** — A or better on all five, zero unaccepted caveats. The injection convention is now a permanent, CI-enforced invariant (CLAUDE.md #15), not a campaign artifact.

### One thing to remember

The `ReviewPublisher` seam is a **1-adapter interface** today, so it can be subtly wrong-shaped until a real GBP adapter validates it — keep it minimal and driven by what the call-sites actually need. And the worker crash-net's transient-DB recovery is deliberate (Release It! "fail inside boundaries that prevent wider collapse") — don't reintroduce a blanket crash-on-any-rejection; ambiguous-state DB codes still crash by design.

## Quick summary — 1-Month Free Trial (2026-06-21 → 2026-06-22, PR #362, on staging — flag OFF)

In simple words: a new business can now **try RepWorth free for 30 days**. They sign up, enter a card, are charged **$0 today**, and get the full product for a month; Stripe automatically charges them when the trial ends. It's **off by default** (a switch, `TRIAL_ENABLED`) and turns on staging→prod when ready.

Behind the scenes we added a new account state called **`trialing`** that the whole app treats like a paying customer — they can generate AI replies, get notified, approve, and post to their real Google profile — with **one exception**: keyword-ranking tracking (which costs us money on every check) stays off until they actually pay. Stripe is the single source of truth: one piece of code (the "applier") turns every Stripe change — trial started, converted to paid, payment failed, cancelled — into the account's status, and a background reconciler fixes any account that drifts (so no customer is ever stuck because one webhook went missing).

How it was built: **grilled + stress-tested by a second AI model (Codex) over 6 rounds before any code**, then a 5-agent heavy review, then — crucially — a **live end-to-end test on staging** with real Stripe. That E2E caught **three real bugs that every code-review layer missed** (all now fixed): Stripe reports a $0 trial checkout as "paid" not "no payment required" (so trials were being recorded as already-paid); the onboarding setup screen looped forever; and trial accounts silently got no nurture emails. Nothing was ever posted to a real Google profile during testing.

### The new shape — what got added

```text
worker/ingress/stripe/apply-subscription-state.ts        ← NEW: the ONE brain that turns a Stripe subscription change into the account's status (trial → paid → past-due → cancelled). Single applier; everything routes through it.
worker/ingress/stripe/invoice-payment-action-required.ts ← NEW: handles "card needs extra verification at the first real charge" (SCA) → past-due + grace.
supabase/migrations/069_trial_subscription.sql           ← NEW migration: a column comment + lets us record the 4 trial events. NO new columns, no data backfill.
src/lib/analytics/trial-events.ts                        ← NEW: the 4 trial facts (started / converted / payment-failed / cancelled), recorded in the same DB transaction as the status change.
docs/runbooks/trial-staging-e2e-and-rollout.md           ← NEW: the step-by-step staging test + production go-live + rollback guide (with a dated sign-off of what's verified).

# Key shared helpers (no new files — added to existing ones):
subscriptionGrantsFullAccess(status)   ← src/lib/shared/subscription-status.ts — the ONE rule for "does this account get the product?" (yes for active + trialing). Replaced ~18 scattered "=== active" checks.
shouldUseDemoWizard(envEnabled, row)   ← src/app/onboarding/business/guard.ts — fixed the onboarding loop (a trial with no location yet gets the wizard that captures it, not the demo).

# Reversible switches (server-only):
TRIAL_ENABLED       ← default OFF — the master switch (in .env.example + env-vars.md)
TRIAL_PERIOD_DAYS   ← default 30  — trial length
```

### One thing to remember

It is **dark by default** (`TRIAL_ENABLED` off). Before the flag flips in prod: apply migration 069 to the prod database, add the same 6 Stripe webhook events (incl. `invoice.payment_action_required`) to the prod endpoint, and finish the last staging checks listed in the runbook's sign-off (the day-30 convert/fail/cancel were proven by a Stripe "test clock" suite; a few staging-projection + admin-handoff checks remain). The trial deliberately does NOT change how owners approve replies — every reply still needs approval (or the owner's own auto-approval policy), exactly as before.

---

## Quick summary — Beta-launch alerting gate + worker hardening (2026-06-19 → 2026-06-20, PR #354, merged to staging)

In simple words: before this, if something in the background pipeline quietly broke at 2am — drafts not generating, approval emails never sending, replies stuck unposted — **nobody would find out** until they happened to look. This PR adds an **alarm system**: a small background "health probe" watches for those silent failures and pings **Discord** (via Sentry) when it sees one, with a "dead-man" heartbeat that also alerts if the probe itself (or the whole worker) dies. We also added a couple of small **safety timeouts** so one slow call (email, ranking lookup, cache) can't freeze the line, and made the worker **refuse to start in production without an alarm sink configured** (so alerting can never be silently switched off). The product behaviour is unchanged — owners still approve every reply by hand; this is purely "so we notice when things go wrong."

This is the action half of a bigger **"is this ready for 1000 businesses?"** audit. The honest answer was *"not 1000 yet, but fine for a small 10–50 paid beta if we add alarms"* — so we built only the small beta-gate part now and wrote everything else (making the worker faster/parallel, etc.) into a future to-do list with clear "fix this when you grow to X" triggers. Nothing here builds 1000-scale plumbing for a 50-customer reality.

### What we changed (plain English)

- **An alarm for silent failures.** A new health probe checks every few minutes for: jobs stuck or failed (especially posting replies and sending approvals), owners who *should* have been notified but weren't, and a backlog of held drafts nobody reviewed. Each finding pings Discord. It deliberately **ignores the cases that are silent on purpose** (e.g. a draft held back by the safety filter, or a bulk backfill) so it doesn't cry wolf.
- **A "did the alarm itself die?" check.** The probe sends a heartbeat to a Sentry cron monitor every run; if it stops (probe crashed, or the whole worker is down), Discord gets pinged. A separate outside check pings the worker's `/ready` URL for the same reason.
- **The worker won't boot in production without an alarm sink.** `SENTRY_DSN` is now required at startup — you can't accidentally run prod with alerting switched off.
- **Money-loss isn't silent either.** If a daily spend cap is hit and a draft gets dropped, that now pings Discord instead of vanishing.
- **Small safety timeouts.** Sending an email, the ranking lookup, and the cache now all have time limits, so one slow call can't jam the single-file worker. Emails also got a dedupe key so a timeout-then-retry can't send the same approval twice.

### What got added — the new shape (where the new code lives)

- `worker/background/pollers/HealthAlertPoller.ts` + `worker/background/pollers/health-alert/` — the new health probe. `checks.ts` runs the read-only database checks (returns "findings"); `emit.ts` sends each finding to Discord via Sentry and does the heartbeat check-in. Registered next to the other background pollers.
- `src/lib/notifications/email/send-email.ts` — the **one** place every email now goes through. It adds the send timeout + the dedupe key. All three email templates were pointed at it.
- `worker/config/startup-assert.ts` — gained `assertAlertSinkEnv` (the "no `SENTRY_DSN`, no boot in prod" rule).
- `docs/runbooks/beta-launch-alerting.md` — the human checklist for wiring the alarms (Sentry → Discord, the cron monitor, the outside `/ready` check) and the test drills to prove each alarm fires.
- `docs/adr/0005-beta-launch-posture.md` — why we launch the small beta this way (owner-approval-only; scale work deferred).
- Tiny edits (no new files): `src/lib/db/redis-cache.ts` (cache timeout), `worker/jobs/RankingTrackingWorker.ts` (ranking timeout), `worker/jobs/response-generation/generate-draft.ts` (the cost-cap alarm).
- `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md` — the "fix when you grow" to-do list (absorbed the 1000-business audit's findings); `docs/future-plans/2026-06-18-1000-business-readiness-audit.md` is now a short verdict pointing at it.

### One thing to remember

This was **planned and stress-tested by a second AI model (Codex) across 4 rounds before any code**, reviewed again afterwards (Codex + a code-quality pass), and is **green on every CI check including fallow and react-doctor**. It's **on `staging` only** — production isn't set up yet. The alarms only actually reach Discord once someone does the dashboard wiring in the runbook (Sentry → Discord, the cron monitor, the `/ready` check) and runs the test drills; until then the probe's findings just collect in the Sentry feed.

## Quick summary — Channels go live + auto-approved post FYI (2026-06-14 → 2026-06-15, PRs #319 / #320 / #322)

In simple words: the **Telegram and WhatsApp** notification channels were already fully built but switched **OFF**. We (1) double-checked they actually work end-to-end and added the missing tests, (2) built a **new "✅ we auto-posted your reply to Google" heads-up** that goes to the owner whenever the AI auto-approves and posts a reply (no action needed — just so they know), and (3) left a small, do-nothing "hook" so a future RepWorth **chat-bot** can plug into these channels later without a rewrite. Then a quality clean-up pass and CI fixes. The channels stay OFF until the production rollout; nothing about the normal owner-approval flow changed.

### What we changed (plain English)

- **A (#319) — prove the channels work.** Added the missing tests for the Telegram/WhatsApp approve/edit/regenerate flow, the "only one mobile channel at a time" rule, and the parallel-channel race (approve on one → the other says "already handled", never double-posts). Also fixed a **silently-swallowed** WhatsApp confirmation failure so it gets logged instead of disappearing.
- **B (#320) — the new auto-approved FYI.** When auto-approval is ON and the AI approves + posts a reply by itself, the owner now gets a one-way **"we posted this"** message on email + Telegram (+ WhatsApp once its template clears) with a **View on Google** button. It is **best-effort** (the reply is already live, so a failed FYI never breaks anything) and only fires for auto-posts — owner-approved posts get nothing (the owner already knows).
- **C/D (#322) — room for a future chat-bot.** Free-text the owner sends to the bot now routes to one clearly-named handler that today politely does **nothing** (and only ever responds to a verified, enrolled owner). Plus an ADR and the rollout/test runbooks. This is the "don't paint ourselves into a corner" step — we are **not** building the chat-bot now.
- **Quality clean-up.** Removed duplicated knowledge: one place now decides which channel errors are worth retrying, one shared email "shell" instead of two copies, and all the new database writes live behind named helpers in one file.

### What got added — the new shape (where the new code lives)

- `worker/jobs/auto-post-notice/` — the new FYI worker (`AutoPostNoticeWorker.ts` orchestrates; `context.ts` loads the posted-auto-policy response; `dispatch.ts` sends per channel; `errors.ts` decides retry-vs-give-up). Mirrors the existing `notification/` worker shape.
- `src/app/r/google/[responseId]/route.ts` — the **View on Google** redirect. A short, hardened page: it checks the reply is really `posted`, only ever redirects to a Google Maps URL, and shows a friendly "link unavailable" page otherwise (it never blindly redirects).
- `src/lib/notifications/channels/transient-send-error.ts` — the single answer to "is this channel error worth retrying?" (used by the FYI sender).
- `src/lib/notifications/delivery.ts` — gained the **claim-before-send** helpers (`claimAutoPostNoticeDelivery` / `finalizeDeliverySent` / `failDelivery` / `releaseDeliveryClaim`) so a crash can't double-send the same FYI.
- `src/lib/notifications/email/templates/shared.ts` — `buildEmailShell()` (the shared email frame, used by both the approval email and the new FYI email) + `src/lib/notifications/email/templates/auto-post-notice.ts` (the FYI email itself).
- New `sendAutoPostNotice` method on each channel (`{email,telegram,whatsapp}-channel.ts` + the `*-body.ts` builders).
- `supabase/migrations/067_*` — two tiny database indexes that make the new outbox topic + the claim-before-send dedup safe.
- `worker/ingress/conversational-seam.ts` — the future-chat-bot no-op handler + its redaction/auth boundaries; `docs/adr/0003-conversational-channel-seams.md` records why.
- `docs/runbooks/channels-rollout.md` (how to flip it on in prod — Telegram first), `docs/runbooks/channels-staging-smoke-test.md` (step-by-step staging test), `docs/runbooks/whatsapp-templates.md` (the WhatsApp template content).
- `.fallowrc.jsonc` — small config so the Fallow code-quality check doesn't false-flag the interface-dispatched send methods or the deliberately-parallel-but-divergent worker code.

### One thing to remember

The normal flow is unchanged: a review comes in, the AI drafts a reply, the **owner approves**, then it posts. The FYI is a *new* notification on a *different* path — it only appears when **auto-approval is enabled** and a reply **auto-posts**. The channels themselves are still **flag-OFF** until the rollout in `channels-rollout.md`.

## Quick summary — Multi-location launch hardening (2026-06-09 → 2026-06-11, PRs A–F + follow-ups)

In simple words: a customer's account can hold **more than one business location** (each location is one Google Business Profile). That feature mostly worked, but a careful review found a list of edge-case bugs that would bite at launch — money leaks, double-billing, settings that silently ignored a secondary location, and channel settings that kept routing after you turned them off. We fixed them in **six ordered pull requests (A–F)**, then **ran the entire pipeline for two locations on a real (local) stack** to prove the whole thing works and nothing cross-routes between locations.

### What we changed (plain English)

- **A — stop a spend leak.** When a location was archived, some background jobs still generated AI drafts for it (= wasted LLM money). Now every spend path checks the location is active first.
- **B — exactly one "primary" location.** Hardened the rule so an account always has exactly one primary location even under races; you can't archive your primary out from under yourself, and reactivation/promotion repair the state. Also: you can't approve/edit/post a reply for an **archived** location anymore.
- **C — no duplicate Google location.** Added a database rule (migration 062) so the same Google place can't be added twice to one account; the wizard/CSV/URL paths all show a friendly "already on your account" message instead of a crash.
- **D — billing that recovers and never double-charges.** One shared helper now decides "which Stripe line is the overage charge" (three copies used to disagree → a second overage item = double-billing). When a past-due subscription recovers, we recompute the overage. Stripe errors are now split into "retry" vs "give up" so a blip doesn't lose a billing update.
- **E — settings that respect every location (migration 063).** The weekly/monthly email toggles were shown as account-wide but stored per-location and only on the primary — so a second location could never opt out and archived locations kept emailing. We moved those toggles to the **account**. Channel overrides now stay visible (and deletable) even after you archive back to one location, show "(archived)" labels, and disconnecting a channel now also turns off its per-location overrides — all in one transaction with an audit trail.
- **F — a way to prove it without a real Google account.** A test kit: a two-location seeder, a fake in-memory "Zernio" server, a per-location webhook script, and a runbook. We then **ran the full loop** (webhook → AI draft → owner approval → publish reply) for two locations and recorded the sign-off. The run itself caught two bugs in the test kit (the fake server didn't echo the posted reply back; the launcher used top-level await) — both fixed (#273).

### What got added — the new shape (where the new code lives)

- `src/lib/payments/overage-item.ts` — the single "find the overage Stripe line item" helper (base-item excluded first; used by the worker, the reconcile poller, and the tier-change route).
- `worker/jobs/billing/stripe-overage-error.ts` — classifies Stripe overage errors as transient (retry) vs terminal (mark failed), mirroring the cost-guard rules.
- `src/lib/locations/duplicate-location.ts` — one owner of the "duplicate Google place" error → HTTP 409 + owner-facing copy.
- `supabase/migrations/062_*` (duplicate-place unique index) and `063_*` (account-level digest toggle columns + backfill).
- `src/lib/channels/` — consolidated into `disable-enrollment.ts`, `mobile-enrollment.ts` (was telegram/whatsapp-enrollment), `override.ts`, `overrides-view.ts`; disable now cascades to overrides.
- `e2e/seed.ts` (`seedMultiLocationAccount`), `e2e/fixtures/zernio-fixture-server.ts` + `serve.ts`, `e2e/multi-location.spec.ts`, and `MOCK_ZERNIO_LOCATION_COUNT` in `src/lib/zernio/client/transport.ts` — the E2E kit.
- `docs/runbooks/multi-location-e2e-full-loop.md` — the launch-gating full-loop procedure + the recorded sign-off.

### One thing to remember

The product behaviour did not change for the happy path: a review still comes in, the AI drafts a reply, the **owner approves**, and only then does it post. This work fixed the *multi-location edges* around that flow — and the two-location loop run is the evidence it holds together end-to-end.

## Quick summary — Rate-limiting & abuse hardening (2026-06-09, PRs #254–#257)

In simple words: we **locked down the doors that cost us money or invite abuse**, in three steps. None of this changes how the product works (the AI drafts, the owner approves, nothing posts to Google without that approval) — it's about stopping a script or a bot from hammering the expensive bits. Importantly, our "spend ceiling" was already safe before this; this was defense-in-depth, one real gap, and a front-door bouncer.

### What we changed (plain English)

1. **Capped "regenerate this reply."** A logged-in owner could click "regenerate" (which spins up a fresh AI draft) as fast as they wanted — through **two** different buttons, and one of them had **no limit at all**. Now both share one limit (~5 regenerations a minute / 30 an hour per account). Real owners never hit it; a script does. If our cache (Redis) is briefly down, the limit deliberately lets requests through — the separate money-counter still prevents overspending.

2. **Made AI drafts survive a brief cache hiccup.** Before, if the cache blinked at the wrong moment, a draft request failed *for good* and the draft was lost. Now those brief blips simply **retry** instead of throwing the work away. (Money was never at risk — the spend ceiling was always enforced; this was about not losing the draft.)

3. **Added a bouncer at the front door (Vercel).** Bot-detection ("BotID") now guards the 4 most abuse-prone public actions — **sign-up, the demo starter, login, and the waitlist form** — so spam bots are turned away before they cost us anything. Underneath that, the Vercel firewall gets per-IP API limits: the tight ones (sign-up, demo starter) are **on**; the broad catch-all starts in **"watch only" mode** so we can confirm it won't block a busy office before switching it on. There's also a documented **"panic button"** (Attack Mode) for an active attack.

During review we caught and **removed BotID from two dead endpoints** (`/api/contact`, `/api/demo-request`) that nothing in the app actually calls — leaving them on would have silently 403'd any leftover outside caller, invisible to tests. (Deleting those dead routes is a small follow-up.)

### What got added — the new shape

```text
src/lib/security/                    ← NEW: bot protection
  botid.ts                           server gate (403 a bot / fail-OPEN on a BotID outage)
  botid-routes.ts                    the ONE list of protected routes + detection level
  __tests__/botid.test.ts
src/lib/shared/
  dashboard-regen-rate-limit.ts      ← NEW: shared per-owner "regenerate" limit (both buttons)
src/lib/costs/
  errors.ts                          ← NEW: CostInfraUnavailableError (a cache blip now retries)
docs/adr/0002-botid-server-check-carveout.md    ← NEW: why a bot-check inside a route is OK
docs/runbooks/vercel-waf-rate-limiting.md        ← NEW: the firewall rules + Attack Mode (owner-applied)
next.config.mjs · src/instrumentation-client.ts  ← wired BotID into the build + browser
```

The firewall rules themselves are **not** committed code (Vercel has no config file for them) — they live in the runbook, and the owner applies them with the `vercel firewall` CLI.

---

## Quick summary — Launch readiness sweep (2026-05-28 → 2026-05-29, PRs #152–#186)

In simple words: we ran a **two-part launch audit** (one for the backend/ops, one for every screen) and then **fixed everything code could fix** so the product is ready to open to the public. Nothing here changes how the core product *works* — the AI still drafts, the owner still approves, nothing posts to Google without that approval. This was about **polish, hidden settings, mobile, and accessibility** — plus two small new capabilities (an admin "unstick the Google reconnect queue" button and a full catalogue of every outside service we use).

### What we changed (plain English)

1. **Every screen now looks like RepWorth.** Before, the most important first moments — finishing signup, paying, approving a reply from the email link, the two-factor screen, the demo page we send to prospects — looked like unstyled developer prototypes (gray boxes, blue buttons). They're all rebuilt on the brand "island" look (sage background, white rounded card, teal buttons, gentle motion), with real success and error states and "what happens next" guidance.

2. **It works on a phone now.** Added a mobile menu, made form inputs big enough that iPhones stop zooming in, made the pricing table scroll instead of getting crushed, fixed a Safari bug that clipped the rounded card, added tablet layouts, and made tap targets finger-sized.

3. **Screen readers and keyboards are handled.** Save confirmations, errors, and loading now announce themselves; menus and tabs got proper keyboard navigation and focus outlines.

4. **No more hidden settings that silently fail.** Several important config values (admin alert email, contact-form recipient, error tracking, billing prices, the impersonation secret) used to be undocumented and would *silently* drop alerts or fall back to a personal inbox. They're now all documented in `.env.example` and the worker refuses to start in production without the most critical one.

5. **A full map of every outside service.** We scanned the whole codebase and found 34 environment variables the code reads that weren't in the template (and 3 dead ones). All fixed, and there's now one doc that lists every third-party service (Stripe, Resend, Twilio, Zernio, OpenAI, …) and every setting in one place.

6. **Admins can unstick the Google reconnect queue.** When a customer's Google connection drops, approved replies park in an "awaiting reconnect" queue. Admins previously could *see* stuck items but not act. Now there's a "Force drain queue" button (re-tries posting them all) and a per-item "Dismiss" — both fully audited, and still impossible to post anything that wasn't already owner-approved.

7. **One small database change.** The founders "price locked for life" promise now stores each account's base price (migration 054) instead of reading a live config value that could drift.

### What got added — the new shape

```text
docs/
├── eservices-variables.md          ← NEW: catalogue of every external service + full env-var inventory + drift report
├── runbooks/deployment-guide.md     ← NEW (consolidated): staging guide + deploy runbook merged into one
└── launch-ready-part1.md / -part2.md ← the two audit docs (now marked ✅/🟡 per item)

supabase/migrations/054_accounts_base_price_cents.sql  ← NEW: stores the grandfathered base price (founders price-lock)

src/app/api/admin/businesses/[id]/zernio-queue/route.ts ← NEW: admin force-drain + dismiss for the reconnect queue
src/components/admin/ZernioConnectionPanel.tsx          ← now has "Force drain queue" + per-row "Dismiss"

# New shared UI shells / components (the brand sweep)
src/components/onboarding/OnboardingFunnelShell.tsx + FunnelStepThread  ← one island shell + progress thread for the whole funnel
src/components/approval/ApprovalErrorState.tsx          ← shared recovery UI for every approval error state
src/components/ui/LiveRegion.tsx                         ← NEW: screen-reader announcements (save/error/loading)
src/components/ui/SettingsSkeleton.tsx                   ← NEW: branded settings loading skeleton
src/app/(public)/demo/[slug]/{not-found.tsx, DemoStatusIsland}  ← branded demo loading/error/expired states
src/app/(authenticated)/error.tsx + global-error.tsx    ← branded error boundaries (were unstyled Next.js pages)
src/app/mfa/layout.tsx                                   ← noindex on the MFA subtree
src/lib/seo.ts                                           ← NEW: shared noindexRobots fragment for auth/utility pages
public/logo.svg                                          ← renamed from "Logo - SVG.svg" (spaced filename gone)

# CSS tokens introduced by the sweep
--rw-sidebar-width   (save-bar/sidebar share one width)
--rw-attn-*          (brand "blush" attention surface, replaces banned amber)
--rw-star            (review stars → teal #97B3AE, app-wide; was yellow #eab308)

.env.example                          ← synced: +34 real vars, 3 vestigial commented/retired
src/lib/accounts/quota.ts + margin-service.ts  ← read the stored base price (migration 054)
```

### One thing to remember

This sweep is **almost entirely presentational + config**. The funnel/approval/demo redesigns preserve the underlying data, polling, redirect, and auth logic byte-for-byte — only the look changed. The two `docs/launch-ready-part1.md` / `-part2.md` files carry the authoritative per-item ✅/🟡 status; the remaining unticked items are **operational** (rotate prod secrets, run the restore drill, confirm email auth, flip the launch flags), not code. The admin reconnect-queue actions never bypass owner approval — they only re-fire or dismiss drafts the owner already approved.

## Quick summary — Wave 3 PRs 4–6 (2026-05-27: eval harness, review sentiment, customer KPIs, finance margins)

In simple words:

### What we changed

Four mostly-additive slices that finish Wave 3. Nothing changes what an existing customer sees yet — the customer-facing KPI cards are a later UI step; the rest is plumbing, an admin screen, and docs.

1. **A safety "exam" for the AI replies (`tests/llm-eval/`).** A small test set of 8 example reviews, each paired with a known-good reply. A scorer runs each reply through the *same* safety filter the real app uses and checks it didn't leak anything forbidden (refund promises, legal fault, following injected instructions, etc.). It runs with **no API keys** by default (`pnpm eval:llm`), so it's cheap and always-on in CI; an optional `--live` mode calls the real model. This gives us a repeatable way to catch safety regressions before launch.

2. **A "mood" on every review (review sentiment).** Each review now gets a `sentiment_score` / `sentiment_label` (positive / neutral / negative), worked out from the star rating the moment the review is ingested. Existing reviews were back-filled once. It's deliberately simple (star-based) so the one-time database back-fill and the live code agree exactly; a `sentiment_source` column leaves room to swap in a smarter classifier later.

3. **Customer performance numbers (KPIs).** A new backend that computes five numbers per location (and per account): response rate, average stars, this-month-vs-last-month review volume, average time-to-respond, and an 8-week mood trend. It's served read-only at `GET /api/dashboard/kpis` and only to paying / in-grace owners (a churned account can't pull them). The actual on-screen cards come in a follow-up; this PR ships the data + API + tests.

4. **Money health for the admin (`/admin/costs`).** A new admin-only view that shows, per account, how much we spend on AI/API vs. what that account pays us (MRR), flags accounts whose cost eats >25% / >40% of their revenue, and shows a platform gross-margin number with provider split and the OpenAI→Anthropic fallback rate. It's computed live from the existing cost table (no new table). Plus three finance docs (a monthly COGS template, a monthly-close checklist, and a 3-scenario model) so the numbers have a process around them.

### What got added — the new shape

```text
tests/llm-eval/                    ← NEW: the keyless safety eval harness
├── eval-set.jsonl                   (8 launch scenarios + safe canned replies)
├── scorer.ts / types.ts / load.ts   (scores candidates via the prod output filter)
├── run.ts                           (pnpm eval:llm — offline default, --live opt-in)
├── live-runner.ts                   (key-gated real generation, dynamic-imported)
└── reports/                         (gitignored JSON run reports)

docs/trust-safety/                 ← NEW: enforcement-workflow.md, abuse-reporting.md, cases/_template.md
docs/finance/                      ← NEW: cogs-template.md, monthly-close.md, model.md
docs/analytics/posthog-dashboards.md ← NEW: internal BI dashboard definitions

supabase/migrations/052_reviews_sentiment.sql ← NEW: reviews.sentiment_* columns + star back-fill
src/lib/reviews/sentiment.ts       ← NEW: classifySentiment() (star-based, deterministic)
  (wired into process-review.ts inserts/updates + zernio insertImportedReview)

src/lib/kpi/                       ← NEW: types.ts + service.ts (DashboardKpiSummary)
src/app/api/dashboard/kpis/route.ts ← NEW: owner-scoped, subscription-gated KPI endpoint

src/lib/admin/margin-service.ts    ← NEW: getMarginReport() (cost vs MRR, aggregate-on-read)
src/app/api/admin/costs/route.ts   ← now also returns a best-effort `margin` payload
src/app/admin/costs/page.tsx       ← now renders a margin-risk section
src/lib/shared/subscription-status.ts ← + subscriptionAllowsDashboardRead() (read entitlement)
```

### Why we did it

These are the last three launch-critical pieces of Wave 3: a way to *prove* the AI stays safe (eval harness + trust-safety docs), the *customer-value* numbers (sentiment + KPIs) the dashboard will show, and the *business-health* visibility (margins + finance discipline) the founder needs to watch unit economics. No new feature flags were needed; the only external (non-code) gates left are vendor setup — production PostHog dashboards, turning OpenAI Moderation on, ProfitWell/Stripe revenue tooling, and the first monthly close.

## Quick summary — what shipped 2026-05-24 (Step 1 keystones: past-due timer, audit helper, activation tracking)

In simple words:

### What we changed

Three small foundations that bigger features need later. None of them changes anything a customer sees yet — they're plumbing.

1. **A "past-due since" timestamp.** When a customer's card fails, we already flipped their account to "past due." Now we also stamp the *moment* it happened (`past_due_at`). That stamp is what a future "your account is past due — 5 days left" countdown will count from. We clear the stamp when they pay again, and also when they cancel (it marks the *current* past-due stretch, not history). Repeated failed charges don't reset it, so the countdown always measures from the first failure.

2. **One tidy place to write the account "audit log."** The account-history table (who did what, when) gained a few standard columns (what kind of thing was touched, an IP, a browser string, a request ID). And instead of every piece of code writing to that table by hand, there's now one small helper (`writeAccountAuditLog`) that does it correctly and can write the history row *in the same database transaction* as the change it's recording — so they can never get out of sync. The three billing webhooks (charge failed / charge paid / subscription cancelled) now use it.

3. **An "activation" signal for our product analytics.** We want to know when a new customer gets real value for the first time. We define that as their **first published review reply within 7 days of signing up**. The app now quietly sends an `activation_completed` event to PostHog (our analytics tool) the moment that happens. It's wired into **every** path a reply can get published through — not just the common one — so the count is honest. If the analytics service is down or its key isn't set, nothing breaks; the event is just skipped.

### Why we did it

These are three of the four "Step 1 keystones" in the production-readiness plan (the fourth, the CI safety-check, shipped earlier). Each unblocks a cluster of later work: the timestamp unblocks the past-due countdown screens; the audit helper unblocks security/impersonation history and the approval-snapshot feature; the activation event unblocks the whole analytics/retention story. Doing them in one batch finishes Step 1.

### What got added — the new shape

```text
supabase/migrations/
└── 043_step_1_keystones.sql      ← NEW: adds accounts.past_due_at + 5 audit columns
                                     (additive only — nothing dropped or rewritten)
src/lib/
├── audit/log.ts                  ← NEW: writeAccountAuditLog() — the one audit write path
└── analytics/posthog.ts          ← NEW: worker-only PostHog client; no-op without a key
worker/
├── index.ts                      ← now flushes analytics on shutdown (so events aren't lost on redeploy)
├── ingress/stripe/
│   ├── invoice-payment-failed.ts ← sets past_due_at + writes audit via the helper
│   ├── invoice-paid.ts           ← clears past_due_at + audit
│   └── subscription-deleted.ts   ← clears past_due_at on cancel + audit
└── jobs/publisher/
    └── activation.ts             ← NEW: the single "first reply published?" check, used by
                                     all four publish paths; sends activation_completed
```

### What this does NOT do yet (on purpose)

No past-due countdown banner or read-only mode yet (just the timestamp behind it). No team/member accounts — we intentionally left the `account_memberships` table out of this batch; it belongs to a later login/security slice. No analytics on the website itself (only the worker), no retention dashboards yet, and the CSV-import path still writes its history the old way. The grace-period clock the worker uses still reads a different (older) field — `past_due_at` is now available to fix that later but wasn't switched over here.

---

## Quick summary — what shipped 2026-05-24 (Continuous Integration "keystone")

In simple words:

### What we changed

We gave the project an automatic safety check that runs every time code is proposed. Before this, anyone could merge a change and it would ship straight to the live site (Vercel) and the background worker (Railway) with **nothing checking it first**. Now, every pull request automatically runs four checks — **lint** (style), **typecheck** (TypeScript types), **test** (the ~300 unit tests), and **build** (does the app compile) — and the change **cannot be merged into `main` until all four pass**. Think of it as a spell-checker and test-runner standing guard at the door.

We created a brand-new `.github/` folder, which is where GitHub looks for this kind of automation:

- **`.github/workflows/ci.yml`** — the actual checks (the four jobs above), run on every pull request and every push to `main`.
- **`.github/actions/setup/`** — a small shared "setup" step (install Node + pnpm, restore the cache) that all four jobs reuse, so we don't repeat the same lines four times.
- **`.github/dependabot.yml`** — a robot that opens pull requests weekly to keep dependencies up to date. We tuned it so routine small updates come bundled and green, while big "major version" updates each arrive as their own separate PR to review carefully.
- **`.github/pull_request_template.md`** — a checklist that pre-fills every new pull request.
- **`.github/CODEOWNERS`** — says who owns the code (you).

### Why we did it

It's the highest-leverage first step in the production-readiness plan: a lot of later safety work (security scans, accessibility checks, performance budgets, AI-output checks) all needs this "fail the build" gate to exist first. Standing it up unblocks roughly eight other planned areas. It also immediately caught **two real bugs** that had been hiding because they only surfaced when tests ran in a clean environment.

### One thing that moved (not a code change, but important)

The repository **moved from a personal GitHub account to the `RepWorth` organization**. We had to: GitHub only lets you protect the `main` branch on a *private* repo if it's on a paid plan, and the paid plan lives on the org. After the move, the live-site (Vercel) and worker (Railway) GitHub connections were re-pointed to the new location. If you clone the repo, the address is now `github.com/RepWorth/ai-review-responder`.

### What this does NOT yet cover

The gate runs the **unit tests only**. The database-backed integration tests and the 13 browser (Playwright) end-to-end tests are **not** in the gate yet — they need a test-database secret and the worker's staging setup, which are still to come. So a green check means "compiles, types are sound, unit tests pass," not "every test ran."

---

## Quick summary — what shipped 2026-05-22 (Owner channel enrollment account-scope fix)

In simple words:

### What we changed

We fixed a bug that hit businesses with **more than one location**. When an owner connects a messaging channel (Telegram or WhatsApp) to get review alerts, that connection belongs to the **whole account**, not one shop. But the code was looking it up by the owner's *home shop* instead of by the account. So on a multi-shop business with two managers based at different shops, the Settings page and the app would disagree about whether a channel was connected — one manager could see "connected" while Disconnect gave an error and Connect crashed. We changed every place that reads or writes these connections to look them up **by account**, so everyone on the account now sees the same, correct state.

We also removed the temporary "WhatsApp is only for single-location accounts" guard we'd put up earlier (PR #53) — multi-location owners can connect WhatsApp again, because the underlying bug is now actually fixed.

### Why we did it

PR #53 (WhatsApp go-live) put a band-aid on this for WhatsApp only and flagged the real fix as a follow-up. This is that follow-up — it fixes the root cause for both Telegram and WhatsApp and takes the band-aid off.

### The new shape — what changed (all small edits, no new database changes)

- **The connection lookups** now use the account (`account_id` + the channel + "no specific location") instead of the shop id. This touched: the status check the widget polls (`/api/dashboard/channels`), the connect/disconnect helper functions, and both the owner-facing and admin-facing Telegram/WhatsApp routes.
- **The "only one mobile channel at a time" lock** is now per-account for Telegram/WhatsApp (so two people on the same account can't both connect at the same instant).
- The old shop id (`business_id`) is still stored on each row for history, but it's no longer used to *find* the connection.

### The new house rule

Owner channel enrollment is an **account-level** thing. Look it up by `account_id` (+ channel, + "no specific location"), never by the owner's `business_id`/location. The `.claude/CLAUDE.md` gotcha and `.claude/reference/migrations-log.md` (risk #5) both spell this out.

### What didn't change

No database migration — this was purely a change to *how we query*. Email, SMS, and the actual review/response flow are untouched. Single-location businesses were never affected by the bug and behave exactly as before.

### What's still left (deferred, written up in `docs/known-issues.md`)

Three spots still use the old shop-id lookup and are the **same bug class**, but lower-impact, so they're tracked for later: admin **SMS** enrollment (can waste a Twilio verification text on multi-location accounts), the notification **dispatcher**'s "owner blocked us" handling, and the admin **business-detail page**'s channel status display.

### Where to read more

- `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md` — the design.
- `docs/known-issues.md` — the three deferred items.
- `docs/progresstracking.md` — the full PR #54 log.

---

## Quick summary — what shipped 2026-05-22 (WhatsApp owner self-service)

In simple words:

### What we changed

Business owners can now connect WhatsApp to RepWorth themselves, from the **Settings → Channels** page — the same way they already connect Telegram. Before this, only an admin could turn WhatsApp on for a business; the owner's page just showed a greyed-out "coming soon" box. The whole feature is still switched off in production (behind the `CHANNELS_WHATSAPP_ENABLED` flag) until the real WhatsApp number and message template are approved by Meta.

### Why we did it

The WhatsApp code was built months ago but parked, waiting for the WhatsApp Business Account to be approved. That approval came through, so we finished the last missing piece (the owner-facing "Connect" button) and wrote the step-by-step guide for actually turning it on.

### The new shape — what got added

- **`src/components/dashboard/OwnerWhatsAppWidget.tsx`** — the "Connect WhatsApp" box the owner sees. Shows a QR code / link to scan, then flips to "Connected" once they message the number. Copied from the Telegram widget.
- **`src/app/api/dashboard/channels/whatsapp/start|cancel|disable/`** — three small API endpoints behind that button (begin connecting, cancel a half-finished connect, disconnect). They only ever act on the logged-in owner's own location.
- **`src/lib/channels/whatsapp-enrollment.ts`** — got two new shared functions (`startWhatsAppEnrollment`, `disableWhatsAppEnrollment`) so the "begin" and "disconnect" database logic lives in one place instead of being copy-pasted into the routes. The older admin route was switched over to use them too.
- **`docs/runbooks/whatsapp-templates.md`** — the "how to actually launch it" checklist: which message template to submit to Meta, what to set in Vercel and Railway, and the 8 things to test before flipping the switch.
- **`docs/known-issues.md`** (new) — records a multi-location bug we found (see below).

### The new house rule

WhatsApp owner self-service is **single-location-only for now.** If an account has more than one location, the owner sees "coming soon" instead of the Connect button, and the connect endpoint refuses with a clear error. This is a deliberate guardrail around a pre-existing bug (the owner connect/disconnect logic looks up the row by location, but the page reads it by account, so on accounts with multiple owners they can disagree). The same bug quietly affected SMS (now removed) and Telegram too — it's written up in `docs/known-issues.md` with a proper fix planned separately.

### What didn't change

Email and Telegram all work exactly as before. The admin-side WhatsApp enrollment (on the business detail page) is unchanged except that it now calls the shared helper functions. Nothing about review ingestion, response generation, or posting changed. And because the flag is still off, customers see no difference until launch.

### Where to read more

- `docs/runbooks/whatsapp-templates.md` — the launch checklist + how to submit the Meta template.
- `docs/known-issues.md` + `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md` — the multi-location desync and its planned cross-channel fix.
- `docs/progresstracking.md` — the full sprint log for this work (PR #53).

---

## Quick summary — what shipped 2026-05-09 (Multi-location support)

In simple words:

### What we changed

We added the ability for one owner to manage **many Google Business Profile locations** under a single subscription. Before today, every owner row mapped 1:1 to a single business and a single Google location. Now the same owner can hold multiple locations under one billing umbrella, switch between them in the dashboard, get notifications routed by location, and bill cleanly via Stripe overage.

### Why we did it

The pricing page already advertised multi-location as a Premium feature, but the code didn't support it. Small chains (the Premium tier's stated audience) couldn't actually onboard without manually creating one full account per location. This branch closes that gap.

### The new shape — what got added, what got rearranged

```
src/
├── app/
│   ├── (authenticated)/
│   │   ├── dashboard/
│   │   │   └── add-location/                  ← NEW: 4-step wizard for adding a location
│   │   │       ├── page.tsx
│   │   │       ├── AddLocationWizard.tsx
│   │   │       └── __tests__/
│   │   └── settings/
│   │       ├── locations/                     ← NEW: list, archive, reactivate, promote-primary
│   │       ├── voice/                         ← NEW: per-location voice config tab
│   │       └── channels/                      ← NEW: per-location channel override tab
│   │
│   └── api/
│       ├── locations/                         ← NEW route group
│       │   ├── add/                           (owner: insert businesses + audit + outbox)
│       │   ├── archive/
│       │   ├── reactivate/
│       │   ├── promote-primary/
│       │   ├── display-label/
│       │   └── existing-place-ids/
│       ├── billing/                           ← NEW route group
│       │   ├── checkout/                      (server-built Stripe Checkout Session)
│       │   ├── portal/                        (POST → Stripe billing portal URL)
│       │   └── tier-change/                   (upgrade/downgrade)
│       ├── settings/
│       │   ├── voice/                         ← NEW
│       │   └── channels/override/             ← NEW
│       └── admin/
│           └── locations/csv-import/          ← NEW: bulk CSV upload
│
├── lib/
│   ├── accounts/                              ← NEW module
│   │   ├── tier-config.ts                     (basic / standard / premium / founders)
│   │   ├── quota.ts                           (assertCanAddLocation, computeOverageQuantity)
│   │   └── repo.ts                            (getAccountById, getAccountOwnerUserId)
│   ├── locations/                             ← NEW module
│   │   ├── add-location-tx.ts                 (atomic add — businesses + audit + outbox)
│   │   ├── archive-location-tx.ts             (atomic archive + reactivate)
│   │   ├── promote-primary-tx.ts              (atomic primary swap)
│   │   ├── repo.ts                            (getLocationById, getActiveLocationCount, …)
│   │   └── display-label.ts                   (getDisplayLabel helper)
│   ├── notifications/
│   │   └── resolve-channels.ts                ← NEW chokepoint: org-default vs per-location override resolver
│   │                                            with 5-min Redis cache + safeInvalidateChannelCache wrapper
│   ├── admin/
│   │   └── csv-import.ts                      ← NEW: parse, validate, processRow + aggregate enqueue helper
│   └── shared/
│       └── ids.ts                             ← UPDATED: branded AccountId + LocationId types
│
worker/
└── jobs/
    └── billing/                               ← NEW folder
        └── UpdateStripeOverageWorker.ts       (handles outbox topic 'update_stripe_overage_quantity'
                                                with Stripe idempotency keys)
```

The schema gained an `accounts` table (the new billing parent), an `account_audit_log` table, and `account_id` denormalization on six existing tables. The `businesses` table now means "a single Google Business Profile location" — the owner-facing concept of "the business" lives on `accounts`. We kept the `businesses` name because renaming 150+ files of `business_id` references would have cost weeks for no functional gain. CLAUDE.md now carries this naming honesty as an architecture invariant.

### How to find what you need

- **"How does an owner add a location?"** → `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx` calls `POST /api/locations/add` which calls `src/lib/locations/add-location-tx.ts` (atomic businesses INSERT + audit log + Stripe overage outbox + Zernio backfill outbox).
- **"How is the dashboard scoped to all-locations vs one location?"** → `src/app/api/dashboard/route.ts` reads `?scope=all` or `?scope=<locationId>`. Falls back to the user's primary location. The `rw_location_scope` cookie persists the choice across navigations.
- **"Where does Stripe overage billing happen?"** → `worker/jobs/billing/UpdateStripeOverageWorker.ts`. Reads outbox rows of topic `update_stripe_overage_quantity`, retrieves the subscription, and updates the overage subscription item with idempotency keys. Add / archive / reactivate / tier-change all enqueue the same topic.
- **"Where does notification routing decide which channel + handle?"** → `src/lib/notifications/resolve-channels.ts`. It groups `channel_enrollments` rows for the account, prefers per-location overrides, ignores archived/unverified/unsubscribed rows, and caches the result in Redis for 5 minutes. Every write path calls `safeInvalidateChannelCache(accountId, context)` — a wrapper that logs Redis failures instead of silently swallowing them.
- **"Where does the publisher refuse to post for archived locations?"** → `worker/jobs/publisher/ResponsePublisherWorker.ts:67-92`. The load query selects `b.archived_at` and short-circuits with `markOutboxCompleted` if the location was archived after the response was approved.
- **"What does the cancellation grace period read?"** → `accounts.cancelled_at + 30 days` (with `subscription_activated_at` legacy fallback). Set by the Stripe webhook on `customer.subscription.deleted`.
- **"Where do migrations 034–041 live?"** → `supabase/migrations/`. The runbook at `docs/runbooks/multi-location.md` lists the apply order and what each one does.

### The new house rule

`.claude/CLAUDE.md` now carries this invariant:

> **`businesses` row = location; `accounts` row = billing parent.** Since multi-location (migration 034), the `businesses` table holds one row per Google Business Profile location. Subscription / Stripe / quota state lives on `accounts`. Naming kept for blast-radius reasons; do not re-introduce subscription columns on `businesses`.

### What didn't change

The single-location experience. If an owner has exactly one location (basic tier or any tier with one location), the location switcher is hidden, the settings page keeps its old shape, and the dashboard renders without the per-location KPI strip. Multi-location is opt-in via the `MULTI_LOCATION_ENABLED` flag — when off, the new routes return 404 and the legacy paths run unchanged.

The approval flow, response generation, Zernio ingestion, and review dedup logic are all unchanged. Reviews and responses still scope by `business_id` (= location_id), and that's still the only correct way to scope per-location data. The new `account_id` column is for cross-location queries (aggregate dashboard, billing, audit) — never use it as a substitute when you actually want a specific location.

### What got better as a side effect

- Auth is now triple-gated for owner mutations: proxy role + account_id check, then in-route `requireRole('owner')`, then per-resource ownership lookup against the session's account. Closes IDOR risks that were possible in the original single-location code if URLs leaked.
- Channel cache invalidation now logs Redis hiccups via `safeInvalidateChannelCache` instead of `.catch(() => {})`. TCPA-relevant cache staleness is no longer silently masked.
- Migration 040+041 tightened RLS on `businesses` and `channel_enrollments` — owners can only directly UPDATE the safe columns (tone, products_services, etc.); subscription / Stripe / `is_primary` / `archived_at` columns require service-role + the dedicated transaction paths.
- Eight new lab notes captured in `.claude/reference/lab-notes.md` — including the "column-level REVOKE doesn't override a table-level GRANT" gotcha and the "FOR UPDATE outside `sql.begin()` is a no-op under PgBouncer" gotcha.

### Where to read more

- `docs/runbooks/multi-location.md` — full implementation runbook + 18 manual test cases + known non-blocking debt list.
- `docs/superpowers/specs/2026-05-06-multi-location-design.md` — the original design spec (gitignored, local-only).
- `docs/superpowers/specs/2026-05-07-multi-location-investigation.md` and `2026-05-07-multi-location-readiness.md` — the pre-implementation investigation and readiness checks (also gitignored).
- `docs/progresstracking.md` — full sprint log of what we built, the 13-issue security review, and the 5-issue post-launch fix-pass.

---

## Quick summary — what shipped 2026-05-05 (Worker index failure extraction, PR #18)

In simple words:

### What we changed

We took the long inline error-handling code out of `worker/index.ts` and moved it into its own files next to the workers it belongs to. The boot file now does just one thing: register workers and start the server. The actual logic for what happens when a job fails for the last time lives next door.

### Why we did it

Before: `worker/index.ts` was 607 lines and did three different things at once — set up Sentry, register all the BullMQ workers, AND own ~250 lines of database-writing failure logic inside two big inline `worker.on('failed', …)` callbacks. The failure logic had almost no test coverage because it was buried deep inside a boot file. Hard to read, hard to test, easy to break.

After: `worker/index.ts` is **296 lines** of pure registration. Each `worker.on('failed', …)` is a one-liner pointing at a named function. The failure logic now lives in tested modules right next to the workers that throw the errors.

### The new shape

```
worker/
├── index.ts                ← still the bootstrap, but now pure registration + lifecycle
├── sentry.ts               ← NEW: Sentry init + key-redaction scrubber
│
├── jobs/
│   ├── zernio/
│   │   ├── ZernioReviewIngestWorker.ts
│   │   └── ingest-failed-hook.ts        ← NEW: handleIngestFailed
│   │
│   └── publisher/
│       ├── ResponsePublisherWorker.ts
│       ├── publisher-error-handlers.ts
│       └── failed-hook.ts               ← NEW: handlePublisherFailed
```

### How to find what you need

- **"Where does Sentry get configured?"** → `worker/sentry.ts`
- **"What happens when a Zernio ingest job fails for the last time?"** → `worker/jobs/zernio/ingest-failed-hook.ts`
- **"What happens when a publish-to-Google job fails for the last time?"** → `worker/jobs/publisher/failed-hook.ts`
- **"Where do the BullMQ workers get registered?"** → still `worker/index.ts`. The `.on('failed', …)` callbacks are now one-liners that delegate to the modules above.

### The new house rule

`.claude/CLAUDE.md` now carries this invariant:

> **Entry points orchestrate; modules own failure behavior.** Route handlers, worker boot files, and ingress handlers may validate, orchestrate, and map errors, but must not own durable side effects inside long failure branches. Extract any error-handling branch over ~30 lines into a named module interface next to its caller, with focused tests for the branch.

This PR was the first application of that rule. PRs #2 and #3 (next on the runway) apply the same rule to two Next.js routes (`select-location/route.ts` and `callback/route.ts`).

### What didn't change

Behavior. Every Sentry tag, every error message, every database write, every outbox reason is byte-equal to what it was before. This was pure code-motion — no logic edits, no formatting drift. If a customer's review fails to ingest tomorrow, the same row gets written to `review_exceptions` with the same payload as it would have a week ago.

### What got better as a side effect

Two error branches that had **zero** direct test coverage on `main` are now tested:

- The "bare ZernioTransientError reached failed-hook" defensive branch (a code-bug indicator that should never fire — but if it does, we now know it'll log + Sentry-capture correctly).
- The "last-resort handler-crash" branch (the safety net for when even our `markOutboxFailed` call throws).

### Where to read more

- `docs/superpowers/specs/2026-05-05-entry-point-modularization-design.md` — the full Group A spec covering all three PRs (local-only, not in git).
- `docs/superpowers/plans/2026-05-05-pr1-worker-index-failure-extraction.md` — the implementation plan that drove this PR (also local-only).
- `docs/progresstracking.md` — full commit-by-commit log of the 13 commits behind PR #18.

---

## Quick summary — what shipped 2026-05-05 (Worker folder reorganization)

In simple words:

### What we changed

We rearranged the files inside the `worker/` folder. Nothing the app *does* changed — same workers, same handlers, same behavior. The change is purely about where files live so the codebase stays easy to navigate as we add more workers and background loops.

### Why we did it

Before: `worker/jobs/` had 28 files mixing three different things — actual job processors, pollers that watch the database, and schedulers that run on a clock. `worker/ingress/` had 17 files where webhook entry points sat next to provider-specific helper modules. Tests were spread across three different `__tests__/` folders that didn't match each other. Hard to scan, hard to know where a new file belongs.

After: each folder has one clear job. Tests live next to the source they test, the way the rest of the codebase already does it.

### The new shape

```
worker/
├── env.ts            ← loads .env.local first
├── index.ts          ← the bootstrap (Sentry, Fastify, BullMQ workers, lifecycle)
├── queues.ts         ← all 16 BullMQ queue definitions in one place
│
├── config/           ← boot-time env-var assertions
│
├── ingress/          ← webhook handlers (Stripe, Resend, etc.)
│   ├── twilio/       ← WhatsApp inbound + shared Twilio helpers
│   ├── telegram/     ← Telegram bot webhooks + helpers
│   └── zernio/       ← Zernio review webhook + signature verify
│
├── jobs/             ← BullMQ job processors (one per `new Worker(...)`)
│   ├── notification/ ← NotificationWorker + its 5 helper modules
│   ├── publisher/    ← ResponsePublisher + error handlers
│   └── zernio/       ← Zernio backfill + ingest workers + shared helpers
│
└── background/       ← long-running loops that aren't BullMQ jobs
    ├── pollers/      ← watch the database for state changes (OutboxPoller, etc.)
    └── schedulers/   ← run on a clock (WeeklySummaryScheduler, etc.)
```

### How to find what you need

- **"Where does Stripe webhook code live?"** → `worker/ingress/stripe.ts`
- **"Where does the WhatsApp signature get verified?"** → `worker/ingress/twilio/twilio-verify.ts`
- **"Where does the email-bounce notification get sent?"** → `worker/jobs/notification/NotificationWorker.ts`
- **"What handles posting a reply to Google?"** → `worker/jobs/publisher/ResponsePublisherWorker.ts`
- **"What drains pending outbox rows into BullMQ?"** → `worker/background/pollers/OutboxPoller.ts`
- **"What enqueues the weekly summary email?"** → `worker/background/schedulers/WeeklySummaryScheduler.ts`
- **"Where do all the workers get registered?"** → still `worker/index.ts` — that file is the canonical "what runs" map.

### Two rules we kept

1. **No barrel/index files inside `worker/`.** Every poller, scheduler, and worker is imported by name in `worker/index.ts`. That file is the runtime registry — you can read it top-to-bottom and see exactly what's running.
2. **Tests live next to the code they test.** Just like everywhere else in `src/`. So `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` sits right next to `worker/jobs/zernio/ZernioBackfillWorker.ts`.

### What didn't move

Class names didn't change. `OutboxPoller` is still `OutboxPoller`. `NotificationWorker` is still `NotificationWorker`. So any documentation or skill file that talked about those by name is still correct — only the file paths changed.

### Where to read more

- `docs/directory.md` — the full file-by-file reference, with one row per file describing what it does.
- `docs/superpowers/specs/2026-05-04-worker-folder-reorg-design.md` and `docs/superpowers/specs/2026-05-05-worker-background-split-design.md` — the planning documents (local-only, not in git).

---

## Quick summary — what shipped 2026-05-04 (Pre-paywall demo + journey reorder)

In simple words:

### The problem we solved

People who signed up for RepWorth used to go straight from "give us your business location" to "give us your credit card." They had to *imagine* what AI replies for their reviews would look like, then trust us with money. A lot of them dropped off at the paywall. We had no proof-of-value moment.

### What we shipped (behind a flag)

A new screen between signup and the paywall that **shows the owner what RepWorth would actually write for their real Google reviews — for free, before they pay.**

The new flow:

1. **Sign up** → confirm email.
2. **`/onboarding/start`** — type business name + pick from Google Maps autocomplete (or paste a Google Maps URL).
3. **`/onboarding/demo`** — within ~10 seconds the page shows 3 of their actual recent reviews with AI-generated responses underneath each one. Big "Choose a plan →" button.
4. **`/onboarding/pay`** — Stripe checkout (unchanged).
5. **`/onboarding/business`** — same form as before but only **Profile** and **Voice** steps now (Location was captured back at step 2). Header reads: *"You're in. Two quick questions to make responses sound like you, then we go live."*
6. **`/dashboard`** — now has a **setup checklist** card at the top showing four boxes (Connect Zernio, Approve your first response, Tune your voice, Set notifications). Each shows ✓ when done.

### What if our demo can't be generated?

Corner cases the user might hit, and what they see:

- **Their business has very few or low-rated Google reviews** → we show three pre-written sample reviews + sample responses with a small note: *"Sample reviews shown — connect your account after signup to see your real ones."* Demo still completes; paywall still shows.
- **Our daily $10 budget for free demos is used up** → we still let them onto `/onboarding/demo` but show the paywall directly: *"Your live demo is on the way after signup — for now, you can still subscribe."* No infinite redirect loop.
- **Demo generation flat-out fails (e.g., SerpAPI down)** → we show a "Try again" button AND the paywall right below. Payment is never blocked on a demo issue.
- **They paid mid-flight** (between clicking Generate and the worker picking up the job) → we mark the demo `failed` (not empty `completed`, which would lock them into never being able to regenerate) and they go on to the paywall path.

### Why it's flag-gated

`ONBOARDING_DEMO_ENABLED=false` keeps the legacy 3-step Location/Profile/Voice wizard exactly as it is today. Flip the flag on, and the new flow appears. We can deploy code without changing user-visible behavior, then turn it on for staff first, then everyone.

### What changed in the codebase

**New UI files:**
- `src/app/onboarding/start/page.tsx` + `StartLocationClient.tsx` — the new "find your business" screen.
- `src/app/onboarding/demo/page.tsx` + `PaywallWithDemoClient.tsx` — the demo + paywall screen.
- `src/app/(authenticated)/dashboard/SetupChecklist.tsx` + `SetupChecklistClient.tsx` — the dashboard checklist.

**New backend files:**
- `src/app/api/onboarding/start/route.ts` — receives the location capture, creates the demo job in one transaction.
- `src/app/api/onboarding/demo/status/route.ts` — the page polls this every 2 seconds while the demo is generating.
- `src/app/api/onboarding/demo/regenerate/route.ts` — fires when the user clicks "Regenerate demo".
- `src/lib/costs/onboarding-demo-cost-guard.ts` — keeps the global $10/day demo spend ceiling. Reserves 20¢ before each demo, reconciles to actual cost (~3¢) after.
- `src/lib/demos/fallback-content.ts` + `__fixtures__/fallback-source-reviews.ts` — the canned reviews + replies we show when SerpAPI returns nothing useful.
- `worker/jobs/OnboardingDemoWorker.ts` — the worker that fetches reviews, generates responses, and writes the demo row.

**Modified files:**
- `src/app/api/onboarding/business/route.ts` — when the flag is on, uses a different schema (rejects location fields) and only writes profile/voice. When the flag is off, exactly the same as before.
- `src/app/onboarding/business/BusinessWizardClient.tsx` + `ProgressDots.tsx` + `guard.ts` + `page.tsx` — the wizard now adapts to 2-step or 3-step based on the flag.
- `src/lib/shared/schemas.ts` — added `OnboardingStartSchema` (tighter business-name regex because the value flows into the LLM prompt) and `BusinessOnboardingPostPaySchema` (rejects `googlePlaceId`/`googleMapsUrl` via `z.never()`).
- `src/lib/shared/queue-names.ts` + `worker/queues.ts` + `worker/index.ts` — registered the new `onboarding_demo_response` queue + worker.
- `src/lib/demos/lifecycle.ts` — `completeDemo` now handles two demos completing for the same user at once (catches Postgres 23505, archives the loser, closes its outbox).
- `worker/jobs/CleanupAbandonedSignupsPoller.ts` — explicitly deletes onboarding_demos rows when cleaning up abandoned signups, plus a top-of-loop pass that drops completed demos older than 30 days.

**New database migration: 032**
- `supabase/migrations/032_onboarding_demos.sql` — new `onboarding_demos` table (sister to the existing `prospect_demos`), with a partial unique index that enforces "one completed demo per user", and a partial cleanup index for the 30-day deletion pass.
- **Important:** the user runs migrations themselves. The file is committed but the SQL has NOT been applied yet.

**New env vars:**
- `ONBOARDING_DEMO_ENABLED` (default off) — master switch.
- `ONBOARDING_DEMO_DAILY_CENTS` (default 1000 = $10/day) — global cost ceiling.
- `ONBOARDING_DEMO_STAFF_EMAILS_CSV` — Phase 3 staff allowlist (not yet wired into the route).

**Test runbook:** `docs/runbooks/pr-2-pre-paywall-demo-test.md` — step-by-step for verifying the implementation locally.

### What's still left for later (Phase 2+)

- **Per-category curated fixtures** — today we have one "general business" fallback for everyone. A script will eventually generate restaurant-specific, salon-specific, etc. versions.
- **`api_costs` ledger entries** — today demo spend lives only in Redis. The admin cost dashboard won't see this lane until we add a `cost_lane` column to the `api_costs` table.
- **Auto-regenerate on stale revisit** — if the user bookmarks `/onboarding/demo` and comes back the next day, today they see a "Last updated 1 day ago" footnote and have to click the Regenerate button. Phase 2 may auto-trigger regeneration on the SSR page.
- **Phase 3 staff-allowlist gating** — the env var exists but the route doesn't yet check it. Wire that up before flipping the flag globally.

---

## What changed before that — 2026-05-02 (Past Replies, view-only)

In simple words:

### The problem we solved

When an owner connects Zernio for the first time, we used to silently throw away every Google review they had already personally replied to before signing up for RepWorth. They lost the entire history. Tanicia Resort lost 8 reviews that way. The owner had no record of past engagement, our voice-learning hook had no bootstrap data, and there was no place in our dashboard to even see those replies.

### What we shipped

A new **read-only "Past Replies" tab** in the owner dashboard. Every existing Google reply is now ingested into our database as a `posted` response and shown in a paginated list (50 per page), grouped into two sections:
- **"From your active period"** — reviews that came in AFTER the owner started paying.
- **"From before you joined"** — reviews from BEFORE the owner started paying. Non-premium owners see a small upsell banner ("Premium customers will be able to edit replies to historical reviews using their current brand voice once direct Google integration ships").

Each card shows the customer's review on the left, the reply that's live on Google on the right, and a small label that says either **"Imported from Google · 2024-08-14"** (the owner posted it directly on Google) or **"Posted via RepWorth · 2024-08-14"** (we posted it for them).

**No edit button. No regenerate button. No drawer.** The full edit feature is parked (see below).

### Why it's read-only — the split decision

The original branch `feat/edit-existing-replies` had the full feature: 31 commits, 6 review rounds, ~3,500 LOC, an EditReplyDrawer with 9 states, 7 API routes, a publisher DELETE+POST locked-tx state machine with orphan-marker recovery, and recovery routes (Retry/Restore-original).

Why we didn't ship that whole thing:

1. **Zernio's API requires DELETE-then-POST to edit a reply.** Direct GBP (Google Business Profile) API uses single-PUT replacement. About 25% of the parked code (the DELETE+POST recovery state machine, the orphan-marker convention, the recovery routes) becomes unnecessary the moment GBP arrives. Building Zernio-shaped recovery for production support of a feature that will be deleted is engineering debt.

2. **GBP is at least 6-18 months away** (we haven't even applied yet). During that window the original Tanicia pain keeps recurring. We needed the visibility win NOW.

3. **The visibility slice is 30% of the code, 5% of the operational complexity, and addresses the original user pain.** The other 70% (edit + recovery) is the optional feature on top.

4. **The branch was stabilizing but not stable.** Six review rounds kept finding successively smaller variants of the same hidden-draft bug class in the regenerate flow. Each round was real engineering hours, and post-launch ops would inherit that complexity.

So we **split**: ship the visibility slice (this branch) now; park the edit machinery on tag `wip/edit-existing-replies-zernio-v1` for either GBP-time reuse OR resurrection if GBP timeline blows up beyond 12 months.

### Two flags

`EDIT_EXISTING_REPLIES_ENABLED` (the original single flag) was renamed and split into TWO independent flags so the operator controls write rollout separately from UI rollout:

- **`EXTERNAL_REPLY_IMPORT_ENABLED`** — gates the WRITES path. When on, `reconcileExternallyAnsweredReview` ingests previously-silent external replies as `posted` responses. When off, today's silent-no-op behavior preserved.
- **`PAST_REPLIES_VIEW_ENABLED`** — gates the UI. When on, the page renders + the OwnerNav link appears. When off, the page returns 404 + nav link is hidden.

Why two flags? Imported `posted` rows count toward the dashboard's "total responded" metric. Turning ingestion on changes customer-visible numbers. The split lets the operator turn ingestion on first, soak silently while watching the metric shift in product analytics, then turn the UI on once they're comfortable.

### Where everything lives on `feat/past-replies-view`

- **Migration:** `supabase/migrations/031_edit_existing_replies.sql` — adds `reviews.external_reply_ingested_at`, `zernio_backfill_runs.external_reply_ingested_count`, partial unique index `responses_one_posted_per_review`, secondary index `idx_reviews_business_review_date`. **Apply non-transactionally; pre-flight check is required (see runbook §10).**
- **Worker (extended, not new files):** `worker/jobs/zernio-ingest-shared.ts` — `reconcileExternallyAnsweredReview` gets two new flag-gated branches (`insertImportedReview` + `insertImportedResponse` + `bumpExternalReplyIngestedCount`).
- **Zernio client safety fixes:** `src/lib/zernio/client.ts` normalizes `reviewReply` to null at the API chokepoint + `summarizeShape` helper for redacting raw JSON in unrecognized-shape logs. `worker/jobs/publisher-error-handlers.ts` exports `redactSensitiveError` which now wraps persisted error bodies in `handlePublisherPermanentErrorTerminal`.
- **Dashboard page:** `src/app/(authenticated)/dashboard/past-replies/page.tsx` (server component, paginated, gap/historical bucketing).
- **Components:** `src/components/dashboard/PastReplyCard.tsx` (read-only card) + `src/components/dashboard/HistoricalUpgradeBanner.tsx` (soft upsell).
- **Nav link:** `src/components/OwnerNav.tsx` accepts `pastRepliesEnabled` prop; `src/app/(authenticated)/layout.tsx` passes `process.env.PAST_REPLIES_VIEW_ENABLED === 'true'`.
- **Backfill script:** `scripts/zernio-backfill-external-replies.ts` — one-off CLI for retroactive ingestion. Requires `EXTERNAL_REPLY_IMPORT_ENABLED=true` to run.
- **Runbook:** `docs/runbooks/zernio-launch-runbook.md` §10 — Phase A → B1 → B2 rollout playbook.

### What's pending before customers see this

1. **Apply migration 031** in production Supabase. Pre-flight check first (run the SQL in the migration file's comments — confirm zero duplicate `posted` rows). Apply non-transactionally (uncheck the single-tx box in Supabase SQL editor).
2. **Phase A:** ship code with both flags off, soak ≥ 1 week.
3. **Phase B1:** turn on `EXTERNAL_REPLY_IMPORT_ENABLED` in prod env. Silent ingestion starts. Watch the dashboard "total responded" count in product analytics.
4. **Phase B2:** turn on `PAST_REPLIES_VIEW_ENABLED` in prod env. Owners see the new tab.
5. **Pilot one customer end-to-end** before wider rollout.
6. **File the GBP API application** if not already.

### What's deferred

- The full edit / regenerate / publish / retry / restore-original feature — parked on tag `wip/edit-existing-replies-zernio-v1`. Revive only when GBP arrives (rebuild against single-PUT) OR GBP timeline blows up beyond 12 months (resurrect the parked branch with another review pass on the residual hidden-draft variants).
- Integration tests + E2E tests (deferred from the parked branch — need `TEST_DATABASE_POOL_URL` + Playwright harness).

### Directory changes (for future reference)

**New files on this branch:**
- `supabase/migrations/031_edit_existing_replies.sql`
- `src/app/(authenticated)/dashboard/past-replies/page.tsx`
- `src/components/dashboard/PastReplyCard.tsx`
- `src/components/dashboard/HistoricalUpgradeBanner.tsx`
- `scripts/zernio-backfill-external-replies.ts`

**Modified files on this branch:**
- `worker/jobs/zernio-ingest-shared.ts` (extended with import branches)
- `worker/jobs/ZernioBackfillWorker.ts` (loose-equality `reviewReply` guards)
- `worker/jobs/ZernioReviewIngestWorker.ts` (loose-equality `reviewReply` guards)
- `worker/__tests__/zernio-ingest-shared.test.ts` (7 new test cases)
- `worker/jobs/publisher-error-handlers.ts` (export `redactSensitiveError` + use it in handlePublisherPermanentErrorTerminal)
- `src/lib/zernio/client.ts` (`listReviews` reviewReply normalization + `summarizeShape` helper + 3 redacted log sites)
- `src/app/(authenticated)/layout.tsx` (passes `pastRepliesEnabled` prop)
- `src/components/OwnerNav.tsx` (renders Past Replies link conditionally)
- `docs/runbooks/zernio-launch-runbook.md` (§10 rewrite for dual-flag rollout)

**Files that are NOT on this branch (parked on tag `wip/edit-existing-replies-zernio-v1`):**
- `src/app/api/dashboard/past-replies/draft/route.ts`
- `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts`
- `src/app/api/dashboard/past-replies/draft-status/route.ts`
- `src/app/api/dashboard/past-replies/publish/route.ts`
- `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts`
- `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts`
- `src/components/dashboard/EditReplyDrawer.tsx`
- `src/lib/responses/edit-existing.ts` (assertCanEditReply + validateOptimisticConcurrency)
- `worker/jobs/publisher-on-failed.ts` (orphan-marker conversion)
- The `runEditPublisherIfApplicable` branch in `worker/jobs/ResponsePublisherWorker.ts`
- The `verify409InTx` helper in `worker/jobs/publisher-error-handlers.ts`
- The stale-marking branch in `src/lib/reviews/process-review.ts`
- The `deleteReply` method + `ZernioReplyAlreadyDeletedError` in `src/lib/zernio/client.ts`/`errors.ts`

For details: see [progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md](progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md) "feat/past-replies-view" section, `docs/runbooks/zernio-launch-runbook.md` §10.

---

> **Older build snapshots archived** to keep this file readable. The three historical
> "Every File In The Project" full-tree dumps, the April-era feature deep-dives
> (self-serve signup, Zernio, channels), and the stale "What's Left To Build" fossil
> now live in [progress-archive/currents-history-2026-04-to-05.md](progress-archive/currents-history-2026-04-to-05.md).
> The dated summaries below (2026-05-22 → 2026-06) are kept live.

---

## What shipped 2026-05-22 (Billing tiers + Locations UX) — `feat/billing-locations-ux`

In simple words:

### What we changed

Two things. First, the **pay/onboarding page** now shows all four real plans — Founding Member, Basic, Standard, Premium — and the prices come straight from one config file instead of being typed in by hand (so they can't drift from what Stripe actually charges). Second, the **Locations settings page** now shows up as soon as the multi-location feature flag is on, even if you only have one location — so a freshly-paid Standard/Premium owner can immediately see how to add a second location. Basic owners see that same page but with a friendly "upgrade to add locations" message instead of an Add button.

### Why it was confusing before

The old code used one yes/no check — "do you already have more than one location?" — to decide everything: whether to show the Locations tab, whether to switch the dashboard into multi-location mode, and whether you could add a location. So a brand-new multi-location customer with exactly one location got locked out of the very feature they paid for.

### The new shape — what got added, what changed

```
src/
├── app/
│   └── onboarding/pay/
│       └── plan-options.ts                 ← NEW: the single source for plan names + prices
│                                              (price read from TIER_CONFIG, not hardcoded)
│       └── PlanPickerClient.tsx            ← now renders all 4 tiers (was 3)
│
├── lib/
│   └── locations/
│       └── multi-location-mode.ts          ← now has THREE helpers instead of one:
│            • shouldUseMultiLocationSettings → "are you in multi-location MODE?" (count > 1)
│            • shouldShowLocationsSettings    → "should the Locations TAB show?" (flag only)
│            • canAddLocationForAccount       → "are you ALLOWED to add one?" (flag + active + tier)
│   └── accounts/
│       └── quota.ts                         ← billing math now reads STORED quota
│                                              (locations_included + locations_overage_price_cents)
│                                              from the account, not the live tier config
│
└── app/(authenticated)/settings/
    ├── locations/page.tsx                   ← shows on the flag alone; computes the
    │                                           Basic "locked" vs eligible "Add Location" state
    └── (page/voice/channels)                ← pass the new "locations visible" flag through;
                                                single-location Voice now links to /settings#brand-voice
```

### One thing to remember

Money math (how many locations are included, and the per-extra overage price) is read from **stored columns on the account**, frozen at the time you signed up — not from the live price table. The one exception is the **base monthly price**, which still comes from the live table because there's no stored column for it yet. That matters most for Founding Members ("rate locked for life") — see the TODO in `quota.ts` and the runbook's Known Issues.

## What shipped 2026-05-25 (Wave 1 — launch-risk hardening) — `codex/wave-1-foundation-launch-risk`

In simple words:

### What we changed

Five safety nets that need to be in place before we open the doors to paying customers:

1. **Proof that customers can't see each other's data.** Two automatic checks now run on every code change — one confirms the database's row-level security is switched on for every customer table, the other scans our SQL to make sure queries are always filtered to the right account. There's also a test that creates two fake customers and tries to make one peek at the other; if it ever succeeds, the build fails.
2. **A billing watchdog.** Once an hour we compare what Stripe is charging each customer against what our own records say they should pay (right plan, right number of locations, right invoice total). If anything drifts, it raises an alert for a human — it never silently "fixes" money. Customers on old grandfathered prices don't get false alarms, because we compare against their *stored* price, not today's price.
3. **A medical-info filter.** Before any Google review is saved, we scan it for things that look like protected health info (medical record numbers, insurance IDs, first-person medical details). If it trips the filter, the review is held for a human instead of being stored, and we never write the raw text into logs.
4. **Honest public legal & security pages.** Proper `/legal/...` pages (terms, privacy, AUP, DPA, cookies, sub-processors), a `/security` page, and a `security.txt` — all written truthfully (we say "SOC 2 not yet done" rather than implying we have it). Every place an owner approves an AI reply now shows a "this was drafted by AI, review before approving" notice.
5. **A tamper-proof record of approvals.** When an owner approves a reply, we now save an exact frozen copy of the words they approved. Even if the reply text changes later, that snapshot can't change — it's our evidence if a customer ever disputes "I never approved that."

### Why it mattered

These are the five things that can sink a young SaaS in its first months: leaking one customer's data to another, charging the wrong amount, storing health info we shouldn't, making legal claims that aren't true, or having no proof of what a customer approved. None of them are "features" customers ask for — they're guardrails, so they're always on (no off-switch).

### The new shape — what got added

```
scripts/ci/
├── rls-audit.ts                 ← NEW: fails the build if a customer table has RLS off
├── tenant-scope-audit.ts        ← NEW: scans SQL for missing account/location filters
├── tenant-scope-allowlist.ts    ← NEW: vetted "known-safe" exceptions (CI-guarded)
└── tenant-tables.ts             ← NEW: the list of customer-scoped tables

src/
├── lib/security/phi-scanner.ts  ← NEW: the medical-info filter (co-occurrence rules)
├── lib/legal/content.ts         ← NEW: all legal text in one typed file (no new framework)
├── lib/ui/disclosures.ts        ← NEW: the single "Draft generated by AI" sentence
├── app/(public)/legal/*         ← NEW: terms/privacy/aup/dpa/cookies/sub-processors pages
├── app/(public)/security/page.tsx ← NEW: public security/disclosure page
└── app/(public)/{terms,privacy} ← now 308-redirect to their /legal/* homes

worker/background/pollers/
├── StripeLocationsReconcilePoller.ts       ← now does full billing reconciliation
└── billing-reconciliation/                 ← NEW: drift rules, expected-invoice, types

worker/jobs/zernio/                          ← every ingest path now PHI-gates before saving
public/.well-known/security.txt              ← NEW
docs/security/, docs/runbooks/, docs/finance/ ← NEW registers, rotation runbooks, pilot template
supabase/migrations/
├── 044_approval_audit_snapshot.sql          ← NEW: frozen approved-text column
└── 045_onboarding_demos_rls.sql             ← NEW: RLS on the demo table
```

### One thing to remember

The PHI filter and the approval snapshot have **no off-switch** on purpose — they're launch-risk guardrails, not optional features. And the billing watchdog only *alerts*; it never changes anyone's subscription or invoice automatically. Two integration tests (the cross-tenant leak test and the approval-snapshot immutability test) need a real database, so at the time they didn't run in our secret-free CI. That gap has since closed: CI's `test` job runs a Postgres service with `TEST_DATABASE_POOL_URL`, the suites run on every PR, and the old `docs/PENDING-db-gated-tests.md` reminder was deleted.

---

## Quick summary — what shipped 2026-05-26 (Wave 2 — Activation: don't lose a paying customer)

In simple words:

### What we changed

Wave 1 was about not sinking the boat (data, billing, legal guardrails). Wave 2 is about not losing a customer in their first days — the stretch where someone pays, then has to connect Google, get a first reply, and not get surprise-locked-out if their card fails. Five plain-English pieces:

1. **We can finally measure activation.** We now record the key steps a new customer takes — signed up, verified email, connected Google, first review came in, first AI reply drafted — and how long "paid → first draft" takes. Crucially, the browser never talks to our analytics tool directly: the app just writes these facts to our own database table, and a background worker forwards them. So if the analytics key isn't set, nothing breaks and nothing is lost — it just waits.

2. **Connecting Google is less confusing.** The connect screen now has a help link and a "if the window didn't open, click here" fallback, and we record where people drop off — measured per account, so we can see the real connect success rate.

3. **Past-due customers get a fair, clear runway instead of a silent lockout.** When a card fails, the customer sees a day-aware banner (gentle → countdown → "last day"), a reminder modal, and then — only after a 7-day grace — a read-only mode that still lets them pay, get help, and manage security. One shared piece of code decides "how many days left / are we read-only," and both the UI and the background workers obey the *same* clock. Support can grant a few extra days, and that extension actually moves the deadline for everyone (it used to silently do nothing for already-locked-out customers — fixed).

4. **Two-factor authentication (MFA).** Owners can turn on an authenticator app under Settings → Security. Sensitive admin/billing actions require it, and removing your second factor requires proving you still have it (so a stolen password alone can't strip your MFA). Every MFA action is recorded.

5. **Support tooling + safe "view-as".** Help articles, a `/help/contact` page, and support macros. Admins can *view a customer's account to diagnose problems* — but it's read-only, time-boxed to one hour, requires MFA, is fully logged, and never lets the admin take destructive actions or "become" the customer. It reads the customer's data on the server only; the browser never gets god-mode keys.

### Why it mattered

These are the things that quietly cost you paying customers: you can't tell whether onboarding works, people give up connecting Google, a failed card locks someone out with no warning, accounts get taken over, or support can't help without risky access. None of this changes the core product — it's the scaffolding that keeps a new paying customer from churning in week one.

### The new shape — what got added

```
supabase/migrations/
├── 046_analytics_events.sql        ← NEW: our own "analytics outbox" table
├── 047_backfill_past_due_at.sql    ← NEW: gives already-past-due accounts a fair grace clock
├── 048_impersonation_sessions.sql  ← NEW: audited admin "view-as" sessions (1h, one-at-a-time)
└── 049_analytics_events_rls.sql    ← NEW: locks the analytics table to server-only access

src/lib/analytics/
├── events.ts                       ← NEW: the list of event names (+ which ones the browser may send)
├── enqueue.ts                      ← NEW: writes an event row to the queue
└── posthog.ts                      ← now: isConfigured / flush helpers (no-op without a key)
src/app/api/analytics/enqueue/route.ts  ← NEW: same-origin route the browser posts intent events to
worker/background/pollers/AnalyticsDispatchPoller.ts  ← NEW: forwards queued events to PostHog
docs/analytics/events.md            ← NEW: the event taxonomy + dashboard definitions

src/lib/shared/
├── past-due-recovery.ts            ← NEW: the single "days left / read-only?" brain
├── writable-subscription.ts        ← NEW: the read-only write guard used everywhere
└── subscription-guard.ts           ← now reads the SAME clock (past_due_at, not businesses.updated_at)
src/components/dashboard/{SubscriptionStatusBanner,PastDueModal}.tsx  ← day-aware banner + modal
src/app/api/admin/billing/grant-extension/route.ts  ← NEW: support grants extra grace days (MFA-gated)

src/lib/auth/mfa.ts                 ← NEW: "is this session two-factor verified?" helpers
src/app/(authenticated)/settings/security/        ← NEW: turn on/off authenticator app
src/app/api/auth/mfa/challenge/route.ts            ← NEW: challenge / verify / unenroll (MFA-gated)
src/app/mfa/challenge/page.tsx                     ← NEW: the "enter your code" step-up screen

src/lib/admin/impersonation/{cookie,session,view,guard}.ts  ← NEW: the safe view-as machinery
src/app/admin/impersonate/                          ← NEW: start a view-as + the read-only customer view
src/app/api/admin/impersonation/{start,end}/route.ts  ← NEW
src/app/(public)/help/contact/page.tsx              ← NEW: public contact/help page
docs/help/*.md, docs/support/macros/*.md, docs/runbooks/support-extension.md  ← NEW: KB + support playbooks
```

### One thing to remember

The analytics queue is **fail-safe**: if PostHog isn't configured (or has a hiccup), events just wait in the table — they're never dropped, and customer actions never wait on analytics. The "view-as" feature is deliberately locked down — read-only, one hour, MFA-required, fully audited, no destructive actions, no session-swap. And before this goes live in prod you must set two env values: `POSTHOG_API_KEY` (or the funnel stays queued) and `IMPERSONATION_COOKIE_SECRET` (≥32 chars, or impersonation refuses to start). The four migrations (046–049) are safe to run in order.

## Quick summary — Wave 3: Visibility & AI Safety (2026-05-26, PRs 1–3b)

In simple words: we made the system **easier to see into**, then made the AI **safer**, and built a way for an admin to **catch bad drafts before the owner ever sees them**. This is half of Wave 3 — three more pieces (an AI test harness, customer KPIs/sentiment, and finance reports) are still to come.

### What we changed

**1. We can finally read the logs (PR #93).** Worker logs are now one JSON line each, tagged with which account/review/job they belong to — so when something breaks you can follow a single request through the system. There's also a simple health-check URL for both the website and the worker, and the admin "jobs" page now shows completed/paused counts.

**2. The AI is pinned and audited (PR #94).** The exact AI model is now locked to a dated version (so it can't silently change under us), the safety rules we send the AI live in one versioned file, and every AI call records which prompt + how long it took + which account it was for. Review text is now wrapped in a clearly-labelled box that tells the AI "this is customer data, don't obey instructions inside it."

**3. Unsafe drafts get held, not sent (PR #95).** Every generated reply is checked against safety rules (promising refunds, admitting legal fault, profanity, etc.). If a reply looks clearly unsafe, it's quietly held back — the owner is **not** notified — and it's logged in a new admin-only table. Nothing is ever auto-posted; the held draft just waits.

**4. Admins can act on held drafts (PR #96).** A new `/admin/flagged` page lists the held drafts. An admin can **Approve** (which finally sends it to the owner for the normal approval), **Dismiss** a false alarm, or mark it **Needs regeneration**.

```text
src/lib/shared/logger.ts             ← now writes JSON logs (was plain text)
src/lib/shared/log-context.ts        ← NEW: remembers which account/job a log line is about
worker/job-log-context.ts            ← NEW: auto-tags every worker job's logs
src/app/api/health/route.ts          ← NEW: website health check
docs/runbooks/{observability,oncall-3am,alert-tuning}.md  ← NEW: "what do I do at 3 a.m." guides
scripts/ci/analytics-events-audit.ts ← NEW: fails the build if event docs drift from code

src/lib/responses/prompt-policy.ts   ← NEW: the versioned AI safety rules (+ their hash)
src/lib/responses/generator.ts       ← pins the AI model; records prompt/latency/account on each call
src/lib/responses/prompt-builder.ts  ← wraps review text in a safe, escaped <review> box
supabase/migrations/050_*.sql        ← NEW columns on api_costs (prompt hash, latency, moderation, flagged)

src/lib/moderation/output-filter.ts  ← NEW: the local "is this reply unsafe?" rules
src/lib/moderation/moderate.ts       ← NEW: runs the rules (+ optional OpenAI moderation, off by default)
supabase/migrations/051_*.sql        ← NEW flagged_responses table (admin-only)
worker/jobs/ResponseGeneratorWorker.ts ← holds high-severity drafts; no owner email

src/app/api/admin/flagged/route.ts   ← NEW: list held drafts + approve/dismiss/regenerate
src/app/admin/flagged/page.tsx       ← NEW: the admin review screen
```

### One thing to remember

Two safety nets both **fail open**: the JSON logger never throws (a bad log argument can't crash a worker), and the moderation never throws (if the optional OpenAI check errors, it falls back to the local rules — it never "passes" something by accident). The held-draft behavior keeps the golden rule intact: **nothing posts to Google without owner approval** — flagging just removes the owner's notification until an admin says it's okay. The OpenAI moderation layer stays **off** unless you set `OPENAI_MODERATION_ENABLED=true`. Migrations 050 and 051 are additive and safe to run in order.

## Quick summary — Auto-Approval Policy (2026-06, PRs #224–#229, #241)

In simple words: we built the **opt-in "let routine good reviews answer themselves"** feature. An owner can now say *"for 5-star reviews (or 4-5, 3-5, …) post the AI's reply automatically without asking me first."* It only ever applies to **brand-new, first-time** reviews, and only after **every** existing safety check passes (moderation clean, active Google connection, active location, subscription OK, the review unchanged since we drafted it). Everything else still waits for the owner. It ships **switched off** — nothing auto-posts until an operator turns it on *and* the owner picks a policy.

### What we changed

**1. A policy you can set per account and per location.** A new settings page (`/settings/auto-approval`) lets the owner pick a star threshold for the whole account, and optionally override it per location. Making auto-approval *broader* asks for a confirmation (with a stronger warning for "All rated", since that includes 1- and 2-star reviews); making it *narrower* or turning it **off** always works instantly — even during a billing problem or an incident.

**2. The robot only acts when it's truly safe.** At the moment we save a draft, the worker re-reads the live state and only auto-approves if the star rating meets the policy **and** moderation came back clean **and** the Google connection + location are active **and** the subscription can post **and** the master switch is on. If any of those fail, it falls back to the normal "owner, please approve" flow — it never posts.

**3. A kill switch that un-does in-flight auto-approvals.** If an operator flips the master switch **off**, any reply that was auto-approved but hasn't posted yet is quietly **put back** to "waiting for owner", the owner is notified, and nothing reaches Google. Turning it off is always the safe direction.

**4. Owners and admins can see what happened.** Past Replies and the dashboard show an **"Auto-approved"** badge on replies the robot handled; an admin-only diagnostics panel shows the current policy, whether the environment is ready, and recent auto / kill-switch decisions — read-only.

```text
src/lib/auto-approval/                                      ← NEW: the whole policy "brain" (thresholds, gates, flags, readiness, types)
src/app/api/settings/auto-approval/route.ts                ← NEW: owner GET/PATCH settings API (server-owned, session-scoped, same-origin)
src/app/(authenticated)/settings/auto-approval/            ← NEW: the owner settings page + UI
src/app/admin/businesses/[id]/_components/AutoApprovalDiagnosticsPanel.tsx  ← NEW: admin read-only diagnostics
src/components/dashboard/reviews/AutoApprovedBadge.tsx      ← NEW: the shared "Auto"/"Auto-approved" badge
src/components/dashboard/reviews/ReviewFeedCard.tsx         ← NEW: one review-feed card (replaced the duplicated ReviewsCard/AggregateReviewsCard bodies)
worker/jobs/response-generation/                           ← the persist-time auto decision (origin lane + final predicate) lives here
worker/jobs/publisher/                                     ← the kill-switch downgrade lives here
supabase/migrations/055_*.sql                              ← NEW auto_approval_policies table + responses.approval_method
docs/runbooks/completed_runbooks/auto-approval-staging-test.md  ← the staging test runbook (now done + archived)
```

### One thing to remember

Auto-approval **skips only the owner's click** — it never skips a safety check. Moderation stays an absolute veto (high-severity drafts are held and never auto-post), and the master switch (`AUTO_APPROVAL_ENABLED`) is read fresh at worker boot, so turning it **off** stops new auto-approvals *and* un-does any that haven't posted yet. It ships **off** in production; staging was fully exercised end-to-end on 2026-06-06.

## Quick summary — Owner Offboarding v1 (2026-06, PRs #244, #245)

In simple words: we built a **safe "I want to leave" button** for account owners. Until now there was no clean, self-serve way to stop using RepWorth — owners had to cancel through Stripe, which left the rest of the system half-connected. Now an owner gets two clear choices, and RepWorth tears everything down (or keeps it) in the right order, on its own. It ships **switched off** in production — nothing changes for customers until an operator turns it on (and the legal terms are in place).

### The two choices

1. **"Cancel my service, keep my data."** We schedule the cancellation for the end of the paid period (through RepWorth, not Stripe's portal). The owner keeps using everything until that date, can **change their mind and reactivate** on the same subscription, and only then do we archive their locations and disconnect Google.

2. **"Close my account and delete my data."** We stop everything immediately, cancel billing, disconnect Google, archive locations, then **delete or anonymize** the data after a **30-day grace window**. During that window the owner can click **"keep my data"** to cancel the deletion (but billing/Google stay torn down). We never promise "absolute deletion" — some billing/compliance records are kept, stripped of personal content.

### How it stays safe

- **One state machine, one source of truth.** A new `account_offboardings` row tracks the whole lifecycle (`pending → scheduled → tearing_down → purge_scheduled → purged`, plus `churned` / `reactivated` / `failed`). Background pollers move it forward on a clock that lives in the database, not in fragile delayed jobs.
- **Deleting really deletes.** A code-owned "table-disposition inventory" lists every table that holds account data and how to clean it; the purge won't mark itself done until every one is empty, scrubbed, or explicitly retained — and a test fails if any table is left unclassified.
- **Destructive actions need proof.** "Delete my data" requires a fresh password re-entry (and MFA if enrolled) and typing "DELETE DATA"; the keep-my-data email link is a single-use token (its own table, never reused approval links).
- **It can't run twice or fight the old cancellation path.** One active offboarding per account, and the old `CancellationGracePoller` skips any account that already has one.

### What we changed (new directories/files)

```text
src/lib/account-offboarding/              ← NEW: the offboarding "brain" — guard gate, confirm logic, table-disposition inventory, flags, purge verification
src/app/api/account/offboarding/          ← NEW: owner routes — confirm, reactivate, keep-my-data, fresh-auth, status
src/app/(authenticated)/account/offboarding/status/  ← NEW: the owner-facing offboarding status page
src/components/dashboard/settings/        ← NEW: AccountOffboardingPanel + DeleteDataOffboardingModal (the settings UI)
worker/jobs/account-offboarding/          ← NEW: the workers — billing-schedule, teardown, purge (+ purge-stages / purge-verification), reactivation, lifecycle email
worker/background/pollers/AccountOffboarding*Poller.ts  ← NEW: the 5 recovery pollers (access-end, purge, purge-reminder, reactivation-reset, teardown-retry)
src/app/admin/offboardings/               ← NEW: minimal admin visibility + provider-disposition override
supabase/migrations/056..060_*.sql        ← NEW: the offboarding tables + analytics allowlist + purge-reminder + reactivation-claim columns
docs/runbooks/owner-offboarding-staging-dry-run.md  ← the staging dry-run + live-E2E evidence record
```

### One thing to remember

This was **specced, built across 7 PRs, dry-run-tested on staging, and fixed before merge.** The staging dry-run caught three real bugs that unit tests had hidden — cancel-only never scheduling, the keep-my-data link 401'ing logged-out owners, and the delete purge failing on phantom columns — all fixed (PR #245) and then **re-run live on staging end-to-end** (2026-06-09) before merging to `main`. The whole feature stays **off in production** behind `ACCOUNT_OFFBOARDING_ENABLED` until the legal terms (a non-refundable mid-cycle clause) are in place. One ops note: deploy the worker from a **clean checkout**, not `railway up` from a worktree — that ships stale code.

## Quick summary — Billing Compliance Hardening (2026-06, branch `billing/compliance-hardening`)

In simple words: we **tidied up and legally tightened the money side** of RepWorth — before the first real customer is ever charged. Nothing here changes how the product works, and nothing is switched on yet: it all sits behind off-by-default settings so it's safe to ship now and turn on later once the Stripe account and the lawyer's sign-off are ready. Think of it as putting the plumbing and the warning labels in place before opening the tap.

### What we changed (plain English)

1. **One place that talks to Stripe.** Before, eight different files each created their own connection to Stripe, with slightly different settings (some had no timeout at all). Now there's a single shared "Stripe connection" file, with one pinned version and sensible timeouts/retries — so the rules live in exactly one spot and can't drift apart.

2. **We can collect sales tax (when we choose to).** Checkout can now add automatic sales tax, ask for a billing address, and collect a business tax ID — but only when a switch (`STRIPE_TAX_ENABLED`) is flipped on. It's **off** today, because turning it on before Stripe is configured would break checkout. Prices stay as the listed number **plus tax on top**.

3. **Honest auto-renewal wording, in two places.** The pricing page and the in-app "change my plan" box now clearly say the subscription **auto-renews every month, plus applicable taxes, until you cancel**, and link to the Terms. The "cancel anytime" wording now points to where you actually cancel (your account), not a screen that doesn't have that button.

4. **A safety net so future price changes can't go wrong.** Existing customers are **grandfathered** — if we change a tier's price later, people who already signed up keep the price they signed up at; only new customers pay the new price. (That was already how it worked; we added a test that locks it in.) We also added a one-command check (`pnpm verify:stripe-prices`) that catches the classic mistake of the displayed price and the actually-charged price drifting apart, plus a written step-by-step for how to change a price safely.

5. **A guard so turning on tax can't cause false billing alarms.** A background job double-checks each customer's expected bill against Stripe. We added a test proving it always compares the **pre-tax** amount, so switching tax on later won't make it cry wolf.

### The new shape — what got added

```text
src/lib/payments/stripe-client.ts          ← NEW: the ONE shared Stripe connection (pinned version + timeouts). Every other file now imports from here; nothing else creates a Stripe client.
scripts/verify-stripe-price-parity.ts      ← NEW: `pnpm verify:stripe-prices` — checks the listed prices match what Stripe will actually charge (run before charging anyone / after any price change).

# Disclosures (no new files — copy added in place):
src/app/onboarding/pay/PlanPickerClient.tsx        ← auto-renewal + tax wording on the pricing page
src/components/dashboard/settings/AccountPanel.tsx ← same wording on the in-app "change plan" box

# Reversible switch (server-only, default OFF):
STRIPE_TAX_ENABLED  ← in .env.example + env-vars.md; validated at worker startup
```

### One thing to remember

This was **planned, grilled, and stress-tested by a second AI model (Codex) across 3 review rounds before any code**, then reviewed again after implementation — full test suite green (5881 tests). **It is all dark by default.** The real-world steps that actually start collecting tax and charging customers — configuring Stripe Tax, recreating Prices with a tax behavior, setting the webhook version, the lawyer's sign-off on auto-renewal terms — are a separate **Launch-Gate Checklist** in the plan, deliberately kept out of the code. Two billing things were intentionally left for later (handling card disputes and reusing a returning customer's Stripe record); they're listed as Fast-Follow.
