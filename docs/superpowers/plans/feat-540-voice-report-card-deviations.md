# Deviations — feat/540-voice-report-card

(Empty — subagents append entries the plan did not anticipate; orchestrator triages at step 6.5.)

## 2026-07-24 — Task 2: noUncheckedIndexedAccess guards in voice-report-card.ts

The plan's `voice-report-card.ts` code failed `pnpm typecheck` (22 errors) because the
repo's tsconfig enables `noUncheckedIndexedAccess` — indexed reads (`conforming[0]`,
`values[0]`, `examples[0]`, regex match groups `m[1]`) type as `T | undefined` even
after a length/clearsBar check. Minimal adaptation, no behavior change:
- each deriver captures `const evidence = conforming[0]; if (!evidence) return null;`
  (unreachable in practice — clearsBar/length guards precede it);
- `mostFrequent` initializes `let best = values[0] ?? ''`;
- `signoffOf` narrows match groups via `ownLine?.[1]` / `trailing?.[1]?.trim() ?? null`;
- `deriveVoiceReportCard` destructures `const [mostRecent] = examples; if (!mostRecent) …`
  replacing the equivalent `examples.length === 0` check.
All 10 promised tests still pass unchanged; test titles untouched.

**VERDICT: ACCEPT** — mechanical type-narrowing, no behavior change. Note for reviewers: the
`if (!evidence) return null` guards branch around states the preceding `clearsBar` check
excludes; accepted because `null` = "trait not detected" is the deriver's own safe semantics
(not silent error-swallowing), and a throw would turn an impossible state into a 500 on a
read-only card.

## 2026-07-24 — Task 4: two adaptations (logged at triage; surfaced in subagent summary)

1. Plan skeleton reset state via `setData(null)` inside the fetch effect; the repo's
   `react-hooks/set-state-in-effect` lint forbids it. Adaptation: `<VoiceReportCard key={locationId}>`
   remounts the card on location switch — identical behavior to the render contract.
   **VERDICT: ACCEPT** (lint-driven, behavior-equivalent, asserted by the re-fetch test).
2. Styling is inline rather than in `settings.css` (outside `allowed_edit_surface`); matches the
   existing sibling idiom in `VoiceClient.tsx`. **VERDICT: ACCEPT** (precedent-following; no surface amendment).

## 2026-07-24 — Gate: `reclassify` WARN triage

Gate WARN: total branch diff 1787 changed lines > 2× the intake's 700 estimate. The estimate
priced CODE (~700 ±250 across ~8 files); the total includes ~680 lines of plan/handoff/deviations
docs. Code-only diff is ~1,100 lines (including the unplanned coverage-fix tests) = 1.57× the
estimate — under the 2× re-classification trigger. **VERDICT: ACCEPT — lane stays `normal`, no
step-0 re-run.** Lesson for future intakes: state whether the estimate includes docs, or the
gate's raw comparison will over-fire.

## 2026-07-24 — Review fix round (triaged list, fixes 1–13)

1. `deriveLength` averages now computed over CONFORMING pairs only; claim reworded to
   describe the tightened replies so the numbers can never contradict the pattern.
2. `deriveCritical` non-cut branch bar raised: negative pair conforms only via new
   `isSubstantiveRewrite` (editWords ≤ 0.75×draftWords OR word-set Jaccard < 0.7) —
   "replaced the draft with your own words" is now justified.
3. `deriveCritical` generalization check now uses the existing `clearsBar` helper.
4. `TRAILING_SIGNOFF_RE` tightened to name-shaped captures
   (`/[—–]\s*([A-Z][^—–\n.!?]{0,30})\s*$/`) — "— thanks so much!" no longer a sign-off.
5. `MIN_EXAMPLES_FOR_ACTIVATION` exported from `voice-learning.ts` (single owner).
6. Route's local `ACTIVATION_THRESHOLD` deleted; imports `MIN_EXAMPLES_FOR_ACTIVATION`.
7. Route's local `UUID_RE` deleted; imports the canonical `UUID_RE` from
   `src/lib/locations/owner-route.ts`.
8. Ownership SELECT moved inside the route's try/catch — DB failure now flows through
   `reportCaughtError` → 500; 400/404 semantics unchanged.
9. `VoiceReportCard.tsx` re-declared interfaces replaced with
   `import type { RegisterTrait, TraitSnippet }` (restores `RegisterTraitKey` narrowing).
10. Zero-trait fallback renders `{editedCount}{'+' when ≥10}` — corpus LIMIT 10 means the
    count is a floor, never falsely absolute.
11. Conforming-pair snippet test hardened: escape hatches removed; per-trait stripped
    snippet cores must literally appear in a pair's draft/edit (can fail for every kind).
12. New tests: length averages from conforming pairs only (mixed cut/expansion corpus);
    trivial negative-pair typo edit yields no critical trait; trailing "— thanks so much!"
    is not a sign-off. Existing critical single-pair test unchanged (Derek rewrite is
    substantive; cut-claim branch still applies).
13. Intake edge case amended in BOTH `.feature/intake.json` and this plan's intake copy:
    "Malformed locationId -> 400; foreign or archived locationId -> 404".
    **VERDICT: intake harmonized to plan contract** (triage: code is right).
