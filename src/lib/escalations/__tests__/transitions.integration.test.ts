// Real-schema behavioral suite for the WS3 escalation transitions (spec §2.7):
// the unit suite only asserts SQL *text*; this drives acknowledge/resolve
// against live Postgres so the state_timestamps CHECK (migration 073) and the
// run-spine attribution actually execute. The key claim under test: resolving
// an escalation records an `escalation_resolved` outcome against a run that
// COMPLETED long before — via the agent_run_id snapshotted at raise time.
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one). Migrations
// 071/073 are applied in beforeAll — both fully idempotent, so this becomes a
// no-op once they ship to the shared test DB.

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { completeRun, startOrGetActiveRun } from '@/lib/agents/run-spine';
import { acknowledgeEscalation, resolveEscalation } from '../transitions';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
let runId: string | undefined;
const businessId = randomUUID();
const reviewId = randomUUID();
const escalationId = uuidv7();

function sql(): postgresType.Sql {
  if (!db) throw new Error('escalation-transitions integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('escalation-transitions integration tenant was not seeded');
  return tenant.accountId;
}

async function insertEscalation(id: string, agentRunId: string | null): Promise<void> {
  await sql()`
    INSERT INTO review_escalations (
      id, account_id, business_id, review_id, agent_run_id, status,
      triage_severity, triage_source, triage_suggested_action, triage_issues
    ) VALUES (
      ${id}, ${accountId()}::uuid, ${businessId}::uuid, ${reviewId}::uuid,
      ${agentRunId}, 'escalated', 'high', 'llm_triage_v1', 'escalate',
      ${['staff_conduct']}
    )
  `;
}

async function escalationById(id: string): Promise<{
  status: string;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
}> {
  const [row] = await sql()<
    { status: string; acknowledged_at: Date | null; resolved_at: Date | null }[]
  >`
    SELECT status, acknowledged_at, resolved_at
    FROM review_escalations WHERE id = ${id}::uuid
  `;
  if (!row) throw new Error(`escalation ${id} not found`);
  return row;
}

async function resolvedOutcomeRows(): Promise<{ agent_run_id: string; attributed_agent: string }[]> {
  return sql()<{ agent_run_id: string; attributed_agent: string }[]>`
    SELECT agent_run_id, attributed_agent FROM agent_outcomes
    WHERE outcome_kind = 'escalation_resolved' AND account_id = ${accountId()}::uuid
  `;
}

describeWithDb('escalation transitions against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    for (const migration of ['071_agent_run_spine.sql', '073_review_escalations.sql']) {
      await db.unsafe(readFileSync(resolve(process.cwd(), 'supabase/migrations', migration), 'utf-8'));
    }
    tenant = await seedTenantAccount(db, {
      userName: 'Escalation Transitions Owner',
      accountDisplayName: 'Escalation Transitions Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Escalation Transitions Biz', 'Escalation Transitions Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await db`
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
      VALUES (${reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`esc-tr-${reviewId}`}, ${`zernio://esc-tr/reviews/${reviewId}`}, 'zernio://esc-tr/locations/1', 'Reviewer', 1, 'The manager screamed at us.', 'pending')
    `;

    // A review_handler run that COMPLETED before any transition happens —
    // the escalation's agent_run_id snapshot is what carries attribution.
    await db.begin(async (tx) => {
      // Lock-ordering contract: review row FOR UPDATE first.
      await tx`SELECT id FROM reviews WHERE id = ${reviewId}::uuid FOR UPDATE`;
      const started = await startOrGetActiveRun(tx, {
        kind: 'review_handler',
        subjectType: 'review',
        subjectId: reviewId,
        accountId: tenant!.accountId,
        businessId,
      });
      runId = started.runId;
      await completeRun(tx, runId, 'completed');
    });

    await insertEscalation(escalationId, runId!);
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM review_escalations WHERE review_id = ${reviewId}::uuid`;
      await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM agent_run_steps WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid)`;
      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM reviews WHERE id = ${reviewId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('acknowledge: escalated → acknowledged with acknowledged_at stamped', async () => {
    const result = await acknowledgeEscalation(sql(), {
      escalationId,
      accountId: accountId(),
    });
    expect(result).toEqual({ ok: true, status: 'acknowledged', noop: false });

    const row = await escalationById(escalationId);
    expect(row.status).toBe('acknowledged');
    expect(row.acknowledged_at).not.toBeNull();
    expect(row.resolved_at).toBeNull();
  });

  it('resolve: stamps both timestamps and records escalation_resolved against the COMPLETED run', async () => {
    const result = await resolveEscalation(sql(), {
      escalationId,
      accountId: accountId(),
    });
    expect(result).toEqual({ ok: true, status: 'resolved', noop: false });

    const row = await escalationById(escalationId);
    expect(row.status).toBe('resolved');
    expect(row.acknowledged_at).not.toBeNull();
    expect(row.resolved_at).not.toBeNull();

    const outcomes = await resolvedOutcomeRows();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.agent_run_id).toBe(runId);
    expect(outcomes[0]!.attributed_agent).toBe('guardian');
  });

  it('second resolve is a noop success and does NOT double-emit the outcome', async () => {
    const result = await resolveEscalation(sql(), {
      escalationId,
      accountId: accountId(),
    });
    expect(result).toEqual({ ok: true, status: 'resolved', noop: true });
    expect(await resolvedOutcomeRows()).toHaveLength(1);
  });

  it('direct resolve (no acknowledge) stamps BOTH timestamps — state_timestamps CHECK satisfied', async () => {
    // The previous escalation is resolved, so the one-open-per-review partial
    // index allows a fresh open escalation on the same review. Null
    // agent_run_id exercises the legacy skip-outcome lane live.
    const freshEscalationId = uuidv7();
    await insertEscalation(freshEscalationId, null);

    const result = await resolveEscalation(sql(), {
      escalationId: freshEscalationId,
      accountId: accountId(),
    });
    expect(result).toEqual({ ok: true, status: 'resolved', noop: false });

    const row = await escalationById(freshEscalationId);
    expect(row.status).toBe('resolved');
    expect(row.acknowledged_at).not.toBeNull();
    expect(row.resolved_at).not.toBeNull();
    // Null agent_run_id → no new outcome row.
    expect(await resolvedOutcomeRows()).toHaveLength(1);
  });
});
