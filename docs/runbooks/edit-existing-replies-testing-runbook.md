# Edit Existing Replies — Manual Testing Runbook

**Branch:** `feat/edit-existing-replies-revival` (PR #56)
**Purpose:** Step-by-step manual verification of the edit/regenerate/republish + recovery feature before flipping it on in production.
**Audience:** You (local dev) or a staging operator.

> The feature ships **inert** behind `EDIT_REPLIES_ENABLED`. This runbook turns it on locally and walks every path. Recovery/orphan states can't be produced by clicking (Zernio is mocked-success locally), so §7 seeds them directly in Postgres.

---

## 0. Prerequisites

```bash
git checkout feat/edit-existing-replies-revival
pnpm install
```

In `.env.local` (`PAST_REPLIES_VIEW_ENABLED` was retired at #678 — the
**Reviews list** at `dashboard/reviews/history` renders unconditionally now, so
`EDIT_REPLIES_ENABLED` is the only flag this runbook needs):

```bash
MOCK_EXTERNAL_APIS=true            # bypass real Zernio/Stripe/etc locally
EXTERNAL_REPLY_IMPORT_ENABLED=true # ingestion of pre-RepWorth replies (writes)
EDIT_REPLIES_ENABLED=true          # the edit/regenerate/republish + recovery
# TEST_DATABASE_POOL_URL=...        # only needed for §11 (pnpm test:integration)
```

Run in three terminals:

```bash
pnpm dev        # Next.js UI on :3000
pnpm worker     # Railway worker (publisher, generator) on :3001
# ensure Postgres + Redis are reachable (the same ones .env.local points at)
```

**You need a seeded owner** with at least one business (location) that has **reviews with `posted` responses**. Easiest paths:
- Use an existing local owner account, or
- Run the connect flow (`/dashboard/connect`) with `MOCK_EXTERNAL_APIS=true`, which ingests mock reviews + replies.

Throughout, open a psql session to the same DB for verification queries. Set a shell var for the location you're testing:

```sql
-- find your test location + account
SELECT b.id AS business_id, b.account_id, a.subscription_tier, a.subscription_activated_at, a.subscription_status
FROM businesses b JOIN accounts a ON a.id = b.account_id
WHERE b.archived_at IS NULL ORDER BY b.created_at LIMIT 5;
```

Note one `business_id` (call it `$LOC`) and its `account_id` (`$ACC`).

---

## 1. Phase-A inertness (flags OFF) — the safety baseline

Temporarily set `EDIT_REPLIES_ENABLED=` (unset/false), restart `pnpm dev`.

- **UI:** `/dashboard/past-replies` renders read-only — no Edit buttons, no lock badges, no recovery cards.
- **API:** every edit route 503s. Quick check (replace cookies/origin as needed, or just confirm in the browser network tab):
  ```bash
  curl -i -X POST http://localhost:3000/api/dashboard/past-replies/draft -H 'content-type: application/json' -d '{}'
  # expect: 503 {"error":"feature_disabled"}
  ```
- **Worker:** publishing a normal (non-edit) response behaves exactly as before — no edit branch taken.

✅ Pass = read-only page + 503 on all 7 routes (`/draft`, `/draft/:id`, `/draft-status`, `/publish`, `/:id/retry`, `/:id/restore-original`).

Re-enable `EDIT_REPLIES_ENABLED=true` and restart for the rest.

---

## 2. Tier gating (C-2 rule)

Rule: **gap** reviews (review_date ≥ subscription_activated_at) are editable by everyone; **historical** reviews (before activation, or NULL activation) require **premium**.

| Account tier | Gap review | Historical review |
|---|---|---|
| basic / standard / founders | ✅ Edit CTA | 🔒 "Premium feature" lock badge |
| premium | ✅ Edit CTA | ✅ Edit CTA |

Test by flipping the account tier and reloading `/dashboard/past-replies`:

```sql
-- make premium, then re-test as a non-premium tier
UPDATE accounts SET subscription_tier='premium'  WHERE id='$ACC';
UPDATE accounts SET subscription_tier='standard' WHERE id='$ACC';
```

A review dated before `subscription_activated_at` should show the lock badge for `standard`, the Edit CTA for `premium`. Server-authoritative: even if you force the button, `/publish` will 403 `premium_required` for a historical+non-premium combo.

---

## 3. Manual edit — happy path

1. `/dashboard/past-replies` → click **Edit** on a posted reply.
2. Change the text → **Update on Google**. Drawer shows "publishing", then success.
3. Verify:
   ```sql
   SELECT id, status, edited_text IS NOT NULL AS is_edited, posted_at, version
   FROM responses WHERE review_id='<review_id>' ORDER BY version;
   -- expect: the new row 'edited' then 'posted' (worker runs); the old reply 'superseded'
   SELECT mode FROM approval_audit_log WHERE response_id='<new_id>';  -- 'manual' (via metadata)
   ```
4. The worker (`pnpm worker` terminal) should log a publish; with `MOCK_EXTERNAL_APIS=true` the Zernio DELETE+POST are mocked-success, so the row lands `posted`.

✅ Pass = old reply `superseded`, new reply `posted`, audit row written, no duplicate `posted` per review.

---

## 4. Regenerate — accept-as-is vs edit-further

**Accept as-is (must stay `regenerate_as_is`, not edited):**
1. Edit → **Regenerate** → wait for the AI draft preview.
2. Click **Update on Google** WITHOUT editing the text.
3. Verify the published row is `approved` (not `edited`) and `edited_text IS NULL`:
   ```sql
   SELECT status, edited_text, llm_provider FROM responses WHERE id='<new_id>';
   -- status 'approved'/'posted', edited_text NULL  → regenerate_as_is
   ```
   (Regression guard: before the fix this wrongly became `edited`/`regenerate_edited`.)

**Edit further:**
1. Regenerate → **Edit further** → modify the text → **Update on Google**.
2. Verify `edited_text` is set → publishes as `edited` (`regenerate_edited`).

---

## 5. Optimistic concurrency (stale drawer)

1. Open the Edit drawer on a posted reply (snapshots `{hash, version}`).
2. In psql, simulate the review changing under you:
   ```sql
   UPDATE reviews SET review_content_hash='deadbeef-changed', review_text='(edited by reviewer)'
   WHERE id='<review_id>';
   ```
3. Click **Update on Google** → drawer shows the **review-changed (409)** prompt, not a silent overwrite.
4. Reset by reopening the drawer (re-snapshots).

A concurrent response version bump (e.g. another publish) similarly yields a `response_changed` 409.

---

## 6. (Reference) how the recovery states arise

The publisher edits a live reply by **DELETE-then-POST** on Zernio:
- DELETE fails → `posting_error = delete_failed_*` (old reply still live on Google).
- DELETE ok + POST fails → orphan: old reply `superseded`, candidate `failed` with `post_after_delete_failed_*` (Google's reply slot is now **empty**).
- On retry exhaustion the failed-hook converts an orphan to `post_after_delete_failed_retry_exhausted`.
- If the reviewer edits their review after a failure → `stale_after_review_changed` (blocks `/retry`).

Locally these don't occur (mock POST succeeds), so §7 seeds them directly.

---

## 7. Recovery — seed the states, then drive the UI

> Adjust `$LOC` and a real `review_id` that currently has a `posted` reply. UUIDs via `gen_random_uuid()` are fine for manual rows.

### 7a. delete-failed (coexists with the live posted reply → sidecar badge on the posted card)

```sql
INSERT INTO responses (id, review_id, business_id, status, response_text, approved_text,
                       posting_error, version, created_at, updated_at)
VALUES (gen_random_uuid(), '<review_id_with_posted>', '$LOC', 'failed',
        'attempted new reply', 'attempted new reply',
        'delete_failed_http_500',
        (SELECT COALESCE(MAX(version),0)+1 FROM responses WHERE review_id='<review_id_with_posted>'),
        NOW(), NOW());
```
- Reload `/dashboard/past-replies`. The **posted card** for that review shows a "needs attention" recovery affordance (sidecar) — the live reply is still there.
- Open it → **Retry**. The drawer calls `/retry`; verify `posting_error` cleared to NULL and a `publish_response` outbox enqueued:
  ```sql
  SELECT status, posting_error FROM responses WHERE id='<failed_id>';      -- 'approved', NULL
  SELECT topic, status FROM job_outbox WHERE payload->>'response_id'='<failed_id>'; -- publish_response
  ```

### 7b. orphan (DELETE ok + POST failed → NO posted sibling → its OWN recovery card)

First make the existing posted reply `superseded` (simulating the DELETE having removed it), then add the orphan failed row:

```sql
UPDATE responses SET status='superseded' WHERE review_id='<review_id>' AND status='posted';

INSERT INTO responses (id, review_id, business_id, status, response_text, approved_text,
                       posting_error, version, posted_at, created_at, updated_at)
VALUES (gen_random_uuid(), '<review_id>', '$LOC', 'failed',
        'reply that failed to post', 'reply that failed to post',
        'post_after_delete_failed_http_400',
        (SELECT COALESCE(MAX(version),0)+1 FROM responses WHERE review_id='<review_id>'),
        NULL, NOW(), NOW());
-- ensure the OLD superseded row has posted_at set (it's the original to restore):
UPDATE responses SET posted_at=COALESCE(posted_at, NOW())
WHERE review_id='<review_id>' AND status='superseded';
```
- Reload. The review now appears as its **own recovery card** (no posted card, since no `posted` row), in the correct gap/historical bucket. It must NOT be hidden, and must NOT show a "Posted via RepWorth" badge (shows "Pending recovery").
- Open it. You get two recovery actions:
  - **Retry** → re-attempts the edit (re-installs the orphan marker for the next publisher attempt).
  - **Restore original** → republishes the original reply directly. Verify:
    ```sql
    -- after Restore original:
    SELECT status, edited_text, version FROM responses WHERE review_id='<review_id>' ORDER BY version;
    -- a NEW 'approved' row at MAX+1, edited_text NULL; old 'failed' row left in place
    SELECT topic FROM job_outbox WHERE payload->>'response_id'='<new_restored_id>'; -- publish_response
    SELECT mode FROM approval_audit_log WHERE response_id='<new_restored_id>';      -- restore_original
    ```
  - With the worker running + mock POST success, the restored row should then go `posted` (the original reply is back).

### 7c. stale-after-review-change blocks retry

On an orphan/delete-failed row, simulate the reviewer editing their review:
```sql
UPDATE responses SET posting_error='stale_after_review_changed' WHERE id='<failed_id>';
```
- **Retry** should be refused with `409 not_recoverable_via_retry` (the drawer surfaces the error). Restore-original is the only path.

---

## 8. Draft resume / discard / queued / reconnect

### 8a. Resume / Discard a pending draft (reload mid-edit)
1. Edit a posted reply → type changes, but **don't publish**; instead create the draft then reload the page (simulating a crash). To force the draft to exist, publish-then-reload, or insert a pending row:
   ```sql
   INSERT INTO responses (id, review_id, business_id, status, response_text, approved_text, edited_text, version, created_at, updated_at)
   VALUES (gen_random_uuid(), '<review_id_with_posted>', '$LOC', 'pending_approval',
           'in-progress text', 'in-progress text', 'in-progress text',
           (SELECT COALESCE(MAX(version),0)+1 FROM responses WHERE review_id='<review_id_with_posted>'),
           NOW(), NOW());
   ```
2. Re-open **Edit** on that review's posted card → `/draft` returns `draft_already_exists`. The drawer offers **Resume** (loads the in-progress text → publish/edit) or **Discard** (DELETE → back to start). Test both.

### 8b. Already-queued / reconnect states (no dead actions)
Change the seeded draft's status and re-open Edit:
```sql
UPDATE responses SET status='approved' WHERE id='<pending_id>';            -- → "Edit already approved, publishing" + Refresh/Close
UPDATE responses SET status='awaiting_owner_connect' WHERE id='<pending_id>'; -- → "Google reconnect required" + Reconnect (→ /dashboard/connect)
```
Neither should offer Resume/Discard (they can't resolve those states).

---

## 9. Multi-location scoping

If your account has 2+ locations, use the location switcher (sets the `rw_location_scope` cookie). Confirm:
- Past Replies shows only the **current** location's replies.
- Editing scopes to that location — a draft/publish binds `business_id = currentLocationId` (not the primary). Verify the inserted row's `business_id` matches the switched location, not the account's primary.

---

## 10. Subscription gating

```sql
UPDATE accounts SET subscription_status='cancelled' WHERE id='$ACC';   -- or 'past_due' / 'pending_payment'
```
- `/dashboard/past-replies` (SSR) redirects to `/onboarding/pay`.
- The edit API routes return `403 subscription_inactive` (resolveOwnerScope). Reset to `'active'` after.

---

## 11. Automated hard-gate (real Postgres)

```bash
# with TEST_DATABASE_POOL_URL set in .env.local (or exported):
pnpm test:integration
# 7+ passing — exercises orphan, retry-exhaustion conversion, /retry, /restore-original against a real DB
pnpm test           # full suite (3733+ passing)
```

---

## 12. Cleanup

Reset any rows/flags you changed:
```sql
-- remove seeded test rows
DELETE FROM responses WHERE response_text IN
  ('attempted new reply','reply that failed to post','in-progress text','reply that failed to post');
-- restore tier/subscription/review as needed
UPDATE accounts SET subscription_tier='<orig>', subscription_status='active' WHERE id='$ACC';
```
Unset the flags in `.env.local` to return to inert (Phase A) behavior.

---

## Production rollout note

Don't hand-flip the production flag from this runbook. Phase A → B rollout **and the ordered rollback drain** (disable UI flag → drain edit-publish outboxes → verify no `delete_failed_%` / `post_after_delete_failed_%` rows → only then disable the worker branch) live in `docs/runbooks/completed_runbooks/zernio-launch-runbook.md` §11.
