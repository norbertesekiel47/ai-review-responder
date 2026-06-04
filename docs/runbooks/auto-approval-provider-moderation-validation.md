# Auto-Approval Provider Moderation Validation

Phase 0 validation confirms that provider moderation works in each deploy
environment before any auto-approval runtime path can depend on it. It does not
enable runtime auto posting, auto approval decisions, schema changes, or
customer-facing settings.

The typed marker-shape contract is covered by:

```bash
pnpm exec vitest run src/lib/moderation/__tests__/moderate.test.ts
```

This runbook covers what mocked unit tests cannot prove: live provider
reachability, real environment credentials, and operational evidence that clean,
provider-error, and provider-flagged outcomes are understood before setting the
readiness flag.

## Required Environment

- Set `OPENAI_MODERATION_ENABLED=true` in the target environment being
  validated.
- Confirm the environment has working OpenAI moderation credentials and can
  reach the provider.
- Do not set `AUTO_APPROVAL_PROVIDER_MODERATION_READY=true` until every
  checklist item below is complete in the same target environment.

## Validation Checklist

- Clean provider result:
  - Submit safe response text that the local filter does not flag.
  - Confirm the environment reaches OpenAI moderation successfully.
  - Confirm the moderation decision records `providerStatus="clean"`.
  - Confirm the moderation decision is not flagged.

- Provider error result:
  - Simulate or observe an OpenAI moderation provider error.
  - Confirm the moderation decision falls back to the local filter.
  - Confirm the moderation decision records `providerStatus="error"`.
  - Confirm the error does not crash the response-generation path.

- Provider-flagged result:
  - Submit text that the OpenAI moderation provider flags.
  - Confirm the moderation decision has `flagged=true`.
  - Confirm the moderation decision does not record provider clean status.
  - Confirm the moderation decision includes `openai_categories`.

- Readiness flag:
  - Set `AUTO_APPROVAL_PROVIDER_MODERATION_READY=true` only after the target
    environment has evidence for the clean and provider-flagged checks above,
    and either an observed provider-error check or an approved operational
    substitute.

## Guardrails

- This phase does not permit runtime auto posting.
- This phase does not change the no-auto-posting invariant: every Google post
  still requires explicit owner approval.
- This phase must not add `AUTO_APPROVAL_*` application code paths.
- Treat validation as environment-specific. Passing in staging does not imply
  production is ready until the same checklist has been completed in production.
