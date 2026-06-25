// scripts/ci/config-coverage-baseline.ts
//
// The canonical set of UNCONDITIONALLY boot-required env vars and which config
// lane(s) own each. "Validate-all" is preserved by proving every entry here is
// asserted by at least one lane's boot assert, without one global parse. The
// shared DB infra (SUPABASE_URL/SUPABASE_SERVICE_KEY/DATABASE_POOL_URL) is
// unconditional core-infra for the WORKER (assertWorkerConfig), but on the Next
// server it is a server-DB SUBSYSTEM (asserted at DB-use via getServerDbConfig in
// Stage 3) — a static/marketing render needs none of it — so it is NOT declared
// for the 'server' boot lane.
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
  // shared DB infra — boot-required by the WORKER only; the Next server asserts
  // it as a server-DB subsystem at DB-use (Stage 3), not at register().
  { var: 'SUPABASE_URL', lanes: ['worker'] },
  { var: 'SUPABASE_SERVICE_KEY', lanes: ['worker'] },
  { var: 'DATABASE_POOL_URL', lanes: ['worker'] },
  // worker-only core infra
  { var: 'REDIS_QUEUE_URL', lanes: ['worker'] },
];

export const CONFIG_COVERAGE_BASELINE = REQUIRED_VAR_DECLARATIONS.length;
