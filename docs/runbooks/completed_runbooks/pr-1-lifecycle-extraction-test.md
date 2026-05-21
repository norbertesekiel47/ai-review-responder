# PR #1 Test Runbook — Lifecycle Extraction

**PR:** Lifecycle Extraction (refactor — zero behavior change to prospect demos)
**Branch:** `feat/lifecycle-extraction`
**Base:** `eabd69c` (`Cost-guard wrapper + LLM error classifier extraction (#14)`)
**Goal of this runbook:** prove zero regression on the existing prospect-demo flow before opening the PR.

This runbook is for local pre-PR verification. Delete after PR #1 merges — it's ephemeral.

---

## What you're testing

PR #1 doesn't add any user-visible features. It restructures the demo lifecycle code into reusable helpers that PR #2 (the actual onboarding-demo feature) will consume. **The success criterion is: prospect demos behave EXACTLY as they did before.**

Three test layers:

1. **Static checks** (5 min) — type, lint, unit tests
2. **Mock end-to-end** (10 min) — full local flow with `MOCK_EXTERNAL_APIS=true`, no real API spend
3. **Real-API end-to-end** (10 min, optional, ~$0.05) — full local flow against actual SerpAPI + LLM

Plus a failure-path check (2 min) and rollback notes.

---

## 0. Prerequisites

```powershell
# Confirm you're on the right branch at the right tip
git status
git log --oneline -1
# Expected last commit: d678b55 fix(worker): preserve failure-tx diagnostic log on failDemo error (#1)

# Confirm dependencies are installed
pnpm install
```

---

## 1. Static checks

Run these three. All must pass. **None of these touch the database or external APIs.**

### 1a. TypeScript

```powershell
pnpm tsc --noEmit
```

**Expected:** `TypeScript: No errors found`

### 1b. ESLint

```powershell
pnpm lint
```

**Expected:** 13 errors total, all in **pre-existing** files (`twilio-inbound.test.ts`, `PlaceIdValidationWorker.test.ts`, `twilio-status.test.ts`, `correlation-chain.test.ts`, `resend-webhook-bounce.test.ts`). **None should be in `src/lib/demos/**` or `worker/jobs/DemoGenerationWorker.ts`.**

If you want to confirm the 13 errors are all pre-existing:

```powershell
pnpm lint 2>&1 | Select-String "demos|DemoGenerationWorker"
# Expected: no output (no PR #1 files in the lint failures)
```

### 1c. Demos unit/integration tests

```powershell
$env:MOCK_EXTERNAL_APIS = "true"
npx vitest run src/lib/demos
```

**Expected:** 16 tests pass / 0 fail. The lifecycle integration tests (`lifecycle.test.ts`) will skip cleanly if `TEST_DATABASE_POOL_URL` is not set — that's expected unless you have a dedicated test DB configured.

If you DO want to run the lifecycle integration tests against a real DB:

```powershell
$env:MOCK_EXTERNAL_APIS = "true"
$env:TEST_DATABASE_POOL_URL = "postgres://...your test pool URL..."
npx vitest run src/lib/demos/__tests__/lifecycle.test.ts
# Expected: 9 tests pass (claimDemo×6, completeDemo×2, failDemo×2)
```

---

## 2. Diff inspection (eyeball pass)

```powershell
# Full commit list for this PR
git log --oneline eabd69c..HEAD

# Diff the two load-bearing files vs the base — these are the ones where
# behavior parity must hold
git diff eabd69c -- src/lib/demos/generator.ts
git diff eabd69c -- worker/jobs/DemoGenerationWorker.ts
```

**What to look for in `generator.ts` diff:**
- New body composes `fetchSerpApiReviews` → `generateResponsesForReviews`
- `startTime` captured BEFORE fetch, used to override `generationDurationMs` in the return value (preserves end-to-end timing semantics)
- **No** `selectQualifyingReviews` call (deliberately deferred to PR #2 to preserve 15-review prospect breadth)

**What to look for in `DemoGenerationWorker.ts` diff:**
- File shrunk from 181 → 70 lines (now 90 with the diagnostic-log fix at `d678b55`)
- All inline lifecycle SQL replaced with `claimDemo` / `completeDemo` / `failDemo` calls
- Catch block has nested try/catch around `failDemo` that logs `"Failed to record failure for demo X: <txError>"` and re-throws — this is the diagnostic preservation from review-feedback fix `d678b55`
- Stale-running `'reset_to_queued'` path now THROWS (vs old inline retry) so BullMQ re-dispatches — same effective behavior, cleaner separation

---

## 3. Mock end-to-end smoke test

This is the most important test. You're verifying the worker still picks up a demo job, processes it through the new helpers, writes to `prospect_demos`, and the demo page renders.

### 3a. Set up mock mode

In `.env.local`:

```
MOCK_EXTERNAL_APIS=true
```

This bypasses real SerpAPI and LLM calls. The worker uses `MockReviewSource` and `generateMockResponse`.

### 3b. Start two terminals

**Terminal 1 — Next.js (Vercel UI):**
```powershell
pnpm dev
# Should start on http://localhost:3000
```

**Terminal 2 — Railway worker:**
```powershell
pnpm worker
# Starts on port 3001
```

The worker bootstraps BullMQ workers silently (no per-worker registration log). The startup logs you'll actually see, roughly in order:

1. `[worker] Feature flags: SMS=off, Telegram=off, WhatsApp=off, SelfServeSignup=on/off, ZernioPublishing=on/off`
2. Fastify info logs (`Server listening at http://0.0.0.0:3001`)
3. `Worker service running on port 3001`
4. Possibly `[NotificationFailover] Skipped — MOCK_EXTERNAL_APIS=true (no real sends)` (with mock mode on)
5. Quiet — pollers tick every 10s in the background

**If you see `Worker service running on port 3001` with no preceding `Startup assertion failed` error, `DemoGenerationWorker` is registered and ready.** The `[DemoGenerationWorker]` log prefix only appears when an actual demo job is being processed (it's built by `createWorkerLogger` inside the handler, not at startup).

### 3c. Trigger a prospect demo

Open `http://localhost:3000/admin/demos` in a browser, sign in as admin, then create a new demo:

- Business name: `RepWorth Test Cafe`
- Place ID: `ChIJN1t_tDeuEmsRUsoyG83frY4` (Google Sydney HQ — known-good Place ID; mock source returns canned data regardless)
- Category: `cafe`

Submit. The admin UI returns a demo URL slug.

### 3d. Watch the worker logs

Within ~5 seconds of submit, Terminal 2 should log:

```
[DemoGenerationWorker] [<correlation-id>] Demo <demoId> completed: 8/8 responses in <N>ms
```

`MockReviewSource` has 8 canned reviews baked in (Alice/Bob/Carlos/Diana/Élise/Frank/Grace/Hans — see `src/lib/reviews/mock-source.ts:5-68`). The worker fetches with `max=15` so it gets all 8, generates a response for each, and writes 8/8 to `prospect_demos`. **Seeing 8/8 (not 3/3) is the success signal — it confirms PR #1 did NOT silently slice to 3 via `selectQualifyingReviews(reviews, { rule: 'newest' })`.** That deliberate deviation was approved during implementation; the slice-to-3 behavior is reserved for PR #2's onboarding worker.

**What this proves:**
- Outbox poller picked up the job → `claimDemo` claimed it → `generateDemo` (new composition) ran → `completeDemo` wrote success + closed outbox
- All four extracted helpers worked end-to-end through the existing prospect path

### 3e. Render the demo page

Visit the demo URL the admin UI gave you (e.g., `http://localhost:3000/demo/<slug>`).

**Expected:**
- Page loads with `<businessName>` header
- "8 reviews analyzed · 8 AI responses generated" stats line
- Eight review cards, each with reviewer name + star rating + review text + AI-generated response (mix of English / Spanish / French / German — Diana's card has no review text but should still render)

**If you see 8/8, prospect-demo behavior parity is confirmed in mock mode.** ✅
**If you see 3/3 instead, PR #1 silently regressed — the `select(newest)` deviation didn't take. Stop and investigate `src/lib/demos/generator.ts`.**

---

## 4. Real-API end-to-end smoke test (optional, ~$0.05)

Skip this if you're confident in the mock test. Run it if you want belt-and-suspenders verification before opening the PR.

### 4a. Toggle off mock mode

In `.env.local`:

```
MOCK_EXTERNAL_APIS=false
```

(Or remove the line entirely.) Confirm `SERPAPI_API_KEY` and `OPENAI_API_KEY` are set.

### 4b. Restart both terminals

```powershell
# In each terminal: Ctrl+C then re-run pnpm dev / pnpm worker
```

`useMocks` is captured at module-load time, so a restart is required to pick up the env change.

### 4c. Trigger a real demo

Same as 3c, but use a Place ID for a real business with reviews:

- Suggested test target: a local Sydney cafe with ≥10 reviews. Easiest way: use `https://www.google.com/maps` to find a cafe, copy its share-link URL, paste into the admin UI's "Maps URL" field. The PlaceIdValidationWorker resolves it.
- Or use a known Place ID like `ChIJrTLr-GyuEmsRBfy61i59si0` (Sydney Opera House — many reviews).

### 4d. Watch the worker logs

Should see ~5-15 second latency (SerpAPI fetch + parallel LLM calls):

```
[DemoGenerationWorker] [<correlation-id>] Demo <demoId> completed: <N>/<N> responses in <ms>ms
```

The `<N>/<N>` should be up to 15 (this is the prospect path's full breadth — confirming we did NOT introduce the `select(newest)` slice).

### 4e. Render the demo page

Same as 3e — should render up to 15 review cards with real review text and real AI responses.

**Cost check:** open `/admin/runbook` (or query Supabase directly) for the `api_costs` table — there should be a fresh row with `cost_lane='response_generation'` (or whatever the existing prospect path uses; it does NOT use `cost_lane='onboarding_demo'` — that's PR #2). Total cost should be under 5¢ for a 15-review demo.

---

## 5. Failure-path verification

Verifies the new diagnostic log path (added in `d678b55`) and that `failDemo` writes `generation_status='failed'` correctly.

### 5a. Trigger a demo with an invalid Place ID

Via `/admin/demos`:

- Business name: `Failure Test`
- Place ID: `ChIJINVALID000000000000000000000` (intentionally invalid; SerpAPI will return 0 reviews or 4xx)

### 5b. Watch the worker logs

You should see:

```
[DemoGenerationWorker] [<correlation-id>] Demo <demoId> failed: <error message>
```

You should NOT see:

```
[DemoGenerationWorker] Failed to record failure for demo <demoId>: <txError>
```

(That second log only fires if `failDemo`'s tx ITSELF fails — a DB transport flake. In a healthy local environment you should only see the first log.)

### 5c. Verify DB state

In Supabase SQL editor or psql:

```sql
SELECT id, business_name, generation_status, generation_error, completed_at
FROM prospect_demos
WHERE business_name = 'Failure Test'
ORDER BY created_at DESC
LIMIT 1;
```

**Expected:**
- `generation_status = 'failed'`
- `generation_error` contains the actual error message ("No reviews found for this business" or similar)
- `completed_at` is set

```sql
SELECT id, status, last_error, completed_at
FROM job_outbox
WHERE topic = 'generate_demo'
  AND aggregate_id = '<demoId from above>';
```

**Expected:**
- `status = 'failed'`
- `last_error` matches the demo row's `generation_error`
- `completed_at` is set

**If both rows look like that, `failDemo` is wired correctly.** ✅

---

## 6. Idempotency check (optional)

Verifies that re-dispatching a completed demo doesn't double-process.

### 6a. Re-enqueue a completed demo

```sql
-- Pick any completed demo from a previous test
SELECT id FROM prospect_demos WHERE generation_status = 'completed' ORDER BY completed_at DESC LIMIT 1;

-- Manually re-insert an outbox row pointing at the same demo
INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
SELECT
  gen_random_uuid(),
  'generate_demo',
  'demo',
  '<demoId from above>',
  jsonb_build_object(
    'demoId', '<demoId>',
    'businessName', 'whatever',
    'googlePlaceId', 'ChIJN1t_tDeuEmsRUsoyG83frY4',
    'category', 'cafe',
    'correlation_id', gen_random_uuid()::text
  ),
  'pending';
```

### 6b. Watch the worker logs

Within ~10s the OutboxPoller picks up the new outbox row and dispatches. The worker should log:

```
[DemoGenerationWorker] Demo <demoId> already completed (prospect_demos), completing outbox
```

(That string comes from `lifecycle.ts:claimDemo` — proving the new helper correctly returns `'already_terminal'` for a completed row, and the worker correctly closes the outbox without re-running generation.)

**Expected:** the demo's `generation_status` and `reviews_snapshot` are UNCHANGED. The outbox row moves to `completed`. No duplicate API spend. ✅

---

## 7. Rollback (if anything looks wrong)

If any test fails and you need to back out:

```powershell
# Soft rollback — keep your branch but reset to base
git reset --hard eabd69c
# WARNING: destroys your 11 PR commits. Only run if you intend to start over.

# OR — keep the branch around but stop testing it
git checkout main
git branch -D feat/lifecycle-extraction  # only after pushing/saving the SHA elsewhere
```

If the database has stale `prospect_demos` rows from your testing:

```sql
DELETE FROM prospect_demos WHERE business_name IN ('RepWorth Test Cafe', 'Failure Test');
```

(Adjust to match the test names you used.)

---

## 8. Sign-off checklist before opening the PR

Tick each before running `gh pr create`:

- [ ] `pnpm tsc --noEmit` — zero errors
- [ ] `pnpm lint` — only the 13 pre-existing errors (none in PR #1 files)
- [ ] `npx vitest run src/lib/demos` — 16/16 PASS (lifecycle tests may skip without TEST_DATABASE_POOL_URL — that's fine)
- [ ] Diff inspection of `generator.ts` and `DemoGenerationWorker.ts` — looks like the right shape
- [ ] Mock end-to-end demo creates and renders a 3-review prospect demo
- [ ] (Optional) Real-API end-to-end demo creates and renders ~10-15 review prospect demo
- [ ] Failure-path test → `prospect_demos.generation_status='failed'` with error message
- [ ] (Optional) Idempotency test → re-dispatched outbox short-circuits with `"already completed"` log
- [ ] No `MOCK_EXTERNAL_APIS=true` left in `.env.local` after testing (if it was committed)

If all green, you're clear to open PR #1 against `main`.

---

## Known deferrals to PR #2 (not testable here)

- 23505 race-loser path in `lifecycle.ts:completeDemo` — needs `onboarding_demos` table, has TODO comment in source.
- `'positive-with-moderate-tail'` selection rule end-to-end — used by PR #2's onboarding worker, not the prospect path.
- Curated fallback flow (`getFallbackDemo`) — PR #2 deliverable.

These are documented as TODOs in code and called out in the spec (§3.5, §3.3, §3.9). Their tests ship with PR #2.

---

## Test Results — 2026-05-04

Tested on branch `feat/lifecycle-extraction` at commit `d678b55`.
`MOCK_EXTERNAL_APIS=false`. Next.js on port 3000, worker on port 3001.

### Section 4 — Real-API end-to-end smoke test ✅

**4C. Demo submitted:**
- Business: Sydney Opera House
- Place ID: `ChIJrTLr-GyuEmsRBfy61i59si0` (pasted raw — parser accepted it)

**4D. Worker completion:**
- Completed in ~20 seconds (SerpAPI + parallel LLM calls)
- DB confirms: `generation_status=completed`, `review_count=8`, `response_count=8`, `completed_at=2026-05-04 03:16:46 UTC`
- Outbox row: `status=completed`, `last_error=null`

**4E. Demo page rendered:**
- Header: "Sydney Opera House" ✅
- Stats line: "8 reviews analyzed · 8 AI responses generated" ✅ — full prospect breadth, NOT sliced to 3. Confirms no `selectQualifyingReviews` regression.
- 8 review cards with real review text (mix of 5★ and 1★) and real AI responses ✅
- Rating-only review (no text) rendered correctly ✅
- Slug: `/demo/PY_tXv1amb`

---

### Section 5 — Failure-path verification ✅

**5A. Invalid Place ID submitted:**
- Business: `Failure Test`, Place ID: `ChIJINVALID000000000000000000000`

**5B/5C. DB state after worker processed:**

`prospect_demos`:
- `generation_status = 'failed'` ✅
- `generation_error = "SerpAPI error: Google hasn't returned any results for this query."` ✅
- `completed_at` set ✅

`job_outbox`:
- `status = 'failed'` ✅
- `last_error` matches `generation_error` exactly ✅
- `completed_at` set ✅

`failDemo` is wired correctly — both rows fail atomically and error propagates.

---

### Section 6 — Idempotency check ✅

**6A.** Re-inserted a `pending` outbox row pointing at the completed Sydney Opera House demo (`019df0fc-c4be-76fe-962f-3932e33fa8cb`).

**6B.** Within 10 seconds, outbox row moved to `status=completed`, `last_error=null`.

`prospect_demos` row unchanged: `generation_status=completed`, `review_count=8`, `response_count=8`, `completed_at=2026-05-04 03:16:46 UTC` (same timestamp as original — no re-processing). No duplicate API spend.

`claimDemo` correctly returns `'already_terminal'` for a completed row and the worker closes the outbox without re-running generation.

---

### Overall verdict

All three sections passed. Zero regressions observed on the prospect-demo path. PR #1 is clear to open.
