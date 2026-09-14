# Dispatch-exhaustion browser check preparation

Status: executed and verified on September 14. [Actual result](recovery-check-result.json) records the controlled fixture, its setup correction, browser reload/recovery at both dimensions, unchanged settings, and zero model calls. [Cleanup result](cleanup-result.json) confirms its subsequent removal. The steps below preserve the procedure; preparation-era statements are historical.

Run this check after the observation has ended and its final source data has been captured. The owner explicitly ended the observation early on September14; the retained final capture is17:36:31.857381Z after19h50m14.857381s. See [owner decision](observation-owner-early-close.json). Preserve the observation conversation and its denominator. Use a separate conversation under the designated synthetic Run D account, then include the new exact IDs in the teardown inventory.

The existing component case `operator dispatch exhaustion renders a recovery action from the durable transcript` in `src/app/(authenticated)/dashboard/operator/__tests__/OperatorClient.test.tsx` proves the expected text and recovery button. The real-DB poller cases separately exercise the production dispatch-failure transition. Neither substitutes for this browser check.

## Fixture and backend proof

Before writing, revalidate the staging project, exact deployed candidate, synthetic account/user/location ownership, and cleanup ledger. The [prepared runner](recovery-check-runner.mjs) seeds an accepted turn and its outbox with the shared enqueue helper, then induces terminal dispatch state and calls the production `reconcileTurnForFailedOutbox` function, all inside one transaction. No pending row is committed for a poller to claim, no queue is paused, and no model is called. This checks the durable browser recovery path from a controlled domain fixture; it is not evidence of a naturally observed transport outage or five actual failed dispatch attempts. The separate real-DB tests drive `runOutboxDispatchFailure` and prove its poller wiring and atomicity.

The runner requires `RUN_D_FINAL_OBSERVATION_CAPTURE_AT` at or after the actual retained final measurement,17:36:31.857381Z, and before its execution. The original24-hour guard is superseded only by the owner's explicit early-close decision. It pins the Railway project/environment/service, deployed candidate, Supabase project, and exact synthetic owner/Auth/location. Its fixed conversation/turn/client-key/outbox IDs end in031/032/033/034 are already registered in the teardown ledger. Existing IDs fail closed. Its30-second deadline or any failure requires an exact-ID readback before retry because a commit acknowledgement can be lost.

Preparation validation: `node --check` passed; the runner has not been executed. Read-only guard preflight at `2026-09-14T08:13:57.400Z` confirmed the running worker's `RAILWAY_GIT_COMMIT_SHA` equals `4b13d96621b156a47dbc4140995f45745bc8114d` and its database URL identifies staging project `kubdiqdhqbhwmqfditeg`. Only that candidate value and a project-match boolean were emitted; no connection string or credentials were printed. Revalidate at execution time.

Capture the turn and temporary outbox inside the fixture transaction after the production reconciliation, including status, failure reason, attempt ownership, and completion timestamps. Then retire only that exact synthetic outbox in the same transaction, before commit; the failed turn remains for the browser. This matters because `checkFailedOutboxByTopic` correctly alerts on a durable failed `agent_turn` outbox, and this check is not an alert-delivery drill. Existing monitoring stays active. Label the captured outbox as an in-transaction snapshot, not a durable row after commit. The committed turn must be failed with `dispatch_exhausted`, with zero new settings proposals/receipts and no settings write. Keep the fixture outside the completed observation cohort.

## Browser steps and expected results

1. In the existing authenticated in-app browser, open the recovery conversation at 390px. Expect: “We could not start this message after several attempts. Nothing was changed. Start a new conversation to try again.” and a “Start a new conversation” action.
2. Reload. Expect the same durable failure and recovery action, with no continuing preparation indicator.
3. Capture a sanitized screenshot and the observed result, then repeat the durable failure/reload check at 1440px.
4. Activate “Start a new conversation.” Expect navigation to `/dashboard/operator` without the failed conversation ID and a usable empty composer. Record the actual resulting URL and visible state. No new provider request is needed to prove this navigation.
5. Return to the old conversation and confirm its stored failure still exists. Capture its final backend row, verify the temporary outbox is absent, and include the remaining exact IDs in the scoped cleanup plan.

Record actual UTC timestamps, browser dimensions, target URL, screenshots, expected/observed results, and any deviation. This document is a preparation checklist only and must not be cited as PASS evidence.
