'use client';

import { LocationProvider, type LocationInfo, type LocationScope } from '@/contexts/LocationContext';
import type { ReactNode } from 'react';

interface AuthenticatedProvidersProps {
  locations: LocationInfo[];
  initialScope: LocationScope;
  multiLocationEnabled: boolean;
  children: ReactNode;
}

/**
 * Client-side providers for the authenticated layout.
 * Wraps children with LocationProvider (and future providers as needed).
 *
 * The LocationProvider receives server-resolved initial data (locations list,
 * initial scope from cookie, and the MULTI_LOCATION_ENABLED flag) and makes
 * it available to all authenticated child components via useLocationScope().
 */
export function AuthenticatedProviders({
  locations,
  initialScope,
  multiLocationEnabled,
  children,
}: AuthenticatedProvidersProps) {
  return (
    <LocationProvider
      locations={locations}
      initialScope={initialScope}
      multiLocationEnabled={multiLocationEnabled}
    >
      {children}
    </LocationProvider>
  );
}
