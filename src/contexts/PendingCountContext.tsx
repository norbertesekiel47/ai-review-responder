'use client';

import { createContext, use, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Lifts the dashboard's pending-approval count into a layout-scoped context
 * so the mobile bottom tabbar can render a red badge on the "Needs Action"
 * tab without firing a second /api/dashboard request.
 *
 * Population:
 *   - The authenticated layout seeds the provider with a server-side count
 *     when it resolves the owner's business_id. This makes the badge
 *     accurate on cold loads of /settings and /dashboard/reviews/history.
 *   - DashboardContent calls useSetPendingCount() inside a useEffect that
 *     fires when its `data` resolves, keeping the count fresh across
 *     refresh ticks and approve actions. The count survives across
 *     navigation between authenticated routes — the layout (and therefore
 *     this provider) doesn't unmount.
 */
interface ContextValue {
  count: number;
  setCount: Dispatch<SetStateAction<number>>;
}

const PendingCountContext = createContext<ContextValue>({
  count: 0,
  setCount: () => {},
});

export function PendingCountProvider({
  children,
  initialCount = 0,
}: {
  children: React.ReactNode;
  initialCount?: number;
}) {
  const [count, setCount] = useState(initialCount);
  const value = useMemo(() => ({ count, setCount }), [count]);
  return (
    <PendingCountContext.Provider value={value}>
      {children}
    </PendingCountContext.Provider>
  );
}

export function usePendingCount(): number {
  return use(PendingCountContext).count;
}

export function useSetPendingCount(): Dispatch<SetStateAction<number>> {
  return use(PendingCountContext).setCount;
}
