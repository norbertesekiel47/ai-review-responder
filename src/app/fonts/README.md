# Self-hosted fonts

These `.woff2` files are served by `next/font/local` from `src/app/layout.tsx`
and `src/app/(authenticated)/layout.tsx`.

## Why they are committed

Both layouts used to load these families with `next/font/google`. Turbopack
resolves those at **compile time** by fetching from `fonts.googleapis.com` /
`fonts.gstatic.com`. When that fetch failed — intermittently, on whichever
family Turbopack happened to be processing — the build failed with:

```
[next]/internal/font/google/<family>.module.css:7:8
Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'
Import trace: ./src/app/layout.tsx
```

Because it breaks `layout.tsx`, it breaks every page at once. It took down E2E
runs and Vercel builds — production included — on commits that touched no React
code. Playwright retries do not help: the dev server itself is broken, so every
retry re-runs against the same broken server.

Self-hosting removes the build-time dependency on a third-party CDN entirely,
and stops leaking visitor IPs to Google on page load.

## What these files are

Each is Google's own **`latin` subset** file, downloaded unmodified. At the time
they were committed, each was **byte-identical (SHA-256) to the file Next was
already emitting** into `.next/static/media/`, so the migration changed nothing
about how latin text renders.

All six families are **variable** fonts: one file spans the family's whole
weight axis, which is why there is no file-per-weight here. The `weight` ranges
declared in the two layouts are the weights this app actually uses.

| File | Family | Weights used | Style |
|---|---|---|---|
| `inter-latin.woff2` | Inter | 100–900 | normal |
| `plus-jakarta-sans-latin.woff2` | Plus Jakarta Sans | 200–800 | normal |
| `dm-sans-latin.woff2` | DM Sans | 400–700 | normal |
| `fraunces-latin.woff2` | Fraunces | 300–500 | normal |
| `fraunces-italic-latin.woff2` | Fraunces | 300–500 | italic |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | 400–500 | normal |
| `young-serif-latin.woff2` | Young Serif | 400 | normal |

`dm-sans-latin.woff2` is referenced by both layouts under two different CSS
variables (`--font-dm-sans` and `--rw-font-body`). Next emits the file once.

## Known limitation: non-latin glyphs

`next/font/google` also emitted non-preloaded `@font-face` rules for the
`latin-ext`, `cyrillic`, `cyrillic-ext`, `greek`, `greek-ext` and `vietnamese`
subsets, lazily fetched per `unicode-range`. **`next/font/local` has no
per-file `unicodeRange` option**, so that split cannot be reproduced here.

Text outside the `latin` range — e.g. a review written in Vietnamese, Greek or
a Cyrillic script — now renders in the size-adjusted system fallback instead of
the brand face. `adjustFontFallback` keeps the metrics matched, so this changes
the typeface, not the layout. Both layouts already declared `subsets: ['latin']`,
so this is that declaration actually taking effect.

If full coverage is ever needed, the options are (a) hand-written `@font-face`
rules with explicit `unicode-range`, giving up `next/font`'s automatic fallback
metrics, or (b) merging subsets into one file per family with `fonttools`.

## Refreshing a file

Fetch the `latin` block for the family from the CSS API with a modern browser
`User-Agent` (an older one gets TTF instead of woff2). For a family with italics,
select the block by `font-style` — the `latin` comment appears once per style:

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

curl -sS -H "User-Agent: $UA" \
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap'
# → copy the .woff2 URL under the `/* latin */` comment, then:
curl -sS '<that-url>' -o dm-sans-latin.woff2
```

Family specs, matching what the layouts request:

| Family | `family=` spec |
|---|---|
| Inter | `Inter:wght@100..900` |
| Plus Jakarta Sans | `Plus+Jakarta+Sans:wght@200;300;400;500;600;700;800` |
| DM Sans | `DM+Sans:wght@400;500;600;700` |
| Fraunces | `Fraunces:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500` |
| JetBrains Mono | `JetBrains+Mono:wght@400;500` |
| Young Serif | `Young+Serif:wght@400` |

Google revs the URL hash when it reissues a font, so the exact URLs are not
pinned here — re-derive them from the CSS API. After refreshing, run
`pnpm build` and confirm no `fonts.googleapis.com` request happens.
