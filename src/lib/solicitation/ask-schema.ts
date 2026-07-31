import { z } from 'zod';

// SHAPE ONLY (spec §4.2, docs/superpowers/specs/2026-07-28-ask-generation-design.md).
// Length/formatting bounds (e.g. the ≤80-char subject) live in lint class 5 so an
// out-of-bounds draft becomes a legible `blocked` render — never a terminal
// LLMStructuredOutputError that burns the cost reservation.
export const SolicitationAskOutputSchema = z.strictObject({
  subject: z.string().min(1),
  body: z.string().min(1),
});
