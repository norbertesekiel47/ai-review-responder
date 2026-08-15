import { z } from 'zod';

// Client-side form schema for the admin "Onboard New Business" page.
//
// Admin onboarding is invite-only identity capture: owner email, owner name,
// business name. Everything the admin used to type beyond identity (place,
// voice & context, subscription tier) is now collected from the OWNER inside
// the self-serve funnel — place at /onboarding/start, tier at /onboarding/pay,
// voice in the post-payment wizard — so capturing it here only duplicated it.
//
// This mirrors OnboardBusinessSchema (@/lib/shared/schemas), the server-side
// contract, but is deliberately declared locally rather than imported: the
// shared module pulls in the Google-Maps URL parser and the tier config for
// schemas this form no longer uses, and none of that belongs in the browser
// bundle for three text inputs. The two are three fields long — if they ever
// drift, POST /api/admin/businesses is the authority and returns the 400.
export const FormSchema = z.object({
  name: z.string().min(1, 'Business name is required').max(255),
  ownerName: z.string().min(1, 'Owner name is required').max(255),
  ownerEmail: z.email('Valid email is required').max(255),
});

export type FormData = z.infer<typeof FormSchema>;
