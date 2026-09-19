import * as Sentry from '@sentry/node';

/**
 * Reconciles the pessimistic 20¢ reserve toward actual spend after a demo
 * completes.
 *
 * Best-effort by design: the demo row is ALREADY completed in Postgres, so a
 * failure here must never propagate into the worker's outer catch, which would
 * flip a successful row to failed.
 *
 * `finalizeCost` is NOT idempotent — `finalizeOnboardingDemoCost` applies
 * `actual - RESERVATION_CENTS` on every call — so the caller must invoke this
 * exactly once per demo.
 */
export async function finalizeOnboardingDemoSpend(input: {
  reservationDate: string | undefined;
  totalCostUsd: number;
  logger: { error(message: string): void };
  finalizeCost: (date: string, actualCents: number) => Promise<void>;
}): Promise<void> {
  if (!input.reservationDate) return;

  const actualCostCents = Math.round(input.totalCostUsd * 100);
  try {
    // Books against the RESERVATION date from the payload, never today: the
    // reserve was taken at /start and may belong to an earlier day.
    await input.finalizeCost(input.reservationDate, actualCostCents);
  } catch (err) {
    input.logger.error(
      `Failed to finalize cost reservation: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Emits one Sentry message per crossed daily-cost threshold. Best-effort for
 * the same reason as above.
 *
 * ONE try wraps BOTH the lookup and the whole capture loop, exactly as the
 * inline version did. Moving the catch inside the loop would keep emitting
 * after a failed capture; moving the loop outside the try would let a Sentry
 * exception reach the worker's terminal-failure path after the demo has
 * already completed.
 */
export async function reportOnboardingDemoCostThresholds(input: {
  demoId: string;
  logger: { error(message: string): void };
  checkThreshold: (
    lane: string,
    date: string,
    thresholds: number[],
  ) => Promise<{ crossed: number[] }>;
}): Promise<void> {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const { crossed } = await input.checkThreshold('onboarding-demo', date, [50, 90, 100]);
    for (const t of crossed) {
      const level = t === 100 ? 'error' : t >= 90 ? 'warning' : 'info';
      Sentry.captureMessage(`onboarding_demo_cost_threshold_${t}`, {
        level,
        tags: { lane: 'onboarding-demo', threshold: String(t) },
      });
    }
  } catch (thresholdErr) {
    input.logger.error(
      `Threshold check / Sentry capture failed for demo ${input.demoId}: ${thresholdErr instanceof Error ? thresholdErr.message : thresholdErr}`,
    );
  }
}
