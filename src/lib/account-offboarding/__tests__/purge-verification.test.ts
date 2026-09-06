import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PURGE_TOMBSTONE_SENTINELS } from '../purge-sentinels';
import {
  PURGE_VERIFICATION_TABLES,
  TABLE_DISPOSITIONS,
} from '../table-disposition';

interface QueryCall {
  text: string;
  values: unknown[];
}

const { calls, mockSql } = vi.hoisted(() => {
  const calls: QueryCall[] = [];
  const mockSql: any = vi.fn(async (strings: any, ...values: unknown[]) => {
    if (!Array.isArray(strings)) return [];
    const text = strings.join('?');
    calls.push({ text, values });
    return [{ violation_count: 0 }];
  });
  // The verifier binds its two jsonb sentinels through exec.json(...) (#892).
  // Postgres.js exposes `.json` on the Sql instance itself, so a bare vi.fn
  // stands in for a template tag but NOT for the real executor — without this
  // every branch throws "exec.json is not a function". Identity is enough: the
  // shape assertions read call text, and the value assertions read `values`.
  mockSql.json = vi.fn((value: unknown) => value);
  return { calls, mockSql };
});

vi.mock('../../db/server', () => ({
  sql: mockSql,
}));

import {
  absentByBusiness,
  PURGE_VERIFICATION_SQL_TABLES,
  verificationQuery,
  verifyAccountOffboardingPurge,
} from '../purge-verification';

describe('purge verification fail-closed guards', () => {
  // Same reason as mockSql.json above: verificationQuery reaches for
  // exec.json(...) while building the businesses and accounts branches.
  const noopExec = Object.assign(() => Promise.resolve([]), {
    json: (value: unknown) => value,
  }) as unknown as Parameters<typeof verificationQuery>[2];

  it('throws for a table with no verification branch so inventory drift is caught, not silently passed', () => {
    expect(() => verificationQuery(
      'a_future_unclassified_table',
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
    )).toThrow('missing_purge_verification_sql:a_future_unclassified_table');
  });

  it('throws for an absent-by-business table that is not on the allowlist', () => {
    expect(() => absentByBusiness('a_future_unclassified_table', 'acct-1', noopExec))
      .toThrow('missing_absent_by_business_sql:a_future_unclassified_table');
  });
});

describe('purge verification', () => {
  beforeEach(() => {
    calls.length = 0;
    mockSql.mockClear();
    mockSql.mockImplementation(async (strings: any, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return [];
      const text = strings.join('?');
      calls.push({ text, values });
      return [{ violation_count: 0 }];
    });
  });

  it('has explicit verification SQL for every disposition table that requires purge verification', () => {
    const expected = PURGE_VERIFICATION_TABLES.map((entry) => entry.table).sort();
    expect(PURGE_VERIFICATION_SQL_TABLES.toSorted()).toEqual(expected);
  });

  it('reports only tables with remaining verification violations', async () => {
    mockSql.mockImplementation(async (strings: any, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return [];
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('FROM responses')) return [{ violation_count: 2 }];
      if (text.includes('FROM approval_audit_log')) return [{ violation_count: 1 }];
      return [{ violation_count: 0 }];
    });

    const result = await verifyAccountOffboardingPurge({
      accountId: '00000000-0000-7000-8000-000000000001',
      offboardingId: '00000000-0000-7000-8000-000000000002',
    }, mockSql);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        table: 'responses',
        purgeVerification: 'must_be_absent',
        violationCount: 2,
      }),
      expect.objectContaining({
        table: 'approval_audit_log',
        purgeVerification: 'must_be_scrubbed',
        violationCount: 1,
      }),
    ]);
  });

  it('reports surviving judge verdicts as account-scoped purge residue', async () => {
    const accountId = '00000000-0000-7000-8000-000000000001';
    mockSql.mockImplementation(async (strings: any, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return [];
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('FROM judge_verdicts')) return [{ violation_count: 2 }];
      return [{ violation_count: 0 }];
    });

    const result = await verifyAccountOffboardingPurge({
      accountId,
      offboardingId: '00000000-0000-7000-8000-000000000002',
    }, mockSql);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        table: 'judge_verdicts',
        disposition: 'hard_delete',
        purgeVerification: 'must_be_absent',
        violationCount: 2,
      }),
    ]);
    const judgeQuery = calls.find((call) => call.text.includes('FROM judge_verdicts'));
    expect(judgeQuery?.text).toContain('WHERE account_id = ?::uuid');
    expect(judgeQuery?.values).toEqual([accountId]);
  });

  it('fails closed on surviving Solicitation batches or asks', async () => {
    const accountId = '00000000-0000-7000-8000-000000000001';
    mockSql.mockImplementation(async (strings: any, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return [];
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('FROM solicitation_batches')) return [{ violation_count: 1 }];
      if (text.includes('FROM solicitation_asks')) return [{ violation_count: 2 }];
      return [{ violation_count: 0 }];
    });

    const result = await verifyAccountOffboardingPurge({
      accountId,
      offboardingId: '00000000-0000-7000-8000-000000000002',
    }, mockSql);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        table: 'solicitation_batches',
        disposition: 'hard_delete',
        violationCount: 1,
      }),
      expect.objectContaining({
        table: 'solicitation_asks',
        disposition: 'hard_delete',
        violationCount: 2,
      }),
    ]);
    for (const table of ['solicitation_batches', 'solicitation_asks']) {
      const query = calls.find((call) => call.text.includes(`FROM ${table}`));
      expect(query?.text).toContain('WHERE account_id = ?::uuid');
      expect(query?.values).toEqual([accountId]);
    }
  });

  it('purge verification fails when a solicitation_outreach row survives the purge', async () => {
    const accountId = '00000000-0000-7000-8000-000000000001';
    mockSql.mockImplementation(async (strings: any, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return [];
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('FROM solicitation_outreach')) return [{ violation_count: 3 }];
      return [{ violation_count: 0 }];
    });

    const result = await verifyAccountOffboardingPurge({
      accountId,
      offboardingId: '00000000-0000-7000-8000-000000000002',
    }, mockSql);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        table: 'solicitation_outreach',
        disposition: 'hard_delete',
        purgeVerification: 'must_be_absent',
        violationCount: 3,
      }),
    ]);
    // Scoped by account_id — outreach carries its own tenant column, so the
    // check does not depend on the batches it cascades from still existing.
    const outreachQuery = calls.find((call) => call.text.includes('FROM solicitation_outreach'));
    expect(outreachQuery?.text).toContain('WHERE account_id = ?::uuid');
    expect(outreachQuery?.values).toEqual([accountId]);
  });

  it('purge verification counts refusal_events rows for the target account, including account-wide rows, and ignores another account', async () => {
    const accountId = '00000000-0000-7000-8000-000000000001';
    mockSql.mockImplementation(async (strings: any, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return [];
      const text = strings.join('?');
      calls.push({ text, values });
      // Two survivors stands in for the pair that matters: one per-location
      // Refusal and one ACCOUNT-WIDE one.
      if (text.includes('FROM refusal_events')) return [{ violation_count: 2 }];
      return [{ violation_count: 0 }];
    });

    const result = await verifyAccountOffboardingPurge({
      accountId,
      offboardingId: '00000000-0000-7000-8000-000000000002',
    }, mockSql);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        table: 'refusal_events',
        disposition: 'hard_delete',
        purgeVerification: 'must_be_absent',
        violationCount: 2,
      }),
    ]);

    const refusalQuery = calls.find((call) => call.text.includes('FROM refusal_events'));
    expect(refusalQuery?.text).toContain('WHERE account_id = ?::uuid');
    // "Including account-wide rows" is the whole reason this branch is scoped
    // by account_id and NEVER joined through businesses: an autonomy_suspended
    // Refusal carries `business_id IS NULL`, so the account_businesses CTE the
    // consent ledger uses below would miss every one of them and the
    // verification would report a clean purge over surviving rows.
    expect(refusalQuery?.text).not.toContain('account_businesses');
    expect(refusalQuery?.text).not.toContain('business_id');
    // Exactly one bind, the target account — another account's rows are outside
    // the filter rather than merely absent from this fixture.
    expect(refusalQuery?.values).toEqual([accountId]);
  });

  it('purge verification fails when a solicitation_consent row survives the purge', async () => {
    const accountId = '00000000-0000-7000-8000-000000000001';
    // absentByBusiness passes the table name through exec(tableName) as an
    // identifier fragment, so mimic Postgres.js by tagging non-template calls.
    mockSql.mockImplementation(((strings: any, ...values: unknown[]) => {
      if (typeof strings === 'string') return { __id: strings };
      if (!Array.isArray(strings)) return Promise.resolve([]);
      const text = strings.join('?');
      calls.push({ text, values });
      const survivesConsent = values.some(
        (value) => (value as { __id?: string } | null)?.__id === 'solicitation_consent',
      );
      return Promise.resolve([{ violation_count: survivesConsent ? 1 : 0 }]);
    }) as any);

    const result = await verifyAccountOffboardingPurge({
      accountId,
      offboardingId: '00000000-0000-7000-8000-000000000002',
    }, mockSql);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        table: 'solicitation_consent',
        disposition: 'hard_delete',
        purgeVerification: 'must_be_absent',
        violationCount: 1,
      }),
    ]);
    // The ledger carries NO account_id (#625 §3.2) — the check must join
    // through businesses, mirroring the contacts/visits it grants coverage for.
    const consentQuery = calls.find((call) =>
      call.values.some((value) => (value as { __id?: string } | null)?.__id === 'solicitation_consent'));
    expect(consentQuery?.text).toContain('WITH account_businesses AS');
    expect(consentQuery?.text).toContain('business_id IN (SELECT id FROM account_businesses)');
    expect(consentQuery?.values).toContainEqual(accountId);
  });

  it('uses explicit account, business, offboarding, and compliance retention scopes', async () => {
    await verifyAccountOffboardingPurge({
      accountId: '00000000-0000-7000-8000-000000000001',
      offboardingId: '00000000-0000-7000-8000-000000000002',
      currentOutboxId: '00000000-0000-7000-8000-000000000003',
      authUserId: 'auth-user-1',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      zernioAccountIds: ['zernio-account-1'],
      zernioProfileIds: ['zernio-profile-1'],
    }, mockSql);

    const sqlText = calls.map((call) => call.text).join('\n');
    expect(sqlText).toContain('WITH account_businesses AS');
    expect(sqlText).toContain('UNION ALL SELECT ?::text');
    expect(sqlText).toContain('UNION ALL SELECT UNNEST(?::text[])');
    expect(sqlText).toContain('FROM account_offboarding_tokens');
    expect(sqlText).toContain('google_maps_url IS NOT NULL');
    // D3 regression: verify the REAL approval_audit_log PII columns; never the
    // phantom columns approval_link_id / user_agent. Scoped to the
    // approval_audit_log query so a real user_agent column elsewhere can't mask it.
    const approvalVerify = calls.find((call) => call.text.includes('FROM approval_audit_log'));
    expect(approvalVerify?.text).toContain('response_text_at_approval IS NOT NULL');
    expect(approvalVerify?.text).toContain('token_hash IS NOT NULL');
    expect(approvalVerify?.text).not.toContain('approval_link_id');
    expect(approvalVerify?.text).not.toContain('user_agent');
    expect(sqlText).toContain("scope.value->>'type' = 'job_outbox_scrub_scope'");
    expect(sqlText).toContain("scope.value->>'type' = 'impersonation_session_scrub_scope'");
    expect(sqlText).toContain('jsonb_array_elements(ao.provider_dispositions)');
    // M1: analytics verification mirrors the FK-independent scrub, so a residual
    // raw-UUID distinct_id with no FK stays in scope and fails verification closed.
    expect(sqlText).toContain('distinct_id IN (?, ?)');
    expect(sqlText).not.toContain('digest(');
    expect(sqlText).not.toContain('SELECT *');
  });

  it('checks payload-control tables against the full raw identifier scope', async () => {
    await verifyAccountOffboardingPurge({
      accountId: '00000000-0000-7000-8000-000000000001',
      offboardingId: '00000000-0000-7000-8000-000000000002',
      currentOutboxId: '00000000-0000-7000-8000-000000000003',
      authUserId: 'auth-user-1',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      zernioAccountIds: ['zernio-account-1'],
      zernioProfileIds: ['zernio-profile-1'],
    }, mockSql);

    const payloadQueries = calls
      .filter((call) =>
        call.text.includes('FROM inbound_events') ||
        call.text.includes('FROM job_outbox')
      )
      .map((call) => call.text)
      .join('\n');

    expect(payloadQueries).toContain('offboarding_scope AS');
    expect(payloadQueries).toContain('job_outbox_id');
    expect(payloadQueries).toContain('job_outbox_scrub_scope AS');
    expect(payloadQueries).toContain('UNION ALL SELECT UNNEST(?::text[])');
    expect(payloadQueries).toContain('payload::text LIKE');
    expect(payloadQueries).toContain('last_error LIKE');
    expect(payloadQueries).toContain('length(btrim(s.identifier)) > 0');
    expect(payloadQueries).toContain('id <> ?::uuid');
    expect(payloadQueries).toContain("status NOT IN ('completed', 'failed')");
  });

  it('fails purge verification for any retained notification delivery linked to the account or its businesses', async () => {
    await verifyAccountOffboardingPurge({
      accountId: '00000000-0000-7000-8000-000000000001',
      offboardingId: '00000000-0000-7000-8000-000000000002',
    }, mockSql);

    const notificationQuery = calls.find((call) => call.text.includes('FROM notification_deliveries'));
    expect(notificationQuery?.text).toContain('account_id =');
    expect(notificationQuery?.text).toContain('business_id IN');
    expect(notificationQuery?.text).not.toContain("recipient <> '[redacted]'");
    expect(notificationQuery?.text).not.toContain('external_message_id IS NOT NULL');
  });

  // #892. The writer and the verifier must agree BY CONSTRUCTION, and the two
  // properties below are what "by construction" means here. Both read the SQL
  // this module actually emits — not its source text — so they cannot break on
  // reformatting.
  describe('tombstone sentinel comparisons', () => {
    /** The nine sentinel comparisons, by the branch that emits them. */
    const SENTINEL_BRANCHES = ['FROM accounts', 'FROM businesses b', 'FROM users'] as const;

    const sentinelQueries = async (): Promise<string[]> => {
      calls.length = 0;
      await verifyAccountOffboardingPurge({
        accountId: '00000000-0000-7000-8000-000000000001',
        offboardingId: '00000000-0000-7000-8000-000000000002',
      }, mockSql);
      return SENTINEL_BRANCHES.map((marker) => {
        const call = calls.find((entry) => entry.text.includes(marker));
        expect(call, `no verification query emitted for ${marker}`).toBeDefined();
        return call!.text;
      });
    };

    it('compares every tombstone sentinel with IS DISTINCT FROM, never <> or NOT LIKE', async () => {
      // The gate is fail-closed and its predicates sit in an OR-chain, so a
      // three-valued predicate reads as "not a violation" and OPENS it. <> goes
      // three-valued the moment its column becomes nullable, which would make
      // this gate's correctness depend on today's NOT NULL constraints.
      // Runtime coverage cannot catch a regression here — every column except
      // tone is NOT NULL, so <> and IS DISTINCT FROM behave identically against
      // a live database today. Only the emitted SQL shows the difference.
      // Strip `-- …` line comments first: the branches EXPLAIN this rule in
      // prose that necessarily names the operators it forbids, and a prose
      // mention is not a predicate.
      const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

      for (const text of await sentinelQueries()) {
        const predicates = stripSqlComments(text);
        expect(predicates).not.toContain('<>');
        expect(predicates).not.toContain('NOT LIKE');
        expect(predicates).toContain('IS DISTINCT FROM');
      }
    });

    it('pins the businesses OR-chain at 28 predicates, three of them non-residue', async () => {
      // lab-notes/history/2026-05.md "An exact count written into a comment is a maintenance
      // trap": #892 exists because 27 rotted. Replacing it with an unpinned 28
      // would rot the same way, so the numbers docs/directory/lib-account-offboarding.md and the
      // branch comments state are asserted here.
      const businesses = (await sentinelQueries())[1];
      expect(businesses, 'no businesses verification query emitted').toBeDefined();
      const predicates = businesses!.replace(/--[^\n]*/g, '');

      // The chain is `AND ( <first> OR <rest> … )`, so predicates = ORs + 1.
      const orCount = (predicates.match(/\bOR\s/g) ?? []).length;
      expect(orCount + 1).toBe(28);

      // The 28 split three ways, and the split is what the prose claims:
      //   5 sentinel-equality  — name, tone, owner_name, owner_email,
      //                          tracked_keywords
      //   1 presence           — archived_at IS NULL
      //  22 residue            — IS NOT NULL
      // Of those, THREE are non-residue: tone and tracked_keywords compare
      // against a RESTORED schema default, and archived_at is the presence
      // check. (accounts.flags is the third restored default across the FILE,
      // in the accounts branch — not this one.)
      const sentinelEquality = (predicates.match(/IS DISTINCT FROM/g) ?? []).length;
      const residueChecks = (predicates.match(/IS NOT NULL/g) ?? []).length;
      expect(sentinelEquality).toBe(5);
      expect(residueChecks).toBe(22);
      expect(predicates).toContain('b.archived_at IS NULL');
      expect(sentinelEquality + residueChecks + 1).toBe(28);

      expect(predicates).toContain('b.tone IS DISTINCT FROM');
      expect(predicates).toContain('b.tracked_keywords IS DISTINCT FROM');
    });

    it('binds all nine sentinel values from PURGE_TOMBSTONE_SENTINELS, never a re-typed literal', async () => {
      calls.length = 0;
      await verifyAccountOffboardingPurge({
        accountId: '00000000-0000-7000-8000-000000000001',
        offboardingId: '00000000-0000-7000-8000-000000000002',
      }, mockSql);
      const bound = calls.flatMap((call) => call.values);

      // Strings arrive as bind values; the two jsonb sentinels arrive through
      // exec.json, which the mock passes through by identity.
      expect(bound).toContain(PURGE_TOMBSTONE_SENTINELS.accountName);
      expect(bound).toContain(PURGE_TOMBSTONE_SENTINELS.businessName);
      expect(bound).toContain(PURGE_TOMBSTONE_SENTINELS.ownerName);
      expect(bound).toContain(PURGE_TOMBSTONE_SENTINELS.userName);
      expect(bound).toContain(PURGE_TOMBSTONE_SENTINELS.tone);
      expect(bound).toContain(PURGE_TOMBSTONE_SENTINELS.emailPrefix);
      expect(bound).toContain(PURGE_TOMBSTONE_SENTINELS.emailSuffix);
      expect(bound).toContain(PURGE_TOMBSTONE_SENTINELS.trackedKeywords);
      expect(bound).toContain(PURGE_TOMBSTONE_SENTINELS.accountFlags);

      // The literals the verifier used to carry are gone from the SQL text.
      const allText = calls.map((call) => call.text).join('\n');
      for (const literal of [
        "'Deleted account'", "'Deleted location'", "'Deleted owner'", "'Deleted user'",
        "'professional and friendly'", "'deleted-'", "'@repworth.invalid'",
      ]) {
        expect(allText, `${literal} is still typed into the verifier`).not.toContain(literal);
      }
    });
  });

  it('does not silently add disposition tables without verification coverage', () => {
    const uniqueTables = new Set(TABLE_DISPOSITIONS.map((entry) => entry.table));
    expect(uniqueTables.size).toBe(TABLE_DISPOSITIONS.length);
    expect(PURGE_VERIFICATION_TABLES.length).toBeGreaterThan(20);
  });
});
