# Post-Sprint 4 Robustness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 validated correctness, security, and reliability issues found during system-wide code review — without breaking the working system.

**Architecture:** Surgical fixes to existing workers and routes. No new tables, no new workers, no architectural changes. Each task is isolated and can be tested independently. Order is risk-priority descending.

**Tech Stack:** Existing stack — TypeScript, BullMQ, Postgres, Stripe SDK, Vitest, Playwright.

**Validation:** All 10 findings confirmed against source code. See conversation context for the full validation report.

---

## File Map

| File | Tasks | What changes |
|---|---|---|
| `worker/jobs/NotificationWorker.ts` | 1 | Skip link revocation on normal retry when delivery record exists |
| `worker/jobs/ResponseGeneratorWorker.ts` | 2 | Re-check avoid-facts on retry; fail instead of falling back to violation |
| `src/app/api/admin/demos/generate/route.ts` | 3 | Fail-closed rate limit for cost-sensitive demo generation |
| `worker/ingress/stripe.ts` | 4, 5 | Atomic dedup claim; verify payment_status before activation |
| `worker/jobs/OutboxPoller.ts` | 6 | Dispatch outside transaction; two-phase claim-then-dispatch |
| `worker/jobs/WeeklySummaryWorker.ts` | 7 | Record send attempt before email; finalize after success |
| `worker/ingress/resend.ts` | 8 | Reject stale svix-timestamps (>5 min) |
| `src/app/api/admin/payment-success/route.ts` | 9 | Remove fallback to recent business; return 404 if no match |
| `e2e/admin-14b-runtime.spec.ts` | 10 | Use `domcontentloaded` waitUntil |

---

### Task 1: NotificationWorker — Don't revoke live approval links on retry

**Files:**
- Modify: `worker/jobs/NotificationWorker.ts:133-154`

**Problem:** If the email sends (line 161) but the worker crashes before `recordNotificationDelivery` (line 183), BullMQ retries. The retry hits line 138 and revokes the link that's already in the owner's inbox.

**Fix:** Only revoke links when there's no delivery record for this response (orphaned link from a crash before email send). If a delivery record exists with `sent_at IS NOT NULL`, the link in the owner's inbox is live — skip revocation and create a new link alongside it.

- [ ] **Step 1: Modify the revocation logic**

In `worker/jobs/NotificationWorker.ts`, replace the comment and transaction block at lines 133-154 with:

```typescript
  // ── Step 6: Create approval link ──────────────────────────────────
  // Only revoke existing links if NO delivery record exists (orphaned link
  // from a crash before email send). If a delivery exists, the link is live
  // in the owner's inbox — do NOT revoke it on retry.
  const [existingDeliveryForRevoke] = await sql<{ id: string }[]>`
    SELECT id FROM notification_deliveries
    WHERE response_id = ${response_id} AND template = 'approval_request' AND sent_at IS NOT NULL
    LIMIT 1
  `;

  await sql.begin(async (tx) => {
    if (!existingDeliveryForRevoke) {
      // No delivery record → link is orphaned (crash before send). Safe to revoke.
      await tx`
        UPDATE approval_links SET revoked_at = NOW()
        WHERE response_id = ${response_id}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > NOW()
      `;
    }

    await tx`
      INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
      VALUES (
        ${uuidv7()}, ${response_id}, ${business_id}, ${tokenHash}, 'email',
        NOW() + INTERVAL '48 hours'
      )
    `;
  });
```

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run worker/__tests__/NotificationWorker.test.ts`
Expected: All existing tests pass (the mock setup doesn't exercise this path).

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/NotificationWorker.ts
git commit -m "fix(H1): skip approval link revocation on retry when delivery exists"
```

---

### Task 2: ResponseGeneratorWorker — Re-check avoid-facts on retry; fail on persistent violation

**Files:**
- Modify: `worker/jobs/ResponseGeneratorWorker.ts:204-261`

**Problem:** `applyAvoidFactsGuardrail` detects a violation (line 216), regenerates once (line 230-232), but doesn't re-check the retry result (line 256). If the retry also violates, or the retry throws, it falls back to the original violating draft (line 258-259).

**Fix:** Re-run `findAvoidFactViolation()` on the retry result. If it still violates or the retry fails, throw an error instead of returning the violation. The caller (`handleResponseGeneration`) will mark the outbox as failed and the review will get a `review_exception`.

- [ ] **Step 1: Modify the guardrail function**

In `worker/jobs/ResponseGeneratorWorker.ts`, replace lines 256-260 (inside `applyAvoidFactsGuardrail`):

Replace:
```typescript
    return merged;
  } catch {
    console.warn(`${LOG_PREFIX} Avoid-fact retry failed for review ${ids.reviewId}, using original response`);
    return result;
  }
```

With:
```typescript
    // Re-check the retry for violations
    const retryViolation = findAvoidFactViolation(merged.responseText, avoidFacts);
    if (retryViolation) {
      throw new Error(
        `Avoid-fact violation persists after retry for review ${ids.reviewId}: "${retryViolation}"`,
      );
    }

    return merged;
  } catch (err) {
    // Retry failed or still violates — do NOT fall back to the violating draft.
    // Throw so the worker marks this as failed and creates a review exception.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Avoid-fact guardrail failed for review ${ids.reviewId}: ${message}`);
  }
```

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run worker/__tests__/ResponseGeneratorWorker.test.ts`
Expected: All existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ResponseGeneratorWorker.ts
git commit -m "fix(H2): re-check avoid-facts on retry, fail instead of returning violation"
```

---

### Task 3: Demo generation — Fail-closed rate limit

**Files:**
- Modify: `src/app/api/admin/demos/generate/route.ts:28-44`

**Problem:** `checkRateLimit` fails open when Redis is down (lines 33/51 of rate-limit.ts). Demo generation triggers SerpAPI + up to 15 LLM calls — should not run uncapped.

**Fix:** Add a fail-closed wrapper for cost-sensitive routes. If Redis is unavailable, return 503 instead of allowing the request.

- [ ] **Step 1: Add fail-closed rate limit checks**

In `src/app/api/admin/demos/generate/route.ts`, replace the two `checkRateLimit` calls with fail-closed versions. After the auth check (around line 27), replace:

```typescript
  // Rate limit: 50 demos per day globally (cost-sensitive — triggers SerpAPI + LLM)
  const dailyLimit = await checkRateLimit('demo:generate:daily', 50, 86400);
  if (!dailyLimit.allowed) {
    return NextResponse.json(
      { error: 'Daily demo generation limit reached (50/day)' },
      { status: 429 },
    );
  }

  // Rate limit: 5 per minute per IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const minuteLimit = await checkRateLimit(`demo:generate:minute:${ip}`, 5, 60);
  if (!minuteLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many demo generations. Try again in a minute.' },
      { status: 429 },
    );
  }
```

With:

```typescript
  // Rate limits: fail CLOSED for cost-sensitive demo generation.
  // If Redis is unavailable, return 503 instead of allowing uncapped generation.
  if (!process.env.REDIS_CACHE_URL) {
    return NextResponse.json(
      { error: 'Rate limiting unavailable — try again later' },
      { status: 503 },
    );
  }

  try {
    const dailyLimit = await checkRateLimit('demo:generate:daily', 50, 86400);
    if (!dailyLimit.allowed) {
      return NextResponse.json(
        { error: 'Daily demo generation limit reached (50/day)' },
        { status: 429 },
      );
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const minuteLimit = await checkRateLimit(`demo:generate:minute:${ip}`, 5, 60);
    if (!minuteLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many demo generations. Try again in a minute.' },
        { status: 429 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Rate limiting unavailable — try again later' },
      { status: 503 },
    );
  }
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/demos/generate/route.ts
git commit -m "fix(H3): fail-closed rate limit for demo generation when Redis unavailable"
```

---

### Task 4: Stripe webhook — Atomic dedup claim

**Files:**
- Modify: `worker/ingress/stripe.ts:161-188`

**Problem:** Check-then-insert race: two concurrent deliveries of the same event can both pass the SELECT (line 162), both INSERT with ON CONFLICT DO NOTHING (line 176), and both process. The INSERT result isn't checked.

**Fix:** Use a single atomic INSERT...RETURNING for claim. If no row returned, the event was already claimed.

- [ ] **Step 1: Replace check-then-insert with atomic claim**

In `worker/ingress/stripe.ts`, replace lines 161-188 (from `// Check for existing dedup record` to the closing brace of the `if (existing.length === 0)` block) with:

```typescript
  // Atomic dedup: INSERT or skip if already exists.
  // Use RETURNING to detect whether this request won the claim.
  const claimed = await sql`
    INSERT INTO inbound_events (id, source, external_event_key, event_type, payload, status)
    VALUES (
      ${uuidv7()},
      'stripe',
      ${event.id},
      ${event.type},
      ${JSON.stringify(event)}::jsonb,
      'received'
    )
    ON CONFLICT (external_event_key) DO NOTHING
    RETURNING id
  `;

  if (claimed.count === 0) {
    // Already claimed — check if it was processed
    const [existing] = await sql<{ status: string }[]>`
      SELECT status FROM inbound_events WHERE external_event_key = ${event.id}
    `;
    if (existing?.status === 'processed') {
      console.log(`${LOG_PREFIX} Duplicate event ${event.id} already processed — skipping`);
      reply.status(200).send({ received: true, duplicate: true });
      return;
    }
    // Event exists but not processed (received/failed) — skip to avoid double-processing
    console.log(`${LOG_PREFIX} Event ${event.id} already claimed (status=${existing?.status}) — skipping`);
    reply.status(200).send({ received: true, duplicate: true });
    return;
  }
```

- [ ] **Step 2: Run existing webhook dedup tests**

Run: `npx vitest run worker/__tests__/webhook-dedup.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add worker/ingress/stripe.ts
git commit -m "fix(H4): atomic dedup claim in Stripe webhook — no check-then-insert race"
```

---

### Task 5: Stripe checkout — Verify payment status before activation

**Files:**
- Modify: `worker/ingress/stripe.ts:29-53`

**Problem:** `processCheckoutSessionCompleted` sets `subscription_status = 'active'` without checking `session.payment_status`. A checkout session can complete with `payment_status: 'unpaid'` (e.g., failed async payment).

**Fix:** Check `session.payment_status === 'paid'` and `session.mode === 'subscription'` before activating.

- [ ] **Step 1: Add payment status checks**

In `worker/ingress/stripe.ts`, in `processCheckoutSessionCompleted`, add validation after extracting IDs (after line 37):

```typescript
  // Only activate for subscription-mode sessions with confirmed payment
  if (session.mode !== 'subscription') {
    console.warn(`${LOG_PREFIX} checkout.session.completed mode=${session.mode} (not subscription) — skipping activation`);
    return;
  }

  if (session.payment_status !== 'paid') {
    console.warn(`${LOG_PREFIX} checkout.session.completed payment_status=${session.payment_status} (not paid) — skipping activation for business ${businessId}`);
    return;
  }
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run worker/__tests__/webhook-dedup.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add worker/ingress/stripe.ts
git commit -m "fix(H5): verify payment_status=paid and mode=subscription before activating business"
```

---

### Task 6: OutboxPoller — Dispatch outside transaction

**Files:**
- Modify: `worker/jobs/OutboxPoller.ts:72-166`

**Problem:** `queue.add()` runs inside a DB transaction (line 116). If the DB update fails after BullMQ accepts the job, the transaction rolls back but the job exists in Redis. The watchdog eventually recovers it, but it's a reliability gap.

**Fix:** Two-phase approach: (1) claim rows by setting `status = 'dispatching'` and commit, (2) dispatch to BullMQ outside the transaction, (3) mark `dispatched` or recover failed dispatches.

- [ ] **Step 1: Rewrite Phase 2 dispatch logic**

Replace the entire Phase 2 block (lines 72-166) in `worker/jobs/OutboxPoller.ts` with:

```typescript
    // ── Phase 2: Claim pending rows ──────────────────────────────────
    const entries = await sql<OutboxEntry[]>`
      UPDATE job_outbox
      SET status = 'dispatching', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM job_outbox
        WHERE status = 'pending'
          AND available_at <= NOW()
        ORDER BY available_at
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, topic, payload, attempts, max_attempts
    `;

    if (entries.length === 0) return;

    console.log(`[OutboxPoller] Found ${entries.length} pending entries`);

    // ── Phase 3: Dispatch to BullMQ (outside transaction) ────────────
    for (const entry of entries) {
      const queue = topicToQueue[entry.topic];

      if (!queue) {
        console.error(`[OutboxPoller] Unknown topic "${entry.topic}" for outbox entry ${entry.id}`);
        await sql`
          UPDATE job_outbox
          SET status = 'failed',
              last_error = ${'Unknown topic: ' + entry.topic}
          WHERE id = ${entry.id}
        `;
        continue;
      }

      try {
        const payload = typeof entry.payload === 'string'
          ? JSON.parse(entry.payload) as Record<string, unknown>
          : entry.payload;

        const jobId = `${entry.id}_${entry.attempts}`;
        await queue.add(entry.topic, { ...payload, outbox_id: entry.id }, { jobId });

        Sentry.addBreadcrumb({
          category: 'outbox',
          message: `Dispatched ${entry.topic} (${entry.id})`,
          level: 'info',
        });

        await sql`
          UPDATE job_outbox
          SET status = 'dispatched', dispatched_at = NOW()
          WHERE id = ${entry.id}
        `;
      } catch (dispatchError) {
        console.error(
          `[OutboxPoller] Failed to dispatch entry ${entry.id} (topic=${entry.topic}):`,
          dispatchError,
        );

        Sentry.addBreadcrumb({
          category: 'outbox',
          message: `Dispatch failed ${entry.topic} (${entry.id})`,
          level: 'error',
        });

        const errorMsg = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
        if (entry.attempts >= entry.max_attempts) {
          console.error(
            `[OutboxPoller] Entry ${entry.id} exceeded max_attempts (${entry.max_attempts}), marking as failed`,
          );
          await sql`
            UPDATE job_outbox
            SET status = 'failed', last_error = ${errorMsg}
            WHERE id = ${entry.id}
          `;
        } else {
          // Reset to pending for next poll cycle
          await sql`
            UPDATE job_outbox
            SET status = 'pending', last_error = ${errorMsg}
            WHERE id = ${entry.id}
          `;
        }
      }
    }
```

Also update the Phase 1 watchdog to recover `dispatching` rows (add after the existing terminated CTE around line 45):

In the watchdog section, add a third CTE to recover stale `dispatching` rows (claimed but never dispatched — process crashed between claim and dispatch):

```sql
-- Recover stale 'dispatching' rows (claimed but process crashed before dispatch)
const [staleDispatching] = await tx<{ count: string }[]>`
  WITH recovered_dispatching AS (
    UPDATE job_outbox
    SET status = 'pending', available_at = NOW()
    WHERE status = 'dispatching'
      AND updated_at < NOW() - INTERVAL '5 minutes'
    RETURNING id
  )
  SELECT COUNT(*)::text AS count FROM recovered_dispatching
`;
```

Note: This requires adding an `updated_at` trigger or using `attempts` timestamp. Since the OutboxPoller already updates `attempts` during claim, we can use a simpler approach: recover `dispatching` rows older than 5 minutes based on the assumption that dispatch takes < 5 minutes.

**Simpler approach:** Just include `'dispatching'` in the existing watchdog recovery for stuck rows. Add `OR (status = 'dispatching' AND attempts > 0)` to the watchdog's `dispatched` recovery CTE condition. The `dispatching` state is transient (seconds), so any row stuck in it is crashed.

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/OutboxPoller.ts
git commit -m "fix(M6): dispatch BullMQ jobs outside DB transaction — two-phase claim+dispatch"
```

---

### Task 7: WeeklySummaryWorker — Prevent duplicate email on crash

**Files:**
- Modify: `worker/jobs/WeeklySummaryWorker.ts:110-144`

**Problem:** Email sends (line 126) before `sent_at` is marked (line 137). Crash in the gap causes duplicate emails on retry.

**Fix:** Set `sent_at = NOW()` BEFORE sending email. If the email fails, the thrown error triggers BullMQ retry. On retry, the idempotent upsert sees `sent_at IS NOT NULL` and the worker skips (the existing check at the top of the function handles this). If the email succeeds but the process crashes before `markOutboxCompleted`, the outbox watchdog retries, but the worker sees `sent_at IS NOT NULL` and skips cleanly.

- [ ] **Step 1: Move sent_at update before email send**

In `worker/jobs/WeeklySummaryWorker.ts`, move the `sent_at` update (lines 137-141) to BEFORE the email send (before line 126):

```typescript
  // ── 5. Mark as sent BEFORE sending (crash-safe) ───────────────────
  // If email send fails, BullMQ retries. On retry, the worker sees
  // sent_at IS NOT NULL and skips. If we need to re-send, the admin
  // can reset sent_at manually or create a new outbox entry.
  await sql`
    UPDATE weekly_summaries
    SET sent_at = NOW()
    WHERE business_id = ${business_id} AND week_start_date = ${week_start_date}::date
  `;

  // ── 6. Send email ─────────────────────────────────────────────────
  const weekLabel = `${week_start_date} to ${weekEndDate}`;
  try {
    await sendInternalEmail({
      to: business.owner_email,
      subject: `Weekly Review Summary — ${business.name} (${weekLabel})`,
      bodyHtml: html,
    });
  } catch (err) {
    // Email failed — sent_at is already set, so retry won't re-send.
    // Log the error but mark outbox as failed (admin can investigate).
    console.error(`${LOG_PREFIX} Failed to send weekly summary for ${business.name} (week ${week_start_date}): ${err instanceof Error ? err.message : err}`);
    await markOutboxFailed(outboxId, err instanceof Error ? err.message : String(err));
    return;
  }

  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Weekly summary sent for ${business.name} (week ${week_start_date})`);
```

Remove the old send + mark blocks (the original lines 124-144).

- [ ] **Step 2: Run tests**

Run: `npx vitest run worker/__tests__/WeeklySummaryWorker.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/WeeklySummaryWorker.ts
git commit -m "fix(M7): mark weekly summary sent before email to prevent duplicates on crash"
```

---

### Task 8: Resend webhook — Reject stale timestamps

**Files:**
- Modify: `worker/ingress/resend.ts:38-40`

**Problem:** `svix-timestamp` is used in signature verification but not checked for freshness. Old signed payloads can be replayed after archival deletes the `inbound_events` dedup record.

**Fix:** Reject timestamps older than 5 minutes.

- [ ] **Step 1: Add timestamp freshness check**

In `worker/ingress/resend.ts`, in `verifySignature`, after the null check for svix headers (after line 40), add:

```typescript
  // Reject stale timestamps to prevent replay attacks after archival
  const timestampSeconds = parseInt(svixTimestamp, 10);
  if (Number.isNaN(timestampSeconds)) {
    return false;
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - timestampSeconds;
  if (ageSeconds > 300 || ageSeconds < -60) {
    // More than 5 minutes old or more than 1 minute in the future (clock skew tolerance)
    console.warn(`${LOG_PREFIX} Stale svix-timestamp: age=${ageSeconds}s — rejecting`);
    return false;
  }
```

- [ ] **Step 2: Run existing webhook tests**

Run: `npx vitest run worker/__tests__/webhook-dedup.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add worker/ingress/resend.ts
git commit -m "fix(M8): reject stale svix-timestamps in Resend webhook (>5min replay protection)"
```

---

### Task 9: Payment success — Remove fallback to recent business

**Files:**
- Modify: `src/app/api/admin/payment-success/route.ts:60-73`

**Problem:** Falls back to "most recently activated business within 5 minutes" which can return the wrong business during concurrent checkouts.

**Fix:** Remove the fallback. Return 404 if the session can't be matched by event data. The client already polls and handles 404 gracefully.

- [ ] **Step 1: Remove the fallback**

In `src/app/api/admin/payment-success/route.ts`, delete lines 60-73 (from the `// Fallback:` comment through the `if (recentBiz)` block).

The final code after the `if (event)` block should simply be:

```typescript
  // Not found yet — webhook may still be processing
  return NextResponse.json({ error: 'Business not found yet' }, { status: 404 });
```

- [ ] **Step 2: Verify client handles 404**

The client at `src/app/admin/payment-success/page.tsx` already retries on non-200 responses (line 44 `setTimeout(checkBusiness, 2000)`), so this is safe.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/payment-success/route.ts
git commit -m "fix(M9): remove payment-success fallback to recent business — match by session only"
```

---

### Task 10: E2E tests — Use `domcontentloaded` waitUntil

**Files:**
- Modify: `e2e/admin-14b-runtime.spec.ts:19,29`

**Problem:** `page.goto()` uses default `load` waitUntil which can timeout when external resources (fonts, analytics) are slow.

**Fix:** Use `{ waitUntil: 'domcontentloaded' }` for faster, more reliable navigation.

- [ ] **Step 1: Update goto calls**

In `e2e/admin-14b-runtime.spec.ts`:

Line 19: Change `await page.goto('/admin/login');` to:
```typescript
    await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
```

Line 29: Change `await page.goto(path);` to:
```typescript
      await page.goto(path, { waitUntil: 'domcontentloaded' });
```

- [ ] **Step 2: Commit**

```bash
git add e2e/admin-14b-runtime.spec.ts
git commit -m "fix(L10): use domcontentloaded waitUntil in E2E tests for reliability"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All 253+ tests pass.

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | grep -iE "error|compiled"`
Expected: `Compiled successfully`

- [ ] **Step 3: Start worker and verify no crashes**

Run: `pnpm worker`
Expected: All 8 workers + pollers start cleanly. No new errors in logs.
