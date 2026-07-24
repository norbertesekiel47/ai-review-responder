# Standards & Maintainability Review — feat/540-voice-report-card (step 7)

Reviewer: standards/maintainability agent, thermo-nuclear-code-quality-review skill applied.
Scope: `git diff $(git merge-base origin/main HEAD)..HEAD` in worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-540-voice-report-card`.
Deviations doc read (`docs/superpowers/plans/feat-540-voice-report-card-deviations.md`) — all three
ACCEPT verdicts honored; the `if (!evidence) return null` guards, keyed remount, and inline styling
are NOT re-litigated here.

Verification run: `pnpm vitest run` on the three new suites — 15/15 pass (605ms).

## Overall structural assessment

This is a well-shaped change. The thermo-nuclear lens found **no structural regression and no missed
code-judo move**:

- The `voice-learning.ts` refactor is the right judo: `getVoiceCorpusStatus` becomes the single owner
  of corpus-selection semantics and `getApprovedResponsePairs` collapses to a one-line delegate, so the
  report card and the prompt path provably read the same corpus (the intake invariant) by construction,
  not by parallel implementation. The prompt-path call site (`worker/jobs/response-generation/generate-draft.ts:104`)
  is untouched.
- `voice-report-card.ts` (234 lines) is a deep module: pure function in, typed traits out; five focused
  derivers + a dispatcher array. A generic "trait spec table" abstraction was considered and rejected —
  the per-trait claim logic (mostFrequent greeting word, word-count averages, signoff majority,
  evidence-scoped critical claim) differs enough that a table would be magic, not simplification.
  The current shape is correct.
- Route follows the sibling idiom exactly (`requireOwnerWithAccount` → ownership SELECT scoped by
  `account_id` → `jsonResponse`), with `reportCaughtError` + 500 on the derive path — actually stricter
  than the sibling `settings/voice/route.ts`, which has no catch at all.
- `VoiceReportCard.tsx` follows the `set-section` / `set-section-head` / `set-section-icon` sibling idiom;
  no structural divergence from `VoiceClient.tsx`'s sections.
- Glossary compliance: clean. Code says `RegisterTrait`/`RegisterTraitKey`, UI says "Voice Report Card";
  no "insights"/"learnings"/"grades" renames anywhere in the diff.
- No file approaches 1k lines; no spaghetti branches added to shared flows; no `any`; named exports
  throughout; comments state contracts/why (the two ticket references match established repo practice).

What remains are one-authoritative-owner violations and one weak test — all fixable in minutes.

## Findings (≥80% confidence)

### F1 (medium) — Activation threshold has two owners
`src/app/api/settings/voice/report-card/route.ts:16` declares `const ACTIVATION_THRESHOLD = 5`, duplicating
the private `MIN_EXAMPLES_FOR_ACTIVATION = 5` in `src/lib/responses/voice-learning.ts:4`. Standard violated:
engineering.md "one authoritative owner for each system fact" (and repworth.md's no-duplicated-constant
posture). If voice-learning's threshold ever changes, the route keeps returning `activationThreshold: 5`
and the UI dots/"N of 5" copy silently diverge from actual activation (`activated` is derived from
`examples.length > 0`, which follows the real constant). Fix: export the constant from voice-learning.ts,
or better, add `activationThreshold` to `VoiceCorpusStatus` so the wire value and the gate share one owner.

### F2 (medium) — Wire contract re-declared client-side, loosened
`src/app/(authenticated)/settings/voice/VoiceReportCard.tsx:13-31` re-declares `TraitSnippet`,
`RegisterTrait`, and the response shape as local interfaces instead of `import type { RegisterTrait,
TraitSnippet } from '@/lib/responses/voice-report-card'`. Type-only imports across this boundary are
explicitly allowed (CLAUDE.md invariant #1: "type-only `import type` allowed"). The copy also loosens
`key: RegisterTraitKey` to `key: string` (line 19), discarding the union the lib module carefully defines.
Two owners of the trait contract = the shapes can drift with no compiler signal. Fix: import the two
lib types; keep only a small local `ReportCardResponse` interface composing them (or export the response
type next to the route).

### F3 (medium) — Near-vacuous test assertions
`src/lib/responses/__tests__/voice-report-card.test.ts:68-78` ("every detected trait's snippet comes from
a conforming pair"): both assertions carry escape hatches that make them pass regardless of the property
under test for some traits.
- Line 70: `(p) => p.originalDraft.startsWith(...) || trait.snippet.before.includes('words') ? true : false`
  — the `includes('words')` term is independent of `p`, so for the length trait (whose snippet always
  appends "(N words)") `find` returns the first example unconditionally and `expect(source).toBeDefined()`
  is a tautology. The trailing `? true : false` is also dead weight over the whole `||`.
- Line 77: `p.editedVersion.includes(afterCore) || afterCore.startsWith('—')` — for the signoff trait
  the snippet after-text is always `— ${display}`, so `startsWith('—')` short-circuits `some` to true on
  the first pair, checking nothing.
Concrete maintainability failure: a regression that sources a length/signoff snippet from a
non-conforming pair would not fail this test, while its title claims it would. Fix: assert per-trait
against the known conforming fixtures directly (the point-of-view test at lines 100-115 shows the right
pattern), and drop the escape hatches.

### F4 (low) — `deriveCritical` re-implements `clearsBar` inline
`src/lib/responses/voice-report-card.ts:199`:
`conforming.length >= MIN_CONFORMING_PAIRS && conforming.length * 2 > negative.length` is byte-for-byte
the semantics of `clearsBar(conforming.length, negative.length)` defined at line 64 of the same file.
The detection-bar predicate is a locked glossary fact (CONTEXT.md "Register trait"); it should have one
expression. Fix: `const generalized = clearsBar(conforming.length, negative.length);`.

### F5 (low) — `UUID_RE` duplicated despite a canonical export
`src/app/api/settings/voice/report-card/route.ts:17` re-declares the UUID regex; a canonical `export const
UUID_RE` exists at `src/lib/locations/owner-route.ts:14`. Noting honestly: ~10 pre-existing routes carry
the same copy, so this is normalized drift rather than new damage, and `owner-route.ts` is a
location-routes module whose import drags in unrelated concerns. Flagged because the review bar is
"reuse the canonical helper"; the durable fix is hoisting `UUID_RE` to a neutral shared module
(e.g. `src/lib/shared/ids.ts`) — a good follow-up, not necessarily this PR.

## Approval

**APPROVE with minor findings.** No blocker under the thermo-nuclear bar: no structural regression, no
missed dramatic simplification (the voice-learning delegation IS the simplification), no file-size
explosion, no spaghetti growth, no boundary leak. F1-F4 are quick pre-merge fixes; F5 can ride a follow-up.

## Low-confidence appendix (NOT findings — style/spec-adjacent, <80%)

- `VoiceReportCard.tsx:139` error text uses `#B91C1C` while sibling `VoiceClient.tsx` uses `#DC2626` and
  neither is a `--rw-*` token. Pixel nit per review instructions; brand skill would prefer a token.
- The zero-trait fallback copy "You've edited {editedCount} replies" reads the LIMIT-10-capped count
  (documented on `VoiceCorpusStatus.editedCount`), so an owner with 30 edits sees "edited 10 replies".
  Spec-level wording question, not a standards violation; the cap is documented at the source.
- Client `fetch` has no AbortController timeout. production.md's timeout rule targets server outbound
  calls; sibling client code uses plain fetch too. Noted only for symmetry.
- `.catch((err: Error) => ...)` annotates the untyped catch param as `Error`; safe for the two throw
  sites in scope (fetch TypeError, explicit `new Error`), but `err instanceof Error ? err.message : ...`
  would be the belt-and-braces idiom.
- Route test mocks `@/lib/db/auth.requireRole` beneath `requireOwnerWithAccount` (mocking one layer below
  the imported helper). Works and matches the sibling test dialect; a `route-helpers` mock would be less
  coupled to the helper's internals.

## Orchestrator triage verdicts (step 7)

- medium ACTIVATION_THRESHOLD dual owner — ACCEPTED, fixed (MIN_EXAMPLES_FOR_ACTIVATION exported + imported).
- medium client-side contract re-declaration — ACCEPTED, fixed (import type from voice-report-card).
- medium vacuous conforming-pair test — ACCEPTED, fixed (escape hatches removed; per-trait core assertions).
- low inlined clearsBar predicate — ACCEPTED, fixed.
- low UUID_RE re-declaration — ACCEPTED, fixed (canonical import from owner-route.ts); repo-wide hoist stays a follow-up.
