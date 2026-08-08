# RepWorth Launch Video — Production Bible

**Direction:** extend the shipped CRT / solarpunk world.
**Runtime:** 60s, 13 beats.
**Budget:** ~310 credits of 2502.

This document exists to make generation **one-pass**. Every re-roll on Higgsfield is
paid in credits, and re-rolls come from underspecified prompts, drifting style prose,
and asking the model for things it cannot do reliably. The rules in §2 are what keep
the cost at 310 instead of 900. Do not improvise around them mid-shoot.

Supersedes the art direction in `RepWorth-hero-video-script.md` (paper collage). That
script's narration and beat structure remain useful reference; its visual treatment does
not apply.

---

## 1. The style key

Locked by the assets already in `public/agents/` and `public/video/`. Do not re-derive
this from prose — §2.2 requires that an approved image be attached as reference on every
call. This section exists so a human can sanity-check a result, not so the model can read
it.

### 1.1 World

A warm solarpunk cliff garden. Overgrown stone ledges, dense green foliage with small
yellow blooms, moss and vines. Behind and below, a pale utopian city of white curved
terraced towers dissolving into atmospheric haze. Soft blue sky, high thin cloud, drifting
particulate in the light. Painterly 3D render, shallow depth of field, generous bokeh.

### 1.2 Characters

Two families, and the distinction between them is the whole product argument. **Never blur
it.**

**Personas — televisions. They have screens. They broadcast. They act.**

Chunky rounded vintage CRT sets, matte sage-green ceramic bodies with subtle surface wear
and chipping, thin metal rabbit-ear antennae with ball tips, small stickers on the flanks.
A dark screen carrying exactly one glowing mint-white glyph, its light spilling warmly
around the bezel.

| Persona | Glyph | Reference still |
|---|---|---|
| Reply | speech bubble | `public/agents/reply.jpg` |
| Guardian | shield | `public/agents/guardian.jpg` |
| Insights | bar chart, warm amber spill | `public/agents/insights.jpg` |
| Solicitor | paper plane | `public/agents/solicitor.jpg` |

**Watchdogs — not televisions. No screens. They observe and they switch.**

| Watchdog | Form | Reference still |
|---|---|---|
| Judge | tall screenless monolith, one recessed lens like an eye, same sage ceramic | `public/agents/judge.jpg` |
| Governor | taller case, a recessed vertical window holding a physical mint toggle lever | `public/agents/governor.jpg` |

Judge has no screen because it never speaks publicly. Governor has a lever because it
does exactly one thing. If a prompt result gives either of them a screen, discard it —
that result is off-model in a way that matters.

### 1.3 Light and grade

**The grade reference is beat 1 itself** — `heroVideo-1600.mp4` recut, ungraded. Every
generated beat is matched to that footage, not to prose. Read it off the frame: warm
sunlight raking from the left onto yellow-green foliage, set against a **cool pale blue
sky**; small cyan accent glows on the towers; heavy atmospheric haze desaturating
everything past the near ledge; strong shallow depth of field with the foreground
foliage fully blurred.

That is **bright morning**, not golden hour. The three acts run day → dusk → dawn:

| | Act 1 — Today | Act 2 — Supervision | Act 3 — Tomorrow |
|---|---|---|---|
| Time | bright morning | dusk, after the sun | dawn breaking |
| Key | warm raking sun, cool sky | cool, high, flat, no warm key | low gold returning from the horizon |
| Lens | close, 50–85mm feel | wide, high angle, still | very wide, craning back |
| Mood | busy, alive, glowing | quiet, watchful, held | open, unfinished, room to grow |

The act break is carried by **light and camera height**, not by new art. Act 2 is the same
ledge with the sun gone and the camera lifted. Act 3 is the sun coming back.

> This arc replaces an earlier "golden hour → blue hour" plan, which would have broken at
> the very first cut: the shipped hero footage is cool-skied daylight and any warm Act 1
> would not match it. Day → dusk → dawn costs nothing extra and makes Act 3 a literal
> sunrise on the unbuilt part of the fleet.

### 1.4 Palette

Sage/mint ceramic `#9db8a8` · glowing mint-white glyphs `#d4f5e4` · deep forest void
`#1a2620` · warm amber spill `#e8b563` · RepWorth gold `#f2c53d` · pale sky `#c9dce8`.

---

## 2. The rules that protect the budget

**2.1 — Still-first, always.** Batch 3 stills for a beat, pick one, *then* image-to-video
from the winner. A rejected still costs 2 credits; a rejected clip costs 14. Never
text-to-video.

**2.2 — One style key, attached not described.** The approved still for a beat is uploaded
and passed as the reference image on the video call, and the persona's `public/agents/*.jpg`
is passed as the identity reference. Style prose drifts between calls; an attached image
does not. This single rule is worth more than every other rule combined.

**2.3 — 4-second clips.** 14 credits vs 17.5 at 5s — 20% off every shot. Retime, hold and
cross-dissolve in the edit. At these camera speeds nobody can tell.

**2.4 — One verb per motion prompt.** "Slow push-in." "Gentle drift." "Light blooms."
Two-part choreography inside one clip is the most reliable way to burn credits. If a beat
needs two moves, it is two clips and a cut.

**2.5 — Kling for ambient, Seedance for character.** Establishing shots, pull-backs,
foliage drift, light changes → Kling 3.0 at 7.5. Shots where a specific agent's identity
must hold → Seedance 2.0 at 14. Preflight both; cost varies with duration.

**2.6 — 720p fast mode throughout.** `upscale_video` the three or four hero shots at the
end. Never regenerate at 4K.

**2.7 — Zero generated text.** Every word, number, logo and label in §4 is composited in
the edit. Generated text is the single largest re-roll driver in any AI video and there is
no reason to accept the risk.

**2.8 — Poll before you retry.** Per the standing rule: on a timeout or ambiguous error,
check job status first. Only resubmit if the job actually failed. Blind retries
double-charge.

---

## 3. The 13 beats

Beat 1 reuses existing footage and costs nothing.

### Act 1 — Today (bright morning, close, warm sun / cool sky)

**1 · Establish — 6s — REUSE, 0 credits — DONE**
`heroVideo-1600.mp4` retimed 2× to 6.04s, preserving the full wide→tight push. 1600×900,
24fps, ungraded. This clip is the grade reference for every beat that follows.

**2 · The problem — 4s — Kling, 7.5cr**
A single review card rests on wet stone at the edge of the ledge, one gold star glowing
faintly above it. The garden around it is dim and empty. No television is lit.
*Motion:* slow drift in, the star pulses once and dims.

**3 · Reply — 4s — Seedance, 14cr** · ref `reply.jpg`
The Reply set on the ledge, screen bright with its speech-bubble glyph. A finished reply
card slides out from beneath the bezel into the warm light.
*Motion:* gentle push-in, the card slides out.

**4 · Guardian — 4s — Seedance, 14cr** · ref `guardian.jpg`
The Guardian set. A dark, ragged review card drifts toward it. The shield glyph brightens
sharply and the card lifts away upward, out of frame, rather than passing.
*Motion:* the card rises and exits; the shield brightens.

**5 · Insights — 4s — Seedance, 14cr** · ref `insights.jpg`
The Insights set in full morning sun, its amber screen spill washing warm across the
stone. Its bar-chart glyph climbs one bar at a time.
*Motion:* slow push-in; the bars rise.

**6 · Solicitor — 4s — Seedance, 14cr** · ref `solicitor.jpg`
The Solicitor set. Small paper envelopes launch from the screen and out over the cliff
edge; a few gold stars drift back in from the haze.
*Motion:* envelopes out, stars in.

**7 · The four together — 4s — Kling, 7.5cr**
Wide, low, golden. All four sets on the same ledge, every screen lit, foliage moving in
the light. The whole fleet working.
*Motion:* slow lateral drift along the ledge.

### Act 2 — Supervision (dusk, high, cool)

**8 · Judge — 4s — Seedance, 14cr** · ref `judge.jpg`
Camera tilts up from the four sets to an upper ledge. The Judge monolith stands alone
against a cooling sky, its single lens catching the last light, angled down at the fleet
below.
*Motion:* slow tilt up, ending on the lens.

**9 · The promise — 4s — Seedance, 14cr** · ref `judge.jpg`
Hold on the Judge. Its lens goes dark. In the soft-focus ledge below, every screen dims
in the same instant. Nothing moves.
*Motion:* the lens closes; the lights below fall.

> This is the beat the whole film is for. It is §1.2 of the design reference — *if the
> supervisor is down, the system doesn't post* — made literal. Give it the longest hold
> in the edit and put the overlay line under it. If any beat earns a re-roll, it is this
> one.

**10 · Governor — 4s — Seedance, 14cr** · ref `governor.jpg`
Tight on the Governor's recessed window. The mint toggle lever throws from up to down. A
soft ring of light sweeps outward down the stone and the ledge goes quiet.
*Motion:* the lever throws.

**11 · The dial — 4s — Seedance, 14cr**
A weathered brass dial set into the ledge stone between the workers below and the watchers
above, its needle travelling from a stamped left mark to a right one and settling near the
middle. Physical object, warm metal, shallow focus.
*Motion:* the needle sweeps and settles.

> Generate this as a **real object in the world**, never as a diagram or UI. Objects are
> reliable; abstract graphics are re-roll bait. Copilot / Autopilot / trust dial / veto
> window are all overlay text (§4).

### Act 3 — Tomorrow (dawn breaking, very wide, craning back)

**12 · Room to grow — 4s — Kling, 7.5cr**
First light returns low across the cliff. The camera cranes back and up. Further ledges
come into view beyond the lit four, each holding an **empty stone plinth**. The city
wakes below.
*Motion:* continuous crane back.

**13 · The fleet grows + sign-off — 4s — Seedance, 14cr**
Three new sets fade in on the empty plinths, clearly dimmer and less resolved than the
four established ones — still in shadow while the established four catch the new sun. The
full constellation holds: four lit workers, two watchers above, three faint arrivals, city
beyond.
*Motion:* slow continued drift back; the new forms resolve faintly.

> The new arrivals **must** read as dimmer and less finished than the shipped four. That
> is §3.2 of the design reference — never place a future agent in the same treatment as a
> shipped one — carried visually rather than only in the overlay label. Get this wrong and
> the video becomes a false-advertising problem.

Logo resolve is composited over the tail of beat 13, not generated.

---

## 3b. The script

**This section was missing from the first version of this document, and its absence was
the single biggest defect in the shoot.** §4 listed overlay *fragments* and deferred the
rest to "the edit", so the first assembly was 13 handsome shots with no argument attached
— a card sliding out of a television means nothing to a viewer who has not read §3. The
visual language does not carry the product story on its own. It never could. **The script
is the film; the footage illustrates it.**

Timings are the assembled cut: beat 1 runs 6.0s, beats 2–13 run 4.04s each.

| Beat | Kicker (gold, top) | Line (subtitle, bottom) |
|---|---|---|
| 1 | — | Every business has a reputation. / Almost nobody has time to manage it. |
| 2 | — | A review arrives. Nobody is watching. |
| 3 | `REPLY` | Drafts a response to every review, in your voice. |
| 4 | `GUARDIAN` | Catches the risky ones. Routes them to a human. |
| 5 | `INSIGHTS` | Tells you what actually happened this week. |
| 6 | `SOLICITOR` | Asks real customers for new reviews. |
| 7 | `THE FLEET` | Four agents. One job each. Always on. |
| 8 | `JUDGE` | Reviews 100% of everything posted automatically. |
| 9 | — | **If the Judge is unavailable, nothing posts.** *(large, centred)* |
| 10 | `GOVERNOR` | Can suspend autonomy on its own. |
| 11 | `COPILOT · AUTOPILOT` | You set the dial. Approve everything, or set limits. |
| 12 | `WHAT'S NEXT — NOT YET SHIPPED` | CRM. Social. Fake-review disputes. |
| 13 | — | **The AI reputation department you could never afford to hire.** *(large, centred)* |

Beats 9 and 13 drop the kicker and go large and centred — they are the trust claim and the
close, and they should stop the scroll rather than sit in a lower third.

Budget roughly **2.5 words per second**. Every line above fits its beat with air; anything
longer forces the viewer to choose between reading and watching.

**Two constraints this table is carrying.** Beat 12's kicker says *NOT YET SHIPPED* in the
same breath as it names CRM, Social and Fake-review dispute — that is §3.2 of the design
reference, and the words are load-bearing, not decoration. And every agent name is
capitalised as a proper noun per §3.1, which is what makes them read as named characters
rather than verbs.

### Rendering the titles

This machine's ffmpeg has **no `drawtext` and no `subtitles` filter**. Titles are
rasterised to transparent PNGs with PIL (`titles.py`) and composited with `overlay`.
Check `ffmpeg -filters` before assuming a text filter exists.

## 4. Overlay list — composited in edit, never generated

| Beat | Overlay |
|---|---|
| 1 | RepWorth wordmark |
| 3–6 | `Reply` · `Guardian` · `Insights` · `Solicitor` — one name per beat, lower third |
| 7 | *Four agents. One job each.* |
| 8 | `Judge` |
| 9 | **An independent AI review of 100% of auto-posts.** / *If the Judge is unavailable, posting stops.* |
| 10 | `Governor` — *autonomy can be suspended, automatically* |
| 11 | `Copilot` ← → `Autopilot` at the needle's two marks; *trust dial · veto window* |
| 12–13 | `What's next` — and each new set labelled `Coming`: CRM · Social · Fake-review dispute |
| 13 | RepWorth logo · *The AI reputation department you could never afford to hire.* |

Vocabulary is fixed by §3.1 of the design reference. Agent names always capitalised.
Never write a future capability without its `Coming` label.

---

## 4b. Selected plates — still pass complete

36 stills generated, 12 selected, **zero re-rolls**. 72 credits. Files in the session
scratchpad under `stills/<index>.png`; index is `beat*10 + variant`.

| Beat | Plate | Why |
|---|---|---|
| 2 · The problem | `21` | Card and gold star with the empty ledge behind — subject and absence in one frame |
| 3 · Reply | `33` | The outgoing card is large and unmistakable; the action is the point |
| 4 · Guardian | `43` | Brightest shield, clearest dark card being turned away |
| 5 · Insights | `52` | Tight on the amber screen — the one macro in the film, and a needed scale change |
| 6 · Solicitor | `62` | The envelope arc over the valley with stars returning; best single image in the set |
| 7 · Four together | `73` | All four glyphs legible at once |
| 8 · Judge | `81` | Low angle, imposing, introduces the lens |
| 9 · The promise | `83` | **Generated as a Judge variant, reassigned.** Two-level and *lit* — the clip animates the lights below going out |
| 10 · Governor | `103` | Lever plus the ring of light already in-frame |
| 11 · The dial | `111` | Blank brass face, needle mid-travel, no markings |
| 12 · Room to grow | `123` | Most empty plinths, strongest dawn |
| 13 · Fleet grows | `132` | Four lit, two watchers above, future plinths still dark in the foreground |

**Two things the generation got righter than the brief.** Plate `83` arrived as the
two-level composition with the lower ledge still lit, which turns beat 9 from two moves
into one. And in the beat-13 plates the future agents rendered as **bare plinths in
shadow** rather than dim televisions — a stronger read of "not yet built" than the spec
asked for, and a cleaner satisfaction of §3.2 of the design reference. Keep both.

## 5. Budget

Estimated, then **actual** — the shoot is complete through the clip pass.

| Line | Qty | Rate | Est. | **Actual** |
|---|---|---|---|---|
| Beat 1 (reuse) | 1 | — | 0 | **0** |
| Stills, `nano_banana_pro` 16:9 1k | 36 | 2 | 72 | **72** |
| Seedance clips, 4s fast 720p silent | 9 | 14 | 126 | **126** |
| Kling 3.0 Turbo clips, 4s 720p | 3 | 7.5 → **6** | 23 | **18** |
| Re-rolls | 0 | — | 66 | **0** |
| **Total through assembly** | | | ~287 | **216** |
| `upscale_video` on final keepers | — | ~6 | 24 | *not yet run* |

Against an opening balance of 2502. A clip-first workflow at a typical re-roll rate lands
the same film near 900.

**Two rate corrections for the next shoot.** Kling 3.0 Turbo at **4s / 720p / 16:9 is 6
credits**, not the 7.5 recorded in earlier notes — that figure came from a 5s 1:1
preflight and does not transfer. Seedance 2.0 at 4s fast/720p/silent is 14, as expected.

**Watch the balance delta, not just the invoice.** The balance moved 253.5 across this
session but only **216** of it was this shoot; the remaining 37.5 was five Kling v3.0
charges from the preceding avatar work that settled *after* the opening balance read.
Reconcile against `transactions`, never against a balance subtraction.

**Hard stop:** if a shoot passes **450 credits**, stop generating and re-cut from what
exists. Overruns past that point are always a prompt problem, never a model problem, and
generating through them is how the balance disappears.

---

## 6. Order of operations

1. ~~Recut beat 1 from the existing hero footage. Confirm the grade the rest must match.~~
   **Done.** 6.04s, 1600×900, 2× retime, ungraded. Arc corrected to day → dusk → dawn
   (§1.3). Zero credits spent.
2. ~~Upload the six `public/agents/*.jpg` as reference media once; reuse those IDs all shoot.~~
   **Done.** Seven refs uploaded and confirmed (six agents + a beat-1 world frame); IDs in §4b
   source notes and `still-jobs.json`.
3. ~~Generate stills for beats 2–13 — 3 variants each.~~ **Done.** 36 submitted across three
   batches (the batch cap is 12, not 36), 36 completed, 0 failed. 72 credits.
4. ~~Review all 36 stills together and pick 12.~~ **Done** — see §4b. Judged as a sequence,
   not individually. No re-rolls required.
5. ~~Upload the 12 winners. Generate the 12 clips in one pass.~~ **Done.** 144 credits,
   0 re-rolls. **No upload was needed** — `generate_video_batch` accepts a prior
   generation's `job_id` directly as a `start_image` media value, so the 12 plates were
   referenced by job ID. Skip the upload step entirely next time.
6. ~~Assemble.~~ **Done** — `RepWorth-launch-roughcut.mp4`, 54.5s, 1280×720, 24fps, hard
   cuts, silent. Decide re-rolls from the cut, never from clips in isolation.
7. Upscale only the keepers that survive the cut. **Not yet run.**

### Three API behaviours that cost time (not credits)

- **Seedance defaults `generate_audio: true`.** Left alone it adds a soundtrack to a film
  that is scored in the edit, and raises the rate. Always pass `false`.
- **The API may intercept a submission with a preset recommendation** instead of running
  it — 5 of the 12 clips came back `submission_failed` with a suggested preset
  ("IN THE DARK"). Nothing runs and nothing is charged. Resubmit with
  `declined_preset_id` set to the offered id. A preset would override the locked style
  key, so declining is the default, not a judgement call.
- **Seedance has a concurrency cap.** With 8 jobs in flight the 9th returns
  `429 rate_limit_reached`. It is transient and uncharged — wait for a slot rather than
  hammering it, and per the standing rule, confirm the job never ran before resubmitting.
