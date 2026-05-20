export async function releaseOnboardingDemoReservation(input: {
  reservationDate: string | undefined;
  logger: { error(message: string): void };
  finalizeCost: (date: string, actualCents: number) => Promise<void>;
}): Promise<void> {
  if (!input.reservationDate) return;
  try {
    await input.finalizeCost(input.reservationDate, 0);
  } catch (err) {
    input.logger.error(
      `Failed to release cost reservation: ${err instanceof Error ? err.message : err}`,
    );
  }
}
