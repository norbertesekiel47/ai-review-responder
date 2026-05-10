import { z } from 'zod';
import { isPlaceId, parseGoogleMapsUrl } from '@/lib/reviews/url-parser';

// ── Reusable field schemas ──────────────────────────────────────────

const businessNameSchema = z.string().min(1, 'Business name is required').max(255);
const categorySchema = z.string().max(100);
const toneSchema = z.string().max(100);
const ownerNameSchema = z.string().min(1, 'Owner name is required').max(255);
const ownerEmailSchema = z.string().email('Valid email is required').max(255);
const ownerPhoneSchema = z.string().max(20);
const staffNamesArraySchema = z.array(z.string().max(100));
const highlightFactsArraySchema = z.array(z.string().max(500));
const avoidFactsArraySchema = z.array(z.string().max(500));

/**
 * URL validator that ONLY permits http: and https: schemes.
 * z.string().url() accepts javascript:, data:, ftp:, mailto: — any of
 * which become XSS/phishing vectors when rendered as anchor hrefs on
 * admin-facing pages. This schema rejects anything other than http://
 * or https:// regardless of the rest of the URL validity.
 */
export const websiteUrlSchema = z
  .string()
  .max(500)
  .refine(
    (val) => {
      try {
        const url = new URL(val);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Website must be a valid http:// or https:// URL' },
  );

/**
 * Strict Google Maps URL validator.
 *
 * Three reasons this can't be a generic URL field:
 *   1. The wizard's "already onboarded" guard treats `google_maps_url IS NOT NULL`
 *      as proof of completion, so any non-empty string lands the user on
 *      /dashboard with a malformed URL the worker can't resolve. A strict
 *      schema fails fast at the API boundary instead of leaking that state.
 *   2. We render this URL on admin pages + email templates. Allowing
 *      arbitrary domains turns it into a phishing-redirect primitive
 *      ("I onboarded my business, here's my URL: https://attacker.example").
 *   3. The downstream Place ID resolver expects either a `/maps/` path on
 *      a google.* host (it parses `!1s` data segments + CIDs) or a Maps
 *      shortlink that resolves to one of those. A bare `https://google.com/`
 *      or `https://google.com/search?q=...` doesn't have anything to resolve
 *      and the worker would mark the business as `validate_place_id_failed`.
 *
 * What we accept:
 *   - `https://www.google.com/maps/...` (any path containing /maps/)
 *   - `https://google.<tld>/maps/...` including regional TLDs
 *   - `https://maps.google.<tld>/...` (any path)
 *   - `https://maps.app.goo.gl/<id>` (mobile-app shortlink — a Maps-only domain)
 *   - `https://goo.gl/maps/<id>` (legacy shortlink — `/maps/` segment is required;
 *     bare `goo.gl/<id>` could be ANY shortlink, so we don't accept it)
 *
 * Owners with a non-Maps URL should use the Step 1 PlaceAutocomplete instead
 * (the preferred path anyway).
 */
const MAPS_HOST_RULES: Array<{ host: RegExp; pathRequired?: RegExp }> = [
  // Canonical Google web — must contain /maps/ in the path.
  { host: /^(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/, pathRequired: /\/maps(?:\/|$)/ },
  // Maps subdomain — any path is fine (path is implicitly /maps/...).
  { host: /^maps\.google\.[a-z]{2,3}(?:\.[a-z]{2})?$/ },
  // Mobile-app shortlink — Maps-only domain, any path.
  { host: /^maps\.app\.goo\.gl$/ },
  // Legacy shortlink — host alone is multi-purpose, require /maps/ segment.
  { host: /^goo\.gl$/, pathRequired: /^\/maps(?:\/|$)/ },
];

/**
 * Two-stage validation:
 *
 *   Stage 1 (host shape) — must be a https:// Google Maps domain (host
 *   whitelist + path requirement). Rejects obvious phishing redirects.
 *
 *   Stage 2 (resolver-readiness) — must yield enough data for the
 *   PlaceIdValidationWorker to actually resolve a Place ID. The worker
 *   accepts either:
 *     - A canonical Place ID embedded in the URL (`!1s<id>` data segment,
 *       `?placeid=`/`?place_id=`/`?q=place_id:` params), OR
 *     - Both a business name (from `/place/Name/`) AND coordinates
 *       (from `@lat,lng`) so it can do a SerpAPI proximity search.
 *   Anything else (`https://maps.google.com/`, `?cid=...`, bare shortlinks)
 *   would let the wizard guard treat the business as onboarded while the
 *   worker silently fails resolution and the owner sits at /dashboard with
 *   no Place ID. Reject at schema time so the wizard surfaces the error
 *   to the owner instead of producing a permanently-broken state.
 *
 * The owner's recourse for an unparseable URL is the Step 1 PlaceAutocomplete
 * picker (which writes a Place ID directly), not pasting any Maps URL.
 */
function urlIsResolverReady(val: string): boolean {
  try {
    const data = parseGoogleMapsUrl(val);
    // Mirror PlaceIdValidationWorker.ts:36 exactly — `isPlaceId()` must
    // pass on the embedded value. A URL like
    //   https://www.google.com/maps/place/?q=place_id:bad
    // parses to `{ placeId: 'bad' }` but the worker would reject it with
    // `Cannot resolve Place ID without business name and coordinates` AND
    // simultaneously not be able to use the bad ID. Without isPlaceId
    // here, the schema would accept the URL, the row would land with
    // google_maps_url set (wizard guard treats as onboarded), and the
    // worker would mark validation permanently failed → owner stuck.
    if (data.placeId !== null && isPlaceId(data.placeId)) return true;
    return data.businessName !== null && data.coordinates !== null;
  } catch {
    return false;
  }
}

const googleMapsUrlSchema = z
  .string()
  .min(1, 'Google Maps URL is required')
  .max(2048, 'Google Maps URL too long')
  .refine(
    (val) => {
      try {
        const url = new URL(val.trim());
        if (url.protocol !== 'https:') return false;
        const host = url.hostname.toLowerCase();
        const path = url.pathname;
        for (const rule of MAPS_HOST_RULES) {
          if (!rule.host.test(host)) continue;
          if (rule.pathRequired && !rule.pathRequired.test(path)) continue;
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    {
      message:
        'Must be an https:// Google Maps URL (e.g. https://google.com/maps/place/..., https://maps.google.com/..., https://maps.app.goo.gl/..., or https://goo.gl/maps/...)',
    },
  )
  .refine(urlIsResolverReady, {
    message:
      'This URL doesn\'t contain a Place ID or enough data (business name + coordinates) for us to resolve. Use the search field above or paste the full /maps/place/<name>/@<lat>,<lng>/data=...!1s<id> URL.',
  });

// ── Onboarding schema (POST /api/admin/businesses) ─────────────────

export const OnboardBusinessSchema = z
  .object({
    name: businessNameSchema,
    category: categorySchema.optional(),
    // Validate Place ID shape at the schema layer — mirrors
    // BusinessOnboardingSchema (owner-side, line 167–171) so both onboarding
    // entry points share the same input contract. The admin route
    // additionally re-checks via `isPlaceId(data.googlePlaceId)` at the
    // handler layer (route.ts ~142) as belt-and-suspenders, but having the
    // refine here means: (a) any future caller of
    // OnboardBusinessSchema.safeParse() — tests, other routes, internal
    // tooling — gets the validation for free, (b) a refactor that moves
    // the strict route-level check can't accidentally drop validation
    // entirely, (c) the schema-level error shape feeds the existing
    // safeParse error-message handling at route.ts:130 without any
    // route-side work.
    googlePlaceId: z
      .string()
      .min(1)
      .refine((v) => isPlaceId(v), { message: 'Invalid Google Place ID format' })
      .optional(),
    googlePlaceAddress: z.string().optional(),
    googleMapsUrl: googleMapsUrlSchema.optional(),
    ownerName: ownerNameSchema,
    ownerEmail: ownerEmailSchema,
    ownerPhone: ownerPhoneSchema.optional(),
    tone: toneSchema.default('professional and friendly'),
    productsServices: z.string().max(5000).optional(),
    staffNames: z.string().max(2000).optional(),
    highlightFacts: z.string().max(2000).optional(),
    avoidFacts: z.string().max(2000).optional(),
    sampleResponses: z.string().max(5000).optional(),
    subscriptionTier: z.enum(['founders', 'standard']).default('standard'),
    website: websiteUrlSchema.optional().nullable(),
  })
  // True XOR — exactly one of googlePlaceId / googleMapsUrl, never both.
  // Allowing both lets the two diverge downstream: createBusinessTx admin
  // mode prefers googlePlaceId for the placeIdInput shape but the wizard
  // guard treats either as authoritative. Keep this in lockstep with
  // BusinessOnboardingSchema (the owner-side equivalent below).
  .refine(
    (data) => Boolean(data.googlePlaceId) !== Boolean(data.googleMapsUrl),
    {
      message: 'Provide exactly one of googlePlaceId or googleMapsUrl, not both',
      path: ['googlePlaceId'],
    },
  );

// ── Update schema (PATCH /api/admin/businesses/:id) ─────────────────

export const UpdateBusinessSchema = z
  .object({
    name: businessNameSchema.optional(),
    category: categorySchema.nullable().optional(),
    tone: toneSchema.optional(),
    productsServices: z.string().max(5000).nullable().optional(),
    staffNames: staffNamesArraySchema.optional(),
    highlightFacts: highlightFactsArraySchema.optional(),
    avoidFacts: avoidFactsArraySchema.optional(),
    website: websiteUrlSchema.nullable().optional(),
    ownerEmail: ownerEmailSchema.optional(),
    ownerEmailBounced: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

// ── Self-serve signup schemas ─────────────────────────────────────────
// See docs/superpowers/specs/2026-04-23-owner-self-serve-signup-design.md §2.3, §3.1.
// Email normalization uses z.preprocess so trim+lower happens BEFORE email validation,
// letting values like "  Owner@X.com  " parse correctly as "owner@x.com".

const normalizedEmailSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string().email().max(254),
);

const passwordSchema = z.string().min(8).max(128);

// Identity-only signup. Business details are collected later via
// BusinessOnboardingSchema (POST /api/onboarding/business) after Stripe payment.
export const SignupSchema = z.object({
  ownerEmail: normalizedEmailSchema,
  ownerName: ownerNameSchema,
  ownerPhone: ownerPhoneSchema.optional(),
  password: passwordSchema,
});

type SignupInput = z.infer<typeof SignupSchema>;

// Google OAuth session provides email; collect name + phone only. Business
// details are deferred to BusinessOnboardingSchema, same as password signup.
export const FinishSignupSchema = z.object({
  ownerName: ownerNameSchema,
  ownerPhone: ownerPhoneSchema.optional(),
});

type FinishSignupInput = z.infer<typeof FinishSignupSchema>;

// Submitted by /onboarding/business after Stripe payment confirms.
// Replaces the business-fields portion of the previous combined SignupSchema.
export const BusinessOnboardingSchema = z
  .object({
    businessName: businessNameSchema,
    category: categorySchema.optional().nullable(),
    googlePlaceId: z
      .string()
      .min(1)
      .refine((v) => isPlaceId(v), { message: 'Invalid Google Place ID format' })
      .optional(),
    googlePlaceAddress: z.string().max(500).optional(),
    googleMapsUrl: googleMapsUrlSchema.optional(),
    tone: toneSchema.default('professional and friendly'),
    productsServices: z.string().max(5000).optional(),
    staffNames: z.string().max(2000).optional(),
    highlightFacts: z.string().max(2000).optional(),
    avoidFacts: z.string().max(2000).optional(),
    sampleResponses: z.string().max(5000).optional(),
    website: websiteUrlSchema.optional().nullable(),
  })
  // True XOR: exactly one of googlePlaceId or googleMapsUrl must be provided.
  // Allowing both (the previous .refine just checked at-least-one) creates
  // ambiguity downstream: createBusinessTx hits a PlaceIdInput branch on
  // googlePlaceId but the wizard guard treats googleMapsUrl as
  // authoritative — accepting both lets the two diverge.
  .refine(
    (d) => Boolean(d.googlePlaceId) !== Boolean(d.googleMapsUrl),
    {
      message: 'Provide exactly one of googlePlaceId or googleMapsUrl, not both',
      path: ['googlePlaceId'],
    },
  );

export type BusinessOnboardingInput = z.infer<typeof BusinessOnboardingSchema>;

export const ForgotPasswordSchema = z.object({
  email: normalizedEmailSchema,
  role: z.enum(['owner', 'admin']),
});
type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  password: passwordSchema,
});
type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

// Admin identities are provisioned manually via the Supabase dashboard with
// `email_confirm: true` and never go through the confirmation-email flow, so
// resend is owner-only. Accepting `flow: 'admin'` would be a phishing-adjacent
// primitive — a caller could trigger a "confirm your account" email to any
// admin address without that address having ever signed up.
export const ResendConfirmationSchema = z.object({
  email: normalizedEmailSchema,
  flow: z.literal('owner'),
});
type ResendConfirmationInput = z.infer<typeof ResendConfirmationSchema>;

// Email OTP entry — owner enters the 6-digit token Supabase sends in the
// confirmation email. We accept 4–10 digit/alphanumeric tokens defensively
// (Supabase has historically used 6-digit numeric, but format isn't
// contractually frozen). Token validation is ultimately enforced by
// `supabase.auth.verifyOtp` — this schema just keeps obvious junk out.
export const VerifyEmailOtpSchema = z.object({
  email: normalizedEmailSchema,
  token: z
    .string()
    .min(4, 'Code is too short')
    .max(10, 'Code is too long')
    .regex(/^[A-Za-z0-9]+$/, 'Code must be alphanumeric'),
});
type VerifyEmailOtpInput = z.infer<typeof VerifyEmailOtpSchema>;

// Plan selection on /onboarding/pay. Owner picks founders, standard, or premium;
// the route writes the choice to businesses.subscription_tier and returns
// the matching Stripe Payment Link.
export const SelectPlanSchema = z.object({
  tier: z.enum(['founders', 'standard', 'premium']),
});
type SelectPlanInput = z.infer<typeof SelectPlanSchema>;

/**
 * Tightened business name for pre-pay demo path.
 * The value flows into the LLM prompt and the curated demo display;
 * demo output is one tweet away from public. This is stricter than
 * businessNameSchema (used for post-pay edits) because prompt-injection
 * risk is load-bearing here.
 */
const demoBusinessNameSchema = z
  .string()
  .min(1, 'Business name is required')
  .max(80, 'Business name too long')
  .regex(/^[^\n\r<>{}]+$/, 'Business name contains invalid characters');

/**
 * POST /api/onboarding/start — pre-pay location capture.
 * Exactly one of googlePlaceId (autocomplete) or googleMapsUrl (URL)
 * must be present. Prefill fields only valid in autocomplete branch.
 */
export const OnboardingStartSchema = z
  .object({
    inputMode: z.enum(['autocomplete', 'url']),
    googlePlaceId: z
      .string()
      .min(1)
      .refine((v) => isPlaceId(v), { message: 'Invalid Google Place ID format' })
      .optional(),
    googlePlaceAddress: z.string().max(500).optional(),
    googleMapsUrl: googleMapsUrlSchema.optional(),
    businessName: demoBusinessNameSchema,
    prefilledCategory: z.string().max(100).nullable().optional(),
    prefilledWebsite: websiteUrlSchema.nullable().optional(),
  })
  .refine(
    (d) => Boolean(d.googlePlaceId) !== Boolean(d.googleMapsUrl),
    {
      message: 'Provide exactly one of googlePlaceId or googleMapsUrl, not both',
      path: ['googlePlaceId'],
    },
  )
  .refine(
    (d) => {
      if (d.inputMode === 'url') {
        return !d.prefilledCategory && !d.prefilledWebsite;
      }
      return true;
    },
    {
      message: 'prefilledCategory and prefilledWebsite are only valid in autocomplete mode',
      path: ['prefilledCategory'],
    },
  );

type OnboardingStartInput = z.infer<typeof OnboardingStartSchema>;

/**
 * POST /api/onboarding/business when ONBOARDING_DEMO_ENABLED=true.
 * Post-pay wizard: location was already captured at /start.
 *
 * The location-capture fields are declared as `z.never().optional()` so a
 * client posting them gets a Zod error instead of having the field silently
 * stripped.
 */
export const BusinessOnboardingPostPaySchema = z.object({
  businessName: z.string().min(1).max(255).optional(),
  category: categorySchema.nullable().optional(),
  tone: toneSchema.default('professional and friendly'),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  website: websiteUrlSchema.nullable().optional(),
  googlePlaceId: z.never({
    error: 'unexpected_field: googlePlaceId is set during pre-pay onboarding at /start',
  }).optional(),
  googleMapsUrl: z.never({
    error: 'unexpected_field: googleMapsUrl is set during pre-pay onboarding at /start',
  }).optional(),
  googlePlaceAddress: z.never({
    error: 'unexpected_field: googlePlaceAddress is set during pre-pay onboarding at /start',
  }).optional(),
});

export type BusinessOnboardingPostPayInput = z.infer<typeof BusinessOnboardingPostPaySchema>;
