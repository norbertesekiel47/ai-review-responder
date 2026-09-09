> **Historical reference.** Superseded by the [Brand Asset Library](../README.md). Do not use this file as a current brief or source of availability claims. Original content is retained below.

# Marketing content generation — Claude Project setup

> **Who this is for.** A non-engineer generating RepWorth marketing content:
> ads, social posts, email sequences, and long-form/SEO pages.
>
> **Time to set up:** about 15 minutes, once.
> **Running cost:** one flat monthly Claude seat. No per-token bill.

---

## Why this lane

Marketing copy needs a human in the loop on most pieces. A flat-rate Claude
seat gives you unlimited-ish iteration at a fixed, predictable cost. Paying per
token through the API only wins when you need hundreds of near-identical
variants with no per-piece judgement — see §8.

**Do not do this work inside the RepWorth code repository.** That project loads
a large engineering context on every message. It is useless for marketing and
it slows every response down.

---

## 1. Get a seat

Get a paid Claude seat at `claude.ai` (Pro is enough to start; move to Max if
you hit usage limits during a heavy writing week).

---

## 2. Create the Project

1. Go to `claude.ai`.
2. Open **Projects** in the left sidebar.
3. Click **New project**.
4. Name it: `RepWorth Marketing`.
5. Description: `Ads, social, email, and SEO copy for RepWorth.`

A Project keeps the brand kit loaded across every chat inside it. You never
paste the brand context again.

---

## 3. Add the brand kit

1. Open the Project.
2. Find **Project knowledge** on the right.
3. Click **Add content** → upload `docs/brand-asset-library/brand-kit/BRAND-KIT.md`.

Ask an engineer to export that file for you, or open it in the repo and copy
the whole thing into a text file named `BRAND-KIT.md`.

---

## 4. Set the custom instructions

In the Project, click **Set instructions** (or **Edit** next to instructions).
Paste this exactly:

```
You write marketing copy for RepWorth. BRAND-KIT.md in project knowledge is
your source of truth. Read it before every task.

Hard rules, in priority order:

1. Never claim an unshipped capability in present tense. CRM Manager,
   Social Media Manager, fake-review disputes, and any platform other than
   Google are FUTURE TENSE ONLY. Solicitor (email review requests) and the
   Review QR are present tense. If you are unsure whether something ships
   today, ask me instead of guessing.
2. Never invent proof. No customer counts, testimonials, case studies,
   logos, press mentions, ratings, or performance metrics. RepWorth has
   none. Fabricating one is the worst failure available to you.
3. Use the fixed vocabulary in BRAND-KIT.md section 4 exactly. Capitalize
   agent names. Guardian is a persona, never a tier.
4. Lead with the gate (trusted autonomy), not with drafting.
5. Obey the banned-words list in section 10.
6. One claim per piece.
7. Never publish a price or trial offer without me confirming it first.

Working style:

- Ask a clarifying question when the brief is ambiguous. One question, then
  proceed.
- Give me options as a numbered list I can pick from, not a single take.
- When you finish, run the section 14 pre-publish checklist against your own
  output and tell me anything that fails.
- Write in plain prose. No em-dash pileups, no rhetorical questions, no
  "Here's the thing", no thread-bait hooks.
```

---

## 5. Prompt templates

Start a **new chat inside the Project** for each batch. Do not run one long
chat for weeks — long chats get slower and more expensive in usage terms.

### Ads and social

```
Write 12 LinkedIn post options for RepWorth.

Angle: [pick ONE — the gate / the 3 AM reply / Guardian escalation /
the Judge / voice matching]
Audience: [e.g. dental practice owners with 2-4 locations]
Goal: early-access signups

Rules: one claim per post. Owner-to-owner voice, first person. No hooks,
no emoji, no thread markers. 60-120 words each.
Give me 12 options as a numbered list, then tell me which 3 you'd run and
why.
```

### Email sequence

```
Write a [N]-email [cold outreach / onboarding / nurture / beta invite]
sequence for RepWorth.

Audience: [e.g. salon owners who requested early access]
Sequence goal: [e.g. book a 15-minute demo]
Send cadence: [e.g. day 0, 3, 7, 14]

For each email give me: subject line (4-7 words), preview text, body,
and one CTA. One ask per email. Founder voice, first person singular.
Flag anywhere you need a fact I have not given you.
```

### Long-form and SEO

```
Write an SEO blog post for RepWorth.

Target query: [e.g. "how to respond to a 1-star google review"]
Length: 1500+ words
Audience: [e.g. independent restaurant owners]

Structure: answer the query in the first 100 words, then earn the rest.
One H1, descriptive H2s. Include a real, usable template or checklist the
reader can act on today.
Do not pad. If you cannot say something true and specific, cut the section.
Before you write, give me the outline and let me approve it.
```

For programmatic pages (`/{city}-reputation-management`), do them one vertical
or city at a time and give Claude a real local detail per page. If you cannot
supply one, skip that page. Spun pages get the whole domain penalised.

---

## 6. Model choice inside claude.ai

Use the model selector at the bottom of the chat box.

| Task | Model |
|---|---|
| Bulk drafts, variants, rewrites | **Sonnet** — faster, uses less of your limit |
| Positioning, headlines, anything strategic | **Opus** — better judgement |
| Long-form outlines and structure | **Opus** for the outline, **Sonnet** for the draft |

Defaulting everything to Opus burns your usage limit for no gain on
mechanical work.

---

## 7. Keeping the brand kit accurate

The brand kit goes stale when the product ships something new. It is the
difference between honest copy and a false claim.

Re-check it:

- Whenever a feature flag flips in production.
- Whenever prices change.
- Whenever a roadmap item moves from "next" to "live".

To update: edit `docs/brand-asset-library/brand-kit/BRAND-KIT.md`, then re-upload it to the
Project (remove the old file first). Update the "Last verified" date at the
top.

---

## 8. When to escalate to the batch lane

Stay in this lane unless **all three** are true:

1. You need 200+ pieces in one run.
2. The pieces are templated — same shape, different input row.
3. No per-piece human judgement is needed before it is generated.

Example that qualifies: 400 city-page intros from a CSV of cities.
Example that does not: 12 LinkedIn posts you want to react to and reshape.

If you hit that bar, ask an engineer to build a Batch API script. Estimated
cost for 500 pieces with prompt caching is roughly $2–6, versus about $19
unoptimised. It is worth building only at that volume.

---

## 9. Before anything goes public

Run section 14 of the brand kit. The two failures that matter most:

- **A present-tense claim about something unshipped.** Solicitor is the most
  likely one, because it is substantially built and reads as real.
- **An invented metric or testimonial.** There are none to cite.

Either one is a credibility problem, not a copy problem. When in doubt, ask.
