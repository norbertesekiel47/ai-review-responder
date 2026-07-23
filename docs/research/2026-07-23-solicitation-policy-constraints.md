# Review-Solicitation Policy Constraints (binding reference)

> **Status:** Research reference — resolves wayfinder ticket #531 (part of map #528).
> **This is engineering research, not legal advice.** It compiles the platform-policy
> and statutory constraints that every Solicitation-agent ticket must cite, and flags
> the questions that need a real lawyer before send-mode ships.
> Researched 2026-07-23 against the primary sources linked inline.

Every later Solicitation ticket (watch-mode, candidate selection, ask copy, send
channels, future voice work) cites this doc instead of re-deriving the rules.

---

## 1. Google policy constraints

Two policy surfaces bind us: the **Maps user-contributed-content policy** (governs the
reviews themselves and how they may be solicited) and the **Business Profile guidance
to merchants**. Violations risk review removal, review pausing on the profile, a public
"suspicious activity" banner, or profile suspension — all directly harmful to the exact
metric our customers pay us to improve.

### 1.1 Review gating (selective solicitation) — PROHIBITED

Google's prohibited-content policy (Fake Engagement section) bans merchants who
"**discourage or prohibit negative reviews, or selectively solicit positive reviews
from customers**."

- Source: https://support.google.com/contributionpolicy/answer/7400114 (Prohibited and restricted content → Fake engagement)
- Binding consequence: **any selection of who gets asked that is conditioned on
  predicted or known sentiment is gating.** "Only ask the 5-star-likely customers" is
  the canonical violation. This applies to the *selection algorithm*, not just the send —
  a candidate-ranking model whose output feeds an ask list is the mechanism Google is
  describing.
- Note the same policy explicitly *permits* neutral solicitation: merchants "may solicit
  or encourage the posting of content that does represent a genuine experience, without
  offering incentives to do so or attempting to influence the rating or the contents of
  the review."
- US law now backs this up: FTC 16 CFR § 465.7 (review suppression) prohibits
  misrepresenting that displayed reviews represent all reviews when negative ones are
  being suppressed (see §3.3). Sentiment-conditioned *asking* is the upstream form of
  the same conduct.

### 1.2 Incentivized reviews — PROHIBITED

Google: merchants must not "**offer incentives – such as payment, discounts, free goods
and/or services – in exchange for posting any review**." The merchant-facing guidance
repeats it: "Offering incentives, like free or discounted goods or services, in exchange
for customers to post reviews, change reviews, or remove negative reviews is considered
fake & misleading content and is strictly prohibited."

- Sources: https://support.google.com/contributionpolicy/answer/7400114 ·
  https://support.google.com/business/answer/3474122 (Get reviews on Google)
- Note Google bans incentives for **any** review (even "honest review, any rating").
  This is stricter than the FTC rule (which targets sentiment-conditioned incentives,
  §3.2). **Google's stricter standard governs product behavior.**
- Binding consequence: no discount codes, entries, points, or freebies anywhere in ask
  copy, follow-ups, or agent-generated conversation. Content templates must be
  lint-able for incentive language.

### 1.3 Ghostwriting / pre-filling review content — PROHIBITED

Google requires that contributions "reflect a genuine experience at a place or
business"; fake-engagement rules ban content "not based on a real experience" and
reviews "paid for, directly or in kind." Merchants must not "request that specific
content be included" in reviews — including "merchants requesting that staff solicit
reviews that include specific content." Conflict-of-interest rules ban reviews written
from an undisclosed employment/contractual relationship — which covers us (a contractor
of the business) drafting or posting review text.

- Source: https://support.google.com/contributionpolicy/answer/7400114
- Binding consequence: the agent may never draft, suggest, seed, or pre-fill review
  *text or rating* for a customer. Ask copy may link to the Google review flow (Google
  explicitly permits sharing the review link / QR code) but must not propose wording,
  keywords, star counts, or talking points. This also rules out "copy this text into
  your review" UX and AI-suggested review drafts shown to end customers. (FTC § 465.2
  independently bans creating/disseminating fake reviews, including AI-generated ones.)

### 1.4 Pressure and on-premises coercion — PROHIBITED

Merchants must not "require or pressure users to leave ratings or write reviews while
on the premises." Source: https://support.google.com/contributionpolicy/answer/7400114.
Binding consequence for content: ask copy must be a request, never a condition of
service; timing logic should avoid "review now while you're standing here" patterns
tied to in-store interactions.

### 1.5 Review velocity / pattern concerns — ENFORCEMENT HEURISTIC, not written rule

Google's written policy contains **no numeric velocity threshold**. The binding text is
the fake-engagement prohibition plus Google's automated moderation, which treats an
unnatural spike of reviews on a profile as a manipulation signal; documented enforcement
includes removing reviews, **pausing new reviews on the profile, and displaying a public
warning banner** to searchers. Third-party numbers ("max N asks/day") are folklore, not
policy — do not encode them as if they were Google's rules.

- Sources: https://support.google.com/contributionpolicy/answer/7400114 (policy basis);
  Google's posted-restrictions enforcement described at
  https://support.google.com/contributionpolicy/answer/7445749 (How Google handles
  policy-violating content).
- Binding consequence: send-mode must **rate-shape** asks (drip over days, proportional
  to real transaction volume) as a self-protective engineering constraint. Treat the cap
  as a tunable guardrail we own, justified by enforcement-risk, and never batch-blast an
  uploaded list.

---

## 2. CAN-SPAM (email) — what it actually regulates

Statute: 15 U.S.C. §§ 7701–7713; FTC compliance guide:
https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business

**Trigger: initiating/sending a commercial electronic mail message** — "any electronic
mail message the primary purpose of which is the commercial advertisement or promotion
of a commercial product or service." Requirements attach to the *message*:

1. No false/misleading header information (From/To/Reply-To must identify the real sender).
2. No deceptive subject lines.
3. Identify the message as an ad (where applicable).
4. Include a valid physical postal address of the sender.
5. Conspicuous opt-out mechanism, operable ≥30 days after send.
6. Honor opt-outs within 10 business days; no fee, no login wall.
7. Sender is liable even when a vendor (us) sends on their behalf — both the business
   whose product is promoted and the sender can be liable.

Penalties: up to **$53,088 per email** (FTC-adjusted civil penalty, 2025 figure).

**Review-ask classification caveat:** a bare post-transaction "how did we do / leave us
a review" message arguably has a transactional-relationship flavor, but the FTC's
primary-purpose test looks at content and presentation; treating review asks as
**commercial** (full CAN-SPAM compliance: address, opt-out, honest subject) is the safe
engineering default and costs little.

---

## 3. TCPA (SMS/calls) — what it actually regulates

Statute: 47 U.S.C. § 227 (text: https://www.law.cornell.edu/uscode/text/47/227);
FCC consumer guidance: https://www.fcc.gov/consumers/guides/stop-unwanted-robocalls-and-texts

**Trigger: making a call or sending a text.** Operative prohibitions: calls/texts to
mobile numbers using an automatic telephone dialing system or artificial/prerecorded
voice without **prior express consent** — and for *marketing* calls/texts, **prior
express written consent**; do-not-call rules for telephone solicitations; caller-ID
spoofing bans extended to text messaging. SMS is covered as a "call" under FCC
precedent. Any future **voice** solicitation using an artificial/AI voice is squarely
inside the artificial-voice prohibition (the FCC confirmed in 2024 that AI-generated
voices are "artificial" under the TCPA).

Private right of action: **$500 per violation (per text/call), trebled to $1,500 for
willful/knowing** — this is the class-action engine; per-message damages × list size is
existential for an SMB.

Also relevant for the FTC side: the Telemarketing Sales Rule (16 CFR Part 310) for any
live/voice telemarketing component.

### 3.1 Related US law that binds regardless of channel

The **FTC Trade Regulation Rule on the Use of Consumer Reviews and Testimonials,
16 CFR Part 465** (final rule announced 2024-08-14, effective 2024-10-21; civil
penalties up to ~$51,744 per violation):
https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465 ·
https://www.federalregister.gov/documents/2024/08/22/2024-18519/trade-regulation-rule-on-the-use-of-consumer-reviews-and-testimonials

- **§ 465.2** — bans creating, buying, selling, or disseminating fake/false reviews,
  explicitly including AI-generated reviews and reviews by people with no real
  experience of the product. (3.2)
- **§ 465.4** — bans providing compensation or other incentives **contingent (expressly
  or by implication) on the review expressing a particular sentiment**, positive or
  negative. (Google's rule is stricter: no incentives at all — §1.2.)
- **§ 465.5** — insider reviews without clear disclosure of the material connection.
- **§ 465.7** — **review suppression** (3.3): unfounded legal threats/intimidation to
  remove reviews, and misrepresenting that a displayed review set represents most/all
  submitted reviews when negatives are suppressed.

---

## 4. Watch-mode scope analysis

**Watch-mode = analysis of an uploaded contact list; ZERO messages sent.**

**Verdict: watch-mode is outside the operative scope of both CAN-SPAM and the TCPA.**
CAN-SPAM's obligations attach to initiating a commercial email; the TCPA's attach to
making a call or sending a text. Neither statute regulates storing, scoring, or
analyzing contact data when no message is transmitted (confirmed against the statutory
text of 47 U.S.C. § 227 and the FTC's CAN-SPAM guide — no provision reaches
pre-send analysis).

**But watch-mode is NOT obligation-free**, on two axes:

1. **Data-protection law applies at upload, not at send.** An uploaded contact list is
   personal information (names, emails, phone numbers, transaction history) of people
   who have no relationship with RepWorth. CCPA/CPRA-style state privacy laws
   (California, Colorado, Virginia, Texas, and the growing roster) impose
   notice-at-collection, purpose limitation, service-provider/processor contract terms,
   deletion/access rights, and security obligations on *holding and processing* the
   data — zero sends required. RepWorth is a **service provider/processor** for the
   SMB's customer list; our ToS/DPA must say so.
2. **Google's gating prohibition binds the selection algorithm even in watch-mode**
   *if* watch-mode's output is a sentiment-filtered ask list that a later send-mode (or
   the owner manually) acts on. Analysis is not a send, but a "here are your happiest
   customers — ask these" artifact is a gating instrument. Watch-mode outputs must be
   framed and built as insight (segments, timing, volume shaping), not as a
   sentiment-screened solicitation queue.

**State-law flags to check before send-mode (flag level, not analysis):**

- **Mini-TCPAs** (~15+ states, 2026): Florida FTSA (broader autodialer definition,
  express written consent, main SMS class-action venue), Oklahoma, Washington
  (10-second DNC hangup rule), Maryland/Oklahoma (3 contact attempts/day caps), Texas
  (2025 update). Where stricter than federal, the state rule governs contacts into that
  state → send-mode needs per-recipient-state awareness or must comply with the
  strictest common denominator.
- **State anti-spam email laws** (e.g., Washington CEMA, California § 17529.5) —
  CAN-SPAM preempts most but not falsity/deception-based state claims.
- **Quiet hours** (federal 8am–9pm recipient local time for telemarketing; some states
  narrower) — a send-scheduler constraint.
- **Consent provenance:** TCPA consent belongs to the *business*, is arguably
  non-transferable, and an uploaded CSV carries no proof of it. Send-mode needs a
  consent attestation + record model designed with counsel.

---

## 5. Implications table: SELECTION vs SENDING vs CONTENT

| # | Constraint | Source | Binds SELECTION (even watch-mode) | Binds SENDING (send-mode) | Binds CONTENT (ask copy / future voice) |
|---|---|---|---|---|---|
| 1 | No review gating / selective solicitation by predicted or known sentiment | Google 7400114; FTC § 465.7 (downstream) | **YES — core constraint.** Candidate selection must be sentiment-blind; segments may use recency, transaction, channel reachability — never predicted rating | YES — the ask list actually acted on is the evidence | Indirect — copy must not steer ("if you loved us, review us; if not, contact us privately" is a gating funnel) |
| 2 | No incentives for reviews (any rating) | Google 7400114 / 3474122; FTC § 465.4 | No | No | **YES** — zero incentive language, ever; lintable template rule |
| 3 | No ghostwriting / pre-filled review text, rating, keywords | Google 7400114; FTC § 465.2 | No | No | **YES** — link to Google review flow only; never draft/suggest review content to the end customer |
| 4 | No pressure / on-premises coercion | Google 7400114 | Timing features must not target "customer on premises now" | YES — send timing | YES — request framing, no conditions |
| 5 | Velocity/pattern shaping (enforcement heuristic, not written rule) | Google fake-engagement enforcement (7445749) | Partial — batch sizing of the candidate queue | **YES** — drip pacing proportional to real transaction volume; never blast | No |
| 6 | CAN-SPAM: headers, subject, ad identity, postal address, opt-out ≤10 days | 15 U.S.C. 7701 ff.; FTC guide | No | **YES** — suppression list + opt-out plumbing before first email | YES — subject honesty, footer requirements |
| 7 | TCPA + mini-TCPAs: prior express (written) consent, DNC, quiet hours, per-state rules; artificial/AI voice = prerecorded-voice territory | 47 U.S.C. § 227; FCC; FL/OK/WA/MD/TX statutes | No (but consent metadata should be a selection input: no consent ⇒ not a candidate) | **YES — hardest send-mode gate**; $500–$1,500/text exposure | YES for voice — AI voice triggers artificial-voice rules |
| 8 | State privacy law (CCPA/CPRA family): notice, purpose limit, processor contract, deletion, security for uploaded PII | State statutes | **YES — binds at list upload**, before any analysis output | YES | No |
| 9 | Insider/material-connection disclosure | FTC § 465.5; Google conflict-of-interest | No | No | YES — anything we author for public display must not masquerade as customer voice |

**Watch-mode ship-gate summary:** rows 1 (selection design) and 8 (PII handling) bind
watch-mode. Everything else activates at send-mode or in content authoring.

---

## 6. Flags for a real lawyer (before send-mode)

Not analysis — a checklist to hand to counsel:

1. Consent model for SMS: what consent record must the SMB attest to / upload, is it
   transferable to RepWorth as sender-agent, and who is the "maker" of the call under
   TCPA when our agent sends?
2. Primary-purpose classification of a review ask email (commercial vs
   transactional/relationship) — we default to commercial-compliant regardless.
3. Per-state mini-TCPA matrix (FL, OK, WA, MD, TX at minimum) vs
   strictest-common-denominator sending policy.
4. RepWorth's role under CCPA/CPRA family for uploaded lists (service provider/processor
   terms in ToS/DPA), retention and deletion SLAs for watch-mode data.
5. Whether watch-mode sentiment analytics shown to the owner (with no ask-list output)
   could still be construed as facilitating gating if the owner manually solicits from it.
6. Future AI-voice solicitation: FCC artificial-voice ruling (2024) + state AI-disclosure
   laws.

---

*Compiled 2026-07-23 from primary sources (Google policy pages, statutory text via
Cornell LII, FTC/FCC guidance, eCFR/Federal Register). Where a primary page was
paywalled/bot-blocked, language was cross-checked against the statute text and reputable
legal summaries; quotes marked as quotes came from the policy pages themselves.*
