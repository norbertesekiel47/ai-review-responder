# Marketing pages agentic refresh — Features + How-it-works

**Date:** 2026-07-22
**Status:** Approved (brainstorming session with owner)
**Scope:** `/features` and `/how-it-works` public pages only. No data flow,
flags, API surface, or `selfServeEnabled` plumbing changes.

## Problem

Both pages still tell the pre-agentic story (email-only approval loop, flat
6-feature list). The pricing page, the brand-story doc
(`docs/design/brand-story.md`), and the shipped platform (design of record
§8, WS1–WS8) have all moved to the two-tier agent narrative: Copilot/Autopilot
tiers, Reply/Guardian/Insights personas, Judge + Governor watchdogs, trust
dial, veto window. The stale pages undersell the differentiator and in places
make claims that are now wrong (approval is email-only; auto-approval exists
only as a FAQ footnote).

## Decisions (made with owner)

1. **Full two-tier story** — both pages present the agent narrative with
   Copilot and Autopilot as co-stars, matching the pricing page. Not
   Copilot-led-with-a-teaser, not a minimal freshness pass.
2. **Restructure sections, reuse patterns** — re-plan the section lineup;
   reuse the existing visual patterns (numbered sections, step artifacts,
   reveal animations). New bespoke artifacts only where a section needs one.
   Not copy-only, not a full redesign.
3. **How-it-works spine: one pipeline, forked gate** — a single linear step
   story where the gate step forks into Copilot (owner approves) vs Autopilot
   (policy + veto window). Not two parallel journeys, not a bolt-on autonomy
   chapter.

## Shared narrative frame

- Lead with **trusted autonomy** ("The AI agent for your reputation"), not
  "AI writes replies". The signature beat is the **gate**: nothing goes
  public without passing draft → moderate → judge → approve/veto.
- Brand guardrails apply (brand-story.md): no fake metrics (keep the
  existing "illustrative, not live data" disclaimer pattern), no anti-slop
  vocabulary, roadmap items only as two-word verb phrases, never
  present-tense claims for unshipped capabilities.
- **"Negative reviews are never auto-posted"** stated plainly on both pages
  (mirrors pricing copy).
- Approval channels: email, Telegram, or WhatsApp ("the channel you choose").
- `metadata.description` in both `page.tsx` files updated to match.
- CTAs stay waitlist (`LeadIntakeForm`, site is pre-launch).

## Features page — new section lineup

TOC regroups from a flat 7-feature list into three labeled groups, keeping
the numbered-chip visual pattern. Index label ("6 live · 1 in testing")
updated to match the new lineup.

**Your agent team** (leads the page)

| # | Section | Source | Content |
|---|---|---|---|
| 01 | Reply | update `FeatAi` | Drafts every reply from scratch in your voice; before/after card stays |
| 02 | Guardian | NEW | Triages negative reviews by severity, escalates serious ones to the owner, never acts publicly. Reuses the timeline-step pattern from `FeatApprove` |
| 03 | Insights | reframe `FeatBrief` | The Insights persona; Monday-brief artifact stays |

**Care and control** (the gate story)

| # | Section | Source | Content |
|---|---|---|---|
| 04 | The Gate (Copilot) | update `FeatApprove` | One-tap approval via email, Telegram, or WhatsApp; phone artifact stays |
| 05 | Autopilot | NEW | Owner-set policy (4–5★ unflagged only), trust dial (rating band + daily cap), 15/30-min veto window. New artifact: veto-window countdown card |
| 06 | The watchdogs | NEW | Judge reviews 100% of auto-posts — auto-posting *stops* if the Judge is unavailable; Governor suspends an account's autonomy if trust slips. Dark-section treatment |

**Craft and proof**

| # | Section | Source | Content |
|---|---|---|---|
| 07 | Voice | keep `FeatVoice` | Learns edit by edit. One dark section per page-half — if 06 is dark, 07 gets a light treatment (resolved at implementation) |
| 08 | Languages | keep `FeatLang` | Unchanged |
| 09 | ROI | keep `FeatRoi` | Unchanged |

**Roadmap band** (unnumbered; replaces the `FeatComp` competitor section):
verb phrases per brand doc — "Get reviews · Flag fakes · Watch everywhere" —
with the competitor scorecard preview folded in as "in testing".

Hero: keep structure (staggered words, metric trio, review marquee); headline
and lede rewritten for the agent narrative; metric labels adjusted if needed
(still explicitly illustrative).

## How-it-works — one pipeline, forked gate

4-step spine becomes 6 steps:

| # | Step | Artifact | Content |
|---|---|---|---|
| 1 | Watch | existing feed | Webhook ingest, near-real-time; copy already accurate |
| 2 | Triage | NEW severity/lane card | Guardian reads it first; negative reviews get severity triage and can escalate straight to the owner |
| 3 | Draft | existing typewriter | Reply writes it in your voice; every draft passes moderation |
| 4 | The Gate | existing email artifact + NEW countdown artifact | The fork, presented as a two-column split (not tabs): **Copilot** — draft comes to you, one tap; **Autopilot** — draft passes your policy, then a veto window counts down before posting. Visual centerpiece of the page |
| 5 | Post | existing posted card | Posted to Google as the owner; auto-posts send an FYI with an undo path |
| 6 | Judge | NEW verdict card | After any auto-post the Judge reviews it; if trust slips, the Governor pauses autonomy on its own |

- **Under the hood** strip: 6 nodes matching the steps.
- **Guarantees:** "Nothing posts without passing the gate" · "Negative
  reviews are never auto-posted" · "Sounds like you wrote it" · "Pause
  anytime — and the Governor can pause it for you."
- **FAQ:** rewritten to align with the pricing page's answers (what can
  Autopilot post, what if I never approve, voice learning, negative reviews,
  supported platforms).
- Hero + overview strip updated to the 6-step pipeline.

## Code shape

- Both components are oversized (`FeaturesContent.tsx` 1,215 lines,
  `HowItWorksContent.tsx` 768 lines) and this change adds sections. Targeted
  improvement: split each feature section (`FeatAi`, `FeatGuardian`, …) and
  each how-it-works step artifact into its own file under the existing
  `src/components/sections/features/` and `src/components/sections/how-it-works/`
  folders. The two `*Content.tsx` files become thin orchestrators.
- No new top-level directories, no new dependencies. Existing reveal /
  animation hooks (`useReveal`, `usePrefersReducedMotion`, `useCountUp`)
  reused.
- Every new artifact replicates the reduced-motion handling pattern the
  existing artifacts use (skip loops/entrances, render the final frame).
- `repworth-brand-design` skill governs all UI work at implementation time.

## Error handling / testing

Pure presentational change. Verification gate: `pnpm lint && pnpm typecheck
&& pnpm test`; the existing `__tests__` suites for both components updated
for the new section structure (section presence, headings, FAQ content,
reduced-motion rendering).

## Out of scope

- Pricing page (already current), landing page, help/contact pages.
- Any change to flags, entitlements, notification code, or the approval flow
  itself.
- New photography/illustration assets; everything stays CSS/SVG in-file.
