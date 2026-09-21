# Blast radius — importers of changed files (`fix/1363-drip-alert-email-idempotency`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/lib/approval/create-link.ts` — 5 importer(s)
- src/lib/approval/__tests__/create-link.test.ts
- worker/jobs/EngagementAlertWorker.ts
- worker/jobs/OnboardingDripWorker.ts
- worker/jobs/notification/dispatch.ts
- worker/jobs/pending-post-notice/dispatch.ts

## `src/lib/notifications/email/templates/internal.ts` — 4 importer(s)
- src/lib/notifications/contact-notify.ts
- src/lib/notifications/email.ts
- src/lib/notifications/email/__tests__/raw-passthrough.test.ts
- src/lib/notifications/email/templates/__tests__/internal.test.ts

## `worker/jobs/EngagementAlertWorker.ts` — 2 importer(s)
- worker/index.ts
- worker/jobs/__tests__/EngagementAlertWorker.test.ts

## `worker/jobs/OnboardingDripWorker.ts` — 6 importer(s)
- worker/background/schedulers/OnboardingDripScheduler.ts
- worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts
- worker/index.ts
- worker/jobs/__tests__/OnboardingDripWorker.test.ts
- worker/jobs/__tests__/onboarding-drip.integration.test.ts
- worker/jobs/notification/__tests__/bounced-skip.test.ts
