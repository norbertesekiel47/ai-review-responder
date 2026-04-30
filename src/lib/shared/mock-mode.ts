/**
 * Returns true when MOCK_EXTERNAL_APIS=true in the environment.
 * Workers use this to swap real API clients for mock implementations.
 */
export function isMockMode(): boolean {
  return process.env.MOCK_EXTERNAL_APIS === 'true';
}
