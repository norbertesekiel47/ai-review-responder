import { NextRequest, NextResponse } from 'next/server';
import { OnboardBusinessSchema } from '@/lib/shared/schemas';
import { sql, supabaseServer } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isPlaceId, extractPlaceId } from '@/lib/reviews/url-parser';
import {
  createBusinessTx,
  DuplicateEmailError,
  type AdminBusinessTxInput,
  type PlaceIdInput,
} from '@/lib/onboarding/create-business';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/admin/businesses — paginated business list
// ---------------------------------------------------------------------------

interface BusinessListRow {
  id: string;
  name: string;
  category: string | null;
  subscription_status: string;
  last_sync_at: Date | null;
  pending_count: number;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limit = Math.min(
      Math.max(parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10) || 20, 1),
      100,
    );
    const offset = Math.max(
      parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0,
      0,
    );

    const [businessRows, countRows] = await Promise.all([
      sql<BusinessListRow[]>`
        SELECT
          b.id,
          b.name,
          b.category,
          b.subscription_status,
          b.last_sync_at,
          COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_count
        FROM businesses b
        LEFT JOIN responses resp
          ON resp.business_id = b.id AND resp.status != 'superseded'
        GROUP BY b.id
        ORDER BY b.name ASC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM businesses`,
    ]);

    return NextResponse.json({
      businesses: businessRows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category ?? null,
        subscriptionStatus: row.subscription_status,
        lastSyncAt: row.last_sync_at ? row.last_sync_at.toISOString() : null,
        pendingCount: row.pending_count,
      })),
      total: countRows[0]?.total ?? 0,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[api/admin/businesses GET] Failed to fetch businesses:', error);
    return NextResponse.json(
      { error: 'Failed to fetch businesses' },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/admin/businesses — onboard a new business
// ---------------------------------------------------------------------------

function splitCommaOrNewline(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitParagraphs(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let authUser;
  try {
    authUser = await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = OnboardBusinessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const data = parsed.data;

  let placeId: string | null = null;
  let placeIdVerified = false;

  if (data.googlePlaceId) {
    // Autocomplete path — validate format server-side
    if (!isPlaceId(data.googlePlaceId)) {
      return NextResponse.json({ error: 'Invalid Place ID format' }, { status: 400 });
    }
    placeId = data.googlePlaceId;
    placeIdVerified = true;
  } else if (data.googleMapsUrl) {
    // URL fallback — extract what we can, validation happens in worker
    placeId = extractPlaceId(data.googleMapsUrl);
    // placeId may be hex CID or null — that's OK, worker will resolve it
    placeIdVerified = false;
  } else {
    return NextResponse.json({ error: 'Place ID or Google Maps URL required' }, { status: 400 });
  }

  const placeIdInput: PlaceIdInput = placeIdVerified && placeId
    ? { placeIdVerified: true, placeId, googleMapsUrl: data.googleMapsUrl ?? null }
    : { placeIdVerified: false, placeId: placeId ?? null, googleMapsUrl: data.googleMapsUrl! };

  const input: AdminBusinessTxInput = {
    ownerEmail: data.ownerEmail,
    ownerName: data.ownerName,
    ownerPhone: data.ownerPhone ?? null,
    businessName: data.name,
    category: data.category ?? null,
    tone: data.tone,
    productsServices: data.productsServices ?? null,
    staffNames: splitCommaOrNewline(data.staffNames),
    highlightFacts: splitCommaOrNewline(data.highlightFacts),
    avoidFacts: splitCommaOrNewline(data.avoidFacts),
    sampleResponses: splitParagraphs(data.sampleResponses),
    subscriptionTier: data.subscriptionTier,
    website: data.website ?? null,
    placeId: placeIdInput,
  };

  // Validate config BEFORE writing any DB rows. The invite step depends on
  // NEXT_PUBLIC_APP_URL to construct the redirectTo; if it's missing,
  // returning 500 after createBusinessTx already committed leaves a
  // half-provisioned business + auth-less users row that the admin can't
  // easily clean up (and our cleanup poller doesn't touch admin-onboarded
  // rows because their `onboarded_by` is non-null). Fail-fast here.
  const ownerEmailLower = data.ownerEmail.trim().toLowerCase();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    console.error(
      '[api/admin/businesses POST] NEXT_PUBLIC_APP_URL not set — cannot build invite redirectTo',
    );
    return NextResponse.json(
      { error: 'Server misconfigured (missing APP_URL)' },
      { status: 500 },
    );
  }
  const inviteRedirectTo = `${appUrl}/api/auth/callback?flow=owner&next=/reset-password`;

  let createdResult: Awaited<ReturnType<typeof createBusinessTx>>;
  try {
    createdResult = await createBusinessTx(input, {
      mode: 'admin',
      onboardedBy: authUser.id,
    });
  } catch (err) {
    if (err instanceof DuplicateEmailError) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 409 },
      );
    }
    console.error('[api/admin/businesses POST] createBusinessTx failed:', err);
    return NextResponse.json({ error: 'Failed to onboard business' }, { status: 500 });
  }

  // Owner provisioning. Without this step the admin-created users row has
  // auth_id = NULL → no Supabase Auth identity → owner can't log in, can't
  // reset password (Supabase silently no-ops on missing auth.users row),
  // and can't sign up either (our /api/auth/signup pre-check finds the
  // existing public.users row by email and returns 409 account_exists).
  //
  // inviteUserByEmail creates the auth.users row WITHOUT a password, marks
  // the email confirmed, and emails the owner an invite link. The link
  // routes through /api/auth/callback?next=/reset-password so the owner
  // sets their initial password on arrival, lands at /dashboard with a
  // valid session. Supabase's "Invite user" email template controls the
  // copy — make sure it points at:
  //   {{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=invite&flow=owner&next=/reset-password

  const { data: invited, error: inviteErr } =
    await supabaseServer.auth.admin.inviteUserByEmail(ownerEmailLower, {
      redirectTo: inviteRedirectTo,
    });

  if (inviteErr || !invited?.user) {
    // Compensating cleanup — the owner can never log in without an auth
    // user, so a half-provisioned business is worse than nothing.
    // FK-aware delete order: users first (no cascade from businesses),
    // then businesses + dependents via CASCADE on the businesses row.
    console.error(
      `[api/admin/businesses POST] inviteUserByEmail failed for ${ownerEmailLower}:`,
      inviteErr?.message ?? 'no user returned',
    );
    try {
      // Wrap rollback in a transaction so all 3 deletes succeed-or-fail
      // together. Order matters:
      //   1. job_outbox first — no FK CASCADE from businesses to job_outbox
      //      (aggregate_id is just a UUID, not a foreign key — see migration
      //      001 line 301), so leaving these rows in place would orphan
      //      pending jobs that the OutboxPoller would then dispatch into
      //      a void (no business_id to look up).
      //   2. users next — users.business_id is a FK to businesses.id without
      //      CASCADE so users must be deleted before businesses.
      //   3. businesses last — channel_enrollments cascade-deletes via
      //      businesses.id ON DELETE CASCADE.
      await sql.begin(async (tx) => {
        await tx`DELETE FROM job_outbox WHERE aggregate_id = ${createdResult.businessId}::uuid`;
        await tx`DELETE FROM users WHERE id = ${createdResult.userId}::uuid`;
        await tx`DELETE FROM businesses WHERE id = ${createdResult.businessId}::uuid`;
      });
    } catch (rollbackErr) {
      console.error(
        '[api/admin/businesses POST] Compensating rollback failed:',
        rollbackErr,
      );
    }
    return NextResponse.json(
      {
        error:
          'Could not send owner invite email. Business was not created — check Supabase Auth settings (SMTP, rate limits) and try again.',
      },
      { status: 500 },
    );
  }

  // Link the auth identity to our users row. The createBusinessTx admin
  // contract still writes auth_id=NULL on insert; we patch it here so the
  // /api/auth/callback role lookup (which keys on auth_id) finds the row
  // when the owner clicks the invite link.
  //
  // Hard-fail if either the UPDATE throws OR matches 0 rows. Soft-warning
  // is too lenient: the caller (admin/businesses/new client) used to ignore
  // the warning and redirect to Stripe anyway, leaving the admin under the
  // impression onboarding worked while the owner is invisibly locked out.
  // Rollback the business + invite atomically so the admin can retry from
  // a clean slate.
  let linked = false;
  try {
    const updated = await sql<{ id: string }[]>`
      UPDATE users
      SET auth_id = ${invited.user.id}, updated_at = NOW()
      WHERE id = ${createdResult.userId}::uuid
        AND auth_id IS NULL
      RETURNING id
    `;
    linked = updated.length > 0;
  } catch (linkErr) {
    console.error(
      `[api/admin/businesses POST] Failed to link auth_id ${invited.user.id} to users.${createdResult.userId}:`,
      linkErr,
    );
  }
  if (!linked) {
    console.error(
      `[api/admin/businesses POST] auth_id link UPDATE matched 0 rows for users.${createdResult.userId} — rolling back business + invited auth user`,
    );
    // Best-effort rollback: delete the auth user we just invited, then the
    // DB rows. Errors here only get logged — the route's final 500 is the
    // load-bearing signal regardless of cleanup outcome.
    try {
      await supabaseServer.auth.admin.deleteUser(invited.user.id);
    } catch (deleteErr) {
      console.error(
        `[api/admin/businesses POST] Failed to delete invited auth user ${invited.user.id} during link-failure rollback:`,
        deleteErr,
      );
    }
    try {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM job_outbox WHERE aggregate_id = ${createdResult.businessId}::uuid`;
        await tx`DELETE FROM users WHERE id = ${createdResult.userId}::uuid`;
        await tx`DELETE FROM businesses WHERE id = ${createdResult.businessId}::uuid`;
      });
    } catch (rollbackErr) {
      console.error(
        '[api/admin/businesses POST] DB rollback after auth_id link failure threw:',
        rollbackErr,
      );
    }
    return NextResponse.json(
      {
        error:
          'Could not link the invited owner to the business record. The business was rolled back — try again, and if this persists check users.auth_id constraints.',
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { id: createdResult.businessId, paymentUrl: createdResult.paymentUrl },
    { status: 201 },
  );
}
