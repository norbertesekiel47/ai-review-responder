# Wave 1 Foundation Launch Risk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Wave 1 launch-risk proof layer: tenant isolation checks, billing reconciliation, approval evidence snapshots, security launch controls, and accurate legal/security public surfaces.

**Architecture:** Implement as five reviewable PR slices, with the approval snapshot slice first. Keep existing architecture intact: no repository rewrite, no new Stripe dedup table, no MDX runtime, no service-role reliance on RLS, and no billing math that ignores stored grandfathered account values.

**Tech Stack:** Next.js App Router, TypeScript, Postgres.js, Supabase/PostgreSQL migrations, BullMQ worker, Stripe SDK, Vitest, pnpm, GitHub Actions.

---

## Scope Check

This plan covers the approved Wave 1 subset only. It intentionally excludes past-due day-variant UX, dunning emails, Stripe Tax, cancellation surveys, CSV import polish, LLM cost rollups, GBP-direct fallback, grant-extension support actions, full Trust Center, MFA/team membership, and support impersonation.

Implementation should use one branch but land as separate reviewable commits or PRs by slice:

1. Approval audit snapshot.
2. Tenant isolation scripts and docs.
3. Billing and invoice reconciliation.
4. Security launch controls and PHI scanner.
5. Legal routes, typed legal content, sub-processors, and AI disclosure.

## File Structure

### PR Slice 1: Approval Snapshot

- Create: `supabase/migrations/044_approval_audit_snapshot.sql`
- Create: `src/lib/shared/__tests__/migration-044-approval-audit-snapshot.test.ts`
- Modify: `src/lib/approval/audit.ts`
- Modify: `src/lib/approval/locks.ts`
- Modify: `src/lib/approval/token-mode.ts`
- Modify: `src/lib/approval/session-mode.ts`
- Modify: `src/lib/approval/callback-mode.ts`
- Modify: `src/lib/approval/__tests__/service.test.ts`
- Modify: `src/lib/approval/__tests__/approve-via-callback.test.ts`

### PR Slice 2: Tenant Isolation Proofs

- Create: `scripts/ci/tenant-scope-audit.ts`
- Create: `scripts/ci/tenant-scope-allowlist.ts`
- Create: `scripts/ci/rls-audit.ts`
- Create: `scripts/ci/__tests__/tenant-scope-audit.test.ts`
- Create: `scripts/ci/__tests__/rls-audit.test.ts`
- Create: `src/__tests__/tenant-isolation.test.ts`
- Create: `docs/security/rls-inventory.md`
- Create: `docs/security/tenant-isolation.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

### PR Slice 3: Billing And Invoice Reconciliation

- Create: `worker/background/pollers/billing-reconciliation/types.ts`
- Create: `worker/background/pollers/billing-reconciliation/expected-invoice.ts`
- Create: `worker/background/pollers/billing-reconciliation/drift.ts`
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts`
- Modify: `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`

### PR Slice 4: Security Launch Controls

- Create: `public/.well-known/security.txt`
- Create: `src/app/(public)/security/page.tsx`
- Create: `src/lib/security/phi-scanner.ts`
- Create: `src/lib/security/__tests__/phi-scanner.test.ts`
- Create: `docs/security/vendor-risk-register.md`
- Create: `docs/security/access-checklist.md`
- Create: `docs/runbooks/secrets-rotation-stripe.md`
- Create: `docs/runbooks/secrets-rotation-supabase.md`
- Create: `docs/runbooks/secrets-rotation-zernio.md`
- Create: `docs/runbooks/secrets-rotation-email-and-messaging.md`
- Create: `docs/runbooks/secrets-rotation-api-keys.md`
- Create: `docs/runbooks/security-scan-staging.md`
- Modify: `worker/jobs/zernio/ZernioReviewIngestWorker.ts`
- Modify: `worker/jobs/zernio/zernio-ingest-shared.ts`
- Modify: `worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts`

### PR Slice 5: Legal And Compliance Accuracy

- Create: `src/lib/legal/content.ts`
- Create: `src/components/legal/LegalPage.tsx`
- Create: `src/app/(public)/legal/terms/page.tsx`
- Create: `src/app/(public)/legal/privacy/page.tsx`
- Create: `src/app/(public)/legal/aup/page.tsx`
- Create: `src/app/(public)/legal/dpa/page.tsx`
- Create: `src/app/(public)/legal/cookies/page.tsx`
- Create: `src/app/(public)/legal/sub-processors/page.tsx`
- Create: `docs/legal/aup.md`
- Create: `docs/legal/dpa.md`
- Create: `docs/legal/cookies.md`
- Create: `docs/legal/sub-processors.md`
- Create: `docs/legal/legal-review.md`
- Create: `docs/legal/insurance.md`
- Modify: `docs/legal/repworth-terms-of-service.md`
- Modify: `docs/legal/repworth-privacy-policy.md`
- Modify: `next.config.mjs`
- Modify: `src/app/(public)/terms/page.tsx`
- Modify: `src/app/(public)/privacy/page.tsx`
- Modify: `src/components/approval/approval-client.tsx`
- Modify: `src/components/dashboard/EditReplyDrawer.tsx`
- Modify: `src/components/sections/landing/LandingContent.tsx`
- Modify: `src/components/auth/auth-island/SignupForm.tsx`
- Modify: `src/components/auth/auth-island/__tests__/SignupForm.test.tsx`

---

## PR Slice 1: Approval Snapshot

### Task 1: Add Approval Audit Snapshot Migration

**Files:**
- Create: `supabase/migrations/044_approval_audit_snapshot.sql`
- Create: `src/lib/shared/__tests__/migration-044-approval-audit-snapshot.test.ts`

- [ ] **Step 1: Write the migration structure test**

Create `src/lib/shared/__tests__/migration-044-approval-audit-snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/044_approval_audit_snapshot.sql'),
  'utf8',
);

describe('migration 044 — approval audit content snapshot', () => {
  it('adds nullable response_text_at_approval to approval_audit_log', () => {
    expect(sql).toMatch(
      /ALTER TABLE approval_audit_log\s+ADD COLUMN IF NOT EXISTS response_text_at_approval TEXT/i,
    );
  });

  it('documents snapshot semantics', () => {
    expect(sql).toMatch(/COMMENT ON COLUMN approval_audit_log\.response_text_at_approval/i);
    expect(sql).toMatch(/immutable owner-approved response text/i);
  });

  it('does not add an HTML snapshot column without canonical rendering', () => {
    expect(sql).not.toMatch(/response_html_at_approval/i);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails because the migration does not exist**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-044-approval-audit-snapshot.test.ts
```

Expected: FAIL with `ENOENT` for `044_approval_audit_snapshot.sql`.

- [ ] **Step 3: Add the migration**

Create `supabase/migrations/044_approval_audit_snapshot.sql`:

```sql
-- ==============================================================================
-- Migration 044: Approval audit approved-text snapshot
--
-- Adds immutable content evidence to approval_audit_log so every approval event
-- can prove the exact owner-approved text even if responses.approved_text changes.
-- Additive and zero-downtime: nullable column, no index until a query needs it.
-- ==============================================================================

ALTER TABLE approval_audit_log
  ADD COLUMN IF NOT EXISTS response_text_at_approval TEXT;

COMMENT ON COLUMN approval_audit_log.response_text_at_approval IS
  'Immutable owner-approved response text captured in the same transaction as approval status mutation and publish outbox enqueue.';
```

- [ ] **Step 4: Run the migration test and verify it passes**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-044-approval-audit-snapshot.test.ts
```

Expected: PASS.

### Task 2: Extend Approval Audit Writers

**Files:**
- Modify: `src/lib/approval/audit.ts`
- Modify: `src/lib/approval/__tests__/service.test.ts`

- [ ] **Step 1: Add the snapshot type and SQL columns in the audit writer**

In `src/lib/approval/audit.ts`, add this type near `type TxClient`:

```ts
export interface ApprovalContentSnapshot {
  responseTextAtApproval: string;
}
```

Change `insertAuditLog` signature:

```ts
export async function insertAuditLog(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: AuditContext,
  metadata?: Record<string, unknown>,
  snapshot?: ApprovalContentSnapshot,
): Promise<void> {
```

Replace its `INSERT` statement with:

```ts
  await tx`
    INSERT INTO approval_audit_log (
      id, response_id, business_id, account_id, token_hash,
      device_cookie_hash, action, ip_address, metadata,
      response_text_at_approval
    )
    VALUES (
      ${uuidv7()},
      ${responseId},
      ${businessId},
      ${accountId},
      ${audit.tokenHash},
      ${audit.deviceCookieHash},
      ${action},
      ${audit.ipAddress},
      ${jsonb(metadata ?? {})},
      ${snapshot?.responseTextAtApproval ?? null}
    )
  `;
```

Change `insertAuditLogSession` signature:

```ts
export async function insertAuditLogSession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: SessionAuditContext,
  metadata?: Record<string, unknown>,
  snapshot?: ApprovalContentSnapshot,
): Promise<void> {
```

Replace its `INSERT` statement with:

```ts
  await tx`
    INSERT INTO approval_audit_log (
      id, response_id, business_id, account_id, token_hash,
      device_cookie_hash, action, ip_address, metadata,
      actor_user_id, auth_method, response_text_at_approval
    )
    VALUES (
      ${uuidv7()}, ${responseId}, ${businessId}, ${accountId}, ${null}, ${null},
      ${action}, ${audit.ipAddress}, ${jsonb(metadata ?? {})},
      ${audit.actorUserId}, 'owner_session',
      ${snapshot?.responseTextAtApproval ?? null}
    )
  `;
```

- [ ] **Step 2: Add an audit-writer regression test**

In `src/lib/approval/__tests__/service.test.ts`, add this test after the existing `approve` happy-path test:

```ts
  it('writes approved text snapshot to approval_audit_log for approve-as-is', async () => {
    const link = validLink({ device_cookie_hash: 'device-hash-abc' });
    const responseText = 'Thanks for the thoughtful review.';
    const tx = createMockTx([
      [{ status: 'pending_approval', original_draft_text: 'draft', response_text: responseText, version: 1, review_id: 'rev-1' }],
      [],
      [],
      [],
      [],
      [{ account_id: 'acc-1' }],
      [],
    ]);

    await approve(tx, link, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

    const auditCall = tx.mock.calls.find((call: unknown[]) =>
      String((call[0] as TemplateStringsArray).join('')).includes('approval_audit_log'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall!.flat()).toContain(responseText);
  });
```

- [ ] **Step 3: Run the approval test and verify it fails**

Run:

```bash
pnpm exec vitest run src/lib/approval/__tests__/service.test.ts
```

Expected: FAIL because `approve` has not yet passed the snapshot.

### Task 3: Capture Snapshot In Token, Session, And Callback Approval Modes

**Files:**
- Modify: `src/lib/approval/token-mode.ts`
- Modify: `src/lib/approval/session-mode.ts`
- Modify: `src/lib/approval/callback-mode.ts`
- Modify: `src/lib/approval/__tests__/service.test.ts`
- Modify: `src/lib/approval/__tests__/approve-via-callback.test.ts`

- [ ] **Step 1: Update token approve to capture the locked response text**

In `src/lib/approval/token-mode.ts`, change:

```ts
  await lockPendingResponse(tx, link.response_id);
```

to:

```ts
  const resp = await lockPendingResponse(tx, link.response_id);
```

Change the final audit call to:

```ts
  await insertAuditLog(
    tx,
    link.response_id,
    link.business_id,
    'approve',
    audit,
    undefined,
    { responseTextAtApproval: resp.response_text },
  );
```

- [ ] **Step 2: Update token edit to capture sanitized edited text**

In `src/lib/approval/token-mode.ts`, change:

```ts
  await insertAuditLog(tx, link.response_id, link.business_id, 'edit', audit, { edit_distance: editDist });
```

to:

```ts
  await insertAuditLog(
    tx,
    link.response_id,
    link.business_id,
    'edit',
    audit,
    { edit_distance: editDist },
    { responseTextAtApproval: sanitizedText },
  );
```

- [ ] **Step 3: Update session approve to capture the locked response text**

In `src/lib/approval/session-mode.ts`, change:

```ts
  await lockPendingResponse(tx, responseId);
```

to:

```ts
  const resp = await lockPendingResponse(tx, responseId);
```

Change the audit call to:

```ts
  await insertAuditLogSession(
    tx,
    responseId,
    businessId,
    'approve',
    audit,
    undefined,
    { responseTextAtApproval: resp.response_text },
  );
```

- [ ] **Step 4: Update session edit to capture sanitized edited text**

In `src/lib/approval/session-mode.ts`, change:

```ts
  await insertAuditLogSession(tx, responseId, businessId, 'edit', audit, { edit_distance: editDist });
```

to:

```ts
  await insertAuditLogSession(
    tx,
    responseId,
    businessId,
    'edit',
    audit,
    { edit_distance: editDist },
    { responseTextAtApproval: sanitizedText },
  );
```

- [ ] **Step 5: Update callback approve to capture the locked response text**

In `src/lib/approval/callback-mode.ts`, change:

```ts
    await insertAuditLog(tx, link.response_id, link.business_id, `approved_via_${input.viaChannel}`, audit, metadata);
```

to:

```ts
    await insertAuditLog(
      tx,
      link.response_id,
      link.business_id,
      `approved_via_${input.viaChannel}`,
      audit,
      metadata,
      { responseTextAtApproval: response.response_text },
    );
```

- [ ] **Step 6: Update lockPendingResponse return type to include response_text**

In `src/lib/approval/locks.ts`, change the `lockPendingResponse` return type to:

```ts
Promise<{
  status: string;
  original_draft_text: string;
  response_text: string;
  version: number;
  review_id: string;
}>
```

Change the row type in the SQL call to the same shape, and change the SELECT list to:

```sql
SELECT status, original_draft_text, response_text, version, review_id
```

- [ ] **Step 7: Update test fixture rows to include response_text**

In `src/lib/approval/__tests__/service.test.ts`, every queued `lockPendingResponse` row used by approve/edit/session approval tests should include:

```ts
response_text: 'Approved draft text'
```

Keep `original_draft_text`, `version`, and `review_id` unchanged.

- [ ] **Step 8: Add callback snapshot assertion**

In `src/lib/approval/__tests__/approve-via-callback.test.ts`, change `pendingResponseRow()` to:

```ts
function pendingResponseRow() {
  return [{
    status: 'pending_approval',
    original_draft_text: 'draft',
    response_text: 'Callback approved draft',
    version: 1,
    review_id: 'rev-1',
  }];
}
```

In the `approveViaCallback` happy-path test, after the metadata assertions, add:

```ts
    expect(auditCall!.params).toContain('Callback approved draft');
```

- [ ] **Step 9: Run approval tests**

Run:

```bash
pnpm exec vitest run src/lib/approval/__tests__/service.test.ts src/lib/approval/__tests__/approve-via-callback.test.ts src/lib/shared/__tests__/migration-044-approval-audit-snapshot.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit PR slice 1**

Run:

```bash
git add supabase/migrations/044_approval_audit_snapshot.sql src/lib/shared/__tests__/migration-044-approval-audit-snapshot.test.ts src/lib/approval/audit.ts src/lib/approval/locks.ts src/lib/approval/token-mode.ts src/lib/approval/session-mode.ts src/lib/approval/callback-mode.ts src/lib/approval/__tests__/service.test.ts src/lib/approval/__tests__/approve-via-callback.test.ts
git commit -m "feat: snapshot approved text in approval audit"
```

---

## PR Slice 2: Tenant Isolation Proofs

### Task 4: Add Tenant Scope Audit Script

**Files:**
- Create: `scripts/ci/tenant-scope-audit.ts`
- Create: `scripts/ci/tenant-scope-allowlist.ts`
- Create: `scripts/ci/__tests__/tenant-scope-audit.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add tenant-scope audit fixtures and tests**

Create `scripts/ci/__tests__/tenant-scope-audit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { auditSqlText } from '../tenant-scope-audit';

describe('tenant-scope-audit', () => {
  it('passes scoped account query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM reviews WHERE account_id = ${accountId}')).toEqual([]);
  });

  it('passes scoped business query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM responses WHERE business_id = ${businessId}')).toEqual([]);
  });

  it('fails unscoped tenant table query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM reviews')).toEqual([
      {
        file: 'src/example.ts',
        table: 'reviews',
        reason: 'missing account_id or business_id scope',
      },
    ]);
  });

  it('ignores global table query', () => {
    expect(auditSqlText('src/example.ts', 'SELECT * FROM inbound_events')).toEqual([]);
  });
});
```

- [ ] **Step 2: Add allowlist module**

Create `scripts/ci/tenant-scope-allowlist.ts`:

```ts
export interface TenantScopeAllowlistEntry {
  file: string;
  table: string;
  reason: string;
}

export const tenantScopeAllowlist: TenantScopeAllowlistEntry[] = [
  {
    file: 'src/lib/admin/business-detail/queries.ts',
    table: 'approval_audit_log',
    reason: 'Admin business detail is scoped by account_id in adjacent query predicates and covered by denorm query tests.',
  },
];
```

- [ ] **Step 3: Add tenant-scope audit script**

Create `scripts/ci/tenant-scope-audit.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tenantScopeAllowlist } from './tenant-scope-allowlist';

const TENANT_TABLES = [
  'accounts',
  'businesses',
  'reviews',
  'responses',
  'approval_links',
  'approval_audit_log',
  'account_audit_log',
  'notification_deliveries',
  'api_costs',
  'zernio_connections',
] as const;

const MUTATING_OR_READING = /\b(SELECT|UPDATE|DELETE)\b/i;
const SCOPED = /\b(account_id|business_id)\b/i;

export interface TenantScopeFinding {
  file: string;
  table: string;
  reason: string;
}

export function auditSqlText(file: string, sqlText: string): TenantScopeFinding[] {
  if (!MUTATING_OR_READING.test(sqlText)) return [];
  const findings: TenantScopeFinding[] = [];
  for (const table of TENANT_TABLES) {
    const tableRegex = new RegExp(`\\b${table}\\b`, 'i');
    if (!tableRegex.test(sqlText)) continue;
    if (SCOPED.test(sqlText)) continue;
    const allowed = tenantScopeAllowlist.some((entry) =>
      entry.file === file && entry.table === table && entry.reason.trim().length > 0,
    );
    if (!allowed) {
      findings.push({ file, table, reason: 'missing account_id or business_id scope' });
    }
  }
  return findings;
}

function extractSqlTaggedTemplates(source: string): string[] {
  const matches = source.matchAll(/sql(?:<[^`]+>)?`([\s\S]*?)`/g);
  return Array.from(matches, (match) => match[1] ?? '');
}

function listFiles(): string[] {
  const output = execFileSync('rg', ['--files', 'src', 'worker'], { encoding: 'utf8' });
  return output
    .split('\n')
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));
}

export function auditFiles(files: string[]): TenantScopeFinding[] {
  return files.flatMap((file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    return extractSqlTaggedTemplates(source).flatMap((sqlText) => auditSqlText(file, sqlText));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = auditFiles(listFiles());
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}: ${finding.table}: ${finding.reason}`);
    }
    process.exit(1);
  }
  console.log('tenant-scope-audit: passed');
}
```

- [ ] **Step 4: Add package script**

In `package.json`, add:

```json
"ci:tenant-scope": "tsx scripts/ci/tenant-scope-audit.ts"
```

Place it after `"test:e2e": "playwright test"`.

- [ ] **Step 5: Run tenant-scope tests and script**

Run:

```bash
pnpm exec vitest run scripts/ci/__tests__/tenant-scope-audit.test.ts
pnpm ci:tenant-scope
```

Expected: test PASS. The script may fail on current unscoped queries; resolve by tightening scanner logic or adding justified allowlist entries with specific file/table/reason.

### Task 5: Add RLS Audit Script And Tenant Docs

**Files:**
- Create: `scripts/ci/rls-audit.ts`
- Create: `scripts/ci/__tests__/rls-audit.test.ts`
- Create: `docs/security/rls-inventory.md`
- Create: `docs/security/tenant-isolation.md`
- Create: `src/__tests__/tenant-isolation.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add RLS audit test**

Create `scripts/ci/__tests__/rls-audit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findRlsFailures } from '../rls-audit';

describe('rls-audit', () => {
  it('returns no failures when all required tables have RLS', () => {
    expect(findRlsFailures([
      { relname: 'reviews', relrowsecurity: true },
      { relname: 'responses', relrowsecurity: true },
    ], ['reviews', 'responses'])).toEqual([]);
  });

  it('returns missing tables and disabled RLS tables', () => {
    expect(findRlsFailures([
      { relname: 'reviews', relrowsecurity: false },
    ], ['reviews', 'responses'])).toEqual([
      'reviews has RLS disabled',
      'responses missing from pg_class result',
    ]);
  });
});
```

- [ ] **Step 2: Add RLS audit script**

Create `scripts/ci/rls-audit.ts`:

```ts
import postgres from 'postgres';

export const REQUIRED_RLS_TABLES = [
  'businesses',
  'reviews',
  'responses',
  'approval_links',
  'notification_deliveries',
  'api_costs',
  'review_exceptions',
  'ranking_snapshots',
  'approval_audit_log',
  'account_audit_log',
  'zernio_connections',
] as const;

export interface RlsRow {
  relname: string;
  relrowsecurity: boolean;
}

export function findRlsFailures(
  rows: RlsRow[],
  requiredTables: readonly string[] = REQUIRED_RLS_TABLES,
): string[] {
  return requiredTables.flatMap((table) => {
    const row = rows.find((candidate) => candidate.relname === table);
    if (!row) return [`${table} missing from pg_class result`];
    if (!row.relrowsecurity) return [`${table} has RLS disabled`];
    return [];
  });
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_POOL_URL ?? process.env.DATABASE_POOL_URL;
  if (!databaseUrl) {
    console.log('rls-audit: skipped because TEST_DATABASE_POOL_URL and DATABASE_POOL_URL are unset');
    return;
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<RlsRow[]>`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY(${REQUIRED_RLS_TABLES})
    `;
    const failures = findRlsFailures(rows);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`rls-audit: ${failure}`);
      process.exit(1);
    }
    console.log('rls-audit: passed');
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Add package script**

In `package.json`, add:

```json
"ci:rls-audit": "tsx scripts/ci/rls-audit.ts"
```

- [ ] **Step 4: Add docs**

Create `docs/security/rls-inventory.md` with this table:

```md
# RLS Inventory

RepWorth has two tenant-enforcement paths.

Service-role Postgres.js writes bypass RLS and must include app-layer `account_id` or `business_id` scoping. Authenticated Supabase reads use RLS through `owner_account_id()`.

| Table | RLS required | Enforcement note |
|---|---:|---|
| businesses | yes | Location rows scoped to owner account. |
| reviews | yes | Review rows scoped through business/account ownership. |
| responses | yes | Response rows scoped through review/business ownership. |
| approval_links | yes | Links scoped by response/business ownership; raw tokens never stored. |
| notification_deliveries | yes | Delivery rows scoped by business/account. |
| api_costs | yes | Cost rows scoped by business/account where present. |
| review_exceptions | yes | Exception rows scoped by business/account. |
| ranking_snapshots | yes | Ranking rows scoped by business/account. |
| approval_audit_log | yes | Approval audit rows include `account_id`. |
| account_audit_log | yes | Account audit rows include `account_id`. |
| zernio_connections | yes | Connection rows scoped by business/account. |
```

Create `docs/security/tenant-isolation.md`:

```md
# Tenant Isolation Contract

RepWorth uses app-enforced account scope for service-role writes and RLS for authenticated Supabase reads.

## Rules

- Service-role SQL must scope tenant tables by `account_id` or by a `business_id` that belongs to the active account.
- RLS must remain enabled on tenant-scoped tables.
- Tenant-scope allowlist entries must name the file, table, and reason.
- Cross-tenant integration tests use two accounts and assert account A cannot read or mutate account B data.

## CI Gates

- `pnpm ci:tenant-scope` scans inline Postgres.js SQL templates.
- `pnpm ci:rls-audit` verifies RLS when a database URL is available.
- `src/__tests__/tenant-isolation.test.ts` runs only when `TEST_DATABASE_POOL_URL` is available.
```

- [ ] **Step 5: Add guarded integration test shell**

Create `src/__tests__/tenant-isolation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

const hasDb = Boolean(process.env.TEST_DATABASE_POOL_URL);

describe.skipIf(!hasDb)('tenant isolation integration', () => {
  it('prevents account A from seeing account B seeded rows', async () => {
    expect(process.env.TEST_DATABASE_POOL_URL).toBeTruthy();
  });
});
```

- [ ] **Step 6: Add CI job step**

In `.github/workflows/ci.yml`, add this step after `Run lint` in the `lint` job:

```yaml
      - name: Run tenant scope audit
        run: pnpm ci:tenant-scope
```

Do not add `pnpm ci:rls-audit` as a hard CI step until `TEST_DATABASE_POOL_URL` is configured.

- [ ] **Step 7: Run tests and scripts**

Run:

```bash
pnpm exec vitest run scripts/ci/__tests__/tenant-scope-audit.test.ts scripts/ci/__tests__/rls-audit.test.ts src/__tests__/tenant-isolation.test.ts
pnpm ci:tenant-scope
pnpm ci:rls-audit
```

Expected: unit tests PASS. `pnpm ci:rls-audit` prints a skip message when no DB URL is set.

- [ ] **Step 8: Commit PR slice 2**

Run:

```bash
git add scripts/ci package.json .github/workflows/ci.yml src/__tests__/tenant-isolation.test.ts docs/security/rls-inventory.md docs/security/tenant-isolation.md
git commit -m "chore: add tenant isolation proof gates"
```

---

## PR Slice 3: Billing And Invoice Reconciliation

### Task 6: Add Billing Reconciliation Domain Helpers

**Files:**
- Create: `worker/background/pollers/billing-reconciliation/types.ts`
- Create: `worker/background/pollers/billing-reconciliation/expected-invoice.ts`
- Create: `worker/background/pollers/billing-reconciliation/drift.ts`
- Modify: `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`

- [ ] **Step 1: Add type module**

Create `worker/background/pollers/billing-reconciliation/types.ts`:

```ts
export interface BillingReconciliationAccount {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  stripe_subscription_id: string;
  locations_included: number;
  locations_overage_price_cents: number;
  active_location_count: number;
  past_due_at: Date | null;
  flags: Record<string, unknown>;
}

export interface ExpectedInvoice {
  baseCents: number;
  overageUnits: number;
  overageUnitPriceCents: number;
  totalCents: number;
}

export type DriftSeverity = 'info' | 'unsafe';

export interface DriftFinding {
  severity: DriftSeverity;
  type:
    | 'missing_subscription'
    | 'duplicate_subscription'
    | 'status_mismatch'
    | 'price_mismatch'
    | 'quantity_mismatch'
    | 'upcoming_invoice_mismatch'
    | 'unknown_stripe_state';
  message: string;
  expectedCents?: number;
  actualCents?: number;
}
```

- [ ] **Step 2: Add expected invoice helper**

Create `worker/background/pollers/billing-reconciliation/expected-invoice.ts`:

```ts
import { computeOverageQuantity } from '../../../../src/lib/accounts/quota';
import { isSubscriptionTier, TIER_CONFIG } from '../../../../src/lib/accounts/tier-config';
import type { BillingReconciliationAccount, ExpectedInvoice } from './types';

export function expectedInvoiceForAccount(
  account: BillingReconciliationAccount,
): ExpectedInvoice {
  if (!isSubscriptionTier(account.subscription_tier)) {
    throw new Error(`Unknown subscription tier: ${account.subscription_tier}`);
  }
  const config = TIER_CONFIG[account.subscription_tier];
  const overageUnits = config.multiLocAllowed
    ? computeOverageQuantity(
        Number(account.active_location_count),
        Number(account.locations_included),
      )
    : 0;
  const overageUnitPriceCents = config.multiLocAllowed
    ? Number(account.locations_overage_price_cents)
    : 0;
  return {
    baseCents: config.baseCents,
    overageUnits,
    overageUnitPriceCents,
    totalCents: config.baseCents + overageUnits * overageUnitPriceCents,
  };
}
```

- [ ] **Step 3: Add drift helper**

Create `worker/background/pollers/billing-reconciliation/drift.ts`:

```ts
import { SubscriptionStatus } from '../../../../src/lib/shared/subscription-status';
import type { BillingReconciliationAccount, DriftFinding } from './types';

const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function isExpectedStatusWindow(
  account: BillingReconciliationAccount,
  stripeStatus: string,
  now: Date = new Date(),
): boolean {
  if (account.subscription_status !== SubscriptionStatus.PAST_DUE) return false;
  if (!account.past_due_at) return false;
  const ageMs = now.getTime() - new Date(account.past_due_at).getTime();
  return ageMs >= 0 && ageMs <= PAST_DUE_GRACE_MS && ['past_due', 'unpaid'].includes(stripeStatus);
}

export function compareUpcomingInvoice(
  accountId: string,
  expectedCents: number,
  actualCents: number,
): DriftFinding[] {
  if (Math.abs(expectedCents - actualCents) <= 1) return [];
  return [{
    severity: 'unsafe',
    type: 'upcoming_invoice_mismatch',
    message: `Upcoming invoice drift for account ${accountId}: expected=${expectedCents} actual=${actualCents}`,
    expectedCents,
    actualCents,
  }];
}
```

- [ ] **Step 4: Add helper tests**

Append to `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts` or create `worker/background/pollers/__tests__/billing-reconciliation.test.ts`:

```ts
import { expectedInvoiceForAccount } from '../billing-reconciliation/expected-invoice';
import { compareUpcomingInvoice, isExpectedStatusWindow } from '../billing-reconciliation/drift';

describe('billing reconciliation helpers', () => {
  it('uses stored overage price instead of live tier overage config', () => {
    const invoice = expectedInvoiceForAccount({
      id: 'acct-grandfathered',
      subscription_tier: 'standard',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_123',
      locations_included: 1,
      locations_overage_price_cents: 3000,
      active_location_count: 3,
      past_due_at: null,
      flags: {},
    });

    expect(invoice.overageUnits).toBe(2);
    expect(invoice.overageUnitPriceCents).toBe(3000);
    expect(invoice.totalCents).toBe(7900 + 2 * 3000);
  });

  it('does not flag one-cent invoice rounding differences', () => {
    expect(compareUpcomingInvoice('acct-1', 12900, 12901)).toEqual([]);
  });

  it('flags invoice drift above one cent', () => {
    expect(compareUpcomingInvoice('acct-1', 12900, 12902)[0]).toMatchObject({
      severity: 'unsafe',
      type: 'upcoming_invoice_mismatch',
    });
  });

  it('treats past_due inside grace as expected status window', () => {
    const now = new Date('2026-05-25T00:00:00.000Z');
    expect(isExpectedStatusWindow({
      id: 'acct-past-due',
      subscription_tier: 'standard',
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_123',
      locations_included: 1,
      locations_overage_price_cents: 2500,
      active_location_count: 1,
      past_due_at: new Date('2026-05-22T00:00:00.000Z'),
      flags: {},
    }, 'past_due', now)).toBe(true);
  });
});
```

- [ ] **Step 5: Run helper tests**

Run:

```bash
pnpm exec vitest run worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts
```

Expected: PASS after helper imports are correct.

### Task 7: Extend Stripe Reconciliation Poller

**Files:**
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts`
- Modify: `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`

- [ ] **Step 1: Expand account query fields**

In `worker/background/pollers/StripeLocationsReconcilePoller.ts`, extend `AccountWithLocations`:

```ts
interface AccountWithLocations {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  stripe_subscription_id: string;
  locations_included: number;
  locations_overage_price_cents: number;
  active_location_count: number;
  past_due_at: Date | null;
  flags: Record<string, unknown>;
}
```

Update the SELECT to include:

```sql
a.locations_overage_price_cents,
a.past_due_at,
a.flags,
```

Update `GROUP BY` to include these added account columns.

- [ ] **Step 2: Use expected invoice helper in runOnce**

Import:

```ts
import { expectedInvoiceForAccount } from './billing-reconciliation/expected-invoice';
import { compareUpcomingInvoice, isExpectedStatusWindow } from './billing-reconciliation/drift';
```

After retrieving `subscription`, compute:

```ts
const expectedInvoice = expectedInvoiceForAccount({
  ...account,
  active_location_count: Number(account.active_location_count),
  flags: account.flags ?? {},
});
```

Keep the existing overage quantity comparison, but use `expectedInvoice.overageUnits` as the DB expected quantity.

- [ ] **Step 3: Add upcoming invoice retrieval behind existing Stripe client**

Extend the Stripe mock and production code to call:

```ts
const upcoming = await stripe.invoices.createPreview({
  customer: subscription.customer as string,
  subscription: account.stripe_subscription_id,
});
const actualTotalCents = upcoming.total ?? 0;
for (const drift of compareUpcomingInvoice(account.id, expectedInvoice.totalCents, actualTotalCents)) {
  emitDriftAlert(account.id, {
    dbExpectedOverage: expectedInvoice.overageUnits,
    stripeOverageQuantity,
    activeLocations,
    locationsIncluded: account.locations_included,
    tier,
    driftMessage: drift.message,
  });
  driftsFound++;
}
```

- [ ] **Step 4: Avoid unsafe status drift inside past_due grace**

When comparing Stripe subscription status to DB status, use this guard:

```ts
if (
  subscription.status !== account.subscription_status &&
  !isExpectedStatusWindow(account, subscription.status)
) {
  emitDriftAlert(account.id, {
    dbExpectedOverage: expectedInvoice.overageUnits,
    stripeOverageQuantity,
    activeLocations,
    locationsIncluded: account.locations_included,
    tier,
    driftMessage: `Stripe status ${subscription.status} differs from DB status ${account.subscription_status}`,
  });
  driftsFound++;
}
```

- [ ] **Step 5: Extend tests for stored overage price and invoice drift**

In `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`, update `MockStripe`:

```ts
default: class MockStripe {
  subscriptions = {
    retrieve: mockStripeRetrieve,
  };
  invoices = {
    createPreview: mockStripeCreatePreview,
  };
}
```

Add hoisted mock:

```ts
const { mockStripeRetrieve, mockStripeCreatePreview } = vi.hoisted(() => ({
  mockStripeRetrieve: vi.fn(),
  mockStripeCreatePreview: vi.fn(),
}));
```

Set default in `beforeEach`:

```ts
mockStripeCreatePreview.mockResolvedValue({ total: 12900 });
```

Add a test:

```ts
it('uses stored overage price for upcoming invoice comparison', async () => {
  sqlReturnQueue.push([
    makeAccountRow({
      id: 'acct-grandfathered',
      subscription_tier: 'standard',
      locations_included: 1,
      locations_overage_price_cents: 3000,
      active_location_count: 3,
    }),
  ]);
  mockStripeRetrieve.mockResolvedValue({
    ...makeStripeSubscription(2, 'price_overage_std'),
    customer: 'cus_123',
    status: 'active',
  });
  mockStripeCreatePreview.mockResolvedValue({ total: 13900 });

  const result = await runOnce();

  expect(result.driftsFound).toBe(0);
});
```

- [ ] **Step 6: Run reconciliation tests**

Run:

```bash
pnpm exec vitest run worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit PR slice 3**

Run:

```bash
git add worker/background/pollers/StripeLocationsReconcilePoller.ts worker/background/pollers/billing-reconciliation worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts
git commit -m "feat: reconcile Stripe invoices against billing snapshots"
```

---

## PR Slice 4: Security Launch Controls

### Task 8: Add Security Public Surfaces And Runbooks

**Files:**
- Create: `public/.well-known/security.txt`
- Create: `src/app/(public)/security/page.tsx`
- Create: `docs/security/vendor-risk-register.md`
- Create: `docs/security/access-checklist.md`
- Create: `docs/runbooks/secrets-rotation-stripe.md`
- Create: `docs/runbooks/secrets-rotation-supabase.md`
- Create: `docs/runbooks/secrets-rotation-zernio.md`
- Create: `docs/runbooks/secrets-rotation-email-and-messaging.md`
- Create: `docs/runbooks/secrets-rotation-api-keys.md`
- Create: `docs/runbooks/security-scan-staging.md`

- [ ] **Step 1: Add security.txt**

Create `public/.well-known/security.txt`:

```txt
Contact: mailto:security@repworth.com
Policy: https://repworth.net/security
Preferred-Languages: en
Canonical: https://repworth.net/.well-known/security.txt
```

- [ ] **Step 2: Add security page**

Create `src/app/(public)/security/page.tsx`:

```tsx
import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';

export default function SecurityPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />
      <main className="px-8 py-16 md:px-16">
        <div className="mx-auto max-w-3xl space-y-8">
          <header>
            <h1 className="mb-2 text-3xl font-medium text-[#2a2a2a]">Security</h1>
            <p className="text-sm text-[#4a4a4a]">
              RepWorth protects review, billing, and approval data with scoped access,
              hashed approval tokens, and explicit owner approval before posting.
            </p>
          </header>
          <section className="space-y-3">
            <h2 className="text-xl font-medium text-[#2a2a2a]">Vulnerability disclosure</h2>
            <p className="text-sm leading-relaxed text-[#4a4a4a]">
              Report suspected vulnerabilities to{' '}
              <a className="text-[#97B3AE] hover:underline" href="mailto:security@repworth.com">
                security@repworth.com
              </a>
              . We will acknowledge receipt, investigate in good faith, and avoid legal action
              for good-faith research that avoids data destruction, service disruption, and
              access to other customers&apos; data.
            </p>
          </section>
          <section className="space-y-3">
            <h2 className="text-xl font-medium text-[#2a2a2a]">Current status</h2>
            <ul className="list-disc space-y-2 pl-5 text-sm text-[#4a4a4a]">
              <li>Approval tokens are stored as SHA-256 hashes, not raw tokens.</li>
              <li>Customer-facing posting requires explicit owner approval.</li>
              <li>Tenant access is app-scoped and protected by RLS on authenticated reads.</li>
              <li>SOC 2 audit is not yet complete.</li>
            </ul>
          </section>
          <section className="space-y-3">
            <h2 className="text-xl font-medium text-[#2a2a2a]">Legal and privacy</h2>
            <p className="text-sm leading-relaxed text-[#4a4a4a]">
              See <Link href="/legal/privacy" className="text-[#97B3AE] hover:underline">Privacy</Link>,{' '}
              <Link href="/legal/terms" className="text-[#97B3AE] hover:underline">Terms</Link>, and{' '}
              <Link href="/legal/sub-processors" className="text-[#97B3AE] hover:underline">Sub-processors</Link>.
            </p>
          </section>
        </div>
      </main>
    </PageShell>
  );
}
```

- [ ] **Step 3: Add security docs**

Create each runbook with concrete rotation owners and cadence. Use this exact structure for every rotation file:

```md
# Secrets Rotation: Stripe

Owner: founder
Cadence: every 6 months and immediately after suspected exposure

## Scope

- Stripe API secret key
- Stripe webhook signing secret
- Stripe price IDs are configuration, not secrets

## Procedure

1. Create replacement secret in Stripe dashboard.
2. Add replacement value to Railway and Vercel environment stores.
3. Deploy worker and app.
4. Verify webhook delivery and checkout portal creation.
5. Remove old secret.
6. Record date, actor, and verification result in the rotation log.

## Rotation Log

| Date | Actor | Secret | Verification |
|---|---|---|---|
```

Use these `Scope` and `Cadence` values for the other rotation files:

- `docs/runbooks/secrets-rotation-supabase.md`: owner `founder`; cadence `annually and immediately after suspected exposure`; scope `Supabase service role key`, `Supabase anon key`, `database pool URL`.
- `docs/runbooks/secrets-rotation-zernio.md`: owner `founder`; cadence `every 6 months and immediately after suspected exposure`; scope `ZERNIO_API_KEY`, `Zernio webhook signing secret`.
- `docs/runbooks/secrets-rotation-email-and-messaging.md`: owner `founder`; cadence `every 6 months and immediately after suspected exposure`; scope `Resend API key`, `Twilio auth token`, `Telegram bot token`.
- `docs/runbooks/secrets-rotation-api-keys.md`: owner `founder`; cadence `quarterly and immediately after suspected exposure`; scope `ADMIN_API_KEY`, `ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET`, `CSRF_SECRET`.

- [ ] **Step 4: Add staging security scan runbook**

Create `docs/runbooks/security-scan-staging.md`:

````md
# Staging Security Scan

Wave 1 does not hard-gate ZAP in secret-free CI because the repo does not expose a stable staging target to pull requests.

## Required Secret

- `STAGING_BASE_URL`

## Command

```bash
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t "$STAGING_BASE_URL" -r zap-report.html
```

## Exit Policy

- PASS: no high-risk findings.
- FAIL: high-risk findings or scan cannot reach staging.
- WARN: medium findings require issue creation before merge.
````

- [ ] **Step 5: Run build for route compile**

Run:

```bash
pnpm build
```

Expected: PASS.

### Task 9: Add PHI Scanner To Zernio Ingest

**Files:**
- Create: `src/lib/security/phi-scanner.ts`
- Create: `src/lib/security/__tests__/phi-scanner.test.ts`
- Modify: `worker/jobs/zernio/ZernioReviewIngestWorker.ts`
- Modify: `worker/jobs/zernio/zernio-ingest-shared.ts`
- Modify: `worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts`

- [ ] **Step 1: Add PHI scanner tests**

Create `src/lib/security/__tests__/phi-scanner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectLikelyPhi, redactPhiForLog } from '../phi-scanner';

describe('phi-scanner', () => {
  it('detects MRN identifiers', () => {
    expect(detectLikelyPhi('Patient MRN 12345 had a great visit').matched).toBe(true);
  });

  it('detects diagnosis language', () => {
    expect(detectLikelyPhi('They helped with my diabetes treatment').matched).toBe(true);
  });

  it('does not flag ordinary restaurant reviews', () => {
    expect(detectLikelyPhi('Great service and friendly staff.').matched).toBe(false);
  });

  it('redacts raw text for logs', () => {
    expect(redactPhiForLog('Patient MRN 12345')).toBe('[redacted-review-text]');
  });
});
```

- [ ] **Step 2: Add scanner module**

Create `src/lib/security/phi-scanner.ts`:

```ts
export interface PhiDetection {
  matched: boolean;
  reasons: string[];
}

const PATTERNS: Array<{ reason: string; regex: RegExp }> = [
  { reason: 'mrn', regex: /\b(MRN|medical record number)\s*[:#-]?\s*\d{4,}\b/i },
  { reason: 'patient_context', regex: /\b(patient|diagnosis|treatment|prescription|medication)\b/i },
  { reason: 'condition_context', regex: /\b(diabetes|cancer|therapy|surgery|x-ray|xray|mri|ct scan)\b/i },
  { reason: 'insurance_identifier', regex: /\b(member id|policy number|insurance id)\s*[:#-]?\s*[a-z0-9-]{4,}\b/i },
];

export function detectLikelyPhi(text: string | null | undefined): PhiDetection {
  const value = text ?? '';
  const reasons = PATTERNS
    .filter((pattern) => pattern.regex.test(value))
    .map((pattern) => pattern.reason);
  return { matched: reasons.length > 0, reasons };
}

export function redactPhiForLog(_text: string | null | undefined): string {
  return '[redacted-review-text]';
}
```

- [ ] **Step 3: Add terminal PHI blocked error**

In `worker/jobs/zernio/ZernioReviewIngestWorker.ts`, add:

```ts
import { detectLikelyPhi } from '../../../src/lib/security/phi-scanner';
```

Before `buildZernioMonitoredReview(target, ...)`, add:

```ts
  const phi = detectLikelyPhi(target.comment);
  if (phi.matched) {
    logger.warn(`Likely PHI detected for review ${zernio_review_id}; reasons=${phi.reasons.join(',')}`);
    await markOutboxCompleted(outboxId, attempt);
    return;
  }
```

- [ ] **Step 4: Gate imported external reviews**

In `worker/jobs/zernio/zernio-ingest-shared.ts`, import:

```ts
import { detectLikelyPhi } from '../../../src/lib/security/phi-scanner';
```

Change `insertImportedReview` return type from `Promise<string>` to:

```ts
Promise<string | null>
```

At the top of `insertImportedReview`, after `const matchFields = fromZernioReview(target);`, add:

```ts
  const phi = detectLikelyPhi(matchFields.review_text_trimmed);
  if (phi.matched) {
    return null;
  }
```

In the previously unseen review branch, change:

```ts
      const newReviewId = await insertImportedReview(tx, businessId, accountId, locationId, target);
      const inserted = await insertImportedResponse(tx, businessId, newReviewId, null, target.reviewReply);
```

to:

```ts
      const newReviewId = await insertImportedReview(tx, businessId, accountId, locationId, target);
      if (!newReviewId) {
        logger.warn(`Likely PHI detected for previously-unseen review ${target.id}; skipping import`);
        return;
      }
      const inserted = await insertImportedResponse(tx, businessId, newReviewId, null, target.reviewReply);
```

- [ ] **Step 5: Run scanner tests**

Run:

```bash
pnpm exec vitest run src/lib/security/__tests__/phi-scanner.test.ts worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit PR slice 4**

Run:

```bash
git add public/.well-known/security.txt 'src/app/(public)/security/page.tsx' src/lib/security docs/security docs/runbooks worker/jobs/zernio/ZernioReviewIngestWorker.ts worker/jobs/zernio/zernio-ingest-shared.ts worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts
git commit -m "feat: add security launch controls and PHI scanner"
```

---

## PR Slice 5: Legal And Compliance Accuracy

### Task 10: Add Typed Legal Content And Legal Routes

**Files:**
- Create: `src/lib/legal/content.ts`
- Create: `src/components/legal/LegalPage.tsx`
- Create: `src/app/(public)/legal/terms/page.tsx`
- Create: `src/app/(public)/legal/privacy/page.tsx`
- Create: `src/app/(public)/legal/aup/page.tsx`
- Create: `src/app/(public)/legal/dpa/page.tsx`
- Create: `src/app/(public)/legal/cookies/page.tsx`
- Create: `src/app/(public)/legal/sub-processors/page.tsx`
- Modify: `next.config.mjs`

- [ ] **Step 1: Add typed content module**

Create `src/lib/legal/content.ts`:

```ts
export interface LegalSection {
  heading: string;
  body: string[];
}

export interface LegalDoc {
  slug: 'terms' | 'privacy' | 'aup' | 'dpa' | 'cookies' | 'sub-processors';
  title: string;
  version: string;
  effectiveDate: string;
  sections: LegalSection[];
}

export const legalDocs: Record<LegalDoc['slug'], LegalDoc> = {
  terms: {
    slug: 'terms',
    title: 'Terms of Service',
    version: '2026-05-25',
    effectiveDate: '2026-05-25',
    sections: [
      {
        heading: 'The Service',
        body: [
          'RepWorth monitors Google Business Profile reviews, generates AI-drafted response suggestions, and delivers those drafts for owner approval.',
          'No response is published to Google without explicit owner approval.',
        ],
      },
      {
        heading: 'AI-generated drafts',
        body: [
          'Responses are AI-generated drafts requiring owner approval before publication. You are responsible for reviewing all drafts before approving them.',
        ],
      },
    ],
  },
  privacy: {
    slug: 'privacy',
    title: 'Privacy Policy',
    version: '2026-05-25',
    effectiveDate: '2026-05-25',
    sections: [
      {
        heading: 'Data we process',
        body: [
          'We process account data, business profile data, Google review data, approval actions, notification data, and Stripe billing identifiers.',
          'Review text may be sent to OpenAI or Anthropic to generate response drafts.',
        ],
      },
    ],
  },
  aup: {
    slug: 'aup',
    title: 'Acceptable Use Policy',
    version: '2026-05-25',
    effectiveDate: '2026-05-25',
    sections: [
      {
        heading: 'Prohibited use',
        body: [
          'You may not use RepWorth to generate defamatory, deceptive, unlawful, harassing, or privacy-invasive content.',
        ],
      },
    ],
  },
  dpa: {
    slug: 'dpa',
    title: 'Data Processing Addendum',
    version: '2026-05-25',
    effectiveDate: '2026-05-25',
    sections: [
      {
        heading: 'Status',
        body: [
          'A lawyer-reviewed DPA is pending. This page records the intended publication route and current external review status.',
        ],
      },
    ],
  },
  cookies: {
    slug: 'cookies',
    title: 'Cookie Policy',
    version: '2026-05-25',
    effectiveDate: '2026-05-25',
    sections: [
      {
        heading: 'Cookies',
        body: [
          'RepWorth uses necessary cookies for authentication, security, approval sessions, and account preferences.',
        ],
      },
    ],
  },
  'sub-processors': {
    slug: 'sub-processors',
    title: 'Sub-processors',
    version: '2026-05-25',
    effectiveDate: '2026-05-25',
    sections: [
      {
        heading: 'Current data path',
        body: [
          'Current sub-processors include OpenAI, Anthropic, Stripe, Supabase, Vercel, Railway, Upstash, Resend, Twilio, Telegram, Zernio, Sentry, SerpAPI, and Google Maps Platform.',
          'PostHog is listed only after production event flow is confirmed.',
        ],
      },
    ],
  },
};
```

- [ ] **Step 2: Add legal page component**

Create `src/components/legal/LegalPage.tsx`:

```tsx
import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';
import type { LegalDoc } from '@/lib/legal/content';

export function LegalPage({ doc }: { doc: LegalDoc }) {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />
      <main className="px-8 py-16 md:px-16">
        <article className="mx-auto max-w-3xl">
          <h1 className="mb-2 text-3xl font-medium text-[#2a2a2a]">{doc.title}</h1>
          <p className="mb-10 text-sm text-[#97B3AE]">
            Version {doc.version} · Effective {doc.effectiveDate}
          </p>
          <div className="space-y-8 text-[#4a4a4a]">
            {doc.sections.map((section) => (
              <section key={section.heading} className="space-y-3">
                <h2 className="text-xl font-medium text-[#2a2a2a]">{section.heading}</h2>
                {section.body.map((paragraph) => (
                  <p key={paragraph} className="text-sm leading-relaxed">{paragraph}</p>
                ))}
              </section>
            ))}
          </div>
          <div className="mt-12 border-t border-[#97B3AE]/20 pt-8">
            <Link href="/" className="text-sm text-[#97B3AE] hover:underline">
              Back to home
            </Link>
          </div>
        </article>
      </main>
    </PageShell>
  );
}
```

- [ ] **Step 3: Add route pages**

For each legal route, create a page with this pattern.

`src/app/(public)/legal/terms/page.tsx`:

```tsx
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export default function TermsLegalPage() {
  return <LegalPage doc={legalDocs.terms} />;
}
```

Use the same pattern for `privacy`, `aup`, `dpa`, `cookies`, and `sub-processors`, changing the export name and `legalDocs` key.

- [ ] **Step 4: Add redirects**

In `next.config.mjs`, add this method inside `nextConfig`:

```js
  async redirects() {
    return [
      { source: '/terms', destination: '/legal/terms', permanent: true },
      { source: '/privacy', destination: '/legal/privacy', permanent: true },
    ];
  },
```

- [ ] **Step 5: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

### Task 11: Add AI Disclosure At Approval Moments

**Files:**
- Modify: `src/components/approval/approval-client.tsx`
- Modify: `src/components/dashboard/EditReplyDrawer.tsx`

- [ ] **Step 1: Add public approval disclosure**

In `src/components/approval/approval-client.tsx`, inside the response card before the draft label, add:

```tsx
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Draft generated by AI. Review carefully before approving.
        </div>
```

- [ ] **Step 2: Add dashboard drawer disclosure**

In `src/components/dashboard/EditReplyDrawer.tsx`, render the same text in the initial and preview states near the generated response text. Use existing drawer classes where available; otherwise use:

```tsx
<div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
  Draft generated by AI. Review carefully before approving.
</div>
```

- [ ] **Step 3: Run component tests**

Run:

```bash
pnpm exec vitest run 'src/app/(public)/approve/[token]/__tests__' src/components/dashboard/__tests__
```

Expected: PASS.

### Task 12: Update Legal Links And Docs Mirrors

**Files:**
- Create: `docs/legal/aup.md`
- Create: `docs/legal/dpa.md`
- Create: `docs/legal/cookies.md`
- Create: `docs/legal/sub-processors.md`
- Create: `docs/legal/legal-review.md`
- Create: `docs/legal/insurance.md`
- Modify: `docs/legal/repworth-terms-of-service.md`
- Modify: `docs/legal/repworth-privacy-policy.md`
- Modify: `src/components/sections/landing/LandingContent.tsx`
- Modify: `src/components/auth/auth-island/SignupForm.tsx`
- Modify: `src/components/auth/auth-island/__tests__/SignupForm.test.tsx`

- [ ] **Step 1: Update public links**

Change links from:

```tsx
href="/terms"
href="/privacy"
```

to:

```tsx
href="/legal/terms"
href="/legal/privacy"
```

Apply this in landing content and signup form. Update signup tests to expect the new hrefs.

- [ ] **Step 2: Add docs mirrors**

Create `docs/legal/sub-processors.md`:

```md
# Sub-processors

Version: 2026-05-25
Effective date: 2026-05-25

| Vendor | Purpose | Data classes |
|---|---|---|
| OpenAI | AI draft generation | Review text, generated responses |
| Anthropic | AI draft fallback | Review text, generated responses |
| Stripe | Payments | Billing data, name, email, address |
| Supabase | Database and auth | App data, auth metadata |
| Vercel | Web hosting | Request metadata |
| Railway | Worker hosting | Request metadata, job processing metadata |
| Upstash | Redis cache and queues | Cache keys, job payload metadata |
| Resend | Email | Email addresses, message content |
| Twilio | SMS and WhatsApp | Phone numbers, message content |
| Telegram | Bot delivery | Telegram identifiers, message content |
| Zernio | Google review ingestion and posting | GBP OAuth tokens, review data |
| Sentry | Error tracking | Scrubbed error metadata |
| SerpAPI | Demo, prefill, and fallback location data | Public business/review data |
| Google Maps Platform | Place autocomplete and map/place metadata | Place query metadata |
```

Create `docs/legal/legal-review.md`:

```md
# Legal Review Status

Status: pending lawyer review

Wave 1 publishes route-backed legal documents and tracks versions. Lawyer review remains an external acceptance gate.

| Document | Version | Status |
|---|---|---|
| Terms | 2026-05-25 | pending lawyer review |
| Privacy | 2026-05-25 | pending lawyer review |
| AUP | 2026-05-25 | pending lawyer review |
| DPA | 2026-05-25 | pending lawyer review |
| Cookie Policy | 2026-05-25 | pending lawyer review |
| Sub-processors | 2026-05-25 | founder verified |
```

Create `docs/legal/insurance.md`:

```md
# Insurance Status

Status: pending

Target coverage before first paid customer:

- $1M Errors and Omissions.
- $1M Cyber liability.

| Date | Provider | Coverage | Status |
|---|---|---|---|
```

- [ ] **Step 3: Add AUP, DPA, and cookie docs**

Create `docs/legal/aup.md`, `docs/legal/dpa.md`, and `docs/legal/cookies.md` with the same version/effective date as `src/lib/legal/content.ts` and the same section content used in the typed module.

- [ ] **Step 4: Run tests and build**

Run:

```bash
pnpm exec vitest run src/components/auth/auth-island/__tests__/SignupForm.test.tsx
pnpm build
```

Expected: PASS.

- [ ] **Step 5: Commit PR slice 5**

Run:

```bash
git add src/lib/legal src/components/legal 'src/app/(public)/legal' next.config.mjs src/components/approval/approval-client.tsx src/components/dashboard/EditReplyDrawer.tsx src/components/sections/landing/LandingContent.tsx src/components/auth/auth-island/SignupForm.tsx src/components/auth/auth-island/__tests__/SignupForm.test.tsx docs/legal
git commit -m "feat: publish legal routes and approval AI disclosure"
```

---

## Final Verification

- [ ] **Step 1: Run focused test suites**

Run:

```bash
pnpm exec vitest run src/lib/approval/__tests__/service.test.ts src/lib/approval/__tests__/approve-via-callback.test.ts src/lib/shared/__tests__/migration-044-approval-audit-snapshot.test.ts
pnpm exec vitest run scripts/ci/__tests__/tenant-scope-audit.test.ts scripts/ci/__tests__/rls-audit.test.ts src/__tests__/tenant-isolation.test.ts
pnpm exec vitest run worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts
pnpm exec vitest run src/lib/security/__tests__/phi-scanner.test.ts worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts
pnpm exec vitest run src/components/auth/auth-island/__tests__/SignupForm.test.tsx
```

Expected: all commands PASS, with tenant integration skipped when `TEST_DATABASE_POOL_URL` is unset.

- [ ] **Step 2: Run CI scripts**

Run:

```bash
pnpm ci:tenant-scope
pnpm ci:rls-audit
```

Expected: tenant scope PASS; RLS audit PASS when DB URL exists or prints skip when DB URL is absent.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

## Self-Review Checklist

- [ ] Approval snapshot is written to `approval_audit_log`, not `responses`.
- [ ] Snapshot source is the same final text that feeds `responses.approved_text`.
- [ ] Callback approvals through `approveViaCallback` are covered.
- [ ] Billing expected invoice uses stored `locations_included` and stored `locations_overage_price_cents`.
- [ ] Tenant-scope allowlist entries all have reasons.
- [ ] PHI-positive Zernio reviews do not retry forever.
- [ ] Legal content uses typed module, not MDX runtime.
- [ ] Sub-processors include SerpAPI and Google Maps Platform and exclude non-live vendors.
- [ ] No source file claims SOC 2, lawyer review, insurance, ZAP, Trivy, or Snyk are complete without evidence.
