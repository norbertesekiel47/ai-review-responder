import { describe, it, expect } from 'vitest';
import { parseGoogleMapsUrl, extractPlaceId, isPlaceId, isHexCid } from '../url-parser';

describe('parseGoogleMapsUrl', () => {
  it('extracts all data from a full URL with hex CID', () => {
    const url =
      'https://www.google.com/maps/place/Caf%C3%A9+LaTTea/@37.3231977,-122.0123423,17z/data=!3m1!4b1!4m6!3m5!1s0x808fb59e48e954f1:0xd8ad2f3c266775b!8m2!3d37.3231977!4d-122.0123423';
    const result = parseGoogleMapsUrl(url);

    expect(result.placeId).toBeNull();
    expect(result.hexCid).toBe('0x808fb59e48e954f1:0xd8ad2f3c266775b');
    expect(result.businessName).toBe('Café LaTTea');
    expect(result.coordinates).toEqual({ lat: 37.3231977, lng: -122.0123423 });
  });

  it('extracts canonical Place ID and business name from data path', () => {
    const url =
      'https://www.google.com/maps/place/Test+Restaurant/@40.7,-74.0,17z/data=!3m1!4b1!4m5!3m4!1sChIJgUbEo8cfqokR5lP9_Wh_DaM!8m2!3d40.7!4d-74.0';
    const result = parseGoogleMapsUrl(url);

    expect(result.placeId).toBe('ChIJgUbEo8cfqokR5lP9_Wh_DaM');
    expect(result.hexCid).toBeNull();
    expect(result.businessName).toBe('Test Restaurant');
    expect(result.coordinates).toEqual({ lat: 40.7, lng: -74.0 });
  });

  it('extracts name with special characters (URI decoded)', () => {
    const url = "https://www.google.com/maps/place/Bob%27s+Fish+%26+Chips/@51.5,-0.1,17z";
    const result = parseGoogleMapsUrl(url);
    expect(result.businessName).toBe("Bob's Fish & Chips");
  });

  it('returns all nulls for non-Google-Maps URL', () => {
    const result = parseGoogleMapsUrl('https://example.com/page');
    expect(result).toEqual({ placeId: null, hexCid: null, businessName: null, coordinates: null });
  });

  it('returns all nulls for empty input', () => {
    const result = parseGoogleMapsUrl('');
    expect(result).toEqual({ placeId: null, hexCid: null, businessName: null, coordinates: null });
  });

  it('extracts coordinates even without data path', () => {
    const url = 'https://www.google.com/maps/place/Some+Place/@-33.8688,151.2093,17z';
    const result = parseGoogleMapsUrl(url);
    expect(result.businessName).toBe('Some Place');
    expect(result.coordinates).toEqual({ lat: -33.8688, lng: 151.2093 });
    expect(result.placeId).toBeNull();
    expect(result.hexCid).toBeNull();
  });

  it('handles URL with Place ID in query param', () => {
    const url = 'https://www.google.com/maps/place/?q=place_id:GhIJQWDl0CIeQUARxks3icF8U8A';
    const result = parseGoogleMapsUrl(url);
    expect(result.placeId).toBe('GhIJQWDl0CIeQUARxks3icF8U8A');
  });

  it('prefers Place ID over hex CID when both appear in data path', () => {
    // Real URLs often have hex CID first then Place ID later in the data segment
    const url =
      'https://www.google.com/maps/place/Some+Place/@-33.8,151.2,17z/data=!3m1!4b1!4m5!3m4!1s0x0:0x0!8m2!1sChIJN1t_tDeuEmsRUsoyG83frY4';
    const result = parseGoogleMapsUrl(url);
    expect(result.placeId).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(result.hexCid).toBeNull();
  });
});

describe('isPlaceId', () => {
  it('returns true for ChIJ Place IDs', () => {
    expect(isPlaceId('ChIJgUbEo8cfqokR5lP9_Wh_DaM')).toBe(true);
  });

  it('returns true for GhIJ Place IDs', () => {
    expect(isPlaceId('GhIJQWDl0CIeQUARxks3icF8U8A')).toBe(true);
  });

  it('returns true for Eic Place IDs', () => {
    expect(isPlaceId('EicxMyBNYXJrZXQgU3QsIFdpbG1pbmd0b24sIE5DIDI4NDAxLCBVU0E')).toBe(true);
  });

  it('returns false for hex CIDs', () => {
    expect(isPlaceId('0x808fb59e48e954f1:0xd8ad2f3c266775b')).toBe(false);
  });

  it('returns false for short strings', () => {
    expect(isPlaceId('short')).toBe(false);
  });
});

describe('isHexCid', () => {
  it('returns true for hex CID format', () => {
    expect(isHexCid('0x808fb59e48e954f1:0xd8ad2f3c266775b')).toBe(true);
  });

  it('returns false for Place IDs', () => {
    expect(isHexCid('ChIJgUbEo8cfqokR5lP9_Wh_DaM')).toBe(false);
  });
});

describe('extractPlaceId (existing contract unchanged)', () => {
  it('extracts raw Place ID', () => {
    expect(extractPlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4')).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
  });

  it('extracts from ?q=place_id: param', () => {
    const url = 'https://www.google.com/maps/place/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4';
    expect(extractPlaceId(url)).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
  });

  it('extracts from ?placeid= param (write review URL)', () => {
    const url =
      'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4';
    expect(extractPlaceId(url)).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
  });

  it('returns null for CID URLs (numeric CID ≠ Place ID)', () => {
    const url = 'https://www.google.com/maps?cid=12345678901234567';
    expect(extractPlaceId(url)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractPlaceId('')).toBeNull();
  });

  it('returns null for unrecognized URL', () => {
    expect(extractPlaceId('https://example.com/some-page')).toBeNull();
  });

  it('returns hex CID when no Place ID is found', () => {
    const url =
      'https://www.google.com/maps/place/Caf%C3%A9+LaTTea/@37.3231977,-122.0123423,17z/data=!3m1!4b1!4m6!3m5!1s0x808fb59e48e954f1:0xd8ad2f3c266775b!8m2!3d37.3231977!4d-122.0123423';
    expect(extractPlaceId(url)).toBe('0x808fb59e48e954f1:0xd8ad2f3c266775b');
  });
});
