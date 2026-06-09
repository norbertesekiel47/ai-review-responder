import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { accountOffboardingEnabled } from '@/lib/account-offboarding/flags';
import {
  keepMyDataForAccount,
  keepMyDataWithToken,
  type KeepMyDataResult,
} from '@/lib/account-offboarding/keep-my-data';
import {
  jsonResponse,
  requireOwnerWithAccount,
  withSameOrigin,
} from '@/lib/auth/route-helpers';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { escapeHtml } from '@/lib/shared/html';

export const dynamic = 'force-dynamic';

const TokenBodySchema = z.strictObject({
  token: z.string().trim().min(1).max(2000),
});

const AuthenticatedBodySchema = z.strictObject({});

async function keepMyData(req: NextRequest): Promise<NextResponse> {
  if (!accountOffboardingEnabled()) {
    return jsonResponse({ error: 'account_offboarding_disabled' }, 404);
  }

  const body = await parseRequestBody(req);
  if (!body.ok) return jsonResponse({ error: body.error }, 400);

  const tokenBody = TokenBodySchema.safeParse(body.value);
  if (tokenBody.success) {
    return resultResponse(await keepMyDataWithToken({
      rawToken: tokenBody.data.token,
      requestId: req.headers.get('x-request-id') ?? uuidv7(),
      ip: clientIp(req),
      userAgent: req.headers.get('user-agent'),
    }));
  }

  const authBody = AuthenticatedBodySchema.safeParse(body.value);
  if (!authBody.success) {
    return jsonResponse({ error: 'invalid_body', issues: authBody.error.issues }, 400);
  }

  const owner = await requireOwnerWithAccount(req);
  if (!owner.ok) return owner.response;

  const idempotencyKey = parseIdempotencyKey(req.headers.get('Idempotency-Key'));
  if (!idempotencyKey.ok) {
    return jsonResponse({ error: idempotencyKey.error }, 400);
  }

  return resultResponse(await keepMyDataForAccount({
    accountId: owner.accountId,
    actorUserId: owner.user.id,
    idempotencyKey: idempotencyKey.value,
    requestId: req.headers.get('x-request-id') ?? uuidv7(),
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  }));
}

function keepMyDataForm(req: NextRequest): NextResponse {
  if (!accountOffboardingEnabled()) {
    return new NextResponse('Not found', { status: 404, headers: NO_STORE_HEADERS });
  }

  const token = req.nextUrl.searchParams.get('token')?.trim();
  if (!token || token.length > 2000) {
    return new NextResponse('Invalid keep-my-data link.', {
      status: 400,
      headers: htmlHeaders(),
    });
  }

  return new NextResponse(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Keep RepWorth data</title>
</head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;color:#111827;">
  <main style="max-width:520px;margin:12vh auto;padding:0 24px;">
    <h1 style="font-size:24px;line-height:1.2;margin:0 0 12px;">Keep RepWorth data?</h1>
    <p style="font-size:15px;line-height:1.5;color:#374151;margin:0 0 20px;">This cancels the scheduled data deletion. It does not restore product access.</p>
    <form method="post" action="/api/account/offboarding/keep-my-data">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button type="submit" style="border:0;border-radius:6px;background:#111827;color:#fff;padding:12px 18px;font-size:14px;font-weight:600;cursor:pointer;">Keep my data</button>
    </form>
  </main>
</body>
</html>`, {
    status: 200,
    headers: htmlHeaders(),
  });
}

type ParsedBody =
  | { ok: true; value: unknown }
  | { ok: false; error: 'invalid_json' | 'invalid_form' };

async function parseRequestBody(req: NextRequest): Promise<ParsedBody> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return { ok: true, value: await req.json() };
    } catch {
      return { ok: false, error: 'invalid_json' };
    }
  }

  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    try {
      const form = await req.formData();
      const body: Record<string, string> = {};
      for (const [key, value] of form.entries()) {
        if (typeof value !== 'string') return { ok: false, error: 'invalid_form' };
        body[key] = value;
      }
      return { ok: true, value: body };
    } catch {
      return { ok: false, error: 'invalid_form' };
    }
  }

  return { ok: true, value: {} };
}

function resultResponse(result: KeepMyDataResult): NextResponse {
  if (!result.ok) {
    const status = result.reason === 'not_available'
      ? 409
      : result.reason === 'token_invalid'
        ? 400
        : 410;
    return jsonResponse({ error: result.reason }, status);
  }

  return jsonResponse({
    ok: true,
    offboarding: {
      id: result.offboarding.id,
      mode: result.offboarding.mode,
      status: result.offboarding.status,
    },
  });
}

type IdempotencyKeyParseResult =
  | { ok: true; value: string }
  | { ok: false; error: 'missing_idempotency_key' | 'idempotency_key_too_long' };

function parseIdempotencyKey(raw: string | null): IdempotencyKeyParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, error: 'missing_idempotency_key' };
  }
  const source = raw.trim();
  if (source.length > 255) {
    return { ok: false, error: 'idempotency_key_too_long' };
  }
  return { ok: true, value: source };
}

function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  return forwarded.split(',')[0]?.trim() || null;
}

function htmlHeaders(): HeadersInit {
  return {
    ...NO_STORE_HEADERS,
    'content-type': 'text/html; charset=utf-8',
  };
}

export const POST = withSameOrigin()(keepMyData);
export const GET = keepMyDataForm;
