# Blast radius — importers of changed files (`fix/1105-unmapped-block-reason-signal`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/lib/refusals/write.ts` — 18 importer(s)
- src/app/api/dashboard/__tests__/refusals-route.test.ts
- src/lib/auto-approval/__tests__/suspension.integration.test.ts
- src/lib/auto-approval/suspension.ts
- src/lib/refusals/__tests__/write.integration.test.ts
- src/lib/refusals/__tests__/write.test.ts
- src/lib/solicitation/__tests__/approval.integration.test.ts
- src/lib/solicitation/__tests__/ask-generation.integration.test.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/dispatch.integration.test.ts
- src/lib/solicitation/approval.ts
- src/lib/solicitation/ask-generation.ts
- src/lib/solicitation/batch-builder.ts
- src/lib/solicitation/dispatch.ts
- worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts
- worker/jobs/publisher/auto-policy-downgrade.ts
- worker/jobs/response-generation/__tests__/persist.test.ts
- worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts
- worker/jobs/response-generation/persist.ts

## `worker/jobs/response-generation/persist.ts` — 7 importer(s)
- worker/jobs/ResponseGeneratorWorker.ts
- worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
- worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts
- worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts
- worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts
- worker/jobs/response-generation/__tests__/persist.test.ts
- worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts
