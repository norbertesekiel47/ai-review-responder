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
    notificationPreference: z.enum(['email', 'sms', 'both']).default('email'),
    tone: toneSchema.default('professional and friendly'),
    productsServices: z.string().max(5000).optional(),
    staffNames: z.string().max(2000).optional(),
    highlightFacts: z.string().max(2000).optional(),
    avoidFacts: z.string().max(2000).optional(),
    sampleResponses: z.string().max(5000).optional(),
    subscriptionTier: z.enum(['founding', 'standard']).default('standard'),
    website: z.string().url().max(500).optional().nullable(),
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
    website: z.string().url().max(500).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });
