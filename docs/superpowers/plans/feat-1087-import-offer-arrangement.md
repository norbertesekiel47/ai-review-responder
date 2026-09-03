# feat/1087 — the Import offer banner's arrangement

Decision ticket [#1087](https://github.com/RepWorth/ai-review-responder/issues/1087) ·
build ticket [#1096](https://github.com/RepWorth/ai-review-responder/issues/1096) ·
map [#1084](https://github.com/RepWorth/ai-review-responder/issues/1084).

Owner's words, item 6 of the original list: *"Import card elements not arranged
properly, fix it."* Clarified 2026-09-03 to mean **`ImportOfferBanner`**, not the
contacts CSV `UploadCard`.

## The defect, named

This was left as "needs a prototype" because nobody had looked. Reading the code
makes it specific enough to build from:

- `.banner` is `display: flex; align-items: center` (`console.css:1242`).
- `.banner-cta` positions an action with `margin-left: auto` (`:1287`).
- `OfferPrompt`'s buttons are a **raw `div` with inline `display:flex`** — so it
  never receives `margin-left: auto`, and `align-items: center` centres a
  two-button group vertically against a **four-line** copy block.

So the actions float mid-height and drift left, while every other banner's
action is pushed right. The second button is styled with inline `background` and
`color` overrides rather than a class.

**This is a hypothesis until it is seen rendered.** Confirm with screenshots at
390px and 1440px before changing anything — the founder rule is "visibly
different at a glance", proven with before/after at both widths.

## Two constraints no visual test will catch

1. **The copy is LOCKED VERBATIM.** The 7-day disclosure and the
   "new reviews will still be handled automatically either way" reassurance
   both. The file says so twice. A fix that shortens the copy to fit the layout
   is the wrong fix.
2. **`BannerShell` must stay at the parent's return position in every state.**
   Its own doc (round-1 A6c) explains why: a screen reader does not announce a
   message that appears in the same commit as its live region, so the region
   must already exist during the import and be the same node when the message
   lands. Wrapping or moving it breaks the terminal announcement **silently**.

## Assumptions recorded, not asked

Per the intake contract's question policy, these are reversible and stated
rather than blocking. Override any of them on resume.

1. The button group becomes a real element in the action slot (a
   `.banner-actions` class beside `.banner-cta`), inheriting `margin-left: auto`.
2. `.banner` gains `align-items: flex-start` **only** where the copy block is
   multi-line, so single-line banners are untouched.
3. "No thanks" gets a secondary class rather than inline overrides.
4. Scope is the `offer` state; the other seven are asserted unchanged.

## Suggested tracers

| # | Slice |
|---|---|
| T1 | Before/after screenshots at 390px and 1440px — confirm or kill the hypothesis |
| T2 | Eval tests: copy verbatim, BannerShell position, actions slot, readOnly |
| T3 | The arrangement change |
| T4 | Docs + merge ledger |
