// eslint-disable-next-line @typescript-eslint/no-unused-vars -- runtime array backs the exported typeof-derived union (and satisfies subset checks); value is intentionally type-only here
const ACCOUNT_OFFBOARDING_MODES = ['cancel_only', 'delete_data'] as const;
export type AccountOffboardingMode = (typeof ACCOUNT_OFFBOARDING_MODES)[number];

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- runtime array backs the exported typeof-derived union (and satisfies subset checks); value is intentionally type-only here
const ACCOUNT_OFFBOARDING_STATUSES = [
  'pending',
  'scheduled',
  'tearing_down',
  'purge_scheduled',
  'purged',
  'churned',
  'reactivated',
  'failed',
] as const;
export type AccountOffboardingStatus =
  (typeof ACCOUNT_OFFBOARDING_STATUSES)[number];

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- runtime array backs the exported typeof-derived union (and satisfies subset checks); value is intentionally type-only here
const ACCOUNT_OFFBOARDING_TERMINAL_STATUSES = [
  'purged',
  'churned',
  'reactivated',
] as const satisfies readonly AccountOffboardingStatus[];
export type AccountOffboardingTerminalStatus =
  (typeof ACCOUNT_OFFBOARDING_TERMINAL_STATUSES)[number];

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- runtime array backs the exported typeof-derived union (and satisfies subset checks); value is intentionally type-only here
const ACCOUNT_OFFBOARDING_ACTIVE_STATUSES = [
  'pending',
  'scheduled',
  'tearing_down',
  'purge_scheduled',
  'failed',
] as const satisfies readonly AccountOffboardingStatus[];
export type AccountOffboardingActiveStatus =
  (typeof ACCOUNT_OFFBOARDING_ACTIVE_STATUSES)[number];

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- runtime array backs the exported typeof-derived union (and satisfies subset checks); value is intentionally type-only here
const ACCOUNT_OFFBOARDING_FAILED_STEPS = [
  'billing',
  'teardown',
  'purge',
] as const;
export type AccountOffboardingFailedStep =
  (typeof ACCOUNT_OFFBOARDING_FAILED_STEPS)[number];

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- runtime array backs the exported typeof-derived union (and satisfies subset checks); value is intentionally type-only here
const ACCOUNT_OFFBOARDING_STEP_OUTCOMES = [
  'success',
  'failed',
  'not_applicable',
] as const;
export type AccountOffboardingStepOutcome =
  (typeof ACCOUNT_OFFBOARDING_STEP_OUTCOMES)[number];

export interface ActiveOffboardingState {
  id: string;
  accountId: string;
  mode: AccountOffboardingMode;
  status: AccountOffboardingActiveStatus;
  failedStep: AccountOffboardingFailedStep | null;
  terminalAt: null;
  accessEndsAt: Date | null;
  teardownStartedAt: Date | null;
  purgeAfter: Date | null;
  purgeStartedAt: Date | null;
  purgeCancelledAt: Date | null;
}
