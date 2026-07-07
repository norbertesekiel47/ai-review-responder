import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type postgres from 'postgres';
import { requireRole, AuthError } from '@/lib/db/auth';
import { recoverCorrelationId } from '@/lib/approval/correlation';
import { getDeviceCookieHash, validateCsrf, verifyDeviceCookie } from '@/lib/approval/cookies';
import { EmptyEditedResponseError, ResponseNotPendingError } from '@/lib/approval/errors';
import { hasOpenFlag, HeldForReviewError } from '@/lib/moderation/held-draft';
import { handleApprovalError } from '@/lib/approval/http-errors';
import { verifyDevice } from '@/lib/approval/locks';
import { lockValidLink } from '@/lib/approval/service';
import type { ApprovalLink, AuditContext, SessionAuditContext } from '@/lib/approval/types';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { getRequestIp } from '@/lib/shared/request-ip';
import {
  assertWritableSubscriptionForAccount,
  assertWritableSubscriptionForBusiness,
  SubscriptionReadOnlyError,
  throwIfReadOnly,
} from '@/lib/shared/writable-subscription';

type TxClient = postgres.TransactionSql;
type Sql = postgres.Sql;

type TokenActionName = 'approve' | 'edit' | 'regenerate' | 'session';

interface TokenActionContext<TPrepared = undefined> {
  tx: TxClient;
  link: ApprovalLink;
  deviceCookieHash: string;
  audit: AuditContext;
  correlationId: string;
  prepared: TPrepared;
}

interface TokenActionOptions<TPrepared> {
  requireVerifiedDeviceCookie?: boolean;
  recoverResponseCorrelation?: boolean;
  prepare?: () => Promise<TPrepared | NextResponse> | TPrepared | NextResponse;
}

export async function runTokenApprovalAction<TPrepared = undefined>(
  sql: Sql,
  request: NextRequest,
  rawToken: string,
  actionName: TokenActionName,
  successBody: Record<string, unknown>,
  action: (ctx: TokenActionContext<TPrepared>) => Promise<void>,
  options: TokenActionOptions<TPrepared> = {},
): Promise<NextResponse> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const rateCheck = await checkRateLimit(`approve:post:${tokenHash}`, 3, 60);
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: NO_STORE_HEADERS });
  }

  if (!validateCsrf(request)) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403, headers: NO_STORE_HEADERS });
  }

  if (options.requireVerifiedDeviceCookie !== false && !verifyDeviceCookie(request)) {
    return NextResponse.json({ error: 'Invalid device cookie' }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const deviceCookieHash = getDeviceCookieHash(request);
  if (!deviceCookieHash) {
    return NextResponse.json({ error: 'Device cookie missing' }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const prepared = options.prepare ? await options.prepare() : undefined as TPrepared;
  if (prepared instanceof NextResponse) {
    return prepared;
  }

  const ip = getRequestIp(request);

  try {
    await sql.begin(async (tx) => {
      const link = await lockValidLink(tx, rawToken);
      if (options.requireVerifiedDeviceCookie !== false) {
        verifyDevice(link, deviceCookieHash);
      }
      throwIfReadOnly(await assertWritableSubscriptionForBusiness(link.business_id, tx));

      const audit: AuditContext = { tokenHash: link.token_hash, deviceCookieHash, ipAddress: ip };
      const correlationId = options.recoverResponseCorrelation === false
        ? link.response_id
        : await recoverLinkCorrelationId(tx, link);

      await action({
        tx,
        link,
        deviceCookieHash,
        audit,
        correlationId,
        prepared: prepared as TPrepared,
      });
    });
  } catch (err) {
    return handleApprovalError(err, actionName);
  }

  return NextResponse.json(successBody, { status: 200, headers: NO_STORE_HEADERS });
}

async function recoverLinkCorrelationId(
  tx: TxClient,
  link: ApprovalLink,
): Promise<string> {
  const [response] = await tx<{ review_id: string }[]>`
    SELECT review_id FROM responses WHERE id = ${link.response_id}
  `;
  return response
    ? await recoverCorrelationId(tx, { reviewId: response.review_id, responseId: link.response_id })
    : link.response_id;
}

interface DashboardOwner {
  id: string;
  accountId: string;
}

interface DashboardReviewActionContext {
  tx: TxClient;
  responseId: string;
  businessId: string;
  audit: SessionAuditContext;
  correlationId: string;
}

export async function requireDashboardReviewOwner(
  request: NextRequest,
): Promise<DashboardOwner | NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
  }

  if (!user.accountId) {
    return NextResponse.json({ error: 'No account associated with this user' }, { status: 403, headers: NO_STORE_HEADERS });
  }

  return { id: user.id, accountId: user.accountId };
}

export async function runDashboardReviewAction(
  sql: Sql,
  request: NextRequest,
  reviewId: string,
  owner: DashboardOwner,
  actionName: 'approve' | 'edit' | 'regenerate',
  successMessage: string,
  action: (ctx: DashboardReviewActionContext) => Promise<void>,
): Promise<NextResponse> {
  const rows = await sql`
    SELECT r.id, r.business_id, r.status
    FROM responses r
    JOIN reviews rv ON rv.id = r.review_id
    JOIN businesses b ON b.id = rv.business_id
    WHERE rv.id = ${reviewId}
      AND b.account_id = ${owner.accountId}::uuid
      AND b.archived_at IS NULL
      AND r.status NOT IN ('superseded', 'failed') -- status-audit-ignore: state-transition approval guard subset, intentionally inline per response-status.ts header; review-status-ignore: responses.status, not reviews.status (the reviews-status guard's r alias-allowlist assumes r is always the reviews alias, but here r is responses)
    ORDER BY r.version DESC LIMIT 1
  `;

  const response = rows[0];
  if (!response) {
    return NextResponse.json({ error: 'No actionable response found for this review' }, { status: 404, headers: NO_STORE_HEADERS });
  }

  const writable = await assertWritableSubscriptionForAccount(owner.accountId, sql);
  if (!writable.ok) {
    return NextResponse.json(
      { error: writable.error },
      { status: writable.status, headers: NO_STORE_HEADERS },
    );
  }

  const ip = getRequestIp(request);
  const audit: SessionAuditContext = { actorUserId: owner.id, ipAddress: ip };

  try {
    await sql.begin(async (tx) => {
      // Lock the candidate response, then refuse to release it while a
      // high-severity moderation flag is open. The lock serializes this check
      // against the admin disposition that closes the flag.
      await tx`SELECT id FROM responses WHERE id = ${response.id as string}::uuid AND business_id = ${response.business_id as string}::uuid FOR UPDATE`;
      if (await hasOpenFlag(tx, response.id as string)) {
        throw new HeldForReviewError();
      }

      // Re-assert the writable/offboarding gate INSIDE the locked tx (TOCTOU): the
      // pre-tx check above can go stale if an offboarding is confirmed between it
      // and this commit. Token + callback approval paths re-check the same way.
      throwIfReadOnly(await assertWritableSubscriptionForBusiness(response.business_id as string, tx));

      // The archived-location gate runs inside the action's
      // lockPendingResponse claim (locks.ts) — same TOCTOU protection as the
      // pre-tx `b.archived_at IS NULL` filter above going stale, owned by the
      // claim primitive for every lane.
      const correlationId = await recoverCorrelationId(tx, {
        reviewId,
        responseId: response.id as string,
      });
      await action({
        tx,
        responseId: response.id as string,
        businessId: response.business_id as string,
        audit,
        correlationId,
      });
    });

    return NextResponse.json(
      { success: true, message: successMessage },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    if (err instanceof EmptyEditedResponseError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (err instanceof ResponseNotPendingError) {
      return NextResponse.json({ error: err.message }, { status: 409, headers: NO_STORE_HEADERS });
    }
    if (err instanceof HeldForReviewError) {
      return NextResponse.json({ error: err.message }, { status: 409, headers: NO_STORE_HEADERS });
    }
    if (err instanceof SubscriptionReadOnlyError) {
      return NextResponse.json({ error: err.error }, { status: err.status, headers: NO_STORE_HEADERS });
    }
    console.error(`[api/dashboard/reviews/${actionName}] Unexpected error:`, err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
