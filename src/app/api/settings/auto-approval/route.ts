import { NextRequest, NextResponse } from 'next/server';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/admin/impersonation/cookie';
import { getOffboardingState, isOperationalUIBlocked } from '@/lib/account-offboarding/gate';
import { jsonResponse, requireOwnerWithAccount, withSameOrigin } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  AutoApprovalConfirmationRequiredError,
  AutoApprovalExpansionBlockedError,
  AutoApprovalSettingsError,
  getAutoApprovalSettings,
  patchAutoApprovalSettings,
} from '@/lib/auto-approval/settings';
import { AutoApprovalPatchSchema, type AutoApprovalPatchRequest } from '@/lib/auto-approval/types';

export const dynamic = 'force-dynamic';

type OwnerWithAccountResult = Awaited<ReturnType<typeof requireOwnerWithAccount>>;
type OwnerWithAccount = Extract<OwnerWithAccountResult, { ok: true }>;
type SettingsOwnerResult = OwnerWithAccount | { ok: false; response: NextResponse };
type ParsedPatchBody =
  | { ok: true; body: AutoApprovalPatchRequest }
  | { ok: false; response: NextResponse };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireSettingsOwner(request);
  if (!owner.ok) return owner.response;

  try {
    const state = await getAutoApprovalSettings({
      accountId: owner.accountId,
      impersonated: hasImpersonationCookie(request),
    });
    return jsonResponse(state);
  } catch (error) {
    reportCaughtError('api/settings/auto-approval GET', error, { accountId: owner.accountId });
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

async function patchSettings(request: NextRequest): Promise<NextResponse> {
  const owner = await requireSettingsOwner(request);
  if (!owner.ok) return owner.response;

  if (hasImpersonationCookie(request)) {
    return jsonResponse(
      {
        error: 'auto_approval_expansion_blocked',
        blockReasons: ['impersonation_not_allowed'],
      },
      409,
    );
  }

  const parsed = await parsePatchBody(request);
  if (!parsed.ok) return parsed.response;

  try {
    const state = await patchAutoApprovalSettings({
      ...parsed.body,
      accountId: owner.accountId,
      actorUserId: owner.user.id,
      impersonated: false,
      ...requestMetadata(request),
    });
    return jsonResponse(state);
  } catch (error) {
    const mapped = autoApprovalErrorResponse(error);
    if (mapped) return mapped;

    reportCaughtError('api/settings/auto-approval PATCH', error, { accountId: owner.accountId });
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

async function requireSettingsOwner(request: NextRequest): Promise<SettingsOwnerResult> {
  if (request.nextUrl.searchParams.has('accountId')) {
    return { ok: false, response: jsonResponse({ error: 'account_id_not_allowed' }, 400) };
  }
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner;

  const offboardingState = await getOffboardingState(owner.accountId);
  if (isOperationalUIBlocked(offboardingState)) {
    return { ok: false, response: jsonResponse({ error: 'account_offboarding_blocked' }, 403) };
  }

  return owner;
}

async function parsePatchBody(request: NextRequest): Promise<ParsedPatchBody> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { ok: false, response: jsonResponse({ error: 'invalid_body' }, 400) };
  }

  const parsed = AutoApprovalPatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    const error = parsed.error.issues[0]?.message ?? 'invalid_request';
    return { ok: false, response: jsonResponse({ error }, 400) };
  }

  return { ok: true, body: parsed.data };
}

function autoApprovalErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof AutoApprovalConfirmationRequiredError) {
    return jsonResponse(
      {
        error: 'auto_approval_confirmation_required',
        confirmationLevel: error.confirmationLevel,
      },
      400,
    );
  }
  if (error instanceof AutoApprovalExpansionBlockedError) {
    return jsonResponse(
      {
        error: 'auto_approval_expansion_blocked',
        blockReasons: error.blockReasons,
      },
      409,
    );
  }
  if (error instanceof AutoApprovalSettingsError) {
    return jsonResponse({ error: error.code }, error.status);
  }
  return null;
}

function hasImpersonationCookie(request: NextRequest): boolean {
  return Boolean(request.cookies.get(IMPERSONATION_COOKIE_NAME)?.value);
}

function requestMetadata(request: NextRequest) {
  return {
    ip: requestIp(request),
    userAgent: request.headers.get('user-agent'),
    requestId: request.headers.get('x-request-id') ?? request.headers.get('x-vercel-id'),
  };
}

function requestIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || null;
  }
  return request.headers.get('x-real-ip');
}

export const PATCH = withSameOrigin()(patchSettings);
