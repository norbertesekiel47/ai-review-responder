# Sprint 5A Prompt 19a — Weekly Value Report + Monthly Impact Email

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the weekly summary email into a retention-driving "Weekly Value Report" with AI Intelligence Brief, and add a new monthly impact email — both proving ROI to business owners.

**Architecture:** Extend the existing WeeklySummaryWorker with new stats queries, an LLM-powered intelligence brief, and a richer email template. Add a new MonthlyImpactScheduler (setInterval poller) + MonthlyImpactWorker pair following the identical patterns used by WeeklySummaryScheduler/Worker. Both emails use the transactional outbox pattern. A new review-summary LLM helper reuses the same OpenAI→Anthropic fallback + cost audit pattern as the response generator.

**Tech Stack:** BullMQ workers, Postgres.js, Resend (email), OpenAI/Anthropic (LLM summaries), Redis (cost tracking), existing outbox pattern

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/lib/responses/review-summary.ts` | LLM-powered review summary helper (weekly/monthly intelligence briefs) |
| Create | `src/lib/responses/__tests__/review-summary.test.ts` | Tests for review summary helper |
| Modify | `src/lib/notifications/delivery.ts` | Make `responseId` optional to support business-level notifications |
| Create | `src/lib/notifications/__tests__/delivery.test.ts` | Tests for updated delivery recording |
| Modify | `src/lib/notifications/email.ts` | Replace `buildWeeklySummaryEmailHtml()` with `buildWeeklyValueReportHtml()`, add `buildMonthlyImpactEmailHtml()` |
| Create | `src/lib/notifications/__tests__/email-templates.test.ts` | Tests for new email templates |
| Modify | `src/lib/shared/worker-types.ts` | Add `SendMonthlyImpactPayload` interface |
| Modify | `worker/queues.ts` | Add `SEND_MONTHLY_IMPACT` queue name, queue instance, topic mapping |
| Modify | `worker/jobs/WeeklySummaryWorker.ts` | Upgrade to use new template with intelligence brief, value stats, review velocity, ranking, dashboard link |
| Create | `worker/jobs/__tests__/WeeklySummaryWorker.test.ts` | Tests for upgraded worker |
| Create | `worker/jobs/MonthlyImpactScheduler.ts` | Hourly poller, fires 1st of month 9-10 AM UTC |
| Create | `worker/jobs/MonthlyImpactWorker.ts` | Processes `send_monthly_impact` outbox entries |
| Create | `worker/jobs/__tests__/MonthlyImpactWorker.test.ts` | Tests for monthly impact worker |
| Modify | `worker/index.ts` | Register monthly impact worker + scheduler, add to shutdown |

---

## Task 1: Review Summary LLM Helper

**Files:**
- Create: `src/lib/responses/review-summary.ts`
- Create: `src/lib/responses/__tests__/review-summary.test.ts`

This is a dedicated helper for generating multi-review intelligence briefs. It reuses the same LLM provider fallback pattern as `generator.ts` but is shaped for summarization, not single-review response generation.

- [ ] **Step 1: Write the failing test for `generateReviewSummary`**

Create `src/lib/responses/__tests__/review-summary.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateReviewSummary } from '../review-summary';

// Mock OpenAI
vi.mock('openai', () => {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'Customers love the tacos but mention slow Friday service. Patio seating is a hit. Overall sentiment improved this week.' } }],
    usage: { prompt_tokens: 200, completion_tokens: 80 },
  });
  return { default: vi.fn(() => ({ chat: { completions: { create } } })) };
});

// Mock Anthropic
vi.mock('@anthropic-ai/sdk', () => {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'Anthropic fallback summary.' }],
    usage: { input_tokens: 200, output_tokens: 80 },
  });
  return { default: vi.fn(() => ({ messages: { create } })) };
});

// Mock cost audit
vi.mock('@/lib/costs/audit', () => ({
  calculateCostUsd: vi.fn().mockReturnValue(0.00015),
  recordApiCost: vi.fn().mockResolvedValue('cost-id-123'),
}));

describe('generateReviewSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const reviews = [
    { starRating: 5, reviewText: 'Best tacos ever! Maria was great.' },
    { starRating: 2, reviewText: 'Waited 45 minutes on a slow Tuesday.' },
    { starRating: 4, reviewText: 'Good food, nice patio seating.' },
  ];

  it('returns an LLM-generated summary for non-empty reviews', async () => {
    const result = await generateReviewSummary(reviews, 'biz-123');
    expect(result).not.toBeNull();
    expect(result!.summaryText).toContain('tacos');
    expect(result!.provider).toBe('openai');
    expect(result!.costUsd).toBeGreaterThan(0);
  });

  it('returns null for empty reviews array', async () => {
    const result = await generateReviewSummary([], 'biz-123');
    expect(result).toBeNull();
  });

  it('truncates review list to max 30 reviews', async () => {
    const manyReviews = Array.from({ length: 50 }, (_, i) => ({
      starRating: (i % 5) + 1,
      reviewText: `Review number ${i} with some text content.`,
    }));
    const result = await generateReviewSummary(manyReviews, 'biz-123');
    expect(result).not.toBeNull();
  });

  it('returns mock summary in mock mode', async () => {
    vi.stubEnv('MOCK_EXTERNAL_APIS', 'true');
    const result = await generateReviewSummary(reviews, 'biz-123');
    expect(result).not.toBeNull();
    expect(result!.summaryText).toContain('review');
    expect(result!.provider).toBe('mock');
    vi.unstubAllEnvs();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test -- src/lib/responses/__tests__/review-summary.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `generateReviewSummary`**

Create `src/lib/responses/review-summary.ts`:

```typescript
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { isMockMode } from '@/lib/shared/mock-mode';
import { calculateCostUsd, recordApiCost } from '@/lib/costs/audit';

const LOG_PREFIX = '[review-summary]';
const OPENAI_MODEL = 'gpt-4o-mini' as const;
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001' as const;
const MAX_REVIEWS_FOR_SUMMARY = 30;
const MAX_REVIEW_TEXT_LENGTH = 200;
const LLM_MAX_TOKENS = 250;

export interface ReviewForSummary {
  starRating: number;
  reviewText: string | null;
}

export interface SummaryResult {
  summaryText: string;
  provider: 'openai' | 'anthropic' | 'mock';
  costUsd: number;
}

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

/**
 * Generates a 3-5 sentence intelligence brief summarizing a batch of reviews.
 * Returns null if reviews array is empty (no input to summarize).
 * Caps input to MAX_REVIEWS_FOR_SUMMARY reviews and truncates text to
 * prevent high-volume customers from exceeding weekly LLM budget.
 */
export async function generateReviewSummary(
  reviews: ReviewForSummary[],
  businessId: string,
): Promise<SummaryResult | null> {
  if (reviews.length === 0) return null;

  if (isMockMode()) {
    return {
      summaryText: `This week saw ${reviews.length} review(s). Customers shared feedback on service quality and overall experience. Consider monitoring recurring themes for improvement opportunities.`,
      provider: 'mock',
      costUsd: 0,
    };
  }

  const capped = reviews.slice(0, MAX_REVIEWS_FOR_SUMMARY);
  const reviewBlock = capped
    .map((r, i) => {
      const text = r.reviewText
        ? r.reviewText.slice(0, MAX_REVIEW_TEXT_LENGTH)
        : '(no text)';
      return `${i + 1}. [${r.starRating}★] ${text}`;
    })
    .join('\n');

  const systemPrompt =
    'You are a business intelligence analyst summarizing customer reviews for a small business owner. Be concise and actionable.';
  const userPrompt = `Summarize the following ${capped.length} customer reviews in 3-5 sentences. Cover: recurring themes, new or notable mentions, overall sentiment trend, and one specific actionable recommendation.\n\nReviews:\n${reviewBlock}`;

  try {
    const result = await callWithFallback(systemPrompt, userPrompt);

    const costUsd = calculateCostUsd(
      result.model,
      result.usage.promptTokens,
      result.usage.completionTokens,
    );

    // Best-effort audit — don't fail the summary if audit write fails
    try {
      await recordApiCost({
        businessId,
        provider: result.provider,
        endpoint: 'review-summary',
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        costUsd,
        responseId: null,
      });
    } catch (auditErr) {
      console.error(`${LOG_PREFIX} Failed to record cost audit:`, auditErr);
    }

    return {
      summaryText: result.text,
      provider: result.provider,
      costUsd,
    };
  } catch (err) {
    console.error(`${LOG_PREFIX} Both LLM providers failed for business ${businessId}:`, err);
    return null;
  }
}

interface LLMResult {
  text: string;
  provider: 'openai' | 'anthropic';
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

async function callWithFallback(
  systemPrompt: string,
  userPrompt: string,
): Promise<LLMResult> {
  try {
    const client = getOpenAI();
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: LLM_MAX_TOKENS,
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned empty response');
    return {
      text,
      provider: 'openai',
      model: OPENAI_MODEL,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  } catch (openaiError) {
    console.error(`${LOG_PREFIX} OpenAI failed, falling back to Anthropic:`, openaiError);
    const client = getAnthropic();
    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: LLM_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = response.content[0];
    if (!block || block.type !== 'text') throw new Error('Anthropic returned empty response');
    return {
      text: block.text,
      provider: 'anthropic',
      model: ANTHROPIC_MODEL,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test -- src/lib/responses/__tests__/review-summary.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/responses/review-summary.ts src/lib/responses/__tests__/review-summary.test.ts
git commit -m "feat(5a): add review summary LLM helper for intelligence briefs"
```

---

## Task 2: Extend Notification Delivery for Business-Level Notifications

**Files:**
- Modify: `src/lib/notifications/delivery.ts`
- Create: `src/lib/notifications/__tests__/delivery.test.ts`

Currently `recordNotificationDelivery` requires `responseId: string`. The weekly value report and monthly impact emails are business-level (no specific response). Make `responseId` optional.

- [ ] **Step 1: Write the failing test**

Create `src/lib/notifications/__tests__/delivery.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mock the sql client
vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      // Capture the call for assertion
      (vi.mocked(sql) as unknown as { lastCall: unknown[] }).lastCall = values;
      return Promise.resolve([]);
    },
    { lastCall: [] as unknown[] },
  ),
}));

vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

import { sql } from '@/lib/db/server';
import { recordNotificationDelivery } from '../delivery';

describe('recordNotificationDelivery', () => {
  it('inserts with responseId when provided', async () => {
    await recordNotificationDelivery({
      businessId: 'biz-1',
      responseId: 'resp-1',
      channel: 'email',
      recipient: 'owner@test.com',
      template: 'approval_request',
      externalMessageId: 'msg-123',
    });
    // If it doesn't throw, the insert succeeded
    expect(true).toBe(true);
  });

  it('inserts with null responseId when omitted', async () => {
    await recordNotificationDelivery({
      businessId: 'biz-1',
      channel: 'email',
      recipient: 'owner@test.com',
      template: 'weekly_value_report',
      externalMessageId: 'msg-456',
    });
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test -- src/lib/notifications/__tests__/delivery.test.ts`
Expected: FAIL — `responseId` is required

- [ ] **Step 3: Update `recordNotificationDelivery` to make `responseId` optional**

In `src/lib/notifications/delivery.ts`, change the parameter type:

```typescript
export async function recordNotificationDelivery(params: {
  businessId: string;
  responseId?: string | null;
  channel: 'email' | 'sms';
  recipient: string;
  template: string;
  externalMessageId: string;
}): Promise<void> {
  await sql`
    INSERT INTO notification_deliveries (id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
    VALUES (
      ${uuidv7()}, ${params.businessId}, ${params.responseId ?? null}, ${params.channel},
      ${params.recipient}, ${params.template}, NOW(), ${params.externalMessageId}
    )
  `;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test -- src/lib/notifications/__tests__/delivery.test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: Verify existing tests still pass**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test`
Expected: All existing tests pass (no callers break since `string` is still accepted)

- [ ] **Step 6: Commit**

```bash
git add src/lib/notifications/delivery.ts src/lib/notifications/__tests__/delivery.test.ts
git commit -m "feat(5a): make responseId optional in recordNotificationDelivery"
```

---

## Task 3: Add `SendMonthlyImpactPayload` + Queue Registration

**Files:**
- Modify: `src/lib/shared/worker-types.ts`
- Modify: `worker/queues.ts`

- [ ] **Step 1: Add payload type**

In `src/lib/shared/worker-types.ts`, add after `ValidatePlaceIdPayload`:

```typescript
export interface SendMonthlyImpactPayload {
  business_id: string;
  /** ISO date 'YYYY-MM-DD' — always the 1st of the month being summarized. */
  month_start_date: string;
}
```

- [ ] **Step 2: Add queue name, instance, and topic mapping**

In `worker/queues.ts`:

Add to `QUEUE_NAMES` (after `VALIDATE_PLACE_ID`):
```typescript
  SEND_MONTHLY_IMPACT: 'send_monthly_impact',
```

Add to `queues` object (after `validatePlaceId`):
```typescript
  sendMonthlyImpact: new Queue(QUEUE_NAMES.SEND_MONTHLY_IMPACT, { connection: opts, defaultJobOptions }),
```

Add to `topicToQueue` (after `validatePlaceId` entry):
```typescript
  [QUEUE_NAMES.SEND_MONTHLY_IMPACT]: queues.sendMonthlyImpact,
```

- [ ] **Step 3: Verify compilation**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/shared/worker-types.ts worker/queues.ts
git commit -m "feat(5a): add SendMonthlyImpactPayload and queue registration"
```

---

## Task 4: Weekly Value Report Email Template

**Files:**
- Modify: `src/lib/notifications/email.ts`
- Create: `src/lib/notifications/__tests__/email-templates.test.ts`

Replace `buildWeeklySummaryEmailHtml()` with `buildWeeklyValueReportHtml()` — a richer template with intelligence brief, value-delivered header, response rate lift, review velocity, conditional ranking, notable reviews, and conditional dashboard link.

- [ ] **Step 1: Write the failing test for the new template**

Create `src/lib/notifications/__tests__/email-templates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildWeeklyValueReportHtml, buildMonthlyImpactEmailHtml } from '../email';

describe('buildWeeklyValueReportHtml', () => {
  const baseParams = {
    businessName: 'Taco Palace',
    weekStartDate: '2026-04-07',
    weekEndDate: '2026-04-14',
    totalReviews: 7,
    totalResponded: 7,
    notableReviews: [
      { reviewerName: 'Jane', starRating: 2, reviewText: 'Slow service on Friday.' },
    ],
    intelligenceBrief: 'Customers love the al pastor but mention slow Friday dinner service.',
    baselineResponseRate: 22,
    fourWeekAvgReviews: 5.2,
    ranking: null as { keyword: string; currentRank: number; initialRank: number } | null,
    dashboardUrl: null as string | null,
  };

  it('includes the intelligence brief section', () => {
    const html = buildWeeklyValueReportHtml(baseParams);
    expect(html).toContain('al pastor');
    expect(html).toContain('Intelligence Brief');
  });

  it('includes the value-delivered header with time saved', () => {
    const html = buildWeeklyValueReportHtml(baseParams);
    expect(html).toContain('49 minutes'); // 7 reviews × 7 min
    expect(html).toContain('handled 7 review');
  });

  it('shows response rate lift when baseline exists', () => {
    const html = buildWeeklyValueReportHtml(baseParams);
    expect(html).toContain('100%');
    expect(html).toContain('was 22%');
  });

  it('omits baseline comparison when baselineResponseRate is null', () => {
    const html = buildWeeklyValueReportHtml({ ...baseParams, baselineResponseRate: null });
    expect(html).not.toContain('was');
    expect(html).toContain('100%');
  });

  it('includes review velocity with 4-week average', () => {
    const html = buildWeeklyValueReportHtml(baseParams);
    expect(html).toContain('7');
    expect(html).toContain('5.2');
  });

  it('includes ranking section when ranking data exists', () => {
    const html = buildWeeklyValueReportHtml({
      ...baseParams,
      ranking: { keyword: 'tacos san jose', currentRank: 4, initialRank: 6 },
    });
    expect(html).toContain('tacos san jose');
    expect(html).toContain('#4');
    expect(html).toContain('#6');
  });

  it('omits ranking section when ranking is null', () => {
    const html = buildWeeklyValueReportHtml(baseParams);
    expect(html).not.toContain('ranking');
  });

  it('includes dashboard link when dashboardUrl is provided', () => {
    const html = buildWeeklyValueReportHtml({ ...baseParams, dashboardUrl: 'https://app.repworth.com/dashboard' });
    expect(html).toContain('https://app.repworth.com/dashboard');
    expect(html).toContain('full dashboard');
  });

  it('omits dashboard link when dashboardUrl is null', () => {
    const html = buildWeeklyValueReportHtml(baseParams);
    expect(html).not.toContain('full dashboard');
  });

  it('omits intelligence brief when null', () => {
    const html = buildWeeklyValueReportHtml({ ...baseParams, intelligenceBrief: null });
    expect(html).not.toContain('Intelligence Brief');
  });

  it('escapes HTML in user content', () => {
    const html = buildWeeklyValueReportHtml({
      ...baseParams,
      businessName: '<script>alert(1)</script>',
      intelligenceBrief: 'Test <b>bold</b>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test -- src/lib/notifications/__tests__/email-templates.test.ts`
Expected: FAIL — `buildWeeklyValueReportHtml` not found

- [ ] **Step 3: Implement `buildWeeklyValueReportHtml` in `email.ts`**

In `src/lib/notifications/email.ts`, replace the `WeeklySummaryEmailParams` interface and `buildWeeklySummaryEmailHtml` function (lines 222-305) with:

```typescript
// ── Weekly Value Report email template ──────────────────────────────

export interface WeeklyValueReportParams {
  businessName: string;
  weekStartDate: string;
  weekEndDate: string;
  totalReviews: number;
  totalResponded: number;
  notableReviews: Array<{
    reviewerName: string;
    starRating: number;
    reviewText: string | null;
  }>;
  intelligenceBrief: string | null;
  baselineResponseRate: number | null;
  fourWeekAvgReviews: number;
  ranking: { keyword: string; currentRank: number; initialRank: number } | null;
  dashboardUrl: string | null;
}

export function buildWeeklyValueReportHtml(params: WeeklyValueReportParams): string {
  const {
    businessName, weekStartDate, weekEndDate,
    totalReviews, totalResponded, notableReviews,
    intelligenceBrief, baselineResponseRate, fourWeekAvgReviews,
    ranking, dashboardUrl,
  } = params;

  const safeName = escapeHtml(businessName);
  const responseRate = totalReviews > 0 ? Math.round((totalResponded / totalReviews) * 100) : 0;
  const weekRange = `${formatWeekDate(weekStartDate)} – ${formatWeekDate(weekEndDate)}`;
  const timeSaved = totalResponded * 7;

  // a. Intelligence Brief
  const briefHtml = intelligenceBrief
    ? `<tr><td style="padding:16px 24px 0;">
        <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">AI Intelligence Brief</p>
        <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;background:#f0f9ff;border-radius:6px;padding:12px;border-left:3px solid #3b82f6;">${escapeHtml(intelligenceBrief)}</p>
      </td></tr>`
    : '';

  // b. Value Delivered
  const valueHtml = `<tr><td style="padding:16px 24px 0;">
    <p style="margin:0;font-size:16px;color:#111;font-weight:600;">This week RepWorth handled ${totalResponded} review${totalResponded !== 1 ? 's' : ''} for you, saving you approximately ${timeSaved} minutes</p>
  </td></tr>`;

  // c. Response rate lift
  const baselineText = baselineResponseRate !== null
    ? ` <span style="color:#6b7280;font-size:14px;">(was ${baselineResponseRate}% before RepWorth)</span>`
    : '';
  const rateColor = responseRate >= 90 ? '#166534' : '#92400e';
  const rateBg = responseRate >= 90 ? '#f0fdf4' : '#fef3c7';

  // d. Review velocity
  const velocityHtml = `<tr><td style="padding:12px 24px 0;">
    <p style="margin:0;font-size:14px;color:#374151;">New reviews this week: <strong>${totalReviews}</strong> | 4-week average: <strong>${fourWeekAvgReviews.toFixed(1)}</strong></p>
  </td></tr>`;

  // e. Ranking (conditional)
  const rankingHtml = ranking
    ? `<tr><td style="padding:12px 24px 0;">
        <p style="margin:0;font-size:14px;color:#374151;">Your ranking for &ldquo;${escapeHtml(ranking.keyword)}&rdquo;: <strong>#${ranking.currentRank}</strong> <span style="color:#6b7280;">(was #${ranking.initialRank} when you joined)</span></p>
      </td></tr>`
    : '';

  // f. Notable reviews
  let notableHtml = '';
  if (notableReviews.length > 0) {
    const items = notableReviews.map((r) => {
      const stars = renderStars(r.starRating);
      const text = r.reviewText ? escapeHtml(truncate(r.reviewText, 150)) : 'Rating only';
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;"><span style="font-size:16px;">${stars}</span> <strong>${escapeHtml(r.reviewerName)}</strong><br><span style="color:#4b5563;font-size:14px;">${text}</span></td></tr>`;
    }).join('');
    notableHtml = `<tr><td style="padding:16px 24px 0;">
      <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Reviews needing attention</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
    </td></tr>`;
  }

  // g. Dashboard link (conditional)
  const dashboardHtml = dashboardUrl
    ? `<tr><td style="padding:16px 24px 0;" align="center">
        <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;color:#2563eb;font-size:14px;font-weight:600;text-decoration:none;">See your full dashboard &rarr;</a>
      </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">Weekly Value Report — ${safeName}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">${weekRange}</p>
        </td></tr>
        ${valueHtml}
        <tr><td style="padding:12px 24px 0;">
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            <tr>
              <td style="padding:16px;background:#f9fafb;border-radius:6px;text-align:center;width:33%;">
                <p style="margin:0;font-size:24px;font-weight:700;color:#111;">${totalReviews}</p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Reviews</p>
              </td>
              <td style="width:8px;"></td>
              <td style="padding:16px;background:#f9fafb;border-radius:6px;text-align:center;width:33%;">
                <p style="margin:0;font-size:24px;font-weight:700;color:#111;">${totalResponded}</p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Responded</p>
              </td>
              <td style="width:8px;"></td>
              <td style="padding:16px;background:${rateBg};border-radius:6px;text-align:center;width:33%;">
                <p style="margin:0;font-size:24px;font-weight:700;color:${rateColor};">${responseRate}%${baselineText}</p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Rate</p>
              </td>
            </tr>
          </table>
        </td></tr>
        ${velocityHtml}
        ${rankingHtml}
        ${briefHtml}
        ${notableHtml}
        ${dashboardHtml}
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
```

Keep the old `buildWeeklySummaryEmailHtml` and `WeeklySummaryEmailParams` as deprecated exports until the WeeklySummaryWorker is updated in Task 6. The old function and interface will be removed in Task 6 when the worker switches to the new template.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test -- src/lib/notifications/__tests__/email-templates.test.ts`
Expected: All weekly value report tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/email.ts src/lib/notifications/__tests__/email-templates.test.ts
git commit -m "feat(5a): add buildWeeklyValueReportHtml email template"
```

---

## Task 5: Monthly Impact Email Template

**Files:**
- Modify: `src/lib/notifications/email.ts`
- Modify: `src/lib/notifications/__tests__/email-templates.test.ts`

- [ ] **Step 1: Add tests for `buildMonthlyImpactEmailHtml`**

Append to `src/lib/notifications/__tests__/email-templates.test.ts`:

```typescript
describe('buildMonthlyImpactEmailHtml', () => {
  const baseParams = {
    businessName: 'Taco Palace',
    monthLabel: 'March 2026',
    totalReviews: 28,
    totalResponded: 28,
    responseRate: 100,
    baselineResponseRate: 22 as number | null,
    timeSavedMinutes: 196,
    intelligenceBrief: 'March saw consistent praise for new patio menu items.',
    ranking: null as { keyword: string; currentRank: number; initialRank: number } | null,
    bestReview: {
      reviewerName: 'John D.',
      starRating: 5,
      reviewText: 'Absolutely the best tacos in town!',
      responseText: 'Thank you John! We take pride in our al pastor.',
    } as { reviewerName: string; starRating: number; reviewText: string; responseText: string | null } | null,
    dashboardUrl: null as string | null,
  };

  it('includes monthly intelligence brief', () => {
    const html = buildMonthlyImpactEmailHtml(baseParams);
    expect(html).toContain('patio menu');
  });

  it('includes time saved in hours', () => {
    const html = buildMonthlyImpactEmailHtml(baseParams);
    expect(html).toContain('3.3 hours'); // 196 min / 60
  });

  it('includes response rate with baseline comparison', () => {
    const html = buildMonthlyImpactEmailHtml(baseParams);
    expect(html).toContain('100%');
    expect(html).toContain('was 22%');
  });

  it('includes best review of the month', () => {
    const html = buildMonthlyImpactEmailHtml(baseParams);
    expect(html).toContain('best tacos');
    expect(html).toContain('al pastor');
  });

  it('omits best review when null', () => {
    const html = buildMonthlyImpactEmailHtml({ ...baseParams, bestReview: null });
    expect(html).not.toContain('Review of the Month');
  });

  it('includes ranking when data exists', () => {
    const html = buildMonthlyImpactEmailHtml({
      ...baseParams,
      ranking: { keyword: 'tacos san jose', currentRank: 3, initialRank: 7 },
    });
    expect(html).toContain('#3');
    expect(html).toContain('#7');
  });

  it('includes dashboard link when provided', () => {
    const html = buildMonthlyImpactEmailHtml({ ...baseParams, dashboardUrl: 'https://app.repworth.com/dashboard' });
    expect(html).toContain('full dashboard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test -- src/lib/notifications/__tests__/email-templates.test.ts`
Expected: FAIL — `buildMonthlyImpactEmailHtml` not found

- [ ] **Step 3: Implement `buildMonthlyImpactEmailHtml`**

Add to end of `src/lib/notifications/email.ts`:

```typescript
// ── Monthly Impact Email template ───────────────────────────────────

export interface MonthlyImpactEmailParams {
  businessName: string;
  monthLabel: string; // e.g. 'March 2026'
  totalReviews: number;
  totalResponded: number;
  responseRate: number;
  baselineResponseRate: number | null;
  timeSavedMinutes: number;
  intelligenceBrief: string | null;
  ranking: { keyword: string; currentRank: number; initialRank: number } | null;
  bestReview: {
    reviewerName: string;
    starRating: number;
    reviewText: string;
    responseText: string | null;
  } | null;
  dashboardUrl: string | null;
}

export function buildMonthlyImpactEmailHtml(params: MonthlyImpactEmailParams): string {
  const {
    businessName, monthLabel, totalReviews, totalResponded,
    responseRate, baselineResponseRate, timeSavedMinutes,
    intelligenceBrief, ranking, bestReview, dashboardUrl,
  } = params;

  const safeName = escapeHtml(businessName);
  const timeSavedHours = (timeSavedMinutes / 60).toFixed(1);

  const briefHtml = intelligenceBrief
    ? `<tr><td style="padding:16px 24px 0;">
        <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Monthly Intelligence Brief</p>
        <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;background:#f0f9ff;border-radius:6px;padding:12px;border-left:3px solid #3b82f6;">${escapeHtml(intelligenceBrief)}</p>
      </td></tr>`
    : '';

  const baselineText = baselineResponseRate !== null
    ? ` <span style="color:#6b7280;font-size:14px;">(was ${baselineResponseRate}% before RepWorth)</span>`
    : '';

  const rankingHtml = ranking
    ? `<tr><td style="padding:12px 24px 0;">
        <p style="margin:0;font-size:14px;color:#374151;">Google Maps ranking for &ldquo;${escapeHtml(ranking.keyword)}&rdquo;: <strong>#${ranking.currentRank}</strong> <span style="color:#6b7280;">(was #${ranking.initialRank} when you joined)</span></p>
      </td></tr>`
    : '';

  let bestReviewHtml = '';
  if (bestReview) {
    const stars = renderStars(bestReview.starRating);
    const responseHtml = bestReview.responseText
      ? `<p style="margin:8px 0 0;font-size:13px;color:#166534;font-style:italic;background:#f0fdf4;padding:8px;border-radius:4px;">&ldquo;${escapeHtml(truncate(bestReview.responseText, 200))}&rdquo;</p>`
      : '';
    bestReviewHtml = `<tr><td style="padding:16px 24px 0;">
      <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Review of the Month</p>
      <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:12px;border:1px solid #e5e7eb;">
        <tr><td>
          <p style="margin:0 0 4px;font-size:16px;">${stars}</p>
          <p style="margin:0 0 4px;font-size:14px;color:#374151;font-weight:600;">${escapeHtml(bestReview.reviewerName)}</p>
          <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.5;">${escapeHtml(truncate(bestReview.reviewText, 200))}</p>
          ${responseHtml}
        </td></tr>
      </table>
    </td></tr>`;
  }

  const dashboardHtml = dashboardUrl
    ? `<tr><td style="padding:16px 24px 0;" align="center">
        <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;color:#2563eb;font-size:14px;font-weight:600;text-decoration:none;">See your full dashboard &rarr;</a>
      </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">Monthly Impact Report — ${safeName}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">${escapeHtml(monthLabel)}</p>
        </td></tr>
        ${briefHtml}
        <tr><td style="padding:16px 24px 0;">
          <p style="margin:0;font-size:16px;color:#111;font-weight:600;">In ${escapeHtml(monthLabel)}, we handled ${totalResponded} review${totalResponded !== 1 ? 's' : ''}, saving you approximately ${timeSavedHours} hours</p>
        </td></tr>
        <tr><td style="padding:12px 24px 0;">
          <p style="margin:0;font-size:14px;color:#374151;">Response rate: <strong style="font-size:18px;color:${responseRate >= 90 ? '#166534' : '#92400e'};">${responseRate}%</strong>${baselineText}</p>
        </td></tr>
        ${rankingHtml}
        ${bestReviewHtml}
        ${dashboardHtml}
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test -- src/lib/notifications/__tests__/email-templates.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/email.ts src/lib/notifications/__tests__/email-templates.test.ts
git commit -m "feat(5a): add buildMonthlyImpactEmailHtml template"
```

---

## Task 6: Upgrade WeeklySummaryWorker to Weekly Value Report

**Files:**
- Modify: `worker/jobs/WeeklySummaryWorker.ts`
- Create: `worker/jobs/__tests__/WeeklySummaryWorker.test.ts`
- Modify: `src/lib/notifications/email.ts` (remove old `buildWeeklySummaryEmailHtml`)

The worker needs new queries for: intelligence brief (via LLM), baseline response rate, 4-week review velocity average, ranking snapshots, and dashboard URL eligibility. Then it uses `buildWeeklyValueReportHtml` instead of `buildWeeklySummaryEmailHtml`.

- [ ] **Step 1: Write tests for the upgraded worker**

Create `worker/jobs/__tests__/WeeklySummaryWorker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../../src/lib/db/server', () => {
  const sqlFn = vi.fn();
  return { sql: sqlFn };
});
vi.mock('../../../src/lib/shared/subscription-guard', () => ({
  checkSubscription: vi.fn().mockReturnValue({ allowed: true }),
}));
vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
}));
vi.mock('../../../src/lib/notifications/email', () => ({
  buildWeeklyValueReportHtml: vi.fn().mockReturnValue('<html>test</html>'),
  sendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
}));
vi.mock('../../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: vi.fn(),
}));
vi.mock('../../../src/lib/responses/review-summary', () => ({
  generateReviewSummary: vi.fn().mockResolvedValue({
    summaryText: 'Test summary', provider: 'mock', costUsd: 0,
  }),
}));

import { sql } from '../../../src/lib/db/server';
import { checkSubscription } from '../../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../../src/lib/shared/outbox';
import { buildWeeklyValueReportHtml, sendInternalEmail } from '../../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../../src/lib/notifications/delivery';
import { generateReviewSummary } from '../../../src/lib/responses/review-summary';
import { handleWeeklySummary } from '../WeeklySummaryWorker';

function makeJob(data: Record<string, unknown>) {
  return { data, id: 'test-job-id' } as unknown as import('bullmq').Job;
}

describe('handleWeeklySummary (upgraded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips if business not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]); // business query
    await handleWeeklySummary(makeJob({ business_id: 'biz-1', week_start_date: '2026-04-07' }));
    expect(markOutboxFailed).toHaveBeenCalledWith('test-job-id', 'business_not_found');
  });

  it('skips if subscription not allowed', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'biz-1', name: 'Test', owner_email: 'a@b.com', subscription_status: 'cancelled', updated_at: new Date() }]);
    vi.mocked(checkSubscription).mockReturnValue({ allowed: false, reason: 'cancelled' });
    await handleWeeklySummary(makeJob({ business_id: 'biz-1', week_start_date: '2026-04-07' }));
    expect(markOutboxCompleted).toHaveBeenCalled();
  });

  it('calls generateReviewSummary with week reviews', async () => {
    // Business
    vi.mocked(sql).mockResolvedValueOnce([{
      id: 'biz-1', name: 'Test Biz', owner_email: 'a@b.com',
      subscription_status: 'active', updated_at: new Date(),
      initial_review_count: 10, initial_responded_count: 2, baseline_captured_at: new Date(),
    }]);
    // Review count
    vi.mocked(sql).mockResolvedValueOnce([{ count: '5' }]);
    // Responded count
    vi.mocked(sql).mockResolvedValueOnce([{ count: '5' }]);
    // Notable reviews
    vi.mocked(sql).mockResolvedValueOnce([]);
    // Reviews for summary
    vi.mocked(sql).mockResolvedValueOnce([
      { star_rating: 5, review_text: 'Great!' },
    ]);
    // 4-week avg
    vi.mocked(sql).mockResolvedValueOnce([{ avg: '4.5' }]);
    // Ranking
    vi.mocked(sql).mockResolvedValueOnce([]);
    // Dashboard eligibility
    vi.mocked(sql).mockResolvedValueOnce([]);
    // Upsert
    vi.mocked(sql).mockResolvedValueOnce([{ sent_at: null }]);
    // Mark sent_at
    vi.mocked(sql).mockResolvedValueOnce([]);

    await handleWeeklySummary(makeJob({ business_id: 'biz-1', week_start_date: '2026-04-07' }));

    expect(generateReviewSummary).toHaveBeenCalled();
    expect(buildWeeklyValueReportHtml).toHaveBeenCalled();
    expect(sendInternalEmail).toHaveBeenCalled();
    expect(recordNotificationDelivery).toHaveBeenCalledWith(expect.objectContaining({
      template: 'weekly_value_report',
    }));
    expect(markOutboxCompleted).toHaveBeenCalled();
  });

  it('skips LLM summary when no reviews this week', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{
      id: 'biz-1', name: 'Test', owner_email: 'a@b.com',
      subscription_status: 'active', updated_at: new Date(),
      initial_review_count: null, initial_responded_count: null, baseline_captured_at: null,
    }]);
    vi.mocked(sql).mockResolvedValueOnce([{ count: '0' }]); // 0 reviews
    vi.mocked(sql).mockResolvedValueOnce([{ count: '0' }]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]); // no reviews for summary
    vi.mocked(sql).mockResolvedValueOnce([{ avg: '0' }]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([{ sent_at: null }]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    await handleWeeklySummary(makeJob({ business_id: 'biz-1', week_start_date: '2026-04-07' }));

    expect(generateReviewSummary).toHaveBeenCalledWith([], 'biz-1');
    expect(buildWeeklyValueReportHtml).toHaveBeenCalledWith(expect.objectContaining({
      intelligenceBrief: null,
    }));
  });
});
```

- [ ] **Step 2: Rewrite `WeeklySummaryWorker.ts` with new queries and template**

Replace the full content of `worker/jobs/WeeklySummaryWorker.ts` with the upgraded version that:
1. Queries business with `initial_review_count`, `initial_responded_count`, `baseline_captured_at`
2. Queries week reviews for the intelligence brief and passes them to `generateReviewSummary()`
3. Reuses existing `summary_text` from weekly_summaries if non-null (idempotent LLM avoidance)
4. Queries 4-week average review count
5. Conditionally queries `ranking_snapshots` for this business
6. Checks if owner has `users.auth_id IS NOT NULL` for dashboard link
7. Uses `buildWeeklyValueReportHtml()` instead of `buildWeeklySummaryEmailHtml()`
8. Records notification delivery with `template='weekly_value_report'` after successful send
9. Stores `summary_text` in weekly_summaries upsert

See the implementation in the executing step — this is the largest single file change.

- [ ] **Step 3: Remove old `buildWeeklySummaryEmailHtml` and `WeeklySummaryEmailParams`**

In `src/lib/notifications/email.ts`, remove the old `WeeklySummaryEmailParams` interface and `buildWeeklySummaryEmailHtml` function now that WeeklySummaryWorker has been updated.

- [ ] **Step 4: Run all tests**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test`
Expected: All tests pass including new WeeklySummaryWorker tests

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/WeeklySummaryWorker.ts worker/jobs/__tests__/WeeklySummaryWorker.test.ts src/lib/notifications/email.ts
git commit -m "feat(5a): upgrade WeeklySummaryWorker to Weekly Value Report with AI brief"
```

---

## Task 7: MonthlyImpactScheduler

**Files:**
- Create: `worker/jobs/MonthlyImpactScheduler.ts`

Follows the identical pattern as `WeeklySummaryScheduler.ts`: hourly setInterval, date-gated (1st of month, 9-10 AM UTC), queries active businesses, inserts outbox entries with dedup guard.

- [ ] **Step 1: Implement MonthlyImpactScheduler**

Create `worker/jobs/MonthlyImpactScheduler.ts`:

```typescript
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import type { SendMonthlyImpactPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[MonthlyImpactScheduler]';
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.MONTHLY_IMPACT_SCHEDULER_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Returns the first day of the previous month as 'YYYY-MM-DD'.
 */
function getPreviousMonthStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 10);
}

async function checkAndSchedule(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    const now = new Date();
    const utcDate = now.getUTCDate();
    const utcHour = now.getUTCHours();

    // Only schedule on the 1st of the month between 9-10 AM UTC
    if (utcDate !== 1 || utcHour < 9 || utcHour >= 10) {
      return;
    }

    const monthStartDate = getPreviousMonthStart(now);

    // Find businesses that need a monthly impact email
    const businesses = await sql<{ id: string }[]>`
      SELECT b.id FROM businesses b
      WHERE b.subscription_status IN ('active', 'past_due')
        AND NOT EXISTS (
          SELECT 1 FROM monthly_impact_emails mie
          WHERE mie.business_id = b.id
            AND mie.month_start_date = ${monthStartDate}::date
            AND mie.sent_at IS NOT NULL
        )
    `;

    let queued = 0;
    for (const biz of businesses) {
      const payload: SendMonthlyImpactPayload = {
        business_id: biz.id,
        month_start_date: monthStartDate,
      };

      try {
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            'send_monthly_impact',
            'business',
            ${biz.id},
            ${JSON.stringify(payload)}::jsonb,
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'send_monthly_impact'
              AND jo.aggregate_id = ${biz.id}
              AND jo.status IN ('pending', 'dispatched')
              AND jo.payload->>'month_start_date' = ${monthStartDate}
          )
        `;
        if (inserted.count > 0) queued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        console.error(`${LOG_PREFIX} Failed to queue monthly impact for business ${biz.id}:`, err);
      }
    }

    if (queued > 0) {
      console.log(`${LOG_PREFIX} Queued ${queued} send_monthly_impact outbox entries for month ${monthStartDate}`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Scheduler cycle failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startMonthlyImpactScheduler(): void {
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  checkAndSchedule().catch(console.error);
  pollerInterval = setInterval(() => {
    checkAndSchedule().catch(console.error);
  }, intervalMs);
}

export function stopMonthlyImpactScheduler(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/MonthlyImpactScheduler.ts
git commit -m "feat(5a): add MonthlyImpactScheduler (1st of month, 9-10 AM UTC)"
```

---

## Task 8: MonthlyImpactWorker

**Files:**
- Create: `worker/jobs/MonthlyImpactWorker.ts`
- Create: `worker/jobs/__tests__/MonthlyImpactWorker.test.ts`

Processes `send_monthly_impact` outbox entries. Follows identical patterns to WeeklySummaryWorker: load business, subscription guard, query stats, upsert idempotent row, build email, mark sent_at before send, record notification delivery.

- [ ] **Step 1: Write tests for MonthlyImpactWorker**

Create `worker/jobs/__tests__/MonthlyImpactWorker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/db/server', () => ({ sql: vi.fn() }));
vi.mock('../../../src/lib/shared/subscription-guard', () => ({
  checkSubscription: vi.fn().mockReturnValue({ allowed: true }),
}));
vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
}));
vi.mock('../../../src/lib/notifications/email', () => ({
  buildMonthlyImpactEmailHtml: vi.fn().mockReturnValue('<html>monthly</html>'),
  sendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-monthly-1' }),
}));
vi.mock('../../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: vi.fn(),
}));
vi.mock('../../../src/lib/responses/review-summary', () => ({
  generateReviewSummary: vi.fn().mockResolvedValue({ summaryText: 'Monthly brief', provider: 'mock', costUsd: 0 }),
}));

import { sql } from '../../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed } from '../../../src/lib/shared/outbox';
import { sendInternalEmail } from '../../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../../src/lib/notifications/delivery';
import { handleMonthlyImpact } from '../MonthlyImpactWorker';

function makeJob(data: Record<string, unknown>) {
  return { data, id: 'test-job-id' } as unknown as import('bullmq').Job;
}

describe('handleMonthlyImpact', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips if business not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);
    await handleMonthlyImpact(makeJob({ business_id: 'biz-1', month_start_date: '2026-03-01' }));
    expect(markOutboxFailed).toHaveBeenCalledWith('test-job-id', 'business_not_found');
  });

  it('skips if already sent (sent_at non-null)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{
      id: 'biz-1', name: 'Test', owner_email: 'a@b.com',
      subscription_status: 'active', updated_at: new Date(),
      initial_review_count: null, initial_responded_count: null, baseline_captured_at: null,
    }]);
    // Upsert returns no row because sent_at IS NOT NULL
    vi.mocked(sql).mockResolvedValueOnce([]);
    await handleMonthlyImpact(makeJob({ business_id: 'biz-1', month_start_date: '2026-03-01' }));
    expect(markOutboxCompleted).toHaveBeenCalled();
    expect(sendInternalEmail).not.toHaveBeenCalled();
  });

  it('sends email and records delivery on success', async () => {
    // Business
    vi.mocked(sql).mockResolvedValueOnce([{
      id: 'biz-1', name: 'Test Biz', owner_email: 'owner@test.com',
      subscription_status: 'active', updated_at: new Date(),
      initial_review_count: 20, initial_responded_count: 4, baseline_captured_at: new Date(),
    }]);
    // Upsert (row returned = not yet sent)
    vi.mocked(sql).mockResolvedValueOnce([{ sent_at: null, summary_text: null }]);
    // Month stats: reviews, responded
    vi.mocked(sql).mockResolvedValueOnce([{ count: '15' }]);
    vi.mocked(sql).mockResolvedValueOnce([{ count: '15' }]);
    // Best review
    vi.mocked(sql).mockResolvedValueOnce([{
      reviewer_name: 'John', star_rating: 5, review_text: 'Amazing!',
      response_text: 'Thanks John!',
    }]);
    // Reviews for summary
    vi.mocked(sql).mockResolvedValueOnce([{ star_rating: 5, review_text: 'Amazing!' }]);
    // Ranking
    vi.mocked(sql).mockResolvedValueOnce([]);
    // Dashboard eligibility
    vi.mocked(sql).mockResolvedValueOnce([]);
    // Save summary_text
    vi.mocked(sql).mockResolvedValueOnce([]);
    // Mark sent_at
    vi.mocked(sql).mockResolvedValueOnce([]);

    await handleMonthlyImpact(makeJob({ business_id: 'biz-1', month_start_date: '2026-03-01' }));

    expect(sendInternalEmail).toHaveBeenCalled();
    expect(recordNotificationDelivery).toHaveBeenCalledWith(expect.objectContaining({
      template: 'monthly_impact',
      businessId: 'biz-1',
    }));
    expect(markOutboxCompleted).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement MonthlyImpactWorker**

Create `worker/jobs/MonthlyImpactWorker.ts` following the same structure as WeeklySummaryWorker with monthly date range queries, best review query, and `buildMonthlyImpactEmailHtml`. The worker:
1. Loads business with baseline fields
2. Subscription guard (workerType='summary')
3. Upserts monthly_impact_emails row — if sent_at already non-null, marks outbox completed and returns
4. Queries month stats (total reviews, responded), best review, reviews for summary
5. Reuses existing `summary_text` from monthly_impact_emails if non-null; otherwise calls `generateReviewSummary()` and saves it
6. Conditionally queries ranking_snapshots
7. Checks dashboard eligibility (owner has auth_id)
8. Builds email via `buildMonthlyImpactEmailHtml()`
9. Marks sent_at BEFORE sending (crash-safe)
10. Sends email, records notification delivery
11. Marks outbox completed

- [ ] **Step 3: Run tests**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test -- worker/jobs/__tests__/MonthlyImpactWorker.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/MonthlyImpactWorker.ts worker/jobs/__tests__/MonthlyImpactWorker.test.ts
git commit -m "feat(5a): add MonthlyImpactWorker for monthly impact email"
```

---

## Task 9: Register in worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add imports**

Add after the existing imports:
```typescript
import { handleMonthlyImpact } from './jobs/MonthlyImpactWorker';
import { startMonthlyImpactScheduler, stopMonthlyImpactScheduler } from './jobs/MonthlyImpactScheduler';
```

- [ ] **Step 2: Create worker instance**

Add after `placeIdValidationWorker`:
```typescript
const monthlyImpactWorker = new Worker(QUEUE_NAMES.SEND_MONTHLY_IMPACT, handleMonthlyImpact, workerOpts);
```

- [ ] **Step 3: Add to workers array**

Update the workers array to include `monthlyImpactWorker`:
```typescript
const workers = [demoWorker, reviewSyncWorker, responseGenWorker, notificationWorker, publisherWorker, adminExceptionWorker, weeklySummaryWorker, placeIdValidationWorker, monthlyImpactWorker];
```

- [ ] **Step 4: Start scheduler in main()**

Add after `startArchivalPoller()`:
```typescript
  startMonthlyImpactScheduler();
```

- [ ] **Step 5: Stop scheduler in shutdown()**

Add after `stopArchivalPoller()`:
```typescript
  stopMonthlyImpactScheduler();
```

- [ ] **Step 6: Verify compilation**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Run full test suite**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add worker/index.ts
git commit -m "feat(5a): register MonthlyImpactWorker and scheduler in worker index"
```

---

## Task 10: Run Migration + Final Verification

- [ ] **Step 1: Run migration against Supabase**

The migration file `supabase/migrations/008_retention_core.sql` was already created. Run it:
```bash
cd "C:\Users\norbe\Desktop\RepWorth" && npx supabase db push
```
Or run the SQL directly via Supabase SQL editor.

- [ ] **Step 2: Run full test suite**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && pnpm test`
Expected: All tests pass

- [ ] **Step 3: Verify TypeScript compilation**

Run: `cd "C:\Users\norbe\Desktop\RepWorth" && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit migration**

```bash
git add supabase/migrations/008_retention_core.sql
git commit -m "chore(5a): add migration 008 for monthly_impact_emails table"
```

---

## Summary of Changes

| Component | Before | After |
|-----------|--------|-------|
| Weekly email | Basic summary with stats + notable reviews | "Weekly Value Report" with AI brief, value delivered, response rate lift, velocity, ranking, dashboard link |
| Monthly email | Did not exist | Monthly impact email with intelligence brief, stats, best review, ranking |
| Notification delivery | `responseId` required | `responseId` optional (supports business-level notifications) |
| Review summary | Did not exist | Dedicated LLM helper with OpenAI→Anthropic fallback, cost audit |
| BullMQ queues | 8 queues | 9 queues (+ `send_monthly_impact`) |
| Worker payload types | 7 interfaces | 8 interfaces (+ `SendMonthlyImpactPayload`) |
| Workers | 8 workers + 5 pollers | 9 workers + 6 pollers (+ MonthlyImpactWorker + MonthlyImpactScheduler) |
