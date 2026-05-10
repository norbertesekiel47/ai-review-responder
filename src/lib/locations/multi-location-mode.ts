export function shouldUseMultiLocationSettings(
  featureEnabled: boolean,
  activeLocationCount: number,
): boolean {
  return featureEnabled && activeLocationCount > 1;
}
