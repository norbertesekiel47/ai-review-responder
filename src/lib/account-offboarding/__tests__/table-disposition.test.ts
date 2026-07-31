import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../../../scripts/ci/tenant-tables';
import {
  ACCOUNT_OFFBOARDING_DISPOSITIONS,
  ACCOUNT_OFFBOARDING_SCOPE_EVIDENCE,
  ACCOUNT_OFFBOARDING_TABLES,
  ALLOWED_PURGE_VERIFICATION_BY_DISPOSITION,
  EXPLICIT_ACCOUNT_OFFBOARDING_TABLES,
  PURGE_VERIFICATION_MODES,
  PURGE_VERIFICATION_TABLES,
  SPEC_ONLY_ACCOUNT_OFFBOARDING_TABLES,
  TABLE_DISPOSITIONS,
  type TableDisposition,
} from '../table-disposition';

const REQUIRED_EXPLICIT_TABLES = [
  'inbound_events',
  'job_outbox',
  'analytics_events',
  'flagged_responses',
  'impersonation_sessions',
] as const;

const REQUIRED_SPEC_ONLY_TABLES = [
  'users',
  'google_connections',
  'prospect_demos',
] as const;

const unique = (values: readonly string[]) => [...new Set(values)].sort();
const accountOffboardingTables: readonly string[] = ACCOUNT_OFFBOARDING_TABLES;
const purgeVerificationTables: readonly TableDisposition[] =
  PURGE_VERIFICATION_TABLES;
const tableDispositions: readonly TableDisposition[] = TABLE_DISPOSITIONS;

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function migrationSqlFiles(): string[] {
  return readdirSync(join(process.cwd(), 'supabase/migrations'))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) =>
      readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8'),
    );
}

function accountLinkedTablesFromMigrations(): string[] {
  const linkedTables = new Set<string>();
  const linkedColumnPattern =
    /\b(?:account_id|business_id|user_id|owner_user_id|actor_user_id|created_by_user_id|consumed_by_user_id|revoked_by_user_id|reviewed_by_user_id|impersonated_user_id|account_offboarding_id|created_by)\b/i;
  // M6: structural catch — any table whose body REFERENCES a tenant root
  // (accounts/businesses) is account-linked regardless of the FK column NAME, so
  // a future `org_id REFERENCES accounts(...)` cannot silently drift out of the
  // inventory + purge just because the column is not on the name list above.
  const referencesTenantRootPattern =
    /references\s+(?:"?public"?\.)?"?(?:accounts|businesses)"?\b/i;

  for (const sql of migrationSqlFiles()) {
    const strippedSql = stripSqlComments(sql);
    const createTablePattern =
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\);/gi;
    for (const match of strippedSql.matchAll(createTablePattern)) {
      const [, table, body] = match;
      if (!table || !body) continue;
      if (linkedColumnPattern.test(body) || referencesTenantRootPattern.test(body)) {
        linkedTables.add(table);
      }
    }

    const alterAddColumnPattern =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s+add\s+column(?:\s+if\s+not\s+exists)?\s+"?([a-z_][a-z0-9_]*)"?/gi;
    for (const match of strippedSql.matchAll(alterAddColumnPattern)) {
      const [, table, column] = match;
      if (!table || !column) continue;
      if (linkedColumnPattern.test(column)) linkedTables.add(table);
    }

    // ALTER TABLE … ADD … REFERENCES accounts/businesses (named-constraint FKs).
    const alterReferencesPattern =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s+add\s+[\s\S]*?references\s+(?:"?public"?\.)?"?(?:accounts|businesses)"?\b/gi;
    for (const match of strippedSql.matchAll(alterReferencesPattern)) {
      const [, table] = match;
      if (table) linkedTables.add(table);
    }
  }

  return [...linkedTables].sort();
}

describe('account offboarding table disposition inventory', () => {
  it('classifies every tenant table and explicit account-linked table exactly once', () => {
    const requiredTables = unique([
      ...TENANT_TABLES,
      ...REQUIRED_EXPLICIT_TABLES,
      ...REQUIRED_SPEC_ONLY_TABLES,
    ]);
    const classifiedTables = tableDispositions.map((entry) => entry.table);

    expect(unique(classifiedTables)).toEqual(classifiedTables.slice().sort());
    expect(unique(classifiedTables)).toEqual(requiredTables);
  });

  it('classifies every directly account-linked table created by migrations', () => {
    const schemaLinkedTables = accountLinkedTablesFromMigrations();
    const missing = schemaLinkedTables.filter(
      (table) => !accountOffboardingTables.includes(table),
    );

    expect(schemaLinkedTables).toContain('account_offboardings');
    expect(schemaLinkedTables).toContain('account_offboarding_tokens');
    expect(missing).toEqual([]);
  });

  it('keeps helper exports in sync with the canonical inventory', () => {
    expect(ACCOUNT_OFFBOARDING_TABLES).toEqual(
      TABLE_DISPOSITIONS.map((entry) => entry.table),
    );
    expect(EXPLICIT_ACCOUNT_OFFBOARDING_TABLES).toEqual(
      REQUIRED_EXPLICIT_TABLES,
    );
    expect(SPEC_ONLY_ACCOUNT_OFFBOARDING_TABLES).toEqual(
      REQUIRED_SPEC_ONLY_TABLES,
    );
  });

  it('uses only known dispositions, link types, and purge verification modes', () => {
    for (const entry of tableDispositions) {
      expect(ACCOUNT_OFFBOARDING_DISPOSITIONS).toContain(entry.disposition);
      expect(ACCOUNT_OFFBOARDING_SCOPE_EVIDENCE).toContain(
        entry.scopeEvidence,
      );
      expect(PURGE_VERIFICATION_MODES).toContain(entry.purgeVerification);
      expect(entry.reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('keeps purge verification modes compatible with disposition semantics', () => {
    for (const entry of tableDispositions) {
      expect(
        ALLOWED_PURGE_VERIFICATION_BY_DISPOSITION[entry.disposition],
      ).toContain(entry.purgeVerification);
    }
  });

  it('offboarding purge sweeps uploads, contacts, visits, batches, and asks', () => {
    const contactsCsvTables = [
      'contact_csv_uploads',
      'solicitation_contacts',
      'solicitation_visits',
      'solicitation_batches',
      'solicitation_asks',
    ] as const;

    for (const table of contactsCsvTables) {
      const entry = tableDispositions.find((candidate) => candidate.table === table);
      expect(entry).toBeDefined();
      expect(entry?.disposition).toBe('hard_delete');
      expect(entry?.purgeVerification).toBe('must_be_absent');
    }
  });

  it('requires purge verification for every applicable table', () => {
    const applicableTables = tableDispositions.filter(
      (entry) => entry.disposition !== 'not_applicable',
    ).map((entry) => entry.table);
    const verificationTables = purgeVerificationTables.map(
      (entry) => entry.table,
    );

    expect(unique(verificationTables)).toEqual(unique(applicableTables));
    expect(
      purgeVerificationTables.filter(
        (entry) => entry.purgeVerification === 'not_checked',
      ),
    ).toEqual([]);
  });
});
