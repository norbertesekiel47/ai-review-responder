// Shape assertions for migration 120 — the Owner Operator tables
// (agent_conversations, agent_turns, agent_proposals,
// agent_unsupported_requests): deny-all RLS, revoked client grants, and the two
// unique constraints on agent_turns. Follows
// migration-116-refusal-events.integration.test.ts for shape and for the
// cross-process live-DB lock, and asserts the schema with assertSchemaReady
// rather than applying any DDL at run time (ci:live-db-suites R2).
//
// Title 2 lives OUTSIDE describeWithDb on purpose: it reads TENANT_TABLES /
// TENANT_SCOPE_COLUMNS through a module import and needs no database, so
// gating it on the live DB would make it a silent skip rather than a failure
// on a keyless run (the 116 suite does the same for its title 19).
import { describe, it } from 'vitest';

describe('migration 120 owner operator — registry', () => {
  it.todo('migration 120 registers all four tables in TENANT_TABLES and TENANT_SCOPE_COLUMNS');
});

describe('migration 120 owner operator', () => {
  it.todo('migration 120 creates the four owner-operator tables with deny-all RLS, revoked client grants, and the two unique constraints');
});
