import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from '../transport';

interface MockLocationsResponse {
  locations: Array<{ id: string; name: string; address: string }>;
}

async function listMockLocations(): Promise<MockLocationsResponse> {
  return request<MockLocationsResponse>({
    method: 'GET',
    path: '/v1/connect/googlebusiness/locations',
    endpointKind: 'list_locations',
  });
}

describe('mock list_locations — MOCK_ZERNIO_LOCATION_COUNT', () => {
  let originalMockExternalApis: string | undefined;
  let originalLocationCount: string | undefined;

  beforeEach(() => {
    originalMockExternalApis = process.env.MOCK_EXTERNAL_APIS;
    originalLocationCount = process.env.MOCK_ZERNIO_LOCATION_COUNT;
    process.env.MOCK_EXTERNAL_APIS = 'true';
  });

  afterEach(() => {
    if (originalMockExternalApis === undefined) {
      delete process.env.MOCK_EXTERNAL_APIS;
    } else {
      process.env.MOCK_EXTERNAL_APIS = originalMockExternalApis;
    }
    if (originalLocationCount === undefined) {
      delete process.env.MOCK_ZERNIO_LOCATION_COUNT;
    } else {
      process.env.MOCK_ZERNIO_LOCATION_COUNT = originalLocationCount;
    }
  });

  it('defaults to exactly one location (mock-loc-1) when the count is unset', async () => {
    delete process.env.MOCK_ZERNIO_LOCATION_COUNT;
    const { locations } = await listMockLocations();
    expect(locations).toHaveLength(1);
    expect(locations[0]!.id).toBe('mock-loc-1');
    expect(locations[0]!.name).toBeTruthy();
    expect(locations[0]!.address).toBeTruthy();
  });

  it('returns exactly two distinct locations when count=2', async () => {
    process.env.MOCK_ZERNIO_LOCATION_COUNT = '2';
    const { locations } = await listMockLocations();
    expect(locations.map((l) => l.id)).toEqual(['mock-loc-1', 'mock-loc-2']);
    const names = locations.map((l) => l.name);
    expect(new Set(names).size).toBe(2);
    const addresses = locations.map((l) => l.address);
    expect(new Set(addresses).size).toBe(2);
  });

  it('returns exactly three locations when count=3', async () => {
    process.env.MOCK_ZERNIO_LOCATION_COUNT = '3';
    const { locations } = await listMockLocations();
    expect(locations.map((l) => l.id)).toEqual([
      'mock-loc-1',
      'mock-loc-2',
      'mock-loc-3',
    ]);
  });

  it('falls back to one location for a non-numeric count', async () => {
    process.env.MOCK_ZERNIO_LOCATION_COUNT = 'banana';
    const { locations } = await listMockLocations();
    expect(locations.map((l) => l.id)).toEqual(['mock-loc-1']);
  });

  it('falls back to one location for a count below one', async () => {
    process.env.MOCK_ZERNIO_LOCATION_COUNT = '0';
    const { locations } = await listMockLocations();
    expect(locations.map((l) => l.id)).toEqual(['mock-loc-1']);
  });

  it('clamps a runaway count to the ceiling instead of building a giant array', async () => {
    // Number('1e8') is a valid integer — without the ceiling this would
    // allocate 100M mock locations in-process.
    process.env.MOCK_ZERNIO_LOCATION_COUNT = '1e8';
    const { locations } = await listMockLocations();
    expect(locations).toHaveLength(50);
    expect(locations[0]!.id).toBe('mock-loc-1');
    expect(locations[49]!.id).toBe('mock-loc-50');
  });
});
