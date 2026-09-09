# Daylight Gallery II — approved marketing rebrand spec (2026-08-21)

This folder is the design source of record for the "Daylight Gallery II"
rebrand of the three marketing pages (`/how-it-works`, `/features`,
`/pricing`) and the shared SiteNav/SiteFooter/SiteShell chrome. The founder
approved demo 4 on 2026-08-21. The Island Style Reference
(`docs/brand-asset-library/design-systems/island/DESIGN.md`) is the system of record; this folder holds
the approved demo and its inputs.

## Contents

| File | What it is |
|---|---|
| `demo4-daylight-v2.src.html` | The approved demo, readable source. Placeholders: `__LOGO__`, `__WASH__`, `__WASHVID__`. This file is the visual spec. |
| `build4.py` | Substitutes the placeholders and writes `demo4-daylight-v2.html`. Run it in this folder to rebuild the demo. |
| `logo_datauri.txt` | Logo data URI for `build4.py`. |
| `system-amendments.md` | The token spec: user-approved amendments to the Island Style Reference for this rebrand. |
| `bar.md`, `progress.md` | Design-loop record (reference bar + round verdicts). |
| `HANDOFF-daylight-ii-rebrand.md` | The implementation handoff written at approval time. |
| `media/wash_c.png`, `media/wash_d.png` | Hero-wash source stills (Higgsfield, paid). Do NOT regenerate — reuse these. |
| `media/wash_loop.mp4` | 73 KB palindrome loop built from the stills. Runtime copy: `public/video/hero-wash-loop.mp4`. |
| `media/wash_poster.jpg` | Poster / reduced-motion fallback. Runtime copy: `public/images/hero-wash-poster.jpg`. |

## Rules

- The demo's `?static=1` mode is demo-only; the app does not port it.
- The marquee field stays visible outside the island; the island is opaque bone.
- Tokens live in `src/app/globals.css` `:root` only (guard:
  `design-scope-purity.test.ts`); the tables in
  `docs/brand-asset-library/design-systems/island/DESIGN.md` must match (guard:
  `design-doc-token-pin.test.ts`).
