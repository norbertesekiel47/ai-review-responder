# Stage 4 BATCH 4e — the `ci:static-policy` inline-feature-flag ban (FINAL)

_Branch `refactor/audit-stage4-flag-ban`. The enforcement step that LOCKS the
Stage-4 feature-flag convention: bans inline `process.env.*_ENABLED` /
`*_DISABLED` reads, so every flag must flow through the `readFlag` primitive
behind a `<feature>/flags.ts` accessor (invariant #13). Completes Stage 4._

## Two parts
### 1. Sweep the last 2 stragglers
`worker/jobs/publisher/failed-hook.ts` and `worker/jobs/publisher/ResponsePublisherWorker.ts`
each read `EDIT_REPLIES_ENABLED` inline → now call `replyEditingFlagEnabled()`
(`past-replies/flags.ts`, landed in 4a). Behavior byte-for-byte (`=== 'true'`).
Both files' ONLY `process.env` read was this flag → they DROP from the baseline.

### 2. The ban — extend `scripts/ci/static-policy-audit.ts`
New `inline-feature-flag` rule: flags a dot-notation `process.env.X_ENABLED` /
`process.env.X_DISABLED` read on a NON-comment line.
- **Regex** `process\.env\.(?!NEXT_PUBLIC_)([A-Z][A-Z0-9_]*_(?:ENABLED|DISABLED))\b`
  — the `process.env.` prefix means bare flag-name mentions in comments/log
  strings are NOT matched (like the existing `NEXT_PUBLIC_ACCESS` rule); the
  `NEXT_PUBLIC_` negative lookahead defers public companions to the more-specific
  `next-public-allowlist` rule (no double-flag); comment lines are skipped; and
  the dynamic `process.env[name]` that `readFlag` uses is bracket notation → not
  matched.
- **Exempt files** (`isFlagBanExempt`): every `<feature>/flags.ts` accessor module
  (incl. `config/flags.ts`, the sanctioned home), the worker boot-assert
  `worker/config/startup-assert.ts` (it validates flag-gated env groups by name),
  and `scripts/**` (CI/dev tooling run standalone via tsx, outside the app runtime
  and the `@/` import graph).
- Whole-repo scan (`src` + `worker` + `scripts`), so the convention is enforced
  everywhere app code lives.

## Why scripts/ is exempt (not migrated)
`scripts/verify-stripe-price-parity.ts` (`STRIPE_TAX_ENABLED`) and
`scripts/zernio-backfill-external-replies.ts` (`EXTERNAL_REPLY_IMPORT_ENABLED`)
read flags inline. They are standalone tsx tooling that does not currently import
from `@/lib`; forcing the accessor import risks an alias-resolution break for zero
runtime benefit. They keep their inline reads under the `scripts/` exemption.

## Tests
- `scripts/ci/__tests__/static-policy-audit.test.ts`: 10 new cases — flags an
  inline `*_ENABLED`/`*_DISABLED` read; does NOT flag a `flags.ts` accessor,
  `config/flags.ts`, `startup-assert.ts`, `scripts/`, a bare-name mention, a
  comment-line `process.env.X_ENABLED`, or dynamic `process.env[name]`. The 3
  pre-existing NEXT_PUBLIC tests still pass (the lookahead prevents double-flag).

## Baseline
`process-env` baseline **16 → 14** (the 2 publisher files migrated). The remaining
~14 are the non-flag floor: `NEXT_PUBLIC_APP_URL` readers (literal #1, not
migratable), DB clients / sentry / redis-connection infra, and a few non-flag env
reads — none are feature flags, so the flag sweep is COMPLETE.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all green. The new rule is live: any
future inline `process.env.*_ENABLED` read outside the exempt set fails CI.
