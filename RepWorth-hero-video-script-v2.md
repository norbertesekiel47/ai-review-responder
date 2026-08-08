# RepWorth Hero Video — As-Built Scenes + Transcript (v5, editable)

*This is exactly what's in the current cut (2:26), enhanced against a fact-checked
research pass on explainer-video craft (scripting, motion, captions, editing, audio,
retention). Edit anything — narration lines, scene notes, transition styles, subtitle
text — and hand the file back for regeneration. Cost model unchanged: narration edits
~1 credit/block (re-voice); scene/visual edits 30 credits/block (new clip); transition,
pacing, subtitle, and audio-mix changes are **free** (local re-assembly).*

**Research basis:** every craft number below traces to the fact-checked findings in
`scratchpad/research-report.md` (Wistia 13M-video retention data, WCAG 2.1 + Netflix
Timed-Text caption specs, Material/NN/g/Disney motion principles, StudioBinder/Lance
Blair VO pacing). Confidence tiers noted where they matter.

---

## What changed in this pass (v5)

**All three known issues are now resolved with concrete, mostly-free specs:**

1. **Abrupt narration endings → FIXED (free).** Root cause confirmed: the crossfade
   started on the voice, clipping its tail. Fix is the professional **L-cut / split
   edit** — the *voice* never crossfades; only the background ambience does, and it
   ducks *under* the voice, never over the final word. Each line now gets a protected
   **0.4–0.6s "breath"** of clean room tone after its full stop *before* the transition
   begins. See per-block **"Transition out"** specs and **§A** for the exact audio rule.
2. **Rushed transitions → FIXED (free).** Old 0.35–0.4s uniform whip-cuts are replaced
   with **eased** transitions whose duration is tuned to the emotional weight of the beat
   (0.5s for list/energetic beats, 0.6–0.8s for emotional beats). Easing curves and
   direction are specified per cut in **§A** and per block below. Rationale: research
   shows abrupt *linear* motion reads "robotic" — the cure isn't just "slower," it's
   *eased* and *beat-matched*.
3. **Subtitles → ON for all blocks, spec'd (free).** Recommendation is **ON everywhere**:
   WCAG SC 1.2.2 makes captions a Level-A requirement for prerecorded video, and a hero
   video that autoplays **muted** on the landing page is unreadable without them. Full
   timecoded, spec-compliant **caption cue sheet in §B** (verbatim narration, broken to
   Netflix limits). If you still want them off, strike §B — but I'd keep them on.
   **Subtitles: [x] ON for all blocks   [ ] OFF   [ ] ON only for blocks: ____**

**Plus two optional bigger moves (your call, in §E):** the 2:26 runtime is long vs.
the retention data, and there's no early call-to-action. Both cost credits and change
intent, so they're presented as options, not applied.

---

## §A — Global motion, transition & audio spec *(the reference the engine assembles to)*

These are the free, cross-cutting rules. Per-block notes below only call out deviations.

### Transitions (free — local re-assembly)
- **Never linear.** Default easing = the standard curve `cubic-bezier(0.4, 0.0, 0.2, 1)`
  for pushes/slides. Entrances/reveals **ease-out** `cubic-bezier(0.0,0,0.2,1)`
  (arrive fast, settle soft); exits/fades **ease-in** `cubic-bezier(0.4,0,1,1)`.
- **Duration by emotional weight** (Murch's rhythm principle — feel over uniformity):
  - Emotional / breath beats (1→2, 2→3, 11→12, 12→13): **0.6–0.8s**
  - Narrative / structural beats (3→4, 5→6, 7→8, 8→9): **0.6s**
  - List / energetic beats (inside 4, 9, 10, 11): **0.5s**
- **Direction discipline:** keep a consistent push axis through a section to avoid the
  old "whippy" feel; reserve axis changes for section boundaries (they read as chapter
  breaks). Push-**in** = "go deeper into a feature"; pull-**back** = "rise up / zoom out
  to the bigger picture" (NN/g zoom semantics — your finale pull-back is already correct).
- **Beat-match:** if a music bed is present, snap each cut to the nearest downbeat that
  falls inside the block's breath window (don't hard-cut on every beat — cut on phrase
  boundaries).

### The "breath" / L-cut rule (fixes abrupt endings — free)
- Voice plays to its **full stop**, then hold **0.4–0.6s of clean room tone** before the
  picture transition starts.
- The **voice track is never crossfaded.** Only the ambience/music bed crossfades.
- Let the *incoming* scene's ambience pre-enter ~0.3s **under** the outgoing voice tail
  (a J-cut) so the seam feels continuous, not stacked.

### Audio mix (free)
- **VO sits 10–15 dB above the music bed** (StudioBinder).
- **Ducking:** sidechain the bed to the VO — ratio ~4:1, attack 10–20 ms, release
  200–400 ms (long enough that the bed doesn't "pump" on breaths).
- **Master to −14 LUFS integrated, true-peak ≤ −1 dBTP** (YouTube / landing-page /
  social all normalize near −14, so one master serves every surface).

### Motion inside each clip (applies only if a clip is regenerated — 30 credits)
- **One primary animation at a time** (NN/g: simultaneous motion competes and dilutes
  attention). Stagger secondary elements as **follow-through** — e.g., a badge *lands*
  (primary), *then* its label fades in.
- **Ease every element** in/out (Disney slow-in/slow-out); un-eased motion looks robotic.
- **Animate along slight arcs**, not straight lines, for organic feel.
- Reserve **overshoot / back-ease** (`easeOutBack`) for one playful accent per scene
  (e.g., the gold star pop) — restrained, not everywhere.

---

## §B — Subtitle / caption cue sheet *(free — turn-key, verbatim narration)*

**Style for the paper-collage brand:** brand font; captions ride in an on-brand
**semi-opaque paper-strip backing** (not a black box) for legibility over busy collage;
**center-justified, lower-third safe area** (≥10% bottom margin). **Exceptions** — ride
captions in the **upper third** on **Blocks 9, 11, 12**, where key action lives along the
bottom of frame (platform tiles / aproned staff / storefronts). Break rules follow
Netflix: ≤2 lines, ≤42 char/line, single line when it fits, break *before* conjunctions
& prepositions, bottom-heavy pyramid. Timings below are phrase anchors — **final in/out
snaps to the VO waveform at assembly.** Cues flagged **⚠hot** exceed 20 cps because the
underlying line is dense (see §D pacing notes).

```srt
1
00:00:00,400 --> 00:00:03,400
Right now, somewhere, a customer is
sharing their experience of your business,   ⚠hot

2
00:00:03,400 --> 00:00:07,000
and the care you put into your reply
is what the next customer feels

3
00:00:07,000 --> 00:00:10,400
before they ever walk in.

4
00:00:12,200 --> 00:00:15,800
Keeping up with every review takes time
most owners simply don't have,

5
00:00:15,800 --> 00:00:20,000
and each reply is a chance to show
a customer they were truly heard.

6
00:00:21,000 --> 00:00:24,500
RepWorth isn't just another chatbot.

7
00:00:24,500 --> 00:00:29,000
It's a caring team of AI agents,
each with one job,

8
00:00:29,000 --> 00:00:34,000
looking after your reputation
around the clock.

9
00:00:34,000 --> 00:00:37,600
Reply crafts a warm answer
for every review.

10
00:00:37,600 --> 00:00:41,000
Guardian flags the ones that deserve
your personal touch.

11
00:00:41,000 --> 00:00:43,800
Insights writes your weekly digest.

12
00:00:43,800 --> 00:00:47,000
And Solicitor invites happy customers
to share their story.

13
00:00:47,000 --> 00:00:50,200
And watching over it all
are two guardians.

14
00:00:50,200 --> 00:00:54,000
A Judge that reviews one hundred percent
of automatic posts,

15
00:00:54,000 --> 00:00:57,000
and a Governor that can pause the system
the instant you want.

16
00:00:58,000 --> 00:01:00,600
You're always in control.

17
00:01:00,600 --> 00:01:04,500
Copilot lets you approve
every reply yourself,

18
00:01:04,500 --> 00:01:08,200
and Autopilot sends the safe,
friendly ones for you,

19
00:01:08,200 --> 00:01:11,000
inside limits you set.

20
00:01:11,000 --> 00:01:14,600
Nothing goes public
without your say-so,

21
00:01:14,600 --> 00:01:18,000
anything sensitive is set
gently aside for you,

22
00:01:18,000 --> 00:01:22,000
and every step is recorded, so you can
always see what happened, and why.

23
00:01:22,000 --> 00:01:26,000
Today, RepWorth already runs
the whole loop for you,

24
00:01:26,000 --> 00:01:29,600
from inviting brand-new reviews
to publishing warm replies.

25
00:01:29,600 --> 00:01:32,000
And this is only the beginning.

26
00:01:32,000 --> 00:01:35,600
Soon the team grows, with agents
to nurture your customer relationships,

27
00:01:35,600 --> 00:01:39,000
care for your social media,

28
00:01:39,000 --> 00:01:43,000
and stand guard against fake reviews
across every platform.

29
00:01:43,000 --> 00:01:47,000
New insight arrives too, showing
how you shine in your neighborhood,

30
00:01:47,000 --> 00:01:50,500
turning reviews
into simple improvements,

31
00:01:50,500 --> 00:01:55,000
and protecting you the moment
an unfair wave of reviews appears.

32
00:01:55,000 --> 00:01:58,500
Others keep your profile
fresh and easy to find,

33
00:01:58,500 --> 00:02:01,000
ask for reviews
at just the right moment,

34
00:02:01,000 --> 00:02:03,500
celebrate the staff
your customers love,

35
00:02:03,500 --> 00:02:06,000
and build a reputation score
you'll be proud to share.

36
00:02:06,000 --> 00:02:10,000
One day, agencies will care
for entire rosters this way,

37
00:02:10,000 --> 00:02:14,000
because RepWorth is
the always-supervised reputation team

38
00:02:14,000 --> 00:02:18,000
every business deserves.
```

**Block 13 (2:18–2:26, silent):** no speech → no dialogue captions. If the outro carries
music, add one HoH cue `♪ [warm outro music] ♪`. If you re-add the tagline (see §E), it
gets its own on-screen caption event.

---

## Full narration transcript (timecoded, as spoken in the v4 cut)

*Unchanged from v4 (kept for reference). The only narration change **proposed** this pass
is an optional Block 11 tighten — see §D and §E.*

| Time | Block | Narration |
|---|---|---|
| 0:00–0:12 | 1 | Right now, somewhere, a customer is sharing their experience of your business, and the care you put into your reply is what the next customer feels before they ever walk in. |
| 0:12–0:20 | 2 | Keeping up with every review takes time most owners simply don't have, and each reply is a chance to show a customer they were truly heard. |
| 0:21–0:34 | 3 | RepWorth isn't just another chatbot. It's a caring team of AI agents, each with one job, looking after your reputation around the clock. |
| 0:34–0:47 | 4 | Reply crafts a warm answer for every review. Guardian flags the ones that deserve your personal touch. Insights writes your weekly digest. And Solicitor invites happy customers to share their story. |
| 0:47–0:57 | 5 | And watching over it all are two guardians. A Judge that reviews one hundred percent of automatic posts, and a Governor that can pause the system the instant you want. |
| 0:58–1:11 | 6 | You're always in control. Copilot lets you approve every reply yourself, and Autopilot sends the safe, friendly ones for you, inside limits you set. |
| 1:11–1:22 | 7 | Nothing goes public without your say-so, anything sensitive is set gently aside for you, and every step is recorded, so you can always see what happened, and why. |
| 1:22–1:32 | 8 | Today, RepWorth already runs the whole loop for you, from inviting brand-new reviews to publishing warm replies. And this is only the beginning. |
| 1:32–1:43 | 9 | Soon the team grows, with agents to nurture your customer relationships, care for your social media, and stand guard against fake reviews across every platform. |
| 1:43–1:55 | 10 | New insight arrives too, showing how you shine in your neighborhood, turning reviews into simple improvements, and protecting you the moment an unfair wave of reviews appears. |
| 1:55–2:06 | 11 | Others keep your profile fresh and easy to find, ask for reviews at just the right moment, celebrate the staff your customers love, and build a reputation score you'll be proud to share. |
| 2:06–2:18 | 12 | One day, agencies will care for entire rosters this way, because RepWorth is the always-supervised reputation team every business deserves. |
| 2:18–2:26 | 13 | *(no narration — silent logo sign-off)* |

### Continuous transcript (prose)

> Right now, somewhere, a customer is sharing their experience of your business, and the care you put into your reply is what the next customer feels before they ever walk in. Keeping up with every review takes time most owners simply don't have, and each reply is a chance to show a customer they were truly heard.
>
> RepWorth isn't just another chatbot. It's a caring team of AI agents, each with one job, looking after your reputation around the clock. Reply crafts a warm answer for every review. Guardian flags the ones that deserve your personal touch. Insights writes your weekly digest. And Solicitor invites happy customers to share their story. And watching over it all are two guardians. A Judge that reviews one hundred percent of automatic posts, and a Governor that can pause the system the instant you want.
>
> You're always in control. Copilot lets you approve every reply yourself, and Autopilot sends the safe, friendly ones for you, inside limits you set. Nothing goes public without your say-so, anything sensitive is set gently aside for you, and every step is recorded, so you can always see what happened, and why.
>
> Today, RepWorth already runs the whole loop for you, from inviting brand-new reviews to publishing warm replies. And this is only the beginning. Soon the team grows, with agents to nurture your customer relationships, care for your social media, and stand guard against fake reviews across every platform. New insight arrives too, showing how you shine in your neighborhood, turning reviews into simple improvements, and protecting you the moment an unfair wave of reviews appears. Others keep your profile fresh and easy to find, ask for reviews at just the right moment, celebrate the staff your customers love, and build a reputation score you'll be proud to share.
>
> One day, agencies will care for entire rosters this way, because RepWorth is the always-supervised reputation team every business deserves.

---

## §D — Per-block breakdown *(narration · scene · enhanced transition)*

*Pacing note per block = words ÷ spoken seconds. Target 140–150 wpm conversational,
~130 when heavy motion needs room. Only Block 11 is a real overload.*

## Block 1 — Cold open *(warm yellow · 11.9s · ~156 wpm, fine)*
- **Narration (editable, keep):** "Right now, somewhere, a customer is sharing their experience of your business, and the care you put into your reply is what the next customer feels before they ever walk in."
- **Scene (as built):** Blank review card tilts in; archival hand-with-pen writes soft marker strokes; a gold paper star pops out and glows above the card; a second dimmed card slides in, gently waiting; slow push-in.
- **Transition out (v5):** smooth push left, **0.7s, ease-in-out** (emotional beat). **Breath:** voice finishes "walk in." → hold **0.6s** room tone → begin push. Ambience-only crossfade; the incoming shop-counter ambience pre-enters ~0.3s under the tail (J-cut).
- **Caption placement:** lower third.

## Block 2 — The challenge, with empathy *(off-white · 10.0s · ~144 wpm, fine)*
- **Narration (keep):** "Keeping up with every review takes time most owners simply don't have, and each reply is a chance to show a customer they were truly heard."
- **Scene:** Review cards gather softly on a warm shop counter, stars still glowing; friendly shopkeeper happily serving a customer at the till, pen tucked nearby; a marker heart floats above the waiting cards. Warm, no gloom.
- **Transition out (v5):** slide up, **0.6s, ease-in-out** (into the product reveal). **Breath 0.5s** after "truly heard." Ambience-only crossfade.
- **Caption placement:** lower third.

## Block 3 — What RepWorth is *(navy · 12.9s · ~112 wpm, roomy — good)*
- **Narration (keep):** "RepWorth isn't just another chatbot. It's a caring team of AI agents, each with one job, looking after your reputation around the clock."
- **Scene:** Gold star at center; four badges snap into orbit one by one — coral speech bubble (Reply), navy shield (Guardian), off-white bar chart (Insights), yellow megaphone (Solicitor); white marker circle draws around the formation.
- **Motion note (if regenerated):** badges arrive **one at a time**, each on the narration beat, ease-out on entry, label fades in *after* the badge lands (follow-through) — don't reveal all four at once.
- **Transition out (v5):** smooth push right, **0.6s, ease-in-out**. **Breath 0.5s** after "around the clock." (This one lands into the four-agent showcase — keep the push crisp.)
- **Caption placement:** lower third.

## Block 4 — The four agents at work *(warm yellow, four quadrants · 13.6s · ~137 wpm)*
- **Narration (keep):** "Reply crafts a warm answer for every review. Guardian flags the ones that deserve your personal touch. Insights writes your weekly digest. And Solicitor invites happy customers to share their story."
- **Scene:** Four torn-paper quadrants flip in clockwise, in narration order: speech-bubble badge stamps a reply card · shield badge gently catches a tricky card and raises a small friendly flag · chart badge with line drawing upward · megaphone badge sends envelopes out, tiny gold stars float back. Gold star at the center crossing point.
- **Sync note:** each quadrant flips **exactly on its sentence** (captions 9–12 are cut per-agent for this reason). Four proper nouns in 13.6s is the densest *conceptual* beat — the per-agent caption + per-agent reveal is what keeps it legible.
- **Transition out (v5):** smooth push up, **0.5s, ease-in-out** (energetic list beat — snappier is right here). **Breath 0.4s** after "their story."
- **Caption placement:** lower third.

## Block 5 — The watchdogs *(navy · 10.9s · ~154 wpm, fine)*
- **Narration (keep):** "And watching over it all are two guardians. A Judge that reviews one hundred percent of automatic posts, and a Governor that can pause the system the instant you want."
- **Scene:** Star + badges warmly lit below; gavel (Judge) and vintage toggle switch (Governor) descend on tape strips; the gavel taps once and a soft golden ring ripples outward; the toggle hovers with a friendly marker arrow.
- **Transition out (v5):** smooth push left, **0.6s, ease-in-out**. **Breath 0.5s** after "you want." Gavel-tap SFX should land *before* the breath, not on the cut.
- **Caption placement:** lower third.

## Block 6 — Copilot vs Autopilot *(coral · 13.6s · ~110 wpm, roomy — good)*
- **Narration (keep):** "You're always in control. Copilot lets you approve every reply yourself, and Autopilot sends the safe, friendly ones for you, inside limits you set."
- **Scene:** Big hand-drawn dial with the gold star at its pivot; left — archival hand presses an approval stamp (Copilot); right — reply cards fly out on their own but stay inside a dashed boundary (Autopilot); needle sweeps left, right, settles center.
- **Transition out (v5):** slide up, **0.6s, ease-in-out**. **Breath 0.5s** after "you set."
- **Caption placement:** lower third.

## Block 7 — Safety & audit trail *(off-white · 12.0s · ~140 wpm)*
- **Narration (keep; optional tighten in §E):** "Nothing goes public without your say-so, anything sensitive is set gently aside for you, and every step is recorded, so you can always see what happened, and why."
- **Scene:** Gold star inside a torn-paper vault. First a tricky dark card is gently covered by a soft navy bar and set behind a holding line with tape (held safely, never sent); then paper strips file into a tidy ledger — the run spine — each with a marker tick.
- **Transition out (v5):** slide up, **0.6s, ease-in-out** (into "the turn"). **Breath 0.5s** after "and why." — this is a section boundary; the slightly longer hold sells the pivot.
- **Caption placement:** lower third.

## Block 8 — The turn *(warm yellow · 10.4s · ~139 wpm)*
- **Narration (keep):** "Today, RepWorth already runs the whole loop for you, from inviting brand-new reviews to publishing warm replies. And this is only the beginning."
- **Scene:** Star + four badges in tight inner orbit; concentric dashed rings draw outward past the frame, dotted with open slots waiting to be filled; steady pull-back reveals the room to grow.
- **Motion note:** the **pull-back** correctly reads as "zoom out to the bigger picture" (NN/g) — this is the visual hinge from *today* to *the roadmap*. Keep it slow and continuous.
- **Transition out (v5):** smooth push left, **0.6s, ease-in-out**. **Breath 0.6s** after "the beginning." (Let "only the beginning" hang before the fleet expands.)
- **Caption placement:** lower third.

## Block 9 — The fleet grows *(navy · 11.3s · ~143 wpm)*
- **Narration (keep):** "Soon the team grows, with agents to nurture your customer relationships, care for your social media, and stand guard against fake reviews across every platform."
- **Scene:** Three new badges snap into the outer ring in narration order — rolodex/contact card (CRM), heart + comment bubbles (Social), magnifying glass over a fake card that tears in half (Fake-review dispute); then platform tiles deal out along the bottom, each linked to the star.
- **Transition out (v5):** slide up, **0.5s, ease-in-out** (energetic). **Breath 0.4s** after "every platform."
- **Caption placement:** **UPPER THIRD** — platform tiles deal along the bottom; keep captions clear of them.

## Block 10 — New intelligence *(coral · 12.2s · ~133 wpm)*
- **Narration (keep):** "New insight arrives too, showing how you shine in your neighborhood, turning reviews into simple improvements, and protecting you the moment an unfair wave of reviews appears."
- **Scene:** Three beats left to right: street map with your bright gold star among gray competitor stars, marker circle around yours · a review card transforms into a checklist as ticks stamp down · a chart dips as dark cards drift in, the navy shield settles calmly, the line eases back to steady.
- **Transition out (v5):** smooth push right, **0.5s, ease-in-out**. **Breath 0.4s** after "appears."
- **Caption placement:** lower third.

## Block 11 — Growth levers *(off-white · 11.7s · ~169 wpm — TOO FAST)*
- **Narration (RECOMMEND re-voice, ~1 credit):** the current line packs **four** vignettes into 11.7s at ~169 wpm — the one genuine pacing overload in the film. Tightened line keeps all four vignettes but drops to ~149 wpm in the same window:
  > **"Others keep your profile fresh and easy to find, ask for reviews at the right moment, celebrate the staff your customers love, and build a reputation score worth sharing."**
  *(If you'd rather not re-voice: leave the current take and this stays free — but it will read fast. Captions 32–35 already chunk it into four readable events either way.)*
- **Scene:** Four vignettes in narration order: storefront profile card gets a shine wipe + fresh photo taped on · paper clock ticks to the marked moment and launches one envelope · workers in aprons each receive a tiny gold star with a praise circle · everything converges into one large gold star that stamps down like a wax seal.
- **Transition out (v5):** circle-open reveal, **0.6s, ease-out** (the reveal wants ease-out; the wax-seal stamp is a natural downbeat to cut on). **Breath 0.4s** after "share." / "worth sharing."
- **Caption placement:** **UPPER THIRD** — aproned staff + wax-seal action own the lower frame.

## Block 12 — Finale / kicker *(navy warming to gold · 12.3s · ~102 wpm — roomy, good)*
- **Narration (keep):** "One day, agencies will care for entire rosters this way, because RepWorth is the always-supervised reputation team every business deserves."
- **Scene:** Camera cranes up from star close-up to the full constellation — badge fleet in two orbit rings, gavel + toggle above, storefronts along the bottom each with a tiny star; one continuous marker stroke draws a protective circle around everything; the star pulses warmly.
- **Transition out (v5):** soft fade, **0.8s, ease-in** (longest hold in the film — this is the emotional landing). **Breath 0.6s** after "deserves." Let the last word ring before the fade.
- **Caption placement:** **UPPER THIRD** — storefronts line the bottom; keep "every business deserves." clear of them. Caption 38 holds a beat longer as the closing line.

## Block 13 — Logo sign-off *(silent · 8.5s)*
- **Narration:** *(none — removed in v4. Write a line here if you want one back, ~1 credit.)*
- **Scene:** Constellation badges collapse inward, the star blooms, and the shot dissolves into the **original logo PNG (unmodified)** centered on a matched warm background; calm hold to the end.
- **On-screen tagline (editable, currently OFF):** *(was: "RepWorth. The reputation team every business deserves." — free to re-add as clean typography. If re-added, it gets a caption event and should fade in ~0.5s after the logo settles, not with it — follow-through.)*
- **Audio:** if music carries the outro, add the `♪ [warm outro music] ♪` HoH caption cue; keep the master at −14 LUFS through the fade-out.

---

## §E — Optional bigger moves *(not applied — your call; these cost credits / change intent)*

These come straight from the retention research and are the two places the current cut
diverges from what the data favors. I did **not** apply them because both are real
tradeoffs against the vision-film intent you built.

### 1. Runtime: 2:26 is long for a hero video *(tradeoff: reach vs. completeness)*
- **Finding:** Wistia's 13M-video data shows engagement is inversely correlated with
  length; short-form peaks ~52% and on good placements viewers watch only **~half** on
  average — with the steepest loss in the opening. Product-explainer sweet spot is
  **60–90s**, with a sharp decline after ~2 min.
- **What that means here:** the whole roadmap arc (Blocks 8–12, ~1:22 onward) is the
  "tail" most viewers won't reach on a landing page. It's beautiful, but it's the part
  the data says gets watched least.
- **Options:**
  - **(a) Keep 2:26 as the full brand/vision film** — correct if this lives on an About
    page, in a pitch, or as a sales-assist asset where a captive audience watches to end.
  - **(b) Cut a ~75–90s landing-page version** (free — removing blocks costs nothing;
    clips already exist): keep Blocks **1, 2, 3, 4, 6, 7, 8** + a shortened finale;
    move Blocks 9–11 (the future roadmap) to a "what's next" section or a separate video.
    This front-loads the product proof where retention is highest.
  - Recommendation: **do both** — full film where attention is captive, 90s cut on the
    landing page. Same assets, two exports.

### 2. There's no call-to-action, and none early *(tradeoff: brand tone vs. conversion)*
- **Finding (and a *refuted* myth):** the research specifically **killed** the common
  "put the CTA at the end" advice — Wistia's own data shows **mid-roll CTAs convert best
  (~17%)** vs. end-roll (~11%), because most viewers never reach the end. Surface the
  primary CTA **before the halfway point.**
- **What that means here:** as a pure brand film ending on the logo, there's no verbal
  ask. If this is a landing-page hero, the page's signup button *is* the CTA and that's
  fine. But if you want the video to drive action, consider a soft mid-video line or an
  on-screen "Start free" chip around the Copilot/Autopilot beat (Block 6, ~1:00 — right
  where the viewer understands the value and retention is still high). Optional; ~1 credit
  if voiced, free if it's just an on-screen chip.

### 3. Optional stronger hook *(first ~3 seconds carry the most weight)*
- **Finding:** the first ~2% of the runtime is where the most viewers decide to stay or
  leave; strong hooks use a pain point, a stat, or a pointed question.
- **Current open** ("Right now, somewhere, a customer is sharing their experience…") is a
  lovely *soft* hook — atmospheric but slow to the point. It's on-brand and I'd keep it
  for the full film. **If** you cut the 90s landing version, consider a punchier first
  line there, e.g. a pain-point open ("Every review you don't answer is a customer you
  might not get back.") — optional, ~1 credit, landing-cut only.

---

*Regeneration notes: leave a line untouched to keep its current voice take (free).
Any edited narration gets re-voiced (~1 credit/block). Scene description changes
regenerate that clip (30 credits). Transition, subtitle, pacing, and audio-mix edits
are free (local re-assembly). This pass's changes are all free except the optional
Block 11 re-voice and the optional §E moves.*
