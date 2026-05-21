# Sprint 5B Prompt 19d — Partner Satisfaction Alert

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `partner_satisfaction_alert` type to the engagement alert system so that when a "not great" satisfaction pulse response arrives (Prompt 19g), the sales partner receives an internal email with the rating, optional comment, and business owner contact info.

**Architecture:** Extend the existing `EngagementAlertType` union with `partner_satisfaction_alert`, add a new `EngagementAlertPayload.satisfaction` optional field for rating/comment data, add a `buildPartnerSatisfactionAlertHtml()` email template, and wire the new alert type into `handlePartnerAlert()` in `EngagementAlertWorker`. The satisfaction pulse (Prompt 19g) will create `engagement_alert` outbox entries with `alert_type='partner_satisfaction_alert'` — this prompt just makes the worker ready to handle them.

**Tech Stack:** TypeScript, Vitest.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/lib/shared/worker-types.ts` | Add `partner_satisfaction_alert` to `EngagementAlertType`, add `satisfaction` field to payload |
| Modify | `src/lib/notifications/email.ts` | Add `buildPartnerSatisfactionAlertHtml()` template |
| Modify | `worker/jobs/EngagementAlertWorker.ts` | Handle `partner_satisfaction_alert` in the switch, widen `handlePartnerAlert` type |
| Modify | `worker/__tests__/EngagementAlertWorker.test.ts` | Add test for satisfaction alert |

---

## Task 1: Extend types + email template + worker handler

**Files:**
- Modify: `src/lib/shared/worker-types.ts`
- Modify: `src/lib/notifications/email.ts`
- Modify: `worker/jobs/EngagementAlertWorker.ts`
- Modify: `worker/__tests__/EngagementAlertWorker.test.ts`

- [ ] **Step 1: Add `partner_satisfaction_alert` to EngagementAlertType and add satisfaction field**

In `src/lib/shared/worker-types.ts`, update the type union and payload:

```typescript
export type EngagementAlertType =
  | 'owner_nudge'
  | 'partner_engagement_alert'
  | 'partner_escalation_alert'
  | 'partner_low_engagement'
  | 'partner_satisfaction_alert';

export interface EngagementAlertPayload {
  business_id: string;
  alert_type: EngagementAlertType;
  metrics: { ... }; // unchanged
  /** Present only for partner_satisfaction_alert — carries the pulse response data. */
  satisfaction?: {
    rating: 'great' | 'ok' | 'not_great';
    comment: string | null;
    week_start_date: string;
  };
}
```

- [ ] **Step 2: Add `buildPartnerSatisfactionAlertHtml` to email.ts**

Append to `src/lib/notifications/email.ts` after `buildPartnerLowEngagementAlertHtml`:

```typescript
export interface PartnerSatisfactionAlertParams {
  businessName: string;
  rating: 'great' | 'ok' | 'not_great';
  comment: string | null;
  weekStartDate: string;
  ownerEmail: string;
  ownerPhone: string | null;
}

export function buildPartnerSatisfactionAlertHtml(params: PartnerSatisfactionAlertParams): string {
  // red accent for not_great, amber for ok
  const accentColor = params.rating === 'not_great' ? '#dc2626' : '#d97706';
  const headerColor = params.rating === 'not_great' ? '#dc2626' : '#92400e';
  const ratingLabel = params.rating === 'not_great' ? 'Not great' : params.rating === 'ok' ? 'OK' : 'Great';
  // ... full HTML template
}
```

- [ ] **Step 3: Wire into EngagementAlertWorker handlePartnerAlert**

Widen `handlePartnerAlert` alertType union to include `partner_satisfaction_alert`. Add a case to the switch.

- [ ] **Step 4: Add test for satisfaction alert**

- [ ] **Step 5: Run tests, commit**

---

## Task 2: Update tracking docs

- [ ] **Step 1: Update CLAUDE.md and progresstracking.md**
