export type AutoApprovalThreshold = 1 | 2 | 3 | 4 | 5;

const AUTO_APPROVAL_THRESHOLDS = [1, 2, 3, 4, 5] as const;

export const APPROVAL_METHOD = {
  OWNER: 'owner',
  AUTO_POLICY: 'auto_policy',
} as const;

export type ApprovalMethod = (typeof APPROVAL_METHOD)[keyof typeof APPROVAL_METHOD];

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

export type AutoApprovalReadinessBlockReason =
  | 'auto_approval_disabled'
  | 'provider_moderation_disabled'
  | 'provider_moderation_not_validated'
  | 'subscription_not_writable'
  | 'preview_environment'
  | 'impersonation_not_allowed';

export interface AutoApprovalReadiness {
  runtimeEnabled: boolean;
  providerModerationEnabled: boolean;
  providerModerationValidated: boolean;
  accountWritable: boolean;
  canExpand: boolean;
  blockReasons: AutoApprovalReadinessBlockReason[];
}

export interface AutoApprovalPolicyApiState {
  policyId: string | null;
  threshold: AutoApprovalThreshold | null;
  exists: boolean;
}

export interface AutoApprovalLocationSettings {
  locationId: string;
  displayName: string;
  override: AutoApprovalPolicyApiState;
  effective: {
    threshold: AutoApprovalThreshold | null;
    source: PolicySource;
    inherited: boolean;
  };
}

export interface AutoApprovalSettingsResponse {
  accountDefault: AutoApprovalPolicyApiState;
  locations: AutoApprovalLocationSettings[];
  readiness: AutoApprovalReadiness;
}

export type AutoApprovalConfirmationLevel = 'standard' | 'all_ratings';

export type AutoApprovalPatchRequest =
  | {
      operation: 'set_account_default';
      threshold: AutoApprovalThreshold;
      confirmationLevel?: AutoApprovalConfirmationLevel;
    }
  | {
      operation: 'set_account_manual' | 'clear_account_default';
      confirmationLevel?: AutoApprovalConfirmationLevel;
    }
  | {
      operation: 'set_location_override';
      locationId: string;
      threshold: AutoApprovalThreshold;
      confirmationLevel?: AutoApprovalConfirmationLevel;
    }
  | {
      operation: 'set_location_manual' | 'delete_location_override';
      locationId: string;
      confirmationLevel?: AutoApprovalConfirmationLevel;
    };

export function isAutoApprovalThreshold(value: unknown): value is AutoApprovalThreshold {
  return typeof value === 'number' && (AUTO_APPROVAL_THRESHOLDS as readonly number[]).includes(value);
}
