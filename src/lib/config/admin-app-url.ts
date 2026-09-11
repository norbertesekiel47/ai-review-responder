/**
 * Trusted Admin app home for server redirects and server-provided link props.
 * Lazy and Edge-safe: importing this module never requires environment setup.
 * Request-supplied from/next values must never enter this accessor.
 */
export function adminAppUrl(): string {
  const raw = process.env.ADMIN_APP_URL?.trim();
  const invalid = () => new Error('ADMIN_APP_URL must be a configured HTTP(S) origin without credentials, path, query or fragment');
  if (!raw || /[\\\s*]/.test(raw) || !/^https?:\/\/[^/?#]+\/?$/i.test(raw)) throw invalid();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  if (
    !['http:', 'https:'].includes(url.protocol) || !url.hostname ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash
  ) throw invalid();
  return url.origin;
}
