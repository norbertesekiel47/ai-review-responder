// ── Churn risk score ────────────────────────────────────────────────
// Pure function: no DB calls, no side effects. Takes pre-queried
// business metrics and returns a 0-100 risk score with breakdown.

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

export const WEIGHTS = {
  approvalRate: 30,
  daysSinceApproval: 25,
  satisfactionPulse: 20,
  responseTimeTrend: 15,
  accountAge: 10,
} as const;

export const LEVEL_THRESHOLDS = { healthy: 30, watch: 60 } as const;

function scoreApprovalRate(metrics: BusinessMetrics): { raw: number; value: string } {
  if (metrics.approvalRate === null || metrics.notifiedResponseCount30d < 3) {
    return { raw: 0, value: metrics.approvalRate === null ? 'no data' : `${metrics.notifiedResponseCount30d} notified (insufficient)` };
  }
  const pct = Math.round(metrics.approvalRate * 100);
  const label = `${pct}%`;
  if (metrics.approvalRate >= 1) return { raw: 0, value: label };
  if (metrics.approvalRate >= 0.8) return { raw: 20, value: label };
  if (metrics.approvalRate >= 0.5) return { raw: 50, value: label };
  return { raw: 100, value: label };
}

function scoreDaysSinceApproval(metrics: BusinessMetrics): { raw: number; value: string } {
  const days = metrics.daysSinceLastApproval;

  if (days === null) {
    if (metrics.pendingResponseCount > 0) {
      return { raw: 60, value: `never approved, ${metrics.pendingResponseCount} pending` };
    }
    return { raw: 0, value: 'no approvals yet, none pending' };
  }

  if (days <= 2) return { raw: 0, value: `${days}d ago` };
  if (days <= 5) return { raw: 30, value: `${days}d ago` };
  if (days <= 13) return { raw: 60, value: `${days}d ago` };
  return { raw: 100, value: `${days}d ago` };
}

function scoreSatisfactionPulse(metrics: BusinessMetrics): { raw: number; value: string } {
  const responses = metrics.satisfactionResponses;
  if (!responses || responses.length === 0) {
    return { raw: 0, value: 'not enabled' };
  }

  const allGreat = responses.every((r) => r.rating === 'great');
  if (allGreat) return { raw: 0, value: 'all great' };

  // Check for not_great streak of 2+
  let maxNotGreatStreak = 0;
  let currentStreak = 0;
  for (const r of responses) {
    if (r.rating === 'not_great') {
      currentStreak++;
      maxNotGreatStreak = Math.max(maxNotGreatStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  if (maxNotGreatStreak >= 2) return { raw: 80, value: `not_great streak (${maxNotGreatStreak})` };

  return { raw: 30, value: 'mixed' };
}

function scoreResponseTimeTrend(metrics: BusinessMetrics): { raw: number; value: string } {
  const trend = metrics.responseTimeTrend;
  if (trend === null || trend === 'faster_or_stable') return { raw: 0, value: trend ?? 'no data' };
  if (trend === 'slower') return { raw: 50, value: 'slower' };
  return { raw: 100, value: 'stopped' };
}

function scoreAccountAge(metrics: BusinessMetrics): { raw: number; value: string } {
  const weeks = metrics.accountAgeDays / 7;
  if (weeks < 5) return { raw: 20, value: `${Math.round(weeks)}w` };
  if (weeks < 12) return { raw: 10, value: `${Math.round(weeks)}w` };
  return { raw: 0, value: `${Math.round(weeks)}w` };
}

function computeLevel(score: number): ChurnScore['level'] {
  if (score <= LEVEL_THRESHOLDS.healthy) return 'healthy';
  if (score <= LEVEL_THRESHOLDS.watch) return 'watch';
  return 'at_risk';
}

export function computeChurnRiskScore(metrics: BusinessMetrics): ChurnScore {
  const signals: Array<{ signal: string; weight: number; scored: { raw: number; value: string } }> = [
    { signal: 'Approval rate (30d)', weight: WEIGHTS.approvalRate, scored: scoreApprovalRate(metrics) },
    { signal: 'Days since approval', weight: WEIGHTS.daysSinceApproval, scored: scoreDaysSinceApproval(metrics) },
    { signal: 'Satisfaction pulse', weight: WEIGHTS.satisfactionPulse, scored: scoreSatisfactionPulse(metrics) },
    { signal: 'Response time trend', weight: WEIGHTS.responseTimeTrend, scored: scoreResponseTimeTrend(metrics) },
    { signal: 'Account age', weight: WEIGHTS.accountAge, scored: scoreAccountAge(metrics) },
  ];

  const breakdown = signals.map(({ signal, weight, scored }) => ({
    signal,
    value: scored.value,
    contribution: Math.round((scored.raw * weight) / 100),
  }));

  const score = breakdown.reduce((sum, item) => sum + item.contribution, 0);

  return { score, level: computeLevel(score), breakdown };
}
