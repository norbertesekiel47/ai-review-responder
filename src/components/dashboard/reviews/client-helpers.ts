export const REPLY_POLL_INTERVAL_MS = 1500;
export const REPLY_POLL_TIMEOUT_MS = 60_000;

export async function readJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
