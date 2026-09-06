---
paths:
  - "src/app/api/_shared/channels/**"
  - "src/app/api/admin/channels/**"
  - "src/app/api/dashboard/channels/**"
  - "src/lib/channels/**"
  - "src/lib/messaging/**"
  - "worker/jobs/auto-post-notice/**"
  - "worker/ingress/telegram/**"
  - "worker/ingress/twilio/**"
---

# Channels rules

## Read first

- Roll out / test the Telegram + WhatsApp channels, the auto-approved post FYI (`auto_post_notice` topic, `worker/jobs/auto-post-notice/`), or its `/r/google/<id>` redirect: runbooks `docs/runbooks/channels-rollout.md` (prod flip) + `docs/runbooks/channels-staging-smoke-test.md` (staging test) + `docs/runbooks/whatsapp-templates.md` (template content) + ADR `docs/adr/0003-conversational-channel-seams.md` (future-agent seam)
- The 12 mobile-channel enrollment routes (`{admin,dashboard}/channels/{telegram,whatsapp}/{start,cancel,disable}`), the shared runners, the **Channel actor** resolvers: `docs/context/core-accounts-channels-admin.md` → **Channel actor** (LOCKED) + spec `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §4. Rules + why: `docs/directory/app-api-a.md` / `app-api-b.md` § `api/_shared/channels/` + `docs/directory/app-admin.md` § `app/admin/`.
- File map: `docs/directory/lib-notifications-channels-messaging.md` § `channels/` and § `messaging/`; `docs/directory/worker-ingress.md` (telegram/, twilio/); `docs/directory/worker-jobs-*.md` (auto-post-notice/).
- Lab notes: `.claude/reference/lab-notes/ingress-rate-limiting.md`, `.claude/reference/lab-notes/billing-multi-location.md` (channel account-scope desync).
- The org-default enrollment gotcha (account-scoped, `location_id IS NULL`) stays in `.claude/CLAUDE.md` § Non-obvious gotchas.

## Traps

The 12 mobile-channel enrollment routes:

- (a) routes are thin shims — behaviour lives in the runner or resolver (`src/app/api/_shared/channels/`), never a route; (b) `resolveAdminActor` reads `businessId` from the BODY, `resolveOwnerActor` reads `locationId` from the SESSION — tenant boundary, keep TWO functions; (c) `ChannelRouteConfig` is 4 fields — a fifth means the seam is wrong. The admin MFA gate is configuration, not structure — `ci:admin-aal2` compensates.

## Rules

- Nothing beyond the traps was moved from `.claude/CLAUDE.md`; invariant #6 (third-party ingress terminates on Railway) binds the Telegram and Twilio ingress.

- **Owner channel enrollment org-default is account-scoped** — keyed by `account_id` + `channel` + `location_id IS NULL`. `business_id` is a legacy FK written on INSERT but NOT used for org-default lookup. All cancel/disable enrollment helpers take `accountId`.
