# Deviations — feat/1013-refusal-policy-gate-held

Every entry here is something the plan did not anticipate. Step 6 reads this
file end to end and logs a one-line verdict per entry. The `reviewed`
transition parses it and refuses on any entry without a resolved
**Verdict:** ACCEPT.

---

## D1 — surface overlap with the parked `feat/refusal-log` worktree

**Raised:** step 2 setup, 2026-08-31. `scripts/feature-setup.sh` reported one
code-pair overlap on `src/lib/refusals/vocabulary.ts` against
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-refusal-log`.

**What it is.** `feat/refusal-log` is the PARKED parent-effort branch. Its HEAD
commit is `fcea7a5f docs(feature): handoff — mark the run STOPPED, point at map
 #994`. Map #994 replaced it, and `main`'s `src/lib/refusals/vocabulary.ts`
already states that its six lane-map values were "harvested verbatim" from that
branch. The branch will never merge, and its worktree is clean.

**Why no coordination is owed.** A merge order exists only between branches that
both land. This one does not land. Narrowing either surface would buy nothing
and would cost this slice the file it must edit.

**Action taken.** None. Recorded here so the overlap warning is not read as an
unresolved collision by a later session or a review agent.

**Verdict:** ACCEPT

---

## D2 — surface amendment 1: the `AutoApprovalBlockReason` declaration move

**Raised:** step 3 design pass, 2026-08-31, BEFORE the plan was written.
**Counted:** `scripts/feature-state.sh incr-amendment` → `surfaceAmendments=1`.
**Approved by the owner** in session, 2026-08-31.

**What the intake missed.** `POLICY_GATE_HELD_REFUSAL_CATEGORIES` must be typed
`satisfies Record<AutoApprovalBlockReason, RefusalCategory | null>`, so
`src/lib/refusals/vocabulary.ts` has to NAME that union. The union is declared in
`worker/jobs/response-generation/auto-approval.ts:37`. Verified at HEAD: **zero**
production modules under `src/lib/` import from `worker/`. The intake locked a
surface that could not express the map it promised.

**Precedent, applied twice already.** `src/lib/shared/worker-types.ts:121` holds
`AutonomySuspensionTrigger` and `:150` holds `AutoPolicyDowngradeReason`, both
moved out of their worker modules for this exact reason, and `:128-140` states
it in those words. The worker module keeps the BEHAVIOUR and imports the
declaration back.

**Three files added to `allowed_edit_surface`:**

* `src/lib/shared/worker-types.ts` — the declaration lands here.
* `worker/jobs/response-generation/auto-approval.ts` — imports it back.
* `worker/jobs/response-generation/__tests__/auto-approval.test.ts` — one import
  repointed. It is the only other reader;
  `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:988`
  mentions the name in a COMMENT and imports nothing.

**No re-export shim.** `working-rules.md` bans one without a named external
consumer, and #1012 already verified and recorded that finding for
`AutoPolicyDowngradeReason`. The single test consumer repoints instead.

**Rejected alternative:** `vocabulary.ts` importing `worker/` directly. It is
`import type` and would erase at compile time, so it breaks no bundle — but it
would be the first production `src/lib/` → `worker/` import in the repo and
contradicts the rule both prior moves exist to protect.

**Verdict:** ACCEPT

---

## D3 — a stale sentence in `src/lib/shared/worker-types.ts`

**Raised:** step 3 design pass, 2026-08-31, while reading the D2 precedent.

**The defect.** `worker-types.ts:135-137` says
`worker/jobs/publisher/auto-policy-downgrade.ts` "still owns the BEHAVIOUR and
**re-exports** this type, so its callers are unchanged". It does not.
`auto-policy-downgrade.ts:16-23` states the opposite and gives the reason:
"it is **NOT** re-exported — nothing outside this file has ever imported it
(verified at the merge base and at head), and `working-rules.md` bans a
compatibility shim with no named external consumer." The `auto-policy-downgrade.ts`
comment is the later correction; the `worker-types.ts` sentence was not updated
with it.

**Why this branch fixes it rather than leaving it.** T2 writes a NEW docblock on
`AutoApprovalBlockReason` directly beneath, citing that same paragraph as its
precedent. Citing a false sentence propagates the defect into a third
declaration. The file is already in the surface under D2, so the correction costs
one edit and no new surface.

**Scope bound.** The correction is limited to the one false clause. No behaviour
changes, and `AutoPolicyDowngradeReason` itself is not touched.

**Verdict:** ACCEPT

---

## D4 — AUTHORITY RULING: the flag-off `policy_gate_held` lane writes nothing

**Raised:** step 1 grilling, 2026-08-31. **Decided by the OWNER in session**,
2026-08-31, choosing "Keep the narrowing" over two alternatives. Recorded here as
a formal ruling because codex plan round 1 (finding F1, HIGH) correctly observed
that a decision contradicting a CLOSED ticket needs one.

**What two closed rulings claim.** #1013's "Volume" section and #1003's
"Operational consequence for #1001" both state: with the `AUTO_APPROVAL_ENABLED`
kill switch off, **every** generated draft on a policy-configured account writes
an `autonomy_paused` row.

**Why the code cannot do that.** Verified at HEAD:

1. The flag off makes `auto_approval_disabled` a STRUCTURAL gate —
   `STRUCTURAL_GATES[0]` is `[(input) => !input.runtimeEnabled,
   'auto_approval_disabled']` (`worker/jobs/response-generation/auto-approval.ts:286`).
2. So `isAutoApprovalCandidate` returns false for every draft
   (`auto-approval.ts:309-311`, called at `persist.ts:105`).
3. So `resolveAutoApprovalDecision` returns `runtimeState: null` and reads no
   policy row at all (`persist.ts:275-279`).
4. #998's narrowing needs `runtimeState.effectivePolicy.threshold !== null`
   (`persist.ts:563-565`).

"On a policy-configured account" is therefore **unknowable** on the very path the
claim describes. Migration 074's own header states the short-circuit is
deliberate: "safe ONLY while AUTO_APPROVAL_ENABLED is off — persist.ts
short-circuits structural non-candidates before any 074-column read (no policy
SELECT, no runtime-state projection)".

**The ruling.** #998's narrowing is inherited VERBATIM. A structural
non-candidate writes no `policy_gate_held` row. The two prose claims above are
FALSE against this code and are corrected on this branch; neither is implemented.

**Rejected alternative 1 — add a policy SELECT for non-candidates.** It would
honour #1003's wording literally, at the price of reversing migration 074's
documented short-circuit and adding a read to every generated draft while the
flag is off. Rejected by the owner.

**Rejected alternative 2 — move `auto_approval_disabled` into the veto set.**
Cleaner in isolation, but it reverses #998 on a member and would need a
`vocabulary_version` decision. Rejected by the owner.

**`auto_approval_disabled` is NOT dead weight in the precedence list.**
`isAutoApprovalCandidate` reads the flag before the transaction
(`auto-approval.ts:310`) and `evaluateAutoApprovalCandidate` reads it again
inside (`auto-approval.ts:360`). A flip between the two yields `blockReasons`
carrying `auto_approval_disabled` with a REAL `runtimeState`. That is the
member's only live path, and test title 26 pins it.

**Codex F1's second half is REJECTED, and the reason is recorded.** F1 asked for
a durable monitored counter for flag-off exclusions, on the grounds that the
ledger cannot distinguish "no decision" from "the lane was excluded". The
distinction is real. A counter is still wrong here:

* `AUTO_APPROVAL_ENABLED=false` is the DELIBERATE, DOCUMENTED pre-launch
  production state — the design doc's §8.4 ordered go-live turns every autonomy
  flag on later — so an alert on it would fire continuously on the intended
  configuration.
* The signal that the LEDGER is dark already exists and is a different fact:
  `REFUSAL_LEDGER_ENABLED`'s once-per-episode warning
  (`src/lib/refusals/write.ts`).
* Auto-approval observability is not this slice's to own. #1013 records a
  decision; it does not instrument the gate.

**What IS accepted from F1:** the intake's reconciliation bullet was vacuous as
written. It now states explicitly that the query is meaningful only with
`AUTO_APPROVAL_ENABLED` ON, that both sides are zero by construction otherwise,
and that a green flag-off reconciliation is never evidence.

**Verdict:** ACCEPT

---
