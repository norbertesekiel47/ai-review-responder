# WS4 — Trust dial + veto window — Design

**Status:** Accepted (brainstormed 2026-07-07 against the design of record; the nine open
design inputs from the WS3→WS4 handoff resolved below with evidence; four product calls
confirmed by Norbert — rating-band hard floor + restricted UI, veto window 15/30 default 15,
daily cap default 10 range 1–50, edit-publish spine gap closed here).
**Parent:** `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` (§3.3
trust dial, §5.1 guardrails, §4 launch-track item 3) and the Phase 1 decomposition table in
`docs/superpowers/plans/2026-07-01-agentic-platform-phase1-run-spine.md` (WS4 row).
**Depends on:** WS1 (shipped — run spine, outcome kinds in migration 071's CHECK).
**Feeds:** WS6 (judge/governor reads approve/edit/veto outcomes and writes the suspension
columns), WS8 (tier gates on policy editing), WS5 (timeline renders the new outcomes).

---

## 1. What WS4 ships

Autopilot's safety mechanics on top of the shipped auto-approval runtime — the 16 gates
plus WS2's two triage vetoes remain the untouched hard floor; WS4 only **extends** the
gate list and the policy schema (design §3.3: "never rewritten, only extended"):

- **Trust-dial policy (migration 074):** `auto_approval_policies` gains
  persona/action-class scoping (schema-ready for Solicitation v1.1; only Reply's posting
  policy is built), `veto_window_minutes` (15/30, default 15), `daily_auto_post_cap`
  (NULL = platform default 10), and governor-facing `suspended_at`/`suspended_reason`
  (WS6's write target, WS4 ships the gate).
- **Rating-band enforcement:** the positive-quadrant hard floor — ≤3★ (and unrated)
  reviews are never auto-approved regardless of policy; owner-selectable thresholds
  narrow to 4–5★/5★/Off. Closes WS2 §2.9's residual.
- **Veto window:** auto-approved replies publish after the policy's veto window via
  `job_outbox.available_at`; a `pending_post_notice` goes out on the owner's channels in
  the same transaction with an approval link whose page shows the scheduled post and a
  **Cancel auto-post** action; cancel atomically kills the pending publish and downgrades
  the response to owner review.
- **Daily auto-post cap:** per-location UTC-day cap enforced as a new evaluator gate;
  exhaustion downgrades to owner review, never queues for tomorrow.
- **Outcome instrumentation:** `reply_approved_no_edit` / `reply_edited_by_owner` emitted
  at every owner approve/edit chokepoint; new `reply_vetoed_by_owner` outcome kind
  (migration 074 CHECK swap). Agreement/edit/veto rates measurable from day one — the
  data that later justifies widening autonomy (design §3.3).
- **Edit-publish spine gap closed** (WS1 follow-up): the `EDIT_REPLIES_ENABLED` republish
  path now rides the mark-posted checkpoint, so its run reaches a terminal state.
- **Settings UI:** the existing `/settings/auto-approval` editor grows the veto-window
  and daily-cap controls and loses the sub-4★ threshold options.

**No LLM calls anywhere in WS4** — no cost-guard registry changes, no new `runLlmTask`
callers. **No new env flags** — everything rides `AUTO_APPROVAL_ENABLED` (off in prod
until the Autopilot go-live gate: WS4 + WS6 + WS7 + Zernio limits on record).

Explicitly **not** WS4: cadence jitter (deferred until Zernio volume/cadence limits are
on record — the veto window already provides delay; noted follow-up), the online judge +
governor thresholds (WS6 — WS4 only ships the suspension schema + gate), tier gating of
the policy editor (WS8), confidence routing (post-launch), a dashboard "scheduled posts"
surface (accepted boundary: during the veto window a review is absent from the pending
feed; WS5's timeline is the natural home), owner self-serve unsuspend (WS6 owns the
suspend/notify flow).

## 2. Resolved design decisions

### 2.1 Policy schema — extend `auto_approval_policies` (migration 074), not a new table

The table keeps its migration-055 shape (account-default row `location_id IS NULL`,
per-location override rows) and gains:

| Column | Type / constraint |
|---|---|
| `persona` | TEXT NOT NULL DEFAULT 'reply' CHECK (`persona IN ('reply')`) |
| `action_class` | TEXT NOT NULL DEFAULT 'posting' CHECK (`action_class IN ('posting')`) |
| `veto_window_minutes` | SMALLINT NOT NULL DEFAULT 15 CHECK (`IN (15, 30)`) |
| `daily_auto_post_cap` | SMALLINT NULL CHECK (`BETWEEN 1 AND 50`) — NULL = platform default (10) |
| `suspended_at` | TIMESTAMPTZ NULL — governor/admin write target (WS6) |
| `suspended_reason` | TEXT NULL |

- **Persona/action-class CHECKs are deliberately single-valued now.** Design §3.3 wants
  the SCHEMA scoped so Solicitation's sends slot in at v1.1 without redesign — widening a
  CHECK in Solicitation's own migration is not redesign. Narrowest-now wins.
- **Both partial unique indexes are rebuilt** to include the new scope columns:
  `auto_approval_policies_one_account_default` → `(account_id, persona, action_class)
  WHERE location_id IS NULL`; `auto_approval_policies_one_location_override` →
  `(account_id, location_id, persona, action_class) WHERE location_id IS NOT NULL`.
  Every `ON CONFLICT` writer in `src/lib/auto-approval/settings.ts` is updated to match
  **byte-for-byte** (documented Postgres gotcha).
- **`auto_approve_min_star` CHECK tightens from 1..5 to 4..5**, preceded by a data
  UPDATE raising existing sub-4 rows to 4 (product unlaunched — user-confirmed; no
  grandfathering machinery). Post-launch trust-widening below 4★ is a deliberate future
  migration, per design §3.3's earned-trust posture.
- All reads/writes stay server-owned (invariant #14, `ci:static-policy` enforced); no
  `NEXT_PUBLIC_*` companion (invariant #13). Loaders
  (`loadAutoApprovalRuntimeState`'s SELECT in
  `worker/jobs/response-generation/auto-approval.ts` and `settings.ts`) filter
  `persona = 'reply' AND action_class = 'posting'`.

Migration 074 also carries (details in the sections that own them): the
`agent_outcomes` CHECK swap adding `reply_vetoed_by_owner` (§2.8),
`responses.auto_post_scheduled_at` (§2.5), the cap-counting partial index (§2.3), and
the `pending_post_notice` outbox/claim indexes (§2.7). **No new table** → no
tenant-table/offboarding checklist churn; the new columns ride their tables' existing
RLS/offboarding posture. Re-runnable throughout (`ADD COLUMN IF NOT EXISTS`,
`DROP CONSTRAINT IF EXISTS` before ADD, `DROP INDEX IF EXISTS` before CREATE for the
index rebuilds — 069/072/073 precedents). Read `.claude/reference/migrations-log.md`
before writing (**next is 074**); log entry + head bump in the same PR.

### 2.2 Rating bands — hard floor in the evaluator, threshold narrowed at every layer

Enforcement point is `evaluateAutoApprovalCandidate`'s `compactBlockReasons` array
(`auto-approval.ts:205-221`) — the same place as the 16 gates and WS2's vetoes:

- **New gate `rating_below_positive_quadrant`:** blocks when `currentStarRating !== null
  && currentStarRating <= 3`. Unrated stays blocked by the existing
  `current_rating_missing`. This gate is ABOVE the dial — it fires regardless of what
  the policy row says (defense in depth against a stale/buggy policy row), exactly like
  the triage and moderation vetoes.
- **Threshold semantics unchanged** (`starMeetsThreshold`, policy row is the source —
  invariant #9a analog: stored policy, never TIER_CONFIG), but the domain narrows:
  `AutoApprovalThreshold` becomes `4 | 5`, the PATCH schema rejects 1–3, the UI offers
  Off / 5★ only / 4–5★ (§2.10), and the DB CHECK enforces 4..5 (§2.1). The
  `all_ratings` confirmation level and its modal copy die with the 1★ option
  (`standard` confirmation for expansions stays).
- Triage vetoes (`triage_high_severity`, `triage_fallback`) and moderation vetoes are
  untouched and remain above the dial.

### 2.3 Daily cap — per-location, UTC-day, evaluator gate, strict under lock

- **Accounting unit: per location** (design §4 item 3 — caps are anti-pattern-detection
  insurance for a *profile*), stored on the effective policy row
  (`daily_auto_post_cap`, location override shadows account default like the threshold);
  NULL resolves to `DEFAULT_DAILY_AUTO_POST_CAP = 10` (TS constant in
  `src/lib/auto-approval/policy.ts`).
- **Counting predicate:** `responses WHERE business_id = $ AND approval_method =
  'auto_policy' AND approved_at >= <current UTC day start>` — auto-approvals *granted*
  today, not posts landed today, so vetoed/downgraded rows still consume their slot
  (conservative; fails toward the owner) and a burst can't approve 50 to trickle out
  later. Computed in `loadAutoApprovalRuntimeState` inside the persist tx; new
  `daily_cap_exhausted` block reason when `count >= cap`.
- **Strictness:** the persist tx takes the `businesses` row `FOR UPDATE` after its
  review lock, then counts — serializing concurrent evaluations per location. This
  extends the binding lock-order rule to **reviews → businesses → child rows →
  agent_runs**; the plan includes a verification task that no existing tx locks
  businesses before reviews (if one exists, fall back to lock-free counting and accept a
  ±concurrency overshoot — the cap is a governor, not a security boundary — and document
  it).
- **Index support (074):** partial index on `responses (business_id, approved_at) WHERE
  approval_method = 'auto_policy'`. A plain range predicate — deliberately NOT a
  per-day expression index, sidestepping the IMMUTABLE-expression gotcha entirely.
- **Cap exhaustion ⇒ the candidate is simply not auto-approved** — it falls into the
  existing held-for-owner path (notification, normal approval lane). Never
  queue-for-tomorrow.

### 2.4 Suspension — schema + gate now, writer in WS6

`suspended_at`/`suspended_reason` on policy rows complete design §3.3's per-account kill
switch story (the owner-facing "Off" already exists as `threshold = NULL`; suspension is
the *system's* kill switch — design §5.1's governor "flips the account's dial"). WS4
ships: the columns, a `policy_suspended` block reason when the account-default row OR
the effective row carries `suspended_at IS NOT NULL`, and a read-only suspended banner
in settings (reason shown, expansion blocked). WS6 ships the writer + owner
notification + recovery flow. Nothing writes these columns in WS4 — the gate is inert
until WS6, mirroring how WS2 shipped triage columns ahead of WS3's consumer.

### 2.5 Veto window — delayed publish via `job_outbox.available_at`

**Mechanism (design input #1, resolved):** the outbox already has
`available_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` and `OutboxPoller`'s claim CTE already
gates on `available_at <= NOW()` (`worker/background/pollers/OutboxPoller.ts:164-176`);
`AnalyticsDispatchPoller` is the in-repo delayed-`available_at` precedent. A BullMQ
delayed job would bypass the outbox (invariant #2); a bespoke `scheduled_post_at` poller
would duplicate machinery the outbox already owns. So:

- `enqueuePublishResponse` (`src/lib/shared/job-outbox-helpers.ts`) gains an optional
  `availableAt` input, INSERTing the column when present (default behavior unchanged for
  every other caller — owner approvals keep publishing immediately).
- In `persist.ts`'s auto-approve branch (the single auto-policy enqueue site), the
  publish enqueue becomes `availableAt = NOW() + veto_window_minutes` from the effective
  policy, and the same UPDATE stamps **`responses.auto_post_scheduled_at`** (new
  nullable column, 074) — the single source of truth for the deadline, read by the
  notice copy, the approve page, and the cancel guard. The `pending_post_notice`
  enqueue (§2.7) rides the SAME transaction (outbox pattern, invariant #2).
- The watchdog needs no change: its 1h stale-`dispatched` arm only touches claimed rows,
  and a vetoed row is terminal before or at claim time (§2.6).
- The publisher's existing post-time re-validation seam is untouched and remains the
  backstop: `ZERNIO_PUBLISHABLE_STATES` gate + the `AUTO_APPROVAL_ENABLED` kill-switch
  downgrade (`ResponsePublisherWorker.ts:67-90`) both run when the delayed row finally
  fires. A row that was vetoed (now `pending_approval`) or kill-switched completes as a
  no-op. The flag-off downgrade path therefore also covers responses caught mid-window
  by a kill-switch flip — they downgrade instead of posting, per invariant #3.

### 2.6 Veto cancel — atomic kill-or-too-late, downgrade precedent, approval-link surface

**Token/surface (design input #3, resolved):** reuse the **existing approval-link
machinery end-to-end** rather than a bespoke veto token table — `approval_links` already
owns SHA-256-hashed single-purpose tokens, TTL, device binding, rate limits, revocation,
and audit (`approval-security` skill governs; invariant #5 holds: raw token only in the
message). The `pending_post_notice` dispatch creates a standard approval link per
delivery (same `create-link` helper the approval dispatcher uses). The approve page
(`/approve/[token]`) learns one new state: a response in `status='approved'` +
`approval_method='auto_policy'` + `auto_post_scheduled_at` in the future renders
"Scheduled to post at HH:MM" with a **Cancel auto-post** button (POST
`/api/approve/[token]/veto`, same-origin + session-bound like the sibling actions).
The veto consumes its link like every other token action (single-use precedent); fresh
approval links arrive with the re-notify (step 5 below) — zero new token machinery. A dashboard veto route is NOT built in v1
(during the window the review is absent from the pending feed — accepted boundary,
§1); the notification link is the cancel surface, per design §3.3.

**Cancel semantics (design input #4, resolved): downgrade, never delete — and the
outbox row is the atomicity token.** One transaction:

1. `UPDATE job_outbox SET status='completed', completed_at=NOW(),
   last_error='vetoed_by_owner' WHERE topic='publish_response' AND aggregate_id=<responseId>
   AND status='pending'` — claims the not-yet-dispatched publish. The poller's
   `FOR UPDATE SKIP LOCKED` claim and this guarded UPDATE serialize cleanly: whoever
   locks first wins; **0 rows updated ⇒ too late** (already dispatching/dispatched/
   completed) → the tx rolls back and the route returns an "already posting/posted"
   outcome. No new outbox status, no poller change. (Completing the row also releases
   `idx_jo_publish_response_inflight`, so a later owner approval enqueues a fresh
   publish normally.)
2. Guarded response downgrade, kill-switch precedent
   (`worker/jobs/publisher/auto-policy-downgrade.ts` shape): `status='pending_approval'`,
   `approval_method=NULL`, `auto_post_scheduled_at=NULL`, `posting_error=
   'auto_post_vetoed_by_owner'`, guarded `WHERE status='approved' AND
   approval_method='auto_policy'`.
3. Audit log (`approval_audit_log`, action `'veto_cancel'`, token auth method) — same-tx
   like every approval action.
4. `recordOutcome('reply_vetoed_by_owner', attributedAgent: 'reply')` when
   `findActiveReviewRun` finds a running run (legacy posture: no run → skip; the run is
   still `running` because nothing posted). No new step key — outcomes carry the
   veto-rate signal (§2.8).
5. `enqueueSendNotification` — kill-switch-downgrade parity: the owner gets the normal
   approval request with fresh links, so the draft is actionable from their channel, not
   just the confirmation page.

Repeat-veto (double-tap) is idempotent-safe: the second request finds no pending outbox
row AND a non-matching response state → clean "already cancelled" response mapped from
the same guarded no-op, not an error. The transition logic lives in a domain module
(`src/lib/approval/veto.ts`, taking `tx` per invariant #15); the route stays
parse → module call → return (invariant #12).

**Deadline race, closed:** cancel succeeds **iff** it kills the pending outbox row, so
publisher-vs-veto is decided by a single row lock — there is no window where the reply
posts to Google after a "cancelled" confirmation. The residual TOCTOU (cancel lands
after the publisher claimed but before Zernio POSTs) resolves as "too late" at step 1,
truthfully.

### 2.7 `pending_post_notice` — third topic-clone sibling

Clone of the `auto_post_notice`/`escalation_notice` pattern (the WS3 plan's touchpoint
checklist transfers directly):

- `src/lib/shared/queue-names.ts` — `PENDING_POST_NOTICE: 'pending_post_notice'`;
  `worker/queues.ts` queue + `topicToQueue`; `worker/index.ts` registration.
- `src/lib/shared/worker-types.ts` — `PendingPostNoticePayload { response_id,
  business_id, correlation_id? }` (snake_case, **ids only** — the deadline is read from
  `responses.auto_post_scheduled_at`, never duplicated into the payload).
- `src/lib/shared/job-outbox-helpers.ts` — `enqueuePendingPostNotice(tx, …)` with
  in-flight `ON CONFLICT` backed by a new 074 partial unique index
  `idx_jo_pending_post_notice_inflight` (byte-for-byte, `aggregate_type='response'` +
  `aggregate_id=response_id` — the notice is about a response, matching
  `auto_post_notice`'s keying).
- New package `worker/jobs/pending-post-notice/` (worker, context loader, dispatch,
  errors) cloned from `worker/jobs/auto-post-notice/`, including the **bounced-owner
  email skip from day one** (the WS3 parity fix — known follow-up #3a does not grow a
  third instance). Reuses `getEligibleChannels` (subscription guard invariant #11 +
  account-scoped enrollment lookup for free).
- **Context-loader freshness guards:** skip-without-sending when the response is no
  longer `approved`/`auto_policy` (vetoed or kill-switched meanwhile), when
  `auto_post_scheduled_at` has already passed (stale outbox backlog — a notice that
  can't be acted on is noise), or when `AUTO_APPROVAL_ENABLED` is off (kill-switch
  semantics at send time, WS3 §2.4 precedent).
- `src/lib/notifications/channels/types.ts` — fourth purpose-built method
  `sendPendingPostNotice(params)` (ADR 0003: no generic `sendText`) + three channel
  implementations + email template. Copy: business/location, star rating, reviewer
  display name, truncated review + truncated draft (established truncation helpers),
  "posting automatically at ~HH:MM", one link → the approve page (view/edit/cancel).
  Review context lives ONLY in the private message; payloads/steps/logs stay ids-only.
- **WhatsApp is business-initiated ⇒ approved template required**
  (`docs/runbooks/whatsapp-templates.md` owns content + submission; the channel fails
  closed-and-logged until the template SID lands — escalation-notice precedent).
- `src/lib/notifications/delivery.ts` — `claimPendingPostNoticeDelivery` backed by a 074
  partial unique claim index on `(response_id, channel, recipient) WHERE response_id IS
  NOT NULL AND template = 'pending_post_notice'` (067 shape), claim-before-send.
- `worker/ingress/resend.ts` — `'pending_post_notice'` joins `OWNER_DIRECTED_TEMPLATES`.
- Per-channel failure semantics identical to auto-post-notice: one channel's failure
  never poisons the others; transient → BullMQ 3× + backoff + 1h outbox watchdog; claims
  prevent double-send. **Notice delivery failure never blocks the publish** — the two
  outbox rows are independent; if every channel fails, the reply still posts at the
  deadline (Autopilot is the owner's configured intent; the notice is best-effort
  transparency, and the post-hoc `auto_post_notice` FYI still fires after publish).

### 2.8 Outcome instrumentation — five chokepoints + one new kind

**Sites (design input #8, resolved):** the approve/edit decision is byte-identical and
structurally decidable in exactly five sibling functions — `approveBySession` /
`editBySession` (`src/lib/approval/session-mode.ts`), token `approve` / `edit`
(`token-mode.ts`), `approveViaCallback` (`callback-mode.ts`; button lanes cannot edit).
Each already runs inside a tx; each gains `findActiveReviewRun(tx, reviewId)` +
`recordOutcome`:

- `reply_approved_no_edit` — the three approve variants (`approved_text =
  response_text`, no edit columns).
- `reply_edited_by_owner` — the two edit variants. No detail payload — `recordOutcome`
  carries none by design, and the edit distance already has one authoritative owner
  (`responses.edit_distance`). Edit IS approve in this codebase (one action), so there is no
  approve-after-edit ambiguity; a run that sees an edited v1 then an approved-unedited
  v2 legitimately records both kinds (per-(run,kind) dedup, accepted + documented —
  WS6's edit-rate reads "edited outcome present on run").
- Both kinds are **already in migration 071's CHECK and `AGENT_OUTCOME_KINDS`** — no
  migration needed for them. Legacy/no-run reviews skip (established posture);
  the past-replies `/publish` route is deliberately NOT instrumented (its subject run
  completed at the original post; `findActiveReviewRun` is null by definition).
- **New kind `reply_vetoed_by_owner`** (§2.6): appended to `AGENT_OUTCOME_KINDS` +
  074's `agent_outcomes` CHECK swap (`DROP CONSTRAINT IF EXISTS` + ADD, 069 precedent).
  Attributed `reply` persona like its siblings.
- Outcome writes are DURABLE facts and stay **in-tx** (the WS3 `transitions.ts` posture
  asymmetry: in-tx for unrecoverable-if-lost facts, best-effort only for observability).

### 2.9 Edit-publish spine gap — closed here (user-confirmed)

`worker/jobs/publisher/edit-publish.ts:320-338` flips a response to `posted` with zero
spine writes, so the run stays `running` forever (WS1 follow-up). Fix: route that
success flip through `markPostedAndMaybeEnqueueAutoPostNotice`
(`worker/jobs/publisher/mark-posted.ts` — the only `completeRun` caller, owning the
`reply_posted` step + outcome + the auto-policy FYI branch). The edit-publish tx already
takes the review row `FOR UPDATE` first (L192), satisfying the lock-ordering contract;
the sibling-supersede stays where it is. The edit lane is owner-approved, so the FYI
branch stays naturally silent (`approval_method='owner'`). Plan verifies the guarded
UPDATE shapes stay equivalent (both key on `AWAITING_PUBLISH_STATUSES`).

### 2.10 Settings UI — same page, narrower dial, two new controls

`/settings/auto-approval` (server component + `AutoApprovalClient`) keeps its structure
(account default + per-location override rows, readiness gating, expansion
confirmation), with:

- Threshold options reduced to **Off / 5★ only / 4–5★** (remove 3–5, 2–5, All rated and
  the `all_ratings` confirmation level; `standard` confirmation for expansions stays).
- **Veto window** selector (15 / 30 minutes) and **daily cap** input (1–50, blank =
  "default (10)") on the account default and per-location rows, same
  inherit/override semantics as the threshold.
- Suspended banner (§2.4) when `suspended_at` is set: read-only reason, expansions
  blocked via a new `policy_suspended` readiness block reason.
- Server route (`/api/settings/auto-approval`) PATCH contract grows matching operations;
  validation in `settings.ts` (zod), all writes through the existing
  `updatePolicyInTransaction` audit path. Invariants #13/#14 hold (server-owned, no
  client table access, no `NEXT_PUBLic_*`).
- Styling per the `repworth-brand-design` skill.

The existing **stored-policy read discipline** stands: the evaluator reads the policy
row snapshot loaded in the persist tx — a mid-window policy change does not retroactively
re-gate an already-approved response (its veto window and the publisher's state checks
still govern it).

### 2.11 Failure semantics — everything fails toward "ask the owner"

| Failure | Behavior |
|---|---|
| Evaluator gate failure (band, cap, suspension, any of the 18 existing) | Not auto-approved → existing held-for-owner path (notification, approval lane). Never queued for later. |
| Cancel-vs-publish race | Decided by the pending outbox row's lock (§2.6): veto succeeds iff it terminalizes the row; otherwise truthful "too late". No state where Google has the reply and the owner saw "cancelled". |
| Veto route failure mid-tx | Whole tx rolls back (outbox row stays pending, response stays approved) — publish proceeds at the deadline; owner can retry cancel until then. |
| Notice delivery failure (one/all channels) | Per-channel isolation; claims prevent double-send; publish unaffected (§2.7); post-hoc FYI still fires. |
| Notice job fires late (post-deadline) or state changed | Context loader completes without sending (§2.7). |
| `AUTO_APPROVAL_ENABLED` flipped off mid-window | Publisher's existing kill-switch downgrade catches the row at fire time → owner review (invariant #3). Notice worker also skips at send time. |
| Outcome write failure at approve/edit/veto | In-tx → the owner action fails visibly and retries; durable facts are never silently lost (§2.8). |
| Cap-count lock contention | Serialized per location inside the persist tx; generation jobs already retry transiently. Fallback posture if lock-order audit fails: lock-free count + accepted overshoot (§2.3). |

### 2.12 Flags & dependency

No new flags. `AUTO_APPROVAL_ENABLED` (server-only, default off; prod stays off until
the Autopilot go-live gate) gates the entire lane: evaluation, delayed enqueue, notice
send (send-time re-check), and the publisher's downgrade backstop. `env-vars.md` gains
only a note that the flag now also governs the veto-window lane.

## 3. Components & file map

| Unit | Responsibility |
|---|---|
| `supabase/migrations/074_trust_dial_veto_window.sql` (create) | §2.1 policy columns + CHECK tighten + data raise + index rebuilds; `responses.auto_post_scheduled_at`; cap-count partial index; `agent_outcomes` CHECK swap; `pending_post_notice` in-flight + claim indexes |
| `src/lib/auto-approval/policy.ts` / `types.ts` (modify) | Threshold domain 4\|5; effective-policy carries veto window/cap/suspension; `DEFAULT_DAILY_AUTO_POST_CAP` |
| `src/lib/auto-approval/settings.ts` (modify) | New columns in SELECT/upsert (byte-for-byte ON CONFLICT), PATCH ops + validation, suspended readiness reason |
| `worker/jobs/response-generation/auto-approval.ts` (modify) | Runtime-state loads (cap count under business lock, suspension); gates `rating_below_positive_quadrant`, `daily_cap_exhausted`, `policy_suspended` |
| `worker/jobs/response-generation/persist.ts` (modify) | Auto-approve branch: stamp `auto_post_scheduled_at`, delayed `enqueuePublishResponse`, `enqueuePendingPostNotice` — same tx |
| `src/lib/shared/job-outbox-helpers.ts` (modify) | `availableAt` on `enqueuePublishResponse`; `enqueuePendingPostNotice` |
| `src/lib/shared/{queue-names,worker-types}.ts`, `worker/{queues,index}.ts` (modify) | Topic/queue/payload/registration |
| `worker/jobs/pending-post-notice/` (create) | Notice worker package — auto-post-notice clone + freshness guards + bounced-owner skip |
| `src/lib/notifications/channels/*` + `email.ts` (modify) | `sendPendingPostNotice` + 3 impls + template |
| `src/lib/notifications/delivery.ts` (modify) | `claimPendingPostNoticeDelivery` |
| `worker/ingress/resend.ts` (modify) | `OWNER_DIRECTED_TEMPLATES` + `pending_post_notice` |
| `src/lib/approval/veto.ts` (create) | §2.6 cancel transition (outbox claim → downgrade → audit → outcome → re-notify), takes `tx` |
| `src/app/api/approve/[token]/veto/route.ts` (create) | Composition root: parse → `runTokenApprovalAction`-style wrapper → veto module |
| Approve page + components (modify) | Scheduled-post state + Cancel action (brand-design skill) |
| `src/lib/approval/{session,token,callback}-mode.ts` (modify) | §2.8 outcome emission at the five chokepoints |
| `src/lib/agents/run-spine.ts` (modify) | `AGENT_OUTCOME_KINDS` + `reply_vetoed_by_owner` |
| `worker/jobs/publisher/edit-publish.ts` (modify) | §2.9 success flip through `markPostedAndMaybeEnqueueAutoPostNotice` |
| `/settings/auto-approval` page + client + route (modify) | §2.10 |
| Registries/docs (modify) | tenant-scope allowlist entries + baseline for new SQL touchpoints; `migrations-log.md` 074; `env-vars.md` note; `docs/directory.md` (new worker package + veto module); `whatsapp-templates.md` (new template) |

## 4. Testing strategy

- **Unit (TDD per task):** gate matrix (band × threshold × cap × suspension × existing
  vetoes); cap accounting edges (UTC day boundary, NULL→default, override shadowing,
  vetoed rows consume slots); veto transition (pending-row win, too-late, double-tap
  idempotency, guarded-downgrade no-ops); outcome emission per lane incl. no-run skip
  and per-(run,kind) dedup; notice worker (claim, freshness guards, flag-off, zero
  channels, bounced skip, per-channel failure isolation); `enqueuePublishResponse`
  `availableAt` pass-through + unchanged default; settings PATCH validation (reject 1–3
  thresholds, cap bounds, window domain); persona-map totality untouched. Mocked-`sql`
  via `createMockSql` (vi.hoisted recipe; reset defaults in beforeEach).
- **Integration (`describeWithDb`):** migration 074 shape + double-apply no-op; delayed
  outbox row invisible to the claim CTE until `available_at`; veto tx vs a concurrent
  claim (SKIP LOCKED serialization observed); cap under concurrent persist txs
  (business-lock serialization); edit-publish now yields `completeRun` + `reply_posted`;
  ON CONFLICT writers match rebuilt indexes byte-for-byte.
- **Gates:** `pnpm lint && pnpm typecheck && pnpm test`, every `ci:*` audit
  (tenant-scope + rls-audit mandatory — DB-touching), `pnpm eval:llm` offline
  (regression guard only; no prompt changes). Brittle-allowlist rule: any
  `static-policy`/`tenant-scope` allowlist churn lands in the SAME commit as the change
  that shifted it. Fallow gate: prefer extraction over pragmas for the notice-package
  clone family.

## 5. Rollout

1. Migration 074 **staging first**, then production, both Supabase projects in lockstep
   (user applies; verify via schema introspection, not the migration ledger).
2. WhatsApp `pending_post_notice` template submitted per
   `docs/runbooks/whatsapp-templates.md` (email + Telegram not gated on it).
3. Staging already runs `AUTO_APPROVAL_ENABLED=true`: observe one full Autopilot loop —
   4–5★ ingest → auto-approve → `pending_post_notice` delivered → (a) let one post at
   the deadline (verify `reply_auto_posted` + FYI), (b) veto another from the link
   (verify outbox row completed-as-vetoed, downgrade, `reply_vetoed_by_owner`, re-notify,
   then owner-approve it), (c) confirm a 3★ triaged review is band-blocked, (d) drive a
   location to its cap and confirm downgrade-to-owner.
4. Prod: nothing to flip — `AUTO_APPROVAL_ENABLED` stays off until the Autopilot
   go-live gate (WS4 + WS6 + WS7 + Zernio limits on record, decomposition table).

## 6. Implementation amendments (2026-07-09, review-driven)

Where per-task reviews tightened the spec during implementation (full record:
the plan's "Implementation record" section). The original sections above are
unchanged; on any conflict, these amendments win.

- **§2.3 counting source:** the daily-cap count reads `approval_audit_log`
  rows (`action='auto_approved_by_policy'`, `created_at >=` UTC day start,
  same-tx as the grant), NOT `responses.approval_method/approved_at` — the
  veto downgrade NULLs those columns, so a responses-based count refunded the
  slot on every veto, inverting the §2.3 fail-toward-owner posture. Audit rows
  are durable and never mutated, so vetoed grants keep consuming their slot;
  the read is served by `idx_aal_business` (002) and 074's responses-side
  partial cap index was dropped as reader-less.
- **§2.6:** ONE marker constant for both veto writes —
  `AUTO_POST_VETOED_BY_OWNER = 'auto_post_vetoed_by_owner'` (`veto.ts`) is
  written to the outbox row's `last_error` AND `responses.posting_error`. The
  spec's step-1 `last_error='vetoed_by_owner'` value was collapsed into the
  step-2 constant so the marker has a single owner.
- **§2.3 lock-order law, extended:** the binding rule is now **reviews FIRST**
  in every approval-lane tx that records an outcome, because `recordOutcome`'s
  INSERT takes an implicit FK `FOR KEY SHARE` on `agent_runs` — implicit FK
  locks count toward the ordering. Three review-caught deadlocks enforce it:
  (1) persist.ts's daily-cap `businesses FOR UPDATE` hoisted ABOVE the
  responses INSERT (share→exclusive upgrade over the INSERT's implicit FK
  lock, reproduced 40P01); (2) veto.ts re-anchored reviews-first (locking its
  response row first closed a cycle against mark-posted/persist); (3) the
  dashboard action wrapper gained `anchorReviewLockOrder` (`outcomes.ts`) as
  its tx's first statement, guarded by an anchor-pairing tripwire test.
- **§2.6/§2.8:** `handleApprovalError` maps a 40P01 deadlock-loser rollback to
  a retryable `409 conflict_retry` — the veto ↔ mark-posted collision is an
  expected concurrency outcome whose losing side retries cleanly; it is
  neither `too_late` nor a 500.
- **§2.7:** the notice worker's subscription guard sits at the WORKER level
  (invariant #11 precedent), not inside the channel senders; the context
  loader owns response-state and deadline freshness (deadline staleness
  compared IN SQL against the same DB clock that stamped it).
- **§2.6/§2.9:** `markPostedAndMaybeEnqueueAutoPostNotice` revokes ALL open
  approval links for the response at post time (`revokeOpenLinksForResponse`)
  — no actionable-looking link survives a posted or vetoed terminal state
  (the veto consumes its own link per §2.6; fresh links arrive with the
  re-notify).
- **§2.9 scope widened:** beyond the edit-publish success flip, the 409
  `matches_our_text` recovery path ALSO routes through the mark-posted
  checkpoint (same spine writes + link revocation), inside edit-publish's
  Phase B tx with the reviews + response locks already held.
- **§2.10:** a veto-window/cap PATCH on a scope with NO policy row creates the
  row with a NULL threshold — the scope stays on manual approval, and a
  location override so created shadows the account default (a contraction,
  never an implied expansion). The UI fronts that case with the
  `location_dial` confirmation interstitial before the override row is
  created.
- **§2.4 scoping:** GET readiness `blockReasons` surfaces `policy_suspended`
  for the ACCOUNT-DEFAULT row only; a location-override suspension surfaces
  per-location via `locations[].effective` — account-level readiness never
  hides behind one suspended location.
- **§2.2:** the retired `all_ratings` confirmation level carries a ONE-RELEASE
  stale-client tolerance in the PATCH schema for in-flight clients; remove it
  next release.


- **§2.11 publisher notice-delivery gate:** at the publish deadline,
  `ResponsePublisherWorker` posts an `auto_policy` row only if at least one
  DELIVERED `pending_post_notice` exists (`sent_at` set) for the response;
  zero delivered notices downgrades to owner review via the generalized
  downgrade helper — new audit action / `posting_error` marker
  `auto_post_notice_undelivered`, metadata
  `downgrade_reason: 'notice_undelivered'`. An unnotified auto-post fails
  toward the owner: the veto window is only real if the owner could see it.
  The gate runs BEFORE any external call, so a racing notice-send between the
  check and the post is benign.
- **§2.7 all-skipped notices alert:** the notice worker's systemic-failure
  signal fires whenever `sent === 0` and at least one channel was attempted
  (skips count, not just failures), at warn level; the outbox entry still
  completes — the publisher gate owns enforcement, the signal is
  observability.
- **§2.7 claim self-reap:** `claimPendingPostNoticeDelivery` deletes stale
  unfinalized claims for the same (response, channel, recipient) —
  `sent_at IS NULL AND failed_at IS NULL AND created_at` older than
  15 minutes — before claiming, so a crashed dispatcher cannot dedup-block
  the veto-critical notice forever (narrows known follow-up #3b for this
  template).
- **§2.3/§5 structural short-circuit + both-direction apply window:**
  `persist.ts` decides structural candidacy (runtime flag, origin lane,
  version, suppression) from env + job inputs before the tx body; structural
  non-candidates skip the businesses `FOR UPDATE` (no FK share→exclusive
  hazard without the later cap count) AND `loadAutoApprovalRuntimeState`
  (a flag-off deploy reads no 074 columns), taking their blocked decision
  from `structurallyBlockedDecision`. Migration 074's apply window is
  therefore two-directional: 074-before-code breaks only settings upserts;
  code-before-074 is safe only while the flag is off — staging runs the flag
  ON, so apply 074 to staging before deploying.
- **§2.6 delivered notice links recognized in orphan checks:**
  `createApprovalLink`'s `orphaned_only` delivered-check matches
  `template IN ('approval_request', 'pending_post_notice')` — a link the
  owner received via the veto notice is not an orphan, so the veto's
  re-notify no longer revokes it (clicking the still-live notice CTA would
  otherwise 410 against §2.6's already_cancelled invariant).
- **§2.4/§2.10 suspension survives policy clears (2026-07-11, external
  review):** `clear_account_default` and `delete_location_override` never
  DELETE a row carrying governor-owned `suspended_at` — deletion laundered
  the suspension (clearing is a contraction, allowed while suspended, and a
  re-created row read suspended=false, re-arming auto-posting past a system
  suspension). A clear on a suspended row degrades to a threshold-NULL
  UPDATE: the scope returns to manual approval while `suspended_at`/
  `suspended_reason` and the dial columns survive, so a follow-up expansion
  stays blocked with `policy_suspended`. Unsuspended rows keep DELETE
  semantics; the audit payload records which shape ran via
  `clearedVia: 'delete' | 'threshold_null_suspended'`.
- **§2.10 implicit override rows seed the account dials (2026-07-11,
  external review):** any op that CREATES a location override row (dial ops
  on a rowless location, and the threshold ops) seeds the non-target dial
  columns from the account default's STORED values instead of schema
  defaults — a cap-2/window-30 account no longer silently becomes cap-10/
  window-15 at that location because one dial was touched. The INSERT arm of
  every settings upsert persists the full seed (`freshRowSeed`); DO UPDATE
  arms stay single-column, ON CONFLICT targets and `resolveEffectivePolicy`
  are unchanged; with no account default, schema defaults stand. The
  threshold is never seeded: a fresh row still starts on manual approval.
- **§2.10 cap-input commit semantics (2026-07-11, external review):** a blur
  with `validity.badInput` (unparsable number-input text reads as `''`)
  discards the draft via the capDraftEpoch remount and never PATCHes — only
  a genuinely emptied field submits the deliberate `cap: null` clear. The
  location cap field's commit baseline is the OVERRIDE's stored value (null
  while rowless), not the effective inherited cap, so typing the inherited
  number onto a rowless location now creates the pin (through the
  `location_dial` interstitial, seeded per the amendment above); the display
  keeps showing the effective cap via the placeholder.
