// Place IDs are base64url strings of varying length (20+ chars). Known prefixes
// include ChIJ, GhIJ, Eic, Iho — but Google doesn't guarantee a fixed prefix,
// so we match on character set + minimum length rather than prefix.
const PLACE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{19,}$/;
const HEX_CID_RE = /^0x[0-9a-fA-F]+:0x[0-9a-fA-F]+$/;

/**
 * Extracts a Google Place ID or hex CID from various Google Maps URL formats.
 *
 * Supported formats:
 * - Raw Place ID: "ChIJgUbEo8cfqokR5lP9_Wh_DaM" (any prefix, not just ChIJ)
 * - Place query param: "https://www.google.com/maps/place/?q=place_id:..."
 * - Write review URL: "https://search.google.com/local/writereview?placeid=..."
 * - Data path (Place ID): "https://www.google.com/maps/place/.../@.../data=...!1s<base64url>"
 * - Data path (hex CID): "https://www.google.com/maps/place/.../@.../data=...!1s0x...:0x..."
 *
 * Returns null if no identifier can be extracted.
 */
export function extractPlaceId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Raw Place ID (base64url, 20+ chars, starts with a letter)
  if (PLACE_ID_RE.test(trimmed)) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // ?q=place_id:... or &place_id=...
  const qParam = url.searchParams.get('q');
  if (qParam?.startsWith('place_id:')) {
    return qParam.slice('place_id:'.length);
  }

  // ?placeid=... (Google's write-review URL)
  const placeIdParam =
    url.searchParams.get('placeid') ?? url.searchParams.get('place_id');
  if (placeIdParam) {
    return placeIdParam;
  }

  // /data=...!1s<base64url Place ID> (any prefix — ChIJ, GhIJ, Eic, Iho, etc.)
  // Check BEFORE hex CID: when a URL contains both, prefer the Place ID.
  // No false-match risk — Place IDs start with [A-Za-z], hex CIDs start with 0x.
  const dataExtracted = trimmed.match(/!1s([A-Za-z][A-Za-z0-9_-]{19,})/)?.[1];
  if (dataExtracted) {
    return dataExtracted;
  }

  // /data=...!1s0x...:0x... (hex CID — fallback when no Place ID found)
  const cidExtracted = trimmed.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/)?.[1];
  if (cidExtracted) {
    return cidExtracted;
  }

  // Path segment that looks like a Place ID
  const pathExtracted = trimmed.match(/\/([A-Za-z][A-Za-z0-9_-]{19,})(?:[/?#]|$)/)?.[1];
  if (pathExtracted) {
    return pathExtracted;
  }

  return null;
}

/** Returns true if the identifier is a hex CID (0x...:0x...) rather than a Place ID. */
export function isHexCid(identifier: string): boolean {
  return HEX_CID_RE.test(identifier);
}

/** Returns true if the identifier looks like a Google Place ID (base64url, 20+ chars). */
export function isPlaceId(identifier: string): boolean {
  return PLACE_ID_RE.test(identifier) && !HEX_CID_RE.test(identifier);
}

// ── Rich URL parser ─────────────────────────────────────────────────

export interface GoogleMapsUrlData {
  placeId: string | null;
  hexCid: string | null;
  businessName: string | null;
  coordinates: { lat: number; lng: number } | null;
}

/** Extracts all available data from a Google Maps URL. */
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

  // Canonical Place ID from !1s data path (check before hex CID)
  const dataPlaceId = trimmed.match(/!1s([A-Za-z][A-Za-z0-9_-]{19,})/)?.[1];
  if (dataPlaceId) {
    result.placeId = dataPlaceId;
    return result;
  }

  // Hex CID from !1s data path
  const hexCid = trimmed.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/)?.[1];
  if (hexCid) {
    result.hexCid = hexCid;
  }

  return result;
}
