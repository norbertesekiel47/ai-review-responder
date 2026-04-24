import { z } from 'zod';

// ── Reusable field schemas ──────────────────────────────────────────

export const businessNameSchema = z.string().min(1, 'Business name is required').max(255);
export const categorySchema = z.string().max(100);
export const toneSchema = z.string().max(100);
export const ownerNameSchema = z.string().min(1, 'Owner name is required').max(255);
export const ownerEmailSchema = z.string().email('Valid email is required').max(255);
export const ownerPhoneSchema = z.string().max(20);
export const staffNamesArraySchema = z.array(z.string().max(100));
export const highlightFactsArraySchema = z.array(z.string().max(500));
export const avoidFactsArraySchema = z.array(z.string().max(500));

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

// ── Onboarding schema (POST /api/admin/businesses) ─────────────────

export const OnboardBusinessSchema = z
  .object({
    name: businessNameSchema,
    category: categorySchema.optional(),
    googlePlaceId: z.string().min(1).optional(),
    googlePlaceAddress: z.string().optional(),
    googleMapsUrl: z.string().min(1).optional(),
    ownerName: ownerNameSchema,
    ownerEmail: ownerEmailSchema,
    ownerPhone: ownerPhoneSchema.optional(),
    tone: toneSchema.default('professional and friendly'),
    productsServices: z.string().max(5000).optional(),
    staffNames: z.string().max(2000).optional(),
    highlightFacts: z.string().max(2000).optional(),
    avoidFacts: z.string().max(2000).optional(),
    sampleResponses: z.string().max(5000).optional(),
    subscriptionTier: z.enum(['founding', 'standard']).default('standard'),
    website: websiteUrlSchema.optional().nullable(),
  })
  .refine(
    (data) => Boolean(data.googlePlaceId) || Boolean(data.googleMapsUrl),
    { message: 'Either a Place ID or Google Maps URL is required', path: ['googlePlaceId'] },
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

// Shared shape between SignupSchema (password auth) and FinishSignupSchema (Google OAuth).
// Reuses existing field schemas where constraints match.
const baseBusinessShape = {
  businessName: businessNameSchema,
  category: categorySchema.optional().nullable(),
  googlePlaceId: z.string().min(1).optional(),
  googleMapsUrl: z.string().min(1).optional(),
  tone: toneSchema.optional(),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  subscriptionTier: z.enum(['founding', 'standard']),
  website: websiteUrlSchema.optional().nullable(),
};

export const SignupSchema = z
  .object({
    ownerEmail: normalizedEmailSchema,
    ownerName: ownerNameSchema,
    ownerPhone: ownerPhoneSchema.optional(),
    password: passwordSchema,
    ...baseBusinessShape,
  })
  .refine((d) => Boolean(d.googlePlaceId) || Boolean(d.googleMapsUrl), {
    message: 'Either googlePlaceId or googleMapsUrl is required',
    path: ['googlePlaceId'],
  });

export type SignupInput = z.infer<typeof SignupSchema>;

export const FinishSignupSchema = z
  .object({
    ownerName: ownerNameSchema,
    ownerPhone: ownerPhoneSchema.optional(),
    ...baseBusinessShape,
  })
  .refine((d) => Boolean(d.googlePlaceId) || Boolean(d.googleMapsUrl), {
    message: 'Either googlePlaceId or googleMapsUrl is required',
    path: ['googlePlaceId'],
  });

export type FinishSignupInput = z.infer<typeof FinishSignupSchema>;

export const ForgotPasswordSchema = z.object({
  email: normalizedEmailSchema,
  role: z.enum(['owner', 'admin']),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export const ResendConfirmationSchema = z.object({
  email: normalizedEmailSchema,
  flow: z.enum(['owner', 'admin']),
});
export type ResendConfirmationInput = z.infer<typeof ResendConfirmationSchema>;
