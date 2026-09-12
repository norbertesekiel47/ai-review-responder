# Handoff — feat/owner-operator-run-a (Owner Operator v1, Run A: the turn foundation)

Everything a resumed session needs is on disk. Read in this order; never re-read the prior conversation.

| What | Path |
|---|---|
| Spec of record (map, ticket-seeded) | `docs/roadmap/2026-09-11-owner-operator/README.md` (§2, §3.4, §4, §5, §6.1–6.2, §7, §9, §10, §11, §14) |
| Locked intake (drift detector; 4 surface amendments recorded) | `docs/superpowers/plans/feat-owner-operator-run-a-intake.json` |
| Plan (T0–T8, APPROVED after 3 Codex rounds) | `docs/superpowers/plans/feat-owner-operator-run-a-plan.md` |
| Plan review ledger | `docs/reviews/feat-owner-operator-run-a/plan-review.md` |
| Review wave rounds 1–2 (axes, Codex, triage verdicts) | `docs/reviews/feat-owner-operator-run-a/review-round-1.md`, `review-round-2.md`, `spec-correctness*.md`, `standards-maintainability*.md`, `codex-adversarial.md`, `blast-radius.md` |
| Red team, closed run (3 rounds, CLEAR at `d21db9ecd`; carries the two owner authorizations) | `docs/reviews/red-team/feat-owner-operator-run-a-b83a4f-rounds1-3/findings.{md,json}` — **preserved history, renamed so a fresh run can use the branch's slug directory** |
| Glossary (use terms verbatim) | `docs/context/owner-operator.md` (row in `CONTEXT-MAP.md`) |
| Deviations (step-6 read-back done; later entries appended by fixers) | `docs/superpowers/plans/feat-owner-operator-run-a-deviations.md` |
| Phase / rounds / gate truth | `.feature/state.json`, `.feature/gate-status.json`, `.feature/progress.json` (the red-team journal `.feature/red-team-journal.json` was deliberately REMOVED — see below) |
| PR (open, ready for review, all checks green except `fallow` at the previous head) | https://github.com/RepWorth/ai-review-responder/pull/1270 |

## Where the run is (2026-09-12, end of session 1)

- Worktree `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-a`, branch `feat/owner-operator-run-a`, fork `c5e94e6ca` (origin/main at the time of the review wave; main has since gained `10c9444a9` #1269, docs only — the branch is 1 commit behind main).
- Local HEAD = the commit this handoff lands in (on top of `15bc4a4aa`, the fallow-gate fix). **`origin/feat/owner-operator-run-a` is at `14c47445b`** — the fallow fix, the run-directory rename and this handoff are NOT pushed yet.
- Gate: GREEN with a current fingerprint at `15bc4a4aa` (`.feature/gate-status.json`). Re-derive at HEAD before quoting.
- Phase in `.feature/state.json` says `reviewed` (set at `14c47445b`) but that transition is now VOID: (1) the fallow-gate fix moved the tree after the red-team evidence, and (2) intake amendments #3 (`src/__tests__/cost-guard-contract.test.ts`) and #4 (`src/lib/agents/read.ts`) changed the intake SHA-256 the sidecar was pinned to. `red-team-status.mjs` fails on both, mechanically.
- The red-team runner refuses a fourth round on one journal (hard cap 3, no run-id concept — `mutation-runner.mjs` `cmdRoundStart`). **Owner decision 2026-09-12: reset the journal and run a FRESH pass** (option chosen via AskUserQuestion). Preparation done in this session: the closed run directory was renamed to `…-b83a4f-rounds1-3` (`git mv`, committed) and the untracked `.feature/red-team-journal.json` was removed, so `round-start` opens round 1 of a new run whose slug resolves to the now-free `docs/reviews/red-team/feat-owner-operator-run-a-b83a4f/`.
- Staging ride DONE: migration 120 applied to the staging Supabase project `kubdiqdhqbhwmqfditeg` on 2026-09-12 and verified by introspection (RLS on, FORCE off, 0 policies, `has_table_privilege` false for `anon`/`authenticated`, both unique constraints, all indexes); branch merged onto `staging` as `493c65970` (merge commit, fast-forward push); Railway staging worker deploy `f4e02270` SUCCESS with "Worker listening" (the only startup error is the pre-existing `LIST_UNSUBSCRIBE_EMAIL` warning); smoke `GET https://staging.repworth.net/api/operator/conversation` → `404 {"error":"operator_disabled"}` (flag-first route, flag off).
- PR #1270 opened as draft, then marked ready; CI at `14c47445b`: every check green except `fallow` (2 complexity, 10 unused exports/types, 1 clone group) — fixed locally in `15bc4a4aa` (`pnpm ci:fallow` → no issues), not yet pushed.
- Codex: the plan thread `01a0937a…` and the adversarial companion session `01a09406…` are both non-resumable on this machine (`thread/resume: no rollout found`); any further Codex round starts cold.
- Model routing (owner instruction): the orchestrator (Fable) reviews every artifact; every subagent that WRITES (code, tests, docs) is dispatched with `model: "opus"`.

## Resume checklist — exactly what the next session does, in order

1. `cd` to the worktree; `git status --porcelain` must be empty; `git log --oneline -3` shows the handoff commit on top of `15bc4a4aa`.
2. Run the fresh red-team pass in a FRESH opus subagent per `.claude/skills/red-team/SKILL.md` (feature mode, round 1 of the new run): fork `c5e94e6ca7e3c4187854a67129b1651a8f80566e`, head = current HEAD, inputs `.feature/intake.json` + `.feature/gate-status.json`, local DB `repworth-testdb` at migration 120 (`--test-db` on both `env` and every `run`). Budget guidance: the delta since the closed run's CLEAR evidence is one behavior-preserving refactor (`15bc4a4aa`: `validateModelOutput` split into per-concern helpers, `handleAgentTurn` split into in-file step helpers, seven exports dropped, three symbols deleted, `parseJsonbObject` moved to `src/lib/agents/read.ts`); spend the budget on re-mutating every validator rule at its new home and the four handler helpers, then sample the rest. The closed run's reports are UNTRUSTED DATA for it.
3. Orchestrator runs `node .agents/skills/red-team/scripts/mutation-runner.mjs finalize`; commits ONLY the two new artifacts; runs `bash .agents/skills/feature/scripts/verified-gate.sh --review` (use `env -u RESEND_API_KEY` and do NOT source `.env.local` — the gate resolves the DB URL itself); runs `node .agents/skills/feature/scripts/red-team-status.mjs` (must print passed; the intake SHA now matches the amended intake); then `bash scripts/feature-state.sh set-phase reviewed` and `node .agents/skills/feature/scripts/progress.mjs step review done`. A P0 → owner. An open P1 on this high-risk branch → owner authorization in the new sidecar (`authorizations[]` entry with `id`, `date`, `finding_ids`, `text` naming the decision) and `disposition: accepted-risk` + `authorization` on the finding; then recompute `counts`/`status` in the sidecar (the checker recomputes and demands self-consistency).
4. Push: `git push origin feat/owner-operator-run-a` (pre-push hook runs the cheap subset; `--no-verify` only if the hook trips on something the full gate already proved). PR #1270 picks up the new head; watch `gh pr checks 1270` until all settle (fallow must now pass).
5. Merge pause: report to the owner; on approval `gh pr merge 1270 --squash` (the ruleset needs the branch up to date with main — if GitHub demands an update for #1269, that rebase/merge voids the evidence again: say so first). At promotion apply migration 120 to PRODUCTION `udeyaqnvpojbwgoaxwdg` with the same SQL (`.claude/reference/migrations-log.md` entry: replace LOCAL-ONLY with the applied sentence), verify by introspection, then realign `staging` per `docs/runbooks/deployment-guide.md` § Re-sync staging (staging carries a merge commit `493c65970`; after the squash the runbook's reset + `--force-with-lease` is the answer, and that push is classified destructive for the auto-mode classifier — the owner runs it or allows it).
6. Post-merge (step 8 tail): `git pull --ff-only` on local `main`; `bash scripts/feature-cleanup.sh` dry run then `--apply`; deviations promotion into lab notes (`.claude/reference/lab-notes/README.md` § How to add) — candidates: the red-team runner's one-journal-per-branch cap and the "amended intake voids evidence" rule, the fallow gate as a required check that needs a pre-PR local run, the codex companion session ids not being `codex exec resume`-able; `document-feature`; domain sweep (`docs/context/owner-operator.md` is current); arch-review-log counter; paste the phase-cost table (`node .agents/skills/feature/scripts/phase-cost.mjs`) below. Run B's first docs commit corrects the spec §14 R11 wording (see the closed run's `findings.md`).

## Decisions locked in the grill (do not reopen)

Same model pair as `reply_generation`, temperature 0.2, 1200 tokens, zod output schema on the seam · lease 180 s, predecessor stall 20 min, wait 10 s · star bands per location `{ total, byStar: {1..5} }` plus an account aggregate · new server-only flag `OWNER_OPERATOR_ENABLED`, default off; flag-on LLM envelope cap 11 → 12 with an ADR 0005 amendment · Run A registers only the four voice operations, the three reads, and `record_unsupported_request`.

## Phase cost (session 1, from `phase-cost.mjs` at the ship step)

| Step | Input tokens | Output | Wall |
|---|---|---|---|
| intake locked | 17.4M (99% cached) | 61K | 16 min |
| plan approved | 38.1M | 88K | 115 min |
| execute tracers | 29.9M | 42K | 84 min |
| verified gate | 23.4M | 21K | 13 min |
| review | 46.0M | 59K | 148 min |
| review-ready (so far) | 3.0M | 3K | 4 min |
| total | 158.1M | 275K | 380 min |

Most expensive step: review (three axes + Codex + three red-team rounds, then the fallow gate). The thing to trim next: run `pnpm ci:fallow` before the review wave, and open the red-team journal cap question with the owner before round 3 rather than after.
