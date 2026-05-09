'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import type { LocationId } from '@/lib/shared/ids';
import { getDisplayLabel } from '@/lib/locations/display-label';

// ── Constants ───────────────────────────────────────────────────────────────

const LOCATION_SCOPE_COOKIE = 'rw_location_scope';

// ── Cookie helpers (document.cookie — no external dependency) ───────────────

function setScopeCookie(value: string): void {
  document.cookie = `${LOCATION_SCOPE_COOKIE}=${value};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface LocationInfo {
  id: LocationId;
  name: string;
  displayLabel: string | null;
  isPrimary: boolean;
}

export type LocationScope = 'all' | LocationId;

interface LocationContextValue {
  /** Current selected scope — 'all' for aggregate view, or a LocationId for per-location view. */
  currentScope: LocationScope;
  /** Active locations for this account (archived locations excluded). */
  locations: LocationInfo[];
  /** Whether this account has more than one active location. */
  isMultiLocation: boolean;
  /** Human-readable label for the currently selected scope. */
  selectedLabel: string;
  /** Set the location scope — updates context + persists cookie. */
  setLocationScope: (scope: LocationScope) => void;
  /** Update the locations list (e.g., after add/archive). */
  setLocations: (locations: LocationInfo[]) => void;
}

const LocationContext = createContext<LocationContextValue | null>(null);

// ── Helper ──────────────────────────────────────────────────────────────────

function getSelectedLabel(
  scope: LocationScope,
  locations: LocationInfo[],
): string {
  if (scope === 'all') return 'All Locations';
  const loc = locations.find((l) => l.id === scope);
  return loc ? getDisplayLabel(loc) : 'All Locations';
}

// ── Provider ────────────────────────────────────────────────────────────────

interface LocationProviderProps {
  locations: LocationInfo[];
  initialScope: LocationScope;
  multiLocationEnabled: boolean;
  children: ReactNode;
}

export function LocationProvider({
  locations: initialLocations,
  initialScope,
  multiLocationEnabled: initialMultiLocationEnabled,
  children,
}: LocationProviderProps) {
  const [currentScope, setCurrentScope] = useState<LocationScope>(initialScope);
  const [locations, setLocations] = useState<LocationInfo[]>(initialLocations);
  const router = useRouter();

  const isMultiLocation =
    initialMultiLocationEnabled && locations.length > 1;

  const selectedLabel = useMemo(
    () => getSelectedLabel(currentScope, locations),
    [currentScope, locations],
  );

  const setLocationScope = useCallback(
    (scope: LocationScope) => {
      setCurrentScope(scope);
      setScopeCookie(scope === 'all' ? 'all' : scope);

      // Trigger server-side revalidation so layout refetches scoped data
      router.refresh();
    },
    [router],
  );

  const value = useMemo<LocationContextValue>(
    () => ({
      currentScope,
      locations,
      isMultiLocation,
      selectedLabel,
      setLocationScope,
      setLocations,
    }),
    [currentScope, locations, isMultiLocation, selectedLabel, setLocationScope],
  );

  return (
    <LocationContext.Provider value={value}>{children}</LocationContext.Provider>
  );
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useLocationScope(): LocationContextValue {
  const ctx = useContext(LocationContext);
  if (!ctx) {
    throw new Error('useLocationScope must be used within a LocationProvider');
  }
  return ctx;
}
