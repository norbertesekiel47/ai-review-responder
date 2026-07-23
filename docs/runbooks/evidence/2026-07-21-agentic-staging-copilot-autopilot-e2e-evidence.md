# Evidence — Agentic staging E2E: Copilot + Autopilot (WS1–WS8)

Runbook: `docs/runbooks/agentic-staging-copilot-autopilot-e2e.md`
Scope this run: **Phases A–C** (Copilot + Guardian + Autopilot autonomy). Phase D (WS8) out of scope.

## Environment
- **Env:** staging
- **Supabase (staging):** `RepWorth-staging` / `kubdiqdhqbhwmqfditeg` (prod `udeyaqnvpojbwgoaxwdg` NEVER touched)
- **Worker:** https://repworth-worker-staging.up.railway.app
- **UI:** https://staging.repworth.net
- **Zernio ingress:** https://repworth-worker-staging.up.railway.app/ingress/zernio
- **Git SHA at start:** a88b4871
- **UTC start:** 2026-07-22T01:37Z
- **Target business_id / account_id:** _TBD (new account to be created post-wipe)_
- **GBP posture:** REAL live business (owner-authorized). Reviews benign + minimal + deleted immediately after each phase. All posted reviews/replies tracked below for teardown.

## Preflight
| Check | Result | UTC |
|---|---|---|
| Staging Supabase wiped, admin `norbertesekiel@gmail.com` preserved (auth + app rows) | ✅ users_remaining=1; all tenant tables=0 | 01:35Z |
| §1.1 schema (migrations 071–083 by introspection) | ✅ agent_runs/steps, reviews.triage_* (7), review_escalations, judge_verdicts, trust-dial cols (2), poller_cursors, job_outbox.completion_reason | 01:30Z |
| §1.2 worker health | ✅ `{"status":"ok"}` uptime ~990s | 01:37Z |
| §1.3 autonomy flag baseline (all 6 OFF) | ⚠️→✅ Staging was found in FULL-AUTOPILOT state (TRIAGE/ESCALATION/JUDGE/GOVERNOR/AUTO_APPROVAL all=true). Flipped all 5 to false → Copilot baseline. Deploy b6dc3ce5 triggered. | 01:41Z |
| §1.4 test business + active/trialing sub + GBP via Zernio | ⏳ pending new account + connect | — |
| §1.5 owner notification channel enrolled | ⏳ pending | — |

**Other env (correct):** MOCK_EXTERNAL_APIS=false, SELF_SERVE_SIGNUP_ENABLED=true, TRIAL_ENABLED=true, DAILY_COST_LIMIT_CENTS_AUTOPILOT=1500, AUTOPILOT_PURCHASABLE=false.
**Railway note:** Railway MCP token is NOT authed; using Railway CLI (authed as norbertesekiel, linked repworth/staging/repworth-worker) for all flag ops.
**Signup account:** norbertliverpool@gmail.com (OTP read via Gmail connector).

### Runbook defects found during preflight (report upstream)
- **§1.1 check is wrong:** it expects `to_regclass('public.review_triage')` non-null, but migration 072 adds `triage_*` COLUMNS to `reviews` — there is no `review_triage` table. Correct check: `reviews` has 7 `triage_*` columns.
- Episodic note said migration 083 adds an `owner_unreachable` column; it actually adds `completion_reason` (holds value `'owner_unreachable'`).

## 🔴 BLOCKER found during onboarding — trial checkout bug (fixed)

**Symptom:** After Stripe checkout, onboarding stuck on "Processing your payment…"; account never left `pending_payment`.

**Root cause:** Card-up-front 30-day trial created a valid `trialing` subscription in Stripe (`sub_…B7ItNE05`, trial window exactly 30 days, $0 invoice `amount_paid:0`), but the Checkout Session came back `payment_status: "paid"` (Stripe issued a $0 setup invoice). `trialContractMatchesLease` (`worker/ingress/stripe/checkout-completed.ts:116`) accepted only `no_payment_required` for trials → flagged `invalid_trial` → `cancelUnexpectedSubscription` auto-cancelled the sub (`cancellation_requested`, +4s) → account stranded `pending_payment`.

**Evidence:** inbound_events: `checkout.session.completed` processed 01:57:57 (no activation) → `customer.subscription.deleted` 01:58:14 failed ("No account found for cus_UvgnhW7lBksQ4C"). Sentry `repworth-staging`: `invalid_trial` @01:57:57Z, `stale_checkout_attempt` @01:58:04Z.

**Impact:** Breaks EVERY card-up-front trial signup (launch-relevant). Existing tests only covered `no_payment_required` — the real `paid` path was never tested.

**Fix:** PR #518 (`fix/trial-checkout-paid-payment-status`) — accept both `paid` and `no_payment_required` for trials (`subscription.status==='trialing'` + 30-day window is the real guarantee nothing charged). Regression test added. Deployed to staging worker via `staging` push (deploy 6e393edf) for E2E validation; PR open to main.

## ✅ Trial fix validated on staging
After deploy 6e393edf, redoing checkout activated the account: `subscription_status='trialing'`, tier=copilot, new `cus_Uvh77ooTcSJOHJ` / `sub_1TvpjM…`, trial_ends 2026-08-21. PR #518 confirmed working end-to-end.

## 🟠 BLOCKER found during onboarding wizard — Google Maps billing (resolved)
**Symptom:** Location step autocomplete dead; console `403` + `<gmp-place-autocomplete>: The caller does not have permission` on `places.googleapis.com/…AutocompletePlaces`.
**Root cause:** **Billing DISABLED on GCP project `repworth` (490954435940)** — Places API (New) requires active billing → blanket `PERMISSION_DENIED`. Key `cc389070` restrictions were CORRECT (Places New allowed, `staging.repworth.net/*` referrer allowed); the API was enabled. One RepWorth project + one key ⇒ **prod likely affected too**.
**Resolution:** Owner re-enabled billing (account `01DB3B-773A7C-23467B`). Verified `billingEnabled=True`; live `places:autocomplete` test returned HTTP 200 with suggestions. Autocomplete restored.
**Note:** paste-a-Maps-URL fallback (SerpAPI, `place-prefill/route.ts`) is independent of Google billing — usable if Maps ever 403s again.

## 🔴 BLOCKER found during onboarding wizard — page/route flag drift (fixed)
**Symptom:** After Voice, dashboard stuck "(pending setup)"; "Set up business" loops back to onboarding; nothing persists (name="(pending setup)", google_place_id=null, onboarding_wizard_completed_at=null).
**Root cause:** `page.tsx` chooses demo-vs-non-demo via `shouldUseDemoWizard(flag,row)` → renders the location-capturing wizard for a trial with no location. But `POST /api/onboarding/business` read the **raw** `onboardingDemoEnabled()` → took the post-pay branch → rejected the submitted `googlePlaceId` with `409 onboarding_not_started` → `/start` → `/dashboard` → loop. Page and route disagreed on one flag. (Triggered here because the account reached the wizard with no pre-captured location — a documented card-up-front-trial case the page handles but the route didn't.)
**Fix:** PR #519 (`fix/onboarding-business-route-demo-flag`) — route now uses the same `shouldUseDemoWizard(onboardingDemoEnabled(), bizRow)` helper as the page. Test that encoded the bug rewritten. Deployed to staging (Vercel `rep-worth-1sqegyw2n` Ready + worker). Wizard Location step now renders + captures.
**Related note:** dashboard "Set up business" → `/onboarding/business` hard-link + demo-flow `/start` bouncing paid users is a latent dead-end for any paid-without-location account; the route fix resolves the loop, but a belt-and-suspenders recovery path is worth a follow-up.

## Posted-artifact tracker (for teardown)
| Phase | Google review posted | Reply posted | Removed? |
|---|---|---|---|
| A | 5★ "Very good resort alongside great food" by Norbert Esekiel on Tancia Resort (~2026-07-22 ~02:1xZ) | pending approval | NO — remove in teardown |

**Preconditions closed:** §1.1 schema ✓, §1.2 worker ✓, §1.3 flags all-off ✓, §1.4 business/sub/GBP-via-Zernio ✓ (Tancia Resort, place_id ChIJqb_7RPR5UDcR6xUi5sIklYk, zernio active, trialing), §1.5 email channel ✓.
**Backfill baseline (pre-Phase-A):** 65 reviews, 65 responses (50 pending_approval drafts + 15 posted), 50 agent_runs (spine OK: review_ingested→draft_generated→moderation_checked→policy_gate, outcome reply_drafted), 0 notifications. WS1 spine already validated.
**Phase A live-ingest test in progress:** awaiting Google→Zernio ingest of the new review (ZernioRecentReviewPoller 5-min cadence).

## Phase A — Copilot (ingest → draft → owner approve → real post → spine) — ✅ PASS (2026-07-22 ~07:29Z)
Full-loop on live Tancia Resort profile, new review 5★ "Very good resort alongside great food" (Norbert Esekiel), review `019f88a1-3447…`, response `019f88a1-4460…`:
- Live ingest (post-backfill, detected 07:01) → draft → moderation → spine ✓
- Owner notification sent (notification_deliveries=1) + approval_links=1 (hashed token) — live path, backfill had 0 ✓
- Approved via /approve token flow → `status=posted`, `approval_method=owner`, approved 07:28:56 → posted 07:29:07 ✓
- Spine: review_ingested→draft_generated→moderation_checked→policy_gate→**reply_posted** (all completed); outcomes reply_drafted, reply_approved_no_edit, reply_posted; run **completed** ✓
- Reply live on Google (owner visual confirm pending). Publish job drained (0 pending).
**Verdict: Copilot ships-today path PROVEN.**

## Phase B — Guardian (triage + escalation, no autonomy) — ✅ PASS (core) (2026-07-22 ~07:48Z)
Flags: TRIAGE_ENABLED=true, ESCALATION_ENABLED=true (JUDGE/GOVERNOR/AUTO_APPROVAL still off). Run on EXISTING real reviews via regenerate (no fake negative review posted).
- **WS2 triage PROVEN** — discriminates severity: 2★ Prashant G → `medium/respond`; empty 1★ → `low/respond`; 1★ "Extremely Poor Service…" (Akshay) → `high/respond_and_escalate`; 1★ Dinesh → `medium/respond_and_escalate`. Each has an `api_costs endpoint='review-triage'` row + a `triage` spine step (on reviews that had runs). `triage_source=llm_triage_v1`.
- **WS3 escalation PROVEN** — 2 `review_escalations` rows `status=escalated`; **escalation-notice emails sent + delivered** to owner (`channel=email, template=escalation_notice`). Acknowledge→`acknowledged`→Resolve→`resolved` lifecycle exercised (HTTP 200, dashboard endpoints).
- **B6 reply still needs approval** ✓ — negative reviews' regenerated drafts are `pending_approval` v2 (autonomy off, nothing auto-posted).
- **Caveat (not a defect):** escalation `agent_run_id` is null for Akshay/Dinesh → no `escalation_raised` step/`review_escalated` outcome attribution. Root cause: they were among the 15 backfill *posted* reviews that never had an `agent_run` created (backfill only spins runs for unresponded drafts). Full spine attribution would need a fresh live escalate-worthy review; owner opted not to post a fake negative. Escalation raising tolerates a null run (robust).
- **Trigger note:** escalate-worthy 1★s were `posted` (dashboard regenerate 409s on posted), so re-enqueued via a manual `job_outbox generate_response` v2 insert (owner-authorized; auto-classifier initially blocked). Real worker path otherwise.
**Verdict: Guardian classify→escalate→notify PROVEN on live data.**

## Phase C — Autopilot autonomy (judge + governor + auto-approval) — IN PROGRESS
**Precondition finding (runbook gap):** auto-approval RUNTIME gate (`worker/jobs/response-generation/auto-approval.ts`) requires `origin_lane=live_ingest_new` + `version=1` + `tierGrantsAutopilot(subscription_tier)` + policy threshold + moderation-clean + active location/zernio + `AUTO_APPROVAL_ENABLED`. It does NOT require `AUTOPILOT_PURCHASABLE` (that gates only the settings UI readiness). So autonomy needs an **autopilot-tier account** — which the runbook's Phase-C-before-D ordering doesn't call out. Runbook §4.2's "veto_window_minutes=5" is also invalid: DB CHECK allows only `(15,30)`.
**Setup (deviations, owner-authorized scope expansion):**
- `accounts.subscription_tier='autopilot'` via SQL (tier is normally Stripe-derived via WS8 cutover; SQL flip is a test shortcut — watch for billing-reconciliation revert).
- Seeded `auto_approval_policies` (account-level): `auto_approve_min_star=4`, `veto_window_minutes=15`, `daily_auto_post_cap=10`, not suspended. (UI seeding blocked since `AUTOPILOT_PURCHASABLE=false`; server-side SQL per invariant #14 deviation.)
- Flags in order: JUDGE+GOVERNOR (deploy bc728500) → AUTO_APPROVAL (deploy SUCCESS). All 5 autonomy flags ON.
**SAFETY VERIFIED:** with AUTO_APPROVAL on, the 50 existing backfill/regenerate drafts did NOT auto-post (`auto_policy_count=0`) — gate correctly restricts to live_ingest_new v1.
### 4.3 Happy path — auto-approval decision ✅ (2026-07-22 ~09:29Z)
New live 5★ "Happy Vacation" (Norbert Esekiel), review `019f8926-984e`, response `019f8926-b3a0`, **version 1 / live_ingest_new**:
- **auto-approved**: `status=approved`, `approval_method=auto_policy` (no owner action) ✓
- publish job `publish_response` **delayed to 09:42Z** (~15-min veto window from ~09:27) ✓
- **pending-post notice** email sent (`email/pending_post_notice`) — the owner's cancel window ✓
- spine review_ingested→draft_generated→moderation_checked→policy_gate ✓
- **Auto-post ✅ (09:42:31Z):** `status=posted`, `approval_method=auto_policy`, publish job completed, run completed. Spine `…→policy_gate→reply_posted`; outcomes `reply_auto_posted, reply_drafted, reply_posted`. Reply LIVE on Google, no owner action.
- **Judge ✅ (09:43:16Z):** `judge_verdicts` verdict=**pass** (gpt-4o-mini-2024-07-18, prompt 2026-07-13.1). WS6 100% (not sampled).
- **VERDICT 4.3: Autopilot autonomy happy path PROVEN.** (Teardown: remove auto-posted reply on "Happy Vacation" review 019f8926.)
### 4.4 Drills
- **Moderation absolute veto ✅ PASS** (invariant #4) — seeded `Refund Tester` review on the auto-approval-eligible lane (live_ingest_new v1), review `55ebbe48`: draft "Dear Refund Tester,", `status=pending_approval`, `approval_method=NULL`, `flagged_responses{severity=high,status=open,source=local_regex,reason=refund_discount}`, **0 notification jobs, 0 publish/auto-post jobs, 0 auto_policy rows**. Moderation overrides auto-approval — held, admin-only, never posted.
- **Judge-unavailable downgrade ✅ PASS** — JUDGE_ENABLED=false; seeded qualifying 5★ (review `95ad6f78`, content_hash set) auto-approved (`auto_policy`, delayed publish). Expedited veto window (backdated pending_post_notice) → publisher passed elapsed gate → judge-check with JUDGE off → **downgraded**: `status=pending_approval`, `approval_method=NULL`, `posted_at=null`; audit `auto_approved_by_policy → auto_policy_revoked_judge_unavailable`; owner `approval_request` notice sent. NOT posted. JUDGE re-enabled after.
- **Governor auto-suspend + unsuspend ✅ PASS** — inserted 5 `flag` judge_verdicts (signal rate 5/6=0.83 > 0.4 threshold, ≥5 sample); shortened `GOVERNOR_INTERVAL_MS=20000`; AutonomyGovernorScheduler auto-suspended: policy `suspended_at` set, reason "Recent safety reviews exceeded the auto-posting safety threshold", audit `autonomy_suspended`, **owner `autonomy_suspended_notice` + `autonomy_admin_alert` both delivered**. Then unsuspended (SQL-simulated admin unsuspend — admin UI needs admin+AAL2 not set up): `suspended_at` cleared + `autonomy_unsuspended` audit → policy re-armed. Full lifecycle `autonomy_suspended → autonomy_unsuspended`.
**VERDICT Phase C: Autopilot autonomy + all 3 fail-safe drills PROVEN.**

## Teardown
- ✅ All 6 autonomy flags → baseline (off): TRIAGE/ESCALATION/JUDGE/GOVERNOR/AUTO_APPROVAL=false; AUTOPILOT_PURCHASABLE never flipped; GOVERNOR_INTERVAL_MS reset to 900000. Worker redeployed to baseline.
- ✅ Tier bypass reverted (accounts+businesses subscription_tier → copilot); seeded auto_approval_policies row deleted; 5 synthetic flag judge_verdicts deleted.
- ✅ Synthetic seeded reviews removed (Refund Tester `55ebbe48`, Judge Down `682dc2a2`, Judge Down2 `95ad6f78`) + their children.
- ⚠️ **OWNER ACTION REQUIRED:** the Phase C auto-posted reply on the **"Happy Vacation" 5★ review (`019f8926`)** is LIVE on the real Tancia Resort profile — delete that Google review (removes review + reply) or use ReviewPublisher.deleteReply. (Phase A "Very good resort" review + reply already removed when owner deleted that review to repost.)
- ℹ️ Left in DB (inert): Phase B v2 drafts on real reviews Akshay `472ecb00` / Dinesh `2ee9b61e` (pending_approval, never posted); their escalations.

## Overall verdict: **PASS** — Phases A, B, C all proven on staging (live profile).
- Copilot (A), Guardian triage+escalation (B), Autopilot autonomy happy-path + moderation absolute veto + judge-unavailable downgrade + governor auto-suspend/unsuspend (C).
- **Bugs fixed:** trial-checkout `payment_status` (PR #518), onboarding page/route flag drift (PR #519). **Ops:** GCP billing re-enabled (Maps). Both PRs **merged to main 2026-07-22 10:20Z** (`c927bf0b`, `5e174b84`) + deployed to staging.
- **Runbook defects to fix:** §1.1 review_triage table check (it's columns on reviews); §4.1/§4.2 Phase C requires autopilot-tier account (not called out) + veto_window "5" invalid (DB CHECK allows 15/30 only).
