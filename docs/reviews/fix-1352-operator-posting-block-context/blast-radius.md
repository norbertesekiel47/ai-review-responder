# Blast radius — importers of changed files (`fix/1352-operator-posting-block-context`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/app/(authenticated)/dashboard/operator/ProposalCard.tsx` — 6 importer(s)
- src/app/(authenticated)/dashboard/operator/OperatorClient.tsx
- src/app/(authenticated)/dashboard/operator/RulesTimeline.tsx
- src/app/(authenticated)/dashboard/operator/TurnBody.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx
- src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx

## `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx` — 2 importer(s)
- src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx
- src/app/(authenticated)/settings/auto-approval/page.tsx

## `src/lib/agents/operator/context.ts` — 12 importer(s)
- src/lib/agents/operator/__tests__/context.test.ts
- src/lib/agents/operator/__tests__/model-call.test.ts
- src/lib/agents/operator/__tests__/prompt.test.ts
- src/lib/agents/operator/__tests__/reads.integration.test.ts
- src/lib/agents/operator/__tests__/render.test.ts
- src/lib/agents/operator/__tests__/snapshot.integration.test.ts
- src/lib/agents/operator/model-call.ts
- src/lib/agents/operator/prompt.ts
- src/lib/agents/operator/reads.ts
- src/lib/agents/operator/render.ts
- src/lib/agents/operator/turns.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/agents/operator/prompt.ts` — 5 importer(s)
- src/lib/agents/operator/__tests__/context.test.ts
- src/lib/agents/operator/__tests__/model-call.test.ts
- src/lib/agents/operator/__tests__/prompt.test.ts
- src/lib/agents/operator/__tests__/snapshot.integration.test.ts
- src/lib/agents/operator/model-call.ts

## `src/lib/agents/operator/proposals.ts` — 25 importer(s)
- src/app/(authenticated)/dashboard/operator/ProposalCard.tsx
- src/app/(authenticated)/dashboard/operator/RulesTimeline.tsx
- src/app/(authenticated)/dashboard/operator/TurnBody.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/RestoreWorkflow.test.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/useProposalWrites.test.tsx
- src/app/(authenticated)/dashboard/operator/useOperatorConversation.ts
- src/app/(authenticated)/dashboard/operator/useProposalWrites.ts
- src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx
- src/app/api/operator/proposals/[id]/decline/route.ts
- src/app/api/operator/rules-timeline/route.ts
- src/lib/agents/operator/__tests__/apply.integration.test.ts
- src/lib/agents/operator/__tests__/policy-apply.integration.test.ts
- src/lib/agents/operator/__tests__/proposals.test.ts
- src/lib/agents/operator/__tests__/reads.integration.test.ts
- src/lib/agents/operator/__tests__/restore-locking.integration.test.ts
- src/lib/agents/operator/__tests__/restore.integration.test.ts
- src/lib/agents/operator/__tests__/snapshot.integration.test.ts
- src/lib/agents/operator/__tests__/turn-worker.integration.test.ts
- src/lib/agents/operator/apply.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/reads.ts
- src/lib/agents/operator/restore.ts
- src/lib/agents/operator/turns.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/auto-approval/posting-block-copy.ts` — 10 importer(s)
- src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx
- src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx
- src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx
- src/lib/agents/operator/__tests__/context.test.ts
- src/lib/agents/operator/__tests__/prompt.test.ts
- src/lib/agents/operator/__tests__/proposals.test.ts
- src/lib/agents/operator/__tests__/reads.integration.test.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/proposals.ts
- src/lib/auto-approval/__tests__/posting-block-copy.test.ts

## `src/lib/auto-approval/posting-status.ts` — 4 importer(s)
- src/lib/agents/operator/__tests__/context.test.ts
- src/lib/auto-approval/__tests__/posting-block-copy.test.ts
- src/lib/auto-approval/__tests__/posting-status.test.ts
- src/lib/auto-approval/settings.ts

## `src/lib/auto-approval/readiness.ts` — 4 importer(s)
- src/lib/admin/business-detail/mappers.ts
- src/lib/auto-approval/__tests__/readiness.test.ts
- src/lib/auto-approval/settings.ts
- src/lib/auto-approval/solicitation-settings.ts

## `src/lib/auto-approval/settings.ts` — 16 importer(s)
- scripts/ws8-staging-smoke.ts
- src/app/(authenticated)/settings/auto-approval/page.tsx
- src/app/api/settings/auto-approval/route.ts
- src/lib/agents/operator/__tests__/apply.test.ts
- src/lib/agents/operator/__tests__/policy-apply.integration.test.ts
- src/lib/agents/operator/__tests__/restore.integration.test.ts
- src/lib/agents/operator/apply.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/proposals.ts
- src/lib/agents/operator/reads.ts
- src/lib/agents/operator/restore.ts
- src/lib/auto-approval/__tests__/settings.integration.test.ts
- src/lib/auto-approval/__tests__/settings.test.ts
- src/lib/auto-approval/__tests__/suspension.integration.test.ts
- src/lib/auto-approval/solicitation-settings.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts
