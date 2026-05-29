import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCacheRedis } from '@/lib/db/redis-cache';
import {
  ZERNIO_CONNECT_COOKIE_NAME,
  verifySignedConnectSessionValue,
} from '@/lib/zernio/connect-session-cookie';
import { locationsKey } from '@/lib/zernio/connect-state';
import type { ConnectLocationsBlob } from '@/lib/zernio/types';
import { LocationPicker } from './LocationPicker';
import { TopBar } from '@/components/dashboard/TopBar';

export const dynamic = 'force-dynamic';

/**
 * Spec §3.3.5 — connect/select-location landing page.
 *
 * Server component reads the signed `zernio_connect_session` cookie, looks up
 * the cached locations blob in Redis, and hands the location list to the
 * client `<LocationPicker>` for selection. Defence-in-depth scoping (userId /
 * businessId / known location) lives inside the POST handler — this page only
 * needs to verify the cookie + that the blob exists; selection submits to
 * `/api/zernio/connect/select-location` which runs the full guard.
 */
export default async function SelectLocationPage() {
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
    // Mirror the API gating: if the feature flag is off we should not render
    // the picker at all.
    redirect('/dashboard');
  }

  const cookieStore = await cookies();
  const signed = cookieStore.get(ZERNIO_CONNECT_COOKIE_NAME)?.value;
  const sessionId = verifySignedConnectSessionValue(signed);
  if (!sessionId) {
    redirect('/dashboard/connect?error=session_missing');
  }

  const redis = getCacheRedis();
  let raw: string | null = null;
  try {
    raw = await redis.get(locationsKey(sessionId));
  } catch (err) {
    // ioredis can throw on connection failure / network blip / AbortError.
    // Don't crash the page — surface a recoverable error and let the owner
    // retry from the connect entrypoint. Log so ops can see Redis health.
    console.error(
      '[dashboard/connect/select-location] Redis read failed (treating as cache_unavailable):',
      err,
    );
    redirect('/dashboard/connect?error=cache_unavailable');
  }
  if (!raw) {
    redirect('/dashboard/connect?error=session_expired');
  }

  let blob: ConnectLocationsBlob;
  try {
    blob = JSON.parse(raw) as ConnectLocationsBlob;
  } catch {
    redirect('/dashboard/connect?error=session_invalid');
  }

  if (!Array.isArray(blob.locations) || blob.locations.length === 0) {
    redirect('/dashboard/connect?error=no_locations');
  }

  return (
    <>
      <TopBar
        title="Connect Google Business"
        subtitle="Select location"
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <LocationPicker locations={blob.locations} />
    </>
  );
}
