# Pathfinder 2026-08-15 — process findings (adjudicated)

Verdicts: **CLOSED** · **FIX** (needs a ticket) · **PROTOCOL** (a rule changes) ·
**DEFER**.

## Headline

**The prior pass's prescriptions were executed — all six, for the first time in
this log's history.** H1–H6 each trace to a merged PR. The 2026-08-10 pass
concluded "the code held its shape; the entropy was in the workflow layer," and
that verdict survives a second window: health 77 B → 77 B, maintainability 92.2 →
92.2, duplication **1.3% → 1.1%**, churn hotspots 0 → 0, across six more merges.

But the workflow layer produced a new failure mode this window, and it is the
inverse of the old one. The old failure was *prescriptions not being executed*.
The new one is **the surface a prescription targets being deleted by a change
the counter does not see.**

---

## 1. Prior-pass handoffs — **CLOSED**

| Handoff | Shipped | Evidence |
|---|---|---|
| H1 — #757 KPI one-stack | YES, one recorded deviation | PR #793 (`17f60e2c`); `kpi/fragments.ts:44`,`:56` |
| H2 — imported-row hash bug | YES | PR #785 (`1ab449f3`); `zernio-ingest-shared.ts:496` |
| H3 — `STRUCTURAL_GATES` (invariant #3) | YES, under the prescribed name | PR #816 (`923fe08c`); `auto-approval.ts:285`,`:301` |
| H4 — one-owner sweep (3 parts) | YES, all three | PR #788 (`c8bbb39e`) |
| H5 — mechanical bundle (~13 seams) | YES, every symbol resolves | PR #815 (`9765e7a3`) |
| H6 — doc-truth sweep | YES | PR #787 (`2ff412a0`) |

H1's residue — P1 asked for four KPI fragments, two were extracted because the
other two had zero composers after Stack A's deletion — is an owner-adjudicated
deviation (D3 / ADR 0019). **This pass confirms it agrees:** extracting a
fragment with no composer would have been dead code.

## 2. Sweep-miss mechanization — **CLOSED**

`.claude/skills/document-feature/SKILL.md:41` carries the mandated
`arch-review-log.md` row, with a worked example at `:69` and a rationale section
at `:74` written specifically to stop a future editor tidying it away. Landed in
**PR #823**.

Provenance of this window's six increments:

| PR | Sweep commit | Written by |
|---|---|---|
| #793 | `209f0cc7` | by hand (pre-mechanization) |
| #805 | `9690f201` | by hand (pre-mechanization) |
| #821 | none — inside the feature commit | by hand |
| #827 | `682681ab` | **by skill** |
| #831 | `7020d34e` | **by skill** |
| #833 | `0a379fb7` | **by skill** |

The last three are uniformly titled `docs: post-merge sweep for #NNN` — a shape
absent before #823 — and `682681ab` is a pure two-file sweep matching the skill's
table exactly. Counter arithmetic is unbroken 0→6. **The class that claimed
#712, #716, #746 and #821 is closed.**

## 3. An uncounted PR deleted the surface three prescriptions targeted — **FIX** (new, high)

**PR #803** — *"chore: optimize Codex agent configuration"*, `0e1a5d41`,
2026-08-12 — rewrote `.agents/skills/feature/SKILL.md` from **667 to 207 lines**
(+187/−480), replacing the 8-step workflow with a 0–7 workflow that ends at
*"Stop at review-ready."* **Step 8 no longer exists.** Shipping moved to
`references/shipping-boundaries.md`, an authorization checklist, not a procedure.

Three separate architecture-pass prescriptions were aimed at step 8:

- the **fallow preflight** (2026-08-10 §5) — never shipped; target now gone
- the **staging-reconcile correction** (carried since #647, six occurrences) —
  the *wrong* instruction was deleted, but the correct one was **not substituted**
- the **arch-log increment** — survived only by luck, because #823 had relocated
  it into `document-feature` four days earlier

`#803` is **not counted** in the entropy log (`grep -c "PR #803"` → 0). By
product surface that is defensible — zero runtime lines. By *workflow*
architecture it removed 480 lines of the process this log exists to govern.

**Verdict:** the counter measures product entropy and is blind to workflow
entropy. Two options for the owner:

1. Count workflow-surface changes (`.agents/skills/**`, `.claude/skills/**`,
   `scripts/verify-gate.sh`, `lefthook.yml`) in the same counter; or
2. Keep the counter product-only but require the `document-feature` sweep to log
   workflow-surface changes as a separate, non-incrementing note.

Option 2 is cheaper and preserves the counter's meaning. Either beats the status
quo, where a 480-line deletion of the ship procedure left no trace.

## 4. Staging reconcile — **PROTOCOL**

The instruction that could never work (`git merge --ff-only main` after a squash
merge) is gone with step 8. Nothing replaced it. The correct procedure — verified
tree-equality, then `reset --hard origin/main` + `--force-with-lease` — now lives
only in `.claude/CLAUDE.md` and `docs/runbooks/deployment-guide.md`, and
`references/shipping-boundaries.md:15` lists "push or reset the staging branch"
as an authorized action **with no method attached and no pointer to either doc**.

Six recorded occurrences (#647, #654, #659, #682, #685, #691). **Fix:**
`shipping-boundaries.md:15` names `deployment-guide.md` §"Re-sync staging"
explicitly. One line.

## 5. Phase rewind — **FIX** (still live, and the apparent fix does not fix it)

`scripts/verify-gate.sh:410-415` still calls
`bash scripts/feature-state.sh set-phase gate_green` on success, guarded only by
"an armed feature run exists" — never by the current phase. `feature-state.sh:52-60`
validates the token then writes unconditionally.

**The trap for the next reader:** PR #803 added
`.agents/skills/feature/scripts/transition-state.mjs` with a real transition
matrix, which *looks* like the fix. It is not, twice over — `verify-gate.sh:414`
shells straight to `feature-state.sh` and bypasses it, **and** the matrix
explicitly permits `reviewed → gate_green` anyway.

Running total: **seven occurrences across five features** (#675, #677 ×2,
#757 ×2, #821 ×3). Prescribed twice, unshipped twice. **Fix:** the gate records
`lastGreenGateSha` and stops writing `phase` at all.

## 6. `reclassify` counts specs as production — **FIX** (still open)

`scripts/verify-gate.sh:316-330` excludes exactly two globs —
`docs/superpowers/plans/*` and `docs/reviews/*`. **`docs/superpowers/specs/**` is
on neither list** and does not match the test-bucket regex, so it lands in
`PROD_ACTUAL`. Live: #833's own sweep edited a spec (+19 lines) that a non-docs-only
run would have charged against `estimated_prod_lines`.

Mitigating: `reclassify` emits **WARN**, not FAIL (`:344`,`:351`; `PASSED` flips
only on FAIL at `:378`). This is trust erosion in the row, not a blocker — which
is precisely why it has survived three windows. One glob closes it.

## 7. "Prescribed fix falls outside what the discovering change may legally touch" — **PROTOCOL** (third instance; structural answer below)

The class the `#833` entry called "well-evidenced enough to be worth a structural
answer." It is actually **two** classes wearing one name, and they need different
answers:

**7a — Illegal by architecture.** #833's `OVERVIEW_AT_RISK_LIMIT` was spec-locked
to `src/app/admin/page-sizes.ts`; `APP_LEAF_IMPORT_BAN` forbids `src/lib/**` →
`@/app/**`, so the prescribed location could never have worked. The spec was
wrong when written. **Answer:** a spec that names a file location for a shared
constant gets that location checked against the import bans *at authoring time*.
Cheap, mechanical, catches this before implementation discovers it.

**7b — Legal but outside the locked surface.** #821 and #827 (`.claude/skills/**`,
`config/server.ts`). The fix is legitimate; the branch may not touch it. #821 had
already spent four owner-approved amendments, so the prescription was recorded and
deferred — and the arch-log mechanization then **survived two architecture passes
unapplied** until a separate docs PR (#823) landed it.

**Answer:** the transferable lesson is already in the log — *it took a separate PR*.
So when a fix falls outside the locked surface, the deliverable should be **an
opened issue, not a note in a log**. The evidence that notes do not survive is
this file's own §2: the same class claimed four features while the fix sat in
prose. Recommend `document-feature` gain a rule — an out-of-surface prescription
discovered during a feature ships as an issue in that feature's sweep PR.

## 8. Text-scan audits — **FIX** (census complete)

**10 AST-based** (`db-imports`, `dropped-columns`, `live-db-suites`,
`outbox-seam`, `outbox-status`, `outbox-topics`, `process-env`,
`response-status`, `reviews-status`, `static-policy`) · **7 text-based**
(`admin-aal2`, `agent-config`, `analytics-events`, `config-coverage`,
`feature-surface`, `rls-audit`, `tenant-scope`) · 2 external (`fallow`).

`rls-audit`'s text nature is unremarkable — it reads `.sql`. The two carrying
real security weight are **`ci:admin-aal2`** (the only MFA-binding check — see
`02-duplication-report.md` §C1 for its three verified holes; handoff **H3**) and
**`ci:tenant-scope`** (a hand-rolled SQL scanner). H3 converts the first.
`ci:tenant-scope` is **DEFER** — no defect found this pass, flagged so a future
pass knows it is a hand-rolled parser guarding tenant isolation.

## 9. "How many older guards pass for the wrong reason?" — **ANSWERED: 15**

The `#833` entry asked. Full census in `06-guard-integrity.md`; remediation is
handoff **H1**. Summary: 15 confirmed by mutation against the full 862-file
suite, 5 of them on invariant #3's gate chain sharing one root cause. 40 of ~55
mutations were correctly killed — the suite is mostly sound.

~~The mirror class — correct tests that no gate runs because they are live-DB
only — is handoff H6 and may be the larger problem.~~ **REFUTED on execution
(H6, same day):** CI's `test` job runs the live-DB lane and has since #244
(`ci.yml:182-212`; 91 integration suites measured on run `31907581265`). The
observations held; the conclusion misread `pnpm test:integration`'s local
one-suite list as CI's coverage. H6's real finding: that gate was **unpinned** —
now pinned in `ci-audit-wiring.test.ts`. See `06-guard-integrity.md` for the
full correction.

## 10. Counter reconciliation

**Six is correct as a product-entropy count**, and the two flagged exclusions are
sound: #830 (marketing copy, zero structural surface) and #822/#819/#817 (docs).
This pass **adds** #803 to the record as a *workflow*-surface change that was
correctly excluded from the product counter and should not have gone unlogged
(§3).

**Reset to 0** on completion of this pass.

---

## Ticket summary

| # | Verdict | Item | Handoff |
|---|---|---|---|
| 1 | CLOSED | Prior-pass handoffs H1–H6 all shipped | — |
| 2 | CLOSED | Sweep-miss mechanization works | — |
| 3 | FIX | Workflow-surface changes invisible to the counter | new |
| 4 | PROTOCOL | `shipping-boundaries.md:15` names the staging runbook | new (1 line) |
| 5 | FIX | Gate stops writing `phase`; records `lastGreenGateSha` | carried ×2 |
| 6 | FIX | `reclassify` excludes `docs/superpowers/specs/**` | carried ×3 |
| 7 | PROTOCOL | 7a spec locations validated vs import bans; 7b out-of-surface fixes ship as issues | new |
| 8 | FIX / DEFER | `ci:admin-aal2` → AST (H3); `ci:tenant-scope` noted | **H3** |
| 9 | FIX | 15 guards passing for the wrong reason | **H1** |
| 10 | — | Counter reset to 0; #803 logged as workflow-surface | — |
