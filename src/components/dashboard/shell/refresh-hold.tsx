'use client';

// Refresh hold — the one signal between a list surface's rows and the shell's
// auto-refresh (UX audit D1). A row that is mid-edit, or waiting on a regenerated
// draft, acquires a hold; the TopBar skips its 60 s tick while any hold is
// live, so the owner's typed text and the in-row progress state survive.
//
// Manual Refresh is deliberately NOT held: an explicit click is the owner
// saying "replace what I see".
//
// Context rather than a module-level store so two Reviews surfaces in one tree
// (an unlikely future) cannot hold each other, and so the default — no provider
// mounted — reads as "not held", which keeps every TopBar without a provider
// working exactly as before.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface RefreshHoldValue {
  held: boolean;
  /** Acquire a hold; returns the release. */
  acquire: () => () => void;
}

const RefreshHoldContext = createContext<RefreshHoldValue | null>(null);

export function RefreshHoldProvider({ children }: { children: ReactNode }) {
  const [holds, setHolds] = useState(0);
  const acquire = useCallback(() => {
    setHolds((count) => count + 1);
    return () => setHolds((count) => Math.max(0, count - 1));
  }, []);
  const value = useMemo(() => ({ held: holds > 0, acquire }), [holds, acquire]);
  return <RefreshHoldContext.Provider value={value}>{children}</RefreshHoldContext.Provider>;
}

/** True while any row in the surface holds the auto-refresh. */
export function useRefreshHeld(): boolean {
  return useContext(RefreshHoldContext)?.held ?? false;
}

/** Hold the surface's auto-refresh while `active` is true. */
export function useRefreshHold(active: boolean): void {
  const acquire = useContext(RefreshHoldContext)?.acquire;
  useEffect(() => {
    if (!active || !acquire) return;
    return acquire();
  }, [active, acquire]);
}
