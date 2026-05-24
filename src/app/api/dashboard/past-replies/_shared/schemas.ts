// src/app/api/dashboard/past-replies/_shared/schemas.ts
//
// Shared Zod schemas reused across the five past-replies mutation routes.
// Keeping them here ensures the validation shapes stay byte-identical and
// are updated in one place.

import { z } from 'zod';

export const snapshotSchema = z.object({
  hash: z.string().min(1),
  version: z.number().int().positive(),
});
