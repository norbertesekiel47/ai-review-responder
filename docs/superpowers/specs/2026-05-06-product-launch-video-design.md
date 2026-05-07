# Product Launch Video — Design Spec

**Date:** 2026-05-06  
**Format:** LinkedIn · 16:9 · ~60 seconds  
**Approach:** Fully AI-generated scenes  
**Narrative arc:** Pain → Relief  
**CTA:** Join the waitlist

---

## Overview

A 60-second LinkedIn launch video for RepWorth. Fully AI-generated visuals using Runway Gen-4, ElevenLabs voiceover, and Suno music. No filming required. Targets SMB owners (restaurants, cafés, salons) who recognize the pain of managing Google reviews manually.

Tone: calm, confident, matter-of-fact. Not hustle-culture excitement — the RepWorth brand is relief, not hype.

---

## Storyboard + Script

### Scene 1 — The Pain (0:00–0:08)

**Visual:** Close-up on a tired restaurant owner's hands holding a smartphone in a dimly lit kitchen. Phone screen glow on their face. They read a bad review, begin typing a reply, then stop and put the phone face-down.

**Voiceover:** *(silence — ambient kitchen sound fades out)*

**Runway prompt:**
> Cinematic close-up of a tired restaurant owner's hands holding a smartphone in a dimly lit kitchen, 11pm, phone screen glow on their face, they read something upsetting, begin to type, then stop. Natural lighting, shallow depth of field, 16:9, photorealistic.

---

### Scene 2 — Recognition (0:08–0:18)

**Visual:** Wide shot — same owner sitting at an empty restaurant table, laptop open, surrounded by sticky notes. Stack of unanswered reviews on screen. Clock on wall: 11:47pm.

**Voiceover:** *"Every week, thousands of small business owners lose sleep over their Google reviews."*

**Runway prompt:**
> Cinematic wide shot, tired restaurant owner sitting alone at empty restaurant table late at night, laptop open showing review dashboard, wall clock reads 11:47pm, warm but exhausted atmosphere, dim overhead lighting, 16:9, photorealistic, film grain.

---

### Scene 3 — The Turn (0:18–0:26)

**Visual:** Static brand card. Fade to RepWorth cream background. Centered text animates in — unhurried.

**On screen:** *"What if every review just… got handled?"*

**Voiceover:** *(pause — let the text breathe)*

**Production note:** Not a Runway scene. Build in Canva/Figma: `#F0EEEA` background, Fraunces italic, center-aligned, slow fade-in.

---

### Scene 4 — The Solution (0:26–0:44)

**Visual:** Calm sunlit café. Business owner relaxed at counter holding a smartphone. RepWorth UI on screen: a review arrives → "Draft ready (8s)" → owner taps Approve → "✓ Posted to Google."

**Voiceover:** *"RepWorth reads every review and drafts a reply — in your voice — in under 8 seconds. One tap to approve. It posts itself."*

**Runway prompt:**
> Bright sunlit café morning, business owner relaxed at counter holding smartphone, screen shows a clean app UI with a drafted reply, they tap approve with a smile, warm natural light, 16:9, photorealistic.

**Production note:** Overlay the RepWorth UI mockup (phone frame + approval flow screenshot) on top of the Runway background in CapCut.

---

### Scene 5 — The Relief (0:44–0:56)

**Visual:** Wide shot — same owner from Scene 1, now in morning light, laughing with a customer. Phone buzzes briefly. They glance: "2 replies approved overnight." They smile and keep going.

**Voiceover:** *"Trained on your best replies. Always on brand. Never misses a review."*

**Runway prompt:**
> Bright morning in a busy café, smiling restaurant owner chatting warmly with a customer, relaxed and present, natural window light, slight bokeh background, 16:9, photorealistic, golden hour tone.

---

### Scene 6 — CTA (0:56–1:00)

**Visual:** Static brand card. Fade to RepWorth sage green. Logo centered. Tagline below. Waitlist URL.

**On screen:**
- RepWorth logo (PNG from `/public/`)
- *"Every review gets the reply it deserves."*
- `repworth.com` · Join the waitlist →

**Production note:** Build in Canva/Figma: `#D2E0D3` background, logo PNG, DM Sans typeface.

---

## LinkedIn Caption

Post body:
> Most business owners know they should respond to every Google review. Almost none do — because it takes time they don't have, and energy they've already spent.
>
> We built RepWorth to handle it automatically. Your voice, your tone, every review.
>
> Join the waitlist → [link]

First comment (for reach):
> "The cost of ignoring a Google review isn't just a bad rating — it's a customer who chose the place next door instead."

---

## Production Pipeline

**Total estimated time:** 4–6 hours (first run)  
**Total cost:** ~$15 (Runway Basic plan; everything else is free)

### Step 1 — Voiceover (ElevenLabs)

- Paste the full script into ElevenLabs
- Recommended voices: "Rachel" (warm female) or "Adam" (calm male)
- Settings: Stability 60, Similarity 75, Style 20
- Export as MP3 — this becomes the timing master for all editing
- Free tier covers it

### Step 2 — Background Music (Suno)

- Suno prompt: *"Calm lo-fi background music, no vocals, soft piano and gentle guitar, warm and reassuring, slow tempo, suitable for a business product video"*
- Generate 3–4 variations, pick the least distracting
- Export highest quality MP3
- Target mix level: ~15% volume under the voiceover (-18dB relative)
- Free tier (5 credits/day)

### Step 3 — AI Video Scenes (Runway Gen-4)

- Run the 4 Runway prompts for Scenes 1, 2, 4, 5
- Settings: 16:9, 10 seconds per generation
- Budget 3–5 attempts per scene — discard anything with uncanny faces
- Tip: prompt for "hands only" or "back of head" shots if faces look AI-generated; they're more reliable and equally emotive
- Add to every prompt: *"cinematic, shallow depth of field, film grain, 16:9, photorealistic"*
- Runway Basic plan: $15/mo (cancel after if not needed ongoing)

### Step 4 — Static Cards (Canva or Figma)

Scene 3 — Title card:
- Background: `#F0EEEA` (RepWorth cream)
- Font: Fraunces italic, center-aligned
- Text: *"What if every review just… got handled?"*
- Animation: slow fade-in

Scene 6 — Brand CTA card:
- Background: `#D2E0D3` (RepWorth sage green)
- RepWorth logo PNG (from `/public/`)
- Tagline: DM Sans, below logo
- URL + waitlist CTA

Export both as PNG (import as still frames in CapCut, hold duration 4–5 sec each).

### Step 5 — Product UI Mockup (Mockuphone or Rotato)

- Screenshot the RepWorth dashboard showing a drafted reply
- Drop into a phone frame via Mockuphone (free) or Rotato (~$10 one-time)
- Animate the "Approve" tap: record a short screen capture or build as a GIF
- Export as MP4 clip — overlay this on the Scene 4 Runway background in CapCut

If product UI isn't ready: build a clean mockup in Figma/Canva showing the approval flow: `[Review text] → "Draft ready (8s)" → [Approve button] → "✓ Posted to Google"`

### Step 6 — Assembly (CapCut)

Assembly order:
1. Import all Runway clips, static cards, VO MP3, music MP3, UI mockup clip
2. Arrange clips per storyboard timing
3. Add auto-captions (CapCut AI captions tool — review for accuracy before export)
4. Overlay UI mockup on Scene 4 background
5. Add subtle cross-dissolve transitions (0.3s)
6. Music: fade in over Scene 1, fade out over Scene 6
7. Add 0.5s fade-in on first frame, 1s fade-to-black at end

Export settings: 1920×1080, H.264, highest quality, MP4.

---

## Cost Summary

| Tool | Cost |
|---|---|
| ElevenLabs (voiceover) | $0 — free tier |
| Suno (music) | $0 — free tier |
| Runway Gen-4 (video scenes) | $15/mo — Basic plan |
| Canva (static cards) | $0 — free |
| Mockuphone (phone mockup) | $0 — free |
| CapCut (assembly) | $0 — free |
| **Total** | **~$15** |

---

## Brand Reference

| Token | Value |
|---|---|
| Sage green | `#D2E0D3` |
| Teal | `#97B3AE` |
| Peach | `#F2C3B9` |
| Cream | `#F0EEEA` |
| Ink | `#2A2A2A` |
| Display font | Plus Jakarta Sans |
| Body font | DM Sans |
| Accent serif | Fraunces (italic) |

Logo PNG: `/public/Logo.png`
