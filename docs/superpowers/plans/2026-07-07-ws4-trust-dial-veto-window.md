# WS4 — Trust Dial + Veto Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Autopilot's safety mechanics — positive-quadrant rating bands, per-location daily caps, governor-ready suspension, a cancellable 15/30-min veto window on auto-posted replies, owner approve/edit/veto outcome instrumentation, and the edit-publish spine-gap fix.

**Architecture:** Extends the shipped auto-approval runtime (never rewrites it): three new gates in `evaluateAutoApprovalCandidate`, policy schema extension in migration 074, delayed publish via `job_outbox.available_at`, a `pending_post_notice` topic-clone with the veto surfaced on the existing approve page, and outcome emitters at the five owner-action chokepoints. Spec of record: `docs/superpowers/specs/2026-07-07-ws4-trust-dial-veto-window-design.md` (READ IT FIRST — on any conflict, the spec wins).

**Tech Stack:** Next.js 16 + Railway worker (Fastify/BullMQ), Postgres.js + Supabase, transactional outbox, Vitest (`createMockSql` + `describeWithDb`).

---

## Binding ground rules (bake into every task)

- **Branch:** `feat/ws4-trust-dial-veto-window` (already exists, carries the spec).
- **Invariant #15 (`ci:db-imports` STRICT):** `src/lib/**` modules take `sql`/`tx` params — never import `@/lib/db/server`. `tx.json()` for JSONB.
- **Lock ordering (binding):** review row `FOR UPDATE` as the tx's FIRST statement for any review-subject spine write; global order reviews → businesses → child rows → agent_runs.
- **ON CONFLICT must match partial-index predicates BYTE-FOR-BYTE**; index-name/topic literals in SQL take `-- topic-audit-ignore` where the outbox topic audit demands (see `enqueuePublishResponse` for the pattern).
- **Migration CHECKs:** `DROP CONSTRAINT IF EXISTS` before ADD; everything re-runnable.
- **Outcome writes are durable facts → in-tx**, never best-effort (see `src/lib/escalations/transitions.ts` header for the posture asymmetry).
- **No new LLM calls** — if you find yourself touching `runLlmTask` or the cost guard, stop; that's out of scope.
- **Brittle allowlists:** any `scripts/ci/static-policy-audit.ts` / `scripts/ci/tenant-scope-allowlist.ts` churn (incl. `ALLOWLIST_BASELINE` bumps) lands in the SAME commit as the change that caused it. Run `pnpm ci:tenant-scope && pnpm ci:static-policy && pnpm ci:db-imports` before every commit.
- **Tests:** mocked-`sql` via `worker/__tests__/helpers/mock-sql.ts` (vi.hoisted recipe in its header; `vi.clearAllMocks()` does NOT reset mockReturnValue — set defaults in beforeEach). Live-DB via `describeWithDb` (needs `TEST_DATABASE_POOL_URL`). Known flaky (unrelated): `worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts`.
- **fallow CI gate:** new duplication clone groups fail the PR — when cloning the notice package, extract genuinely shared logic instead of copy-holding it; sanctioned pragma is `// fallow-ignore-next-line complexity`.
- **Commit format:** end every commit with the Co-Authored-By + Claude-Session trailer used on this branch (see `git log -1`).

## File structure (locked decomposition)

| File | Responsibility |
|---|---|
| `supabase/migrations/074_trust_dial_veto_window.sql` (create) | All WS4 schema (Task 1) |
| `src/lib/auto-approval/types.ts`, `policy.ts` (modify) | Threshold 4\|5, policy-row/effective-policy dial fields, `DEFAULT_DAILY_AUTO_POST_CAP` (Task 2) |
| `worker/jobs/response-generation/auto-approval.ts` (modify) | 3 new gates + runtime-state loads (Task 3) |
| `src/lib/shared/job-outbox-helpers.ts`, `queue-names.ts`, `worker-types.ts` (modify) | `availableAt` on publish enqueue; `pending_post_notice` topic/payload/enqueue (Task 4) |
| `worker/jobs/response-generation/persist.ts` (modify) | Stamp deadline + delayed publish + notice enqueue in the approve tx (Task 5) |
| `src/lib/notifications/channels/*`, `email.ts`, `delivery.ts` (modify) | `sendPendingPostNotice` seam + 3 impls + claim (Task 6) |
| `worker/jobs/pending-post-notice/` (create), `worker/{queues,index}.ts`, `worker/ingress/resend.ts` (modify) | Notice worker package + registration (Task 7) |
| `src/lib/agents/run-spine.ts` (modify), `src/lib/approval/veto.ts` (create), `locks.ts`, `errors.ts` (modify) | Veto transition module + `reply_vetoed_by_owner` (Task 8) |
| `src/app/api/approve/[token]/veto/route.ts` (create), approve page components (modify) | Veto route + scheduled-post state (Task 9) |
| `src/lib/approval/{session,token,callback}-mode.ts` (modify) | Approve/edit outcome emitters (Task 10) |
| `worker/jobs/publisher/edit-publish.ts` (modify) | Spine-gap fix via mark-posted (Task 11) |
| `src/lib/auto-approval/{settings,readiness}.ts`, settings route (modify) | Policy PATCH ops + readiness (Task 12) |
| `/settings/auto-approval` page + `AutoApprovalClient.tsx` (modify) | Dial UI (Task 13) |
| Docs + registries sweep | Task 14 |

Tasks 1→9 are sequential. Tasks 10 and 11 are independent of 4–9 (only need 1–2). Task 12→13 sequential, need 1–2. Task 14 last.

---

### Task 1: Migration 074 + migrations-log entry

**Files:**
- Create: `supabase/migrations/074_trust_dial_veto_window.sql`
- Modify: `.claude/reference/migrations-log.md` (074 entry + head bump to "Current head: **074** — next migration is **075**")
- Test: `src/__tests__/` or wherever migration-shape `describeWithDb` tests live — follow migration 073's test placement (find it: `rg -l "073" src worker --include="*.test.ts"`)

- [ ] **Step 1: Read prerequisites.** Read `.claude/reference/migrations-log.md` entries 055, 067, 071, 073 (the four this builds on) and `supabase/migrations/055_auto_approval_policy.sql` + `071_agent_run_spine.sql` in full. Confirm the inline CHECK constraint names with a live query against the test DB (or staging via the Supabase MCP):

```sql
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'auto_approval_policies'::regclass AND contype = 'c';
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'agent_outcomes'::regclass AND contype = 'c';
```

Record the actual names (expected: `auto_approval_policies_auto_approve_min_star_check`, `agent_outcomes_outcome_kind_check`) and use THEM in the migration. If they differ, adjust the DROP lines below.

- [ ] **Step 2: Write the failing migration-shape test** (describeWithDb; mirror 073's shape test): after applying 074, assert (a) `auto_approval_policies` has the six new columns with expected types/defaults, (b) inserting `auto_approve_min_star = 3` violates the CHECK, (c) two account-default rows for the same `(account_id, persona, action_class)` violate `auto_approval_policies_one_account_default`, (d) `agent_outcomes.outcome_kind = 'reply_vetoed_by_owner'` is accepted and `'bogus_kind'` rejected, (e) `responses.auto_post_scheduled_at` exists, (f) the two `pending_post_notice` partial unique indexes exist (`pg_indexes` lookup), (g) applying the file TWICE is a clean no-op.

- [ ] **Step 3: Write the migration:**

```sql
-- 074_trust_dial_veto_window.sql
-- WS4 trust dial + veto window (spec 2026-07-07-ws4-trust-dial-veto-window-design.md).
-- Additive + re-runnable; transactional (no CONCURRENTLY: new partial indexes have
-- zero-row predicates — 'pending_post_notice' is a brand-new topic/template — and the
-- policies/responses tables are small pre-launch). Apply staging first, then prod.

-- ── 1. auto_approval_policies: scope + dial columns ─────────────────────────
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS persona TEXT NOT NULL DEFAULT 'reply';
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS action_class TEXT NOT NULL DEFAULT 'posting';
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS veto_window_minutes SMALLINT NOT NULL DEFAULT 15;
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS daily_auto_post_cap SMALLINT NULL;
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ NULL;
ALTER TABLE auto_approval_policies ADD COLUMN IF NOT EXISTS suspended_reason TEXT NULL;

ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_persona_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_persona_check
  CHECK (persona IN ('reply'));
ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_action_class_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_action_class_check
  CHECK (action_class IN ('posting'));
ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_veto_window_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_veto_window_check
  CHECK (veto_window_minutes IN (15, 30));
ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_daily_cap_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_daily_cap_check
  CHECK (daily_auto_post_cap IS NULL OR daily_auto_post_cap BETWEEN 1 AND 50);

-- Positive-quadrant raise BEFORE tightening the threshold CHECK (product
-- unlaunched — user-confirmed 2026-07-07; no grandfathering machinery).
UPDATE auto_approval_policies
SET auto_approve_min_star = 4, updated_at = NOW()
WHERE auto_approve_min_star IS NOT NULL AND auto_approve_min_star < 4;

ALTER TABLE auto_approval_policies DROP CONSTRAINT IF EXISTS auto_approval_policies_auto_approve_min_star_check;
ALTER TABLE auto_approval_policies ADD CONSTRAINT auto_approval_policies_auto_approve_min_star_check
  CHECK (auto_approve_min_star IS NULL OR auto_approve_min_star BETWEEN 4 AND 5);

-- Uniqueness now includes the (persona, action_class) scope. The ON CONFLICT
-- writers in src/lib/auto-approval/settings.ts are updated in the same PR
-- (Task 12) to match these predicates BYTE-FOR-BYTE.
DROP INDEX IF EXISTS auto_approval_policies_one_account_default;
CREATE UNIQUE INDEX IF NOT EXISTS auto_approval_policies_one_account_default
  ON auto_approval_policies (account_id, persona, action_class)
  WHERE location_id IS NULL;
DROP INDEX IF EXISTS auto_approval_policies_one_location_override;
CREATE UNIQUE INDEX IF NOT EXISTS auto_approval_policies_one_location_override
  ON auto_approval_policies (account_id, location_id, persona, action_class)
  WHERE location_id IS NOT NULL;

-- ── 2. responses: veto-window deadline + cap-count index ────────────────────
ALTER TABLE responses ADD COLUMN IF NOT EXISTS auto_post_scheduled_at TIMESTAMPTZ NULL;
COMMENT ON COLUMN responses.auto_post_scheduled_at IS
  'Auto-approved publish deadline (veto window end). Single source of truth for the '
  'notice copy, approve-page scheduled state, and veto guard. NULL once vetoed/downgraded '
  'and for every owner-approved response. WS4 spec §2.5.';

-- Daily-cap accounting read (§2.3): plain range predicate on approved_at —
-- deliberately NOT a per-day expression index (IMMUTABLE gotcha avoided).
CREATE INDEX IF NOT EXISTS idx_responses_auto_policy_daily_cap
  ON responses (business_id, approved_at)
  WHERE approval_method = 'auto_policy';

-- ── 3. agent_outcomes: veto outcome kind ────────────────────────────────────
ALTER TABLE agent_outcomes DROP CONSTRAINT IF EXISTS agent_outcomes_outcome_kind_check;
ALTER TABLE agent_outcomes ADD CONSTRAINT agent_outcomes_outcome_kind_check
  CHECK (outcome_kind IN (
    'reply_drafted', 'reply_posted', 'reply_auto_posted',
    'reply_approved_no_edit', 'reply_edited_by_owner', 'reply_vetoed_by_owner',
    'review_escalated', 'escalation_resolved', 'digest_sent'
  ));

-- ── 4. pending_post_notice outbox in-flight + delivery claim indexes ────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_pending_post_notice_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'pending_post_notice' AND status IN ('pending', 'dispatching', 'dispatched');
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_pending_post_notice_claim
  ON notification_deliveries (response_id, channel, recipient)
  WHERE response_id IS NOT NULL AND template = 'pending_post_notice';
```

IMPORTANT: if migration 071's CHECK definition (from Step 1) lists kinds in a different order or wording, replicate ITS text and only append `reply_vetoed_by_owner` — the CHECK swap must be a strict superset.

- [ ] **Step 4: Run the shape test** against the test DB (apply 074, run, apply again, re-run). Expected: PASS incl. the double-apply no-op.
- [ ] **Step 5: Update `.claude/reference/migrations-log.md`:** head bump + a 074 entry in the established voice (what/why, re-runnability, the byte-for-byte index/writer pairings, staging-first note, the CHECK-tighten + data-raise ordering).
- [ ] **Step 6: Commit** (`feat(ws4): migration 074 — trust dial + veto window schema`).

### Task 2: Policy domain — threshold narrowing + dial fields

**Files:**
- Modify: `src/lib/auto-approval/types.ts`, `src/lib/auto-approval/policy.ts`
- Test: existing colocated tests (`rg -l "resolveEffectivePolicy|starMeetsThreshold" src/lib/auto-approval --include="*.test.ts"` — extend them)

- [ ] **Step 1: Write failing tests:** (a) `isAutoApprovalThreshold(3)` is false, `(4)`/`(5)` true; (b) `resolveEffectivePolicy` returns override's `vetoWindowMinutes`/`dailyAutoPostCap` when an override exists, account default's otherwise, and `{ vetoWindowMinutes: 15, dailyAutoPostCap: null, suspended: false }` for `source: 'none'`; (c) `suspended` is true when EITHER the account default OR the winning override row has `suspendedAt` set (spec §2.4); (d) `exposureRank` no longer accepts 1–3 (type-level — delete those cases).
- [ ] **Step 2: Implement.** In `types.ts`: `AutoApprovalThresholdSchema = z.union([z.literal(4), z.literal(5)])`; extend `PolicyRowState` with `vetoWindowMinutes: 15 | 30`, `dailyAutoPostCap: number | null`, `suspendedAt: Date | null`; extend `EffectiveAutoApprovalPolicy` with `vetoWindowMinutes: 15 | 30`, `dailyAutoPostCap: number | null`, `suspended: boolean`. In `policy.ts`: trim `exposureRank` to `null | 5 | 4` cases (0/1/2); export `DEFAULT_DAILY_AUTO_POST_CAP = 10`; extend `resolveEffectivePolicy`:

```ts
export function resolveEffectivePolicy(
  accountDefault: PolicyRowState | null,
  locationOverride: PolicyRowState | null,
): EffectiveAutoApprovalPolicy {
  const winner = locationOverride ?? accountDefault;
  // The account-level suspension (governor kill switch, spec §2.4) applies even
  // when a location override wins the threshold resolution.
  const suspended = Boolean(accountDefault?.suspendedAt) || Boolean(winner?.suspendedAt);
  if (!winner) {
    return {
      source: 'none', threshold: null, policyId: null,
      vetoWindowMinutes: 15, dailyAutoPostCap: null, suspended,
    };
  }
  return {
    source: locationOverride ? 'location_override' : 'account_default',
    threshold: winner.autoApproveMinStar,
    policyId: winner.id,
    vetoWindowMinutes: winner.vetoWindowMinutes,
    dailyAutoPostCap: winner.dailyAutoPostCap,
    suspended,
  };
}
```

- [ ] **Step 3: Run the domain tests + `pnpm typecheck`.** Typecheck WILL fail in `settings.ts`/UI where thresholds 1–3 are referenced — fix ONLY compile errors minimally here (e.g. THRESHOLD_OPTIONS trimming lands properly in Tasks 12/13; if a temporary type assertion is unavoidable, prefer deleting the dead option entries now — they are pure data).
- [ ] **Step 4: Commit** (`feat(ws4): narrow auto-approval threshold to positive quadrant + dial policy fields`).

### Task 3: Evaluator gates + runtime-state loads

**Files:**
- Modify: `worker/jobs/response-generation/auto-approval.ts`
- Test: `worker/jobs/response-generation/__tests__/auto-approval.test.ts` (find exact name via `ls worker/jobs/response-generation/__tests__/`)

- [ ] **Step 1: Lock-order audit (spec §2.3).** Run `rg -n "FROM businesses[^;]*FOR UPDATE" src worker` and inspect each hit's enclosing tx: does any lock `businesses` FOR UPDATE and LATER lock a `reviews` row FOR UPDATE in the same tx? (`FOR SHARE` on businesses — `assertLocationNotArchived` — is compatible-with-itself and only conflicts with FOR UPDATE; note findings.) If a reverse-order site exists, use the spec's fallback: lock-free count, document the ±concurrency overshoot in a code comment, and skip the business lock below. Record the audit result in the task's commit message.
- [ ] **Step 2: Write failing evaluator tests** (pure function — no mocks needed): (a) 3★ + threshold 4 → blocks with BOTH `rating_below_threshold` and `rating_below_positive_quadrant`; (b) 3★ + (hypothetical) threshold-met input still blocks `rating_below_positive_quadrant` (pass `effectivePolicy.threshold: 4`, `currentStarRating: 3` — the hard floor is independent); (c) 4★ clean + `autoApprovedTodayCount: 10, effectiveDailyCap: 10` → `daily_cap_exhausted`; count 9 → approved; (d) `policySuspended: true` → `policy_suspended`; (e) existing 18-gate matrix untouched (run the whole file).
- [ ] **Step 3: Implement evaluator.** Extend `AutoApprovalBlockReason` with `'rating_below_positive_quadrant' | 'daily_cap_exhausted' | 'policy_suspended'`. Extend `AutoApprovalCandidateInput` with `autoApprovedTodayCount: number; effectiveDailyCap: number; policySuspended: boolean;`. Append to the `compactBlockReasons` array (order: right after the WS2 triage vetoes):

```ts
    when(input.currentStarRating !== null && input.currentStarRating <= 3, 'rating_below_positive_quadrant'),
    when(input.autoApprovedTodayCount >= input.effectiveDailyCap, 'daily_cap_exhausted'),
    when(input.policySuspended, 'policy_suspended'),
```

- [ ] **Step 4: Implement loader.** In `loadAutoApprovalRuntimeState`: (a) policy SELECT gains the new columns + scope filter `AND persona = 'reply' AND action_class = 'posting'`; map them into `PolicyRowState` (`vetoWindowMinutes`, `dailyAutoPostCap`, `suspendedAt`); (b) after the policy read, take the business lock then count (unless Step 1's audit forced the fallback):

```ts
  // Serialize concurrent cap evaluations per location (spec §2.3). Lock order:
  // the persist tx already holds this review's row FOR UPDATE (its first
  // statement), and the audited global order is reviews → businesses.
  await tx`SELECT id FROM businesses WHERE id = ${businessId} FOR UPDATE`;
  const [capRow] = await tx<{ auto_approved_today: number }[]>`
    SELECT count(*)::int AS auto_approved_today
    FROM responses
    WHERE business_id = ${businessId}
      AND approval_method = 'auto_policy'
      AND approved_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `;
```

Return `autoApprovedTodayCount`, `effectiveDailyCap: effectivePolicy.dailyAutoPostCap ?? DEFAULT_DAILY_AUTO_POST_CAP`, and `policySuspended: effectivePolicy.suspended` on `AutoApprovalRuntimeState`; thread all three through the `evaluateAutoApprovalCandidate` call in `persist.ts` (compile error will point there) and into `buildAutoApprovalDecisionSummary` (add `daily_cap`, `auto_approved_today`, `policy_suspended` fields — ids/enums/counts only).
- [ ] **Step 5: Mocked-sql loader test:** policy rows with new columns resolve; the UTC-day boundary predicate is asserted by inspecting the captured SQL (mock-sql helper records statements). Integration (describeWithDb): two concurrent `sql.begin` persist-shaped txs against one business — second blocks on the business lock until first commits, then sees its approval in the count (drive with `Promise.all` + explicit ordering; mirror WS3's concurrent double-raise test structure).
- [ ] **Step 6: Run the whole response-generation test dir + typecheck + audits. Commit** (`feat(ws4): rating-band, daily-cap and suspension gates in the auto-approval evaluator`).

### Task 4: Outbox plumbing — delayed publish + pending_post_notice enqueue

**Files:**
- Modify: `src/lib/shared/job-outbox-helpers.ts`, `src/lib/shared/queue-names.ts`, `src/lib/shared/worker-types.ts`
- Test: colocated helper tests (`rg -l "enqueuePublishResponse" src/lib/shared --include="*.test.ts"`)

- [ ] **Step 1: Failing tests:** (a) `enqueuePublishResponse` without `availableAt` inserts `available_at = NOW()`-equivalent (assert the SQL contains `COALESCE` and the bound param is null); (b) with `availableAt: someDate` binds that date; (c) `enqueuePendingPostNotice` inserts topic `pending_post_notice`, aggregate `response`, ids-only payload, and carries the byte-for-byte ON CONFLICT predicate (assert SQL text includes `WHERE topic = 'pending_post_notice'` and the three statuses).
- [ ] **Step 2: Implement.** `queue-names.ts`: `PENDING_POST_NOTICE: 'pending_post_notice'` (mirror how `AUTO_POST_NOTICE` is declared and registered in any queue-name lists/types). `worker-types.ts`: `PendingPostNoticePayload { response_id: string; business_id: string; correlation_id?: string }`. `job-outbox-helpers.ts`:

```ts
export interface EnqueuePublishResponseInput {
  outboxId?: string;
  responseId: string;
  businessId: string;
  correlationId?: string;
  /** Veto-window delayed publish (WS4 §2.5): OutboxPoller claims only rows with
   *  available_at <= NOW(), so this single column IS the delay mechanism. */
  availableAt?: Date;
}
```

In the INSERT, change the column list to `(id, topic, aggregate_type, aggregate_id, payload, status, available_at)` and the VALUES tail to `${JOB_OUTBOX_STATUS_PENDING}, COALESCE(${input.availableAt ?? null}, NOW())`. Leave the ON CONFLICT clause byte-identical. Then add `enqueuePendingPostNotice` cloned from `enqueueAutoPostNotice` (same interface shape with `responseId`, aggregate `AGGREGATE_TYPE_RESPONSE`, topic `QUEUE_NAMES.PENDING_POST_NOTICE`, `-- topic-audit-ignore` comment on the ON CONFLICT literal, doc comment naming `idx_jo_pending_post_notice_inflight`).
- [ ] **Step 3: Run tests + `pnpm ci:tenant-scope` (new SQL touchpoint may need an allowlist entry — same commit) + commit** (`feat(ws4): delayed publish enqueue + pending_post_notice outbox helper`).

### Task 5: persist.ts — schedule the delayed auto-publish + notice

**Files:**
- Modify: `worker/jobs/response-generation/persist.ts`
- Test: the persist test file in `worker/jobs/response-generation/__tests__/`

- [ ] **Step 1: Failing tests (mocked sql):** on the auto-approved branch (a) the responses UPDATE sets `auto_post_scheduled_at` and the enqueued publish row's `available_at` equals it (assert both captured statements); (b) a `pending_post_notice` enqueue happens in the same tx; (c) the held/blocked branches do NOT stamp `auto_post_scheduled_at` and do NOT enqueue the notice; (d) `veto_window_minutes: 30` policy → 30-minute delta (compute from the bound interval param).
- [ ] **Step 2: Implement.** In the `autoDecision.approved` branch, replace the approve UPDATE + publish enqueue with:

```ts
      const vetoWindowMinutes = runtimeState.effectivePolicy.vetoWindowMinutes;
      const [scheduled] = await tx<{ auto_post_scheduled_at: Date }[]>`
        UPDATE responses
        SET status = ${RESPONSE_STATUS_APPROVED},
            approval_method = ${APPROVAL_METHOD.AUTO_POLICY},
            approved_text = ${result.responseText},
            approved_at = NOW(),
            auto_post_scheduled_at = NOW() + make_interval(mins => ${vetoWindowMinutes}),
            posting_error = NULL,
            updated_at = NOW()
        WHERE id = ${responseId}
          AND business_id = ${businessId}
          AND status = ${RESPONSE_STATUS_PENDING_APPROVAL}
        RETURNING auto_post_scheduled_at
      `;
```

Keep `insertAuditLogAutoPolicy` unchanged but add `veto_window_minutes: vetoWindowMinutes` to its metadata. Then:

```ts
      await enqueuePublishResponse(tx, {
        responseId,
        businessId,
        correlationId,
        availableAt: scheduled!.auto_post_scheduled_at,
      });
      await enqueuePendingPostNotice(tx, { responseId, businessId, correlationId });
```

(If `scheduled` is undefined the guarded UPDATE lost a race — throw `new Error('auto_approve_transition_lost')` so the tx rolls back; the existing generation-job retry semantics cover it.)
- [ ] **Step 3: Run the persist tests + full response-generation dir. Commit** (`feat(ws4): veto-window delayed publish + pending-post notice on auto-approval`).

### Task 6: Notification channel seam — sendPendingPostNotice

**Files:**
- Modify: `src/lib/notifications/channels/types.ts`, `email-channel.ts`, `telegram-channel.ts`, `whatsapp-channel.ts`, `src/lib/notifications/email.ts`, `src/lib/notifications/delivery.ts`
- Test: colocated channel/delivery tests (mirror WS3's `sendEscalationNotice` tests file-for-file — `rg -l "sendEscalationNotice" src/lib/notifications`)

- [ ] **Step 1: Read the WS3 precedent end-to-end first:** `sendEscalationNotice` on the interface, its three channel impls, the email template, `claimEscalationNoticeDelivery`. Your additions must be the same shape, one for one.
- [ ] **Step 2: Failing tests:** interface totality (each channel implements `sendPendingPostNotice`); email template renders business name, star rating, reviewer display name, truncated review + truncated draft (use the surface's established `truncate` helpers — no bespoke slicing, WS3 §6 amendment precedent), the "posting automatically at" time, and the approve-page link; WhatsApp impl fails closed-and-logged when the template SID env is unset; claim helper's ON CONFLICT matches `notification_deliveries_pending_post_notice_claim` byte-for-byte (`(response_id, channel, recipient) WHERE response_id IS NOT NULL AND template = 'pending_post_notice'`).
- [ ] **Step 3: Implement** `SendPendingPostNoticeParams` (business/location display name, star rating, reviewer name, review text, draft text, `scheduledPostAt: Date`, `approveUrl: string` — the tokenized approve-page link) + the interface method + 3 impls + `claimPendingPostNoticeDelivery`/reuse of `releaseDeliveryClaim`. Copy tone/structure from the escalation notice; the message copy states the reply will post automatically at ~HH:MM local-agnostic UTC-relative phrasing ("in about N minutes") with one button/link: "Review or cancel". Review context ONLY in the private message (never payloads/logs — WS4 spec §2.7).
- [ ] **Step 4: Run tests. WhatsApp template env var:** follow the escalation-notice precedent for the SID env name (`WHATSAPP_PENDING_POST_TEMPLATE_SID`) incl. `worker/config/startup-assert.ts` treatment if the precedent registers there. Commit** (`feat(ws4): pending-post notice channel seam + templates + delivery claim`).

### Task 7: pending-post-notice worker package + registration

**Files:**
- Create: `worker/jobs/pending-post-notice/{PendingPostNoticeWorker.ts,context.ts,dispatch.ts,errors.ts}` (+ `__tests__/`)
- Modify: `worker/queues.ts`, `worker/index.ts`, `worker/ingress/resend.ts`
- Test: `worker/jobs/pending-post-notice/__tests__/` (clone auto-post-notice's test structure)

- [ ] **Step 1: Read `worker/jobs/auto-post-notice/` in full** (worker, context, dispatch, errors + tests) and `worker/jobs/escalation-notice/` for the bounced-owner skip. The new package is their sibling; extract any 3-way-identical logic into a shared helper ONLY if it drops out cleanly (fallow gate prefers extraction, but do not force a bad abstraction — flag it for the reviewer instead).
- [ ] **Step 2: Failing tests for the context loader** (mocked sql): skip-complete (no send) when (a) response is not `status='approved'` + `approval_method='auto_policy'` (vetoed/kill-switched/posted meanwhile), (b) `auto_post_scheduled_at` is NULL or `<= NOW()` (stale backlog — a notice that can't be acted on is noise), (c) `AUTO_APPROVAL_ENABLED` is off (send-time kill switch, WS3 §2.4 semantics), (d) subscription check via `getEligibleChannels` denies. Happy path loads business/review/draft context.
- [ ] **Step 3: Failing tests for dispatch:** claim-before-send per channel; bounced-owner email skip (`businesses.owner_email_bounced` → counted skipped, ids-only log); per-channel failure isolation (one channel throwing doesn't stop others); approval-link creation per delivery (see Step 4); retryable vs terminal classification mirrors auto-post-notice's `errors.ts`.
- [ ] **Step 4: Implement.** The dispatch creates ONE approval link per channel delivery via the same helper the approval dispatcher uses (`src/lib/approval/create-link.ts` — read it; raw token only into the message URL, hash into `approval_links`, standard TTL). The link URL is the ordinary approve-page URL (`/approve/<rawToken>`) — Task 9 teaches that page the scheduled state. Record deliveries exactly like auto-post-notice. `escalation_sent`-style spine step: record a best-effort `owner_notified`-family step? NO — WS4 adds no new step keys (spec §2.6/§2.8); skip spine writes in this worker entirely.
- [ ] **Step 5: Register:** queue instance + `topicToQueue` in `worker/queues.ts`, worker + `workersByQueue` in `worker/index.ts`, `'pending_post_notice'` into `OWNER_DIRECTED_TEMPLATES` in `worker/ingress/resend.ts` (hard bounces flag `owner_email_bounced`). Mirror WS3's registration diff exactly (`git log --oneline -20 -- worker/queues.ts` → find the WS3 commit and read its diff).
- [ ] **Step 6: Run the package tests + boot the worker locally once (`pnpm worker` with `MOCK_EXTERNAL_APIS=true`) to verify registration (25→26 queues in the boot log). Commit** (`feat(ws4): pending-post-notice worker + queue registration`).

### Task 8: Veto transition module + outcome kind

**Files:**
- Modify: `src/lib/agents/run-spine.ts` (AGENT_OUTCOME_KINDS), `src/lib/approval/locks.ts` (new lock helper), `src/lib/approval/errors.ts` (veto error types if the route mapping needs them)
- Create: `src/lib/approval/veto.ts` (+ test file colocated with the other approval-mode tests)

- [ ] **Step 1: run-spine:** append `'reply_vetoed_by_owner'` to `AGENT_OUTCOME_KINDS` (matches 074's CHECK — Task 1). Run the run-spine drift-guard tests (`pnpm test -- run-spine`): the kind list test must be updated in the same commit if one pins the array.
- [ ] **Step 2: Failing tests for `vetoAutoPost`** (mocked sql): (a) pending outbox row killed → response downgraded (assert guarded UPDATE shape: `WHERE ... status = 'approved' AND approval_method = 'auto_policy'`, sets `pending_approval`, `approval_method NULL`, `auto_post_scheduled_at NULL`, `posting_error 'auto_post_vetoed_by_owner'`), audit written, `reply_vetoed_by_owner` recorded when a running run exists, `enqueueSendNotification` enqueued, link consumed → returns `'cancelled'`; (b) no pending row + response still approved/auto_policy → `'too_late'`, NOTHING mutated; (c) no pending row + response already downgraded-with-veto-marker or posted → `'already_cancelled'` / `'too_late'` respectively; (d) no running run → outcome skipped, everything else proceeds.
- [ ] **Step 3: Implement `src/lib/approval/veto.ts`:**

```ts
// src/lib/approval/veto.ts
//
// Owner veto of a scheduled auto-post (WS4 spec §2.6). The pending
// publish_response outbox row is the atomicity token: the veto succeeds IFF
// this tx terminalizes that row while it is still 'pending' — the OutboxPoller
// claims with FOR UPDATE SKIP LOCKED, so whoever locks first wins and there is
// no state where Google has the reply after the owner saw "cancelled".

import type postgres from 'postgres';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { enqueueSendNotification } from '@/lib/shared/job-outbox-helpers';
import { findActiveReviewRun, recordOutcome } from '@/lib/agents/run-spine';
import { insertAuditLog, type AuditContext } from './audit';
import { consumeLink } from './locks';
import type { ApprovalLink } from './types';

type TxClient = postgres.TransactionSql;

export const AUTO_POST_VETOED_BY_OWNER = 'auto_post_vetoed_by_owner';

export type VetoAutoPostResult = 'cancelled' | 'already_cancelled' | 'too_late';

export async function vetoAutoPost(
  tx: TxClient,
  link: ApprovalLink,
  audit: AuditContext,
  correlationId?: string,
): Promise<VetoAutoPostResult> {
  const responseId = link.response_id;
  const businessId = link.business_id;

  // Lock the response first (uniform approval-lane order: responses → rest).
  const [resp] = await tx<{
    status: string; approval_method: string | null;
    posting_error: string | null; review_id: string;
  }[]>`
    SELECT status, approval_method, posting_error, review_id
    FROM responses
    WHERE id = ${responseId} AND business_id = ${businessId}
    FOR UPDATE
  `;
  if (!resp) return 'too_late';

  if (!(resp.status === 'approved' && resp.approval_method === APPROVAL_METHOD.AUTO_POLICY)) {
    return resp.status === 'pending_approval' && resp.posting_error === AUTO_POST_VETOED_BY_OWNER
      ? 'already_cancelled'
      : 'too_late';
  }

  // The atomic kill. 0 rows ⇒ the publisher already claimed it — too late.
  const [killed] = await tx<{ id: string }[]>`
    UPDATE job_outbox
    SET status = 'completed', completed_at = NOW(), last_error = ${AUTO_POST_VETOED_BY_OWNER}
    WHERE topic = ${QUEUE_NAMES.PUBLISH_RESPONSE}
      AND aggregate_id = ${responseId}
      AND status = 'pending'
    RETURNING id
  `;
  if (!killed) return 'too_late';

  const [downgraded] = await tx<{ id: string }[]>`
    UPDATE responses
    SET status = 'pending_approval',
        approval_method = NULL,
        approved_at = NULL,
        approved_text = NULL,
        auto_post_scheduled_at = NULL,
        posting_error = ${AUTO_POST_VETOED_BY_OWNER},
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status = 'approved'
      AND approval_method = ${APPROVAL_METHOD.AUTO_POLICY}
    RETURNING id
  `;
  if (!downgraded) {
    // Impossible while we hold the response lock — defensive rollback.
    throw new Error('veto_downgrade_lost_response');
  }

  await consumeLink(tx, link.id);

  const activeRun = await findActiveReviewRun(tx, resp.review_id);
  if (activeRun) {
    await recordOutcome(tx, {
      runId: activeRun.id,
      accountId: activeRun.account_id,
      businessId,
      attributedAgent: 'reply',
      outcomeKind: 'reply_vetoed_by_owner',
    });
  }

  await insertAuditLog(tx, responseId, businessId, 'veto_cancel', audit, {
    correlation_id: correlationId,
  });

  // Kill-switch-downgrade parity: the draft goes back to the normal approval
  // lane with fresh links, so it is actionable from the owner's channel.
  await enqueueSendNotification(tx, { responseId, businessId, correlationId });

  return 'cancelled';
}
```

Check whether the tenant-scope audit flags the `job_outbox` UPDATE (no account scope on that table — look for existing outbox-UPDATE allowlist entries, e.g. `markOutboxCompleted`, and mirror their category) and whether the topic audit demands `-- topic-audit-ignore`; handle in the same commit. NOTE the response lock here does NOT go through `lockPendingResponse` (which requires `pending_approval` + rejects archived locations) — vetoing on an archived location is deliberately allowed: cancelling an outbound post is a reduction of exposure and must not fail closed. Document that in the module comment.
- [ ] **Step 4: Integration test (describeWithDb):** real tx race — start a `sql.begin` that claims the outbox row poller-style (`UPDATE ... SET status='dispatching' WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`) and hold it; a concurrent `vetoAutoPost` returns `'too_late'`. Then the reverse order returns `'cancelled'` and the poller-style claim finds nothing.
- [ ] **Step 5: Run tests + audits. Commit** (`feat(ws4): veto transition module + reply_vetoed_by_owner outcome`).

### Task 9: Veto route + approve-page scheduled state

**Files:**
- Create: `src/app/api/approve/[token]/veto/route.ts`
- Modify: the approve page + its client components (`src/app/approve/[token]/` — read the whole directory first) and `src/lib/approval/http-routes.ts` if the wrapper needs a veto-aware variant
- Test: route tests colocated with the sibling approve-route tests; component test alongside the page's existing ones

- [ ] **Step 1: Read `src/lib/approval/http-routes.ts` (`runTokenApprovalAction`) and the three sibling routes + the approve page loader.** Key incompatibility to solve: the sibling actions go through `lockPendingResponse` (pending-only). The veto route wraps `vetoAutoPost` instead, but keeps the SAME outer machinery: `withSameOrigin`, `force-dynamic`, `lockValidLink` + `verifyDevice` (device bound via the existing `/session` route — the approve page already establishes it), rate limiting if the wrapper applies it, and the standard error mapping. Route stays parse → one module call → mapped response (invariant #12).
- [ ] **Step 2: Failing route tests:** 200 `{ result: 'cancelled' }` happy path; `{ result: 'too_late' }` maps to 409; invalid/expired/consumed token → the wrapper's standard 4xx; same-origin enforced; device mismatch → the standard conflict error.
- [ ] **Step 3: Implement the route** (thin composition root; the outcome-to-status mapping table lives beside the sibling routes' mapping).
- [ ] **Step 4: Approve page scheduled state.** Read the page's data loader: it must now ALSO load `approval_method` + `auto_post_scheduled_at` and render, for `status='approved' AND approval_method='auto_policy' AND auto_post_scheduled_at > NOW()`: the draft (read-only), "Posting automatically at ~{time}" with a countdown-free static timestamp, and a single destructive-styled **Cancel auto-post** button POSTing to the veto route; after success, a confirmation state ("Cancelled — the draft is back in your approval queue; we've sent you a fresh approval link."). For `auto_post_scheduled_at <= NOW()` render the existing "no longer actionable" state. Invoke the `repworth-brand-design` skill BEFORE writing any UI code and follow its tokens/patterns. Do NOT touch the pending-approval flow's markup beyond the added branch.
- [ ] **Step 5: Component/route tests green; `pnpm lint && pnpm typecheck`. Commit** (`feat(ws4): veto cancel route + approve-page scheduled-post state`).

### Task 10: Approve/edit outcome instrumentation (5 chokepoints)

**Files:**
- Modify: `src/lib/approval/session-mode.ts` (approveBySession, editBySession), `src/lib/approval/token-mode.ts` (approve, edit), `src/lib/approval/callback-mode.ts` (approveViaCallback)
- Test: the existing mode test files (find: `rg -l "approveBySession|approveViaCallback" src/lib/approval --include="*.test.ts"`)

- [ ] **Step 1: Failing tests:** for each of the five functions — a running review run exists ⇒ exactly one `agent_outcomes` insert with the right kind (`reply_approved_no_edit` for the 3 approve variants, `reply_edited_by_owner` for the 2 edit variants), attributed `reply`; no running run ⇒ no outcome insert, action still succeeds; retry/duplicate action ⇒ per-(run,kind) ON CONFLICT absorbs (mock the second call).
- [ ] **Step 2: Implement.** Extract ONE tiny shared emitter in `src/lib/approval/outcomes.ts` (three-caller rule satisfied; keeps fallow happy and the five sites one-line):

```ts
// src/lib/approval/outcomes.ts
import type postgres from 'postgres';
import { findActiveReviewRun, recordOutcome } from '@/lib/agents/run-spine';

type TxClient = postgres.TransactionSql;

/** Emit the owner-decision outcome for a review's running run, if any (WS4
 *  spec §2.8). Legacy/no-run reviews skip silently — established posture. */
export async function recordOwnerDecisionOutcome(
  tx: TxClient,
  input: {
    reviewId: string;
    businessId: string;
    outcomeKind: 'reply_approved_no_edit' | 'reply_edited_by_owner';
  },
): Promise<void> {
  const activeRun = await findActiveReviewRun(tx, input.reviewId);
  if (!activeRun) return;
  await recordOutcome(tx, {
    runId: activeRun.id,
    accountId: activeRun.account_id,
    businessId: input.businessId,
    attributedAgent: 'reply',
    outcomeKind: input.outcomeKind,
  });
}
```

Call it in each function right after the response UPDATE (the `resp` from `lockPendingResponse` provides `review_id` in every lane): `await recordOwnerDecisionOutcome(tx, { reviewId: resp.review_id, businessId, outcomeKind: 'reply_approved_no_edit' })` (session/token/callback approve) and `'reply_edited_by_owner'` (session/token edit). In callback-mode the business id is `link.business_id`.
- [ ] **Step 3: Run all approval tests + `pnpm ci:db-imports`. Commit** (`feat(ws4): owner approve/edit outcome instrumentation at all five chokepoints`).

### Task 11: Edit-publish spine-gap fix

**Files:**
- Modify: `worker/jobs/publisher/edit-publish.ts` (success path, currently lines ~320–338)
- Test: `worker/jobs/publisher/__tests__/` — the edit-publish unit tests + the integration file

- [ ] **Step 1: Failing test:** an edit-publish success against a review with a running run leaves the run `completed` with a `reply_posted` step + `reply_posted` outcome; owner lane ⇒ NO `auto_post_notice` enqueued; a legacy no-run review still succeeds with zero spine writes.
- [ ] **Step 2: Implement.** Replace the step-7 success UPDATE with marker-clear + the shared checkpoint (the tx already holds the review lock from step 1, satisfying mark-posted's ordering contract — its re-lock is an idempotent same-tx re-acquire):

```ts
      // 7. Success path. Sibling supersede + candidate posted via the shared
      // mark-posted checkpoint (WS4 spec §2.9 — closes the WS1 spine gap:
      // this lane previously flipped to posted without completing the run).
      if (existingPosted) {
        await supersedeSibling(tx, existingPosted.id);
      }
      await tx`
        UPDATE responses
        SET posting_error = NULL, updated_at = NOW()
        WHERE id = ${responseId} AND business_id = ${businessId}
      `;
      const marked = await markPostedAndMaybeEnqueueAutoPostNotice({
        tx,
        responseId,
        reviewId,
        businessId,
        correlationId,
        logger,
      });
      if (!marked.transitioned) {
        throw new Error('candidate_lost_during_publish');
      }
      outcomeRef.value = { kind: 'success' };
```

Verify `correlationId` and `logger` are in scope in this function (they are used elsewhere in the file — if the inner helper doesn't receive them, thread them through from the caller; check `edit-publish-tx.ts` too). The separate marker-clear UPDATE preserves the old behavior (`posting_error = NULL`) that mark-posted's UPDATE does not set.
- [ ] **Step 3: Run the publisher test dir (integration file may be flaky — rerun once before diagnosing). Commit** (`fix(ws4): route edit-publish success through the mark-posted spine checkpoint`).

### Task 12: Settings backend — PATCH ops + readiness

**Files:**
- Modify: `src/lib/auto-approval/settings.ts`, `src/lib/auto-approval/readiness.ts`, `src/lib/auto-approval/types.ts` (PATCH schema + API state types), `src/app/api/settings/auto-approval/route.ts` (error mapping only if new error kinds appear)
- Test: the settings test files (`rg -l "patchAutoApprovalSettings" src/lib/auto-approval --include="*.test.ts"`)

- [ ] **Step 1: Read `settings.ts` in full** (690 lines — the upsert ON CONFLICT sites ~L454–507 and SELECT lists ~L461–518 are the critical regions) and `readiness.ts`.
- [ ] **Step 2: Failing tests:** (a) PATCH `set_account_default` with `threshold: 3` fails zod; (b) new ops `set_account_veto_window` / `set_location_veto_window` (`minutes: 15|30`) and `set_account_daily_cap` / `set_location_daily_cap` (`cap: number 1..50 | null`) round-trip through `patchAutoApprovalSettings` and land in the columns; (c) every upsert's ON CONFLICT still resolves (integration or captured-SQL assertion) against the REBUILT indexes — conflict targets are now `(account_id, persona, action_class) WHERE location_id IS NULL` and `(account_id, location_id, persona, action_class) WHERE location_id IS NOT NULL`, byte-for-byte; (d) GET response includes `vetoWindowMinutes`, `dailyAutoPostCap` (with `null` = default signalled distinctly), `suspended` + `suspendedReason` per scope; (e) readiness gains `policy_suspended` in `blockReasons` when the account default row is suspended; (f) veto-window/cap changes do NOT require the expansion confirmation (they are not exposure expansions — only threshold loosening is).
- [ ] **Step 3: Implement:** SELECT/INSERT/UPDATE column lists gain the four owner-facing columns (persona/action_class are always the `'reply'`/`'posting'` literals from constants — export `POLICY_PERSONA_REPLY = 'reply'` / `POLICY_ACTION_POSTING = 'posting'` in `types.ts`, no string literals at call sites per repworth rules); new PATCH ops in the discriminated union; `AutoApprovalReadinessBlockReason` + `'policy_suspended'`; `AutoApprovalSettingsResponse` extended. Remove the now-dead `all_ratings` confirmation level end-to-end (schema, `assertMutationAllowed`, tests) — threshold 1 no longer exists so the level is unreachable; keep `standard`.
- [ ] **Step 4: Run settings tests + `pnpm ci:static-policy` (this file is why the static-policy allowlist is line-keyed — if `src/lib/dashboard/types.ts` shifted, fix entries in the same commit) + commit** (`feat(ws4): trust-dial settings backend — veto window, daily cap, suspension readiness`).

### Task 13: Settings UI

**Files:**
- Modify: `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx` (+ `page.tsx` if the SSR payload type changed)
- Test: existing component tests beside the client

- [ ] **Step 1: Invoke the `repworth-brand-design` skill**, then read the current client component in full.
- [ ] **Step 2: Failing component tests:** threshold selects offer exactly Off / 5★ only / 4–5★; veto-window control renders 15/30 with current value; daily-cap input clamps 1–50 and blank submits `null` (labelled "default (10)"); suspended banner renders reason and disables expansion controls; each control fires the matching PATCH op.
- [ ] **Step 3: Implement:** trim `THRESHOLD_OPTIONS` to `[null, 5, 4]` entries; drop the `all_ratings` modal branch (`required = 'standard'` for any expansion); add the two controls to the account-default section and each location row (inherit/override semantics identical to the threshold's); suspended banner from the GET payload. Keep the existing readiness-block rendering.
- [ ] **Step 4: `pnpm lint && pnpm typecheck && pnpm test -- AutoApproval` + visual sanity via `pnpm dev` if feasible. Commit** (`feat(ws4): trust-dial settings UI — bands, veto window, daily cap, suspension banner`).

### Task 14: Docs, registries, full gates

**Files:**
- Modify: `.claude/reference/env-vars.md` (AUTO_APPROVAL_ENABLED note + `WHATSAPP_PENDING_POST_TEMPLATE_SID`), `docs/directory.md` (pending-post-notice package, veto module/route), `docs/runbooks/whatsapp-templates.md` (pending_post_notice template content + submission steps), `docs/superpowers/plans/2026-07-07-ws4-trust-dial-veto-window.md` (tick checkboxes; append an implementation-record section for any review-driven amendments)

- [ ] **Step 1: Docs sweep** per the table above. Grep for dangling references: `rg "pending_post_notice|veto" docs .claude/reference --files-with-matches` and make every mention consistent.
- [ ] **Step 2: Full gates locally:** `pnpm lint && pnpm typecheck && pnpm test` then EVERY `ci:*` script in package.json (`pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy && pnpm ci:db-imports` + any others listed) and `pnpm eval:llm` (offline). All green.
- [ ] **Step 3: Commit** (`docs(ws4): reference + runbook sweep for trust dial + veto window`).

---

## Verification & review protocol (execution session)

- Per-task TWO-STAGE review (WS1–WS3 protocol): (1) spec-compliance review against the spec section(s) the task implements; (2) ADVERSARIAL code-quality review — "do not trust the implementer's report; read the diff; spot-check the critical guards by mutating them mentally" (the veto atomicity kill, the guarded downgrade, the byte-for-byte ON CONFLICTs, the UTC day boundary, the lock order). Fix loops until approved.
- Final whole-branch integration review before the PR: cross-task seams (Task 4's `availableAt` ↔ Task 5's stamp ↔ Task 8's kill; Task 1's indexes ↔ Task 12's conflict targets; Task 2's types ↔ Tasks 3/12/13), `docs/directory.md` contract, allowlist hygiene.
- PR: `feat(trust-dial): WS4 — rating bands, daily caps, veto window, outcome instrumentation` against `main`; body maps spec §§ → tasks; all 13+ CI checks green before handing off.

## Spec-coverage self-check (writing-time)

| Spec § | Task(s) |
|---|---|
| 2.1 schema | 1, 12 |
| 2.2 rating bands | 1 (CHECK+raise), 2 (types), 3 (gate), 13 (UI) |
| 2.3 daily cap | 1 (index), 2 (default), 3 (gate+count), 12/13 (setting) |
| 2.4 suspension | 1 (columns), 2 (resolution), 3 (gate), 12 (readiness) + banner 13 |
| 2.5 delayed publish | 4 (availableAt), 5 (stamp+enqueue) |
| 2.6 veto cancel | 8 (module), 9 (route+page) |
| 2.7 notice | 4 (enqueue), 6 (channels), 7 (worker) |
| 2.8 outcomes | 1+8 (kind), 8 (veto emit), 10 (five chokepoints) |
| 2.9 spine gap | 11 |
| 2.10 settings UI | 12, 13 |
| 2.11 failure semantics | asserted across 3, 5, 7, 8 tests |
| 2.12 flags | 7 (send-time check), 14 (env-vars note) |
| §4 testing, §5 rollout | every task's steps; rollout is post-merge (user applies 074, staging observation per spec §5) |
