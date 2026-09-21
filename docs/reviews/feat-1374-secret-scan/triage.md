# Review triage — feat/1374-secret-scan, round 1

Reviewed SHA `e2c3ac36e53b3a968b52c3129538a4ff3adf12ef`, merge-base `75c8d54cb77ac34d1f2f7686b9171528871b81f3`.
Measured production diff (tests excluded): code/config 285 added; docs 475 added / 17 removed. RISK = normal;
the diff is above the 300-line threshold, so the standards axis joined the wave. No red-team member: the
signed-off intake is normal risk and `red-team-status.mjs` records the waiver. Wave: spec-correctness
(+ security lens), standards-maintainability. Both: REVISE. The per-finding JSONL transcript
(`review-log.mjs`) was not populated; this file is the record.

| Finding | Sev | Verdict | Reason |
|---|---|---|---|
| Spec F1 — the pass branch trusts `[]` on stdout; gitleaks 8.30.1 exits 0 with `[]` when its `git log` writes to stderr | P1 | ACCEPT | Reproduced by the reviewer: a real finding in the range passed green. This breaks the intake invariant "a gate that cannot see never passes". Fix: a pass needs exit 0 AND `[]` AND gitleaks' own scanned-commit count equal to the range count AND no git error on stderr. |
| Spec F2 · Std F2 — the path allowlist disables EVERY rule in six live test suites | P1/P2 | ACCEPT | Violates `invariants[4]`. Reproduced: a fake private key in `send-email.test.ts` exits 0 as shipped, 1 with `targetRules = ["generic-api-key"]`. All 16 real false positives in those files are `generic-api-key`. One line. |
| Spec F5 · Std F4 — the printed count is the range count, defaults to 0 on `rev-list` failure | P2/P3 | ACCEPT | A failed count is a failure (fail closed); the printed number is gitleaks' own. Same mechanism as F1. |
| Spec F6 — a secret introduced only in a merge resolution is never scanned | P2 | ACCEPT if expressible | Test `--log-opts` variants (`-m`, `--cc`, `--first-parent`) in a scratch repository. If one scans merge diffs, use it; if none does, state the limit in the script header and the runbook. |
| Spec F7 — the fake's "clean" default equals the real failure shape; no test asserts exit status or the report flags | P3 | ACCEPT | Tests assert `--report-format json`, `--report-path -`, and the exit-status handling of F1. |
| Spec F9 · Std F3 — `origin/main` hardcoded; `merge-ledger-audit.ts` `baseRefFor()` already owns the base ref | P3 | ACCEPT | The intake names that file as the precedent; `weakened-checks-audit.ts` already imports it. A `staging`-based PR otherwise scans commits it did not author. The default stays `origin/main`, so the locked test title holds. |
| Spec F3 — audit C1 step 3 marked DONE; the runbook Scope is untouched and five rotated keys have no procedure | P2 | ACCEPT | Mark step 3 partial and say what is missing. Writing five rotation procedures is outside this ticket. |
| Spec F4 — `REDIS_QUEUE_TOKEN` is not an Upstash token; "still-live value" is unsupported | P2 | ACCEPT | `.env.example` and `deployment-guide.md` say the queue is on Railway Redis. Rows name the real variables and say "value exposed in `keys.md`", not "still-live". |
| Std F1 · Spec false-claim 6 — "the same gitleaks release installed locally": no local pin exists | P2 | ACCEPT | Make the text true: CI pins 8.30.1 by sha256; the local install is unpinned Homebrew. The script prints `gitleaks version` so a drift is visible in the hook output. |
| Spec F8 — the drill is not reproducible from the runbook alone | P3 | ACCEPT | Describe how to CONSTRUCT the fake value (shape and length, assembled at run time) — never a literal — plus the gitleaks version and the install command. |
| Std F5 — `ScanOutcome.message` exists only for tests | P3 | ACCEPT | Tests read the injected `log`; one producer, as the `AuditReport` + `emit` precedent. |
| Spec false-claim 7 — `.gitleaks.toml` "this allowlist cannot hide a real leak" | — | ACCEPT | True once the path block carries `targetRules`; reword to cover both blocks. |
| Spec F10 — the wiring test title says "lint CI", the check is ci.yml-wide | P3 | REJECT | Follows the `ci:admin-contract` precedent three lines above it; the reviewer verified the assertion reddens on all three removals. The title is locked by the intake. |
| Std F6 — the file name breaks the `*-audit.ts` convention | P3 | REJECT | The reviewer confirmed zero mechanical cost. A rename changes two locked surface entries — a second surface amendment, which is an abort criterion — for a naming gain. Named debt in the change ledger. |

# Round 2 (verification-only) — fix commit `8092131a4456e4620becf60d0f65a730c127b139` (superseded, see N1)

One Claude verification agent (`round-2-verification.md`): 12/12 accepted findings ADDRESSED, the round-1 P1 is
closed against its own reproduction, 31 doc claims checked (29 TRUE, 2 FALSE). 24 false-pass / false-fail
experiments in scratch repositories. REVISE on defects the fixes introduced.

| Finding | Sev | Verdict | Reason |
|---|---|---|---|
| N1 — the branch fails its own gate: the drill paragraph writes a literal PEM `BEGIN`/`END` pair and gitleaks reports `private-key` in commit `8092131a4` | P1 | ACCEPT | A false positive, and proof the scan is live. Reword the recipe so neither marker is a literal. Because the scan reads COMMITS, a later commit cannot clear it: the unpushed fix commit is rewritten so the pair never enters the branch history. |
| N2 · N3 — false FAIL on a line-deletion-only commit and on a revert; the test locks the wrong model in | P1/P2 | ACCEPT (owner decision 2026-09-21: lower bound) | The exact count match was wrong twice and blocks honest pushes. New rule: FAIL when gitleaks scanned FEWER commits than the number of commits that add text lines — gitleaks always counts those and may count more. The stderr git-error check stays the first defense. |
| N4 — a file marked `-diff`/`binary` in `.gitattributes` is invisible to gitleaks, so a key in it passes | P2 | ACCEPT as a documented limit | A gitleaks limitation, not fixable in the script without modelling attributes. Stated in the script header and the runbook. |
| N5 — the false "gitleaks counts only commits that ADD a line" measurement is recorded in three durable places | P3 | ACCEPT | Corrected together: script header, ledger paragraph, deviations file. |

Round 3 is this branch's last branch round (cap three): one verification agent on the round-3 fix hunks.
