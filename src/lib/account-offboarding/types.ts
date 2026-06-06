export const ACCOUNT_OFFBOARDING_MODES = ['cancel_only', 'delete_data'] as const;
export type AccountOffboardingMode = (typeof ACCOUNT_OFFBOARDING_MODES)[number];

export const ACCOUNT_OFFBOARDING_STATUSES = [
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

export const ACCOUNT_OFFBOARDING_TERMINAL_STATUSES = [
  'purged',
  'churned',
  'reactivated',
] as const satisfies readonly AccountOffboardingStatus[];
export type AccountOffboardingTerminalStatus =
  (typeof ACCOUNT_OFFBOARDING_TERMINAL_STATUSES)[number];

export const ACCOUNT_OFFBOARDING_ACTIVE_STATUSES = [
  'pending',
  'scheduled',
  'tearing_down',
  'purge_scheduled',
  'failed',
] as const satisfies readonly AccountOffboardingStatus[];
export type AccountOffboardingActiveStatus =
  (typeof ACCOUNT_OFFBOARDING_ACTIVE_STATUSES)[number];

export const ACCOUNT_OFFBOARDING_FAILED_STEPS = [
  'billing',
  'teardown',
  'purge',
] as const;
export type AccountOffboardingFailedStep =
  (typeof ACCOUNT_OFFBOARDING_FAILED_STEPS)[number];

export const ACCOUNT_OFFBOARDING_STEP_OUTCOMES = [
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
