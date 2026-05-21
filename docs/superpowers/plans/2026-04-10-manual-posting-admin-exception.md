# Manual Posting + AdminExceptionWorker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SerpAPI-mode posting workflow: ResponsePublisherWorker sends manual-post instructions to the sales partner via email, AdminExceptionWorker alerts on review edits after posting, and a minimal admin business detail page lets the sales partner copy responses and mark them as posted.

**Architecture:** The ResponsePublisherWorker consumes `publish_response` jobs after approval. In SerpAPI mode (no GBP API), it sets the response to `awaiting_manual_post` and emails the admin/sales partner with the approved text + Google Maps link. The AdminExceptionWorker consumes `notify_admin_review_exception` jobs and emails alerts when a reviewer edits their review after a response was already posted. The admin business detail page shows responses awaiting manual posting with copy-to-clipboard and mark-as-posted buttons.

**Tech Stack:** Postgres.js, Resend (via existing `email.ts` infrastructure), BullMQ, Next.js server components, Tailwind CSS

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `.env.example` | Modify | Add ADMIN_NOTIFICATION_EMAIL |
| `src/lib/notifications/email.ts` | Modify | Add `sendInternalEmail()` for admin notifications |
| `worker/jobs/ResponsePublisherWorker.ts` | Create | Process publish_response: set awaiting_manual_post, email admin |
| `worker/jobs/AdminExceptionWorker.ts` | Create | Process notify_admin_review_exception: email admin about review edits |
| `worker/index.ts` | Modify | Register both new workers |
| `src/app/admin/businesses/[id]/page.tsx` | Replace | Server component: business detail + awaiting manual post list |
| `src/app/api/admin/businesses/[id]/mark-posted/route.ts` | Create | POST: mark response as posted |
| `worker/__tests__/ResponsePublisherWorker.test.ts` | Create | Unit tests |
| `worker/__tests__/AdminExceptionWorker.test.ts` | Create | Unit tests |

---

### Task 1: Add ADMIN_NOTIFICATION_EMAIL to env files + sendInternalEmail helper

**Files:**
- Modify: `.env.example`
- Modify: `src/lib/notifications/email.ts`
- Modify: `src/lib/notifications/index.ts`

- [ ] **Step 1: Add env var to .env.example**

After RESEND_FROM_EMAIL:
```
ADMIN_NOTIFICATION_EMAIL=your-admin@email.com
```

- [ ] **Step 2: Add sendInternalEmail to email.ts**

A simple HTML email sender for admin notifications (manual post instructions, exception alerts). Reuses the Resend singleton and mock mode from the existing module.

```typescript
export interface InternalEmailParams {
  to: string;
  subject: string;
  bodyHtml: string;
}

export async function sendInternalEmail(
  params: InternalEmailParams,
): Promise<{ messageId: string }> {
  const from = process.env.RESEND_FROM_EMAIL ?? 'RepWorth <notifications@repworth.com>';

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Internal email to=${params.to} subject="${params.subject}" messageId=${mockId}`);
    return { messageId: mockId };
  }

  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from,
    to: params.to,
    subject: params.subject,
    html: params.bodyHtml,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
```

- [ ] **Step 3: Update barrel exports**

Add to `src/lib/notifications/index.ts`:
```typescript
export { sendInternalEmail } from './email';
export type { InternalEmailParams } from './email';
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

---

### Task 2: Create ResponsePublisherWorker

**Files:**
- Create: `worker/jobs/ResponsePublisherWorker.ts`

- [ ] **Step 1: Create the worker**

Key logic:
1. Read response (with approved_text) + review + business from DB
2. Subscription guard with workerType `'publisher'` — skips cancelled and pending_payment
3. Idempotency: if response is already `awaiting_manual_post` or `posted`, markOutboxCompleted and return
4. UPDATE response status to `awaiting_manual_post`
5. Determine admin email: query users table for admin/sales_partner, fall back to ADMIN_NOTIFICATION_EMAIL
6. Send internal email with: business name, reviewer + rating, approved text, Google Maps URL, copy-paste instructions
7. markOutboxCompleted — if email fails, throw for BullMQ retry (response is already awaiting_manual_post, so retry is safe)

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

---

### Task 3: Create AdminExceptionWorker

**Files:**
- Create: `worker/jobs/AdminExceptionWorker.ts`

- [ ] **Step 1: Create the worker**

Key logic:
1. Read exception from review_exceptions joined with reviews + businesses
2. If exception status != 'open': markOutboxCompleted, return (already resolved)
3. Parse payload (JSONB guard) for old/new content hash, response status
4. Send email to ADMIN_NOTIFICATION_EMAIL explaining what happened
5. markOutboxCompleted

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

---

### Task 4: Register both workers in worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add imports**

```typescript
import { handlePublishResponse } from './jobs/ResponsePublisherWorker';
import { handleAdminException } from './jobs/AdminExceptionWorker';
```

- [ ] **Step 2: Create workers and add to array**

```typescript
const publisherWorker = new Worker(QUEUE_NAMES.PUBLISH_RESPONSE, handlePublishResponse, {
  connection: redisOpts,
});

const adminExceptionWorker = new Worker(QUEUE_NAMES.NOTIFY_ADMIN, handleAdminException, {
  connection: redisOpts,
});

const workers = [demoWorker, reviewSyncWorker, responseGenWorker, notificationWorker, publisherWorker, adminExceptionWorker];
```

- [ ] **Step 3: Verify types and tests pass**

Run: `npx tsc --noEmit && pnpm test`

---

### Task 5: Build admin business detail page + mark-posted API

**Files:**
- Replace: `src/app/admin/businesses/[id]/page.tsx`
- Create: `src/app/api/admin/businesses/[id]/mark-posted/route.ts`

- [ ] **Step 1: Replace business detail page**

Server component that reads business + responses awaiting manual post from DB. Shows business info, then a list of responses needing manual posting with copy-to-clipboard and mark-as-posted buttons (client component for interactivity).

- [ ] **Step 2: Create mark-posted API route**

POST route protected by existing admin middleware:
```typescript
UPDATE responses SET status = 'posted', posted_at = NOW()
WHERE id = $responseId AND business_id = $businessId AND status = 'awaiting_manual_post'
```
Returns 200 on success, 404 if not found or wrong status.

- [ ] **Step 3: Verify build succeeds**

Run: `npx tsc --noEmit && pnpm build`

---

### Task 6: Write unit tests

**Files:**
- Create: `worker/__tests__/ResponsePublisherWorker.test.ts`
- Create: `worker/__tests__/AdminExceptionWorker.test.ts`

ResponsePublisherWorker tests:
1. Success: sets awaiting_manual_post, sends email, completes outbox
2. Subscription cancelled: skips, completes outbox
3. Already posted: idempotent skip, completes outbox
4. Email failure: throws for BullMQ retry

AdminExceptionWorker tests:
1. Success: sends admin email, completes outbox
2. Already resolved exception: skips, completes outbox
3. Email failure: throws for BullMQ retry

- [ ] **Step 1: Create both test files**
- [ ] **Step 2: Run tests**

Run: `pnpm test`

---

### Task 7: Final verification + tracking

- [ ] **Step 1: Full verification**

Run: `npx tsc --noEmit && pnpm test && pnpm build`

- [ ] **Step 2: Update tracking files**

Update `.claude/CLAUDE.md` and `docs/progresstracking.md` with Prompt 13 completion.
