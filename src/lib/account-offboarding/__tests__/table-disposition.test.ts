import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../../../scripts/ci/tenant-tables';
import { verificationQuery } from '../purge-verification';
import {
  ACCOUNT_OFFBOARDING_DISPOSITIONS,
  ACCOUNT_OFFBOARDING_SCOPE_EVIDENCE,
  ACCOUNT_OFFBOARDING_TABLES,
  ALLOWED_PURGE_VERIFICATION_BY_DISPOSITION,
  EXPLICIT_ACCOUNT_OFFBOARDING_TABLES,
  PROVIDER_DATA_RETENTION,
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
  'admin_audit_log',
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

  it('classifies refusal_events as hard_delete by direct_account_id, verified must_be_absent', () => {
    const entry = tableDispositions.find((candidate) => candidate.table === 'refusal_events');
    expect(entry).toBeDefined();
    expect(entry?.disposition).toBe('hard_delete');
    // ACCOUNT evidence, never business: the autonomy_suspended lane is
    // account-wide and carries `business_id IS NULL`, so business-scoped
    // evidence would leave every suspension Refusal behind after a purge.
    expect(entry?.scopeEvidence).toBe('direct_account_id');
    expect(entry?.purgeVerification).toBe('must_be_absent');
    // The reason must state the accurate fact rather than gesture at one: this
    // table's only FKs are to `accounts` and `businesses`, both
    // retain_deidentified and neither cascading, so nothing removes these rows
    // unless the purge deletes them explicitly.
    //
    // POLARISED on purpose. A bare /cascade/i passes on a reason claiming this
    // table DOES cascade just as happily as on one saying it does not — the
    // same defect this branch already fixed once in the migration suite's
    // retention-clock assertion, applied in one file of the change and missed
    // in the other. An assertion that cannot fail is worse than none, because
    // it reads as coverage.
    expect(entry?.reason).toMatch(/NO CASCADE REACHES IT/);
    expect(entry?.reason).toMatch(/deletes them explicitly/i);
    // POLARISED, same shape and same reason as the two above: the analogy set
    // states a DIRECTION for each table it names, and a sentence claiming the
    // opposite direction is exactly the error this arm has already made once.
    // Both regexes must fail on the negation, not merely miss it.
    expect(entry?.reason).toMatch(/review_escalations relies on, which is likewise NO ACTION/);
    expect(entry?.reason).toMatch(
      /contact_csv_uploads and agent_outcomes[\s\S]*?DO carry ON DELETE CASCADE/,
    );
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

describe('provider data retention inventory', () => {
  it('PROVIDER_DATA_RETENTION classifies the Stripe Customer object as retain_compliance_limited_pii', () => {
    const stripeCustomer = PROVIDER_DATA_RETENTION.find(
      (entry) => entry.provider === 'stripe' && entry.object === 'customer',
    );

    expect(stripeCustomer).toBeDefined();
    expect(stripeCustomer!.disposition).toBe('retain_compliance_limited_pii');
    // The reason must name what SURVIVES. The deletion receipt and the privacy
    // policy state the same categories but are NOT written from this sentence —
    // neither imports the array, so the three are kept in step by review. Paid
    // invoices keep a snapshotted billing name and address, and tax_ids is
    // unreachable from a customers.update.
    expect(stripeCustomer!.reason).toMatch(/invoice/i);
    expect(stripeCustomer!.reason).toMatch(/tax_ids/);
  });

  it('PROVIDER_DATA_RETENTION carries the detached Stripe PaymentMethod as its own entry', () => {
    // Detaching is the most the API allows, not an erasure: Stripe exposes
    // detach and no delete, so billing_details and card last4/fingerprint
    // outlive the purge. The redaction module once claimed that data was
    // deletable and the inventory therefore carried no entry; the 2026-09-04
    // staging dry-run read a detached method back in full and falsified it.
    const paymentMethod = PROVIDER_DATA_RETENTION.find(
      (entry) => entry.provider === 'stripe' && entry.object === 'payment_method',
    );

    expect(paymentMethod).toBeDefined();
    expect(paymentMethod!.disposition).toBe('retain_compliance_limited_pii');
    expect(paymentMethod!.reason).toMatch(/billing_details/);
    expect(paymentMethod!.reason).toMatch(/last4/);
    // The correction itself: the reason must not re-assert deletability.
    expect(paymentMethod!.reason).not.toMatch(/is deletable/i);
  });

  it('PROVIDER_DATA_RETENTION entries never appear in ACCOUNT_OFFBOARDING_TABLES or PURGE_VERIFICATION_TABLES', () => {
    // D2. A Stripe object has no SQL, and purge-verification throws
    // missing_purge_verification_sql for any inventory entry with no branch.
    // Keeping the two inventories separate is what makes that safe.
    const retentionKeys = PROVIDER_DATA_RETENTION.map(
      (entry) => `${entry.provider}.${entry.object}`,
    );
    const verificationTables = PURGE_VERIFICATION_TABLES.map((entry) => entry.table);

    for (const entry of PROVIDER_DATA_RETENTION) {
      expect(ACCOUNT_OFFBOARDING_TABLES).not.toContain(entry.object);
      expect(verificationTables).not.toContain(entry.object);
      expect(entry).not.toHaveProperty('purgeVerification');
    }
    expect(unique(retentionKeys)).toEqual(retentionKeys.slice().sort());
  });

  it('verificationQuery still throws missing_purge_verification_sql for an unknown table name', () => {
    // The fail-closed guard must survive the addition of a second inventory:
    // a provider object must not become a silently-passing verification table.
    const noopExec = Object.assign(() => Promise.resolve([]), {
      json: (value: unknown) => value,
    }) as unknown as Parameters<typeof verificationQuery>[2];

    expect(() => verificationQuery(
      'customer',
      {
        accountId: 'acct-1',
        offboardingId: 'off-1',
        currentOutboxId: null,
        authUserId: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        zernioAccountIds: null,
        zernioProfileIds: null,
      } as unknown as Parameters<typeof verificationQuery>[1],
      noopExec,
    )).toThrow('missing_purge_verification_sql:customer');
  });
});
