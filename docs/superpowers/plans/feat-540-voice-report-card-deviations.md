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
