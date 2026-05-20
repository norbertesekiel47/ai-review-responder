import { resolvePlaceId } from '../../../src/lib/reviews/place-id-resolver';
import { isPlaceId, parseGoogleMapsUrl } from '../../../src/lib/reviews/url-parser';

export async function resolveOnboardingDemoPlaceId(input: {
  googlePlaceId: string;
  googleMapsUrl: string | undefined;
  mockMode: boolean;
}): Promise<string> {
  if (isPlaceId(input.googlePlaceId)) {
    return input.googlePlaceId;
  }

  if (input.mockMode) {
    // In mock mode fetchSerpApiReviews is stubbed — any non-empty string
    // works as the place identifier. Skip the real SerpAPI resolution.
    return input.googlePlaceId || 'mock-place-id';
  }

  if (input.googleMapsUrl) {
    const urlData = parseGoogleMapsUrl(input.googleMapsUrl);
    return resolvePlaceId(urlData);
  }

  throw new Error('Invalid Place ID and no URL available for resolution');
}
