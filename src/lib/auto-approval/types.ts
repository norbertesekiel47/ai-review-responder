import { z } from 'zod';

// Positive quadrant only (WS4 spec §2.2): auto-approval never touches sub-4★
// reviews. Widening below 4 is a deliberate future migration, not a code edit.
const AutoApprovalThresholdSchema = z.union([z.literal(4), z.literal(5)]);

export type AutoApprovalThreshold = z.infer<typeof AutoApprovalThresholdSchema>;

// Module-private: `autoApprovalThresholdLabel` is the only interface. The
// `Record<AutoApprovalThreshold, string>` annotation is the exhaustiveness
// guard — widening the union without adding a label is a compile error here.
const THRESHOLD_LABELS: Record<AutoApprovalThreshold, string> = {
  4: '4–5★',
  5: '5★ only',
};

/**
 * Threshold vocabulary, shared by the owner settings screen and the admin
 * diagnostics panel so the two cannot drift. The two
 * `AutoApprovalReadinessBlockReason` maps are deliberately NOT shared — admin
 * renders terse ops labels, owner renders explanatory sentences.
 *
 * `null` means auto-approval is off for that scope.
 *
 * Throws on an out-of-domain threshold rather than returning `undefined` under a
 * `: string` signature. Migration 074's CHECK makes that unreachable, but the
 * only producer is an unvalidated row cast (`business-detail/queries.ts`), so a
 * schema drift would otherwise render the literal string "undefined" in the
 * admin panel instead of failing loudly.
 */
export function autoApprovalThresholdLabel(threshold: AutoApprovalThreshold | null): string {
  if (threshold === null) return 'Off';
  const label = THRESHOLD_LABELS[threshold];
  if (label === undefined) {
    throw new Error(`unknown_auto_approval_threshold:${threshold}`);
  }
  return label;
}

// Veto window sizes (spec §2.1); migration 074's CHECK mirrors this union.
const VetoWindowMinutesSchema = z.union([z.literal(15), z.literal(30)]);

export type VetoWindowMinutes = z.infer<typeof VetoWindowMinutesSchema>;

// Daily auto-post cap (spec §2.1): stored 1..50; null = platform default
// (DEFAULT_DAILY_AUTO_POST_CAP). Migration 074's CHECK mirrors this range.
const DailyAutoPostCapSchema = z.number().int().min(1).max(50).nullable();

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
  vetoWindowMinutes: VetoWindowMinutes;
  dailyAutoPostCap: number | null;
  suspendedAt: Date | null;
}

export interface EffectiveAutoApprovalPolicy {
  source: PolicySource;
  threshold: AutoApprovalThreshold | null;
  policyId: string | null;
  vetoWindowMinutes: VetoWindowMinutes;
  /** NULL resolves to the platform default via resolveDailyCap() at evaluation time. */
  dailyAutoPostCap: number | null;
  /** Governor kill switch (spec §2.4): account default OR winning row suspended. */
  suspended: boolean;
}

export type PolicyExposureClassification =
  | 'expansion'
  | 'contraction'
  | 'no_change';

export type AutoApprovalReadinessBlockReason =
  | 'auto_approval_disabled'
  | 'autopilot_unavailable'
  | 'provider_moderation_disabled'
  | 'provider_moderation_not_validated'
  | 'subscription_not_writable'
  | 'policy_suspended'
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
  vetoWindowMinutes: VetoWindowMinutes;
  /** Stored value; null = platform default (distinct from an explicit cap). */
  dailyAutoPostCap: number | null;
  /** The cap enforced when this row wins: stored value or the platform default. */
  effectiveDailyCap: number;
  /** System kill switch (spec §2.4); written by the WS6 governor, never by owners. */
  suspended: boolean;
  suspendedReason: string | null;
}

export interface AutoApprovalLocationSettings {
  locationId: string;
  displayName: string;
  override: AutoApprovalPolicyApiState;
  effective: {
    threshold: AutoApprovalThreshold | null;
    source: PolicySource;
    inherited: boolean;
    vetoWindowMinutes: VetoWindowMinutes;
    dailyAutoPostCap: number | null;
    effectiveDailyCap: number;
    suspended: boolean;
  };
}

export interface AutoApprovalSettingsResponse {
  accountDefault: AutoApprovalPolicyApiState;
  locations: AutoApprovalLocationSettings[];
  readiness: AutoApprovalReadiness;
}

// 'standard' is the ONLY level the server can require since the threshold
// floor rose to 4★ (WS4 — 'all_ratings' guarded the dead 1-star option).
// The member stays ACCEPTED as input for one release: a stale cached client
// may still submit it, and it satisfies 'standard' (the pre-WS4
// confirmationSatisfies tolerance). Drop it once the Task-13 UI has shipped
// for a release; Task 13 also removes the client-side comparison that keeps
// this union two-membered.
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
  // Dial operations (WS8 §4.3): veto shortening and cap raising/removal are
  // exposure expansions and require `standard`; contractions and exact no-ops
  // do not. The optional field preserves that one-operation PATCH shape.
  z.strictObject({
    operation: z.literal('set_account_veto_window'),
    minutes: VetoWindowMinutesSchema,
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal('set_location_veto_window'),
    locationId: z.uuid(),
    minutes: VetoWindowMinutesSchema,
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal('set_account_daily_cap'),
    cap: DailyAutoPostCapSchema,
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal('set_location_daily_cap'),
    locationId: z.uuid(),
    cap: DailyAutoPostCapSchema,
    confirmationLevel: AutoApprovalConfirmationLevelSchema.optional(),
  }),
]);

export type AutoApprovalPatchRequest = z.infer<typeof AutoApprovalPatchSchema>;

export function isAutoApprovalThreshold(value: unknown): value is AutoApprovalThreshold {
  return AutoApprovalThresholdSchema.safeParse(value).success;
}

export function isVetoWindowMinutes(value: unknown): value is VetoWindowMinutes {
  return VetoWindowMinutesSchema.safeParse(value).success;
}
