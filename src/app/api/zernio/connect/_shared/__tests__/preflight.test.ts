import { describe, expect, it } from 'vitest';
import { parseRequestedLocationId } from '../preflight';

describe('parseRequestedLocationId', () => {
  it('returns null when body has no locationId', () => {
    expect(parseRequestedLocationId({})).toBeNull();
  });

  it('trims a valid locationId', () => {
    expect(
      parseRequestedLocationId({
        locationId: '  018f6a77-2c2a-7000-8000-000000000001  ',
      }),
    ).toBe('018f6a77-2c2a-7000-8000-000000000001');
  });

  it('throws invalid_body for malformed locationId', () => {
    expect(() => parseRequestedLocationId({ locationId: 'not-a-uuid' })).toThrow(
      'invalid_body',
    );
  });
});
