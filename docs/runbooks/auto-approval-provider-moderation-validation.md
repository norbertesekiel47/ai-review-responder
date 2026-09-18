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
  - **Inject the fault BEFORE the process starts — never inside it.** The OpenAI client is
    built once and cached, so mutating `process.env.OPENAI_API_KEY` mid-process cannot reach
    it: the call succeeds and returns `providerStatus="clean"`, which looks exactly like a
    pass while testing nothing. Run a fresh process with the bad credential injected at
    start, e.g.
    `railway run --environment <env> --service repworth-worker -- env OPENAI_API_KEY=sk-invalid npx tsx <script>`.
  - Confirm the provider error actually occurred (an `invalid_api_key` in the output) before
    believing the decision that came back.
  - Simulate or observe an OpenAI moderation provider error.
  - Confirm the moderation decision falls back to the local filter.
  - Confirm the moderation decision records `providerStatus="error"`.
  - Confirm the error does not crash the response-generation path.

- Provider-flagged result:
  - Submit text that the OpenAI moderation provider flags.
  - Confirm the moderation decision has `flagged=true`.
  - Confirm the moderation decision does not record provider clean status.
  - Confirm the moderation decision includes `openai_categories`.

- Corpus run (the recorded false-positive / false-negative measurement):
  - The three checks above prove each outcome SHAPE once. They do not measure
    how often the provider is right. That is what the corpus run does, and the
    launch checklist requires it before the readiness flag.
  - Run it per environment:
    ```bash
    railway run --environment <env> --service repworth-worker -- \
      npx tsx tests/llm-eval/run.ts --live --moderation-corpus \
      --env <env> --out docs/runbooks/evidence/<date>-provider-moderation-corpus-<env>.json
    ```
  - The corpus is `tests/llm-eval/moderation-corpus.jsonl`. The acceptance
    criteria are owned by `MODERATION_CORPUS_ACCEPTANCE` in
    `tests/llm-eval/moderation-runner.ts` — never restated as numbers elsewhere.
  - The lane refuses to start unless the process reads
    `OPENAI_MODERATION_ENABLED === 'true'`, and scores any row with no provider
    marker as `provider_not_reached`. Both guard the silent-failure mode above.
  - Confirm `VERDICT: PASS` before the readiness flag. Latest recorded run:
    `docs/runbooks/evidence/2026-09-17-provider-moderation-corpus.md` —
    **FAIL in staging and production**, finding G4-F1.

- Readiness flag:
  - Set `AUTO_APPROVAL_PROVIDER_MODERATION_READY=true` only after the target
    environment has evidence for the clean and provider-flagged checks above,
    either an observed provider-error check or an approved operational
    substitute, AND a `VERDICT: PASS` corpus run in that same environment.

## Guardrails

- This phase does not permit runtime auto posting.
- This phase does not change the no-auto-posting invariant: every Google post
  still requires explicit owner approval.
- This phase must not add `AUTO_APPROVAL_*` application code paths.
- Treat validation as environment-specific. Passing in staging does not imply
  production is ready until the same checklist has been completed in production.
