# RepWorth launch explainer — script and shot list

Source of truth for narrative: `docs/roadmap/2026-08-26-brand-story.md`.
This file adds nothing to that story. It sequences it for film.

**Locked spec**

| Decision | Value |
|---|---|
| Runtime | 1:55 – 2:10. Unhurried. Not compressed to 90s. |
| Format | 16:9 master, 1920×1080. No vertical cut. |
| Voice | AI narrator. Warm, measured, mid-range. |
| Music | Sparse ambient bed. Low pads. One lift at Act 4. |
| Captions | Burned in. |
| Visuals | Documentary b-roll, no faces. Real UI screenshots, animated. |
| Screenshots | Throwaway dev capture route. Real components, fixture data. |
| Demo account | Northbank Kitchen. Fictional. Marked "Demo data". |
| Audience | Owner variant (brand story §7 default). |
| Honesty | Governance present-tense (§8 "true today"). Autopilot framed as the ladder. Act 4 future-framed. |
| End card | Tagline + logo. No URL. |

---

## ACT 1 — The problem · 0:00 – 0:20

**Narration** (46 words)

> For a local business, your reputation is the storefront.
> Customers read the reviews before they call.
> Now AI assistants read them too — and recommend accordingly.
> Every unanswered review quietly costs you covers.
> But nobody opened a restaurant to spend their evenings on Google.

**Shots**

| # | Shot | Motion |
|---|---|---|
| A1 | Empty dining room at night. Chairs on tables. One lamp still on. | Slow push in |
| A2 | Phone face-up on a steel kitchen pass. Screen wakes. A review notification lands. | Static, rack focus to screen |
| A3 | Hands wipe down the pass. Service is over. No face. | Slow left drift |
| A4 | Front door. Lock turns. Street light outside the glass. | Static, held |

**Typography** — none. Act 1 is image and voice only.

---

## ACT 2 — The turn · 0:20 – 0:38

**Narration** (47 words)

> AI can write review replies now.
> Everyone's AI can. That's the problem.
> Your reputation is your name, in public, forever.
> Hand it to an unsupervised text generator, and a bad week becomes a screenshot.
> Almost nobody answers the real question.
> **Who is watching the agent?**

**Shots**

| # | Shot | Motion |
|---|---|---|
| B1 | A wall of identical, generic AI review replies scrolling. Cold blue light. | Fast vertical scroll, motion blur |
| B2 | A phone screen. A screenshot flash freezes one bad reply. | Hard cut, freeze |
| B3 | Cut to black. | — |

**Typography** — "WHO IS WATCHING THE AGENT?" full frame on black. Held 2s. This is the hinge of the film.

---

## ACT 3 — The answer · 0:38 – 1:33

**Opening line** (7 words)

> RepWorth was built governance first. Autonomy second.

**Beat 1 — Reply drafts in your voice** (16 words) · 0:41 – 0:49

> A review arrives. RepWorth drafts the reply in your voice — learned from your own edits.

*UI-01* Reviews list, new review lands.
*UI-02* Draft reply panel opens. Text types on. Approve / Edit visible.
*UI-03* Owner edits one line. "Learned from your edits" indicator lights.

**Beat 2 — Guardian escalates** (18 words) · 0:49 – 0:57

> A one-star complaint comes in. Guardian holds it and sends it to you. It never speaks in public.

*UI-04* A 1-star review enters the list. A red "Held — escalated to you" badge sets.
Callout ring on the badge. Public reply field greys out.

**Beat 3 — The rules you set** (21 words) · 0:57 – 1:06

> You set the rules once. Which reviews it may answer alone. How many a day. What it may never say.

*UI-05* Settings → auto-approval. Trust dial, rating band, daily cap, never-say list.
Three sequential highlight rings, one per rule.

**Beat 4 — Requests that refuse** (18 words) · 1:06 – 1:14

> It asks every eligible customer for a review — and shows you the ones it refused to send.

*UI-06* Requests page. A batch of sent asks. Then the withheld column with reasons.
Callout on one withheld row: the reason text.

**Beat 5 — The Judge and the veto window** (27 words) · 1:14 – 1:25

> An independent Judge reviews one hundred percent of automatic posts.
> If the Judge is down, posting stops.
> And you hold a veto window before anything goes live.

*UI-07* Judge verdict panel on an auto-post.
*UI-08* Veto window countdown before publish.
Split-screen for the last three seconds: Judge left, veto right.

**Beat 6 — The audit trail** (9 words) · 1:25 – 1:29

> Every action lands on a record you can check.

*UI-09* Activity log. Rows stack in, one per action, with timestamps.

**Ladder** (20 words) · 1:29 – 1:38

> Start on Copilot — you approve everything, and RepWorth learns your standards.
> Graduate to Autopilot, where it runs inside them.

Typography: COPILOT → AUTOPILOT as a two-stage ladder graphic. No UI.

---

## ACT 4 — The vision · 1:38 – 1:58

Label this act on screen: **"Where this is going."** Non-negotiable — brand story §8.

**Narration** (44 words)

> Here is where this is going.
> One morning, you wake to a single message.
> Fourteen reviews handled overnight. Thirty-eight requests sent. Two complaints escalated. One unhappy customer recovered.
> And a note: arrival-time complaints are your fastest-growing issue.
> Nothing else needs your attention.

**Shots**

| # | Shot | Motion |
|---|---|---|
| D1 | Morning sun through the window of the same empty dining room from A1. | Slow push in — mirrors A1 |
| D2 | Phone on the counter. One message. Lines of the morning report type on. | Static, text builds |
| D3 | Service starting. The room fills. Plates go out. Warm. | Slow drift right |

Music lifts here. This is the only lift in the film.

---

## OUTRO · 1:58 – 2:08

**Narration** (15 words)

> RepWorth. AI that does the work. Rules that you set. A record you can check.

**Shots**

1. Cut to the brand ground. Logo mark draws on.
2. Wordmark sets beneath it.
3. Tagline sets: *AI that does the work. Rules that you set. A record you can check.*
4. Hold 3s. Values line fades in below: *Earn trust. Never manufacture it.*
5. Fade to black.

No URL. No CTA button. No pricing.

---

## Asset manifest

### UI captures needed — 9 states, 1440px wide

| ID | Route | State |
|---|---|---|
| UI-01 | `/dashboard/reviews` | Populated list. New 5-star review at top. |
| UI-02 | `/dashboard/reviews` | Draft reply panel open. Approve / Edit. |
| UI-03 | `/dashboard/reviews` | Edit mode. Voice-learning indicator. |
| UI-04 | `/dashboard/reviews` | 1-star held and escalated. Reply field disabled. |
| UI-05 | `/settings/auto-approval` | Trust dial, rating band, daily cap, never-say list. |
| UI-06 | `/dashboard/requests` | Sent asks plus withheld asks with reasons. |
| UI-07 | `/dashboard/reviews` | Judge verdict on an auto-post. |
| UI-08 | `/dashboard/reviews` | Veto window countdown. |
| UI-09 | `/dashboard` | Activity log / audit rows. |
| UI-10 | `/dashboard` | Populated overview. 4.6 · 94% · 11.4 hrs. Agents working. |
| UI-11 | `/dashboard/analytics` | Rep Pulse and reputation trend. |

UI-10 and UI-11 are cutaways used across Act 3.

### Generated b-roll — 9 clips

A1, A2, A3, A4 · B1, B2 · D1, D2, D3.
Documentary. No faces. Warm tungsten for the restaurant. Cold blue for B1–B2.

### Audio

1. Narration — one voice, warm, measured, mid-range. ~288 words.
2. Music — sparse ambient bed. One lift at 1:38.
3. UI sound design — soft ticks on state changes. Optional.

### Assembly

Higgsfield `video-editing` (higgsedit) timeline. Renders the 1920×1080 MP4.
