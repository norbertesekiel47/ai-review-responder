## Building with RepWorth

RepWorth is a Next.js marketing surface. This bundle carries its **Island**
(white-card marketing chrome) and **Landing** (full-bleed narrative sections)
systems. The Console system that dashboards use is not in this bundle.

### Wrap everything in `PreviewProviders`

Every landing component animates through Motion's `m.*` under a strict
`LazyMotion`, and the video components read an ambient pause context. Rendered
outside both, they throw or come up blank. `PreviewProviders` supplies exactly
the pair `LandingExperience` uses in production:

```jsx
<PreviewProviders>
  <HeroSection primaryCtaHref="/signup" primaryCtaLabel="Start free" />
</PreviewProviders>
```

`AmbientMotionProvider` alone is enough for `AmbientVideo` and
`AmbientMotionToggle`, but never for a landing section. When in doubt, wrap in
`PreviewProviders`.

Two page shells exist and are not interchangeable. `SiteShell` owns the
marketing chrome — drifting-review marquee, white island, nav, footer — and
takes a required `scope` class (`"rw-landing"`, `"hiw-page"`). `PageShell` is
an unrelated Tailwind parallax island for legal and confirmation pages.

### The styling idiom: `--rw-*` tokens, exposed as Tailwind utilities

Colour and type live in `--rw-*` custom properties. Tailwind v4 `@theme inline`
re-exports each colour as a utility, so `bg-rw-sage` emits `var(--rw-sage)` —
the token stays the single source of truth. Write utilities for your own
layout; reach for `var(--rw-*)` only in inline styles.

| Family | Real names |
|---|---|
| Ground | `rw-cream` `rw-beige` `rw-sage` `rw-bone` `rw-paper` `rw-warm-gray` |
| Accent | `rw-teal` `rw-teal-strong` `rw-teal-darkest` `rw-peach` `rw-pink` `rw-brown` |
| Ink | `rw-ink` `rw-ink-soft` `rw-sage-text` |
| Status | `rw-error` `rw-success` `rw-red-600` |

Each takes the `bg-` / `text-` / `border-` / `from-` / `to-` prefixes.
Type uses four faces, always through their variables:
`var(--rw-font-display)` (Plus Jakarta Sans), `var(--rw-font-body)` (DM Sans),
`var(--rw-font-serif)` (Fraunces), `var(--rw-font-mono)` (JetBrains Mono).

Landing and how-it-works components also carry hand-written class names —
`rw-lp-*` for landing, `hiw-*` for how-it-works, `rw-marquee-*` and `rw-bg-*`
for the review marquee. Those are internal: style around the components, never
by reusing their class names.

**Never invent a colour.** No hex literals, no Tailwind palette defaults
(`bg-slate-100`, `text-gray-700`). If a shade seems missing, compose from the
tokens above.

### Where the truth is

Read these before styling anything:

- `styles.css` and its import closure — every token, utility and component rule
- `fonts/fonts.css` — the seven shipped faces
- `components/<group>/<Name>/<Name>.prompt.md` — that component's API and use
- `guidelines/design-docs/island-system.md` and `landing-system.md` — the two
  systems in full; `brand-story.md` for voice

### One idiomatic composition

```jsx
<PreviewProviders>
  <SiteShell scope="rw-landing">
    <section className="bg-rw-cream px-8 py-16">
      <p className="text-xs uppercase tracking-widest text-rw-ink-soft">
        Every review
      </p>
      <h2
        className="mt-2 text-4xl leading-tight text-rw-ink"
        style={{ fontFamily: 'var(--rw-font-display)' }}
      >
        Answered in your voice
      </h2>
      <p className="mt-4 max-w-xl text-rw-ink-soft">
        Drafted the moment a review lands. Posted only when you say so.
      </p>
    </section>
  </SiteShell>
</PreviewProviders>
```

### Media

Components that render video (`HeroSection`, `CtaSection`, `WatchdogsSection`,
`AgentFlipCard`, `AmbientVideo`) reference clips that are not in this bundle,
so their media area renders empty. Layout, type and colour are unaffected. Pass
your own `posterSrc` where the prop exists.
