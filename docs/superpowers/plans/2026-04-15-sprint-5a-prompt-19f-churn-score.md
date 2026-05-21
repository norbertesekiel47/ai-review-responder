# Sprint 5A Prompt 19f — Churn Risk Score System

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure-function churn risk scoring system and surface it in the admin overview CRM table (Health column) and business detail page (score breakdown), giving the sales partner an at-a-glance "who needs attention?" view.

**Architecture:** A pure function (`computeChurnRiskScore`) takes pre-queried metrics and returns a 0-100 score with level and breakdown. The admin overview API adds one grouped metrics query for all returned businesses, runs each through the scoring function, and appends the score to the response. The frontend adds a Health column and engagement breakdown section. No new tables, workers, or pollers — metrics computed at query time per Sprint 5 architecture override #7.

**Tech Stack:** TypeScript (pure function), Postgres.js (grouped metrics query), React/Tailwind (admin UI)

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/lib/shared/churn-score.ts` | Pure scoring function + types + exported constants |
| Create | `src/lib/shared/__tests__/churn-score.test.ts` | Comprehensive tests for all signals, combinations, edge cases, boundaries |
| Modify | `src/app/api/admin/overview/route.ts` | Add grouped metrics query, compute scores, add to response |
| Modify | `src/app/admin/overview/page.tsx` | Add Health column with color badges, default sort by risk |
| Modify | `src/app/api/admin/businesses/[id]/route.ts` | Add engagement metrics query + churn score to business detail response |
| Modify | `src/app/admin/businesses/[id]/page.tsx` | Add risk badge in header + Engagement breakdown section |

---

## Task 1: Churn Risk Score Function + Tests

**Files:**
- Create: `src/lib/shared/churn-score.ts`
- Create: `src/lib/shared/__tests__/churn-score.test.ts`

This is a pure function with no side effects — the most testable component.

- [ ] **Step 1: Create the churn score module**

Create `src/lib/shared/churn-score.ts`:

```typescript
// ── Types ────────────────────────────────────────────────────────────

export interface BusinessMetrics {
  approvalRate: number | null;
  notifiedResponseCount30d: number;
  pendingResponseCount: number;
  daysSinceLastApproval: number | null;
  satisfactionResponses: Array<{ rating: 'great' | 'ok' | 'not_great' }> | null;
  responseTimeTrend: 'faster_or_stable' | 'slower' | 'stopped' | null;
  accountAgeDays: number;
}

export interface ChurnScore {
  score: number;
  level: 'healthy' | 'watch' | 'at_risk';
  breakdown: Array<{ signal: string; value: string; contribution: number }>;
}

// ── Weights (exported for transparency + future tuning) ─────────────

export const WEIGHTS = {
  approvalRate: 30,
  daysSinceApproval: 25,
  satisfactionPulse: 20,
  responseTimeTrend: 15,
  accountAge: 10,
} as const;

export const LEVEL_THRESHOLDS = {
  healthy: 30,
  watch: 60,
} as const;

// ── Scoring functions per signal ────────────────────────────────────

function scoreApprovalRate(rate: number | null, notifiedCount: number): { raw: number; value: string } {
  if (rate === null || notifiedCount < 3) {
    return { raw: 0, value: notifiedCount < 3 ? 'Insufficient data' : 'N/A' };
  }
  const pct = Math.round(rate * 100);
  let raw: number;
  if (pct >= 100) raw = 0;
  else if (pct >= 80) raw = 20;
  else if (pct >= 50) raw = 50;
  else raw = 100;
  return { raw, value: `${pct}%` };
}

function scoreDaysSinceApproval(days: number | null, pendingCount: number): { raw: number; value: string } {
  if (days === null) {
    if (pendingCount > 0) return { raw: 60, value: 'Never approved (pending exist)' };
    return { raw: 0, value: 'No activity yet' };
  }
  let raw: number;
  if (days <= 2) raw = 0;
  else if (days <= 5) raw = 30;
  else if (days <= 13) raw = 60;
  else raw = 100;
  return { raw, value: `${days} days` };
}

function scoreSatisfaction(
  responses: Array<{ rating: 'great' | 'ok' | 'not_great' }> | null,
): { raw: number; value: string } {
  // null = Sprint 5B not enabled yet — neutral
  if (!responses || responses.length === 0) {
    return { raw: 0, value: 'Not available' };
  }
  const ratings = responses.map((r) => r.rating);
  const hasNotGreat = ratings.includes('not_great');
  const allGreat = ratings.every((r) => r === 'great');

  if (allGreat) return { raw: 0, value: 'All positive' };
  if (hasNotGreat) {
    // Check for streak (2+ consecutive not_great)
    let streak = 0;
    let maxStreak = 0;
    for (const r of ratings) {
      if (r === 'not_great') { streak++; maxStreak = Math.max(maxStreak, streak); }
      else { streak = 0; }
    }
    if (maxStreak >= 2) return { raw: 80, value: 'Negative streak' };
  }
  return { raw: 30, value: 'Mixed' };
}

function scoreResponseTimeTrend(
  trend: 'faster_or_stable' | 'slower' | 'stopped' | null,
): { raw: number; value: string } {
  if (!trend || trend === 'faster_or_stable') return { raw: 0, value: trend ?? 'N/A' };
  if (trend === 'slower') return { raw: 50, value: 'Slowing' };
  return { raw: 100, value: 'Stopped' };
}

function scoreAccountAge(days: number): { raw: number; value: string } {
  const weeks = Math.floor(days / 7);
  if (weeks <= 4) return { raw: 20, value: `${weeks} weeks` };
  if (weeks <= 12) return { raw: 10, value: `${weeks} weeks` };
  return { raw: 0, value: `${weeks} weeks` };
}

// ── Main scoring function ───────────────────────────────────────────

export function computeChurnRiskScore(metrics: BusinessMetrics): ChurnScore {
  const approval = scoreApprovalRate(metrics.approvalRate, metrics.notifiedResponseCount30d);
  const days = scoreDaysSinceApproval(metrics.daysSinceLastApproval, metrics.pendingResponseCount);
  const satisfaction = scoreSatisfaction(metrics.satisfactionResponses);
  const trend = scoreResponseTimeTrend(metrics.responseTimeTrend);
  const age = scoreAccountAge(metrics.accountAgeDays);

  const breakdown = [
    { signal: 'Approval rate', value: approval.value, contribution: Math.round(approval.raw * WEIGHTS.approvalRate / 100) },
    { signal: 'Days since approval', value: days.value, contribution: Math.round(days.raw * WEIGHTS.daysSinceApproval / 100) },
    { signal: 'Satisfaction pulse', value: satisfaction.value, contribution: Math.round(satisfaction.raw * WEIGHTS.satisfactionPulse / 100) },
    { signal: 'Response time trend', value: trend.value, contribution: Math.round(trend.raw * WEIGHTS.responseTimeTrend / 100) },
    { signal: 'Account age', value: age.value, contribution: Math.round(age.raw * WEIGHTS.accountAge / 100) },
  ];

  const score = breakdown.reduce((sum, b) => sum + b.contribution, 0);
  const level: ChurnScore['level'] =
    score <= LEVEL_THRESHOLDS.healthy ? 'healthy' :
    score <= LEVEL_THRESHOLDS.watch ? 'watch' :
    'at_risk';

  return { score, level, breakdown };
}
```

- [ ] **Step 2: Create comprehensive tests**

Create `src/lib/shared/__tests__/churn-score.test.ts` with tests covering:

- Each signal independently (one signal active, others at neutral/zero)
- Perfect engagement → score 0, level healthy
- Completely disengaged → high score, level at_risk
- New account with no data → low score (only account age contributes)
- Boundary values at 30 (healthy/watch) and 60 (watch/at_risk)
- Combined scoring: multiple signals contributing
- Approval rate with insufficient data (notifiedCount < 3) → contribution 0
- Satisfaction with null (Sprint 5B not enabled) → contribution 0
- Days since approval null with pending reviews → contribution 15 (60 * 25/100)
- Days since approval null without pending → contribution 0

- [ ] **Step 3: Run tests + commit**

```bash
pnpm test -- src/lib/shared/__tests__/churn-score.test.ts
git commit -m "feat(5a): add computeChurnRiskScore pure function with comprehensive tests"
```

---

## Task 2: Admin Overview API — Add Churn Metrics + Score

**Files:**
- Modify: `src/app/api/admin/overview/route.ts`

Add one grouped metrics query for all businesses returned by the page. Run each through `computeChurnRiskScore()`. Add score to response.

- [ ] **Step 1: Add imports and update response interface**

Add import: `import { computeChurnRiskScore, type ChurnScore } from '@/lib/shared/churn-score';`

Add to the `OverviewData.businesses` array item type:
```typescript
    churnScore: ChurnScore;
```

- [ ] **Step 2: Add grouped metrics query**

After the existing `Promise.all` block (line 100), add a second query that fetches churn metrics for the returned business IDs:

```typescript
    const businessIds = businessRows.map((r) => r.id);

    // Skip metrics if no businesses
    const metricsRows = businessIds.length > 0
      ? await sql<{
          business_id: string;
          approval_rate: number | null;
          notified_count: number;
          pending_count: number;
          days_since_approval: number | null;
          account_age_days: number;
          avg_approval_hours_current: number | null;
          avg_approval_hours_prev: number | null;
        }[]>`
          WITH biz_ids AS (SELECT UNNEST(${businessIds}::uuid[]) AS id),
          notif AS (
            SELECT nd.business_id,
                   COUNT(DISTINCT nd.response_id)::int AS notified_count,
                   COUNT(DISTINCT nd.response_id) FILTER (
                     WHERE r.status IN ('approved','edited','posted','awaiting_manual_post')
                   )::int AS approved_count
            FROM notification_deliveries nd
            JOIN responses r ON r.id = nd.response_id
            WHERE nd.business_id IN (SELECT id FROM biz_ids)
              AND nd.template = 'approval_request'
              AND nd.sent_at IS NOT NULL
              AND nd.sent_at >= CURRENT_DATE - 30
            GROUP BY nd.business_id
          ),
          resp_metrics AS (
            SELECT resp.business_id,
                   COUNT(*) FILTER (WHERE resp.status = 'pending_approval')::int AS pending_count,
                   EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(resp.approved_at)
                     FILTER (WHERE resp.status IN ('approved','edited','posted','awaiting_manual_post'))
                   )::int AS days_since_approval,
                   AVG(EXTRACT(EPOCH FROM resp.approved_at - resp.created_at) / 3600.0)
                     FILTER (WHERE resp.approved_at IS NOT NULL
                       AND resp.created_at >= CURRENT_DATE - 7)::float AS avg_approval_hours_current,
                   AVG(EXTRACT(EPOCH FROM resp.approved_at - resp.created_at) / 3600.0)
                     FILTER (WHERE resp.approved_at IS NOT NULL
                       AND resp.created_at >= CURRENT_DATE - 35
                       AND resp.created_at < CURRENT_DATE - 7)::float AS avg_approval_hours_prev
            FROM responses resp
            WHERE resp.business_id IN (SELECT id FROM biz_ids)
            GROUP BY resp.business_id
          )
          SELECT
            b.id AS business_id,
            CASE WHEN COALESCE(n.notified_count, 0) >= 3
                 THEN n.approved_count::float / NULLIF(n.notified_count, 0)
                 ELSE NULL END AS approval_rate,
            COALESCE(n.notified_count, 0) AS notified_count,
            COALESCE(rm.pending_count, 0) AS pending_count,
            rm.days_since_approval,
            EXTRACT(DAY FROM CURRENT_TIMESTAMP - b.created_at)::int AS account_age_days,
            rm.avg_approval_hours_current,
            rm.avg_approval_hours_prev
          FROM biz_ids b
          LEFT JOIN notif n ON n.business_id = b.id
          LEFT JOIN resp_metrics rm ON rm.business_id = b.id
        `
      : [];

    // Index metrics by business_id for O(1) lookup
    const metricsMap = new Map(metricsRows.map((r) => [r.business_id, r]));
```

- [ ] **Step 3: Compute scores and add to response**

In the business mapping, compute the score:

```typescript
      businesses: businessRows.map((row) => {
        const responseRate = ...existing...;
        const m = metricsMap.get(row.id);

        // Derive response time trend
        let responseTimeTrend: 'faster_or_stable' | 'slower' | 'stopped' | null = null;
        if (m?.avg_approval_hours_current !== null && m?.avg_approval_hours_prev !== null) {
          if (m.avg_approval_hours_current > m.avg_approval_hours_prev * 1.5) {
            responseTimeTrend = 'slower';
          } else {
            responseTimeTrend = 'faster_or_stable';
          }
        } else if (m?.pending_count > 0 && m?.days_since_approval !== null && m.days_since_approval > 7) {
          responseTimeTrend = 'stopped';
        }

        const churnScore = computeChurnRiskScore({
          approvalRate: m?.approval_rate ?? null,
          notifiedResponseCount30d: m?.notified_count ?? 0,
          pendingResponseCount: m?.pending_count ?? 0,
          daysSinceLastApproval: m?.days_since_approval ?? null,
          satisfactionResponses: null, // Sprint 5B
          responseTimeTrend,
          accountAgeDays: m?.account_age_days ?? 0,
        });

        return {
          ...existing fields...,
          churnScore,
        };
      }),
```

- [ ] **Step 4: Change default sort to risk score descending**

Replace the existing ORDER BY in the business query with:
Keep the existing ORDER BY for now (it sorts by pending count). The frontend will sort by risk score client-side since the score is computed post-query.

- [ ] **Step 5: Verify + commit**

```bash
npx tsc --noEmit && pnpm test
git commit -m "feat(5a): add churn metrics query and risk score to admin overview API"
```

---

## Task 3: Admin Overview Page — Health Column

**Files:**
- Modify: `src/app/admin/overview/page.tsx`

- [ ] **Step 1: Update the OverviewData type to include churnScore**

Add to the businesses array item in the local `OverviewData` interface:
```typescript
    churnScore: {
      score: number;
      level: 'healthy' | 'watch' | 'at_risk';
      breakdown: Array<{ signal: string; value: string; contribution: number }>;
    };
```

- [ ] **Step 2: Add HealthBadge component**

```typescript
function HealthBadge({ level, score }: { level: string; score: number }) {
  const styles: Record<string, string> = {
    healthy: 'bg-green-100 text-green-800',
    watch: 'bg-amber-100 text-amber-800',
    at_risk: 'bg-red-100 text-red-800',
  };
  const labels: Record<string, string> = {
    healthy: 'Healthy',
    watch: 'Watch',
    at_risk: 'At Risk',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${styles[level] ?? styles.healthy}`}>
      {labels[level] ?? level} <span className="opacity-60">{score}</span>
    </span>
  );
}
```

- [ ] **Step 3: Add Health column to table**

Add `<th>` header: `<th className="px-4 py-3 text-left font-medium text-gray-500">Health</th>`

Add `<td>` in each row: `<td className="px-4 py-3"><HealthBadge level={biz.churnScore.level} score={biz.churnScore.score} /></td>`

Update colspan on empty state from 6 to 7.

- [ ] **Step 4: Sort by risk score descending by default**

Add state and sort logic:
```typescript
const sorted = [...businesses].sort((a, b) => b.churnScore.score - a.churnScore.score);
```
Use `sorted` instead of `businesses` in the table map.

- [ ] **Step 5: Verify + commit**

```bash
npx tsc --noEmit
git commit -m "feat(5a): add Health column with churn risk badges to admin overview"
```

---

## Task 4: Business Detail API — Churn Score

**Files:**
- Modify: `src/app/api/admin/businesses/[id]/route.ts`

- [ ] **Step 1: Add churn metrics query to GET handler**

After the existing business + reviews queries, add the same metrics query (scoped to single business_id) and compute the score. Add `churnScore` to the response.

The metrics query is the same as overview but for a single business. Add `responseTimeTrend` derivation.

- [ ] **Step 2: Add `churnScore` to response type**

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit && pnpm test
git commit -m "feat(5a): add churn risk score to admin business detail API"
```

---

## Task 5: Business Detail Page — Risk Badge + Engagement Section

**Files:**
- Modify: `src/app/admin/businesses/[id]/page.tsx`

- [ ] **Step 1: Add risk badge to business header**

Add `HealthBadge` component (same as overview page) and render next to the business name in the header area.

- [ ] **Step 2: Add Engagement breakdown section**

After the existing sections, add:

```tsx
{detail.churnScore && (
  <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-lg font-semibold text-gray-900">Engagement</h2>
      <HealthBadge level={detail.churnScore.level} score={detail.churnScore.score} />
    </div>
    <div className="space-y-2">
      {detail.churnScore.breakdown.map((item) => (
        <div key={item.signal} className="flex items-center justify-between text-sm">
          <div>
            <span className="font-medium text-gray-700">{item.signal}:</span>{' '}
            <span className="text-gray-500">{item.value}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 w-24 rounded bg-gray-100 overflow-hidden">
              <div
                className={`h-full rounded ${item.contribution > 15 ? 'bg-red-400' : item.contribution > 5 ? 'bg-amber-400' : 'bg-green-400'}`}
                style={{ width: `${Math.min(item.contribution * 3, 100)}%` }}
              />
            </div>
            <span className="text-xs text-gray-400 w-8 text-right">{item.contribution}</span>
          </div>
        </div>
      ))}
    </div>
  </section>
)}
```

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit
git commit -m "feat(5a): add risk badge and engagement breakdown to business detail page"
```

---

## Task 6: Update Status Docs

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `docs/progresstracking.md`

- [ ] **Step 1: Update CLAUDE.md** with Prompt 19f entry
- [ ] **Step 2: Update progresstracking.md** with Phase 5A.4 entry
- [ ] **Step 3: Commit**

```bash
git commit -m "docs: update status with Sprint 5A Prompt 19f (churn risk score)"
```
