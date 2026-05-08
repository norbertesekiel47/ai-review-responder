import { z } from 'zod';
import { websiteUrlSchema } from '@/lib/shared/schemas';

// Client-side form schema for the admin "Onboard New Business" page. The
// server-side equivalent (OnboardBusinessSchema in @/lib/shared/schemas)
// enforces an XOR refinement between googlePlaceId and googleMapsUrl, but the
// client form needs both fields independently optional because the user picks
// one input mode at a time (autocomplete vs paste-URL) and only the chosen
// field is sent in the POST payload. The XOR check happens at the API
// boundary (POST /api/admin/businesses) — this schema only validates the
// shape of in-form values for inline error display.
export const FormSchema = z.object({
  name: z.string().min(1, 'Business name is required').max(255),
  category: z.string().max(100).optional(),
  googlePlaceId: z.string().optional(),
  googlePlaceAddress: z.string().optional(),
  googleMapsUrl: z.string().optional(),
  // websiteUrlSchema only permits http:// or https:// — blocks javascript:,
  // data:, ftp:, etc. .or(z.literal('')) keeps empty string valid for the form.
  website: websiteUrlSchema.or(z.literal('')).optional(),
  ownerName: z.string().min(1, 'Owner name is required').max(255),
  ownerEmail: z.string().email('Valid email is required').max(255),
  ownerPhone: z.string().max(20).optional(),
  tone: z.string().min(1, 'Tone is required').max(100),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  subscriptionTier: z.enum(['founders', 'standard']),
});

export type FormData = z.infer<typeof FormSchema>;
