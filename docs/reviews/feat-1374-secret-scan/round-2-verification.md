# Round 2 — verification review, `feat/1374-secret-scan`

Branch round 2. VERIFICATION ONLY: each ACCEPTED round-1 finding is checked against the fix
commit, plus defects the fixes introduced. New observations against unchanged code are in the
appendix, untriaged.

- ROUND1_SHA `e2c3ac36e53b3a968b52c3129538a4ff3adf12ef`
- FIX_HEAD `8092131a4456e4620becf60d0f65a730c127b139`
- MERGE_BASE `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- Fix commit: `8092131a4 fix(1374): review round 1 — an empty gitleaks report is a pass only when the scan covered the range`
- Tooling used: local `gitleaks 8.30.1` (`/opt/homebrew/bin/gitleaks`), `git 2.54.0`.
  Every gitleaks invocation carried `--redact`. All experiments ran in `mktemp -d` scratch
  repositories outside the worktree; every key-shaped value was assembled at run time from
  `/dev/urandom` + `printf`-joined word fragments. No secret value appears in this report.

---

## 1. Per-finding verdicts

| Finding | Verdict | Evidence at FIX_HEAD |
|---|---|---|
| **Spec F1 (P1)** — pass branch trusted `[]` on stdout | **ADDRESSED** (with two new defects, N2/N4 below) | `scripts/ci/secret-scan.ts:284-347` is now a four-condition conjunction: report parses to a list (`:286`), length 0 (`:297`), `status === 0` (`:310`), no `ERR`/`FTL`/`fatal:` on stderr (`:318`, matcher `:216-220`), gitleaks' own `N commits scanned` present (`:327`) and equal to the git-derived count (`:337`). **Round-1 F1 reproduced and now fails closed**: scratch repo with a `.gitattributes` `diff=missingdriver` textconv pointing at a nonexistent binary and a complete PEM in the range → gitleaks exit 0, stdout `[]`, `ERR [git] fatal: cannot exec …`, `0 commits scanned`; script decision `FAIL:git-error` (and the count would also mismatch, 0 vs 2). |
| **Spec F2 · Std F2 (P1/P2)** — path allowlist disabled every rule in six suites | **ADDRESSED** | `.gitleaks.toml:52` `targetRules = ["generic-api-key"]` now sits on the path block (`:50-57`) as well as the value block (`:41`). Verified in a scratch repo: a run-time-built PEM at `src/lib/notifications/email/__tests__/send-email.test.ts` is reported (`rules=['private-key']`) while the co-located generic key is suppressed; the same file content at a non-allowlisted path reports `['generic-api-key','private-key']`. The 16-hit claim also holds: the six real fixture files scanned with the shipped config → **0** findings; with the path block deleted → **16**, all `generic-api-key`. |
| **Spec F5 · Std F4 (P2/P3)** — printed count was the range count, defaulted to 0 | **ADDRESSED** | `secret-scan.ts:259-267` fails closed when the `git log` exits non-zero (no silent `0`); the number printed on the pass line (`:346`) is `scannedCommits`, i.e. gitleaks' own. Test `scripts/ci/__tests__/secret-scan.test.ts:221-231` asserts both the message and `not.toMatch(/passed \(/)`. |
| **Spec F6 (P2)** — merge-resolution secret never scanned | **ADDRESSED** | `DIFF_MERGES_FLAG = '--diff-merges=remerge'` (`secret-scan.ts:103`) passed to both gitleaks (`:272`) and the count read (`:255`). Measured on a scratch evil-merge repo (PEM present in neither parent, added in the resolution): `-m` → 2 findings / 3 commits; `--cc` → 0 / 2; `-c` → 0 / 2; `--first-parent -m` → 1 / 2 (side branch dropped); `--diff-merges=remerge` → **1 finding / 3 commits scanned**, `Secret: REDACTED`, rule `private-key`. Exactly once, whole range covered — as the header and runbook claim. |
| **Spec F7 (P3)** — fake's "clean" default equalled the failure shape | **ADDRESSED** | `secret-scan.test.ts:39-46` `cleanGitleaksStderr(n)` now emits a real `N commits scanned.` line, and the default `gitleaks-scan` response (`:73`) is `{status:0, stdout:'[]', stderr: cleanGitleaksStderr(3)}` against a 3-commit `git-count` default (`:72`) — no longer byte-identical to a broken scan. Report flags asserted paired, not merely present (`:136-138`); exit status asserted at `:213-218`. |
| **Spec F9 · Std F3 (P3)** — `origin/main` hardcoded | **ADDRESSED** | `secret-scan.ts:86` imports `baseRefFor` from `./merge-ledger-audit`; used at `:228`. Import is side-effect-free: `merge-ledger-audit.ts` module scope is imports + `const` declarations only, and its `main()` is behind the same `process.argv[1]`/`import.meta.url` guard (last line of that file), so running `tsx scripts/ci/secret-scan.ts` never runs the ledger audit. Default is `origin/main` (`baseRefFor` returns `'origin/main'` for `undefined`), so the locked title "scans the commit range origin/main..HEAD with redaction on" is still honestly asserted — the test at `secret-scan.test.ts:123-139` runs with `env: {}` and asserts `--log-opts=… origin/main..HEAD`. |
| **Spec F3 (P2)** — audit C1 step 3 marked DONE | **ADDRESSED** | `docs/audits/2026-07-06-codebase-audit-findings.md:22` box is `[ ]`; `:24` states "steps 1, 2 and 4 are DONE or explicitly DECIDED; step 3 is PARTIAL" and gives the tick rule; `:44` step 3 is **PARTIAL** and names what is missing; `:193` the "Suggested fix order" entry is un-struck, reads **MOSTLY DONE**, and cross-references the checklist item. Cross-reference is consistent in both directions. The step-3 claim that `## Scope` still names only `ENCRYPTION_KEY`/`SESSION_COOKIE_SECRET`/`CSRF_SECRET` is **true** (runbook lines 6-10). |
| **Spec F4 (P2)** — `REDIS_QUEUE_TOKEN` "still-live" claim | **ADDRESSED** | All six rows now read "value exposed in `keys.md`", never "still-live". The two Redis rows name the real variables and their current status; both check out against `.env.example:29-30,36` and `deployment-guide.md` §1.4 (see §3 below). |
| **Std F1 · Spec false-claim 6 (P2)** — "same gitleaks release installed locally" | **ADDRESSED** | Removed from `ci.yml` (the comment at `:243-251` now says CI is the only pinned install and that the two can drift) and from the runbook ("**Version: CI is pinned, your machine is not**"). `secret-scan.ts:236-240` prints the local version beside `CI_PINNED_GITLEAKS_VERSION`; test `secret-scan.test.ts:100-110` pins that behaviour with a deliberately divergent `8.99.0`. `GITLEAKS_VERSION: 8.30.1` at `ci.yml:256`; no other pin exists anywhere in the repo (`git grep gitleaks -- lefthook.yml package.json` → one comment only). |
| **Spec F8 (P3)** — drill not reproducible | **ADDRESSED** (but see N1) | The runbook's "How to build the fake value" recipe was followed **literally** in a scratch repo: `-----BEGIN RSA PRIVATE KEY-----` markers `printf`-assembled from separate words, body `head -c 600 /dev/urandom | base64 | fold -w 64`, committed then deleted in a later commit → gitleaks exits **1**, one `private-key` finding, `Secret`/`Match` both `REDACTED`. Both sub-claims also verified: a 48-byte body is enough (finding fires); a `BEGIN` line with no `END` line is **not** detected (0 findings). |
| **Std F5 (P3)** — `ScanOutcome.message` existed only for tests | **ADDRESSED** | `secret-scan.ts:131-134` — `ScanOutcome` now carries `exitCode` only. No test references `.message`; every assertion reads the injected `log` via `recordingLog()`. |
| **Spec false-claim 7** — "this allowlist cannot hide a real leak" | **ADDRESSED** | `.gitleaks.toml:26-38` rewritten; it is true of **both** blocks ("EVERY allowlist in this file is scoped with `targetRules`… the path block below included"). Verified empirically in both directions (see Spec F2 row). One residual nuance in the appendix. |

### Locked-surface checks

- The **7 locked test titles** are present verbatim: `secret-scan.test.ts:90, 112, 123, 169, 185, 264`
  and `src/__tests__/ci-audit-wiring.test.ts:78`.
- **Mutation reasoning** for each new fail-closed branch (reasoned, not executed — no `pnpm` in this
  worktree): removing `:310` makes the `status: 2` test pass the conjunction → reddens; removing
  `:318` makes the ERR-stderr test (count already matches at 3) pass → reddens; removing `:327`
  makes the no-count test fall to the mismatch branch whose message lacks
  "did not report a scanned-commit count" → reddens on the text assertion; removing `:337` makes the
  0-vs-3 test pass → reddens; removing `:259` makes the count-unreadable test emit the mismatch
  message, which does not contain "commit count" → reddens. All five are genuinely load-bearing.

---

## 2. False-pass / false-fail experiments

All runs use the exact commands the script builds:
`git log --format=$'\x1e%H' --numstat --diff-merges=remerge <range>` for the expected count and
`gitleaks git --log-opts="--diff-merges=remerge <range>" --redact --no-color --config <cfg>
--report-format json --report-path - .` for the scan. "Script outcome" applies the four-condition
pass rule from `secret-scan.ts:284-347`.

| Case | Expected count | gitleaks count | Script outcome |
|---|---|---|---|
| normal add | 1 | 1 | PASS ✔ |
| empty commit (`--allow-empty`) | 0 | 0 | PASS ✔ |
| whole-file deletion (`git rm`) | 0 | 0 | PASS ✔ |
| **line-deletion-only (file survives)** | **0** | **1** | **FAIL: count-mismatch — FALSE FAIL (N2)** |
| **revert of a one-line add (2-commit range)** | **1** | **2** | **FAIL: count-mismatch — FALSE FAIL (N2)** |
| rename-only (100% similarity) | 0 | 0 | PASS ✔ |
| rename with edits | 1 | 1 | PASS ✔ |
| binary-only add | 0 | 0 | PASS ✔ |
| whitespace-only added lines | 1 | 1 | PASS ✔ |
| empty file added | 0 | 0 | PASS ✔ |
| mode-only change (`chmod +x`) | 0 | 0 | PASS ✔ |
| path with spaces + non-ASCII (`app/we ird — näme.txt`) | 1 | 1 | PASS ✔ |
| very large diff (20 000 added lines) | 1 | 1 | PASS ✔ |
| added lines only in a path-allowlisted file | 1 | 1 | PASS ✔ (count unaffected by allowlist) |
| CRLF file added | 1 | 1 | PASS ✔ |
| `.gitattributes` itself added | 1 | 1 | PASS ✔ |
| file under a `-diff` attribute added (no secret) | 0 | 0 | PASS ✔ |
| symlink-only commit | 1 | 1 | PASS ✔ |
| submodule add (`vendor/sub`) — 2-commit range | 2 | 2 | PASS ✔ |
| submodule pointer bump only | 1 | 1 | PASS ✔ |
| clean merge, no conflict (3 commits) | 2 | 2 | PASS ✔ |
| octopus merge (2 side branches) | 3 | 3 | PASS ✔ |
| `diff.renames=false`, rename-only | 1 | 1 | PASS ✔ (parity holds) |
| `diff.algorithm` = myers / histogram / patience, rename-only | 0 | 0 | PASS ✔ (parity holds) |
| root commit inside the range | n/a | n/a | Unreachable — `<base ref>..HEAD` can never contain the root commit; `git rev-parse --verify` gates it first |
| **evil merge: PEM added only in the conflict resolution** | 3 | 3 | FAIL: finding(1) ✔ (reported exactly once, REDACTED) |
| **F1 reproduction: broken `.gitattributes` textconv + PEM in range** | 2 | 0 | FAIL: git-error ✔ **(round-1 P1 closed)** |
| control: PEM + a normal file in one commit, no `-diff` | 1 | 1 | FAIL: finding(1) ✔ |
| **PEM + a normal file in one commit, `*.pem -diff` in `.gitattributes`** | **1** | **1** | **PASS — FALSE PASS (N4)** |
| real branch range `MERGE_BASE..FIX_HEAD` | 3 | 3 | **FAIL: finding(1)** — the branch fails its own gate (N1) |
| real 60-commit slice of main ending at FIX_HEAD | 60 | 60 | FAIL: finding(1) — same doc hit |
| unsupported `--diff-merges` value (stands in for git < 2.35) | — | — | FAIL closed, readable: `git log` exits 128 with `fatal: invalid value for '--diff-merges'`; the script prints "the commit count for … could not be read (git exited 128)" **before** gitleaks ever runs |

### What gitleaks 8.30.1 actually counts

Captured with a `git` shim on `PATH`: gitleaks runs exactly
`git -C . log -p -U0 <log-opts>` (plus one `git ls-remote --quiet --get-url`). It increments its
`N commits scanned` counter for a commit that yields **at least one hunk on a file that still
exists after the commit** — added *or removed* lines. It does **not** count empty commits,
whole-file deletions, 100%-similarity renames, mode-only changes or binary-only changes.
`countScannableCommits` (`secret-scan.ts:184-197`) models only `added > 0`, which is why
line-deletion-only commits diverge.

`--diff-merges=remerge` requires git ≥ 2.35 (Jan 2022); the header's "It needs git >= 2.35" is
correct. On an older git the **count read fails first** (it is issued at `:252`, before the gitleaks
call at `:270`), so the developer sees the fail-closed message plus git's own error text, not a
confusing count comparison. Fails closed, readably.

---

## 3. Doc-claim audit (sentences the fix commit added or changed)

**31 claims checked: 29 TRUE, 2 FALSE, 0 UNVERIFIABLE.**

TRUE (verified, not assumed) — a sample of the load-bearing ones:

- Runbook: range is `<base ref>..HEAD`; base resolved by `baseRefFor()` in `merge-ledger-audit.ts`,
  "the same resolver the merge-ledger and weakened-checks audits use" — both files import it.
- Runbook: CI pins **8.30.1** by sha256 via `GITLEAKS_VERSION` (`ci.yml:256`); no local pin exists.
- Runbook: the quoted first line of output matches the template at `secret-scan.ts:237-240`.
- Runbook: the quoted command shape matches the argv built at `secret-scan.ts:270-282`.
- Runbook: every `-m` / `--cc` / `-c` / `--first-parent -m` / `remerge` measurement — reproduced
  exactly (2/3, 0/2, 0/2, 1/2, 1/3).
- Runbook: gitleaks aborts on non-empty stderr from its own `git log`, prints `0 commits scanned`,
  `[]`, and exits 0 — reproduced.
- Runbook: all three drill-recipe claims (complete PEM detected + REDACTED; 48-byte body enough;
  `BEGIN` without `END` not detected).
- Runbook: an unscoped allowlist disables the whole default set for what it matches — the scoped
  direction verified both ways (0 findings with the path block, 16 `generic-api-key` without it).
- `.gitleaks.toml:26-38`: true of **both** blocks; a vendor rule (`private-key`) fires inside an
  allowlisted path; the 16 fixture hits stay suppressed.
- Rotation log: "`REDIS_CACHE_URL` (the token is embedded in the `rediss://…upstash.io` URL)" —
  TRUE (`.env.example:29`); "`REDIS_CACHE_TOKEN` … only for Upstash's REST form" — TRUE
  (`.env.example:30`, verbatim "Only needed for the Upstash REST URL (https://) form").
- Rotation log: "`REDIS_QUEUE_TOKEN` … the queue has since moved to Railway Redis and this variable
  is unused (`.env.example`, `deployment-guide.md` §1.4)" — TRUE (`.env.example:36`
  "Unused with Railway (no token)"; `deployment-guide.md` §1.4 heading "Railway for the queue
  (private networking), Upstash for the cache", and §"…queue moved to Railway…so it no longer burns
  Upstash commands/egress", which also supports the row's "Upstash queue credential at the time of
  the exposure").
- Audit C1: box unticked; step 3 PARTIAL; the `## Scope` claim; the "Suggested fix order" entry
  un-struck and consistent with the checklist item in both directions.
- `ci.yml:243-251` comment: every clause true.

FALSE:

1. **`scripts/ci/secret-scan.ts:43-54`, `.claude/reference/arch-review-log.md:3`, and
   `docs/superpowers/plans/feat-1374-secret-scan-deviations.md` — "gitleaks counts a commit only
   when that commit's diff contains at least one ADDED line" / "(measured: gitleaks does not count
   empty, deletion-only, rename-only, mode-only or binary-only commits)".** A commit that only
   *removes* lines from a surviving file **is** counted by gitleaks (measured 1) and is **not**
   counted by `countScannableCommits` (measured 0). Only *whole-file* deletions behave as claimed.
2. **`docs/runbooks/secrets-rotation-api-keys.md:180-185` — "assemble the `BEGIN`/`END` markers with
   `printf` from separate words, so no literal that looks like a key is ever typed, pasted, or
   written into this repo."** The same paragraph writes the literal `-----BEGIN RSA PRIVATE
   KEY-----` / `-----END RSA PRIVATE KEY-----` markers into the repo, and gitleaks' `private-key`
   rule matches across them — this is defect N1.

No literal key **value** appears in any changed doc: `gitleaks dir --redact` over a scratch copy of
the four changed docs + `ci.yml` + the deviations file returns exactly **1** finding — the
`private-key` false positive at `secrets-rotation-api-keys.md:180`, `Secret: REDACTED`.

---

## 4. Defects the fixes introduced

| ID | Sev | file:line | Finding |
|---|---|---|---|
| **N1** | **P1** | `docs/runbooks/secrets-rotation-api-keys.md:180-181` | **The branch fails its own gate.** The drill-recipe paragraph added by the fix commit writes a literal PEM `BEGIN`/`END` pair; gitleaks' default `private-key` rule matches across it. `gitleaks git --log-opts="--diff-merges=remerge 75c8d54c..8092131a" …` exits **1** with `{'RuleID': 'private-key', 'File': 'docs/runbooks/secrets-rotation-api-keys.md', 'StartLine': 180, 'Secret': 'REDACTED'}`. The same range at ROUND1_SHA was clean (`[]`, "no leaks found"), and `git log -S` attributes the text to `8092131a4` alone. Consequence: the lefthook `pre-push` hook blocks the push, ci.yml's `lint` job fails, and the worktree verify gate (which enumerates every `ci:*`) is red. No path allowlist helps — `private-key` is a vendor rule and the two allowlists are `targetRules`-scoped to `generic-api-key`. Fix needs a `gitleaks:allow` marker, a scoped allowlist entry, or splitting the markers in the prose. |
| **N2** | **P1** | `scripts/ci/secret-scan.ts:184-197` (model stated at `:43-54`) | **False fail on a line-deletion-only commit.** `countScannableCommits` counts a commit only when a `--numstat` row has `added > 0`; gitleaks counts any commit with a hunk on a surviving file, removals included. Measured: a commit deleting three lines from an existing file → expected **0**, gitleaks **1** → `FAIL: gitleaks scanned 1 commit(s) but <range> holds 0 scannable commit(s)`. A revert of a one-line add, in a two-commit range → expected **1**, gitleaks **2** → same failure. The review rubric names deletion-only commits as a must-not-fail case. Whole-file deletions and rename-only commits are fine; only the surviving-file removal shape diverges. Measured frequency on real history: **0 of the last 400 commits** on `main` (squash-merge workflow hides it), but a pre-push run scans the *unsquashed* `origin/main..HEAD`, where a "remove dead code" commit is ordinary. Correct predicate: count a commit when any row has `added > 0` **or** (`deleted > 0` and the path is not deleted by that commit). |
| **N3** | **P2** | `scripts/ci/__tests__/secret-scan.test.ts:286-306` | The test `does not count commits gitleaks will not scan (empty, deletion-only, rename, binary)` encodes N2's wrong model and locks it in: its `'\u001esha-deleted\n\n0\t7\tsrc/b.ts\n'` record is a **line** deletion on a surviving file, which real gitleaks counts. The suite therefore asserts the false-fail behaviour as correct, and a fix for N2 will have to change this test. |
| **N4** | **P2** | `scripts/ci/secret-scan.ts:337-344` (pass condition) / `.gitleaks.toml` | **Equal counts do not prove coverage.** A file marked `-diff` (or `binary`) in `.gitattributes` is invisible to *both* sides — `--numstat` reports `-`/`-`, and gitleaks' `-p -U0` emits "Binary files differ" — so a complete PEM committed alongside one ordinary text file yields expected **1**, gitleaks **1**, exit 0, `[]` → **PASS with a real key in the range**. The identical commit without the attribute fails correctly. This is a gitleaks-level limitation rather than something the fix created, but it falsifies the new contract's implicit claim that count equality means the range was scanned, and it is a one-line bypass for anyone who wants one. |
| **N5** | **P3** | `.claude/reference/arch-review-log.md:3`; `docs/superpowers/plans/feat-1374-secret-scan-deviations.md` (round-1-fixes entry); `scripts/ci/secret-scan.ts:43-54` | The "measured" deletion-only claim is false in three places at once (see §3 FALSE #1). Because the ledger and the deviations file are the durable record, the wrong model will outlive the code unless all three are corrected together. |

## 5. REJECT verdicts — do the recorded reasons hold up?

- **Spec F10** (wiring-test title says "lint CI", the check is ci.yml-wide) — **holds.** `inCi` is
  built by `ciScriptsInvokedIn()` over the whole workflow file
  (`src/__tests__/ci-audit-wiring.test.ts:49-54`), so the observation is factually right, but the
  title is verbatim in the intake's `tests_to_add` and the `ci:admin-contract` case three lines
  above uses the same wording — changing it would amend a locked surface for no signal.
- **Std F6** (file name breaks the `*-audit.ts` convention) — **holds.** A rename would edit two
  entries in the locked `allowed_edit_surface`, which is an abort criterion, for a naming gain;
  recording it as named debt is the right call.

---

## Appendix — new, untriaged observations (not part of round 1; no verdict claimed)

- `realExec` caps `maxBuffer` at 64 MB (`secret-scan.ts:354`). A range whose `git log --numstat`
  or whose gitleaks JSON report exceeds that returns `status: null`, which `ok()` treats as a
  failure — fail-closed, but the printed message ("git exited null") would not tell a developer
  the buffer was the cause.
- `COMMIT_RECORD_SEPARATOR` is `\u001e`, described at `:168` as "never valid in a path". Git
  permits any byte but NUL and `/` in a path component; `core.quotePath` (default on) escapes it,
  so this is safe in practice but not for the stated reason.
- The `generic-api-key` UUID value allowlist would also suppress a genuine secret that happens to be
  UUID-shaped. That is the locked round-0 decision, noted only for completeness.
- The `.gitleaks.toml` claim "neither allowlist in this file can hide a real leak" is true for the
  eight named vendor rules; a real high-entropy credential with no vendor rule, sitting in one of
  the six fixture files, would still be suppressed under `generic-api-key`. Consistent with the
  locked decision, but the sentence reads broader than it is.

---

**VERDICT: REVISE** — the round-1 P1 is genuinely closed and every accepted finding is addressed,
but the fix commit makes the gate fail on its own branch (N1) and introduces a deterministic false
fail on a commit shape the rubric names as must-not-fail (N2, with N3 locking it in and N5
recording the wrong model in the durable ledger).
