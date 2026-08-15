# CI health triage — handoff (2026-08-11)

Three findings surfaced while triaging the stale Dependabot PRs (#317 / #424 / #579).
That triage is **done and merged**; this document covers only what was left behind.
None of the three is filed as a GitHub issue yet.

**Nothing here is started. No branch exists. Each item is independent — do them in any
order, but the suggested order is 3 → 1 → 2 (cheapest and most misleading first).**

---

## Context: what already landed (do not redo)

Seven PRs merged on 2026-08-10/11, ending at `aed5c2ba`:

| PR | Change |
|---|---|
| #579 | `actions/checkout` → 7.0.1 (all 12 sites) |
| #317 | `actions/upload-artifact` → 7.0.1 |
| #424 | `actions/cache` → 6.1.0 (`e2e.yml`) |
| #775 | `dependabot.yml`: `directories` glob so `.github/actions/*` is scanned |
| #778 | `actions/cache` → 6.1.0 (composite) |
| #777 | `actions/setup-node` → 7.0.0 |
| #780 | `react-doctor` re-pinned to the v2.2.8 **release** commit (was tracking `main`) |
| #782 | SHA-pinned the last two floating refs in `claude*.yml` |

Every action under `.github/` is now SHA-pinned to a current release. #776 was closed
in favour of #780. **Do not un-pin anything.**

---

## Issue 1 — 44 open Dependabot security alerts

### Evidence

`gh api "repos/RepWorth/ai-review-responder/dependabot/alerts?state=open&per_page=100" --paginate`
→ **44 open: 22 high, 21 medium, 1 low.** Every alert has a patched version available;
there are zero "no patch" entries.

They collapse into ~12 packages. The largest are already **inside existing semver
ranges**, so they are a lockfile refresh, not a dependency migration:

| Package | Installed | Patched | package.json range | Alerts |
|---|---|---|---|---|
| `next` | 16.2.6 | 16.2.11 | `^16.2.6` — in range | **9** (4 high) |
| `nanoid` | 5.1.11 | 5.1.16 | in range | 3 |
| `postcss` | 8.5.15 | 8.5.18 / 8.5.23 | `^8.5.15` — in range | 2 |

Transitive (not hoisted, so `require()` can't see them): `axios` → 1.18.0 (10 alerts),
`undici` → 7.29.0 (5, dev), `brace-expansion` (6), `fast-uri` (3), `vite` → 8.0.16
(2, dev), plus one each of `sharp`, `find-my-way`, `@opentelemetry/core`, `@babel/core`.

### Why it hasn't self-healed

Dependabot's own npm jobs keep dying at the registry — failures on 08-09, 08-10, 08-11
for `undici`, `brace-expansion`, `fast-uri`. The proxy log ends with:

```
proxy | WARN: Cannot handshake client registry.npmjs.org:443
        read tcp 172.19.0.2:1080->172.19.0.3:42094: read: connection reset by peer
```

That is upstream infrastructure, not repo config. Don't go looking for a bug in
`dependabot.yml` — it was just corrected in #775 and the `github_actions` job succeeds.

### Approach

1. `pnpm update` to refresh the lockfile; confirm `next` moves 16.2.6 → 16.2.11.
   This alone clears 9 alerts including 4 of the 22 highs, with **no `package.json`
   change** — the caret already permits it.
2. Re-check the alert count. For anything left, use `pnpm.overrides` in `package.json`
   only where a parent pins a vulnerable version.
3. Verify: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm build`.

### Constraints

- `next` is app-wide. Per CLAUDE.md's promotion rules this should ride `staging` before
  `main`, not go straight in.
- Do **not** bump majors here. If a fix needs a major, split it into its own PR.
- Do not touch the `github_actions` entry in `dependabot.yml` (settled in #775).

---

## Issue 2 — E2E fails intermittently on `next/font/google` under Turbopack

### Evidence

Two failures on `main` within ~6 hours, and **only** on `main` across the last 20 runs
on all branches:

| Commit | Time | Font that failed to resolve |
|---|---|---|
| `34a54540` | 03:43 | `fraunces_1e9ece7d.module.css` |
| `f5151902` | 07:11 | `dm_sans_bcb79813.module.css` |

Identical error both times:

```
⨯ [next]/internal/font/google/<font>.module.css:7:8
Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'
Import trace: ./src/app/layout.tsx
```

**This is not Fraunces-specific** — it hits whichever font Turbopack happens to be
processing. `src/app/layout.tsx:2` imports five families:

```ts
import { Inter, Plus_Jakarta_Sans, DM_Sans, Fraunces, JetBrains_Mono } from 'next/font/google';
```

with these configs (preserve exactly when migrating):

| Family | Weights | Notes | CSS variable |
|---|---|---|---|
| Inter | (default) | | `--font-inter` |
| Plus Jakarta Sans | 200–800 | 200/300 used by landing hero | `--font-plus-jakarta` |
| DM Sans | 400/500/600/700 | | `--font-dm-sans` |
| Fraunces | 300/400/500 | **normal + italic** | `--font-fraunces` |
| JetBrains Mono | 400/500 | | `--font-jetbrains-mono` |

All `subsets: ['latin']`, all `display: 'swap'`.

Playwright boots the app via `playwright.config.ts:34` → `command: 'pnpm dev'` →
`next dev` → Turbopack, which fetches all five from `fonts.googleapis.com` at compile
time. One failure breaks `layout.tsx`, which breaks every page, so every
rendered-content assertion fails at once (14 tests in the `34a54540` run).

### What does NOT work

**Playwright retries.** The `34a54540` log shows Retry #1 and Retry #2 both failing —
the breakage is in the dev server, not the test, so the retry re-runs against the same
broken server.

### Approach

Self-host via `next/font/local`: fetch the woff2 subsets for the five families above,
commit them, and rewrite the five configs, keeping every weight/style/variable name
identical so `globals.css` and all consumers are untouched.

Decide where the files live before writing any — check `docs/directory.md` first; the
repo rule is "default is no new file / no new top-level directory."

Beyond fixing CI this removes a build-time dependency on a third-party CDN and is the
better privacy posture.

### Verification

Re-run E2E several times — a single green run proves nothing against a ~17%
intermittent failure. Confirm no `fonts.googleapis.com` fetch remains at build time.

---

## Issue 3 — react-doctor runs an unpinned version, and the devDependency is vestigial

> **Correction.** An earlier reading of this said "local runs 0.2.14, CI runs 0.9.11,
> so the two environments disagree." **That was wrong** — it was based on the
> `package.json` devDependency without checking what the script actually executes.
> The corrected finding is below.

### Evidence

Three references, and the two that actually *execute* both float:

| Reference | Location | Resolves to |
|---|---|---|
| `"doctor": "npx react-doctor@latest"` | `package.json:51` | **latest** (0.9.11 today) |
| action input `version:` **unset** → defaults to `latest` | `.github/workflows/react-doctor.yml` | **latest** (0.9.11 today) |
| `"react-doctor": "^0.2.14"` devDep | `package.json:112` | 0.2.14 installed, **never executed** |

`doctor.config.json` references only rule *names* (`react-doctor/no-fetch-in-effect`
etc.), not the package. Nothing imports the devDependency.

So the two real paths agree with each other — but both float to `@latest`, meaning
**findings can change day to day with no change in this repo**, and the CI job runs
`blocking: error`. The `^0.2.14` devDep is stale (7 minors behind), unused, and
misleads anyone reading `package.json`.

Note this is adjacent to, but distinct from, the fallow local-vs-CI gotcha already in
CLAUDE.md (#783) — that one is about coverage inputs, this one is about version drift.

### Approach

1. Pin the action: add `version: "0.9.11"` next to `blocking: error` in
   `.github/workflows/react-doctor.yml`.
2. Pin the script: `"doctor": "npx react-doctor@0.9.11"`.
3. Resolve the devDep: either remove `react-doctor` from `devDependencies` (nothing
   imports it) or align it to the same version. Removing is cleaner — but check
   `ci:fallow` / unused-dependency audits react either way.

Keep all three in lockstep in one PR, and add a comment saying they must move together.

### Caveat

The action step is `blocking: error`. Pinning may surface findings that differ from
whatever `latest` reported on the last run, so budget triage time. If the pinned
version goes red, fix the findings or adjust `doctor.config.json` — **do not** revert
to `latest` to make it green.

---

## Repo constraints that apply to all three

- `main` is protected. **Land via PR** — direct pushes are rejected.
- Required checks: `lint`, `typecheck`, `test`, `build`, `deploy-install`, `llm-eval`.
- `lefthook` runs the cheap CI subset pre-push. `git push --no-verify` for WIP only.
- Verify before claiming done: `pnpm lint && pnpm typecheck && pnpm test`.
- The fallow PR gate is `ci:fallow:coverage`; a bare `fallow audit` does **not** predict
  it in either direction. Reproduce with `pnpm test:coverage && pnpm ci:fallow:coverage`.
- Anything touching the worker, a webhook, a migration, or billing rides `staging` first.
  The `next` bump in Issue 1 is app-wide and should follow that path.
- Migration 078 — and only 078 — is absent in prod; do not apply it out-of-band.
  (Corrected 2026-08-14: 077 and 105 turned out to be applied there already, #825.)

## Useful commands

```bash
# alert inventory
gh api "repos/RepWorth/ai-review-responder/dependabot/alerts?state=open&per_page=100" \
  --paginate -q '.[] | "\(.security_advisory.severity)\t\(.dependency.scope)\t\(.dependency.package.name)\t\(.security_vulnerability.first_patched_version.identifier // "NO PATCH")"' \
  | sort | uniq -c | sort -rn

# E2E history on main (watch for the font failure recurring)
gh run list --workflow=E2E --branch main --limit 15 \
  --json headSha,conclusion,createdAt -q '.[] | "\(.headSha[0:8])\t\(.conclusion)\t\(.createdAt[0:16])"'

# confirm no floating action refs crept back
grep -rnE "uses: [a-z0-9._-]+/[a-z0-9._-]+@(v[0-9]|main|master)" .github/
```
