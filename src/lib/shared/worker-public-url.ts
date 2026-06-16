/**
 * Single authoritative reader for WORKER_PUBLIC_URL. Strips trailing slashes so
 * callers can safely append a path (a trailing slash would otherwise produce a
 * double-slash URL and break Twilio signature verification / status callbacks).
 */
export function getWorkerPublicUrl(): string {
  const raw = process.env.WORKER_PUBLIC_URL;
  if (!raw) throw new Error('WORKER_PUBLIC_URL is not set');
  return raw.replace(/\/+$/, '');
}
