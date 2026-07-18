# Plan adversarial review — Codex round 1 (VERDICT: REVISE) + triage

Codex read the plan, investigation, intake, and grounding source. Verdict REVISE,
7 findings. Triage below (superpowers:receiving-code-review — verified, not
performed). Facts re-verified against the repo before accepting.

| # | Finding | Verdict | Action |
|---|---------|---------|--------|
| F1 | Flush hypothesis mechanically wrong: postgres.js 3.4.9 has NO cork/uncork — it buffers the full Parse/Describe/Bind/Execute/Sync into one write, defers small writes via `setImmediate`, one `socket.write()` (connection.js:185,246). Temporary starvation would delay the `setImmediate`, not lose it forever → doesn't explain PERMANENCE, `state_change` fixity vs `query_start` restamp, or poison-migration. | **ACCEPT** | Rewrite investigation: root cause is UNPROVEN; drop the cork claim; require the harness + postgres.js `debug` hook (fires pre-write) to actually test any mechanism; any accepted mechanism MUST explain permanence + state_change fixity + migration. |
| F2 | T1 standalone harness can't validate T2 (which changes `worker/index.ts`). Re-running a standalone script after T2 exercises nothing. `.scratch/wedge-repro.ts` absent from this worktree. | **ACCEPT** | T1 boots the REAL worker, fresh process/container per trial, real 30 Queue/30 Worker + actual start fns, unique per-trial markers, staging-positive-match + prod-reject, transport-write-level timing via `debug`. Cure toggles the real stagger seam via env. Acceptance = ZERO wedge across repeated fresh boots (not first-boot-self-healed). |
| F3 | ≤10s poller stagger doesn't isolate the storm: BullMQ Workers autorun at module scope and run DB-backed handlers before pollers start; plan never awaits Redis DNS/reconnect settling. | **ACCEPT** | Cure = boot-readiness coordinator: `autorun:false` during boot (or async coordinator) + bounded Redis/BullMQ readiness await, THEN ordered/staggered DB-loop starts + worker resume. No postgres.js option is an assumed cure. A `.cancel()`-based client-side timeout is a staging experiment for ADDED containment, not the fix. |
| F4 | `staggerBoot(): void` unsafe at shutdown: SIGTERM `stopX()` can precede a delayed `startX()`, starting DB work mid-shutdown (shutdown.ts:81). | **ACCEPT** | Interface → `{ cancel(): void; done: Promise<void> }`; `stopBackgroundLoops` cancels pending timers FIRST; readiness held false until `done`; schedule strictly monotonic. Add `worker/shutdown.ts` to surface. |
| F5 | Reaper deletion (T3) sequenced too early (parallel to T2), removing diagnostic identity + fastest re-arm path before cure proven. (Concedes: reaper unreachable today, so deletion doesn't cut LIVE protection.) | **ACCEPT w/ nuance — SURFACE to user** | Keep T3 in-branch but gate the PR→main MERGE on staging cure-validation (already required for high-risk). Fallback documented: if cure fails validation, re-plan the reaper (keep dormant). Offer the user the cleaner decouple: reaper-delete as its own small PR that merges regardless. |
| F6 | T3 misses refs: SIX marker sites (6th = `src/lib/shared/backlog-depth.ts:37`, #501's code, now on main); `health-db.ts` + `CONTEXT.md` go stale; FIVE `POOL_WEDGE_REAPER_*` vars (not 1); don't blind-delete `DIRECT_URL`; surface omits `boot-stagger.ts`+tests, `src/lib/db/__tests__`, `src/lib/config/__tests__`, `backlog-depth.ts`, maybe `package.json`. | **ACCEPT** (verified) | Enumerate 6 marker sites + comment refs; remove all 5 reaper env vars; remove `DIRECT_URL` config exposure (sole consumer was the reaper) but preserve the direct-route concept in the re-arm ticket; update health-db.ts + CONTEXT.md; expand surface (below). Run harness via `tsx` — NO package.json script (avoids manifest-edit hook). |
| F7 | OP4 stale: #501 ALREADY MERGED (verified: 2026-07-18T21:18:57Z). `verify-gate.sh` runs each `verification_commands` entry via `bash -c` — the annotated `pnpm ci:db-imports (...)` / `OPERATIONAL (...)` entries aren't valid shell. Add `pnpm build`. | **ACCEPT** (mostly) | Drop OP4 (#501 done). Fix `verification_commands` → executable-only; move prose to a separate field/notes. `pnpm build`: backend-only → gate skips it by convention (#502 precedent), run manually as insurance — not added to the required gate list. |

## Verified facts (this session)
- #501 MERGED 2026-07-18T21:18:57Z → backlog-depth alert on main; OP4 removed.
- 6 `/* rw-reapable */` query sites: 5× `health-alert/checks.ts` + 1× `src/lib/shared/backlog-depth.ts:37`. Plus comment refs in `health-db.ts`, ADR 0007, env-vars.md, lab-notes.md.
- 5 reaper env vars: `POOL_WEDGE_REAPER_{ENABLED,AGE_S,INTERVAL_MS,MAX_PER_SWEEP,OP_TIMEOUT_MS}`.
- `DIRECT_URL` sole consumer = the reaper (`resolveDirectUrl`). No other reader.

## Surface expansion required (needs user sign-off — hook enforces declared surface)
Add to allowed_edit_surface: `worker/background/**` (boot-stagger + its tests),
`worker/shutdown.ts`, `src/lib/db/**` (server.ts + __tests__),
`src/lib/config/**` (worker.ts + __tests__), `src/lib/shared/backlog-depth.ts`.
(NOT package.json — harness runs via `tsx`.)
