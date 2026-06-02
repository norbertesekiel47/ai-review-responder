'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * App-wide client providers. React Query was previously mounted only under
 * /admin; lifting a QueryClientProvider to the root lets client data hooks
 * across all route trees use `useQuery` (one client per browser session,
 * created lazily so SSR and each client mount get their own instance).
 */
export function RootProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
