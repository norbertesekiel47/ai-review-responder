// Live-Postgres race suite for vetoAutoPost (WS4 plan Task 8 Step 4, spec
// §2.6): the unit suite pins SQL text; this proves the ATOMICITY claim — the
// pending publish_response outbox row is the single decision point between
// the OutboxPoller's FOR UPDATE SKIP LOCKED claim and the veto's guarded
// terminalizing UPDATE. Whoever locks first wins:
//   (i)  poller claims and holds → concurrent veto blocks on the row lock,
//        then truthfully reports 'too_late' (response untouched, link intact);
//   (ii) veto terminalizes first → 'cancelled', and a poller-style claim
//        (concurrent via SKIP LOCKED, then again post-commit) finds nothing.
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one). Migrations
// 071/074 are applied idempotently in beforeAll (074 behind the shared
// advisory-lock helper — parallel suites re-apply it too).

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_071_RUN_SPINE,
  MIGRATION_074_TRUST_DIAL_VETO_WINDOW,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { enqueuePublishResponse } from '@/lib/shared/job-outbox-helpers';
import { startOrGetActiveRun } from '@/lib/agents/run-spine';
import { vetoAutoPost, AUTO_POST_VETOED_BY_OWNER } from '../veto';
import type { ApprovalLink } from '../types';
import type { AuditContext } from '../audit';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
let runId: string | undefined;

const businessId = randomUUID();
// Two independent scheduled auto-posts: A loses the race in (i), B wins it in (ii).
const a = { reviewId: randomUUID(), responseId: randomUUID(), linkId: uuidv7() };
const b = { reviewId: randomUUID(), responseId: randomUUID(), linkId: uuidv7() };

const AUDIT_CTX: AuditContext = {
  tokenHash: 'veto-int-token-hash',
  deviceCookieHash: null,
  ipAddress: null,
};

function sql(): postgresType.Sql {
  if (!db) throw new Error('veto integration database was not initialized');
  return db;
}

function mkLink(ids: { responseId: string; linkId: string }): ApprovalLink {
  return {
    id: ids.linkId,
    response_id: ids.responseId,
    business_id: businessId,
    token_hash: `veto-int-${ids.linkId}`,
    channel: 'email',
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    consumed_at: null,
    revoked_at: null,
    device_cookie_hash: null,
    created_at: new Date(),
  };
}

async function seedScheduledAutoPost(ids: {
  reviewId: string;
  responseId: string;
  linkId: string;
}): Promise<void> {
  await sql()`
    INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
    VALUES (${ids.reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`veto-int-${ids.reviewId}`}, ${`zernio://veto-int/reviews/${ids.reviewId}`}, 'zernio://veto-int/locations/1', 'Reviewer', 5, 'Wonderful service', 'responded')
  `;
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text, response_language,
      status, approval_method, approved_at, approved_text, auto_post_scheduled_at
    ) VALUES (
      ${ids.responseId}::uuid, ${ids.reviewId}::uuid, ${businessId}::uuid,
      'Thanks for visiting!', 'Thanks for visiting!', 'en',
      'approved', 'auto_policy', NOW(), 'Thanks for visiting!', NOW()
    )
  `;
  await sql()`
    INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
    VALUES (${ids.linkId}, ${ids.responseId}::uuid, ${businessId}::uuid, ${`veto-int-${ids.linkId}`}, 'email', NOW() + INTERVAL '1 hour')
  `;
  // available_at defaults to NOW(): the race under test happens AT the
  // deadline, when the row first becomes claimable.
  await sql().begin(async (tx) => {
    await enqueuePublishResponse(tx, {
      responseId: ids.responseId,
      businessId,
    });
  });
}

/** Poller-style claim (OutboxPoller phase 2 shape) scoped to one aggregate. */
async function claimPollerStyle(
  tx: postgresType.TransactionSql,
  responseId: string,
): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    UPDATE job_outbox
    SET status = 'dispatching', attempts = attempts + 1, dispatched_at = NOW()
    WHERE id IN (
      SELECT id FROM job_outbox
      WHERE status = 'pending'
        AND available_at <= NOW()
        AND topic = ${QUEUE_NAMES.PUBLISH_RESPONSE}
        AND aggregate_id = ${responseId}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolveFn = resolvePromise;
  });
  return { promise, resolve: resolveFn };
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

describeWithDb('vetoAutoPost against live Postgres (publish-vs-veto race)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    // max > 2: races below hold one transaction open while a second runs.
    db = postgres(testDatabaseUrl!, { max: 4, prepare: false });
    await assertSchemaReady(db, [
      MIGRATION_071_RUN_SPINE,
      MIGRATION_074_TRUST_DIAL_VETO_WINDOW,
    ]);
    tenant = await seedTenantAccount(db, {
      userName: 'Veto Race Owner',
      accountDisplayName: 'Veto Race Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Veto Race Biz', 'Veto Race Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await seedScheduledAutoPost(a);
    await seedScheduledAutoPost(b);

    // A run still RUNNING on review B — the cancelled lane must record
    // reply_vetoed_by_owner against it.
    await db.begin(async (tx) => {
      // Lock-ordering contract: review row FOR UPDATE first.
      await tx`SELECT id FROM reviews WHERE id = ${b.reviewId}::uuid FOR UPDATE`;
      const started = await startOrGetActiveRun(tx, {
        kind: 'review_handler',
        subjectType: 'review',
        subjectId: b.reviewId,
        accountId: tenant!.accountId,
        businessId,
      });
      runId = started.runId;
    });
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      const responseIds = [a.responseId, b.responseId];
      const reviewIds = [a.reviewId, b.reviewId];
      await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM agent_run_steps WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid)`;
      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM approval_audit_log WHERE response_id = ANY(${responseIds}::uuid[])`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id = ANY(${responseIds}::uuid[])`;
      await sql()`DELETE FROM approval_links WHERE response_id = ANY(${responseIds}::uuid[])`;
      await sql()`DELETE FROM responses WHERE id = ANY(${responseIds}::uuid[])`;
      await sql()`DELETE FROM reviews WHERE id = ANY(${reviewIds}::uuid[])`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('(i) poller claims first and holds → concurrent veto is too_late; nothing else mutates', async () => {
    const claimed = deferred();
    const release = deferred();

    const pollerTx = sql().begin(async (tx) => {
      const rows = await claimPollerStyle(tx, a.responseId);
      claimed.resolve();
      await release.promise;
      return rows;
    });

    await claimed.promise;
    // The veto's guarded outbox UPDATE blocks on the claimed row's lock
    // (guarded UPDATEs wait — only the poller side skips). Release the claim
    // while the veto is parked so it wakes to a committed 'dispatching' row.
    const vetoPromise = sql().begin((tx) => vetoAutoPost(tx, mkLink(a), AUDIT_CTX));
    await sleep(200);
    release.resolve();

    const [claimRows, vetoResult] = await Promise.all([pollerTx, vetoPromise]);
    expect(claimRows).toHaveLength(1);
    expect(vetoResult).toBe('too_late');

    // Loser mutated NOTHING: the publish proceeds untouched.
    const [resp] = await sql()<{ status: string; approval_method: string | null; auto_post_scheduled_at: Date | null }[]>`
      SELECT status, approval_method, auto_post_scheduled_at FROM responses WHERE id = ${a.responseId}::uuid
    `;
    expect(resp).toMatchObject({ status: 'approved', approval_method: 'auto_policy' });
    expect(resp!.auto_post_scheduled_at).not.toBeNull();
    const [link] = await sql()<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM approval_links WHERE id = ${a.linkId}
    `;
    expect(link!.consumed_at).toBeNull();
    const [outboxRow] = await sql()<{ status: string }[]>`
      SELECT status FROM job_outbox WHERE topic = ${QUEUE_NAMES.PUBLISH_RESPONSE} AND aggregate_id = ${a.responseId}
    `;
    expect(outboxRow!.status).toBe('dispatching');
  });

  it('(ii) veto terminalizes first → cancelled; the poller-style claim finds nothing', async () => {
    const vetoDone = deferred();
    const releaseVeto = deferred();

    const vetoTx = sql().begin(async (tx) => {
      const result = await vetoAutoPost(tx, mkLink(b), AUDIT_CTX, 'veto-int-corr');
      vetoDone.resolve();
      await releaseVeto.promise;
      return result;
    });

    // While the veto tx still HOLDS the terminalized row, a concurrent
    // poller-style claim must come back empty — SKIP LOCKED skips it.
    await vetoDone.promise;
    const concurrentClaim = await sql().begin((tx) => claimPollerStyle(tx, b.responseId));
    expect(concurrentClaim).toHaveLength(0);

    releaseVeto.resolve();
    await expect(vetoTx).resolves.toBe('cancelled');

    // Post-commit the row is terminal ('completed') — still nothing to claim.
    const postCommitClaim = await sql().begin((tx) => claimPollerStyle(tx, b.responseId));
    expect(postCommitClaim).toHaveLength(0);

    const [killedRow] = await sql()<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM job_outbox WHERE topic = ${QUEUE_NAMES.PUBLISH_RESPONSE} AND aggregate_id = ${b.responseId}
    `;
    expect(killedRow).toMatchObject({ status: 'completed', last_error: AUTO_POST_VETOED_BY_OWNER });

    // Full downgrade shape + link consumption + audit + re-notify + outcome.
    const [resp] = await sql()<{
      status: string; approval_method: string | null; approved_at: Date | null;
      approved_text: string | null; auto_post_scheduled_at: Date | null; posting_error: string | null;
    }[]>`
      SELECT status, approval_method, approved_at, approved_text, auto_post_scheduled_at, posting_error
      FROM responses WHERE id = ${b.responseId}::uuid
    `;
    expect(resp).toMatchObject({
      status: 'pending_approval',
      approval_method: null,
      approved_at: null,
      approved_text: null,
      auto_post_scheduled_at: null,
      posting_error: AUTO_POST_VETOED_BY_OWNER,
    });

    const [link] = await sql()<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM approval_links WHERE id = ${b.linkId}
    `;
    expect(link!.consumed_at).not.toBeNull();

    const audits = await sql()<{ action: string }[]>`
      SELECT action FROM approval_audit_log WHERE response_id = ${b.responseId}::uuid
    `;
    expect(audits.map((row) => row.action)).toContain('veto_cancel');

    const outcomes = await sql()<{ agent_run_id: string; attributed_agent: string }[]>`
      SELECT agent_run_id, attributed_agent FROM agent_outcomes
      WHERE outcome_kind = 'reply_vetoed_by_owner' AND account_id = ${tenant!.accountId}::uuid
    `;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ agent_run_id: runId, attributed_agent: 'reply' });

    const notifyRows = await sql()<{ status: string }[]>`
      SELECT status FROM job_outbox
      WHERE topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND aggregate_id = ${b.responseId}
    `;
    expect(notifyRows).toHaveLength(1);
    expect(notifyRows[0]!.status).toBe('pending');
  });
});
