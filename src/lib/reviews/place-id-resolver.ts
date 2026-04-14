import { getJson } from 'serpapi';
import { isPlaceId } from './url-parser';
import type { GoogleMapsUrlData } from './url-parser';
import { getCacheRedis } from '@/lib/db/redis-cache';

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

  // Strategy 2: SerpAPI search — fail closed (block if Redis unavailable)
  await checkSerpApiResolutionBudget();

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

  // Find best match: must be within MATCH_RADIUS_M AND have a similar name.
  // SerpAPI's ll is only a search origin hint — results can be anywhere.
  // In dense areas (strip malls), distance alone picks the wrong business.
  const targetLat = data.coordinates.lat;
  const targetLng = data.coordinates.lng;
  const targetName = normalizeName(data.businessName);

  let bestMatch: SerpApiLocalResult | null = null;
  let bestScore = -1;

  for (const result of results) {
    if (!result.place_id || !result.gps_coordinates || !result.title) continue;

    const distance = haversineMeters(
      targetLat, targetLng,
      result.gps_coordinates.latitude, result.gps_coordinates.longitude,
    );

    if (distance > MATCH_RADIUS_M) continue;

    const similarity = nameSimilarity(targetName, normalizeName(result.title));
    if (similarity < 0.4) continue; // reject poor name matches even if close by

    // Score: weight name similarity heavily, use distance as tiebreaker
    const score = similarity * 1000 - distance;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = result;
    }
  }

  if (!bestMatch?.place_id) {
    throw new Error('Could not verify business location — try using the search field instead');
  }

  return bestMatch.place_id;
}

/** Fail-closed SerpAPI budget guard. Blocks if Redis is unavailable (unlike checkRateLimit which fails open). */
async function checkSerpApiResolutionBudget(): Promise<void> {
  if (!process.env.REDIS_CACHE_URL) {
    throw new Error('Daily Place ID resolution limit unavailable — use the search field instead');
  }

  try {
    const redis = getCacheRedis();
    const key = 'serpapi:resolve:daily';
    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, DAILY_WINDOW_S);
    }

    if (current > DAILY_LIMIT) {
      throw new Error('Daily Place ID resolution limit reached — use the search field instead');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Daily Place ID resolution limit')) {
      throw err;
    }
    throw new Error('Daily Place ID resolution limit unavailable — use the search field instead');
  }
}

function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns 0-1 similarity score. 1 = exact match, 0 = no overlap. */
function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Check containment (handles "Cafe LaTTea" vs "Cafe LaTTea - Downtown")
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return shorter / longer;
  }

  // Word overlap ratio
  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const totalUnique = new Set([...wordsA, ...wordsB]).size;
  return totalUnique > 0 ? overlap / totalUnique : 0;
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
