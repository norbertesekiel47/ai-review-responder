# Review record — `fix/1078-title-suffix-and-demo-retry`

Reviewed SHA: `fe0380f60366533ce07d92454eb2ce779f44df35`
Fork point: `f797d25064c31997dfe400414baf99967b63315f` (unmoved; no rebase)
Production diff: **50 added / 16 deleted** (tests and workflow artifacts excluded).

## Wave composition, and why it was one member

`risk: normal`, and the measured production diff is **66 changed lines** — well
under the 300-line threshold at which the maintainability axis joins. So the wave
carried the spec/correctness axis alone. `red-team-status.mjs` derived the
red-team waiver mechanically from the signed-off intake and printed **WAIVED**;
that is a reading of the contract, not a claim made at transition time.

The axis returned **6 findings, all Low, all ACCEPT, no blocking defect.** Five
were fixed; the sixth is carried forward as a product question.

## What the review confirmed

- The route change is correct: `REGENERABLE_STATUSES` is interpolated as a
  postgres.js **bind parameter**, not string-built SQL; `running`, `queued` and
  `archived` stay ineligible so a retry cannot race a worker mid-generation;
  owner scoping, the cost reservation and its cleanup, and the archive-then-insert
  plus `job_outbox` row in ONE transaction are byte-identical to base.
- **The fix lands end to end.** `PaywallWithDemoClient` renders "Try the demo
  again" only on the failed/skipped branch, and the demo page selects the newest
  non-archived demo — so the freshly queued replacement is what the refresh shows.
- Five of the six promised tests fail when the feature is reverted. The scan is
  additionally guarded against vacuity by asserting it found >50 files and >20
  titles against the real tree.
- Nothing from sections A, C, D or E of #1078 crept in. The root layout's
  `openGraph.title` and `twitter.title` are untouched.

## The findings, and why they mattered

Every one was about the GUARD, not the sixteen edits — which is right, because
the guard's whole value is preventing the seventeenth page.

1. **Blind to three page-17 spellings.** `metadataTitles` returned `[]` whenever
   `export const metadata` was absent, so a page using `generateMetadata` — the
   standard Next API for a dynamic segment, and the likeliest future shape — was
   never even opened. Also missed `title: PAGE_TITLE` and
   `title: { default: … }`. **Fixed:** the scan now extracts balanced-brace,
   comment-aware metadata regions from both `export const metadata` and
   `generateMetadata()`, and reads four value shapes including an identifier
   resolved through a same-file `const` or one import hop. Each is proved by a
   fixture asserted on its exact reported title, with two clean controls — an
   identifier from a bare package (unresolvable, and deliberately not guessed)
   and the landing page's brand PREFIX.
2. **All layouts were excluded, where only the ROOT one earns it.**
   `src/app/mfa/layout.tsx` titles its whole subtree, so nested layouts owning
   titles is established practice here. A nested layout spelling the suffix
   produced the identical doubled tab and was never scanned. **Fixed:** layouts
   are scanned, excluding only `src/app/layout.tsx`, proved both ways.
3. **The guard would have false-positived on deferred work.** `title.template`
   applies to `metadata.title` only, and the root declares `openGraph.title` with
   no template — so a CORRECT per-page OG title has to spell the brand. The
   guard sliced to EOF and would have failed the openGraph follow-up that
   `non_goals[2]` defers. **Fixed:** `openGraph`/`twitter` blocks are stripped
   and `title:` matches only at the top level.
4. **"Names every offending file and its title" was vacuous.** It hand-built
   `Offender` literals and checked the formatter; `findOffenders` was never
   invoked. The mutant `offenders.push({ file, title: '' })` kept the whole suite
   green while the real gate failure would print absolute machine paths with
   empty titles — the exact outcome the docstring said it prevented. **Fixed**
   with a fixture tree run through the real `findOffenders`, and verified by
   making that exact mutation: 4 tests went red, reporting
   `expected "…/login/page.tsx → title: 'Log in · RepWorth'"` against
   `"/var/folders/…/login/page.tsx → title: ''"`. Mutation restored.
5. **The 16-row table's `path` was decorative.** Nothing tied it to the module
   `load()` imported, and the surface holds two same-title pairs with identical
   `robots` — so a copy-paste mis-pointing both privacy rows passed every
   assertion. **Fixed:** loaders come from `import.meta.glob` keyed by the row's
   own `path`, so a row cannot point at another module, and an unknown path
   throws.

## Carried forward, not fixed

**The `goal` sentence is not true of `/`.** The landing page title is
`'RepWorth: Automated Google review responses'`, so with the root template the
tab reads the brand twice. That is a brand PREFIX, not a mechanical duplicate,
and it is a copy decision rather than a bug — the guard deliberately allows it,
with a control asserting the allowance. But the intake's goal says "every public
page renders its brand suffix exactly once", and that is unmet for the
highest-traffic public page. It wants a ticket rather than only a comment,
otherwise the next reader takes the guard's own docstring as saying `/` is fine.

Two smaller items, both out of surface and both true:

- `src/app/onboarding/_shared/__tests__/page-titles.test.ts` and
  `src/app/mfa/__tests__/metadata.test.ts` are narrower title guards whose
  suffix check the new app-wide scan now subsumes; they keep other assertions,
  so consolidation is a follow-up rather than a deletion.
- `'skipped'` appears as a `generation_status` in `PaywallWithDemoClient.tsx`
  but is absent from migration 032's CHECK constraint. Pre-existing, untouched,
  and non-regenerable either way.

## Non-actionable notes worth keeping

The reviewer traced whether widening the eligible set to `{completed, failed}`
lets a second POST pick a stale settled row while an earlier retry is still
`queued`, and concluded it is unreachable: migration 032's
`onboarding_demos_one_completed_per_user` caps completed rows at one per user,
`/api/onboarding/start` refuses a second insert once the place is set, and every
regenerate archives the row it selected. The row-level invariant holds
unconditionally; the account-level one holds by construction elsewhere, not by
anything this route asserts — worth a sentence in the route docstring if the
demo lifecycle ever grows a second producer.
