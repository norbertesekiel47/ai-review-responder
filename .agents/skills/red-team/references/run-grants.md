# Red-team budget grants — closed runs

History, not rules. Each entry below is an owner-approved, branch-pinned
extension to the red-team launch or round budget, moved verbatim out of
`SKILL.md` on 2026-09-18 so a new feature's red-team pass does not load five
closed campaigns. Verified on main at that date: #1185 merged as #1229; Run C,
Run D and Run E were closed by #1279, #1292 and #1294; the Operator Fallow
branch no longer exists and its review record is under `docs/reviews/`.

The runner (`scripts/mutation-runner.mjs`) and `red-team-status.mjs` enforce
every grant by exact branch, SHA and authorization id. Nothing here applies to
any other branch, and nothing here raises the general limits in `SKILL.md`.

Every entry predates 2026-09-18, when the ordinary budget changed from 30
launches per round to 20 minutes of measured test time. Where an entry says
"other branches keep 30", read it as "other branches keep the ordinary budget".

Read this file only when working on one of the named branches, or as the
precedent when the owner approves a new grant. A new grant needs: the owner's
explicit approval of a concrete proposal, a runner change that pins it, and an
entry appended here.

**Owner-approved #1185 continuation (2026-09-09).** The existing 453-case
inventory exhausted round 1 after 30 launches. The runner recognizes only the
exact recorded approval on `feat/1185`, original head `0b374b6a`, round 1,
and that inventory. It permits at most 1,400 total supervised launches, without
resetting the 30 already spent. See `feat-1185-deviations.md` D3. Every other
branch/round keeps 30; timeouts, two mutations per test, restoration and
incomplete-status rules remain unchanged. This grants neither another round
nor acceptance of unmeasured coverage.

**Owner-approved Operator Fallow same-round continuation (2026-09-15).** Only `codex/operator-fallow-refactor`, under grant `operator-fallow-round-1-continuation-2026-09-15`, may continue round 1 from its restored 30-launch checkpoint to at most **1,500 cumulative supervised local launches**. Authority and the immutable admission manifest live in `docs/reviews/codex-operator-fallow-refactor/budget-extension-review.md`. The exact owner reply is recorded there; it approved the preceding concrete proposal, not a generic limit override. Preserve the 501-case historical inventory prefix and four exclusions; only the finite admission-pinned verifier case suffix may append. Every launch counts, including baselines and retries; 120 seconds per launch and two semantic mutants per canonical candidate still apply. Existing attempts count. This grants no new round, product changes, existing-assertion changes, risk waiver or global budget change. Admission and status checks must preserve old report/journal evidence, bind each result to its candidate/target/selector, reject aliases and resets, and leave unmeasured or inconclusive cases incomplete. Root finalization remains mandatory. Computer Use evidence is a separate requirement and is not waived by this grant.

**Owner-approved Run C next pass (2026-09-13).** On
`codex/owner-operator-run-c` only, authorization
`owner-run-c-budget-next-pass` permits round 2 to finish the unmeasured original
inventory and verify the accepted fixes, directly affected callers and scoped
verifier change, with at most 1,500 supervised local launches. The runner pins
the original report/inventory, corrected product baseline and next-pass HEAD;
the verbatim approval lives in the JSON sidecar. See
`codex-owner-operator-run-c-deviations.md` D1. Other branches keep 30 launches.
Timeouts, mutation limits, environment isolation, root restoration and
incomplete-status rules are unchanged. This grants no third round or
accepted-risk disposition.

**Owner-approved Run C fourth round (2026-09-13).** Only
`codex/owner-operator-run-c`, with the exact committed authorization
`owner-run-c-fourth-round-prompt-regression`, may open closed round 3 into
round 4, capped at **150 supervised local launches**. This covers the prompt
regression fix, its evaluators and the verifier safeguards in the finite path
set enforced by the runner. The admission report must retain the complete
historical round-3 evidence, the original 785 inventory identities and the
prior findings/authorizations; only new authorizations may append before
measurement. Committed admission Markdown must match its pinned historical
blob exactly. Final Markdown must retain those historical bytes as an exact
prefix, including trailing newlines, with fresh round-4 results appended.
Admission descends from `fb536c09711ec331262f5efc64ff42f066bec3ba`
and requires a clean committed tree. Every launch validates the committed
grant and HEAD; the first pins them before supervisor release, and later
launches permit only exact journaled mutations. Final reports append fresh
results while retaining the history; the status checker corroborates their
committed admission and matching launch journal. This grants no fifth round,
extra provider calls, accepted-risk disposition or exception to isolation,
restoration, timeouts, per-test mutation limits or incomplete-status rules.

**Owner-approved Run D second pass (2026-09-14).** Only
`codex/owner-operator-run-d`, round 2, may use the exact committed grant
`owner-run-d-second-pass-200` for at most **200 supervised local launches**.
Admission descends from corrected baseline
`bd23d56e542a825da1dc16b2c0375127ded2443c`; the finite supporting-path list,
committed intake amendment, original 226 inventory identities and complete
round-1 JSON evidence are checked. Only the exact owner grant may append to
that JSON before measurement; committed Markdown retains the original bytes
as a prefix. The first launch pins HEAD and grant before supervisor release;
each subsequent launch rejects drift and permits only journaled mutations.
Keep scratch files ignored or outside the worktree: untracked files also
block this scoped pass. Missing or malformed permission fails before the
first launch, and Run D cannot open or launch a third round, including when
the approval text says “no third round.” Fresh report results append while
preserving all prior evidence. Isolation, root finalization, timeouts,
per-test mutation limits and honest incomplete statuses remain required.

**Owner-approved Run E second pass (2026-09-15).** Only
`codex/owner-operator-run-e`, round 2, may use the exact committed grant
`owner-run-e-second-pass-1600` for at most **1,600 supervised local launches**.
The corrected code baseline is
`54cb1a05e82de192355e379b7eb7b76182189306`; the original measured head remains
`890eea76c8c04b8d2acfcc73a895ec3112560e38`. Original reports were published
unchanged in a separate pinned history commit after the code correction.
Admission checks their exact hashes, all 2,113 ordered inventory identities,
complete historical evidence, finite supporting paths, and the exact intake
amendment. The grant covers 707 unmeasured original cases, the Restore fix and
directly affected callers, and finite verifier safeguards; the cap is not a
coverage waiver. Every launch pins/revalidates committed HEAD and grant, rejects
untracked or unjournaled drift, and spends the same bounded counter. Run E
cannot open, launch or certify a third round, even when permission text contains
“no third round.” The checker corroborates the closed journal and immutable
admission history. Final JSON keeps `authorizations: []`: the exact completed
execution grant stays in permanent admission history, with no risk waived and
no separate report-format approval required. The approved supporting alert work
includes staging configuration/readback; delivery is not claimed without a
drill, and production configuration is required before future enablement. This
grants no production Operator enablement, external provider calls, external
Claude/Opus delegation, other-branch budget changes, or relaxation of isolation,
timeouts, per-test mutation limits, restoration or incomplete-status rules.

**Run E same-round discovery correction.** The approved proposal expressly permits root adjudication of a required correction
after admission within the same round and cap. One continuation preserves the closed 124-launch checkpoint from
`b6ee3973b3e0ad9f6749f02c5428e6b4980cf837`, all original attempts and the unchanged `budgetAuthorization` pin. Before launch
125, the runner records one successor HEAD and checkpoint digest; subsequent launches require that same pin and the exact
historical journal prefixes. No counter reset, second successor, third round, product change or intake/history rewrite is
admitted by that discovery continuation. The finite source-correction manifest and checkpoint live in the existing
budget-extension review document. Original discovery evidence remains intact. Only independently reviewed cases outside the
changed behavioral contract may be reclassified; unresolved cases remain incomplete. A case's two-mutation limit spans both
pins, and changed verifier cases need fresh successor measurements. Migration 121's executable regression is in scope because
that test reads and executes the SQL during its body; its existing finally restores the five constraints, and readback must
confirm restoration. This does not change the general exclusion for migrations provisioned before a test.

**Run E finite corrective admission.** The same owner-approved post-admission correction clause permits the root-adjudicated
fixture correction after the `9f20dbecd2ce302494088a49cc3147bca96a3f27` continuation. It requires a new frozen, closed
checkpoint and the exact corrected test blobs, six existing verifier support paths and two append-only review/deviation
documents. Both earlier pins, all journal prefixes, original evidence and the existing grant remain unchanged. A separate
`correctiveAdmission` pins the candidate before checkpoint launch N+1. Its first baseline is clean; later launches require
that exact candidate and matching journaled mutations. That corrective pin admits no further successor. Ancestry and pin checks prevent
stripped journals, branch renames and report-round downgrades from reaching a generic allowance or a report waiver. Round 2,
1,600 cumulative launches and at most two mutants per original case remain the limits across all pins. Changed contracts need
fresh measurements within those limits; exhausted or unresolved cases remain incomplete. New safeguard identities are
appended, never aliases for exhausted existing cases. The checkpoint constants must stay fail-closed until the root freezes
the pass, reviews the exact final correction set and admits the verified committed candidate. **Finite staging diagnostic admission:** root adjudication additionally preserves the closed 776-launch checkpoint and all three pins, retaining exactly the reviewed 690a8792 diagnostic product/test blobs and incident document. One separate `stagingCorrectionAdmission` pins the final support candidate before launch 777; its frozen completed report, journal prefixes, exact surface, clean first baseline and later journaled mutations are checked. No further staging successor or generic budget is admitted. Intermediate staging diagnosis has only its recorded focused/build/pre-push evidence and stale red-team status; final certification requires the new exact proof, full gate, unchanged 1,600 cumulative cap and two mutants per original identity. Preserve old reports and findings, append genuine new identities, and never count a recovery on a new turn as proof that the earlier failed turn succeeded.
