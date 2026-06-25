// scripts/ci/config-coverage-baseline.ts
//
// The canonical set of UNCONDITIONALLY boot-required env vars and which config
// lane(s) own each. "Validate-all" is preserved by proving every entry here is
// asserted by at least one lane's boot assert, without one global parse. Shared
// infra (SUPABASE_URL/SUPABASE_SERVICE_KEY/DATABASE_POOL_URL) is owned by BOTH
// the server and worker processes because both read it via src/lib/db/server.ts.
//
// Changing this set requires bumping CONFIG_COVERAGE_BASELINE in the same PR.

export type ConfigLane = 'client' | 'server' | 'worker';

export interface RequiredVarDeclaration {
  var: string;
  lanes: readonly ConfigLane[];
}

export const REQUIRED_VAR_DECLARATIONS: readonly RequiredVarDeclaration[] = [
  // client-required trio (also server-needed for SSR; declared on both)
  { var: 'NEXT_PUBLIC_SUPABASE_URL', lanes: ['client', 'server'] },
  { var: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', lanes: ['client', 'server'] },
  { var: 'NEXT_PUBLIC_APP_URL', lanes: ['client', 'server'] },
  // server/worker shared infra (read by db/server.ts in both processes)
  { var: 'SUPABASE_URL', lanes: ['server', 'worker'] },
  { var: 'SUPABASE_SERVICE_KEY', lanes: ['server', 'worker'] },
  { var: 'DATABASE_POOL_URL', lanes: ['server', 'worker'] },
  // worker-only core infra
  { var: 'REDIS_QUEUE_URL', lanes: ['worker'] },
];

export const CONFIG_COVERAGE_BASELINE = REQUIRED_VAR_DECLARATIONS.length;
