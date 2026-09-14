// Executed September 14; result and cleanup evidence are retained beside this file.
// Run with the deployed candidate's tsx loader from its root,
// after final observation capture, using only the pinned staging service.
// This controlled fixture exercises production domain reconciliation, not a
// naturally observed transport outage. Poller wiring has separate DB tests.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const accountId = '019f43d0-0000-7000-8000-000000000001';
const userId = '019f43d0-0000-7000-8000-000000000002';
const locationId = '019f43d0-0000-7000-8000-000000000011';
const conversationId = '019f43d0-0000-7000-8000-000000000031';
const turnId = '019f43d0-0000-7000-8000-000000000032';
const clientTurnKey = '019f43d0-0000-7000-8000-000000000033';
const outboxId = '019f43d0-0000-7000-8000-000000000034';
// Owner ended observation early; pin the actual retained final capture.
// See observation-owner-early-close.json; this does not claim24-hour coverage.
const earliestEnd = Date.parse('2026-09-14T17:36:31.857381Z');
const importFromRoot = (path) => import(pathToFileURL(resolve(process.cwd(), path)).href);
let stage = 'target_guards';

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  requireCondition(process.env.RAILWAY_PROJECT_ID === 'ad641d0e-dc01-4250-b71c-db1beedb9c8c'
    && process.env.RAILWAY_ENVIRONMENT_ID === '58c06358-8cbe-497f-bec0-df3b47769a10'
    && process.env.RAILWAY_SERVICE_ID === 'fb413c72-29b6-4cd1-90c2-26002491e301', 'Wrong staging target');
  requireCondition(process.env.RAILWAY_GIT_COMMIT_SHA === '4b13d96621b156a47dbc4140995f45745bc8114d', 'Candidate is not confirmed');
  const databaseUrl = new URL(process.env.DATABASE_POOL_URL);
  requireCondition(databaseUrl.hostname === 'db.kubdiqdhqbhwmqfditeg.supabase.co'
    || decodeURIComponent(databaseUrl.username) === 'postgres.kubdiqdhqbhwmqfditeg', 'Wrong database project');
  const finalCapture = Date.parse(process.env.RUN_D_FINAL_OBSERVATION_CAPTURE_AT ?? '');
  requireCondition(Number.isFinite(finalCapture) && finalCapture >= earliestEnd
    && finalCapture <= Date.now(), 'Final observation capture must precede this fixture');

  stage = 'imports';
  const { sql } = await importFromRoot('src/lib/db/server.ts');
  const { enqueueAgentTurn } = await importFromRoot('src/lib/shared/job-outbox-helpers.ts');
  const { reconcileTurnForFailedOutbox } = await importFromRoot('src/lib/agents/operator/turns.ts');
  const { AGENT_TURN_LEASE_SECONDS } = await importFromRoot('worker/jobs/agent-turn/constants.ts');
  const result = await sql.begin(async (tx) => {
    stage = 'owner_binding';
    const [owner] = await tx`
      SELECT a.id FROM accounts a
      JOIN users u ON u.account_id = a.id AND u.id = a.owner_user_id
      JOIN businesses b ON b.account_id = a.id
      WHERE a.id = ${accountId}::uuid AND u.id = ${userId}::uuid
        AND u.auth_id = '856a970a-45a9-43a4-a9a4-71261f7b4fb7'
        AND u.email = 'run-d-c48bb6a6@e2e.repworth.net'
        AND b.id = ${locationId}::uuid AND b.archived_at IS NULL
      FOR UPDATE OF a, u, b
    `;
    requireCondition(Boolean(owner), 'Synthetic owner binding is not confirmed');
    stage = 'active_turns';
    const [active] = await tx`
      SELECT count(*)::int AS count FROM agent_turns
      WHERE account_id = ${accountId}::uuid AND status IN ('accepted', 'running')
    `;
    requireCondition(active.count === 0, 'Existing observation work is not terminal');

    // Unique fixed IDs fail closed on replay or an unexpected preexisting row.
    stage = 'insert_conversation';
    await tx`INSERT INTO agent_conversations (id, account_id, created_by_user_id, last_turn_at)
      VALUES (${conversationId}::uuid, ${accountId}::uuid, ${userId}::uuid, NOW())`;
    stage = 'insert_turn';
    await tx`INSERT INTO agent_turns
      (id, conversation_id, account_id, actor_user_id, location_id, client_turn_key, sequence, owner_text, status)
      VALUES (${turnId}::uuid, ${conversationId}::uuid, ${accountId}::uuid, ${userId}::uuid,
        ${locationId}::uuid, ${clientTurnKey}::uuid, 1,
        'Run D controlled dispatch-exhaustion recovery check. No settings change requested.', 'accepted')`;
    stage = 'enqueue';
    await enqueueAgentTurn(tx, { turnId, accountId, conversationId, outboxId });
    stage = 'dispatch_transition';
    await tx`UPDATE job_outbox SET status = 'dispatching', attempts = 5, max_attempts = 5, dispatched_at = NOW()
      WHERE id = ${outboxId}::uuid AND aggregate_id = ${turnId}::uuid AND status = 'pending'
        AND payload->>'account_id' = ${accountId}`;
    const winners = await tx`UPDATE job_outbox
      SET status = 'failed', completed_at = NOW(), last_error = 'Synthetic browser recovery fixture'
      WHERE id = ${outboxId}::uuid AND aggregate_id = ${turnId}::uuid
        AND payload->>'account_id' = ${accountId} AND status = 'dispatching' AND attempts = 5
      RETURNING id`;
    requireCondition(winners.length === 1, 'Synthetic terminal attempt did not win');
    stage = 'reconcile';
    const reconciled = await reconcileTurnForFailedOutbox(tx, outboxId, AGENT_TURN_LEASE_SECONDS);
    requireCondition(reconciled === 'failed', 'Production reconciliation did not fail the fixture');
    const [pair] = await tx`
      SELECT t.id AS turn_id, t.conversation_id, t.status AS turn_status, t.failure_reason,
        t.created_at::text, t.completed_at::text, o.id AS outbox_id, o.status AS outbox_status,
        o.attempts AS synthetic_dispatch_attempt, o.completed_at::text AS outbox_completed_at
      FROM agent_turns t JOIN job_outbox o ON o.aggregate_id = t.id AND o.id = ${outboxId}::uuid
      WHERE t.id = ${turnId}::uuid AND t.account_id = ${accountId}::uuid
    `;
    requireCondition(pair.turn_status === 'failed' && pair.failure_reason === 'dispatch_exhausted'
      && pair.outbox_status === 'failed', 'Unexpected final fixture state');
    // Preserve the failed turn for the browser, but retire this temporary
    // synthetic outbox before commit. A durable failed outbox would correctly
    // page through checkFailedOutboxByTopic; this is not an alert-delivery drill.
    const retired = await tx`DELETE FROM job_outbox
      WHERE id = ${outboxId}::uuid AND aggregate_id = ${turnId}::uuid
        AND payload->>'account_id' = ${accountId} AND status = 'failed' AND attempts = 5
      RETURNING id`;
    requireCondition(retired.length === 1, 'Temporary synthetic outbox was not retired');
    return { ...pair, outbox_snapshot_was_inside_transaction: true, outbox_retired_before_commit: true };
  });
  console.log(JSON.stringify({ campaign: 'run-d-browser-recovery', controlled_fixture: true,
    actual_dispatch_attempts: 0, provider_calls: 0, captured_at: new Date().toISOString(), result }));
}

const deadline = setTimeout(() => {
  console.error('Run D recovery fixture deadline reached; inspect the fixed IDs before any retry.');
  process.exit(2);
}, 30_000);
main().then(() => { clearTimeout(deadline); process.exit(0); }).catch((error) => {
  clearTimeout(deadline);
  // Emit only a fixed stage and SQLSTATE, never error text, query, or parameters.
  console.log(JSON.stringify({ campaign: 'run-d-browser-recovery-error', stage,
    sqlstate: /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : null }));
  console.error('Run D recovery fixture unconfirmed; raw error suppressed. Inspect fixed IDs before retry.');
  process.exit(1);
});
