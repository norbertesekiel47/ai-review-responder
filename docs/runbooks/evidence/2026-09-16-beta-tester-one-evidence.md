# Evidence — beta tester one, the first production customer end to end

Runbooks: [`deployment-guide.md`](../deployment-guide.md) §8 → §9 · protocol
[`beta-production-standup.md`](../beta-production-standup.md) Phase H · onboarding
[`beta-onboarding-cofounder-guide.md`](../beta-onboarding-cofounder-guide.md).

This campaign resumes and **completes** the Phase H campaign that the owner paused on
2026-09-02 (`2026-09-01-phase-h-beta-launch-evidence.md`). Every step below was executed by the
owner in a browser; every assertion was measured in production by query, never read off a screen.

---

## Environment

| Field | Value |
|---|---|
| Target | production Supabase `udeyaqnvpojbwgoaxwdg`, Railway `production`, Vercel Production |
| Git SHA | `103d38043` (#1290, the tier reprice) on both lanes |
| Stripe mode | LIVE |
| Live surface | Tanicia Resort, Place ID `ChIJqb_7RPR5UDcR6xUi5sIklYk` |
| Owner / operator | @norbertesekiel |
| UTC window | 2026-09-16 08:06Z → 10:41Z |

**Posture at the start:** production held **0** customer accounts and **0** Stripe customers —
both environments were emptied on 2026-09-14/16 by owner decision, which is why no account is
grandfathered on the retired $29/$19 prices.

---

## Preflight (08:06Z)

| # | Check | Result |
|---|---|---|
| P1 | Production data | 0 accounts, 0 businesses, 0 connections, 0 failed/in-flight jobs |
| P2 | `norbertliverpool@gmail.com` free in app + Auth | yes — D-6's 409 no longer applies |
| P3 | Worker | `/api/health` ok, `/ready` 200 |
| P4 | Admin app + site | `admin.repworth.net/login` 200, `repworth.net` 200 |
| P5 | Flags, both surfaces | `AUTO_APPROVAL_ENABLED=false` · `AUTOPILOT_PURCHASABLE=false` · `SELF_SERVE_SIGNUP_ENABLED=false` · `TRIAL_ENABLED=false` · `ZERNIO_PUBLISHING_ENABLED=true` · `ONBOARDING_DEMO_ENABLED=true` · `BETA_COMP_COUPON_ID=repworth-beta-comp-3mo` · `MFA_ENFORCEMENT_ENABLED=true` |
| P6 | Operator flag | ON both lanes — `/api/operator/*` answers **401**, not 404 (#1296) |
| P7 | Live Prices + coupon | 6 Prices verified (7900/4900/7900/14900/9900/14900, active, monthly, USD); coupon 100% off, repeating, 3 months, valid |

---

## Execution log

| UTC | Step | Evidence |
|---|---|---|
| 08:11:46 | **H.0b** — admin creates tester one on the **Admin app** | account `01a0a945-…2f6a` `pending_payment`, Copilot, variant **founding**, base **4900**, overage **7900**; business `Tanicia Resort`, primary, `onboarded_by` set |
| 08:11:47 | Invite issued | `auth.users.invited_at` set, not confirmed |
| 08:11:48 | **Supabase Auth `/invite` → 200** | auth log, no error. On 2026-09-02 the same call returned **500** `535 "Authentication credentials invalid"` (D-7). Owner confirmed the email arrived |
| 08:11:50 | Resend `email.delivered` | `inbound_events` `processed` |
| 08:12:40 | **H.0e** — both digests OFF before connect (rule 6 / D-4) | `weekly_summary_enabled=false`, `monthly_impact_enabled=false` |
| 08:27:04 | Place capture + AI demo | SerpAPI `google_maps_prefill` $0.005; `onboarding_demo_response` completed |
| 08:27:21 | Checkout attempt frozen | coupon `repworth-beta-comp-3mo`, base Price `price_1UFf69…LtiMVJcs` (**the new $49 Price**), base cents **4900**, tax false |
| 08:28:45 | **Owner completes live Checkout** | Stripe page: subtotal **$49.00**, comp **−$49.00**, **total due today $0.00**, card required and supplied |
| 08:28:48 | Account goes active | `active`, `subscription_activated_at` set; `sub_1UGECxIhPBLaM6xAvxz3QGVu`, customer `cus_VGlk3BVNROGPM4` |
| 08:28:48 | Stripe webhooks | `checkout.session.completed` and `invoice.paid` both `processed`, no error |
| — | First invoice | `in_1UGECvIhPBLaM6xAZP8rHxIl` — subtotal 4900, **total 0**, paid; card `pm_1UGECu…` captured on the $0 invoice |
| — | Discount window | 2026-09-16T08:28:45Z → **2026-12-16T08:28:45Z**, exactly three cycles ⇒ cycle 4 bills $49.00 |
| 08:30:45 | **§8** — Google connected | `zernio_connections` `active`, both Zernio IDs set, `last_error` null; Place ID verified; `account.connected` processed; **0** finalize incidents |
| 08:30:45 | Import offer created | expires 2026-09-23 |
| 08:32:42→08:33:01 | **Import accepted → backfill** (D-2's gate) | 19 s; **31 imported**, 0 skipped, **13 external replies** ingested as `posted` responses |
| 08:36:41 | On-demand draft (owner pressed Generate) | OpenAI `gpt-4o-mini-2024-07-18`, 314/69 tokens, **$0.000089**; **no notification by design** — `on-demand-generate.ts` pins `originLane=ON_DEMAND_GENERATE`, `suppressNotification=true` |
| 08:43:48 | **Live review ingested** | 5★ "Great Resort a must visit place again" |
| 08:43:57 | Draft generated automatically | OpenAI `gpt-4o-mini`, **$0.000079**; 0 flagged |
| 08:44:03.8 | Approval email **sent** | `notification_deliveries.sent_at` |
| 08:44:06.6 | Approval email **delivered** | `delivered_at`, 2.7 s later, Resend webhook |
| 08:49:21 | **§9.5** — approval page opened on a phone | `approval_audit_log` `session_bind` / `auth_method: token`, IP recorded, device cookie bound; token stored as **SHA-256 only** (64 chars); response unchanged |
| 10:37:31 | **§9.6** — owner approves | `approve` / `auth_method: owner_session`, approved text snapshotted; **approval link revoked in the same instant** |
| 10:37:40 | **Reply posted to Google** | `status='posted'`, `approval_method='owner'`, `posting_error` null, 9.6 s after approval; `publish_response` completed on attempt 1; owner confirmed the reply on the live profile |

**Review chosen for the first post:** a 5★ review written by the operator himself, with no
existing owner reply. No real customer's review was used.

## Closing state

| Metric | Value |
|---|---|
| Reviews | 32 (31 imported + 1 live) |
| Responses | 14 `posted` (13 imported replies + **1 posted by RepWorth**), 1 `pending_approval` |
| `approval_method` on the posted reply | `owner` |
| Judge verdicts | **0** — correct: the Judge reviews auto-posts, and auto-approval is off |
| Held (`flagged_responses`) | 0 |
| Failed outbox rows | 0 · open finalize incidents 0 |
| AI spend for the whole run | **$0.000168** (two OpenAI calls) plus $0.005 SerpAPI |

## Unproven paths from the 2026-09-01 campaign — final state

| # | Path | State |
|---|---|---|
| U1 | Production Sentry receives an error from the live UI | ✅ browser half closed 2026-09-14 (`REPWORTH-PRODUCTION-5`). Server half still rests on the DSN match (Resume 2 → R11), **not** on an observed server event |
| U2 | Zernio OAuth connect writes `status='active'` | ✅ 08:30:45Z |
| U3 | Import offer renders and acceptance enqueues the backfill | ✅ 08:32:42Z |
| U4 | Backfill ingests real reviews | ✅ 31 reviews |
| U5 | A production email is SENT under the rotated `RESEND_API_KEY` | ✅ sent 08:44:03.8Z, **delivered** 08:44:06.6Z |
| U6 | Approval page renders read-only and audits the GET | ✅ 08:49:21Z |
| U7 | One approved reply reaches Google | ✅ 10:37:40Z |
| U8 | The OpenAI key is really used | ✅ two `openai` rows in `api_costs`, model `gpt-4o-mini-2024-07-18` |
| U9 | Supabase Auth can send email | ✅ re-proven by `/invite` 200 + arrival |

## Findings

**F1 — a hand-requested draft never emails the owner, by design.** The operator pressed
Generate, saw the draft in *Reviews Need Action*, and no email arrived. That is
`on-demand-generate.ts`'s contract: `suppressNotification: true` plus
`originLane = ON_DEMAND_GENERATE`, which is also the primary structural exclusion from
auto-approval. Nothing was wrong. Worth stating in the co-founder guide, because the operator
reasonably read the silence as a fault.

**F2 — the Connect banner shows for a few seconds after a successful connect.** The dashboard is
`force-dynamic` and `ConnectGoogleBanner` hides only on `status === 'active'`; a render that
lands in the window before `zernio_connections` is written shows the pre-connect banner once. It
corrected itself on the next render. Cosmetic; recorded, not ticketed.

**F3 — imported reviews do not auto-draft.** 31 reviews imported, 0 drafts generated. That is the
consented-import design (an import is history you may reply to, not a queue), and it means the AI
path must be proven either by an on-demand generate or by a genuinely new review. This campaign
did both.

## Verdict

✅ **PASS — 2026-09-16T10:41Z.** Beta tester one is a live, paying-in-month-four production
customer, and the full loop is proven in production: admin sign-in → invite → $0 checkout on the
new $49 founding price → Google connect → consented import → autonomous draft of a live review →
delivered approval email → read-only approval page → one owner-approved reply on Google.

**Still open outside this campaign** (`launch-checklist.md`): lawyer review of the legal
documents, insurance binding, alerting drills §4.7/§4.8, the `endpoint:admin-mfa-gate` Discord
rule, and U1's server half.
