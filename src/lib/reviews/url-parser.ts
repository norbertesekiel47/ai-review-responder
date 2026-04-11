/**
 * Extracts a Google Place ID from various Google Maps URL formats.
 *
 * Supported formats:
 * - Raw Place ID: "ChIJN1t_tDeuEmsRUsoyG83frY4"
 * - Place query param: "https://www.google.com/maps/place/?q=place_id:ChIJ..."
 * - Write review URL: "https://search.google.com/local/writereview?placeid=ChIJ..."
 * - Data path: "https://www.google.com/maps/place/.../@.../data=...!1sChIJ..."
 *
 * Returns null if no Place ID can be extracted.
 * CID URLs (google.com/maps?cid=...) return null — CID is not a Place ID.
 */
export function extractPlaceId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Raw Place ID (starts with ChIJ, typically 27+ chars, base64-like)
  if (/^ChIJ[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // ?q=place_id:ChIJ... or &place_id=ChIJ...
  const qParam = url.searchParams.get('q');
  if (qParam?.startsWith('place_id:')) {
    return qParam.slice('place_id:'.length);
  }

  // ?placeid=ChIJ... (Google's write-review URL)
  const placeIdParam =
    url.searchParams.get('placeid') ?? url.searchParams.get('place_id');
  if (placeIdParam) {
    return placeIdParam;
  }

  // /data=...!1sChIJ... in the URL path or fragment
  const dataExtracted = trimmed.match(/!1s(ChIJ[A-Za-z0-9_-]+)/)?.[1];
  if (dataExtracted) {
    return dataExtracted;
  }

  // Path segment that looks like a Place ID
  const pathExtracted = trimmed.match(/\/(ChIJ[A-Za-z0-9_-]{20,})/)?.[1];
  if (pathExtracted) {
    return pathExtracted;
  }

  return null;
}
