# RepWorth Beta — Founder's Guide to Onboarding Businesses

> **Who this is for:** RepWorth co-founders running beta onboarding meetings with
> business owners. No technical background needed — everything technical stays
> on Norbert's side, and this guide tells you exactly where that line is.
>
> **Status:** written 2026-08-09 for the first beta cohort (10–15 businesses,
> free for 3 months); recommitted 2026-08-10. Companion docs: the beta decisions
> live in `docs/launch-checklist.md` ("Beta cohort decisions"); the technical
> posture is ADR 0005.
>
> **Before your first meeting:** read Parts 1–4 fully, skim the rest, and
> confirm the **Feature Status Board (Part 3)** is current with Norbert — it is
> the single list of what you may and may not promise.

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

- **Free for 3 months.** Full Copilot product, no payment at onboarding, no
  invoice during the free period.
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

**Payment mechanics (so you never have to touch them):** the owner pays nothing
at onboarding and you never handle payment details in a meeting. Billing setup
happens on our side after the meeting. **Never create or edit anything in the
Stripe dashboard yourself** — even a well-meant manual invoice can incorrectly
flag a customer's account as unpaid and interrupt their service. Anything
billing-shaped goes to Norbert.

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
| Email notifications + approval links | Live (once account is activated) | Email is the always-on channel. |
| AI drafts for every new review | Live | Typically ready within ~15 min of the review appearing. |
| Edit a draft before approving | Live | On the approval page — textarea, then "Save & post." |
| Ask for a fresh draft ("regenerate") | Live | On the approval page. |
| Import of existing/historical reviews | Live | Owner's choice; see Part 5, step 7. |
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
  seeing it. Ask Norbert to clean up the test afterwards.
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
  at a computer or comfortable on their phone — they'll click through email and
  Google sign-in during the call.
- Tell them in advance to bring: access to their **email inbox** and their
  **Google sign-in** for the business. Nothing else.
- **Coordinate with Norbert before scheduling**: he (or whoever runs technical
  activation that day) should be reachable during the meeting window, because
  a new account needs a short technical activation step before reviews start
  flowing (details in Part 5, step 4). Batch meetings on the same day if you
  can.

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

Total ~45 minutes. Steps 4 and 5 have small waits built in — use them for the
conversation parts.

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

### Step 2 — Create their account (5 min, you drive, screen NOT shared for this part)

On **your** screen (don't share it — the admin console shows internal tools),
open **`/admin/businesses/new`** and fill the four sections:

1. **Business info** — search their business name/address and pick it from the
   dropdown (or paste their Google Maps link).
2. **Owner info** — their name, email (the one they actually read!), phone.
3. **Voice & context** — do this *with* them, conversationally; it's a great
   discovery moment (see Step 8 for what each field means). You can keep it
   light here and refine in Step 8.
4. **Subscription tier** — select **Copilot**. (Always Copilot for beta.)

Submit. Two things happen: the owner gets an **invitation email**, and the
account exists in a "pending activation" state.

### Step 3 — Owner signs in (5 min, owner drives)

Ask the owner to open the invite email (check spam/promotions if it's not there
within 2 minutes) and click the link. They'll set a password and land on their
dashboard, which will show **"Account activation pending — your account is
being set up by your account manager."** That's expected — say so before they
see it: *"You'll see an 'activation pending' note for a few minutes while our
system finishes setting you up."*

### Step 4 — Activation (parallel, Norbert's side)

Message Norbert (or the day's technical contact): **"[Business name] created —
activate."** He completes billing/account activation on our side — the owner
pays nothing and sees nothing. Until this step is done, the product is dormant:
**no notifications go out and nothing can post.** Usually a couple of minutes.

While waiting, talk through Part 6 (what week one looks like) or continue the
voice conversation.

### Step 5 — Connect Google (10 min, owner drives — the big moment)

Once activated, have the owner (sharing *their* screen now, or just narrating):

1. Go to the dashboard and click **Connect Google Business** (there's a card on
   the dashboard; also under Settings).
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

### Step 6 — Notifications check (2 min)

Confirm the owner knows notifications arrive by **email** for now, from
RepWorth — have them add us to contacts / check spam once. (If the status board
says Telegram or WhatsApp are live and the owner prefers one, they can add it
under Settings → Channels.)

### Step 7 — The import decision (3 min, owner decides)

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

### Step 8 — Voice setup (5–10 min, together — this determines draft quality)

Under **Settings → Voice** (or refine what you entered in Step 2). Four things,
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

Note: there is **no automatic signature/sign-off setting** — if they want
"— Maria, Owner" at the end, it should go in their sample replies so the AI
picks up the habit, and they can always edit any draft.

### Step 9 — The first approval (5 min — do this live if at all possible)

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

### Step 10 — Wrap (5 min)

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
| Invite email never arrives | "Let's check spam… no? We'll resend it right after the call." | Verify the email address you entered. Escalate to Norbert. |
| Google connect errors or loops | "This is on us, not on you — team will sort it today." | Screenshot (with the address bar), escalate. |
| Reviews not appearing 30+ min after connect | "Sync can lag; we'll confirm from our side." | Escalate with the business name + connect time. |
| Owner approved but the reply isn't on Google after ~15 min | "Posting can take a few minutes; we'll verify it landed." | Escalate — this one is time-sensitive. |
| Owner says a review never produced a draft email | "Some drafts get an extra safety check on our side — let me look into it." | Escalate; may be a held draft (working as intended) — never speculate to the owner. |
| **A posted reply looks wrong/off-brand** | "Thanks for flagging — we're on it right now." | **Escalate IMMEDIATELY (call, don't text).** A bad public reply is our worst failure mode; minutes matter. |
| Owner asks for refund/legal/contract things | "Let me get you an answer from the team today." | Escalate. Never improvise terms. |

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
- **Activation** — the internal step after account creation that switches the
  account fully on; owners see "activation pending" until it's done.
