# RepWorth Beta — Founder's Guide to Onboarding Businesses

> **Who this is for:** RepWorth co-founders running beta onboarding meetings with
> business owners. No technical background needed — everything technical stays
> on Norbert's side, and this guide tells you exactly where that line is.
>
> **Status:** written 2026-08-09 for the first beta cohort (10–15 businesses,
> free for 3 months); recommitted 2026-08-10. **Rewritten 2026-08-14** — the
> owner now walks the whole journey themselves in the meeting (there is no
> "message Norbert to activate" step any more). Companion docs: the beta
> decisions live in `docs/launch-checklist.md` ("Beta cohort decisions"); the
> technical posture is ADR 0005.
>
> **Before your first meeting:** read Parts 1–4 fully, skim the rest, and
> confirm the **Feature Status Board (Part 3)** is current with Norbert — it is
> the single list of what you may and may not promise.
>
> ⚠️ **Not live in production yet.** The self-checkout path this guide describes
> depends on billing machinery that is deliberately absent from the production
> database until the WS8 tier cutover runs
> (`docs/runbooks/ws8-tier-cutover.md`). It works end-to-end on staging today.
> Confirm with Norbert that the cutover has run before you book the first real
> meeting, and see **Part 12 — Pending ops steps** for everything else that is
> still outstanding.

---

## Part 1 — What RepWorth is (the two-minute version you should be able to say cold)

RepWorth watches a business's **Google reviews** and handles the responses.

When a new review comes in, RepWorth notices it within about 15 minutes, writes
a reply in the business's own voice, and sends the owner an email: *"Here's the
review, here's our suggested reply — approve it, edit it, or ignore it."* One
tap and the reply is live on their Google profile. The owner also gets a
dashboard (inbox of reviews, analytics, settings) and a **Monday email digest**
summarizing the week: how many reviews came in, how many got responses, and
what's worth knowing.

Why owners care: responding to every review — quickly, politely, in their own
voice — measurably helps their Google presence and shows customers someone is
listening. Almost nobody has time to do it well. RepWorth does it for them
without taking away control.

**The two products (know these names):**

- **Copilot** — RepWorth drafts every reply; **the owner approves every single
  one** before it goes anywhere. Nothing ever posts on its own. *This is what
  every beta business gets.*
- **Autopilot** — RepWorth may post replies to happy reviews by itself, inside
  rules the owner sets (star-rating threshold, a cancel window, a daily cap),
  with independent safety systems watching. **Not available during the beta.**
  It exists, it's coming, and beta businesses will get first access — but do
  not sell it, demo it, or promise a date.

**The safety story (owners always ask, so have it ready):** in the beta,
*nothing is ever posted to Google without the owner explicitly approving that
exact text.* Not for good reviews, not for bad ones, not ever. On top of that,
drafts pass through automated safety filters, and anything concerning is held
for human review on our side instead of being sent out. The owner can
disconnect Google or cancel at any time.

---

## Part 2 — The beta offer (say it exactly like this)

- **Free for 3 months.** Full Copilot product, **$0 charged at onboarding and $0
  invoiced during the free period.** They do put a card on file at checkout — see
  "Payment mechanics" below, and say it early rather than letting it surprise
  them mid-meeting.
- **After 3 months:** the founding-customer rate — **$19/month** for Copilot
  (regular price $29) — unless they cancel first. They can cancel anytime in
  Settings → Billing with no penalty; canceling keeps access through the paid
  period.
- **What we ask in return:** honest feedback. A 15-minute check-in call in the
  early weeks, and "tell us when something is confusing or broken." They are
  founding customers, not test subjects — the product is real and works on
  their real Google profile.
- **Cohort size:** first 10–15 businesses only. It's fine to say that — it's
  true and it helps.

**What you must NOT offer without checking first:** custom pricing, longer free
periods, contractual terms beyond the standard ones on the website
(repworth.net/legal), Autopilot access, or features from the "Not yet" column
in Part 3. If a prospect needs something special, say *"let me check with the
team and come back to you tomorrow"* — that is always an acceptable answer.

**Payment mechanics — read this carefully, it changed on 2026-08-14.** The owner
now goes through a **real Stripe checkout during the meeting**, and it will ask
for a **card**. The total is **$0 due today**: the beta discount (100% off for
3 months) is applied automatically by our system because the account was created
from an admin invite — nobody types a promo code, and there is no code to type.

Say it to them plainly, before they see the card field, in roughly these words:

> *"Next screen is our normal checkout. It'll ask for a card, and the total will
> say $0 — you're not being charged today and you won't be charged for three
> months. The card is on file so that at month four it just carries on at $19
> instead of us having to chase you. You can cancel any time before then in
> Settings and never pay anything."*

Two things that make this safe to say: the total genuinely reads **$0.00 due
today** on the Stripe page (if it doesn't, **stop and escalate — do not have
them pay**), and canceling during the free months costs them nothing.

You still never handle their card. They type it themselves on Stripe's own page.
**Never create or edit anything in the Stripe dashboard yourself** — even a
well-meant manual invoice can incorrectly flag a customer's account as unpaid and
interrupt their service. Anything billing-shaped goes to Norbert.

---

## Part 3 — Feature Status Board

This is the promise gate. Anything marked **Not yet** must not be promised,
demoed, or hinted at with a date. When an owner asks for one, the line is:
*"That's on our roadmap — as a founding customer you'll be first to get it."*

> ⚠️ **Last updated 2026-08-09 — before your FIRST meeting, ask Norbert to
> re-confirm this table**, especially the first row, which the whole product
> depends on.

| Feature (plain name) | Status | Notes for you |
|---|---|---|
| Google connect + posting approved replies | **CONFIRM WITH NORBERT** | The core loop. Must be verified live in production before meeting #1. |
| Email notifications + approval links | Live (once they finish checkout) | Email is the always-on channel. |
| AI drafts for every new review | Live | Typically ready within ~15 min of the review appearing. |
| Edit a draft before approving | Live | On the approval page — textarea, then "Save & post." |
| Ask for a fresh draft ("regenerate") | Live | On the approval page. |
| Import of existing/historical reviews | Live | Owner's choice; see Part 5, step 9. |
| Live AI demo on their real reviews, before payment | **CONFIRM WITH NORBERT** | Part 5, step 4 — the wow moment. Nothing is posted; drafts only. Depends on the pre-pay demo lane being switched **on** in that environment, and it is off by default — confirm before your first meeting. |
| Owner completes their own $0 checkout in the meeting | Live | Part 5, step 5. Card collected, $0 due today, 3 months comped. **Prod-blocked until the WS8 cutover** — confirm with Norbert. |
| Resend the invite email yourself | Live | Part 9. Only works while they haven't signed in yet. |
| Dashboard: review inbox, all-reviews list, analytics | Live | |
| Weekly Monday digest email | Live | |
| Voice settings (tone, what to mention/avoid, sample replies) | Live | No "signature/sign-off" field exists — don't promise one. |
| Cancel / delete-data from Settings → Billing | Live | See Part 8. |
| Automated safety filters on drafts | Live (baseline) | A second, stronger filter layer is being validated — internal detail, don't discuss. |
| Negative-review alert emails ("Guardian" escalations) | **Not yet** | Negative reviews still get drafts + normal approval emails — they are not ignored. The special urgent-alert treatment is what's pending. |
| Autopilot (auto-posting within owner rules) | **Not yet — by design** | Beta is Copilot-only. First access for founding customers later. |
| Telegram / WhatsApp notification channels | **Not yet** | Email only for now. |
| Review requests / "ask your customers for a review" | **Not yet** | |
| Keyword-ranking tracking in the digest | **Not yet** | |
| Multiple locations under one account | **Not yet** | Beta = one location per business. Multi-location prospects: onboard their busiest location, note the interest. |
| Editing a reply that is already posted on Google | **Not yet** | Before approval: always editable. After posting: not from RepWorth yet (they can edit on Google directly). |

---

## Part 4 — Before the meeting

### One-time setup for YOU (do this once, this week)

- [ ] You have a **RepWorth admin account with two-factor authentication
  (MFA) enrolled**. The onboarding form refuses to work without MFA. Norbert
  sets this up — do it days before your first meeting, not the morning of.
- [ ] You've clicked through the admin onboarding form (`/admin/businesses/new`)
  once against a made-up test business so the meeting isn't your first time
  seeing it. It is **three fields** — owner email, owner name, business name —
  and nothing else. Ask Norbert to clean up the test afterwards.
- [ ] You've read a few of the AI's draft replies (ask Norbert to generate
  sample drafts for a real business via the admin demo tool) so you can speak
  to their quality honestly.
- [ ] You know the legal pages exist at repworth.net/legal (Terms, Privacy,
  Acceptable Use). If an owner wants a signed agreement or has legal questions,
  take it away — don't improvise.

### Qualifying a lead (from the early-access waitlist)

Leads arrive from the **"join early access" form** on the website (the
book-a-demo page). Before booking a meeting, confirm:

- [ ] **They have a Google Business Profile** — search their business on Google
  Maps; a real listing with reviews should come up.
- [ ] **They personally control it** — they (not an agency, not an ex-employee)
  can sign into the Google account that manages the listing. This is the #1
  onboarding blocker. Ask literally: *"If I asked you to sign into the Google
  account that manages your business listing right now, could you?"* If unsure,
  have them check **business.google.com** before the meeting.
- [ ] **They get reviews** — ideally a few per month. A business with 2 reviews
  a year won't feel the product. (They can still join; set expectations.)
- [ ] **One location** for the beta (see status board).
- [ ] **They're the decision maker** — owner or manager who can say yes.

### Booking the meeting

- **45–60 minutes, video call with screen sharing.** The owner will need to be
  at a computer or comfortable on their phone — they'll click through email,
  a checkout page, and Google sign-in during the call.
- Tell them in advance to bring: access to their **email inbox**, a **credit or
  debit card** (for a $0 checkout — say why, per Part 2, so it isn't a surprise
  on the call), and their **Google sign-in** for the business. Nothing else.
- **No technical activation step exists any more.** The owner activates their
  own account by completing the $0 checkout in the meeting; nobody on our side
  has to do anything mid-call. Norbert does **not** need to be on standby, though
  it is still worth telling him which day you're onboarding so he can watch for
  anything odd.

### 24 hours before

- [ ] Re-check the Feature Status Board with Norbert if anything was pending.
- [ ] Look at the business's actual Google reviews for 5 minutes. Note one
  recent review you could talk about — it makes the demo personal.
- [ ] Optional wow-moment: ask Norbert to pre-generate **sample AI drafts for
  their real reviews** (admin demo tool). Opening the meeting with "here's what
  RepWorth would have said to the review Maria left you last Tuesday" is the
  single most convincing thing we can do.

---

## Part 5 — The onboarding meeting, step by step

Total ~45–60 minutes. Steps 4 and 7 have short waits built in (the AI demo
generating, reviews syncing after connect) — use them for the conversation
parts.

### Step 1 — Frame it (5 min)

Cover, in your own words:

1. The two-minute story from Part 1 (watches reviews → drafts replies in your
   voice → you approve → it posts).
2. The control promise: *"Nothing is ever posted without you approving that
   exact text. You can edit any draft, ignore any draft, disconnect anytime."*
3. The offer from Part 2 (free 3 months → $19/mo founding rate → cancel
   anytime).
4. What beta means: *"The product is real and live on your real Google profile.
   You're one of our first ~15 businesses, you get a direct line to the
   founders, and we want you to tell us everything that feels confusing."*
5. If you have pre-generated sample drafts (Part 4) — show them now.

> **The shape of the whole journey**, so you can narrate it before it starts:
> you create the account (3 fields) → they get an invite email → they set a
> password → they're returned to the **login page** → from there the system puts
> them on exactly the right next screen → they confirm their business location →
> **they watch the AI write replies to their real reviews** → checkout at $0 with
> a card → a short setup wizard ending in Connect Google → dashboard. (The
> location + demo pair depends on a switch that is off by default — see the
> caveat in Step 4, and check with Norbert beforehand.)
>
> **You never decide where they go next.** Every time they log in — during this
> meeting or three days later — the system works out which step they're owed and
> sends them there. If they drop off mid-way and come back, they resume; they
> never have to re-do a step or find a link.

### Step 2 — Create their account (2 min, you drive, screen NOT shared for this part)

On **your** screen (don't share it — the admin console shows internal tools),
open **`/admin/businesses/new`**. It is **three fields**:

1. **Owner email** — the one they actually read. Everything downstream depends
   on this being right: the invite, the approval emails, the digest.
2. **Owner name**.
3. **Business name**.

That's all. There is deliberately no place/address picker, no voice questions,
and no tier picker on this form any more — the owner supplies their location
themselves in Step 4, you do voice together in the wizard (Step 6), and the
plan is Copilot by default.

Submit. Two things happen: the owner gets an **invitation email**, and their
account exists, awaiting their own checkout.

### Step 3 — Owner accepts the invite and sets a password (5 min, owner drives)

Ask the owner to open the invite email (check spam/promotions if it's not there
within 2 minutes) and click the link. They set a password, and are then returned
to the **login page** and asked to sign in with the password they just chose.

Warn them about that beforehand — *"it'll bounce you back to a login screen once;
that's normal, just sign in with the password you literally just set"* — because
being asked to log in immediately after setting a password reads like a failure
if you weren't expecting it. (It's deliberate: the password-reset session is
destroyed the moment the password is written, which is the safe thing to do.)

**If the invite email never arrives**, don't wait it out — you can resend it
yourself; see Part 9.

### Step 4 — Their location, then the AI demo (10 min, owner drives — the wow moment)

When they log in, the system puts them on the right screen automatically. For a
brand-new invited owner that's the **location step**:

1. They search their business by name/address and pick it from the dropdown (or
   paste their Google Maps link). This is the same information you used to
   collect on the admin form — it's better coming from them, because they can
   confirm it's the right listing on the spot.
2. RepWorth then pulls a few of their **real, current Google reviews** and
   **writes draft replies to them live, in front of the owner.** This is the
   single most convincing moment of the meeting. Let it land — read one out.
3. Nothing here is posted anywhere. These are demo drafts on their real reviews;
   the point is "here's what we'd say," not "here's what we said."

If they stop the meeting here and come back tomorrow, logging in returns them to
this same demo — they will not be sent back to re-enter their location.

> ⚠️ **This whole step only exists when the pre-pay demo lane is switched on**
> (`ONBOARDING_DEMO_ENABLED`, which is **off by default**). With it off, logging
> in takes the owner **straight to plan selection and checkout (Step 5)** — no
> location step, no demo — and they enter their location inside the setup wizard
> instead, which then runs **Location → Profile → Voice** with Connect Google
> from the dashboard afterwards rather than as a wizard step. Nothing breaks
> either way, but the meeting is materially less impressive without the demo.
> **Ask Norbert which way the environment you're onboarding into is set,** and
> ask before your first meeting rather than discovering it on the call.

### Step 5 — Checkout at $0 (5 min, owner drives)

From the demo they continue to plan selection and then **Stripe's checkout page**.

- Plan: **Copilot**. (Autopilot isn't purchasable during the beta — see Part 3.)
- The checkout page asks for a **card** and shows **$0.00 due today**. Say the
  Part 2 script out loud *before* they see the card field.
- **Check the total before they submit.** It must read $0 due today. If it shows
  $19, $29, or any non-zero amount, **stop — do not have them pay.** That means
  the beta discount didn't attach; screenshot the page and escalate (Part 9).
  It is not fixable in the meeting and paying "and we'll refund you" is not an
  acceptable workaround.
- They submit. Their subscription becomes active with the discount attached, and
  they're taken into the setup wizard.

**How to tell the comp actually applied** (you can check any of these, in
increasing order of how technical they are): the checkout page said $0.00 due
today; and after checkout, Settings → Billing shows an active subscription with
no charge. Norbert can confirm from our side that the discount is on the
subscription and that month 4 is scheduled at the full founding rate. If in any
doubt, ask him to confirm before you leave the call — it's a two-minute check and
much cheaper than a surprise charge to a founding customer.

### Step 6 — The setup wizard: Profile, then Voice (5–10 min, together — this determines draft quality)

After checkout the owner lands in a short wizard: **Profile → Voice → Connect
Google** (or **Location → Profile → Voice** if the demo lane was off — see the
caveat in Step 4). Profile is quick (business details, mostly pre-filled). Voice is the
one worth your time — do it *with* them, conversationally; it's a great
discovery moment and it's what makes the drafts sound like them. Four things,
in plain terms:

- **Tone** — how replies should sound (e.g. "professional and friendly," or
  their own description). Ask: *"If your best employee answered a review, how
  would it sound?"*
- **Products & services** — what the business wants mentioned or highlighted.
- **Things to avoid** — topics or claims replies must never touch (e.g. "never
  promise discounts," "don't mention the old location"). Push on this one — it
  prevents the awkward drafts.
- **Sample replies** — 2–3 past replies the owner actually wrote and liked.
  This is the highest-impact field: the more "them" we have, the more the
  drafts sound like them. If they've never replied to reviews, have them
  dictate one on the spot for a real review.

The Voice step is **skippable** and everything here is editable later under
**Settings → Voice** — so if the meeting is running long, take the tone and the
things-to-avoid now and book the rest into the week-one check-in.

Note: there is **no automatic signature/sign-off setting** — if they want
"— Maria, Owner" at the end, it should go in their sample replies so the AI
picks up the habit, and they can always edit any draft.

### Step 7 — Connect Google (10 min, owner drives — the other big moment)

With the demo lane on, connecting Google is the **last step of the setup
wizard**, so they arrive at it on their own; with it off, the wizard ends after
Voice and they connect from the dashboard. Either way, have the owner (sharing
*their* screen now, or just narrating):

1. Click **Connect Google Business** — on the wizard's final step, or from the
   card on the dashboard (it's also under Settings).
2. They'll be sent to a **Google sign-in and consent screen**. **They sign in
   themselves — never ask for, type, or watch them type their Google
   password.** They're granting RepWorth access to read the listing's reviews
   and post the replies they approve.
3. If their Google account manages several locations, a picker appears — they
   choose the one location for this beta.
4. Back in RepWorth, the business shows as **Connected**.

Within about **10–15 minutes**, their existing Google reviews start appearing
in the dashboard. If the connection fails or hangs, don't debug on the call —
screenshot it, tell the owner *"our team will have this sorted today,"* and
escalate (Part 9).

### Step 8 — Notifications check (2 min)

Confirm the owner knows notifications arrive by **email** for now, from
RepWorth — have them add us to contacts / check spam once. (If the status board
says Telegram or WhatsApp are live and the owner prefers one, they can add it
under Settings → Channels.)

### Step 9 — The import decision (3 min, owner decides)

A banner will appear on their dashboard offering to **import their recent
reviews** — up to the 100 most recent from the past year. Explain it neutrally:

- *"This pulls your recent review history into RepWorth so you can see
  everything in one place and write replies to old unanswered reviews if you
  want. Nothing is posted automatically — imported reviews just sit in your
  list, and you choose if and when to respond to any of them."*
- The offer stays open for **7 days**, then quietly expires. It's one-time.
- New reviews are handled either way — declining changes nothing about the
  core service.

Most owners should accept — it makes the dashboard immediately feel alive. But
it's genuinely their call; record what they chose in your meeting notes.

### Step 10 — The first approval (5 min — do this live if at all possible)

If any drafts are ready (for a new review, or generate one on demand from an
unanswered review in the **All Reviews** list):

1. Open the approval page (from the email if one arrived, or the dashboard's
   pending list).
2. Walk the three choices: **Approve** (it's a deliberate two-tap — "tap again
   to post to Google" — because posting is public and permanent), **Edit** the
   text first, or **Regenerate** for a fresh draft. And the quiet fourth
   option: *do nothing — nothing ever posts on its own.*
3. Have them approve one. Then **open their Google listing and show the reply
   live.** That moment closes the deal emotionally — don't skip it.

Two practical things to mention: approval links in email **expire after 48
hours** (the dashboard always works regardless — an expired link never means a
lost reply), and an approval link is basically a "post this reply" button —
**they shouldn't forward those emails** to people they wouldn't let speak for
their business.

### Step 11 — Wrap (5 min)

- Recap: *"From now on it's automatic — review comes in, you get an email with
  a suggested reply, you tap approve or edit. A couple of minutes a day, most
  days zero."*
- Tell them about the **Monday digest email** so it isn't a surprise.
- Book the **week-one check-in call** (15 min) before you hang up.
- Give them a direct contact (your phone/WhatsApp/email) for anything odd.
- Ask them to *not* post fake test reviews on their own listing — real reviews
  only. (Google penalizes fake reviews; if they want to see the loop, the next
  organic review will do it.)

---

## Part 6 — What the owner experiences in week one (so you can predict it for them)

- **Right after connect:** existing reviews appear in the dashboard within
  ~15 minutes. If they accepted the import, up to 100 recent reviews fill the
  All Reviews list (none of them auto-drafted — on-demand only).
- **New review arrives:** draft + approval email typically within ~15 minutes.
- **They approve:** reply visible on Google within a couple of minutes.
- **They ignore a draft:** nothing happens. It waits in the dashboard. The
  email link dies after 48 hours; the dashboard copy doesn't.
- **A rare case worth knowing:** occasionally a draft trips our safety filters
  and is **held for human review on our side** instead of being sent to the
  owner. If an owner ever mentions "a review never got a draft email," don't
  troubleshoot — escalate it (Part 9); it may be a held draft doing its job.
- **Monday:** the weekly digest email — review count, response count, notable
  reviews, a short intelligence brief, and a one-tap "how are we doing"
  pulse. Tell them to actually click the pulse — we read it.

---

## Part 7 — Owner questions you WILL get (answers you can give verbatim)

**"Will it ever post something without me?"**
No. In your plan, never. Every reply that reaches Google was approved by you,
word for word. (An automatic mode is on our roadmap — it will be strictly
opt-in, with rules you set, and you'll be first to get access.)

**"What if the AI writes something wrong or embarrassing?"**
You'd catch it before anyone sees it — nothing posts without your approval. You
can edit the text, ask for a new draft, or just ignore it. There are also
automated safety checks on our side before a draft ever reaches you.

**"What about bad reviews?"**
Same deal, with more care: you get a drafted, professional response, and you
decide. Nothing about a negative review ever happens without you. (Read
negative-review drafts closely before approving — that's exactly what the
approval step is for.)

**"Do you get access to my Google account?"**
You sign in with Google yourself and grant limited access — reading your
reviews and posting the replies you approve. We never see your password. You
can disconnect at any time from settings.

**"Can it answer my old reviews?"**
If you accept the import, your recent history comes into RepWorth and you can
generate a reply for any old unanswered review whenever you like. Nothing is
posted to old reviews automatically.

**"What happens to my data if I leave?"**
Two options in Settings → Billing: **cancel** (service stops at the end of the
period, data is retained so you can come back), or **delete my data**
(permanent — 30-day window, then it's gone, except records we're legally
required to keep). If you want an export, contact us before deleting.

**"How much will this cost me?"**
Nothing for 3 months. Then $19/month as a founding customer — that rate is
yours to keep. Cancel anytime before the free period ends and you'll never pay
anything.

**"Why do you need my card if it's free?"**
So month four just works instead of us having to chase you for payment details
right when the product has become part of your routine. Today's total is $0 —
you'll see that on the checkout page before you enter anything — and nothing is
charged until the three free months are over. If you cancel before then, in
Settings, the card is never charged at all.

**"Will I get charged by accident when the free period ends?"**
No accident about it — at month four it becomes $19/month, the founding rate,
and you'll have had three months to decide. Cancel any time up to that point in
Settings → Billing and you pay nothing, ever.

**"Can my manager handle the approvals?"**
The account has one login for the beta, and approval emails go to its email
address. Practical workaround: use a shared inbox address for the account.
Proper multi-user support is roadmap.

**"Why didn't a review show up yet?"**
Google-to-RepWorth sync typically takes up to ~15 minutes. If a review is over
30 minutes old and not showing, that's worth reporting to us — take a note.

---

## Part 8 — Leaving, pausing, and the offboarding conversation

If a beta business wants out, make it easy — a graceful exit is a referral;
a trapped customer is a bad review of a review-management company.

- **Cancel subscription** (Settings → Billing): access continues through the
  current period, then processing stops; their data is kept, and they can
  reactivate later. During the free 3 months, canceling simply means they never
  pay.
- **Delete my data** (Settings → Billing, danger zone): immediate stop,
  disconnects Google, starts a **30-day permanent deletion** window. Requires
  their password and typing a confirmation — by design scary. If they mention
  wanting their data first, they must contact us **before** doing this; there's
  no self-serve export.
- Whatever the reason, get it in your notes: churn reasons from the first 15
  customers are some of the most valuable information the company will ever
  collect.

---

## Part 9 — When something goes wrong (your triage table)

Golden rule: **never debug live on a call.** Screenshot, reassure, move on,
escalate. *"Our team will have this fixed today — let's keep going"* preserves
confidence; ten minutes of on-call fiddling destroys it.

| Symptom | What you say | What you do |
|---|---|---|
| Invite email never arrives | "Let's check spam… no? I'll resend it right now." | Verify the email address you entered, then use **Resend invite** on the business's admin page (see below). If the resend also fails to arrive, escalate. |
| **Checkout total is NOT $0** | "Give me one second — I don't want you paying for something that's meant to be free." | **STOP. Do not let them pay.** Screenshot the checkout page, escalate immediately. The beta discount didn't attach; it is not fixable in the meeting. |
| Checkout page errors or won't load | "That's on us — team will sort it today." | Screenshot (with the address bar), escalate. Do not retry more than once. |
| They log in and land somewhere unexpected | "Let me look — the system picks the screen for you." | Note exactly what they saw and where they'd got to, and escalate. Don't hand them a URL to type. |
| Google connect errors or loops | "This is on us, not on you — team will sort it today." | Screenshot (with the address bar), escalate. |
| Reviews not appearing 30+ min after connect | "Sync can lag; we'll confirm from our side." | Escalate with the business name + connect time. |
| Owner approved but the reply isn't on Google after ~15 min | "Posting can take a few minutes; we'll verify it landed." | Escalate — this one is time-sensitive. |
| Owner says a review never produced a draft email | "Some drafts get an extra safety check on our side — let me look into it." | Escalate; may be a held draft (working as intended) — never speculate to the owner. |
| **A posted reply looks wrong/off-brand** | "Thanks for flagging — we're on it right now." | **Escalate IMMEDIATELY (call, don't text).** A bad public reply is our worst failure mode; minutes matter. |
| Owner asks for refund/legal/contract things | "Let me get you an answer from the team today." | Escalate. Never improvise terms. |

### Resending the invite email (you can do this yourself)

Open the business in the admin console (`/admin/businesses/[id]`) and use
**Resend invite**. It sends the same invitation email to the same address.

Two things to know:

- **It only works while the owner has never signed in.** Once they've accepted
  the invite and set a password, resending is refused on purpose — at that point
  the fix is a **password reset**, which they can do themselves from the login
  page ("Forgot password"). Send them there instead of resending.
- **You get 3 resends per business per hour.** That's deliberate: this is the one
  button that puts email into someone else's inbox on demand, and a click-loop
  would damage our sending reputation for everyone. If three didn't land, the
  problem isn't the button — escalate.
- **If it fails with an error you don't understand, escalate rather than
  retrying.** The way this action reports provider failures is
  **not yet verified against real Supabase behaviour on staging** (it is on the
  pending-ops list in Part 12), so an unfamiliar error message is a genuine
  "tell Norbert" moment, not something to click through.

You cannot change the owner's email address from here. If you typed the address
wrong, that's an escalation — the account has to be recreated.

**Escalation contact:** Norbert — [phone] — plus the shared founders channel.
When escalating, always include: business name, owner email, what happened,
when, and a screenshot.

**Your never-do list (worth repeating):**

- Never handle the owner's Google password or sign into Google for them.
- Never touch the Stripe dashboard.
- Never promise anything in the "Not yet" column of Part 3.
- Never forward an approval link or post one in a chat/screenshot — the link
  itself can post to the owner's public profile.
- Never let an owner post fake reviews "to test it."
- Never share your admin login or do admin work on a shared screen.

---

## Part 10 — After the meeting

Within an hour, log (shared doc/CRM — one entry per business):

- Business, owner, contact, date onboarded, who ran it
- Import decision (accepted / declined / left for later — the offer dies in 7 days, so if "later," set yourself a day-5 reminder)
- Voice notes (tone chosen, things-to-avoid — useful when reviewing draft quality later)
- First approval done live? (yes/no)
- Questions they asked, hesitations, feature requests
- Week-one check-in date (booked before hang-up)

**Check-in cadence for the beta:** 15-minute call in week one, then weekly
messages / bi-weekly calls for the free period. Standing agenda: Are drafts
sounding like you? Anything confusing? Anything you expected that isn't there?
Would you pay $19 when the free period ends — and if not, what's missing?
That last question, asked honestly at month two, is the beta's entire purpose.

Also watch for the silent ones: an owner who stops approving drafts for a week
isn't "fine" — they're churning quietly. The dashboard-side signal is visible
to us internally; if we flag someone as gone-quiet, a friendly personal message
from the founder who onboarded them works far better than anything automated.

---

## Part 11 — Glossary (terms you'll see or hear)

- **Copilot / Autopilot** — the two product tiers: approve-everything vs.
  bounded auto-posting (beta = Copilot only).
- **Draft** — an AI-written reply that has not been approved; invisible to the
  public.
- **Approval link** — the email button that opens the approve/edit/regenerate
  page for one draft; expires after 48 hours; treat like a key.
- **Connect / connection** — the owner's Google sign-in granting RepWorth
  access to the listing's reviews and replies.
- **Import (offer)** — the one-time, 7-day-window option to pull in up to 100
  recent historical reviews; history only, nothing auto-drafted.
- **Digest** — the Monday summary email.
- **Voice** — the settings that shape how drafts sound: tone, products &
  services, things to avoid, sample replies.
- **Escalation / Guardian** — the (upcoming) urgent-alert treatment for
  negative reviews; today negatives flow through the normal approve path.
- **Invite** — the email that creates the owner's login. Sent when you submit
  the 3-field admin form; resendable from the business's admin page until they
  first sign in.
- **Activation** — completing the $0 checkout. That is what switches the
  account fully on. **There is no separate internal activation step any more**
  and nobody on our side performs one; if you hear "message Norbert to
  activate," that instruction is out of date.
- **AI demo** — the pre-payment moment where RepWorth drafts replies to the
  owner's real Google reviews so they can see the quality before paying.
  Nothing from it is ever posted.
- **Setup wizard** — the short post-checkout sequence Profile → Voice → Connect
  Google that ends on the dashboard.
- **Beta discount** — the automatic 100%-off-for-3-months applied at checkout
  because the account came from an admin invite. There is no promo code to type
  and no code to give out.

---

## Part 12 — Pending ops steps (NOT done by the implementation)

> **Audience: Norbert / whoever owns ops.** This section is not for the meeting.
> It is the complete list of things the 2026-08-14 code change deliberately did
> **not** do, because they are provider or environment actions rather than code.
> **Until every box here is ticked for an environment, the flow in Part 5 does
> not work in that environment** — most visibly, the checkout will show the full
> price instead of $0, which is the one failure a beta tester must never see.
>
> Sources: plan `docs/superpowers/plans/2026-08-14-admin-invite-funnel.md`
> steps 1 and 9 + "Risks / open questions"; env reference
> `.claude/reference/env-vars.md` → `BETA_COMP_COUPON_ID`.

- [ ] **Create the Stripe coupon in TEST mode** (for staging): 100% off,
      `duration: repeating`, `duration_in_months: 3`. Nobody has created it yet.
      Record the coupon ID.
- [ ] **Create the Stripe coupon in LIVE mode** (for production), same shape.
      **It is a different ID from the test-mode one** — a test-mode ID deployed
      to live fails every invited tester's checkout identically.
- [ ] **Set `BETA_COMP_COUPON_ID` in Vercel — staging first, then production.**
      Server-only; there is no `NEXT_PUBLIC_` companion and it is deliberately
      not a worker variable. Redeploy. **Unset is the kill switch, and it only
      affects NEW checkout attempts** — an owner whose attempt already
      snapshotted the coupon keeps it.
- [ ] **Verify the Supabase re-invite error shapes on staging** before trusting
      the resend-invite action's error mapping (`src/lib/onboarding/resend-invite.ts`,
      route `POST /api/admin/businesses/[id]/resend-invite`). The mapping was
      written **without** that staging verification and is marked
      staging-verify-before-prod in the module itself. Exercise at least: an
      owner who has never signed in (expect success), and an owner who has
      already accepted (expect a clean refusal, not a duplicate invite).
- [ ] **Decide and set `ONBOARDING_DEMO_ENABLED` per environment.** It is **off
      by default**, and with it off the invited owner goes straight from login to
      checkout — no location step and **no AI demo**, which is the meeting's best
      moment. The funnel is correct either way (`resolveFunnelEntry` routes
      `pending_payment` → `/onboarding/pay` when the demo is off, and the wizard
      captures the location itself), so this is a product call, not a bug — but
      it must be a *decided* one, and Part 5 step 4 tells the co-founders to ask.
      Note the per-demo LLM cost sits under the existing onboarding-demo cost
      guard.
- [ ] **Verify the live production value of `SELF_SERVE_SIGNUP_ENABLED`.** The
      design assumed it has always been `false` in prod; if it was ever flipped
      on temporarily during an onboarding, some assumptions in the plan's
      write-up are wrong (the design itself is unaffected). This is a read, not
      a change.
- [ ] **Confirm WS8 cutover timing.** Migrations **077 and 078** are
      deliberately absent in production and apply *inside* the WS8 tier cutover
      (`docs/runbooks/ws8-tier-cutover.md`); migration **105** replaces a
      constraint over 077's columns, so it cannot be applied in production
      before that cutover. **Until WS8 runs in prod, this checkout path is
      staging-only.** Do not apply 077, 078, or 105 to production out-of-band.
- [ ] **Run the staging smoke** — the operator checklist is
      `docs/runbooks/beta-production-standup.md` → **Phase F**. It is the proof
      that $0-due-today, card-collected, active-with-discount, and
      full-price-at-month-4 all actually hold.
