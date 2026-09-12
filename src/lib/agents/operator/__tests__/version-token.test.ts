// Unit seams for src/lib/agents/operator/version-token.ts — the **Version
// token**'s type, its JSONB parse site and its equality. T1 converts these.
//
// Titles 1, 2 and 20 (the fast-check property) all live here because they are
// one subject: what "the same token" means. The microsecond case is the whole
// reason the token is text end-to-end (CLAUDE.md's timestamptz gotcha).
import { describe, it } from 'vitest';

describe('voice version token', () => {
  it.todo('version token equality is text-to-text on both fields and a one-microsecond difference is not equal');
  it.todo('version token parser rejects a stored token missing businessId or updatedAt');
});

describe('voice version token invariants', () => {
  it.todo('invariants: equal version tokens are exactly those with equal businessId and equal updatedAt text');
});
