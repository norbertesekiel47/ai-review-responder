# Stage 4 BATCH 4a — the `readFlag` primitive + harmonize the existing flags.ts

_Branch `refactor/audit-stage4-readflag-primitive`. The FOUNDATION of the Stage-4
feature-flag sweep (PLAN.md Stage 4 / handoff §4b). Establishes the shared flag
primitive and converts the three pre-existing `<feature>/flags.ts` accessors to it.
Zero behavior change._

## Why Stage 4 is a multi-PR sub-campaign
There are **20 boolean flags** (16 `*_ENABLED` + 4 `*_DISABLED`) across ~180 read
sites. This batch lands ONLY the primitive + the 3 existing accessors; subsequent
batches add per-feature `flags.ts` for the remaining clusters (auth, channels/
publishing, locations/payments/onboarding), and the FINAL batch adds the
`ci:static-policy` ban once every inline flag read is migrated.

## The primitive — `src/lib/config/flags.ts`
- **`readFlag(name): boolean`** = `process.env[name] === 'true'`. Runtime-agnostic —
  a flag's value is the same literal string on Vercel and Railway, so it is its OWN
  sanctioned env reader, a PEER of `getServerConfig`/`getWorkerConfig` and
  deliberately NOT routed through them (PLAN.md / Codex R3-2: routing worker-owned
  flags through Next-server config would re-couple the lanes). Lives under the
  `src/lib/config/` prefix → automatically allowlisted by `process-env-baseline.ts`.
  NOT memoized (a flag read is one cheap compare; keeps tests free of the memo-reset
  dance and matches the old direct `=== 'true'` semantics).
- **`isPreviewEnvironment()`** — the `VERCEL_TARGET_ENV` target-env resolution, moved
  here from `auto-approval/flags.ts` (its one home now). `VERCEL_TARGET_ENV` is an
  exempt indicator anyway; centralizing it removes the gotcha's duplication.

## Harmonized accessors (now call `readFlag`, no direct `process.env`)
- `auto-approval/flags.ts`: `autoApprovalRuntimeEnabled` (`AUTO_APPROVAL_ENABLED`),
  `providerModerationEnabled` (`OPENAI_MODERATION_ENABLED`), `providerModerationValidated`
  (`AUTO_APPROVAL_PROVIDER_MODERATION_READY`). `isPreviewEnvironment` removed (moved).
- `past-replies/flags.ts`: `pastRepliesViewEnabled` (`PAST_REPLIES_VIEW_ENABLED`),
  `replyEditingFlagEnabled` (`EDIT_REPLIES_ENABLED`); `editRepliesEnabled` unchanged.
- `account-offboarding/flags.ts`: `accountOffboardingEnabled` (`ACCOUNT_OFFBOARDING_ENABLED`).

## Consumers updated (import `isPreviewEnvironment` from its new home)
- `auto-approval/settings.ts` and `admin/business-detail/mappers.ts` now import
  `isPreviewEnvironment` from `@/lib/config/flags` (the other accessors still come
  from `auto-approval/flags`). `mappers.ts` STAYS in the baseline — it reads other
  flags inline, migrated in a later Stage-4 cluster.

## Behavior preservation
`readFlag(name)` is byte-for-byte `process.env[name] === 'true'` — exactly what every
accessor did inline. The exact-string-`'true'` semantics (TRUE/True/1/' true '/unset
all → false) are preserved and locked by tests.

## Tests
- New `src/lib/config/__tests__/flags.test.ts`: `readFlag` exact-`'true'`-only matrix +
  dynamic-name reads + `isPreviewEnvironment` (the VERCEL_TARGET_ENV cases, relocated
  from `auto-approval/__tests__/flags.test.ts`).
- `auto-approval/__tests__/flags.test.ts`: dropped the `isPreviewEnvironment` import +
  its now-relocated case; all other assertions unchanged.

## Baseline
`process-env` baseline **32 → 29** — the three harmonized `flags.ts` no longer read
`process.env` directly. `config/flags.ts` is allowlisted via the `src/lib/config/` prefix.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all green.
