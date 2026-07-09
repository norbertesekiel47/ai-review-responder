import { z } from 'zod';

// Positive quadrant only (WS4 spec §2.2): auto-approval never touches sub-4★
// reviews. Widening below 4 is a deliberate future migration, not a code edit.
const AutoApprovalThresholdSchema = z.union([z.literal(4), z.literal(5)]);

export type AutoApprovalThreshold = z.infer<typeof AutoApprovalThresholdSchema>;

export const APPROVAL_METHOD = {
  OWNER: 'owner',
  AUTO_POLICY: 'auto_policy',
} as const;

// The only persona/action-class scope built today — migration 074's CHECKs are
// deliberately single-valued (spec §2.1); Solicitation v1.1 widens them in its
// own migration. Every policy SELECT/upsert filters on these constants (Task 12
// settings writers included), never on string literals at call sites.
export const POLICY_PERSONA_REPLY = 'reply';
export const POLICY_ACTION_POSTING = 'posting';

export type ApprovalMethod = (typeof APPROVAL_METHOD)[keyof typeof APPROVAL_METHOD];

export type PolicySource = 'location_override' | 'account_default' | 'none';

export interface PolicyRowState {
  id: string;
  accountId: string;
  locationId: string | null;
  autoApproveMinStar: AutoApprovalThreshold | null;
  vetoWindowMinutes: 15 | 30;
  dailyAutoPostCap: number | null;
  suspendedAt: Date | null;
}

export interface EffectiveAutoApprovalPolicy {
  source: PolicySource;
  threshold: AutoApprovalThreshold | null;
  policyId: string | null;
  vetoWindowMinutes: 15 | 30;
  /** NULL resolves to the platform default via resolveDailyCap() at evaluation time. */
  dailyAutoPostCap: number | null;
  /** Governor kill switch (spec §2.4): account default OR winning row suspended. */
  suspended: boolean;
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

const AutoApprovalConfirmationLevelSchema = z.enum(['standard', 'all_ratings']);

export type AutoApprovalConfirmationLevel = z.infer<typeof AutoApprovalConfirmationLevelSchema>;

// Single source of truth for the PATCH /api/settings/auto-approval contract.
// The route validates against this schema; AutoApprovalPatchRequest is inferred
// from it, so adding an operation can't drift the runtime check from the type.
export const AutoApprovalPatchSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('set_account_default'),
    threshold: AutoApprovalThresholdSchema,
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal('set_account_manual'),
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal('clear_account_default'),
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal('set_location_override'),
    locationId: z.uuid(),
    threshold: AutoApprovalThresholdSchema,
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal('set_location_manual'),
    locationId: z.uuid(),
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal('delete_location_override'),
    locationId: z.uuid(),
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
]);

export type AutoApprovalPatchRequest = z.infer<typeof AutoApprovalPatchSchema>;

export function isAutoApprovalThreshold(value: unknown): value is AutoApprovalThreshold {
  return AutoApprovalThresholdSchema.safeParse(value).success;
}
