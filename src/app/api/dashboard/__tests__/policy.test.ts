import { describe, expect, it } from 'vitest';
import { resolveDashboardScopePolicy } from '../policy';

describe('resolveDashboardScopePolicy', () => {
  it('returns aggregate mode for multi-location scope=all', () => {
    expect(
      resolveDashboardScopePolicy({
        scopeParam: 'all',
        userLocationId: 'loc-1',
        multiLocationEnabled: true,
      }),
    ).toEqual({ mode: 'aggregate' });
  });

  it('falls back to user location mode for disabled multi-location scope=all', () => {
    expect(
      resolveDashboardScopePolicy({
        scopeParam: 'all',
        userLocationId: 'loc-1',
        multiLocationEnabled: false,
      }),
    ).toEqual({ mode: 'location', locationId: 'loc-1' });
  });

  it('prefers explicit location scope over user location', () => {
    expect(
      resolveDashboardScopePolicy({
        scopeParam: 'loc-2',
        userLocationId: 'loc-1',
        multiLocationEnabled: true,
      }),
    ).toEqual({ mode: 'location', locationId: 'loc-2' });
  });

  it('uses user location when no scope is provided', () => {
    expect(
      resolveDashboardScopePolicy({
        scopeParam: null,
        userLocationId: 'loc-1',
        multiLocationEnabled: true,
      }),
    ).toEqual({ mode: 'location', locationId: 'loc-1' });
  });

  it('uses null location when no scope or user location is available', () => {
    expect(
      resolveDashboardScopePolicy({
        scopeParam: null,
        userLocationId: undefined,
        multiLocationEnabled: true,
      }),
    ).toEqual({ mode: 'location', locationId: null });
  });
});
