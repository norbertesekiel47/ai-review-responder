# Agentic platform — staging E2E: Copilot + Autopilot

The single orchestrating runbook for proving WS1–WS8 on the staging full stack,
in the order the gates were designed to be turned on. It **composes** existing
runbooks rather than restating them:

- Moderation absolute-veto (invariant #4): `auto-approval-staging-test.md`
- Copilot/Autopilot Stripe tier cutover (migrations 077/078): `ws8-tier-cutover.md`
- Channel enrollment smoke (owner notifications): `channels-staging-smoke-test.md`
- Concrete URLs / project IDs / deploy mechanics: `deployment-guide.md`

> ⚠️ **Staging posts to REAL Google.** Staging runs `MOCK_EXTERNAL_APIS=false`, so
> any reply that posts flows through the Zernio adapter and lands as a **real,
> public reply on the connected Google Business Profile**. Autopilot auto-posts
> are real public posts. **Connect a throwaway/test GBP location you own** — never
> a live customer's. Posts can be removed (`ReviewPublisher.deleteReply` via the
> publisher path), but they are public until then.

> ⚠️ **Staging only.** Never point any step here at the production Supabase project
> or the production Zernio/Stripe accounts.

---

## 0. Mental model (read once)

The posting path is **Zernio**, not GBP-direct (no GBP adapter exists yet). Your
"GBP account ready" is relevant only as *the Google location connected to staging
through Zernio*. Everything posts through `zernio-review-publisher.ts`.

Two products, gated differently:

| | Flags required | What it proves |
|---|---|---|
| **Copilot** | NONE (all autonomy flags off) | ingest → draft → **owner approves** → post. The spine records it; no autonomous action. |
| **Autopilot (autonomy)** | `TRIAGE` → `ESCALATION` → `JUDGE`+`GOVERNOR` → `AUTO_APPROVAL` | ingest → draft → policy auto-pass → **veto window** → auto-post → judge verdict; governor can auto-suspend. |
| **Autopilot (purchasable tier)** | above **+** WS8 tier cutover **+** `AUTOPILOT_PURCHASABLE` | an owner can *buy* Autopilot and edit autonomy-expanding policy. |

**Golden rule of the flag order:** never enable a downstream gate before its
upstream. `AUTO_APPROVAL_ENABLED=true` is meaningful only with `JUDGE_ENABLED=true`
(the publisher downgrades every unposted auto_policy row to owner review when the
judge is unavailable — verify this is still the coded behavior before trusting it).

---

## 1. Preconditions (read-only; do not proceed until all green)

**1.1 Migrations 071–083 applied to the staging Supabase project.** Verify by
schema introspection, NOT the migration ledger (per migrations-log.md lab note):

```sql
-- Expect one row each. Spot-check the spine + autonomy tables.
-- (There is NO review_triage table — migration 072 adds triage_* COLUMNS to reviews.)
SELECT to_regclass('public.agent_runs'),
       to_regclass('public.agent_run_steps'),
       to_regclass('public.review_escalations'),
       to_regclass('public.judge_verdicts');
-- Triage columns (migration 072) — expect 7 rows:
SELECT column_name FROM information_schema.columns
WHERE table_name='reviews' AND column_name LIKE 'triage_%';
-- Trust-dial columns (migration 074):
SELECT column_name FROM information_schema.columns
WHERE table_name='auto_approval_policies'
  AND column_name IN ('veto_window_minutes','daily_auto_post_cap');
```

Any missing object → apply the gap migrations staging-first (both Supabase
projects stay in lockstep per repo rule, but for *testing* staging is what you
need green first). Do NOT hand-edit; run the numbered files in order.

**1.2 Staging full stack healthy.**

```bash
# Worker + OutboxPoller (confirm the exact URL in deployment-guide.md)
curl -s https://repworth-worker-staging.up.railway.app/api/health   # {"status":"ok",...}
```

**1.3 All six autonomy flags OFF at baseline** (this is the Copilot baseline):

```bash
railway variables --kv --environment staging --service repworth-worker | \
  grep -E '^(TRIAGE_ENABLED|ESCALATION_ENABLED|JUDGE_ENABLED|GOVERNOR_ENABLED|AUTO_APPROVAL_ENABLED|AUTOPILOT_PURCHASABLE)='
# Expect: all false/unset. If any is true, you are NOT at the Copilot baseline.
```

**1.4 A test business on staging** with an active (or `trialing`) subscription and
your **throwaway GBP location connected via Zernio** (active `zernio_connections`
row). Record its `business_id` and `account_id`. Confirm a live review actually
ingests before testing responses — post a review on the test GBP location and
watch a `reviews` row appear (webhook path) or wait for the recent-review poller.

**1.5 Owner notification channel enrolled** (email at minimum) for the target
account, so Copilot approval emails and Guardian escalations have somewhere to go.
If unsure, run `channels-staging-smoke-test.md` first.

**1.6 Open an evidence record** (one Markdown file): environment, git SHA, UTC
start, target `business_id`/`account_id`, and a row per phase below with
pass/fail + UTC time. Never record tokens, approval URLs, or customer PII.

---

## 2. Phase A — Copilot end-to-end (NO autonomy flags)

**Goal:** prove ingest → draft → owner approve → **real post to Google** → the run
spine attributes every step. This is the product you can ship today.

1. **Post a positive review** (4–5★) on the test GBP location from a different
   Google account. Wait for ingest (webhook or poller).
2. **Confirm a draft is generated** and an **owner approval notification** is sent
   (check the enrolled channel). In the DB: a `responses` row `status='pending_approval'`,
   `approval_method` NULL.
3. **Confirm the run spine recorded it:** an `agent_runs` row (`kind='review_handler'`)
   with `review_ingested` → `draft_generated` → `moderation_checked` steps, and a
   `reply_drafted` outcome. This is WS1 working.
4. **Approve via the owner approval page** (the real token flow — device cookie,
   CSRF, the works). Optionally edit the draft first to exercise the edit path.
5. **Confirm it posts to Google** via Zernio: `responses.status='posted'`,
   `approval_method='owner'`, and the reply is **visible on the GBP location**.
   The spine adds a `reply_posted` step + `reply_posted` outcome and completes the run.
6. **Record:** Copilot PASS/FAIL + the posted reply URL (in evidence, not chat).

**Stop rule:** if Phase A fails, do NOT enable any autonomy flag. Copilot is the
substrate autonomy rides on; fix it first.

---

## 3. Phase B — Guardian (Triage + Escalation)

**Goal:** a negative review is classified and escalated to the owner; autonomy is
still OFF, so the reply still waits for owner approval.

1. **Enable Triage, then Escalation — in this order**, staging worker:

```bash
railway variables --set TRIAGE_ENABLED=true --environment staging --service repworth-worker
# confirm the worker picked it up (redeploy/restart per deployment-guide.md), then:
railway variables --set ESCALATION_ENABLED=true --environment staging --service repworth-worker
```

   (Escalation is inert without Triage — no classification means nothing to escalate.)
2. **Post a negative review** (1–2★) on the test GBP location.
3. **Confirm triage ran:** a `review_triage` row with a severity/`suggested_action`,
   and an `api_costs` row `endpoint='review-triage'` (the cost-guarded ~200-token
   `gpt-4o-mini` call). This is WS2.
4. **Confirm escalation raised + sent:** a `review_escalations` row, a
   `review_escalated` outcome, an `escalation_raised` step, and an **escalation
   notice delivered** to the owner channel. This is WS3.
5. **Exercise acknowledge + resolve** from the dashboard (these are NOT flag-gated).
6. **Confirm the reply still needs approval** — Guardian holds + escalates; it does
   NOT auto-post and does NOT do autonomous recovery. `responses.status` stays
   `pending_approval`.
7. **Record:** Guardian PASS/FAIL.

---

## 4. Phase C — Autopilot autonomy (Judge + Governor + Auto-approval)

**Goal:** a qualifying positive review **auto-posts after the veto window**, is
**judged 100%**, and the governor can **auto-suspend** on a forced flag. This is
the highest-risk phase — real auto-posts to real Google.

> **Precondition discovered on the 2026-07-21 run:** the auto-approval runtime
> (`worker/jobs/response-generation/auto-approval.ts`) requires an
> **Autopilot-tier account** (`tierGrantsAutopilot(subscription_tier)`) — a
> Copilot account never auto-posts regardless of flags. `AUTOPILOT_PURCHASABLE`
> is NOT required by the runtime (it gates only purchasability + autonomy-
> expanding settings edits). Since tier is normally Stripe-derived, either run
> Phase D first and buy Autopilot properly, or flip
> `accounts.subscription_tier='autopilot'` via SQL as an owner-authorized test
> shortcut — record the deviation in evidence, watch for billing-reconciliation
> reverts, and revert at teardown.

**4.1 Enable the WS6 safety pair first, then auto-approval last:**

```bash
railway variables --set JUDGE_ENABLED=true    --environment staging --service repworth-worker
railway variables --set GOVERNOR_ENABLED=true --environment staging --service repworth-worker
# Only after judge+governor are live and confirmed inert-safe:
railway variables --set AUTO_APPROVAL_ENABLED=true --environment staging --service repworth-worker
```

   Also confirm the Autopilot cost ceiling is set (required, no default):
   `DAILY_COST_LIMIT_CENTS_AUTOPILOT`. Judge/governor cadence
   (`JUDGE_POLL_INTERVAL_MS` / `GOVERNOR_INTERVAL_MS`) can stay default.

**4.2 Set the trust dial** on the target account so the positive quadrant
auto-passes: rating band auto-approve ≥4★, `veto_window_minutes = 15` (the DB
CHECK allows only **15 or 30** — there is no shorter test value; to expedite a
window mid-test, backdate the pending-post notice rather than shrinking the
window), and a daily cap. Prefer the owner settings path — but note it blocks
autonomy-**expanding** edits while purchasability is closed
(`AUTOPILOT_PURCHASABLE=false`); if testing Phase C before Phase D, seed the
policy server-side and record the invariant-#14 deviation in evidence.

**4.3 Happy path — auto-post:**
1. Post a **4–5★, benign** review on the test GBP location.
2. Confirm the draft is generated and the policy gate records `decision=auto_approved`
   (spine `policy_gate` step). The publish job is enqueued **delayed**
   (`available_at = NOW() + veto_window_minutes`), and a **pending-post notice** is
   sent to the owner (the cancel window). This is WS4.
3. **Optionally test the veto:** cancel from the notice within the window → the
   response downgrades to owner review, does NOT post. Then do a second review and
   let the window elapse.
4. After the window: confirm `responses.status='posted'`, `approval_method='auto_policy'`,
   reply **visible on Google**, spine `reply_posted` + `reply_auto_posted` outcomes,
   run completed.
5. **Confirm the judge ran (100%, not sampled):** within a poll interval, a
   `judge_verdicts` row for that response. This is WS6.

**4.4 Fail-safe drills (the important ones):**

- **Moderation absolute veto** — run `auto-approval-staging-test.md` verbatim
  (reviewer name `Refund Tester` forces a `high` flag). Expect: held, `flagged_responses`
  row, **no** notification, **never** auto-posted — even with `AUTO_APPROVAL_ENABLED=true`.
- **Judge-unavailable downgrade** — temporarily set `JUDGE_ENABLED=false`, post a
  qualifying review. Expect: the publisher **downgrades the unposted auto_policy row
  to owner review** rather than posting. Re-enable `JUDGE_ENABLED=true` after.
- **Governor auto-suspend** — force enough judge flags (or use the smoke driver's
  forced-flag scenario if present) to cross the governor threshold. Expect: the
  account's autonomy **auto-suspends** (policy contracted to hold), an
  **owner suspension notice**, and an **admin alert**. Then **admin-unsuspend** and
  confirm autonomy resumes. This is the WS6 governor + suspension flow.
6. **Record:** Autopilot-autonomy PASS/FAIL per drill.

**Stop rule:** any drill where an unsafe/held/judge-down case **still posted** is a
launch-blocker — disable `AUTO_APPROVAL_ENABLED`, capture evidence, stop.

---

## 5. Phase D — Autopilot as a purchasable tier (WS8)

Autonomy working ≠ Autopilot buyable. Purchasability is `AUTOPILOT_PURCHASABLE`
**AND** the composed runtime gate, and it depends on the Stripe tier cutover.

**Staging is already post-cutover** (migrations 077+078 applied; the 2026-07-21
run activated a fresh signup directly as `tier=copilot`), so the cutover
choreography in `ws8-tier-cutover.md` does not need re-running there — it stays
authoritative for the **production** cutover. For staging, follow the dedicated
Phase D runbook:

→ **`docs/runbooks/agentic-staging-phase-d-purchasability.md`** — smoke-driver
battery (`scripts/ws8-staging-smoke.ts`), real-browser Autopilot checkout +
tier upgrade, trust-dial settings-UI writes (the invariant-#14-clean path Phase
C had to bypass), and the admin `/admin/autonomy` unsuspend UI under AAL2.

**Record:** WS8 purchasability PASS/FAIL per that runbook's evidence template.

---

## 6. Teardown / rollback

- **Return flags to baseline** (all six autonomy flags → false) when done, unless
  you're intentionally leaving staging in a demoable Autopilot state.
- **Clean up test posts on Google** via the publisher delete path
  (`ReviewPublisher.deleteReply`) so the throwaway GBP location isn't left with
  test replies.
- **Instant kill switches** if anything misbehaves mid-test:
  `AUTO_APPROVAL_ENABLED=false` (stops all auto-posting; unposted auto_policy rows
  downgrade to owner review) and, account-scoped, the trust-dial kill switch.
- **Evidence record**: close it with an overall PASS/FAIL and the posted/removed
  reply URLs.

---

## 7. Production go-live (do NOT do as part of this test)

Only after every phase above passes on staging AND the one non-code gate is
closed — **Zernio's automated-posting volume/cadence limits** (CLOSED
2026-07-22: no limits, pay-per-use per account — record + implications in
`zernio-automated-posting-limits.md`) — repeat
the ordered flip in production: `TRIAGE` → `ESCALATION` → `JUDGE`+`GOVERNOR` →
`AUTO_APPROVAL`, then the WS8 cutover, then `AUTOPILOT_PURCHASABLE`. Ship Copilot
(no flags) first and let it accrue edit/approval-rate data before turning on any
autonomy. Production go-live is a separate change with its own approval.
