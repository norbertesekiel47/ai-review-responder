import { getOffboardingState, isOperationalUIBlocked } from './gate';

export interface AccountOffboardingStatusSummary {
  id: string;
  accountId: string;
  mode: string;
  status: string;
  failedStep: string | null;
  accessEndsAt: Date | null;
  teardownStartedAt: Date | null;
  purgeAfter: Date | null;
  operationalUIBlocked: boolean;
}

export interface AccountOffboardingStatusResult {
  activeOffboarding: AccountOffboardingStatusSummary | null;
}

export async function getAccountOffboardingStatus(
  accountId: string,
): Promise<AccountOffboardingStatusResult> {
  const state = await getOffboardingState(accountId);
  return {
    activeOffboarding: state
      ? {
        id: state.id,
        accountId: state.accountId,
        mode: state.mode,
        status: state.status,
        failedStep: state.failedStep,
        accessEndsAt: state.accessEndsAt,
        teardownStartedAt: state.teardownStartedAt,
        purgeAfter: state.purgeAfter,
        operationalUIBlocked: isOperationalUIBlocked(state),
      }
      : null,
  };
}
