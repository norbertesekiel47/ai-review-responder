-- 120_owner_operator.sql
--
-- Owner Operator Run A — the conversational configuration surface's four
-- tables. Spec of record: docs/roadmap/2026-09-11-owner-operator/README.md §9.
-- Additive and re-runnable. It touches no existing table and adds no
-- job_outbox index.
--
-- WHAT A ROW IS
-- * agent_conversations — one owner conversation. The id is CLIENT-GENERATED
--   (spec §3.2): the browser mints it so a lost first response can be retried
--   against the same conversation. DOCUMENTED DEPARTURE from the repo's
--   uuidv7 convention, and the reason the route must treat an id that already
--   exists under ANOTHER account as a 404 rather than an upsert.
-- * agent_turns — one owner message and the single model reply it earns.
--   uuidv7, minted by the route. `attempt_token` is the fence: exactly one
--   dispatch's terminal write commits.
-- * agent_proposals — one catalog operation prepared for an explicit click.
--   NOTHING IN RUN A APPLIES ONE. No executor exists, no auto_approval_policies
--   row moves, nothing reaches Google (invariant #3).
-- * agent_unsupported_requests — what the owner asked for that RepWorth cannot
--   do. A separate relation, not a proposal with no button.
--
-- NO job_outbox INDEX, DELIBERATELY. Every in-flight unique index on
-- job_outbox is pinned to one literal topic (004/018 for sync_reviews, 030,
-- 091, 114). There is no generic (topic, aggregate_id) in-flight index, so
-- enqueueAgentTurn is a plain INSERT with no ON CONFLICT and needs no index
-- here. Turn idempotency is agent_turns_account_client_key_uniq below, taken
-- in the same transaction as the enqueue.
--
-- RLS POSTURE: deny-all on all four, zero policies, plus
-- REVOKE ALL ... FROM anon, authenticated. Load-bearing rather than a default:
-- agent_turns.owner_text is the owner's verbatim message and agent_proposals
-- carries full before/after settings state; the read path is a server route
-- scoped by account_id, never a client-side Supabase read. RLS filters ROWS,
-- not COLUMNS, so a client-readable policy could not withhold owner_text.
--
-- OFFBOARDING: all four are hard_delete / direct_account_id / must_be_absent.
-- NO CASCADE REACHES THEM FROM A PURGE: the account and businesses roots are
-- retain_deidentified and are never deleted, so the ON DELETE CASCADE columns
-- below are inert for offboarding. runContentPurgeStage deletes all four
-- explicitly, children first, in the same change as this file.
--
-- ONE TRANSACTION, load-bearing (116's reasoning verbatim): psql autocommits
-- each statement, so on a partial re-run a CREATE TABLE that succeeded
-- followed by a failing index or ALTER would leave a table without its indexes
-- or its RLS posture. SET LOCAL lock_timeout bounds lock acquisition.
--
-- LOCKSTEP: apply to STAGING first, then PRODUCTION at promotion, byte-
-- identical SQL. VERIFY BY INTROSPECTION, never the Supabase migration ledger
-- (it does not track RepWorth's 0xx migrations): pg_tables for the four
-- relations, pg_class.relrowsecurity = true, a pg_policies count of 0,
-- has_table_privilege('anon'|'authenticated', ..., 'SELECT') = false, and
-- pg_constraint for agent_turns_account_client_key_uniq and
-- agent_turns_conversation_sequence_uniq.

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS agent_conversations (
  id UUID PRIMARY KEY,                       -- client-generated (spec §3.2); NOT uuidv7 — documented departure
  account_id UUID NOT NULL REFERENCES accounts(id),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_turn_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS agent_turns (
  id UUID PRIMARY KEY,                       -- uuidv7 from the route
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  location_id UUID NOT NULL REFERENCES businesses(id),
  client_turn_key UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  owner_text TEXT NOT NULL,
  reply JSONB NULL,
  status TEXT NOT NULL DEFAULT 'accepted' CONSTRAINT agent_turns_status_check CHECK (status IN ('accepted','running','completed','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  attempt_token UUID NULL,
  claimed_at TIMESTAMPTZ NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  CONSTRAINT agent_turns_account_client_key_uniq UNIQUE (account_id, client_turn_key),
  CONSTRAINT agent_turns_conversation_sequence_uniq UNIQUE (conversation_id, sequence)
);

CREATE TABLE IF NOT EXISTS agent_proposals (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  turn_id UUID NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  location_id UUID NULL REFERENCES businesses(id),
  operation TEXT NOT NULL,
  contract_version INTEGER NOT NULL CHECK (contract_version >= 1),
  input JSONB NOT NULL,
  before JSONB NOT NULL,
  after JSONB NOT NULL,
  rationale TEXT NOT NULL,
  label_kind TEXT NOT NULL CONSTRAINT agent_proposals_label_kind_check CHECK (label_kind IN ('rule','fact')),
  prepared_version_token JSONB NOT NULL,
  requires_confirmation BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT agent_proposals_status_check CHECK (status IN ('pending','applied','stale','rejected','failed','superseded')),
  superseded_by UUID NULL REFERENCES agent_proposals(id),
  decided_by_user_id UUID NULL REFERENCES users(id),
  applied_at TIMESTAMPTZ NULL,
  receipt JSONB NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_unsupported_requests (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id),
  turn_id UUID NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  request TEXT NOT NULL,
  context TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The card read: every pending proposal for one conversation.
CREATE INDEX IF NOT EXISTS idx_agent_proposals_conversation_status
  ON agent_proposals (conversation_id, status);

-- "the actor's most recent conversation for this account" — the GET
-- /api/operator/conversation read with no id.
CREATE INDEX IF NOT EXISTS idx_agent_conversations_account_recent
  ON agent_conversations (account_id, created_by_user_id, last_turn_at DESC);

-- The offboarding purge's scope. agent_turns and agent_proposals are already
-- covered account-first by their unique constraints and the index above.
CREATE INDEX IF NOT EXISTS idx_agent_unsupported_requests_account
  ON agent_unsupported_requests (account_id);

COMMENT ON TABLE agent_conversations IS
  'Owner Operator conversation (Run A, spec docs/roadmap/2026-09-11-owner-operator/README.md §9). id is CLIENT-generated so a lost first response resumes the same conversation; a client id that already exists under another account is a 404, never an upsert. Deny-all RLS; read only through account-scoped server routes. Offboarding: hard_delete / direct_account_id / must_be_absent.';

COMMENT ON TABLE agent_turns IS
  'One Owner Operator turn: the owner message (owner_text, stored verbatim) and the single model reply (reply, an ordered segment array). location_id is frozen at POST so moving the location selector never retargets a turn. attempt_token is the completion fence — exactly one dispatch commits. Unique on (account_id, client_turn_key) for idempotent re-POST and on (conversation_id, sequence) for ordering. Deny-all RLS. Offboarding: hard_delete / direct_account_id / must_be_absent.';

COMMENT ON TABLE agent_proposals IS
  'One prepared Owner Operator change awaiting an explicit owner click. before/after carry the FULL effective state of the target scope, not only the named field. contract_version is the catalog operation version; prepared_version_token is settings freshness — two different questions, kept apart (spec §6.2). NOTHING IN RUN A APPLIES ONE: no executor exists and no auto_approval_policies row changes (invariant #3). Deny-all RLS. Offboarding: hard_delete / direct_account_id / must_be_absent.';

COMMENT ON TABLE agent_unsupported_requests IS
  'What an owner asked the Operator for that RepWorth cannot do, normalized, with its context. A distinct relation from agent_proposals so a renderer can never grow an Apply affordance onto one; the GET routes return the two under separate keys. Frequency alone does not decide the roadmap. Deny-all RLS. Offboarding: hard_delete / direct_account_id / must_be_absent.';

ALTER TABLE agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_unsupported_requests ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies on any of the four: deny-all. The server reaches
-- them through the RLS-bypassing postgres role only.
REVOKE ALL ON agent_conversations FROM anon, authenticated;
REVOKE ALL ON agent_turns FROM anon, authenticated;
REVOKE ALL ON agent_proposals FROM anon, authenticated;
REVOKE ALL ON agent_unsupported_requests FROM anon, authenticated;

COMMIT;
