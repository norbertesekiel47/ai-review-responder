export type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Best-effort JSON decoding for browser fetches. Error pages from proxies and
 * upstream services are frequently HTML or empty, so callers must not assume
 * every response body is JSON.
 */
export async function readJsonObject(response: Response): Promise<JsonObject> {
  const contentType = response.headers?.get?.('content-type')?.toLowerCase();
  if (contentType && !contentType.includes('/json') && !contentType.includes('+json')) {
    return {};
  }

  try {
    const body: unknown = await response.json();
    return isJsonObject(body) ? body : {};
  } catch {
    return {};
  }
}

export function apiErrorMessage(
  body: JsonObject,
  fallback: string,
  status?: number,
): string {
  const detail = typeof body.detail === 'string' ? body.detail : null;
  const error = typeof body.error === 'string' ? body.error : null;
  return detail ?? error ?? (status ? `${fallback} (${status})` : fallback);
}
