/**
 * Single authoritative reader for WORKER_PUBLIC_URL. Normalizes to the URL origin
 * (scheme://host[:port]), dropping any path, query string, fragment, trailing slash,
 * or userinfo so callers can safely append a path without double-slash or stale
 * component issues (Twilio signature verification, status callbacks, etc.). (F-13/P3)
 */
export function getWorkerPublicUrl(): string {
  const raw = process.env.WORKER_PUBLIC_URL;
  if (!raw) throw new Error('WORKER_PUBLIC_URL is not set');
  return new URL(raw).origin;
}
