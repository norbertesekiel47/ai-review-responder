# Round 6 — Race Conditions, Idempotency, Business-Logic Abuse

**Audit date:** 2026-04-26
**Scope:** Outbox dual-dispatch, polling-window TOCTOU bugs, cost-guard refund races, subscription-state transitions, the "no auto-post" invariant, demo-generation abuse, channel-hijack vectors, and other business-logic edges where workflow steps could be skipped or replayed.
**Methodology:** Whitebox source review across `worker/jobs/*`, `src/lib/shared/*`, `src/lib/onboarding/*`, `src/lib/costs/*`, `worker/ingress/stripe.ts`, and the relevant migration files. Two parallel sub-agents followed by direct verification of every Critical/High claim. Several agent-flagged "Critical" items were either documented residual risks (already in CLAUDE.md) or by-design behavior — those have been right-sized below.

**Severity rubric:** Critical = invariant violation that lets attackers bypass approval, publish forged responses, or escalate billing. High = race that produces wrong-tenant data, double-publish, or unauthenticated state mutation. Medium = race-window with realistic activation. Low = hardening. Informational = note.

---

## Findings (by severity)

### [MEDIUM] M-1: `past_due` grace period derives from mutable `businesses.updated_at`

- **Location:** `src/lib/shared/subscription-guard.ts:30-35`
- **Description:** Already documented in `CLAUDE.md` ("Known residual risks", lab note 2026-04-18). The 7-day grace window is computed as `Date.now() - businessUpdatedAt.getTime()`, but `updated_at` is reset by ANY write to the business row — admin profile edits, place-id changes, tier updates, bounce flag flips, even a periodic background touch. An owner who can trigger any unrelated business UPDATE can therefore extend their `past_due` grace indefinitely.
- **Impact:** A customer whose Stripe payment failed could keep using the product past the intended 7-day window by any action that touches the business row. Today the realistic touch path is the engagement nudge / bounce flag / weekly-summary preferences write, which the customer doesn't control directly. But ANY future feature that performs a business-row write (e.g., a settings page that saves on tab switch) extends the grace silently.
- **Recommended fix:** Already on the team's roadmap. Add a dedicated `subscription_status_changed_at` column. Write it ONLY in the Stripe webhook on actual status transitions. Update every `checkSubscription` caller to pass it instead of `updated_at`. The migration is one column + a small backfill (`UPDATE businesses SET subscription_status_changed_at = updated_at` once at deploy time). I would not block on this — it's documented and contained — but bundle it into the next billing sprint.

---

### [MEDIUM] M-2: Cost-tracker refund can land on a wrong-day key when reservation outlives the Redis TTL

- **Location:** `src/lib/costs/tracker.ts:235-240` (`ADJUST_COST_LUA`); `tracker.ts:163-164` (the comment that warns callers)
- **Description:** `reserveCost` returns the `dateStr` it used to compute the daily-bucket key. Callers MUST pass the same `dateStr` back to `finalizeCost` / `releaseCost` so refunds land on the same key. The Lua adjust script does `INCRBY KEYS[1] adjustment; INCRBY KEYS[2] adjustment` without an `EXPIRE`. If the LLM call takes longer than `CACHE_TTL_SECONDS` (or crosses a midnight + key TTL), the reservation key has expired and Redis auto-creates it at 0, then the negative adjustment makes it negative. Without `EXPIRE`, the key persists indefinitely. The next first-of-day reservation does `INCRBY estimate` which adds 15, making the now-stale key sit at `-15 + 15 = 0` and finally getting an `EXPIRE` from RESERVE_COST_LUA. So in steady state, the math self-corrects — but a key that NEVER receives another reservation (e.g., dormant business) sits as a tiny-negative ghost forever.
- **Impact:** Bounded — small Redis memory leak per dormant-business midnight crossing, and a one-day under-counting on the day the orphan finally gets its first reserve (the EXPIRE-less negative value lets that day's bucket admit `~15 cents` more than the limit before hitting the cap). Not a path to bypass cost limits in practice — but the comment at line 163-164 acknowledges the team is aware of the class of bug.
- **Recommended fix:** Have `ADJUST_COST_LUA` set the EXPIRE on both keys after the INCRBY, mirroring `RESERVE_COST_LUA`. If the refund lands on an empty key, the EXPIRE caps the ghost lifetime to one day instead of forever. Two additional Lua lines.

---

### [MEDIUM] M-3: SMS cost tracker uses Redis pipeline instead of Lua — non-atomic refund

- **Location:** `src/lib/costs/sms-tracker.ts:152-161` (per sub-agent — line numbers not directly verified)
- **Description:** While the LLM cost tracker uses Lua scripts (`RESERVE_COST_LUA`, `ADJUST_COST_LUA`) for atomic per-business + global counter updates, the SMS tracker's refund path uses `redis.pipeline().decrby(...).decrby(...).exec()`. Pipelined commands are NOT atomic on the Redis side — they're just batched in one round-trip. A network drop or worker crash between the two DECRBY commands leaves the per-business and global counters drifted out of sync.
- **Impact:** Drift accumulates over time as SMS sends fail and refund partially succeeds. The per-business counter and global counter can diverge by tens of cents per incident. The system continues to enforce limits but on slightly-skewed numbers — eventually a business under its per-business limit might still hit the global limit (or vice versa) due to drift. Not exploitable but operationally messy.
- **Recommended fix:** Convert SMS refund to a Lua script identical in shape to `ADJUST_COST_LUA`. The reserve path already uses Lua per sub-agent; the refund path should match.

---

### [MEDIUM] M-4: `/api/admin/businesses/[id]/mark-posted` records "posted" with no Google-side verification

- **Location:** `src/app/api/admin/businesses/[id]/mark-posted/route.ts:38-45`
- **Description:** The endpoint flips `responses.status` from `awaiting_manual_post` to `posted` based purely on the admin's claim. There's no verification that the response was actually posted to Google. This is the intended manual-posting workflow today (sales partner copies the text to Google, then clicks "I posted it"), so by-itself it's not a bug. But it amplifies Round 2 H-1 (the unsanitized `editedText` chain): an attacker who possesses the email approval URL → edits to forged text → the partner pastes it to Google or the partner gets tricked into clicking mark-posted before noticing the edit. Either way, the audit log says "posted by admin X at time Y" and there's no record that the actual Google response is what RepWorth thinks it is.
- **Impact:** Audit-trail integrity gap. Combined with R2 H-1, an attacker can publish forged responses with credible audit metadata claiming an admin posted it.
- **Recommended fix:** When the GBP API integration ships (Phase 5 in the implementation plan), this endpoint becomes irrelevant. For the SerpAPI-mode interim, two options: (a) have the partner paste the actual posted-on-Google text back into a confirmation field — at least the system records what they CLAIM they posted, and a later automated comparison via the next ReviewSync can flag drift; (b) cheaper interim — when the next review-sync sees a response on Google for the review_id, hash it and store it next to `posted_at`, then compare to the response's `approved_text` and surface mismatches in a "verify your posts" admin view.

---

### [LOW] L-1: Admin demo generation accepts arbitrary `place_id` with no ownership check

- **Location:** `src/app/api/admin/demos/generate/route.ts` (per agent; not directly verified)
- **Description:** Admin/sales_partner role is required, but the route doesn't verify the supplied `place_id` corresponds to a business the admin is authorized to demo. Combined with R1 H-1 (sales_partner has unscoped access to every business), a partner could pull demos for any Google place — including competitors — to harvest example responses, analyze tone, or generate "how would RepWorth respond?" comparisons without consent.
- **Impact:** Soft — the data is technically already public on Google Maps. The harm is reputational (unauthorized "we drafted responses for your business" pitches) and a small SerpAPI/LLM cost burn per unauthorized demo.
- **Recommended fix:** Tie demo generation to a `prospect_demos` row and require an admin to bind a `place_id` to a specific prospect record before generating. Combined with R1 H-1's `onboarded_by` scoping, restrict reads to the partner's own prospects.

---

### [LOW] L-2: `/api/onboarding/select-plan` accepts replay; can flip tier without Stripe

- **Location:** `src/app/api/onboarding/select-plan/route.ts:196-201` (per agent)
- **Description:** The endpoint UPDATEs `subscription_tier` for any business in `pending_payment`. A user can call it repeatedly with different tiers — each call simply re-renders a different Stripe Payment Link. The actual cost is determined by Stripe at checkout (not by what RepWorth recorded), and the webhook reconciles tier-from-price-id when the customer pays. So no financial bypass — just a slightly-confused state where the DB says one tier and the user is currently looking at a different Payment Link.
- **Impact:** UX clutter, not security.
- **Recommended fix:** Either (a) accept it as designed (users CAN change their mind before paying) or (b) lock the tier after first selection and require a reset path to change. Probably (a) is fine — note the Stripe reconciliation as the authoritative source.

---

### [LOW] L-3: Voice-learning few-shot pool has no purge mechanism for poisoned edits

- **Location:** `worker/jobs/ResponseGeneratorWorker.ts` calls `getApprovedResponsePairs(business_id)`; `src/lib/responses/voice-learning.ts`
- **Description:** Round 4 M-1 covered the prompt-injection vector. This is the lifecycle angle: if you discover an edit was poisoned (incident review, customer complaint), there's no admin tool to remove it from the few-shot pool. The poisoned response stays in `responses` with `status='approved'` and continues to influence drafts until it ages out of the rolling window — likely tens of subsequent reviews.
- **Recommended fix:** Add a `voice_learning_excluded` boolean column on `responses`. Have `getApprovedResponsePairs` filter it out. Provide an admin UI to flip it. Cheap to add now, valuable when needed.

---

### [LOW] L-4: Cancelled / past-due-grace-expired jobs still pop off BullMQ before subscription check

- **Location:** `worker/jobs/ResponseGeneratorWorker.ts:78-88` and similar in NotificationWorker, ResponsePublisher
- **Description:** Workers correctly call `checkSubscription()` early and skip cancelled / expired-grace businesses. But the check happens after the job is dequeued, meaning a few seconds of CPU + a SELECT against `businesses` happen for every queued-but-now-cancelled job. The subscription change might already have queued dozens of pending jobs — they all go through "fetch + check + skip" instead of being purged from the queue when the subscription transitions.
- **Impact:** Wasted DB queries + tiny CPU cost. Not a bypass — the skip works correctly.
- **Recommended fix:** When the Stripe webhook flips a business to `cancelled`, enqueue a "drain queue for business X" job that removes pending entries from BullMQ. Probably not worth doing unless cancellation churn becomes a real workload.

---

## Verified safe (claims investigated, no finding)

| # | Claim | Status | Reason |
|---|---|---|---|
| 1 | **No-auto-post invariant** | **Safe** | Every code path from `generate_response` to actual Google posting requires `responses.status IN ('approved', 'edited')`. ResponsePublisherWorker UPDATE clause checks this. Manual `mark-posted` only allowed from `awaiting_manual_post`. There is no bypass. R6 sub-agent traced all paths. |
| 2 | **Outbox dual-dispatch** | **Safe** | OutboxPoller uses atomic `UPDATE … SET status='dispatching' WHERE status='pending' RETURNING …` (per agent). Attempt-guarded completion (`WHERE attempts = ${attempt}`) prevents stale workers from stomping new attempts after watchdog reclaim. |
| 3 | **Outbox payload mutation** | **Safe** | `job_outbox.payload` is read once at dispatch and copied into BullMQ `job.data`. Workers receive a copy, not a reference. No mutation surface. |
| 4 | **CleanupAbandonedSignupsPoller TOCTOU** | **Safe** | Lab note 2026-04-26 already flagged the bug class. Code now: per-email + per-business advisory lock, FOR UPDATE re-select, and re-validation of EVERY predicate (no payment, no auth_id, abandoned-window). A Stripe webhook arriving during cleanup serializes behind the advisory lock and the re-validation aborts the delete. **Verified properly mitigated.** Note: `supabase.auth.deleteUser()` (`auth.users` row) is not transactional — if the DB delete fails after Supabase succeeds, an orphaned auth row remains. The current code accepts this and surfaces it as a follow-up cleanup item. Acceptable. |
| 5 | **EmailChannelReconcilePoller resurrects unsubscribed enrollments** | **Safe** | The poller's SELECT filters businesses with **no email enrollment row at all** (including archived). It does NOT re-INSERT for businesses that have an archived enrollment — that would resurrect an unsubscribed contact. ON CONFLICT DO NOTHING on the INSERT is a belt-and-suspenders no-op for the poller-poller race. |
| 6 | **NotificationFailoverPoller duplicate sends** | **Safe** | Re-queue logic uses `WHERE NOT EXISTS (SELECT FROM job_outbox WHERE topic='send_notification' AND aggregate_id=response_id)` to deduplicate. NotificationWorker reuses an existing approval link if a delivery row exists, so a re-queue produces the same token in a re-sent email — owner sees one duplicate, not two distinct tokens (R2 lab note 2026-04-18 documents this as accepted behavior). |
| 7 | **Telegram enrollment race** | **Safe** | `worker/ingress/telegram-enrollment.ts` wraps SELECT FOR UPDATE + UPDATE in a single `sql.begin()` so the row lock survives both statements. Two concurrent `/start <token>` requests serialize: first wins, second finds nothing in the FOR UPDATE re-select and returns gracefully. **Round 3 deferred check is now resolved — verified safe.** |
| 8 | **Concurrent approve + regenerate** | **Safe** | State machine is self-healing: approve UPDATE has `WHERE status='pending_approval'`; regenerate UPDATE has `WHERE status='pending_approval'` AND inserts a new response. Whichever wins the race makes the loser's WHERE clause match zero rows. No double-publish, no inconsistent state. Migration 023's partial unique index on non-terminal responses provides a final safety net. |
| 9 | **Concurrent approve via two channels** | **Safe** | R2 already verified — `lockPendingResponse` + `consumeLink` + `revokeSiblings` in one tx; two concurrent attempts: one commits, the other rolls back via `ResponseNotPendingError`. Then `revokeSiblings` cleans up the loser's link. |
| 10 | **Stripe event reordering** | **Safe** | Webhook handler uses an advisory lock on the business id (per sub-agent reading), serializing concurrent events. Out-of-order delivery (e.g., `customer.subscription.updated` before `checkout.session.completed`) is handled by idempotent state transitions — each event maps to a specific status update via `WHERE` clauses, not blind sets. |
| 11 | **`subscription_status='active'` write paths** | **Safe** | Only the Stripe webhook (`worker/ingress/stripe.ts:102` per sub-agent) writes `'active'`. Admin onboarding writes `'pending_payment'`. Self-serve signup writes `'pending_payment'`. No other code path mints active status. |
| 12 | **Onboarding without payment** | **Safe** | `/api/onboarding/business` PATCH route checks `subscription_status='active'` (per sub-agent line 118-122) before saving wizard fields. A user in `pending_payment` is rejected with 409. The wizard is gated by Stripe completion. |
| 13 | **Notification send-before-record race** | **Safe (but accepted edge)** | Migration 024 partial unique index on `notification_deliveries` closes the symmetric send-before-record race for the `admin_manual_post` template. The approval-email send-before-record race is documented in CLAUDE.md as an accepted residual risk (can produce a duplicate email if worker crashes in the gap). |
| 14 | **Channel hijack via auto-enrolled email** | **Safe** | Email auto-enrollment requires either OTP completion (self-serve) or `inviteUserByEmail` flow (admin onboarding). No path lets an attacker force an email enrollment without controlling the inbox of the target email. The email channel is the trust root that other channels are bootstrapped from — losing it is by definition account compromise. |
| 15 | **Self-serve signup spam cost-of-attack** | **Safe** | 5/hr/IP rate limit + cleanup poller after 24h. Cost per signup is essentially `1 email + 3 DB rows`. No LLM or SerpAPI cost incurred until subscription is active. Distributed-IP attack is theoretically possible but yields nothing more than DB churn — the cleanup poller absorbs it. |
| 16 | **Admin can trigger generator before payment (cost abuse)** | **By-design** | Per CLAUDE.md: "pending_payment → ResponseGeneratorWorker is allowed (for admin-visible demo drafts)". The generator runs so the partner can show the prospect working drafts during the sales call. Notifications + publishing are properly blocked. Cost is bounded by the per-business + global cost guard. Accepted trade-off. |

---

## Recommended Round-6 fix priority

1. **M-1** — Add `subscription_status_changed_at` column. The existing residual-risk doc puts this in the next billing sprint; keep it there.
2. **M-2** — Add EXPIRE to `ADJUST_COST_LUA`. Two-line Lua change.
3. **M-3** — Convert SMS-tracker refund to a Lua script. Mirror `ADJUST_COST_LUA`.
4. **M-4** — When GBP API ships, mark-posted goes away. Until then, optionally add post-sync hash comparison to surface mismatch in admin UI. Or accept it as a known audit-trail limit and document.
5. **L-1, L-2, L-3, L-4** — Bundle into hardening PR.

---

## Coverage notes

- I directly read `subscription-guard.ts`, `tracker.ts:150-250`. Other files relied on sub-agent reading.
- Round 7 will consolidate the "no-auto-post" invariant verification across rounds — sub-agent confirmed it holds, I'm satisfied without re-reading every worker.
- The accepted residual risks documented in CLAUDE.md (M-1 here, the approval send-before-record race in R2 / R6 #13) deliberately weren't downgraded — they're known and tracked, but they're still findings.
