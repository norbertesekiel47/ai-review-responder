// Scoped staging proof: the deployed poller recovers an exhausted dispatching
// row, then this process removes its six exact synthetic fixture rows.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ids = {
  account: '019f43d1-0000-7000-8000-000000000001',
  user: '019f43d1-0000-7000-8000-000000000002',
  location: '019f43d1-0000-7000-8000-000000000011',
  conversation: '019f43d1-0000-7000-8000-000000000031',
  turn: '019f43d1-0000-7000-8000-000000000032',
  clientKey: '019f43d1-0000-7000-8000-000000000033',
  outbox: '019f43d1-0000-7000-8000-000000000034',
};
const email = 'run-d-rollback-bd23d56e@e2e.repworth.net';
const importFromRoot = (path) => import(pathToFileURL(resolve(process.cwd(), path)).href);
let stage = 'target';
let seedAttempted = false;
let deadlineExpired = false;
let sql;
function requireCondition(value, message) { if (!value) throw new Error(message); }

async function remaining(db) {
  const [row] = await db`
    SELECT
      (SELECT count(*)::int FROM accounts WHERE id = ${ids.account}::uuid) AS accounts,
      (SELECT count(*)::int FROM users WHERE id = ${ids.user}::uuid) AS users,
      (SELECT count(*)::int FROM businesses WHERE id = ${ids.location}::uuid) AS businesses,
      (SELECT count(*)::int FROM agent_conversations WHERE id = ${ids.conversation}::uuid) AS conversations,
      (SELECT count(*)::int FROM agent_turns WHERE id = ${ids.turn}::uuid) AS turns,
      (SELECT count(*)::int FROM job_outbox WHERE id = ${ids.outbox}::uuid) AS outboxes
  `;
  return row;
}

async function cleanup() {
  if (!seedAttempted) return;
  stage = 'cleanup';
  // The seed COMMIT may have succeeded even if its acknowledgement was lost.
  // Own cleanup before sending it, then resolve the durable state explicitly.
  const initial = await remaining(sql);
  if (Object.values(initial).every((value) => value === 0)) {
    console.log(JSON.stringify({ kind: 'cleanup', captured_at: new Date().toISOString(), remaining: initial }));
    return;
  }
  requireCondition(Object.values(initial).every((value) => value === 1), 'Ambiguous fixture state requires inspection');
  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    const [owner] = await tx`
      SELECT a.id FROM accounts a JOIN users u ON u.account_id = a.id AND a.owner_user_id = u.id
      WHERE a.id = ${ids.account}::uuid AND u.id = ${ids.user}::uuid
        AND u.email = ${email} AND u.auth_id IS NULL
        AND a.display_name = 'Run D rollback recovery fixture'
      FOR UPDATE OF a, u
    `;
    requireCondition(owner, 'Fixture identity changed');
    const [unexpected] = await tx`
      SELECT
        (SELECT count(*)::int FROM agent_turns WHERE account_id = ${ids.account}::uuid AND id <> ${ids.turn}::uuid)
        + (SELECT count(*)::int FROM agent_conversations WHERE account_id = ${ids.account}::uuid AND id <> ${ids.conversation}::uuid)
        + (SELECT count(*)::int FROM businesses WHERE account_id = ${ids.account}::uuid AND id <> ${ids.location}::uuid)
        + (SELECT count(*)::int FROM users WHERE account_id = ${ids.account}::uuid AND id <> ${ids.user}::uuid)
        + (SELECT count(*)::int FROM agent_proposals WHERE account_id = ${ids.account}::uuid)
        + (SELECT count(*)::int FROM api_costs WHERE account_id = ${ids.account}::uuid)
        + (SELECT count(*)::int FROM agent_runs WHERE account_id = ${ids.account}::uuid)
        + (SELECT count(*)::int FROM job_outbox WHERE payload->>'account_id' = ${ids.account} AND id <> ${ids.outbox}::uuid)
        AS count
    `;
    requireCondition(unexpected.count === 0, 'Unexpected fixture activity requires inspection');
    const removed = [];
    removed.push(await tx`DELETE FROM job_outbox WHERE id = ${ids.outbox}::uuid AND aggregate_id = ${ids.turn}::uuid AND payload->>'account_id' = ${ids.account} RETURNING id`);
    removed.push(await tx`DELETE FROM agent_turns WHERE id = ${ids.turn}::uuid AND account_id = ${ids.account}::uuid RETURNING id`);
    removed.push(await tx`DELETE FROM agent_conversations WHERE id = ${ids.conversation}::uuid AND account_id = ${ids.account}::uuid RETURNING id`);
    removed.push(await tx`DELETE FROM businesses WHERE id = ${ids.location}::uuid AND account_id = ${ids.account}::uuid AND owner_email = ${email} RETURNING id`);
    removed.push(await tx`DELETE FROM accounts WHERE id = ${ids.account}::uuid AND owner_user_id = ${ids.user}::uuid RETURNING id`);
    removed.push(await tx`DELETE FROM users WHERE id = ${ids.user}::uuid AND account_id = ${ids.account}::uuid AND email = ${email} RETURNING id`);
    requireCondition(removed.every((rows) => rows.length === 1), 'Exact fixture cleanup count changed');
    await tx`SET CONSTRAINTS ALL IMMEDIATE`;
  });
  const counts = await remaining(sql);
  requireCondition(Object.values(counts).every((value) => value === 0), 'Fixture cleanup incomplete');
  console.log(JSON.stringify({ kind: 'cleanup', captured_at: new Date().toISOString(), remaining: counts }));
}

async function main() {
  const expected = process.env.RUN_D_RECOVERY_EXPECTED_SHA ?? '';
  requireCondition(/^[0-9a-f]{40}$/.test(expected) && process.env.RAILWAY_GIT_COMMIT_SHA === expected, 'Unconfirmed candidate');
  requireCondition(process.env.RAILWAY_PROJECT_ID === 'ad641d0e-dc01-4250-b71c-db1beedb9c8c'
    && process.env.RAILWAY_ENVIRONMENT_ID === '58c06358-8cbe-497f-bec0-df3b47769a10'
    && process.env.RAILWAY_SERVICE_ID === 'fb413c72-29b6-4cd1-90c2-26002491e301', 'Wrong staging service');
  const databaseUrl = new URL(process.env.DATABASE_POOL_URL);
  requireCondition(databaseUrl.hostname === 'db.kubdiqdhqbhwmqfditeg.supabase.co'
    || decodeURIComponent(databaseUrl.username) === 'postgres.kubdiqdhqbhwmqfditeg', 'Wrong database');
  requireCondition(process.env.OWNER_OPERATOR_ENABLED === 'true' && process.env.AUTO_APPROVAL_ENABLED !== 'true', 'Unexpected staging flags');
  ({ sql } = await importFromRoot('src/lib/db/server.ts'));
  const { enqueueAgentTurn } = await importFromRoot('src/lib/shared/job-outbox-helpers.ts');
  stage = 'preflight';
  const before = await remaining(sql);
  requireCondition(Object.values(before).every((value) => value === 0), 'Fixed fixture ids already exist');
  console.log(JSON.stringify({ kind: 'preflight', captured_at: new Date().toISOString(), candidate: expected, ids,
    before, auth_identity_created: false, provider_calls_requested: 0, observation_restarted: false }));
  stage = 'seed';
  requireCondition(!deadlineExpired, 'Deadline elapsed before seed');
  seedAttempted = true;
  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`INSERT INTO users (id, name, email, role, account_id)
      VALUES (${ids.user}::uuid, 'Run D recovery fixture', ${email}, 'owner', ${ids.account}::uuid)`;
    await tx`INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status)
      VALUES (${ids.account}::uuid, ${ids.user}::uuid, 'Run D rollback recovery fixture', 'copilot', 'active')`;
    // An archived synthetic location avoids unrelated location schedulers.
    await tx`INSERT INTO businesses (id, account_id, name, owner_name, owner_email, is_primary, archived_at)
      VALUES (${ids.location}::uuid, ${ids.account}::uuid, 'Run D recovery fixture', 'Run D fixture', ${email}, true, NOW())`;
    await tx`INSERT INTO agent_conversations (id, account_id, created_by_user_id, last_turn_at)
      VALUES (${ids.conversation}::uuid, ${ids.account}::uuid, ${ids.user}::uuid, NOW())`;
    await tx`INSERT INTO agent_turns (id, conversation_id, account_id, actor_user_id, location_id, client_turn_key, sequence, owner_text, status)
      VALUES (${ids.turn}::uuid, ${ids.conversation}::uuid, ${ids.account}::uuid, ${ids.user}::uuid,
        ${ids.location}::uuid, ${ids.clientKey}::uuid, 1, 'Synthetic rollback recovery fixture; no model work requested.', 'accepted')`;
    await enqueueAgentTurn(tx, { turnId: ids.turn, accountId: ids.account, conversationId: ids.conversation, outboxId: ids.outbox });
    const changed = await tx`UPDATE job_outbox SET status = 'dispatching', attempts = 5, max_attempts = 5,
      dispatched_at = NOW() - INTERVAL '3 minutes'
      WHERE id = ${ids.outbox}::uuid AND aggregate_id = ${ids.turn}::uuid AND status = 'pending'
        AND payload->>'account_id' = ${ids.account} RETURNING id`;
    requireCondition(changed.length === 1, 'Fixture outbox binding failed');
    requireCondition(!deadlineExpired, 'Deadline elapsed during seed');
    await tx`SET CONSTRAINTS ALL IMMEDIATE`;
  });
  requireCondition(!deadlineExpired, 'Deadline elapsed after seed');
  stage = 'observe_deployed_watchdog';
  const started = Date.now();
  let pair;
  do {
    [pair] = await sql`
      SELECT t.status AS turn_status, t.failure_reason, t.attempt_token,
        t.completed_at::text AS turn_completed_at, o.status AS outbox_status,
        o.attempts, o.last_error, o.completed_at::text AS outbox_completed_at
      FROM agent_turns t JOIN job_outbox o ON o.aggregate_id = t.id AND o.id = ${ids.outbox}::uuid
      WHERE t.id = ${ids.turn}::uuid AND t.account_id = ${ids.account}::uuid
    `;
    if (pair?.turn_status === 'failed' && pair?.outbox_status === 'failed') break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  } while (!deadlineExpired && Date.now() - started < 20_000);
  requireCondition(pair?.turn_status === 'failed' && pair.outbox_status === 'failed'
    && pair.failure_reason === 'dispatch_exhausted' && pair.attempt_token === null && pair.attempts === 5
    && pair.turn_completed_at !== null && pair.turn_completed_at === pair.outbox_completed_at
    && pair.last_error === 'Stale dispatching entry exceeded max_attempts', 'Deployed watchdog recovery unproven');
  console.log(JSON.stringify({ kind: 'result', captured_at: new Date().toISOString(), candidate: expected,
    synthetic_initial_state: 'accepted turn plus aged exhausted dispatching outbox',
    actual_dispatch_attempts: 0, observed_deployed_poller: true, elapsed_ms: Date.now() - started, pair }));
}

let failed = false;
const deadline = setTimeout(() => {
  // Never force-exit across a possibly committed seed or its cleanup. Existing
  // database timeouts bound active queries; the next continuation enters finally.
  deadlineExpired = true;
  failed = true;
  console.error('Run D recovery deadline elapsed; retaining cleanup ownership until the database operation settles.');
}, 60_000);
try { await main(); }
catch (error) {
  failed = true;
  console.log(JSON.stringify({ kind: 'error', stage, sqlstate: /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : null }));
} finally {
  try { await cleanup(); }
  catch (error) {
    failed = true;
    console.log(JSON.stringify({ kind: 'cleanup_error', sqlstate: /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : null }));
  }
  clearTimeout(deadline);
  await sql?.end({ timeout: 5 });
}
process.exit(failed ? 1 : 0);
