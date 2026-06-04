export type AutoApprovalThreshold = 1 | 2 | 3 | 4 | 5;

export type ApprovalMethod = 'owner' | 'auto_policy';

export type PolicySource = 'location_override' | 'account_default' | 'none';

export interface PolicyRowState {
  id: string;
  accountId: string;
  locationId: string | null;
  autoApproveMinStar: AutoApprovalThreshold | null;
}

export interface EffectiveAutoApprovalPolicy {
  source: PolicySource;
  threshold: AutoApprovalThreshold | null;
  policyId: string | null;
}
