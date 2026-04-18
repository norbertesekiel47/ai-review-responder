# RepWorth Pre-Launch Smoke Test Checklist

Manual end-to-end verification before the first paid customer. Runs
against real external services in Stripe test mode with real API keys.

**Pre-flight:**
- [ ] `MOCK_EXTERNAL_APIS=false` in the environment
- [ ] Real `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SERPAPI_KEY`,
      `RESEND_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`
- [ ] Stripe in **test mode** (`STRIPE_SECRET_KEY` starts with `sk_test_`)
- [ ] `STRIPE_WEBHOOK_SECRET` points at the test-mode webhook endpoint
- [ ] `CSRF_SECRET`, `RESEND_WEBHOOK_SECRET`, `ADMIN_NOTIFICATION_EMAIL` set
- [ ] Railway worker is running; Vercel preview is deployed
- [ ] Three real Google Business Profile place IDs ready (can be
      your own test businesses or partner's — just needs real reviews)
- [ ] Three real email inboxes you can access for each test business

**Test matrix:**

| | Business A | Business B | Business C |
|---|---|---|---|
| Focus | Happy path | Edit + concurrency | Regenerate + correlation |
| Place ID | real | real | real |
| Owner email | inbox-a | inbox-b | inbox-c |

---

## Business A — Full happy path

- [ ] Onboard via `/admin/businesses/new`. Use the PlaceAutocomplete
      input to select the business. Verify the SerpAPI pre-fill
      populates `category`, `ownerPhone`, and `website` within 2
      seconds. Empty fields get filled; fields you already edited
      are preserved. (Hours/full address are returned by the API but
      not currently surfaced in the form — do not assert on them.)
- [ ] Submit the form. The app automatically redirects the browser
      to the Stripe Payment Link (no intermediate success page). Pay
      via Stripe test card `4242 4242 4242 4242` (any future date,
      any CVC). If redirect does not happen, inspect the onboarding
      POST response for `paymentUrl`.
- [ ] Confirm `subscription_status` transitions to `active` on
      `/admin/businesses/<id>` within 30s (Stripe webhook).
- [ ] Initial sync fires. Confirm `reviews` rows appear on the
      detail page within 2-3 minutes (SerpAPI rate permitting).
- [ ] Approval email lands in `inbox-a`. Open on a **mobile device**.
- [ ] Page loads in under 2s on a throttled mobile connection (use
      Chrome DevTools → Network → "Slow 3G" throttle).
- [ ] Click **Approve**. Page transitions to a success state.
- [ ] Confirm `responses.status='awaiting_manual_post'` in admin.
- [ ] In the admin detail page's Manual Post Section, copy the approved
      text, paste into Google Business Profile UI, then click
      **Mark as posted**. Confirm `responses.status='posted'` and
      `posted_at` is populated.

## Business B — Edit flow + concurrent onboarding

- [ ] Start onboarding Business B while Business A's sync is still
      running. Verify `/admin/businesses/new` responds normally — no
      interference.
- [ ] After payment + sync, approval email arrives.
- [ ] Click **Edit** on the approval page. Modify the response text
      (change at least 20 characters).
- [ ] Submit the edit. Confirm `responses.status='edited'`,
      `approved_text` contains your edits, and the original
      `response_text` is preserved.
- [ ] Open the same approval link again — should show the "already
      consumed" state.
- [ ] Confirm in admin that Business A's data is untouched (no
      cross-business leakage: `business_id` scoping works).

## Business C — Regeneration + correlation ID tracing

- [ ] Onboard + pay + wait for initial sync.
- [ ] Approval email arrives. Click **Regenerate** on the approval
      page. A new draft generates (may take 10-30s).
- [ ] Confirm the old response row has `status='superseded'` and a
      new response row exists with `status='pending_approval'` and
      `version` incremented.
- [ ] Confirm the **old** approval link now returns a "consumed /
      expired" state when revisited.
- [ ] A **new** approval email arrives with a fresh link. Approve it.
- [ ] Grab the new `response_id` from admin. Run the correlation
      trace from `docs/operational-runbook.md` Section C1. Confirm
      every step (sync_reviews, generate_response, send_notification,
      publish_response) is tagged with the same correlation ID.

## System health across all three businesses

- [ ] `/admin/overview` lists all three businesses.
- [ ] System Health card: pending outbox drops to <10 within 5
      minutes of the last approval. Failed jobs = 0.
- [ ] Email Health card shows green: delivery rate ≥95%, 0 complaints,
      0 hard bounces.
- [ ] `/admin/costs` shows cost entries for every provider actually
      invoked during the run. In the happy path that means `serpapi`
      (sync + any pre-fill) and `openai` (response generation). The
      `anthropic` provider only appears if OpenAI fell back during the
      run. `resend` is NOT tracked via `api_costs` today — email
      spend is reconciled via the Resend dashboard. All three
      businesses should appear in the per-business breakdown for the
      providers that did run.
- [ ] `/admin/notifications` lists approval email deliveries for
      all three businesses with `delivered_at` populated.
- [ ] Wait ≥4 hours. Confirm `NotificationFailoverPoller` has not
      fired spurious admin alerts (it should only alert if
      `sent_at` is set but `delivered_at` is NULL for >4h).

## Throughput sanity check (non-production only)

Seed 200 safe outbox entries and confirm OutboxPoller drains them
cleanly. **Do not run this against production.**

- [ ] Point at a staging DB or a throwaway branch of production.
- [ ] Insert 200 `job_outbox` rows with `topic='sync_reviews'` and
      valid `aggregate_id` references (or any safe idempotent topic).
- [ ] Watch `/admin/jobs` → pending count drops, dispatched count
      rises, then both return to 0 as completed grows.
- [ ] Confirm no duplicate side effects: SerpAPI call count should
      match unique `(business_id, review_id)` pairs, not 2× that.
- [ ] Confirm no rows stuck in `dispatched` status after drain.

## Approval performance check

- [ ] Open the approval page from an approval email on a phone OR
      Chrome DevTools Mobile emulation + "Slow 3G" throttle.
- [ ] Page loads (FCP) in under 2 seconds. Record the actual number.
- [ ] Approve button is responsive (tap → feedback within 200ms).

---

## Sign-off

- [ ] All three business flows completed end-to-end
- [ ] No unexpected errors in Sentry during the test run
- [ ] No orphaned/stuck outbox entries
- [ ] Email Health card green at end of run
- [ ] Costs tracked for every external call

**Run date:** ____________
**Run by:** ____________
**Result:** Pass / Fail / Fail-fix-retry
**Notes:**
