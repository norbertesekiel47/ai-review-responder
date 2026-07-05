import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';
import { writeAccountAuditLog } from '@/lib/audit/log';

const SESSION_TTL_MS = 60 * 60 * 1000;

export class ImpersonationStartError extends Error {
  constructor(readonly code: string = 'active_session_exists') {
    super(code);
    this.name = 'ImpersonationStartError';
  }
}

export interface StartImpersonationSessionInput {
  actorUserId: string;
  impersonatedUserId: string;
  accountId: string;
  ticketId: string;
  reason: string;
}

export interface ActiveImpersonationSession {
  id: string;
  actorUserId: string;
  impersonatedUserId: string;
  accountId: string;
  ticketId: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  impersonatedEmail: string | null;
  accountDisplayName: string | null;
}

export async function startImpersonationSession(
  sql: Sql,
  input: StartImpersonationSessionInput,
): Promise<{ sessionId: string; expiresAt: Date }> {
  const sessionId = uuidv7();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await sql.begin(async (tx) => {
    // Reap expired-but-unended sessions for this actor first. Nothing else ends a
    // session on TTL expiry (the /end route needs the now-evicted cookie), so
    // without this a lapsed session would permanently block new starts via the
    // ended_at-only pre-check and partial UNIQUE index.
    await tx`
      UPDATE impersonation_sessions
      SET ended_at = expires_at
      WHERE actor_user_id = ${input.actorUserId}::uuid
        AND ended_at IS NULL
        AND expires_at <= NOW()
    `;

    // One active session per actor. The partial UNIQUE index (migration 048) is
    // the hard backstop; this FOR UPDATE pre-check returns a clean typed error
    // instead of a raw constraint violation.
    const existing = await tx<{ id: string }[]>`
      SELECT id
      FROM impersonation_sessions
      WHERE actor_user_id = ${input.actorUserId}::uuid
        AND ended_at IS NULL
      LIMIT 1
      FOR UPDATE
    `;
    if (existing.length > 0) {
      throw new ImpersonationStartError('active_session_exists');
    }

    await tx`
      INSERT INTO impersonation_sessions (
        id,
        actor_user_id,
        impersonated_user_id,
        account_id,
        ticket_id,
        reason,
        expires_at
      ) VALUES (
        ${sessionId}::uuid,
        ${input.actorUserId}::uuid,
        ${input.impersonatedUserId}::uuid,
        ${input.accountId}::uuid,
        ${input.ticketId},
        ${input.reason},
        ${expiresAt}
      )
    `;

    await writeAccountAuditLog(
      {
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        eventType: 'impersonation_started',
        entityType: 'user',
        entityId: input.impersonatedUserId,
        payload: {
          ticket_id: input.ticketId,
          reason: input.reason,
          expires_at: expiresAt.toISOString(),
        },
      },
      tx,
    );
  });

  return { sessionId, expiresAt };
}

export async function endImpersonationSession(
  sql: Sql,
  input: {
    sessionId: string;
    actorUserId: string;
  },
): Promise<{ ended: boolean }> {
  const ended = await sql.begin(async (tx) => {
    const rows = await tx<{ account_id: string; impersonated_user_id: string }[]>`
      UPDATE impersonation_sessions
      SET ended_at = NOW()
      WHERE id = ${input.sessionId}::uuid
        AND actor_user_id = ${input.actorUserId}::uuid
        AND ended_at IS NULL
      RETURNING account_id, impersonated_user_id
    `;
    const row = rows[0];
    if (!row) return false;

    await writeAccountAuditLog(
      {
        accountId: row.account_id,
        actorUserId: input.actorUserId,
        eventType: 'impersonation_ended',
        entityType: 'user',
        entityId: row.impersonated_user_id,
        payload: { session_id: input.sessionId },
      },
      tx,
    );
    return true;
  });

  return { ended };
}

export async function loadActiveImpersonationSession(
  sql: Sql,
  input: {
    sessionId: string;
    actorUserId: string;
    now?: Date;
  },
): Promise<ActiveImpersonationSession | null> {
  const rows = await sql<{
    id: string;
    actor_user_id: string;
    impersonated_user_id: string;
    account_id: string;
    ticket_id: string;
    reason: string;
    started_at: Date;
    expires_at: Date;
    impersonated_email: string | null;
    account_display_name: string | null;
  }[]>`
    SELECT
      s.id,
      s.actor_user_id,
      s.impersonated_user_id,
      s.account_id,
      s.ticket_id,
      s.reason,
      s.started_at,
      s.expires_at,
      u.email AS impersonated_email,
      a.display_name AS account_display_name
    FROM impersonation_sessions s
    JOIN users u ON u.id = s.impersonated_user_id
    JOIN accounts a ON a.id = s.account_id
    WHERE s.id = ${input.sessionId}::uuid
      AND s.actor_user_id = ${input.actorUserId}::uuid
      AND s.ended_at IS NULL
      AND s.expires_at > ${input.now ?? new Date()}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    impersonatedUserId: row.impersonated_user_id,
    accountId: row.account_id,
    ticketId: row.ticket_id,
    reason: row.reason,
    startedAt: new Date(row.started_at),
    expiresAt: new Date(row.expires_at),
    impersonatedEmail: row.impersonated_email,
    accountDisplayName: row.account_display_name,
  };
}
