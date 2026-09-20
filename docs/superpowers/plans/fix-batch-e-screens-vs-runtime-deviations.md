# Deviations — fix/batch-e-screens-vs-runtime

Entries the plan did not anticipate. Each carries a **Verdict:** line, resolved
at step 6 before the review wave. ACCEPT = the adaptation is sound.
RE-PLAN = it invalidates a locked decision.

---

## D1 — The ladder in the main checkout carried stale Batch A state

`progress.mjs init` did not reset `.feature/progress.json`; it kept Batch A's
`intake: done` note ("batch A: #1107 #1108 #1199 implement, #1305 verify+close")
and left the run reading 31% complete before this feature had started. Batch A
merged in #1345/#1347, so the state was dead. Backed the file up to the
scratchpad, removed it, and re-ran `init`, which then produced a clean ladder.

**Verdict:** ACCEPT — the reset was correct and lost nothing. Durable lesson for
step 8: `progress.mjs init` is not idempotent against a completed prior run.

---

## D2 — `progress.mjs init` rejects the classification vocabulary `/feature` uses

`/feature` step 0 names sizes `trivial | small | feature | epic` and surfaces
`ui | backend | full-stack`. `progress.mjs init` accepts
`trivial|small|standard|epic` and `ui|backend|mixed`. Two failed invocations
before the mapping was clear: `feature` → `standard`, `full-stack` → `mixed`.

**Verdict:** ACCEPT — mapped and proceeded; the axes mean the same thing.
Durable lesson for step 8: the command doc and the script disagree on two
vocabularies.

---

## D3 — `codex exec resume` does not accept `--sandbox`

`.agents/skills/feature/references/review-prompts.md` gives the verification
round as `codex exec resume <session-id> "<delta>"`. Carrying round 1's
`--sandbox read-only` across to the resume fails:

```
error: unexpected argument '--sandbox' found
Usage: codex exec resume --model <MODEL> <SESSION_ID> [PROMPT]
```

`codex exec resume` takes `-c 'sandbox_mode="read-only"'` instead. The wrapper
exits 0 while codex itself errored, so the failure is silent unless the output
file is checked — it was zero bytes. Round 2 was re-dispatched with the correct
flag. `codex-cli 0.153.2`.

**Verdict:** ACCEPT — a flag correction, no plan impact. Durable lesson for
step 8: record the flag difference, and always check the resume's output size
before reading a verdict from it.

---

## D4 — The Codex stop-gate hook demands gate evidence from a read-only plan review

Round 1's session was told to write nothing and implement nothing. On finishing,
`.codex/hooks/stop-gate.sh:28` demanded a green `.feature/gate-status.json`
because `.feature/intake.json` exists. The hook does not distinguish a read-only
plan review from completed implementation. The session correctly refused to run
`verified-gate.sh` (which writes logs, gate status and a fingerprint, and can
advance workflow phase) and returned its verdict anyway, so no evidence was
forged and no phase moved.

**Verdict:** ACCEPT — the reviewer's refusal was the right call and the round
completed. Durable lesson for step 8: a read-only reviewer session inside an
armed worktree trips the stop gate; brief it to ignore the demand, as round 2's
brief now does.
