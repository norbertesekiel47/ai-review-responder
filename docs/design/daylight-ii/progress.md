# Design loop — RepWorth How It Works, "Daylight Gallery II"

Goal: demo 4 = Daylight Gallery + Ink Band dossier arrangement for the six steps (sticky
stacking) and for the "pipeline, end to end" panel, plus a motion/graphics pass.
Bar: Ada light capture (`bar.md`). System: Island DESIGN.md + `system-amendments.md`.

## Round 1 (12 critics) — all pieces back to the builder

| # | Piece | Brief | System | Craft | Biggest gap named |
|---|---|---|---|---|---|
| 1 | Hero + stat cards | PASS | FAIL | FAIL | no air in hero; 3 filled pills; ink + forest fills; thin pale bars; hero/stats hairline; mock unlabelled as sample |
| 2 | Six steps, sticky stack | FAIL | FAIL | FAIL | text bleed-through (pre-fix capture); nested two-tone mock panels; 6+ sizes; soft "pyramid" stripes; small-label contrast |
| 3 | Pipeline panel + Reply slice | FAIL | FAIL | FAIL | invisible arrow circle; dense 6-col cells; eyebrow; ink fills; restating footers; heading under nav |
| 4 | Pricing + FAQ + CTA + footer | PASS | FAIL | FAIL | 5–6 type sizes in pricing; "$ 29" gap; second dark surface in CTA; small-text contrast ≤ AA |

## Round 2 — fixes applied (builder)
- tokens: ink-55 → .62, ink-70 → .74 (small text ≥ 4.5:1); bars 6px, accents a touch more saturated
- hero: no bottom hairline; min-height; headline 80px, .004em tracking; lede tightened; mock labelled "Sample", full reply (no typewriter), outline-only mock buttons; nav CTA forest
- steps: one white surface, artifact column split by a hairline; stripes crisp (no scale); sizes 13/15/30; stars ink; segmented control outline
- pipeline panel: 3×2, 24px titles, footers removed; decorative flow line removed; h2 scroll-margin
- reply slice: eyebrow dropped into the heading; tabs outline; cards align start; arrow circle ink
- pricing: "$29" one unit, 24/56/15/13 scale; Autopilot gets an honest "Tell me when Autopilot opens" outline pill
- CTA: form on a hairline frame (no second dark surface); placeholder/label contrast raised

## Gap history
- r1 → r2: see table above

## Round 2 (12 critics) — verdicts
| # | Brief | System | Craft | Gap named |
|---|---|---|---|---|
| 1 | (R1 pass) | FAIL | FAIL | stray hairline at hero/stats seam; hero density; 3 fills; thin bars |
| 2 | FAIL | FAIL | FAIL | 05 header peeking under 06 (offset bug); card-in-card mock; pale bars; 5+ sizes |
| 3 | PASS | FAIL | FAIL | ink arrow disc; jobless meta label; 3×2 gapless grid; 4-line left heading |
| 4 | (R1 pass) | PASS | FAIL | pricing pair unresolved; 6 sizes; footer rule width; optical-size strokes |

## Round 3 (12 critics) — verdicts
| # | Brief | System | Craft | Gap named |
|---|---|---|---|---|
| 1 | PASS | FAIL | FAIL | stat bar in forest; hero air / wash; nav translucency |
| 2 | FAIL | PASS | FAIL | 01 and 05 same hue; scalloped ribbon ends; nested mock frames; 2 fills in gate |
| 3 | PASS | PASS | — | (craft re-run in R5) |
| 4 | PASS | PASS | FAIL | pricing sizes; white-on-white cards; nav over dark band |

## Round 4 — verdicts
| # | Brief | System | Craft |
|---|---|---|---|
| 1 | (pass) | FAIL (1px seam line — traced to the wash clip edge, fixed by extending the wash below the hero) | FAIL |
| 2 | PASS | (R3 pass) | FAIL (ribbon corners; two near hues; nested frames; long 06 paragraph) |
| 4 | PASS | PASS | PASS (TIE) |

## Round 5 — builder changes
- hero: card column wider (1.35fr/1fr), single pill + text link, wash saturate 1.45 / contrast 1.06, nav opaque when scrolled, 8px stat bars, stat cards 236px tall
- steps: square cards (square-ended ribbon), 8px bars with 9px offset, 05 hue → #7fa99c, post mock flattened (no outer frame, no tint), paragraphs tightened (02/03/04/06)
- seam line root cause: Chrome draws a 1px artefact at the clip edge of a blurred element; the wash now overhangs the hero by 80px so the edge is clipped away

Elapsed: 5 rounds · 47 critic runs · 4 pieces

## Round 5 — verdicts
| # | Brief | System | Craft | Gap named |
|---|---|---|---|---|
| 1 | PASS (R3) | FAIL→fixed (seam line; wash now overhangs the hero) | FAIL | hero gutter; nav translucency; bar weight; card density |
| 2 | PASS (R4) | PASS (R3) | FAIL | 1px white seam in ribbon (card top border — removed); pastel hues (deepened); 06 column balance |
| 3 | PASS (R3) | PASS (R3) | FAIL | white cards on white band (band now bone); sample card tint (now paper); guarantee row density |
| 4 | PASS (R3) | PASS (R3) | PASS (TIE, R4) | — |

## Final builder pass after R5
- hero: gutter 104px, headline 64px, one pill + text link, card with one action, nav fully opaque, bars 10px, deeper bar hues
- steps: card top border removed → ribbon is flush and solid (sage/coral/blue/yellow/teal/ink), offset = bar = 8px
- pipeline band on bone; sample-review card on paper

## Status at stop (5 rounds, 50 critic runs)
- Brief critic: PASS on all four pieces.
- System critic: PASS on all four pieces (piece 1's last named gap — the seam line — traced and removed; verified by pixel sampling).
- Craft critic vs the Ada bar: PASS on piece 4; pieces 1–3 still judged "A better" on the same residual themes after five rounds:
  1. Density — Ada's case cards carry a headline and a portrait; ours carry the client's step copy (title, paragraph, three bullets) plus a real product artifact. The critics keep asking for Ada's emptiness; the brief asks for the content.
  2. Hero wash — Ada's is a blurred photograph; ours is a generated, blurred loop. Critics read it as less luminous.
  3. Type-size count inside product mocks — a mock needs label/value sizes; Ada's cards have none.
  These are brief-vs-bar trade-offs, not defects. Stopping here; the run can be resumed from `round5/` if you want another pass on pieces 1–3 with a changed brief (e.g. shorter step copy, photographic wash).
