/**
 * `fetch` with an explicit bounded timeout (production.md: every outbound call
 * gets a finite wait). On timeout the underlying request is aborted and the
 * call rejects (an `AbortError`), which the auth flows already map to their
 * generic "Connection failed / try again" copy — so a hung connection can no
 * longer leave a spinner stuck forever.
 *
 * Scope: the browser→Next API-route `fetch` calls in the auth flows. Supabase
 * SDK calls (`signInWithPassword`, `signInWithOAuth`) are not `fetch` and manage
 * their own transport; the OAuth path has its own stuck-spinner fallback.
 */
const DEFAULT_TIMEOUT_MS = 12_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
