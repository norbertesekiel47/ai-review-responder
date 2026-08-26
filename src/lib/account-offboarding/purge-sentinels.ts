/**
 * The tombstone sentinels — the exact values the account purge writes, and the
 * exact values its verifier checks for.
 *
 * WHY THIS FILE EXISTS. The purge writer
 * (`worker/jobs/account-offboarding/purge-stages.ts`) and the purge verifier
 * (`./purge-verification.ts`) must agree BY CONSTRUCTION — that is the entire
 * point of having a verifier. Before this module they agreed because two
 * humans typed the same EIGHT duplicated values twice each. (Eight pairs, nine
 * members below: the email is one pair carried by two fragments.) A verifier
 * that drifts from
 * its writer is worse than no verifier: it is a fail-closed compliance gate
 * that reports PASS on residue.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It holds VALUES, not SQL. The two
 * sides compose their own predicates from these parts and keep their own
 * operators — the writer's `=`, the verifier's `IS DISTINCT FROM`. A shared
 * fragment builder would need an `Sql` parameter and would hide that
 * asymmetry at the call sites, which is exactly where a reader needs to see
 * it. It also does NOT collapse the writer's `SET` clause and the verifier's
 * `OR`-chain into one declarative column -> expectation table; those are
 * different predicate kinds over different column sets, and that is a separate
 * design decision (#892 anti-pattern guard).
 *
 * PROVENANCE, per value — each sentinel is authorised by a SCHEMA fact, not by
 * an application default that happens to share its text:
 *
 * - `tone` is `001_initial_schema.sql:71`'s column DEFAULT. It is NOT
 *   `src/lib/responses/prompt-builder.ts`'s `DEFAULT_TONE`. Same string today,
 *   different fact: one is what the database restores, the other is what the
 *   prompt falls back to. Conflating them is the next drift.
 * - `accountFlags` is migration 034's `accounts.flags` default.
 * - `trackedKeywords` is migration 014's `businesses.tracked_keywords` default
 *   (`014_retention_expansion.sql:116-121`, which also made it `NOT NULL`).
 *
 * THE TWO JSONB SENTINELS ARE SEMANTIC VALUES, NOT JSON TEXT. Both sides bind
 * them through `tx.json(...)` / `exec.json(...)` per the repo's Postgres.js
 * jsonb rule — never `'[]'::jsonb` string interpolation.
 *
 * THE EMAIL PATTERN IS TWO FRAGMENTS, NOT ONE VALUE, because it is built around
 * a per-row id: `deleted-<id>@repworth.invalid`. Neither fragment contains
 * `%`, `_` or a backslash, which is what lets the verifier compare it with
 * `IS DISTINCT FROM` rather than `LIKE`. A future fragment containing any of
 * those characters would make that comparison a behaviour change — check
 * before editing these two strings.
 */

/** The nine tombstone sentinel values. Frozen at every level: `as const` is a
 *  TypeScript annotation and freezes nothing at runtime, so the two containers
 *  are frozen explicitly or an importer could mutate them. */
export const PURGE_TOMBSTONE_SENTINELS = Object.freeze({
  /** `businesses.name` */
  businessName: 'Deleted location',
  /** `businesses.tone` — RESTORED to the schema default, not nulled. */
  tone: 'professional and friendly',
  /** `businesses.owner_name` */
  ownerName: 'Deleted owner',
  /** `accounts.display_name` */
  accountName: 'Deleted account',
  /** `users.name` */
  userName: 'Deleted user',
  /** `businesses.tracked_keywords` — RESTORED to the schema default. */
  trackedKeywords: Object.freeze([]) as readonly never[],
  /** `accounts.flags` — RESTORED to the schema default. */
  accountFlags: Object.freeze({}) as Readonly<Record<string, never>>,
  /** `businesses.owner_email` and `users.email`, around the row's own id. */
  emailPrefix: 'deleted-',
  emailSuffix: '@repworth.invalid',
} as const);
