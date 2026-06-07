'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { LocationProvider, type LocationInfo, type LocationScope } from '@/contexts/LocationContext';
import type { ReactNode } from 'react';

interface AuthenticatedProvidersProps {
  locations: LocationInfo[];
  initialScope: LocationScope;
  multiLocationEnabled: boolean;
  enableLocationProvider?: boolean;
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
  enableLocationProvider = true,
  children,
}: AuthenticatedProvidersProps) {
  const [queryClient] = useState(() => new QueryClient());

  const content = enableLocationProvider ? (
    <LocationProvider
      locations={locations}
      initialScope={initialScope}
      multiLocationEnabled={multiLocationEnabled}
    >
      {children}
    </LocationProvider>
  ) : (
    children
  );

  return (
    <QueryClientProvider client={queryClient}>
      {content}
    </QueryClientProvider>
  );
}
