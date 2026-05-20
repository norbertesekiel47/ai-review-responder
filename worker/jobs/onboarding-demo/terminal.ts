import { failDemo } from '../../../src/lib/demos/lifecycle';

export async function failOnboardingDemoTerminal(input: {
  demoId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  error: Error;
  logger: { error(message: string): void };
}): Promise<void> {
  try {
    await failDemo(
      'onboarding_demos',
      input.demoId,
      input.outboxId,
      input.outboxAttempt,
      input.error,
    );
  } catch (txError) {
    if (input.error.message === 'subscription_state_changed') {
      input.logger.error(
        `Failed to record subscription_state_changed for demo ${input.demoId}: ${txError instanceof Error ? txError.message : String(txError)}`,
      );
    } else {
      input.logger.error(
        `Failed to record failure for demo ${input.demoId}: ${txError instanceof Error ? txError.message : String(txError)}`,
      );
    }
    throw txError;
  }
}
