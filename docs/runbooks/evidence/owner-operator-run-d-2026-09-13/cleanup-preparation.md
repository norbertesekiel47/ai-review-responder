# Run D cleanup procedure — executed September 14

Completed: [cleanup-result.json](cleanup-result.json). All 101 exact public fixture rows and the synthetic Auth identity were removed; independent readbacks found zero captured IDs, zero rows in 54 ownership scopes, and zero Auth users/identities/sessions/refresh tokens. All 27 captured terminal jobs were removed individually and absence-checked. The following text preserves the preparation procedure; it is not an open cleanup obligation.

Prepared from staging schema introspection and the current synthetic outbox inventory on 2026-09-14. This file does not close any teardown obligation. The owner explicitly ended observation early; its final capture is **2026-09-14T17:36:31.857381Z**, after 19h50m14.857381s. All 24 submitted requests completed. The sampler was stopped and both original log segments preserved. The original full-day deadline is superseded by [the owner decision](observation-owner-early-close.json); do not restart observation or submit cancelled slots.

Target: staging Supabase `kubdiqdhqbhwmqfditeg`; Railway project `ad641d0e-dc01-4250-b71c-db1beedb9c8c`, environment `58c06358-8cbe-497f-bec0-df3b47769a10`, worker service `fb413c72-29b6-4cd1-90c2-26002491e301`. Production `udeyaqnvpojbwgoaxwdg` is never a fixture target.

## Fixed fixture identities

- Account `019f43d0-0000-7000-8000-000000000001`; application owner `019f43d0-0000-7000-8000-000000000002`.
- Auth `856a970a-45a9-43a4-a9a4-71261f7b4fb7`, email `run-d-c48bb6a6@e2e.repworth.net`. Existing helper `/private/tmp/run-d-auth.mjs` validates this exact identity. Never print its private browser login binding.
- Salon `019f43d0-0000-7000-8000-000000000011`; Cafe `019f43d0-0000-7000-8000-000000000012`.
- Conversation `2d4ae2aa-73df-40e9-8ac8-05a05ce7f8f4`; observation turns come from the final submission ledger. T3/T4 IDs remain in the main evidence ledger.
- Review `01a09caf-8108-73db-8cd3-a5dcf3dc6dce`; response `01a09caf-9893-76dd-8f8c-0a8f41f3d67d`; generation outbox `01a09caf-82ca-779c-b401-a49ce70f5ebd`; run `01a09caf-81a2-70eb-8061-2c372a96dd78`.

## Before any deletion

1. Preserve all three final observation queries/results, the complete browser submission ledger, all attempt files, health samples, candidate/flag readbacks, and screenshot evidence. Interim 08 files are not the final denominator.
2. Refresh the account-scoped outbox inventory and exact terminal BullMQ metadata. At the eight-hour checkpoint the inventory had 15 completed outboxes: 12 observation turns, T3, T4, and one `generate_response` row. More hourly turns are still due. Never use this interim list as the final deletion list.
3. Preserve matched logs and queue metadata before removing jobs. Read-only helper `/private/tmp/run-d-observe-jobs.py` accepts 1–30 exact `<outbox UUID>_<attempt>` IDs, pins all Railway IDs, validates each job's account, and emits no raw payloads or credentials. It changes no queue state. For final checkpoint jobs include the two T3/T4 agent-turn IDs too; handle the generation queue separately using its source-verified queue name and exact generation job ID.
4. Verify no synthetic turn or outbox remains accepted/running/in flight. The review-handler run legitimately remains open awaiting owner approval; that status is not proof of an active queue job. Verify the response is still unposted/unapproved and both locations still have no Google/Zernio connection. Confirm the account has no Stripe customer/subscription before any fixture removal.
5. Sign out the synthetic browser owner and verify zero sessions for the exact Auth UUID. Do not delete Auth first and assume existing sessions were revoked. After session refresh, the campaign uses tab 1. Temporary paired tab 2 was closed and its absence verified. Leave the user's Vercel tab 3 alone.

## Database ordering and ownership

[Foreign keys](cleanup-foreign-keys-preparation.json) and [interim outbox inventory](cleanup-outbox-inventory-partial-08.json) were read from staging. The account/user ownership pair is deferred; remove both in one transaction. Several Operator, cost, audit and refusal references have no deletion cascade. Analytics references use SET NULL, so delete synthetic analytics explicitly before deleting their parent rows or the cleanup loses its account/identity lookup.

At final execution, build one explicitly reviewed transaction with an elapsed-window guard and exact account/user/Auth/email/location identity checks. Select only the final retained outbox IDs whose topic/aggregate/payload binding matches the fixture. A JSON account claim alone does not authorize deleting an outbox bound to another tenant. Abort on unexpected binding, nonterminal work, posting connections, external billing identity, or an unknown fixture-owned topic; inspect before widening the deletion set.

Delete exact owned outbox rows while their bound turn/review rows still exist; then scoped notification deliveries, review escalations, refusal events, approval/account audits, API costs, analytics, channel enrollments, solicitation suppressions and impersonation fixtures if present. Delete Operator proposals/unsupported requests/turns/conversation before locations and owner. Remove review outcomes/runs (steps cascade), responses/reviews and the remaining fixture-owned dependents before locations. Delete the two locations, application owner and account in the same transaction, respecting the verified deferred owner cycle. Let constraints abort unexpected references; do not disable constraints or delete by broad dates/name patterns.

After commit, run explicit zero-count readback for every ledger identity and dependent relation, including all captured outbox/step IDs from the final inventory. Remove only exact completed/failed BullMQ jobs after saving their metadata and checking their tenant identity; verify each job is absent. Never flush a queue or Redis database. Delete the exact email-checked synthetic Auth identity through the existing helper, then verify Auth user, identities, sessions and refresh tokens are absent. Preserve the actual readback result, not only a cleanup command's exit code.

## Baseline restoration and final disposition

Read back the worker flags: OWNER_OPERATOR=true, AUTO_APPROVAL=false, JUDGE=true, MOCK_EXTERNAL_APIS=false. No D flag change was needed. Keep Vercel's existing write-only AUTO_APPROVAL readback limitation explicit; do not invent its value. Preserve configured Sentry rule 3985600. Verify the agent-turn queue is unpaused and the old T4 ownership/guardian markers remain absent; do not invoke another pause. Reset the viewport and close only synthetic campaign tabs. Mark the main teardown ledger closed only after all readbacks pass, and attach the final cleanup evidence before D's final review gate.
