# Handoff — implement "Daylight Gallery II" rebrand on the three marketing pages

Date: 2026-08-21 · Repo: `/Users/norbertesekiel/Developer/startups/RepWorth` (branch `main`, GitHub `RepWorth/ai-review-responder`, PR-only merges)

## What happened before this session

The founder wants the three public marketing pages — `/how-it-works`, `/features`, `/pricing` —
rebranded. The current pages "look like AI slop". The design reference was Ada
(https://styles.refero.design/style/f23e132d-3bfb-498d-a2e4-6d069b4dbc59, the LIGHT capture).
Four HTML demos were built and reviewed; the founder approved **demo 4 "Daylight Gallery II"**
and said: *"Yes I love the design. We're going to finalize this for the three marketing pages."*

**The approved demo is the spec.** Artifact: https://claude.ai/code/artifact/8552d2e3-8506-47bf-a90f-f19697e26c25
Local source (single HTML file, self-contained, all CSS/JS inline, media as data URIs):

- `/var/folders/x0/7xsr73k947jcdnk0qp827dr00000gn/T//repworth-daylight-ii/demo4-daylight-v2.src.html` (readable source, `__LOGO__`/`__WASH__`/`__WASHVID__` placeholders)
- same dir `demo4-daylight-v2.html` (built), `build4.py` (placeholder substitution)
- media: `media/wash_loop.mp4` (73KB palindrome loop), `media/wash_poster.jpg`, originals `media/wash_c.png`, `media/wash_d.png` (Higgsfield, paid, do NOT regenerate)
- design-loop record: `design-loop/system-amendments.md` (THE token spec), `design-loop/bar.md`, `design-loop/progress.md`, round screenshots in `design-loop/round1..5/`

All referenced files were copied to the durable dir `/var/folders/x0/7xsr73k947jcdnk0qp827dr00000gn/T//repworth-daylight-ii` (this file's own directory). Consider vendoring the spec + media into the repo (e.g. `docs/design/daylight-ii/`) as part of the PR.

## The approved design, in one paragraph

Bone island (`#f6f6f2`) on the untouched sage marquee field; DM Sans 400 ONLY (one family, one
weight, hierarchy by size); ink `#15191a` text + hairlines (`rgba(21,25,26,.12)`/`.22`); paper
`#fff` cards, NO drop shadows inside the island; forest `#2e5b4f` is the ONLY action colour
(button fills, arrow discs, live/verdict dots); accents exist ONLY as 8–10px bars and small dots:
sage-bar `#8fb99b`, coral `#eca396`, blue `#8fb1e6`, yellow `#dcb94a`, teal `#6f9d8f`, ink (Judge).
Stars are ink. Radii: cards 8px, pills 9999px, island 48px. Sticky white pill nav inside the island.
Dark ink CTA band + bone footer. Hero: blurred "wash" video loop (poster fallback,
reduced-motion-safe) fading to bone before the hero ends. The six How-it-works steps are
square-cornered dossier cards (8px colour top bar, header row `01 · Watch · T + 0:00`, text left /
product artifact right) that sticky-stack: offset per card = bar height (8px, `top: 116 + i*8`),
top border removed so pinned bars form a flush ribbon. Full token spec: `system-amendments.md`.

## Key decisions already made (do not relitigate)

1. New palette allowed; Island tokens get updated. Nav + footer rebrand everywhere (all Island
   pages inherit), landing `/` keeps its own system.
2. DM Sans 400 only on these surfaces. No Plus Jakarta / Fraunces here.
3. Marquee background (`MarqueeBackground.tsx` + `.rw-marquee-field`) unchanged.
4. Content preserved (lightly tightened copy is in the demo; it was critic-reviewed for
   truthfulness — "Sample" labels, "Typical figures shown for illustration…", honest Autopilot
   "Opening soon" state with outline "Tell me when Autopilot opens").
5. Hero: ONE filled CTA + "See pricing →" text link; nav CTA "Start free trial"; approval-email
   mock labelled "Sample" with a single mock action.
6. Design-loop verdicts: Brief+System critics PASS everywhere; Craft ties Ada on pricing/FAQ/CTA/
   footer; hero/steps/pipeline residual gaps are brief-vs-bar trade-offs (our cards carry real content),
   accepted by stopping the loop. Founder then approved.

## What the new session must build

Port demo 4 into the codebase for ALL THREE pages (demo 4 is the full How-it-works page plus a
Reply feature slice and a pricing strip; Features and Pricing pages need the same system applied
to their full existing content):

- `/how-it-works` — direct port of demo 4 (hero, stat cards, overview, 6-step sticky stack with
  artifacts + working Copilot/Autopilot switch, pipeline 3×2, guarantees, FAQ, CTA).
- `/features` — keep the existing 9 feature sections' content (`src/components/sections/features/`)
  restyled in the system; the demo's Reply slice shows the pattern (centred intro, tab switch,
  paper cards, diag rows, outline pill with forest arrow disc).
- `/pricing` — keep `PricingContent.tsx`'s view-model logic (flags, founding prices, purchasability,
  waitlist vs signup) — the demo shows only the visual: plan cards with left bars (sage-bar Copilot /
  gold Autopilot), inline "Opening soon" badge, `$29`/`$69` as one unit "per month", aligned door
  slots, comparison matrix + FAQ + CTA restyled.
- `SiteNav` / `SiteFooter` / `SiteShell` chrome: sticky pill nav (solid white, forest CTA pill with
  arrow disc), bone island, new footer (brand+blurb, 3 columns, grid-width hairline, © line).
- Motion: `motion/react` (NOT framer-motion) or CSS, per Island rules; the demo's JS shows exact
  behaviours (staged hero entrance, stat stagger+count-up, countdowns, typewriter draft, pulse dot,
  scroll reveals, sticky stack with `--top: 116 + i*8`). All gated on `prefers-reduced-motion`.
  Note: `overflow: clip` (not hidden) on the island so sticky works; page root must NOT have
  overflow-hidden (iOS rule). The wash video needs `visibilitychange` replay + poster fallback
  (see demo JS — background tabs never fire `canplay`).
- Wash media → `public/` (or import), not data URIs, in the real app.

## Repo integration facts (verified this session)

- Pages: `src/app/(public)/{how-it-works,features,pricing}/page.tsx` (server shells with flags —
  keep their props/flag logic; only the Content components + CSS change).
- Content: `src/components/sections/how-it-works/HowItWorksContent.tsx` (+6 artifact files),
  `src/components/sections/features/FeaturesContent.tsx` (+9 Feat* files),
  `src/app/(public)/pricing/PricingContent.tsx`.
- Page CSS: `src/app/(public)/_styles/{island,how-it-works,features,pricing}.css` — `@import`ed
  from `globals.css` in that ORDER (cascade is pinned by `design-scope-purity.test.ts`). Tokens
  live ONLY in `globals.css` `:root` (guards: `design-token-single-source.test.ts`,
  `design-doc-token-pin.test.ts` — the Island DESIGN.md tables must match the CSS, so
  `docs/design/island/DESIGN.md` must be updated with the new tokens in the same PR).
- Existing tests to keep green: `HowItWorksContent.test.tsx` (+client), `FeaturesContent.test.tsx`,
  `PricingContent.test.tsx`, `pricing-view-model.test.ts`, `claude-md-shape.test.ts`, eslint
  boundary tests. A11y contract: one `<main id="main-content">` per page (SiteShell provides it);
  FAQ accordions keep aria-expanded/controls; icon-only controls need labels; inline SVG only.
- Fonts: DM Sans already self-hosted (`src/app/fonts/dm-sans-latin.woff2`); check which weights the
  woff2 carries — the design needs 400 only.
- Verification: `pnpm lint && pnpm typecheck && pnpm test`; sibling worktree via
  `pnpm worktree:new <branch>`; land via PR (never push main).

## Suggested skills for the new session

- `repworth-brand-design` — FIRST; then update `docs/design/island/DESIGN.md` to the new system
  (the doc-pin test forces this anyway).
- `feature` or `writing-plans` + `subagent-driven-development` — this is a multi-file feature;
  plan as tracer bullets (tokens+chrome → how-it-works → features → pricing → docs).
- `impeccable` — final UI polish/QA pass in the browser.
- `claude-in-chrome` + `run` — visual verification against the demo, incl. `?static=1`-style checks.
- `document-feature` — post-merge docs sweep.

## Open items / watchouts

- Old teal-based components elsewhere (auth, approve, admin, legal, help) inherit the nav/footer
  rebrand but keep their page CSS; do not break them — the new tokens should ADD (e.g. `--rw-ink2`,
  `--rw-bone`, `--rw-forest`, bar colours) rather than repoint existing `--rw-teal*` without
  checking consumers (ADR 0004 contrast rules still apply to surfaces that keep teal).
- The demo hides the marquee behind an opaque bone island; real pages must keep the marquee visible
  outside the island exactly as today.
- Judge/06 bar is ink by design; Copilot plan bar sage-bar, Autopilot gold.
- Stat-card figures and all mock content are illustrative — keep the disclaimer lines verbatim.
- The demo's `?static=1` mode is demo-only; don't port it.
