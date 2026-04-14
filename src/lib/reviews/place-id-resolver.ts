import { getJson } from 'serpapi';
import { isPlaceId } from './url-parser';
import type { GoogleMapsUrlData } from './url-parser';
import { checkRateLimit } from '@/lib/shared/rate-limit';

const MATCH_RADIUS_M = 200;
const DAILY_LIMIT = 75;
const DAILY_WINDOW_S = 86400;

interface SerpApiLocalResult {
  place_id?: string;
  title?: string;
  gps_coordinates?: { latitude: number; longitude: number };
  address?: string;
}

/**
 * Resolves GoogleMapsUrlData to a canonical Place ID.
 *
 * Strategy:
 * 1. Canonical Place ID present → return directly
 * 2. Business name + coordinates → SerpAPI google_maps search → match by proximity
 * 3. Anything else → fail fast
 */
export async function resolvePlaceId(data: GoogleMapsUrlData): Promise<string> {
  // Strategy 1: already canonical
  if (data.placeId && isPlaceId(data.placeId)) {
    return data.placeId;
  }

  // Strategy 3: fail fast if missing required data
  if (!data.businessName && !data.coordinates) {
    throw new Error(
      'Cannot resolve Place ID without business name and coordinates — use the search field instead',
    );
  }
  if (!data.coordinates) {
    throw new Error(
      'Cannot resolve Place ID without coordinates — use the search field instead',
    );
  }
  if (!data.businessName) {
    throw new Error(
      'Cannot resolve Place ID without business name and coordinates — use the search field instead',
    );
  }

  // Strategy 2: SerpAPI search
  const limit = await checkRateLimit('serpapi:resolve:daily', DAILY_LIMIT, DAILY_WINDOW_S);
  if (!limit.allowed) {
    throw new Error('Daily Place ID resolution limit reached — use the search field instead');
  }

  const params: Record<string, unknown> = {
    engine: 'google_maps',
    q: data.businessName,
    ll: `@${data.coordinates.lat},${data.coordinates.lng},15z`,
    type: 'search',
    api_key: process.env.SERPAPI_API_KEY,
  };

  const response = await getJson(params);

  if (response.error) {
    const msg = typeof response.error === 'string' ? response.error : JSON.stringify(response.error);
    throw new Error(`SerpAPI search error: ${msg}`);
  }

  const results: SerpApiLocalResult[] = response.local_results ?? [];
  if (results.length === 0) {
    throw new Error('Could not verify business location — try using the search field instead');
  }

  // Find best match within MATCH_RADIUS_M
  const targetLat = data.coordinates.lat;
  const targetLng = data.coordinates.lng;
  const targetName = normalizeName(data.businessName);

  let bestMatch: SerpApiLocalResult | null = null;
  let bestDistance = Infinity;

  for (const result of results) {
    if (!result.place_id || !result.gps_coordinates) continue;

    const distance = haversineMeters(
      targetLat, targetLng,
      result.gps_coordinates.latitude, result.gps_coordinates.longitude,
    );

    if (distance > MATCH_RADIUS_M) continue;

    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = result;
    } else if (distance === bestDistance && result.title) {
      const currentNameSim = normalizeName(bestMatch?.title ?? '');
      const candidateNameSim = normalizeName(result.title);
      if (candidateNameSim === targetName && currentNameSim !== targetName) {
        bestMatch = result;
      }
    }
  }

  if (!bestMatch?.place_id) {
    throw new Error('Could not verify business location — try using the search field instead');
  }

  return bestMatch.place_id;
}

function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function haversineMeters(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
