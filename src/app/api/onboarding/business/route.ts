import { NextRequest, NextResponse } from 'next/server';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { createServerClient } from '@supabase/ssr';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import {
  BusinessOnboardingSchema,
  BusinessOnboardingPostPaySchema,
  type BusinessOnboardingInput,
  type BusinessOnboardingPostPayInput,
} from '@/lib/shared/schemas';
import { extractPlaceId } from '@/lib/reviews/url-parser';
import type { ValidatePlaceIdPayload } from '@/lib/shared/worker-types';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { PLACEHOLDER_BUSINESS_NAME } from '@/lib/onboarding/create-business';
import { enqueueValidatePlaceId } from '@/lib/shared/job-outbox-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

// ── Local helpers (intentionally duplicated from src/app/api/admin/businesses/route.ts
//    for isolation — small, isolated string utilities) ───────────────────

function splitCommaOrNewline(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text.split(/\n|,/).flatMap((s) => {
    const trimmed = s.trim();
    return trimmed ? [trimmed] : [];
  });
}

function splitParagraphs(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text.split(/\n\n+/).flatMap((s) => {
    const trimmed = s.trim();
    return trimmed ? [trimmed] : [];
  });
}

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

interface BusinessRow {
  id: string;
  account_id: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

// Subset for the FOR UPDATE re-read inside the transaction.
// subscription_status is NOT re-checked inside the tx — the outer query
// already gates on it.
interface ForUpdateRow {
  id: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Feature flag — hide the route entirely when off.
  if (!selfServeSignupEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  // 2. Same-origin check. CSRF here would weaponize the owner's Supabase
  //    cookie to fill a placeholder business with attacker-controlled
  //    Place ID / business name / sample responses.
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    throw err;
  }

  // 3. Read session via cookie-bound anon client. setAll is a no-op — no
  //    cookie refresh on this write endpoint.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only.
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // 4. Look up the business owned by this auth user. Service-role sql
  //    enforces the auth_id scope in the WHERE clause (no RLS on businesses).
  //
  //    Defense-in-depth: explicit `u.role = 'owner'` filter. Proxy gates
  //    /onboarding/* PAGES on role, but proxy doesn't check `/api/onboarding/*`
  //    — direct API calls from a signed-in admin session would otherwise have
  //    access to whatever primary business their account points at (NULL for
  //    true admins). Filtering at the SQL boundary makes this an authorization
  //    invariant that survives proxy refactors.
  const [bizRow] = await sql<BusinessRow[]>`
    SELECT b.id, a.id AS account_id, a.subscription_status, b.place_id_verified, b.google_maps_url
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (!bizRow) {
    // Either no users row yet (signup not finished provisioning), no
    // business attached, OR the caller is an admin posting directly to
    // this owner-only endpoint. Return 404 either way so we don't leak
    // whether an admin session has an associated business.
    return NextResponse.json(
      { error: 'account_incomplete' },
      { status: 404, headers: NO_STORE },
    );
  }

  // 5. Subscription gate — wizard requires `active` or `trialing`. The dashboard
  //    pending-payment banner steers the owner to /onboarding/pay if they reach
  //    this flow before Stripe confirms.
  if (!subscriptionGrantsFullAccess(bizRow.subscription_status)) {
    return NextResponse.json(
      { error: 'subscription_inactive', subscriptionStatus: bizRow.subscription_status },
      { status: 409, headers: NO_STORE },
    );
  }

  const demoFlowEnabled = process.env.ONBOARDING_DEMO_ENABLED === 'true';

  // 6. Onboarding-state guard. Branches by ONBOARDING_DEMO_ENABLED:
  //
  //    Demo flow ON (post-pay wizard): location was captured at /onboarding/start
  //    BEFORE Stripe. If we reach here without it, the user skipped /start —
  //    redirect them back. The presence of place_id_verified or google_maps_url
  //    is the EXPECTED state, not a duplicate-submission signal.
  //
  //    Demo flow OFF (legacy single-pass wizard): location is captured here.
  //    Any pre-existing place_id_verified or google_maps_url means the wizard
  //    already ran — block as duplicate submission.
  if (demoFlowEnabled) {
    if (!bizRow.place_id_verified && !bizRow.google_maps_url) {
      return NextResponse.json(
        { error: 'onboarding_not_started', redirectTo: '/onboarding/start' },
        { status: 409, headers: NO_STORE },
      );
    }
  } else {
    if (bizRow.place_id_verified || bizRow.google_maps_url) {
      return NextResponse.json(
        { error: 'already_onboarded' },
        { status: 409, headers: NO_STORE },
      );
    }
  }

  // 7. Strict per-authId rate limit. Owners typically submit once; 10/hour
  //    leaves slack for validation-error retries. Redis-down fails closed
  //    with 503 so the cap can't be bypassed during a cache outage.
  try {
    const rl = await checkRateLimit(
      `onboarding-business:auth:${user.id}`,
      10,
      3600,
      { strict: true },
    );
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
    }
  } catch (err) {
    reportCaughtError('api/onboarding/business', err, { reason: 'rate_limit_strict_failure' });
    return NextResponse.json(
      { error: 'rate_limit_unavailable' },
      { status: 503, headers: NO_STORE },
    );
  }

  // 8. Parse + validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: NO_STORE });
  }
  const schema = demoFlowEnabled
    ? BusinessOnboardingPostPaySchema
    : BusinessOnboardingSchema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400, headers: NO_STORE },
    );
  }
  // The two schemas have overlapping but distinct shapes. Type-narrow inside
  // each branch — the post-pay schema rejects googlePlaceId/googleMapsUrl on
  // input (z.never), so those fields are always undefined when demoFlowEnabled.
  // We share `data` via the broader union; each branch reads only fields it
  // knows are present.
  const data = parsed.data as BusinessOnboardingInput & Partial<BusinessOnboardingPostPayInput>;

  // 9. Resolve place id state. PlaceAutocomplete path supplies googlePlaceId
  //    directly (verified) — review ingestion is now webhook-driven via Zernio,
  //    so no outbox row is needed for the verified path.
  //    Maps URL path supplies googleMapsUrl which the PlaceIdValidationWorker
  //    resolves; we extract a tentative placeId but place_id_verified stays
  //    false until the worker confirms it.
  // Demo-flow ON skips this entire block: location was captured at /start
  // and the post-pay schema rejects googlePlaceId/googleMapsUrl on input.
  let resolvedPlaceId: string | null = null;
  let placeIdVerified = false;
  let validatePayload: ValidatePlaceIdPayload | null = null;

  const correlationId = uuidv7();
  if (!demoFlowEnabled) {
    if (data.googlePlaceId) {
      resolvedPlaceId = data.googlePlaceId;
      placeIdVerified = true;
      // No outbox enqueue — review ingestion happens via Zernio webhooks now.
    } else {
      // googleMapsUrl branch (BusinessOnboardingSchema's XOR refine guarantees
      // one of the two is present; we already validated above).
      const mapsUrl = data.googleMapsUrl!;
      resolvedPlaceId = extractPlaceId(mapsUrl); // may be null or a hex CID
      placeIdVerified = false;
      validatePayload = {
        business_id: bizRow.id,
        google_maps_url: mapsUrl,
        correlation_id: correlationId,
      };
    }
  }

  const staffNames = splitCommaOrNewline(data.staffNames);
  const highlightFacts = splitCommaOrNewline(data.highlightFacts);
  const avoidFacts = splitCommaOrNewline(data.avoidFacts);
  const sampleResponses = splitParagraphs(data.sampleResponses);

  // 10. Atomic UPDATE + outbox INSERT.
  //     Advisory lock matches the Stripe webhook key shape (`<bizId>:activation`)
  //     so the wizard cannot race against a concurrent webhook delivery for
  //     the same business — even though the webhook no longer enqueues, future
  //     callers using the same lock key remain serialized.
  //     The FOR UPDATE re-read inside the tx is the defense-in-depth: another
  //     wizard submission in flight may have already onboarded; we silently
  //     no-op rather than write twice.
  //     The job_outbox INSERT uses WHERE NOT EXISTS over BOTH topics + all
  //     non-terminal statuses — defense-in-depth dedup against any race that
  //     leaves an in-flight outbox row visible.
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${bizRow.id + ':activation'}))`;

      const [forUpdateRow] = await tx<ForUpdateRow[]>`
        SELECT id, place_id_verified, google_maps_url
        FROM businesses
        WHERE id = ${bizRow.id}::uuid
        FOR UPDATE
      `;
      if (!forUpdateRow) {
        // Race: business deleted between the SELECT outside the tx and now.
        // Treat the whole request as a silent no-op — owner will get a 200,
        // but the dashboard will surface the missing business when they hit it.
        return;
      }
      if (!demoFlowEnabled && (forUpdateRow.place_id_verified || forUpdateRow.google_maps_url)) {
        // Legacy single-pass wizard only: place data already set means another
        // wizard submit won. Silent no-op so the loser's response is still 200
        // and the UI redirect to /dashboard works.
        //
        // Post-pay (demoFlowEnabled): place_id_verified IS the precondition
        // (set at /onboarding/start before Stripe). Treating it as
        // "duplicate submit" here would silently swallow every Profile/Voice
        // submission. Fall through to the post-pay UPDATE branch below.
        return;
      }

      if (demoFlowEnabled) {
        // Post-pay UPDATE: only profile + voice fields. Location was set at
        // /start. COALESCE preserves existing name/category if the wizard
        // omits them (post-pay user editing voice without retyping name).
        await tx`
          UPDATE businesses
          SET
            name = COALESCE(${data.businessName ?? null}, name),
            category = COALESCE(${data.category ?? null}, category),
            tone = ${data.tone},
            products_services = ${data.productsServices ?? null},
            staff_names = ${staffNames},
            highlight_facts = ${highlightFacts},
            avoid_facts = ${avoidFacts},
            sample_responses = ${sampleResponses},
            website = ${data.website ?? null},
            updated_at = NOW()
          WHERE id = ${bizRow.id}::uuid
        `;
      } else {
        await tx`
          UPDATE businesses
          SET
            name = ${data.businessName},
            category = ${data.category ?? null},
            google_place_id = ${resolvedPlaceId},
            place_id_verified = ${placeIdVerified},
            google_maps_url = ${data.googleMapsUrl ?? null},
            tone = ${data.tone},
            products_services = ${data.productsServices ?? null},
            staff_names = ${staffNames},
            highlight_facts = ${highlightFacts},
            avoid_facts = ${avoidFacts},
            sample_responses = ${sampleResponses},
            website = ${data.website ?? null},
            updated_at = NOW()
          WHERE id = ${bizRow.id}::uuid
        `;
      }

      // Explicit wizard-completion stamp — the one authoritative "wizard ran"
      // signal read by /api/auth/signup-status (migration 064; replaces the
      // updated_at-vs-activation proxy). COALESCE: first completion wins,
      // resubmits don't move the timestamp. Stamped on BOTH flow branches —
      // the legacy read path doesn't use it today, but the stamp is true in
      // both flows and survives ONBOARDING_DEMO_ENABLED flips.
      await tx`
        UPDATE accounts
        SET onboarding_wizard_completed_at = COALESCE(onboarding_wizard_completed_at, NOW()),
            updated_at = NOW()
        WHERE id = ${bizRow.account_id}::uuid
      `;

      if (data.businessName) {
        await tx`
          UPDATE accounts
          SET display_name = ${data.businessName}, updated_at = NOW()
          WHERE id = ${bizRow.account_id}::uuid
            AND display_name = ${PLACEHOLDER_BUSINESS_NAME}
        `;
      }

      // INSERT validate_place_id outbox row only on the Maps URL path.
      // The PlaceAutocomplete-verified path no longer enqueues anything —
      // review ingestion is webhook-driven via Zernio.
      if (validatePayload) {
        await enqueueValidatePlaceId(tx, {
          businessId: bizRow.id,
          googleMapsUrl: validatePayload.google_maps_url,
          correlationId: validatePayload.correlation_id,
        });
      }
    });
  } catch (err) {
    reportCaughtError('api/onboarding/business', err, { reason: 'transaction_failed', businessId: bizRow.id });
    return NextResponse.json({ error: 'internal' }, { status: 500, headers: NO_STORE });
  }

  return NextResponse.json({ redirectTo: '/dashboard' }, { status: 200, headers: NO_STORE });
}
