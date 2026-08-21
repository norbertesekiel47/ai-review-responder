# The bar — Ada (ada.cx), light "daylight gallery" capture

Source: Refero style f23e132d (light capture, 2026-04) — `bar/ada_hero.jpg`, `bar/contact.jpg`,
`bar/frame_01..22.jpg` (1 fps from the 22 s scroll video), `ada_style.json` (design tokens).
Live ada.cx has since gone dark; the light capture is the bar.

## Mechanisms a critic can check by looking

1. **One family, one weight.** Every glyph is the same humanist sans at weight 400. The hero
   headline is ~4.5× body size (72 vs 16); a viewport never shows more than three type sizes
   (display, body, caption). Letter-spacing is normal everywhere.
2. **Two surfaces and a hairline, no shadows.** Warm off-white canvas, pure-white cards, 1px
   borders at ≤ 15% ink. No drop shadow anywhere. Cards 8px radius; buttons full pill;
   inputs 4px.
3. **Accent as punctuation.** At most one accent element per viewport: a 4–6px colour bar on
   the edge of a card, or one filled pill. Accent colours never appear as text, never as a
   broad fill, never more than one hue at a time except the stat-card row (one bar per card,
   four hues, left→right).
4. **Hero = wash + split + one card.** A heavily blurred photographic wash fills the hero; the
   headline sits left (≈60%), a single white product card floats right (≈40%) with one dark
   pill + circular arrow; ~40% of the frame is empty.
5. **Motion resolves once, slowly.** Section intros fade-up once. The stat cards reveal
   left→right with a ~300 ms stagger and the numerals count up. Nothing animates under
   ~400 ms; no bounce, no loop, no hover scale > 1.02.
6. **Sticky stacking cases.** Full-width cards with a 6px colour top bar are sticky-stacked:
   each new card slides over the previous one, which stays pinned; the top bars of the cards
   underneath remain visible as stripes at the top of the stack.
7. **Air between bands.** ≥ 80px between content bands; section headings centred, ≤ 2 lines,
   ≤ ~720px wide; no eyebrows, no decorative dividers; rhythm comes from whitespace.
