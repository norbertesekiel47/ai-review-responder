import { Icon } from '@/components/dashboard/shell/Icon';
import type { ApprovalMethod } from '@/lib/auto-approval/types';

type AutoApprovedBadgeVariant = 'compact' | 'provenance';

/**
 * Single owner of the "this reply was auto-approved by policy" badge.
 * Renders nothing unless the response was approved via auto-policy, so callers
 * can pass the raw nullable approval_method without their own guard. Two visual
 * variants: `compact` (review-feed pill) and `provenance` (past-replies row).
 */
export function AutoApprovedBadge({
  method,
  variant,
}: {
  method: ApprovalMethod | null;
  variant: AutoApprovedBadgeVariant;
}) {
  if (method !== 'auto_policy') return null;

  if (variant === 'provenance') {
    return (
      <span className="pr-prov-badge pr-prov-auto">
        <Icon name="shield" size={10} /> Auto-approved
      </span>
    );
  }

  return <span className="badge badge-auto">Auto</span>;
}
