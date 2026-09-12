import { readFlag } from '@/lib/config/flags';

/**
 * Server-only. Off/unset means the Operator surface does not exist: the POST
 * route 404s before any write and the worker fails its turn `operator_disabled`
 * without loading tenant context. No `NEXT_PUBLIC_*` companion (invariant #13)
 * — the browser learns the state from the 404.
 */
export function ownerOperatorEnabled(): boolean {
  return readFlag('OWNER_OPERATOR_ENABLED');
}
