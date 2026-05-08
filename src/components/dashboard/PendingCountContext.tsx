'use client';

import { createContext, useContext, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Lifts the dashboard's pending-approval count into a layout-scoped context
 * so the mobile bottom tabbar can render a red badge on the "Needs Action"
 * tab without firing a second /api/dashboard request.
 *
 * Population:
 *   - DashboardContent calls useSetPendingCount() inside a useEffect that
 *     fires when its `data` resolves; the count survives across navigation
 *     to /settings or /dashboard/past-replies (the layout, and therefore
 *     the provider, doesn't unmount).
 *   - On non-dashboard initial loads (e.g. user lands directly on
 *     /settings), the badge starts at 0 until the user visits /dashboard.
 *     Acceptable because the dashboard is the natural source for that
 *     count and we deliberately don't add a parallel API.
 */
interface ContextValue {
  count: number;
  setCount: Dispatch<SetStateAction<number>>;
}

const PendingCountContext = createContext<ContextValue>({
  count: 0,
  setCount: () => {},
});

export function PendingCountProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);
  return (
    <PendingCountContext.Provider value={{ count, setCount }}>
      {children}
    </PendingCountContext.Provider>
  );
}

export function usePendingCount(): number {
  return useContext(PendingCountContext).count;
}

export function useSetPendingCount(): Dispatch<SetStateAction<number>> {
  return useContext(PendingCountContext).setCount;
}
