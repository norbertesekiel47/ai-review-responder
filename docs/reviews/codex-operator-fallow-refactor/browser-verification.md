# Operator refactor — Computer browser verification

## Scope and environment

Verified on 2026-09-15 America/Los_Angeles (backend timestamps extend into 2026-09-16 UTC), using Computer Use through `cua_repl` and the in-app browser. Browser actions were performed by the root agent. This report records those observations and separately checked backend evidence.

| Target | Checkout | Browser URL |
|---|---|---|
| Before | Root checkout at `87591310` | `http://localhost:3100/dashboard/operator` |
| After | Refactor worktree at `8ea2ac28f49724dd6df65435fe956d781dd72638`; product baseline `2ac6ff871b4496f996c37aaaaade9bdc7eee9a62` | `http://localhost:3101/dashboard/operator` |

The after checkout's product code is unchanged from the stated product baseline. Each target used its own disposable synthetic owner, with identical visible names **E2E Harness Owner** and **Operator Test Restaurant**, and initial tone **professional and friendly**. Auth and database settings pointed to the same staging Supabase project. Credentials and login URLs remained private scratch data and are not included here.

Local app processes enabled the Operator and policy readiness flags and mocked external calls locally. No remote configuration was changed. The existing auth and Operator E2E helpers supplied fixtures. In particular, the owner sent each initial instruction through the real browser UI; a scratch watcher then called the existing production-builder-backed completion helper to supply the proposal. This exercises browser routes and persisted outcomes but does not establish live LLM or Railway worker verification. The shared staging worker was not isolated: cleanup diagnosis found one owned `api_costs` row for OpenAI `owner-operator`, USD 0.000634, with 3,797 input and 107 output tokens. Consequently, this campaign must not be described as making no LLM calls.

## Before/after voice journey

The same sequence ran on both targets:

1. Sign in as the disposable owner and open Operator.
2. Enter **Make my replies warmer.** and click **Send**.
3. Complete the accepted turn with the existing voice-proposal helper.
4. Inspect the proposal at desktop and mobile sizes.
5. Click **Apply**, inspect the receipt at both sizes, and query persisted state.

Expected: a proposal for **warm and brief**, then a successful receipt, exactly one turn, an applied proposal with no failure reason, and persisted tone **warm and brief**.

Observed: both targets met those expectations. `before-backend.txt` and `after-voice-backend.txt` each contain one turn, one applied proposal, a stored receipt, no failure reason, and the expected tone. Neither initial voice fixture had policy rows, policy audits, or reviews. Fresh disposable fixtures were used for the final screenshot recapture: `recapture-before-backend.txt` and `recapture-after-backend.txt` independently confirm the same result, including one turn and no failure reason on each target.

### Screenshot evidence

The eight linked files below are **normal viewport captures**, replacing preliminary full-page screenshots preserved only in the scratch evidence directory. DOM reads confirmed desktop viewports of **1440 × 900** and mobile viewports of **390 × 844**. The screenshot backend returned normalized JPEG bitmaps of **1425 × 891** and **375 × 812**, respectively. `sips` converted these to PNG without resizing or painting; the PNG dimensions therefore differ from the requested viewports. The captures preserve screenshot-backend pixels, not exact CSS-pixel viewport dimensions. The after desktop-proposal blank frame was replaced with a fresh capture. Independent visual review passed all four comparison pairs and found no concrete visual regression. Expected differences are timestamps and fixture UUIDs; the mobile proposal pair also has the scroll offset noted below. The development indicator obscures the same tiny area in each comparable capture. No exact pixel-identity claim is made.

| Capture | Before scroll Y | After scroll Y |
|---|---:|---:|
| Desktop proposal | 0 | 0 |
| Desktop receipt | 600 | 600 |
| Mobile proposal | 864 | 860 |
| Mobile receipt | 1509 | 1509 |

The mobile proposal pair has a 4-pixel manual scroll difference. The preliminary full-page captures had capture-related geometry differences, including a 7-pixel horizontal shift and a 140-pixel footer-position difference; those superseded images are not the final comparison evidence.

| State | Before | After |
|---|---|---|
| Proposal, 390 | [Before proposal 390](browser-before-proposal-390.png) | [After proposal 390](browser-after-proposal-390.png) |
| Proposal, 1440 | [Before proposal 1440](browser-before-proposal-1440.png) | [After proposal 1440](browser-after-proposal-1440.png) |
| Receipt, 390 | [Before receipt 390](browser-before-receipt-390.png) | [After receipt 390](browser-after-receipt-390.png) |
| Receipt, 1440 | [Before receipt 1440](browser-before-receipt-1440.png) | [After receipt 1440](browser-after-receipt-1440.png) |

## Additional after-target journeys

| Journey | Actions and expected result | Observed result and persistence evidence |
|---|---|---|
| Restore | Click **Restore** on the voice receipt, inspect the reverse proposal, then click **Apply**. Tone should return to the prior value. | UI completed Restore. `after-policy-backend.txt` includes the separate applied reverse proposal and receipt from **warm and brief** to **professional and friendly**; current tone is the latter. |
| Policy scope confirmation | Seed the existing five-review synthetic history; send the instruction to auto-reply to 4 and 5 star reviews at all locations through the UI; complete using the existing policy helper. A near-match confirmation should fail client validation; exact confirmation should enable Apply. | `all locations ` with a trailing space kept confirmation disabled. Exact **all locations** enabled it at the 390-wide viewport. Applying displayed **Active rule** and consequence counts of 2 eligible out of 3, excluding 1 imported review and 1 with unknown origin. |
| Policy persistence | Reload after applying. The saved rule and receipt should remain. | Reload preserved the rule. `after-policy-backend.txt` records 1 policy row, threshold 4, 1 policy audit, and 5 reviews. This reload is persistence coverage; it is not a direct duplicate-apply API replay test. |
| Stale proposal refusal | Send a voice instruction through the UI and complete its proposal. After the card renders, use existing `moveVoiceRow` to change tone to **formal and precise**. Click **Apply**. It should refuse the outdated proposal without overwriting that concurrent edit. | UI showed the stale refusal. `after-stale-backend.txt` records status `stale`, failure reason `version_mismatch`, and no receipt for that proposal; tone remains **formal and precise**. |
| Refresh stale plan | Click **Refresh plan**. The real route should prepare a new proposal from the current settings; apply that refreshed proposal. | The route created a new proposal from **formal and precise**. A subsequent helper completion attempt found no accepted turn because the route had already completed it. `after-stale-backend.txt` captures that new proposal pending, with 4 turns total. Root subsequently observed the refreshed Apply produce a **warm and brief** receipt. `after-final-backend.txt` confirms the refreshed proposal applied with a receipt and no failure reason, current tone **warm and brief**, and 4 turns total. |

The policy state remained at 1 row, threshold 4, 1 audit, and 5 reviews in the stale-path snapshot. That snapshot records 4 account-scoped outbox rows; the earlier policy snapshot records 2. These are point-in-time counts and do not establish worker delivery.

## Evidence interpretation and limitations

The backend and cleanup text files referenced here are scratch verification records in `/private/tmp/operator-browser-evidence/`, not committed artifacts. Their sanitized outcomes are recorded above. The backend text files begin with pnpm status output; their JSON payload starts at the first `{`. The recorded JSON was parsed successfully when preparing this report. Proposal status and receipt evidence come from the persisted rows, not only screen text. All fixture identifiers and content are synthetic.

- Final first-pass persisted state has proposal statuses **applied / applied / applied / stale / applied**, with no receipt on the stale proposal and receipts on all four applied proposals. Policy state remains 1 row, threshold 4, 1 audit, and 5 reviews.
- Initial baseline fixture cleanup returned zero account/user/business/Auth-user residue. Initial after-fixture owner deletion was blocked by `api_costs_business_id_fkey`; after preserving the sanitized cost summary, targeted cleanup using the existing seed pattern succeeded and returned zero for the same four counts. `recapture-before-cleanup.txt` and `recapture-after-cleanup.txt` confirm all four counts are zero for both recapture fixtures.
- All four viewport comparison pairs passed independent visual review after the final desktop-proposal replacement. `final-recapture-cleanup.txt` confirms zero account/user/business/Auth-user residue for the final capture fixture. The browser viewport was reset, its tab was closed, and the owned local launchers were stopped.
- Live LLM generation and Railway worker behavior were not verified by this browser campaign. An owned cost row shows the shared staging worker/provider path may have executed alongside helper completion; local mocking did not isolate that worker.
- The owner subsequently explicitly approved the exact 287 documented discovery corrections. That separate approval is not inferred from browser evidence. Guard/manifest integration is owned by the root task; this report does not activate continuation admission.
