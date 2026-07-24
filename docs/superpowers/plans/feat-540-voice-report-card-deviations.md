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
