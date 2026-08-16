import type { ChurnScore } from '@/lib/shared/churn-score';

// One authoritative churn-level → style/label mapping for the admin console,
// a peer of StatusBadge. Extracted from OverviewClient when /admin/businesses
// absorbed the Health column (spec §5.4): Overview's at-risk list and the
// Businesses inventory render the SAME level from the SAME churn score, and
// spec §5.1 names "would disagree with the Health column on /admin/businesses"
// as a real failure mode — so the presentation has one owner, not two copies.
//
// Keys come from ChurnScore['level'] (single owner: src/lib/shared/churn-score.ts),
// so adding a level there is a type error here rather than a silent grey pill.
const HEALTH_BADGE_STYLES: Record<ChurnScore['level'], string> = {
  healthy: 'bg-green-100 text-green-800',
  watch: 'bg-gray-100 text-gray-700',
  at_risk: 'bg-red-100 text-red-800',
};

const HEALTH_BADGE_LABELS: Record<ChurnScore['level'], string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  at_risk: 'At Risk',
};

export function HealthBadge({ level, score }: { level: ChurnScore['level']; score: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${HEALTH_BADGE_STYLES[level]}`}
    >
      {HEALTH_BADGE_LABELS[level]} <span className="opacity-60">{score}</span>
    </span>
  );
}
