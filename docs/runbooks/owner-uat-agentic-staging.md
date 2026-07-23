# RepWorth Test Drive — Business Owner's Guide

**Who this is for:** You — a business owner helping us test RepWorth end-to-end
before launch. No technical knowledge needed. If anything is confusing or looks
broken, that's exactly what we want to hear about — write it down and tell us.

**What RepWorth does:** it watches your Google reviews and drafts replies for
you. In **Copilot** mode, nothing is ever posted until you approve it. In
**Autopilot** mode, the AI posts replies to happy reviews by itself — inside
rules you set, with a cancel window, and with safety systems watching it.

**What you'll be testing:** the whole journey — signing up, connecting your
Google business, approving AI replies (Copilot), getting alerts about unhappy
reviews (Guardian), and finally letting the AI post by itself (Autopilot).

**Time needed:** roughly 2–3 hours of your attention, spread over 1–2 days.
Most of it is "do a small thing, then wait a few minutes."

---

## ⚠️ Read this first — three important things

1. **This test uses your REAL Google Business Profile.** Replies posted during
   this test are really visible on Google. Everything we post will be polite
   and generic, and at the end we'll delete the test reviews (deleting a review
   also removes its reply). Nothing about your business is changed otherwise.

2. **You will post a few "test reviews" on your own business** (from your
   personal Google account, and optionally one from a friend). Keep them
   **short, generic, and harmless** — we'll give you the exact text. We keep
   the number tiny and remove them afterwards.

3. **No real money is involved.** The test site uses a fake payment system.
   When asked for a card, use this test card — it looks real but charges
   nothing and only works on the test site:

   > **Card number:** 4242 4242 4242 4242
   > **Expiry:** any future date (e.g. 12/30) · **CVC:** any 3 digits · **ZIP:** any

**The test website:** https://staging.repworth.net
(This is our test environment — separate from the real product.)

**Your contact at RepWorth:** ___________________ (phone/WhatsApp/email)
Send questions and screenshots here any time. Screenshots of anything odd are
gold to us.

**How the test is organized:** four parts. At each "⛔ CHECKPOINT," message us
a quick progress note — your impressions while they're fresh are half the value
of this test. Parts 1→3 flow straight through at your own pace. **Only one
checkpoint requires you to wait for us: before Part 4 (Autopilot)**, we switch
it on for your account and reply "go ahead."

**Your scorecard:** at the end of this document there's a results sheet. After
each numbered test, mark ✅ or ❌ and jot a note. "It worked but felt confusing"
is a valid and valuable result.

---

# Part 1 — Getting set up (about 30 minutes)

### 1.1 Create your account
1. Go to **https://staging.repworth.net** and choose **Sign up / Start trial**.
2. Enter your email — use your normal business email.
3. You'll receive a **6-digit code** by email. Enter it.
   - *No code within 2 minutes? Check spam. Still nothing → message us.*

**✅ What you should see:** you're signed in and taken toward checkout/setup.

### 1.2 Start the trial (fake payment)
1. When asked for payment, enter the **test card** from the box above.
2. Complete checkout.

**✅ What you should see:** checkout succeeds and you land back in RepWorth —
your trial is active. **❌ If you get stuck on a "processing payment" screen for
more than ~2 minutes, screenshot it and message us — that's a bug we want.**

### 1.3 Set up your business
1. Follow the setup steps. When asked for your business location, start typing
   your business name/address and **pick it from the dropdown suggestions**.
2. Continue through the "voice" questions (how you like replies to sound —
   formal/friendly, sign-off, etc.). Answer honestly; you'll see the effect in
   the drafts later.

**✅ What you should see:** the dropdown finds your business; setup completes;
the dashboard shows your business name (not "pending setup").

### 1.4 Connect your Google Business Profile
1. When prompted, connect Google. You'll be sent to a Google sign-in/consent
   screen — **use the Google account that manages your business profile** and
   approve access.
2. Pick your business location if asked.

**✅ What you should see:** RepWorth shows your business as **connected**, and
within ~10–15 minutes your **existing Google reviews start appearing** in the
dashboard, many with **AI reply drafts already prepared**.

### 1.5 Check your notifications
1. Make sure you can receive emails from RepWorth (check spam once).

**✅ What you should see:** shortly after connecting, emails asking you to
review/approve drafted replies begin arriving.

> **Heads-up:** if your business has some older negative reviews, you may
> **also** get one or two **alert emails about them right away**. That's the
> Guardian part of the system noticing unhappy reviews the moment it meets your
> business — it's working as intended, and Part 3 walks you through it. Nothing
> is posted in response to them without you.

> ### ⛔ CHECKPOINT 1 — message us: "Part 1 done"
> Tell us anything that felt confusing during signup/setup, even small stuff.

---

# Part 2 — Copilot: the AI drafts, YOU approve (about 30–40 minutes)

In this part, nothing gets posted without your say-so. You're testing that the
drafts are good, the approve flow is easy, and replies really land on Google.

### Test 2.1 — Approve a draft as-is
1. Open an approval email (or the dashboard's pending-replies list).
2. Read the AI's draft for one of your existing reviews.
3. If it reads well, **approve it without editing**.

**✅ What you should see:** it's marked approved → **posted**, and within a
couple of minutes the reply is **visible on your Google profile** (check it on
Google, not just in RepWorth).

### Test 2.2 — Edit a draft, then approve
1. Pick another pending draft.
2. **Change the wording** (make it more "you"), then approve.

**✅ What you should see:** the **edited** text (not the original draft) is what
appears on Google.

### Test 2.3 — Ask for a redo
1. Pick a third pending draft and use the **regenerate / redo** option.

**✅ What you should see:** a fresh, different draft appears for the same review.

### Test 2.4 — The full live loop (new review → draft → approve → posted)
1. From your **personal** Google account, post this review on your business:
   > ⭐⭐⭐⭐⭐ "Great experience, friendly staff. Will come again."
2. Wait ~10–15 minutes.

**✅ What you should see:** RepWorth notices the new review, drafts a reply, and
emails you for approval. Approve it → the reply appears on Google. **The reply
should match your "voice" answers from setup.**

### Test 2.5 — Look around the dashboard
1. Open the dashboard and find the **agent activity / timeline** view.
2. Find the review from Test 2.4 and look at its history.

**✅ What you should see:** a step-by-step story of what the AI did (spotted the
review → drafted → checked → you approved → posted). Judge it as a customer:
does this make you trust the system? Note anything confusing.

> ### ⛔ CHECKPOINT 2 — message us: "Part 2 done" + your impressions
> No need to wait for us — continue straight into Part 3 whenever you're ready.

---

# Part 3 — Guardian: unhappy reviews get escalated to you (about 20 minutes)

Guardian watches for negative reviews, warns you quickly, and **never** posts
anything to an unhappy customer without you.

### Test 3.1 — A negative review triggers an alert
1. From your personal Google account (or a friend's), post:
   > ⭐ "Very disappointed with my visit. Slow service and my order was wrong."
   (Generic on purpose — it comes down at the end.)
2. Wait ~10–15 minutes.

**✅ What you should see:**
- An **alert email** telling you a negative review needs your attention — it
  should feel more urgent than the normal approval emails and give you context.
- A reply is **drafted but NOT posted** — it waits for you.

### Test 3.2 — Acknowledge and resolve
1. In the dashboard, find the escalation/alert for that review.
2. Mark it **acknowledged** ("I've seen it"), then later **resolved**.
3. Separately, review the drafted reply — edit if you like — and approve it.

**✅ What you should see:** the alert moves through seen → resolved; the reply
posts only after **your** approval. Nothing about this negative review ever
happened without you.

> ### ⛔ CHECKPOINT 3 — message us: "Part 3 done" — **and WAIT here**
> **This is the one place you must pause.** We'll now switch on Autopilot for
> your account. Don't start Part 4 until we reply "go ahead."

---

# Part 4 — Autopilot: the AI posts by itself, inside YOUR rules (about 1 hour, mostly waiting)

How Autopilot works: **you set the rules** (e.g. "only auto-reply to 4–5 star
reviews," "wait 15 minutes before posting so I can cancel," "no more than N
per day"). The AI only ever acts inside those rules. Unhappy reviews still go
through you, always. An independent safety checker reviews every auto-posted
reply after it goes out.

### Test 4.1 — Set your own rules
1. In settings, find the **Autopilot / autonomy** controls.
2. Set: auto-reply for **4–5★ reviews**, cancel window **15 minutes**, daily
   limit **10**.

**✅ What you should see:** the settings save without errors and read back the
way you set them. **This screen matters a lot to us — tell us if anything is
unclear or feels scary.** (Scary-unclear is a design bug.)

### Test 4.2 — The happy path: hands off
1. Post from your personal account:
   > ⭐⭐⭐⭐⭐ "Lovely place, great atmosphere. Highly recommend."
2. Wait ~10–15 minutes. **You'll get an email saying a reply will be posted
   automatically in 15 minutes unless you cancel.** For this test: **do
   nothing.**
3. Wait out the 15-minute window.

**✅ What you should see:** the reply **posts itself** — check Google. You never
clicked approve. The dashboard timeline shows it was auto-approved, waited the
window, posted, and then was **safety-checked** afterwards.

### Test 4.3 — The cancel window (veto)
1. Post another 5★ test review (vary the wording slightly).
2. When the "will post in 15 minutes" email arrives, **use the cancel option**
   within the window.

**✅ What you should see:** the reply does **NOT** post. It falls back into your
normal approval queue instead — you're back in control. (You can approve or
just leave it.)

### Test 4.4 — Below your bar → asks you first
1. Post a middling review:
   > ⭐⭐⭐ "It was okay. Some things could be better."

**✅ What you should see:** because 3★ is below your 4–5★ rule, **no auto-post**
— you get a normal approval request instead.

### Test 4.5 — Negative review under Autopilot → still goes through you
1. Post one more negative test review (different wording than Part 3's):
   > ⭐ "Not happy with the service today."

**✅ What you should see:** even with Autopilot ON — **no auto-post**. You get
the Guardian alert, and the drafted reply waits for you. This is the most
important safety promise of the whole product.

### Test 4.6 — The safety net (we trigger this one)
We'll simulate the safety checker repeatedly disliking auto-posted replies —
you don't need to do anything to cause it.

**✅ What you should see:** an email telling you **Autopilot has been paused**
for safety and that unposted replies went back to your approval queue. Then,
after we restore it, things return to normal. Judge the emails: would you have
understood what happened and what to do?

> ### ⛔ CHECKPOINT 4 — message us: "Part 4 done"

---

# Part 5 — Cleanup & your verdict (15 minutes)

### Cleanup (do this with us on the line)
1. **Delete every test review** you and your helpers posted (Google →
   your reviews → delete). Deleting a review removes its reply too.
   Test reviews to delete: 2.4, 3.1, 4.2, 4.3, 4.4, 4.5.
2. We'll confirm from our side that nothing test-related is left on your
   profile, and we'll switch your account back to a normal state.

### Your verdict — the three questions that matter most
1. Would you pay for Copilot as you experienced it in Part 2? Why/why not?
2. After Part 4 — would you trust Autopilot with your real reviews? What would
   it take to get you comfortable?
3. What was the single most confusing moment of the whole test?

---

# Results sheet

| # | Test | ✅/❌ | Notes (what you saw / what felt off) |
|---|---|---|---|
| 1.1 | Sign up + email code | | |
| 1.2 | Trial checkout (test card) | | |
| 1.3 | Business setup + location search | | |
| 1.4 | Google connect + reviews appear | | |
| 1.5 | Notification emails arrive | | |
| 2.1 | Approve as-is → live on Google | | |
| 2.2 | Edit then approve → edited text live | | |
| 2.3 | Regenerate gives a new draft | | |
| 2.4 | New review → draft → approve → live | | |
| 2.5 | Activity timeline makes sense | | |
| 3.1 | Negative review → alert email, no post | | |
| 3.2 | Acknowledge → resolve; reply only after approval | | |
| 4.1 | Autopilot settings save + make sense | | |
| 4.2 | 5★ auto-posts after 15-min window | | |
| 4.3 | Cancel within window → no post | | |
| 4.4 | 3★ (below bar) → asks first | | |
| 4.5 | 1★ under Autopilot → asks first + alert | | |
| 4.6 | Safety pause email understandable | | |
| — | Overall: would you use this? | | |

---

# If something goes wrong

- **No email?** Wait 2 minutes, check spam/promotions. Then message us.
- **Review not showing in RepWorth?** Google + our sync can take up to ~15
  minutes. If 30 minutes pass, message us — that's a finding.
- **A page errors or loops?** Screenshot (include the web address bar) and
  message us. Then try again from the dashboard home.
- **Something posted that shouldn't have?** Message us **immediately** — we can
  remove it and we need to know within minutes.
- Nothing you do here can break your Google profile or your business data.

---
---

# Appendix — RepWorth operator choreography (owner can ignore this page)

> Operator-only. Staging = Supabase `kubdiqdhqbhwmqfditeg`, Railway
> `repworth-worker` staging, UI staging.repworth.net. Evidence pattern per
> `docs/runbooks/evidence/2026-07-21-…-e2e-evidence.md`. Open a fresh evidence
> record for this UAT.

**Before Part 1 (baseline — SET 2026-07-22, verify it still holds before sharing):**
- Two-stage flag posture: `TRIAGE/ESCALATION/JUDGE/GOVERNOR=true` (flipped
  2026-07-22 ~10:37Z, worker healthy after redeploy) — Guardian is live from
  the owner's first connect, so existing negative reviews will escalate during
  onboarding (Part 1 heads-up covers this). The three posting/commercial
  levers stay OFF until Checkpoint 3: `AUTO_APPROVAL_ENABLED=false`,
  `AUTOPILOT_PURCHASABLE=false`, account tier stays `copilot`.
- `SELF_SERVE_SIGNUP_ENABLED=true`, `TRIAL_ENABLED=true`, `MOCK_EXTERNAL_APIS=false`, `DAILY_COST_LIMIT_CENTS_AUTOPILOT` set.
- Staging Stripe in test mode (4242 card works). PRs #518/#519 are on main — confirm staging is at/past `5e174b84`.
- GCP Maps billing still enabled (it was re-enabled 2026-07-22; a 403 on the
  location step means it lapsed again).
- Watch the owner's signup in `inbound_events`/Sentry; the two fixed bugs
  (#518 trial `paid`, #519 wizard flag drift) are the regression surfaces.

**Checkpoints 1–2 need nothing from you** beyond reading the owner's notes —
Guardian is already live.

**At Checkpoint 3 (the ONLY gate) → enable Autopilot:**
1. `AUTO_APPROVAL_ENABLED=true` (JUDGE/GOVERNOR are already on, so the
   judge-required-for-posting invariant is satisfied from the first auto-post).
2. Account tier → `autopilot`: either run the WS8 staging cutover
   (`ws8-tier-cutover.md`) if you want Phase D coverage in the same window, or
   the SQL tier flip used in the 2026-07-21 run (watch billing reconciliation
   for reverts).
3. `AUTOPILOT_PURCHASABLE=true` (staging only) — **required so the owner can
   exercise the trust-dial settings UI in Test 4.1**, the surface the previous
   run couldn't test. Composed gate is satisfied once AUTO_APPROVAL is on.
4. Do NOT pre-seed `auto_approval_policies` — Test 4.1's whole point is the
   owner creating the policy through the UI. Constraint: veto window choices
   are **15 or 30 only** (DB CHECK).

**Test 4.6 (governor drill):** seed ≥5 `flag` judge_verdicts on the account
(signal rate > 0.4 threshold), optionally shorten `GOVERNOR_INTERVAL_MS`
(reset to 900000 after). Expect auto-suspend + owner notice + admin alert.
Restore via the admin unsuspend UI if admin+AAL2 is set up on staging —
**prefer this over SQL**; it's still an unproven surface. Confirm the owner's
Test 4.3 cancelled reply and 4.4/4.5 held replies never posted.

**Teardown:** six flags → false (incl. `AUTOPILOT_PURCHASABLE`), tier reverted
(if SQL-flipped), synthetic judge_verdicts deleted, `GOVERNOR_INTERVAL_MS`
reset, verify owner deleted all test reviews (list in Part 5), close the
evidence record with per-test results transcribed from the owner's sheet.
