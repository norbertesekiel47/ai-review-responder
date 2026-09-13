# Blast radius — importers of changed files (`feat/owner-operator-run-b`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/app/(authenticated)/dashboard/operator/OperatorClient.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx
- src/app/(authenticated)/dashboard/operator/page.tsx

## `src/app/(authenticated)/dashboard/operator/page.tsx` — 1 importer(s)
- src/app/(authenticated)/dashboard/operator/__tests__/page.test.tsx

## `src/app/(authenticated)/dashboard/operator/ProposalCard.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/operator/OperatorClient.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx

## `src/app/(authenticated)/dashboard/operator/ReceiptView.tsx` — 1 importer(s)
- src/app/(authenticated)/dashboard/operator/ProposalCard.tsx

## `src/app/(authenticated)/dashboard/operator/RequestedCapabilityCard.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/operator/OperatorClient.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx

## `src/app/(authenticated)/dashboard/operator/StarterActions.tsx` — 1 importer(s)
- src/app/(authenticated)/dashboard/operator/OperatorClient.tsx

## `src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/operator/OperatorClient.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/SummaryPanel.test.tsx

## `src/app/(authenticated)/dashboard/operator/wording.ts` — 8 importer(s)
- src/app/(authenticated)/dashboard/operator/OperatorClient.tsx
- src/app/(authenticated)/dashboard/operator/ProposalCard.tsx
- src/app/(authenticated)/dashboard/operator/ReceiptView.tsx
- src/app/(authenticated)/dashboard/operator/RequestedCapabilityCard.tsx
- src/app/(authenticated)/dashboard/operator/StarterActions.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx
- src/app/(authenticated)/dashboard/operator/page.tsx

## `src/app/(authenticated)/layout.tsx` — 1 importer(s)
- src/app/(authenticated)/__tests__/layout-role-gate.test.ts

## `src/app/api/operator/conversation/route.ts` — 1 importer(s)
- src/app/api/operator/__tests__/conversation-route.test.ts

## `src/app/api/operator/proposals/[id]/apply/route.ts` — 1 importer(s)
- src/app/api/operator/__tests__/apply-route.test.ts

## `src/app/api/operator/proposals/[id]/decline/route.ts` — 1 importer(s)
- src/app/api/operator/__tests__/decline-route.test.ts

## `src/app/api/operator/turns/route.ts` — 1 importer(s)
- src/app/api/operator/__tests__/turns-route.test.ts

## `src/app/api/settings/auto-approval/route.ts` — 1 importer(s)
- src/app/api/settings/auto-approval/__tests__/route.test.ts

## `src/components/dashboard/shell/active-nav.ts` — 5 importer(s)
- src/app/(authenticated)/settings/page.tsx
- src/components/dashboard/settings/SettingsSidebar.tsx
- src/components/dashboard/shell/MobileTabBar.tsx
- src/components/dashboard/shell/Sidebar.tsx
- src/components/dashboard/shell/__tests__/active-nav.test.ts

## `src/components/dashboard/shell/MobileTabBar.tsx` — 3 importer(s)
- src/app/(authenticated)/dashboard/operator/__tests__/page.test.tsx
- src/app/(authenticated)/layout.tsx
- src/components/dashboard/__tests__/MobileTabBar.test.tsx

## `src/components/dashboard/shell/Sidebar.tsx` — 2 importer(s)
- src/app/(authenticated)/layout.tsx
- src/components/dashboard/__tests__/Sidebar.test.tsx

## `src/lib/admin/impersonation/cookie.ts` — 14 importer(s)
- src/app/(authenticated)/settings/auto-approval/page.tsx
- src/app/admin/impersonate/[sessionId]/view/page.tsx
- src/app/admin/layout.tsx
- src/app/api/admin/impersonation/end/route.ts
- src/app/api/admin/impersonation/start/route.ts
- src/app/api/dashboard/__tests__/refusals-route.test.ts
- src/app/api/operator/__tests__/turns-route.test.ts
- src/app/api/operator/proposals/[id]/apply/route.ts
- src/app/api/operator/proposals/[id]/decline/route.ts
- src/app/api/operator/turns/route.ts
- src/app/api/settings/auto-approval/route.ts
- src/lib/admin/impersonation/__tests__/cookie.test.ts
- src/lib/admin/impersonation/view.ts
- src/lib/admin/shell-context.ts

## `src/lib/agents/operator/apply.ts` — 3 importer(s)
- src/app/api/operator/proposals/[id]/apply/route.ts
- src/lib/agents/operator/__tests__/apply.integration.test.ts
- src/lib/agents/operator/__tests__/apply.test.ts

## `src/lib/agents/operator/catalog.ts` — 6 importer(s)
- src/lib/agents/operator/__tests__/apply.integration.test.ts
- src/lib/agents/operator/__tests__/catalog.test.ts
- src/lib/agents/operator/apply.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/proposals.ts
- src/lib/agents/operator/render.ts

## `src/lib/agents/operator/proposals.ts` — 13 importer(s)
- src/app/(authenticated)/dashboard/operator/OperatorClient.tsx
- src/app/(authenticated)/dashboard/operator/ProposalCard.tsx
- src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx
- src/app/api/operator/proposals/[id]/decline/route.ts
- src/lib/agents/operator/__tests__/apply.integration.test.ts
- src/lib/agents/operator/__tests__/proposals.test.ts
- src/lib/agents/operator/__tests__/reads.integration.test.ts
- src/lib/agents/operator/__tests__/snapshot.integration.test.ts
- src/lib/agents/operator/apply.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/reads.ts
- src/lib/agents/operator/turns.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/agents/operator/reads.ts` — 5 importer(s)
- src/app/(authenticated)/dashboard/operator/OperatorClient.tsx
- src/app/(authenticated)/dashboard/operator/SummaryPanel.tsx
- src/app/api/operator/conversation/route.ts
- src/app/api/operator/turns/[id]/route.ts
- src/lib/agents/operator/__tests__/reads.integration.test.ts

## `src/lib/agents/operator/schema.ts` — 23 importer(s)
- src/app/(authenticated)/dashboard/operator/ProposalCard.tsx
- src/app/(authenticated)/dashboard/operator/ReceiptView.tsx
- src/lib/agents/operator/__tests__/apply.integration.test.ts
- src/lib/agents/operator/__tests__/apply.test.ts
- src/lib/agents/operator/__tests__/proposals.test.ts
- src/lib/agents/operator/__tests__/reads.integration.test.ts
- src/lib/agents/operator/__tests__/render.test.ts
- src/lib/agents/operator/__tests__/schema.test.ts
- src/lib/agents/operator/__tests__/snapshot.integration.test.ts
- src/lib/agents/operator/__tests__/turn-worker.integration.test.ts
- src/lib/agents/operator/apply.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/model-call.ts
- src/lib/agents/operator/prompt.ts
- src/lib/agents/operator/proposals.ts
- src/lib/agents/operator/reads.ts
- src/lib/agents/operator/render.ts
- src/lib/agents/operator/turns.ts
- src/lib/llm/tasks.ts
- src/lib/responses/__tests__/model-pinning.test.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts
- worker/jobs/agent-turn/__tests__/failed-hook.test.ts
- worker/jobs/agent-turn/failed-hook.ts

## `src/lib/agents/operator/version-token.ts` — 5 importer(s)
- src/app/api/operator/proposals/[id]/apply/route.ts
- src/lib/agents/operator/__tests__/version-token.test.ts
- src/lib/agents/operator/apply.ts
- src/lib/agents/operator/proposals.ts
- src/lib/agents/operator/schema.ts

## `src/lib/shared/protected-routes.ts` — 4 importer(s)
- src/lib/auth/__tests__/helpers/admin-gate-mocks.ts
- src/lib/auth/verified-identity.ts
- src/lib/shared/__tests__/protected-routes.test.ts
- src/proxy.ts
