# Auto-Approval Policy — Design Spec

- **Date:** 2026-05-31
- **Status:** Draft — design decisions approved **and refined via a grilling session (2026-05-31, cross-referenced against the codebase); NOT implemented**. CLAUDE.md invariants #3/#4/#11 remain authoritative until the implementation PR lands.
- **Owner:** Norbert Esekiel
- **Origin:** Potential-client survey — clients want to choose which reviews get fully automated (drafting → posting) vs. which require manual owner approval.

> **Grilling-session amendments (2026-05-31).** Several originally-drafted decisions were corrected after reading the actual code. The material changes: auto-approval **reuses the `approved` status** with an `approval_method` discriminator instead of a new `auto_approved` status (§7); it **never applies to the first-connect backfill** (§5); the subscription gate uses **publisher** semantics, not generator (§9); auto requires the **provider moderation layer on + a per-draft clean verdict + zero flags** (§4); and v1 ships **no per-review FYI notification** (§8). The body below reflects the refined decisions; `docs/superpowers/specs/CONTEXT.md` holds the glossary.

> **Code-audit amendments (2026-05-31, second pass).** Every load-bearing code claim in this spec was verified against the live source. The audit changed four things, all reflected below: **(1, blocker)** `approval_audit_log.auth_method` has a migration-014 `CHECK (auth_method IN ('token','owner_session'))` — writing `'auto_policy'` throws and rolls back the whole persist transaction, so **migration 055 must amend that constraint** (§6c, §12). **(2)** `suppressNotification` is **not** backfill's sole producer (the live edit-replies *regenerate* path also sets it), so the backfill exclusion is re-based onto an explicit **`origin_lane`** signal rather than overloading the notification flag (§3.5, §4, §5). **(3)** `publisherSubscriptionOK` is a **second** `checkSubscription` call — the generator gate in `load-context.ts` stays for its own purpose (§7, §9). **(4)** added an explicit **no-retroactive-re-evaluation** non-goal and a **canonical-publish-enqueue-reuse** note (§2, §7, §10). The `categories.openai_moderation` field was confirmed to be a tri-state marker (clean/error/absent), correct only in conjunction with `!flagged` (§4).

> **Owner-review amendments (2026-05-31, third pass).** A subsequent review found five more issues, all verified against code and reflected below. **(P1) `origin_lane` was under-specified and defaulted unsafely.** Four *more* lanes enqueue `generate_response` besides the past-replies route — the token/session/callback approval supersede-regenerate paths (`token-mode.ts:153`, `session-mode.ts:174`, `callback-mode.ts:99`) and the admin flagged re-draft (`admin/flagged/route.ts:254`). The signal is now **required and fail-closed**: anything other than an explicit `'live_ingest'` (including missing/unknown) is non-auto, and *every* regenerate producer must set `'regenerate'` (§3.5, §4, §5). **(P1) The new tenant table needs explicit RLS/inventory work** — enable RLS, mirror the `channel_enrollments` posture, add to `TENANT_TABLES` + `rls-inventory.md`, add migration tests (§6a). **(P2) The "canonical publish enqueue" helper does not exist yet** — the approval modes inline `INSERT … 'publish_response'` *without* `ON CONFLICT`; the spec now requires *extracting* a shared `enqueuePublishResponse(...)` and migrating the existing paths + auto to it (§7, §10). **(P2) A NULL per-location override means "manual override," not inherit** — explicit resolution note + test (§5, §11). **(P2) A new tokenless auto-policy audit helper is required** — existing helpers are token/owner_session-shaped and cannot write `auth_method='auto_policy'` (§8).

---

## 1. Problem

Today every generated response requires an explicit human approval before it posts to Google (CLAUDE.md invariant #3, "No auto-posting"). The survey says some clients want hands-off automation for routine reviews while keeping a human in the loop for sensitive ones — typically by star rating (e.g. auto-respond to 3–5★, manually handle 1–2★).

We need an **owner-configurable auto-approval policy** that lets a client pick, in advance, which reviews skip the owner-approval step — **without** removing the safety guarantees the approval architecture exists to enforce.

## 2. Goals / Non-goals (v1)

**Goals**
- Per-client policy: "all auto", "all manual" (today's behavior), or "auto if star ≥ N".
- Account-level default with optional per-location override (multi-location clients).
- Auto-approval **never** weakens moderation, token security, subscription gating, or auditability.
- Safe, opt-in default: no policy configured ⇒ everything stays manual (current behavior).

**Non-goals (v1)**
- Signals other than **star rating** (sentiment, keyword match, length, language) — clean future extension, explicitly out of scope.
- Per-reviewer or per-campaign rules.
- Auto-*editing* of drafts — auto-approval posts the generated draft as-is or holds it; it never silently rewrites.
- Auto-approving anything but the **live-ingest lane** — the first-connect backfill and the edit-replies regenerate lane stay manual (§5).
- A per-review "we auto-responded" notification — deferred to a future batched digest (§8, §13).
- **Retroactive re-evaluation.** Policy is resolved once, at generation time (the `already_exists` dedup short-circuits in `load-context.ts` *before* persist). Enabling or changing a policy does **not** flip already-generated `pending_approval` rows to auto — it applies only to reviews generated afterward. (A backfill-and-auto-approve-existing sweep is explicitly out of scope; see §14.)

## 3. Locked decisions

1. **Moderation is an absolute veto** (approved in design dialogue). A draft flagged high-severity unsafe (invariant #4) is held for manual/admin review and **never** auto-posts, regardless of policy. Auto-approval skips the *owner* step, never the *safety* step. **Refined (§4):** auto further requires the provider moderation layer enabled, a per-draft clean provider verdict, and *zero* flags (medium/low flags also fall to manual).
2. **Scope = account default + per-location override** (approved). Mirrors owner channel-enrollment (account-scoped default keyed by `location_id IS NULL`, per-location override row) and the multi-location settings pattern. Respects invariant #9 (`accounts` = billing parent, `businesses` = location).
3. **Dimension = star rating only, threshold model** (locked). A single `auto_approve_min_star` expresses every survey case (see §5). Richer signals are a future generalization.
4. **Reuse the `approved` status; record the auto-ness in `approval_method`** (locked — *reverses the original §7*). Auto-approval sets `responses.status = 'approved'` and `responses.approval_method = 'auto_policy'`; it does **not** introduce a separate `auto_approved` status. Distinguishability lives in a dedicated column on the same row, not in the status value — which keeps the ~20 inline publisher status lists, the KPI status groups, the non-terminal partial unique index, the dashboard, and edit-replies all working byte-for-byte unchanged. See §7.
5. **Only the live-ingest lane is auto-eligible — required and fail-closed** (locked; refined by the 2026-05-31 code audit + owner review). Auto-approval is gated on an explicit `origin_lane` signal in the `generate_response` payload; **only the exact value `'live_ingest'` is auto-eligible**, and *anything else — `'backfill'`, `'regenerate'`, an unknown value, or a missing field — is non-auto* (fail-closed, never defaulted to live). Eligibility is **decoupled from `suppressNotification`** (which has more than one producer). There are **five** regenerate producers that must each set `'regenerate'` (§5). See §5.

## 4. Safety model (the core)

Auto-approval is **subordinate** to every existing guarantee. A draft posts automatically **only if all** of the following hold (evaluated as one predicate; the final branch runs inside the response-persistence transaction where the moderation hold result is known):

```
auto =  policyEligible            // resolved min_star ≠ NULL AND star_rating ≥ min_star  (NULL star ⇒ false)
     && isLiveIngestLane          // origin_lane === 'live_ingest' EXACTLY; missing/unknown/backfill/regenerate ⇒ non-auto (§5)
     && publisherSubscriptionOK   // SECOND checkSubscription call, workerType:'publisher' — NOT the generator gate (§9)
     && providerModerationClean   // tri-state marker: categories.openai_moderation === 'clean' (else 'error'|absent) (§4 below)
     && !moderation.flagged       // zero flags; high-severity still HOLDS, medium/low ⇒ manual
     && !held                     // recordModerationAndHold returned false (known only inside persist tx)
```

If any condition fails, the response falls back to the **manual** path (`pending_approval`, owner notification as today). Auto-approval can only ever **remove the owner step** — it can never bypass moderation, billing, or audit.

**Moderation prerequisite (refined).** The human approval step is today's real safety backstop, and `OPENAI_MODERATION_ENABLED` is **off in prod** (local regex only). Auto-approval removes the human, so it must not run on regex-only vetting:
- **Environment prerequisite:** auto-approval requires `OPENAI_MODERATION_ENABLED=true`. If it is off, no draft carries the `'clean'` provider marker, so `providerModerationClean` is false and **everything stays manual** — the feature fails safe to today's behavior. The provider layer (already a launch-checklist item) is a hard dependency; enable + threshold-tune it first.
- **Per-draft verification:** `providerModerationClean` is true only when the provider actually ran and passed for *that* draft (`categories.openai_moderation === 'clean'`). **Verified against the code:** this field is a *tri-state marker*, not a verdict enum — it is `'clean'` (passed), `'error'` (provider threw, fail-open to local rules), or **absent** (provider disabled, *or the provider flagged* — a provider flag never sets the field to `'flagged'`, it sets `flagged: true`). The `=== 'clean'` test is therefore correct **only in conjunction with** `!moderation.flagged`; both conjuncts are required (a provider-flagged draft has the marker absent *and* `flagged: true`). A fail-open or disabled result ⇒ not auto-eligible ⇒ manual.
- **Zero-flag strictness:** auto requires `!moderation.flagged`, not merely `!held`. High-severity still holds; **medium/low flags fall to manual** so a human at least reads flagged text before it posts.

**Fail-closed:** any error resolving the policy (missing row, malformed value, DB error) ⇒ treat as **manual**. We never auto-post on uncertainty.

**Opt-in default:** absence of any policy row ⇒ manual. New accounts and newly-added locations are manual until the owner explicitly enables auto-approval (§13.3).

## 5. Policy model & resolution

**Threshold model.** One nullable field, `auto_approve_min_star ∈ {NULL, 1..5}`:

| Client intent | `auto_approve_min_star` | Effect |
|---|---|---|
| All manual (today) | `NULL` | nothing auto-approves |
| Auto 3–5★, manual 1–2★ | `3` | auto if `star_rating ≥ 3` |
| All automated | `1` | auto for every (rated) review |

**Resolution order** for a review at location `L` (account `A`, star `S`):
1. Per-location override row (`account_id = A, location_id = L`). If present, use it.
2. Else account default row (`account_id = A, location_id IS NULL`).
3. Else **manual** (no row = opt-out).
4. `policyEligible = (min_star IS NOT NULL) AND (S IS NOT NULL) AND (S >= min_star)`.

This is the same override→default→fallback resolution used by owner channel enrollment.

**NULL star rating (refined).** `reviews.star_rating` is nullable in the schema (the `CHECK` passes on NULL; Zernio normalization enforces 1..5 but other write paths may not). The resolver guards this explicitly: a NULL star is **not** auto-eligible (do not rely on SQL `NULL >= n` semantics leaking through) ⇒ manual.

**Origin-lane exclusion (refined — locked; corrected by the 2026-05-31 code audit).** Auto-approval must apply **only** to live, post-connect reviews. The first-connect backfill ingests up to 75 historical reviews via `ZernioBackfillWorker` (`worker/jobs/zernio/ZernioBackfillWorker.ts:248`); auto-approving those would blast dozens of replies onto years-old Google reviews the moment an owner connects.

The original draft proposed keying `isBackfill` off `suppressNotification === true`. **The code audit disproved the premise that backfill is `suppressNotification`'s sole producer:** the live edit-replies *regenerate* path (`src/app/api/dashboard/past-replies/draft/route.ts:223`, gated by `EDIT_REPLIES_ENABLED`) **also** sets `suppress_notification: true` and flows through the same `persist.ts`. Overloading a *notification-suppression* flag to carry *approval-eligibility* semantics violates orthogonality (one fact, one owner) and would silently mis-handle any future suppressing producer.

**Decision: carry an explicit positive origin-lane signal**, not a side-effect flag, and make it **required + fail-closed**. The `generate_response` payload gains `origin_lane: 'live_ingest' | 'backfill' | 'regenerate'`. **Auto-eligibility requires `origin_lane === 'live_ingest'` *exactly*; the resolver treats any other value — `'backfill'`, `'regenerate'`, an unrecognized string, *or a missing field* — as non-auto** (`isLiveIngestLane` in §4). There is **no default-to-live**: a producer that forgets to set the field fails *safe* (manual), never *open*.

**Every `generate_response` producer must set its lane explicitly** (verified against code — there are more than the two the prior pass named):

| Lane | Producer(s) | `origin_lane` |
|---|---|---|
| Live ingest | `ZernioReviewIngestWorker` / `ZernioRecentReviewPoller` → `process-review.ts` (never suppresses) | `'live_ingest'` — **the only auto-eligible value** |
| Backfill | `ZernioBackfillWorker` → `process-review.ts` (`suppressNotification: true`) | `'backfill'` |
| Regenerate | `past-replies/draft/route.ts:228`; approval supersede-regenerate in `token-mode.ts:153`, `session-mode.ts:174`, `callback-mode.ts:99`; admin held-draft re-generate in `admin/flagged/route.ts:254` | `'regenerate'` |

The regenerate lane is the dangerous one to get wrong: e.g. an admin re-drafting a **high-severity-held** 5★ response (`admin/flagged/route.ts`) expects to review the new draft — under a default-to-live rule with an all-auto policy it could silently post. Fail-closed + an explicit `'regenerate'` on all five producers prevents that. Because `process-review.ts` is shared by the live and backfill lanes, it threads `origin_lane` from its callers rather than hard-coding one value.

This also decouples auto-approval from `suppressNotification` — the notification flag keeps its single meaning, and a new ingestion lane becomes an explicit, greppable enum value plus a fail-closed default, instead of an implicit coupling.

**Per-location NULL override = "manual override," not "inherit" (P2b).** Resolution step 1 uses the per-location row **if it exists**, including when its `auto_approve_min_star IS NULL` — that is a deliberate "this location is manual" override that does **not** fall through to the account default. Only the *absence* of a per-location row inherits the account default (step 2). A settings UI must therefore **write a NULL-threshold override row** to make one location manual under an all-auto account default — not delete the row (which would re-inherit auto). Covered by an explicit test (§11).

## 6. Data model

**Migration 055** (head is **054**; confirm `migrations-log.md` at implementation time) carries three changes:

**(a) New table `auto_approval_policies`:**

```
id                    uuid  PK  (uuidv7)
account_id            uuid  NOT NULL  FK accounts(id)
location_id           uuid  NULL      FK businesses(id)   -- NULL = account default
auto_approve_min_star smallint NULL   -- NULL = disabled; 1..5 threshold
created_at            timestamptz NOT NULL default now()
updated_at            timestamptz NOT NULL default now()
```

- Partial unique indexes mirroring channel enrollment: one default per account (`UNIQUE (account_id) WHERE location_id IS NULL`) and one override per (account, location) (`UNIQUE (account_id, location_id) WHERE location_id IS NOT NULL`).
- `CHECK (auto_approve_min_star BETWEEN 1 AND 5)` when not null.
- Settings-UI writes upsert via `ON CONFLICT`; **the conflict target's predicate must match the partial-index predicate BYTE-FOR-BYTE** (documented gotcha) — two distinct upsert paths, one per index.
- All reads scoped by `account_id` (and `location_id`) per invariant #8. No cross-account read is required, so **no** tenant-scope allowlist entry is added.
- **Tenant-isolation work is explicit, not "audits stay green" (P1b).** `auto_approval_policies` is a per-account tenant table and must be wired into the isolation inventory in the **same migration/PR**, mirroring the `channel_enrollments` sibling (account-scoped; direct owner writes revoked; all access via service-role with app-enforced scoping):
  - **Enable RLS** on the table. Posture: **deny-all to the anon/auth roles** (no client policy) — every read/write is server-side via the service key (worker resolver + the settings route), exactly like `channel_enrollments`. Confirm that sibling's exact `GRANT`/policy shape at implementation and match it.
  - **Add `'auto_approval_policies'` to `TENANT_TABLES`** in `scripts/ci/tenant-tables.ts`.
  - **Add a row to `docs/security/rls-inventory.md`** describing the scope key (`account_id`, `location_id`) and the deny-direct-write posture.
  - **Migration tests** asserting RLS is enabled and the deny-all posture holds; `ci:tenant-scope` + `ci:rls-audit` then pass *because* the table is inventoried, not by omission.

**(b) New column on `responses`:**

```
approval_method  text NOT NULL DEFAULT 'owner'   -- 'owner' | 'auto_policy'
```

Records *how* a response was approved without overloading `status` (locked decision #4). Existing rows default to `'owner'`; the manual approval paths keep that default; the auto branch sets `'auto_policy'`. The dashboard badges auto-responded reviews from this column.

**(c) Amend the `approval_audit_log.auth_method` CHECK constraint (BLOCKER — found by the 2026-05-31 code audit):**

```
-- migration 014 set: CHECK (auth_method IN ('token','owner_session'))
ALTER TABLE approval_audit_log DROP CONSTRAINT <existing_auth_method_check_name>;
ALTER TABLE approval_audit_log
  ADD CONSTRAINT approval_audit_log_auth_method_check
  CHECK (auth_method IN ('token', 'owner_session', 'auto_policy'));
```

The §8 audit row writes `auth_method = 'auto_policy'` **inside the response-persistence transaction** (§7). Migration 014 constrains `auth_method` to `('token','owner_session')`, so without this amendment that INSERT throws a CHECK violation, the whole transaction rolls back, and **auto-approval fails 100% of the time — taking response persistence down with it** (the response row never lands). The `action` column has **no** CHECK constraint, so the new value `'auto_approved_by_policy'` there needs no migration. Confirm the existing constraint's exact name against the live schema at implementation time (Postgres auto-named it from migration 014).

**Policy-change auditing.** Editing a policy is a security-relevant config change. Each create/update writes an audit row capturing owner, account/location scope, and old→new threshold (mechanism: same `account_audit_log` path used for other account-config changes, in the write transaction).

## 7. Decision flow & state machine

**Single chokepoint.** The auto/manual decision is resolved **once**, in the response-persistence step (`worker/jobs/response-generation/persist.ts`), immediately after moderation — the same transaction that persists the response. This is the chokepoint precisely because the moderation-hold result (`held`) is only known *inside* that transaction, where it meets the policy/subscription eligibility resolved earlier in `load-context.ts`.

```
generate → moderate
  ├─ high-severity flag → flagged_responses + HOLD (invariant #4)              [unchanged; overrides all]
  └─ resolve §4 predicate (policy ∧ liveIngestLane ∧ publisherSub ∧ providerClean ∧ !flagged ∧ !held)
       ├─ AUTO  → status = 'approved', approval_method = 'auto_policy',
       │          approved_text = response_text, approved_at = NOW()
       │          → write approval_audit_log row (action 'auto_approved_by_policy', token_hash NULL)
       │          → enqueue publish_response via job_outbox     (NO send_notification; NO FYI — §8)
       └─ MANUAL→ status = 'pending_approval', approval_method = 'owner'
                  → enqueue send_notification (unless suppressed)              [today's behavior]
```

- **No new status.** Auto-approval reuses `approved` (locked decision #4). Because the status value is unchanged, the publisher's `ZERNIO_PUBLISHABLE_STATES`, the ~20 inline `status IN ('approved','edited','awaiting_owner_connect')` clauses across the publisher subsystem, the `response-status.ts` groups (`NON_TERMINAL`, `HANDLED`, `AWAITING_PUBLISH`, `RECENT_REVIEW_DISPLAY`, …), the non-terminal partial unique index, and edit-replies are **untouched** — no status migration, no risk of a missed inline list silently black-holing a post.
- **Placement.** `load-context.ts` (which already loads `star_rating` and the subscription inputs) also resolves the policy row (override→default→null). A **pure resolver** computes `policyEligible` + `publisherSubscriptionOK` from already-loaded data. **Note (audit):** `load-context.ts` already calls `checkSubscription` with `workerType:'generator'` for the existing generation gate; `publisherSubscriptionOK` is a **separate, second** call with `workerType:'publisher'` over the same already-loaded inputs — do **not** reuse the generator result (it diverges on `pending_payment`; see §9). `checkSubscription` is pure, so the second call is free. `persist.ts` receives a single `autoApproveEligible` boolean (plus audit inputs) and evaluates the final branch against its in-transaction `held` result.
- **`approved_text` population.** The publisher reads `responses.approved_text` (`ResponsePublisherWorker.ts:97`), never `response_text`. The manual flow sets it at approval time; the auto branch sets `approved_text = response_text` at persist so the existing publisher read works unchanged.
- **Extract a shared `enqueuePublishResponse(...)` helper — it does not exist yet (P2a).** *Corrected by owner review:* the approval modes (`token-mode.ts`, `session-mode.ts`, `callback-mode.ts`) each **inline** `INSERT INTO job_outbox … 'publish_response' …` **without** `ON CONFLICT`; the only correct, index-aligned enqueue is in `DrainOwnerConnectWorker.ts:72` (`ON CONFLICT (topic, aggregate_id) WHERE topic = 'publish_response'`, matching `idx_jo_publish_response_inflight` from migration 026). So there is **no canonical path to reuse** — the plan must *create* one: extract `enqueuePublishResponse(tx, { responseId, businessId })` (payload `{ response_id, business_id }`, carrying the `ON CONFLICT` guard) into a shared module, **migrate the three approval modes onto it**, and have the auto branch call the same helper. One owner for "how a publish job is enqueued"; the `ON CONFLICT` predicate then lives in exactly one place and cannot drift per call site.
- All enqueues use the transactional outbox (invariant #2); no Postgres-write-then-enqueue.
- The publisher path is otherwise unchanged — it already gates on publishable status + (publisher) subscription, so an auto-`approved` row flows through the same posting + idempotency machinery, including supersede/edit (DELETE-before-POST) for a later review version.

## 8. Notification & audit

- **No per-review FYI notification in v1 (refined).** A client who sets `min_star = 1` ("all auto") did so to *stop* being pinged per review; a per-review "we auto-responded" notice re-introduces the interruption they opted out of. The existing `send_notification` path also mints an **approval link/token** (invariant #5), which an already-posted reply must not have. Transparency in v1 is served entirely by (a) the **dashboard**, which lists responded reviews and badges `approval_method = 'auto_policy'`, and (b) the **audit row** (below). A **batched digest** ("we auto-responded to N reviews this week") is the documented fast-follow — emitted by a time-cadence scheduler reading `approval_method`, never wired into the hot publish path. See §13.
- **Audit (required, single owner).** Every auto-approval decision writes one row to **`approval_audit_log`** (the response-scoped approval audit; `token_hash` is nullable since migration 014, so a tokenless row is valid), action `auto_approved_by_policy`, `auth_method = 'auto_policy'`, `actor_user_id` NULL, `token_hash` NULL, and `response_text_at_approval = response_text` (the immutable snapshot the manual paths also capture), with the resolved threshold + star + location in metadata — in the same transaction as persistence. **`auth_method = 'auto_policy'` requires the migration-055 CHECK amendment (§6c)** — without it this very INSERT throws and rolls back the persist transaction. This is the *one* owner of "why did this post automatically?" `api_costs` continues to own the separate *moderation* fact only; the original "audit/log.ts **and/or** api_costs" wording is resolved to `approval_audit_log` alone.
- **A new tokenless auto-policy audit helper is required (P2c).** The existing helpers in `src/lib/approval/audit.ts` cannot be reused: `insertAuditLog` is token-shaped (expects token/device context) and `insertAuditLogSession` hardcodes `auth_method = 'owner_session'`. Add a sibling — e.g. `insertAuditLogAutoPolicy(tx, { responseId, businessId, metadata, snapshot })` — that writes `token_hash = NULL`, `actor_user_id = NULL`, `auth_method = 'auto_policy'`, and `response_text_at_approval`. It lives beside the other two so all three audit shapes share one owner.

## 9. Subscription & billing gating

Auto-post is a publisher action and inherits invariant #11 — but the **decision-time check must use publisher semantics, not the generator's**, because the two gates diverge on exactly one status:

- `checkSubscription` allows `pending_payment` for `workerType: 'generator'` (admin demo drafts) but **denies** it for `workerType: 'publisher'`.
- A naive auto decision using the generator gate would set `approved` + enqueue `publish_response` for a `pending_payment` account; the publisher then skips it, leaving the row stuck in `approved` forever with no re-drive and (per §8) no notification — a silent black hole.

Therefore the §4 predicate uses a **second** `checkSubscription({ …business, workerType: 'publisher' })` call — *in addition to*, not instead of, the existing `workerType:'generator'` gate `load-context.ts` already runs to decide whether to generate at all:
- `cancelled` ⇒ not auto (and not manual-postable).
- `pending_payment` ⇒ **not auto** ⇒ degrades to `pending_approval`, exactly like a manual review for a `pending_payment` account (notification itself is skipped, but the row is dashboard-visible and the owner acts after paying).
- `past_due` within 7-day grace ⇒ auto allowed; after grace (`past_due_expired`) ⇒ not auto ⇒ manual.

A subscription-blocked auto-decision **degrades to `pending_approval`** (owner-actionable) rather than dropping or stranding the response.

**Residual race (accepted, pre-existing).** Subscription `active` at persist → flips to denied before the `publish_response` job runs → publisher skips → row stranded in `approved`. This window is seconds and already affects *manually*-approved rows today; it is not auto-specific. Documented and **out of v1 scope** (no sweeper built now).

## 10. Error handling

- Policy resolution error ⇒ **manual** (fail-closed).
- Provider moderation degraded — fail-open (`'error'`) or disabled (marker absent) ⇒ `providerModerationClean` false ⇒ **manual** (§4). A high-severity *local-rule* flag still holds, unaffected.
- Auto-publish enqueue is idempotent via the outbox key (invariant #2; BullMQ `_` separator), the generator's `already_exists` idempotency check (re-run ⇒ no re-persist / re-enqueue — this is also why policy is resolved once and never retroactively, see §2), and the `idx_jo_publish_response_inflight` partial unique index. **The enqueue goes through the newly-extracted `enqueuePublishResponse(...)` helper (§7), so the `ON CONFLICT` predicate is owned in one place and stays aligned with that index.** Correlation chained `ingest → generate → publish_response` (notification skipped).
- The auto branch performs no best-effort work after the primary side effect in v1 (no FYI), so the worker fail-open gotcha does not apply; if a digest is added later, its enqueue is best-effort and must not flip a completed post to failed.

## 11. Testing

- Policy resolution: override beats default; default applies; **no row ⇒ manual**; **NULL star ⇒ manual**.
- **NULL per-location override is a manual override, not inheritance (P2b)** — account default `min_star = 1` (all-auto) + a per-location row with `auto_approve_min_star = NULL` ⇒ that location resolves **manual** (does not inherit the all-auto default); removing the row re-inherits auto. Guards the UI from "delete row to go manual."
- Threshold boundaries: `min_star = 3` ⇒ 2★ manual, 3★ auto; `min_star = 1` ⇒ all (rated) auto; `NULL` ⇒ all manual.
- **Only live-ingest lane auto, fail-closed** — `origin_lane = 'live_ingest'` ⇒ auto-eligible; `'backfill'`, `'regenerate'`, **an unknown value, and a *missing* field** ⇒ manual even with `min_star = 1`. Plus a guard asserting auto-eligibility does **not** read `suppressNotification`.
- **All five regenerate producers stay manual** — one case per producer (`past-replies/draft`, `token-mode`, `session-mode`, `callback-mode`, `admin/flagged`) asserting each enqueues `origin_lane = 'regenerate'` and the result is never auto, even at `min_star = 1`. The admin-flagged held-draft re-generate is the priority regression (a re-drafted high-severity-held reply must not auto-post).
- **Moderation veto overrides auto** — high-severity draft is held even with `min_star = 1`.
- **Provider-degraded ⇒ manual** — `openai_moderation` `'error'` or absent ⇒ not auto; **medium/low flag ⇒ manual** (only `!flagged` is auto).
- **Subscription (publisher gate)** — `pending_payment`/`cancelled`/`past_due_expired` ⇒ degrades to `pending_approval`, no post, no strand.
- **Fail-closed** — resolution throws ⇒ manual, never auto.
- Auto path sets `status='approved'`, `approval_method='auto_policy'`, `approved_text=response_text`; flows through publisher idempotency unchanged.
- `approval_audit_log` row written for every auto decision (tokenless, `auth_method='auto_policy'`); tenant-scope + RLS audits pass.
- **CHECK-constraint migration (blocker regression)** — after migration 055, an `INSERT … auth_method='auto_policy'` into `approval_audit_log` **succeeds**; a guard/migration test proves the constraint was amended (a row written with the old constraint would throw and roll back the whole persist tx).
- **No retroactive re-evaluation** — a review generated as `pending_approval` is **not** flipped to auto when a policy is later enabled/raised; re-running generation hits `already_exists` and does not re-persist.
- **Shared `enqueuePublishResponse` helper (P2a)** — a unit test on the extracted helper (correct topic/payload + `ON CONFLICT` matching `idx_jo_publish_response_inflight`), plus assertions that the migrated approval modes and the auto branch all route through it (no remaining inline `'publish_response'` INSERTs in those paths).
- **Tenant-isolation migration (P1b)** — migration test asserts RLS is enabled on `auto_approval_policies` with the deny-direct-write posture; `ci:tenant-scope` + `ci:rls-audit` pass with the table present in `TENANT_TABLES` and `rls-inventory.md`.
- Outbox idempotency for the auto-publish enqueue (`idx_jo_publish_response_inflight`).

## 12. CLAUDE.md change-map (applied WITH the implementation PR, not before)

| Location | Change |
|---|---|
| **What this project is** (pipeline) | `Never auto-posts.` → posts via owner approval **or** owner-configured auto-approval policy; moderation can always veto |
| **Invariant #3** | Rewrite: no posting without an approval *decision* (explicit approval **or** owner-set policy); auto-approval **cannot** bypass moderation; still impossible to post without a decision |
| **Invariant #4** | Add: the high-severity hold **overrides auto-approval**; auto additionally requires provider moderation enabled + a per-draft `'clean'` verdict + **zero** flags |
| **Invariant #11** | Add: auto-post gated by subscription via the **publisher** gate; `pending_payment` degrades to `pending_approval` (no strand) |
| **New invariant #14** | Policy contract: account-default + per-location override, star-threshold, resolved once after moderation (**not retroactive**), **subordinate** to moderation veto + **publisher** subscription guard; auto-eligible **only** when `origin_lane === 'live_ingest'` (backfill + regenerate never auto; decoupled from `suppressNotification`); auto-approval **reuses `approved`** with an `approval_method` discriminator (**never** a separate status) |
| **Database** | Migration 055 = three changes: new `auto_approval_policies` table + `responses.approval_method` column + **amend `approval_audit_log.auth_method` CHECK to allow `'auto_policy'`** (§6c — without it auto-approval throws). Tenant isolation (§6a): RLS-enable the new table, add it to `TENANT_TABLES` + `rls-inventory.md`, migration tests |
| **Where things live** | New `auto-approval-policy` skill (sibling of `approval-security`); **update `approval-security`** skill — it currently assumes every post is human-approved. New shared `enqueuePublishResponse` helper (§7) + new `insertAuditLogAutoPolicy` helper in `src/lib/approval/audit.ts` (§8) |

These edits flip the docs to the new reality **in the same commit** the code lands, so CLAUDE.md never describes a bypass that isn't yet built.

## 13. Product decisions (settled in the grilling session)

1. **Per-review FYI on auto-post** — **No in v1.** Dashboard badge + `approval_audit_log` provide transparency; a batched digest is the documented fast-follow (§8).
2. **Threshold vs per-rating map** — **Threshold for v1** (covers all survey cases). Generalize to a per-rating set only if a non-monotonic case appears; `min_star` is the degenerate case of that future widening.
3. **Onboarding ramp** — **Allow all-auto immediately, no hard trust-gate.** Make it cheaply safe instead: an explicit, unmistakable settings-UI confirmation when enabling ("Replies to these reviews will post to Google automatically, without your review"); rely on dashboard transparency so the owner can audit from post #1 and dial back; optionally pre-select a conservative default threshold (4–5★, "automate your best reviews first"). No trust-tracking infrastructure built speculatively; revisit if quality complaints appear.

## 14. Out of scope / future

- Non-star signals (sentiment, keywords, length, language) and the per-rating-map generalization.
- Auto-editing / auto-regeneration before posting.
- Per-reviewer rules, scheduling windows, A/B of auto vs manual.
- Batched "auto-responded to N reviews" digest notification (fast-follow off a scheduler).
- **Retroactively auto-approving already-generated `pending_approval` rows** when a policy is newly enabled or raised (policy is resolved once at generation; see §2). A backfill-style sweep over the pending queue is a deliberate future feature, not v1.
- A sweeper for the residual `active→denied` publish-time strand (also affects manual today).

---

## Next step

When ready to build: run the **writing-plans** skill against this spec to produce the phased implementation plan (migration 055 = policy table + `approval_method` column + `auth_method` CHECK amendment (§6c) + RLS/`TENANT_TABLES`/`rls-inventory.md` for the new table (§6a) → required, fail-closed `origin_lane` payload plumbing across **all five** producers (live ingest, backfill, and the four regenerate lanes) → extract shared `enqueuePublishResponse` helper and migrate the approval modes onto it (§7) → new `insertAuditLogAutoPolicy` audit helper (§8) → resolution module + pure resolver + tests → `load-context` policy load + second publisher `checkSubscription` → `persist.ts` decision integration gated on `held` → settings UI + confirmation (incl. NULL-override = manual) → CLAUDE.md change-map). Auto-approval requires `OPENAI_MODERATION_ENABLED=true` enabled + threshold-tuned **before** launch. Anything touching the worker/migration rides `staging` first, then lands on `main` via PR (the CLAUDE.md change-map travels in that same PR).
