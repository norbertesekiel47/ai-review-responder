/**
 * Utilities for parsing Google Maps URLs and extracting business identifiers.
 *
 * Supported Place ID formats:
 *   - ChIJ... (most common, 27 chars)
 *   - GhIJ... (newer format)
 *   - Eic... (address-based)
 *   - Any base64url string starting with a letter, 20+ chars
 *
 * Hex CID format: 0x{hex}:0x{hex} — NOT a Place ID; treated separately.
 *
 * CID URLs (google.com/maps?cid=...) return null from extractPlaceId —
 * numeric CIDs cannot be used as Place IDs in the Google APIs.
 */

export const PLACE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{19,}$/;
export const HEX_CID_RE = /^0x[0-9a-fA-F]+:0x[0-9a-fA-F]+$/;

export function isPlaceId(identifier: string): boolean {
  return PLACE_ID_RE.test(identifier);
}

export function isHexCid(identifier: string): boolean {
  return HEX_CID_RE.test(identifier);
}

export interface GoogleMapsUrlData {
  placeId: string | null;
  hexCid: string | null;
  businessName: string | null;
  coordinates: { lat: number; lng: number } | null;
}

export function parseGoogleMapsUrl(input: string): GoogleMapsUrlData {
  const result: GoogleMapsUrlData = {
    placeId: null,
    hexCid: null,
    businessName: null,
    coordinates: null,
  };

  const trimmed = input.trim();
  if (trimmed.length === 0) return result;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return result;
  }

  // Business name from /place/Name/ segment
  const nameMatch = url.pathname.match(/\/place\/([^/@]+)/);
  if (nameMatch) {
    result.businessName = decodeURIComponent(nameMatch[1]!.replace(/\+/g, ' '));
  }

  // Coordinates from /@lat,lng segment
  const coordMatch = trimmed.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]!);
    const lng = parseFloat(coordMatch[2]!);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      result.coordinates = { lat, lng };
    }
  }

  // Canonical Place ID from query params
  const qParam = url.searchParams.get('q');
  if (qParam?.startsWith('place_id:')) {
    result.placeId = qParam.slice('place_id:'.length);
    return result;
  }
  const placeIdParam = url.searchParams.get('placeid') ?? url.searchParams.get('place_id');
  if (placeIdParam) {
    result.placeId = placeIdParam;
    return result;
  }

  // Scan all !1s tokens — prefer Place ID over hex CID when both appear.
  // Real URLs can have !1s0x{hexcid}!...!1sChIJ{placeid} where the hex CID
  // appears first but the Place ID is the canonical identifier we want.
  const dataTokenRe = /!1s([A-Za-z0-9_:+/-]{4,})/g;
  let dataMatch: RegExpExecArray | null;
  let foundHexCid: string | null = null;

  while ((dataMatch = dataTokenRe.exec(trimmed)) !== null) {
    const token = dataMatch[1]!;
    if (PLACE_ID_RE.test(token)) {
      result.placeId = token;
      return result;
    }
    if (foundHexCid === null && HEX_CID_RE.test(token)) {
      foundHexCid = token;
    }
  }

  if (foundHexCid !== null) {
    result.hexCid = foundHexCid;
  }

  return result;
}

/**
 * Extracts a Google Place ID or hex CID from various Google Maps URL formats.
 *
 * Supported formats:
 * - Raw Place ID: "ChIJN1t_tDeuEmsRUsoyG83frY4"
 * - Place query param: "https://www.google.com/maps/place/?q=place_id:ChIJ..."
 * - Write review URL: "https://search.google.com/local/writereview?placeid=ChIJ..."
 * - Data path: "https://www.google.com/maps/place/.../@.../data=...!1sChIJ..."
 * - Hex CID in data path: "...!1s0x808fb59e48e954f1:0xd8ad2f3c266775b..."
 *
 * Returns null if no Place ID or hex CID can be extracted.
 */
export function extractPlaceId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Raw Place ID (base64url, 20+ chars, starts with a letter)
  if (PLACE_ID_RE.test(trimmed)) {
    return trimmed;
  }

  const parsed = parseGoogleMapsUrl(trimmed);
  return parsed.placeId ?? parsed.hexCid ?? null;
}
