import { z } from 'zod';

export const AutoApprovalThresholdSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export type AutoApprovalThreshold = z.infer<typeof AutoApprovalThresholdSchema>;

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

export const AutoApprovalConfirmationLevelSchema = z.enum(['standard', 'all_ratings']);

export type AutoApprovalConfirmationLevel = z.infer<typeof AutoApprovalConfirmationLevelSchema>;

// Single source of truth for the PATCH /api/settings/auto-approval contract.
// The route validates against this schema; AutoApprovalPatchRequest is inferred
// from it, so adding an operation can't drift the runtime check from the type.
export const AutoApprovalPatchSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('set_account_default'),
    threshold: AutoApprovalThresholdSchema,
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('set_account_manual'),
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('clear_account_default'),
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('set_location_override'),
    locationId: z.uuid(),
    threshold: AutoApprovalThresholdSchema,
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('set_location_manual'),
    locationId: z.uuid(),
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('delete_location_override'),
    locationId: z.uuid(),
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }).strict(),
]);

export type AutoApprovalPatchRequest = z.infer<typeof AutoApprovalPatchSchema>;

export function isAutoApprovalThreshold(value: unknown): value is AutoApprovalThreshold {
  return AutoApprovalThresholdSchema.safeParse(value).success;
}
