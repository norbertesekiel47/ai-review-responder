# Round 3 — verification review, `feat/1374-secret-scan` (LAST branch round)

VERIFICATION ONLY. Each ACCEPTED round-2 finding (N1–N5) is checked against the round-3 fix
commit, plus defects the fixes introduced. New observations against unchanged code are in the
appendix, untriaged.

- MERGE_BASE `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- ROUND1_SHA `e2c3ac36e53b3a968b52c3129538a4ff3adf12ef`
- FIX_HEAD `8837643e380e15ad660b5f7fa2c19e124702878d`
  (`fix(1374): review rounds 1-2 — an empty gitleaks report is a pass only when the scan covered the range`)
- Branch history at FIX_HEAD: `75c8d54c → e2c3ac36 → 6ac36114 → 8837643e`. The round-2-reviewed
  commit `8092131a4` is unreachable from the branch (confirmed: still in the object database, not
  in `git log`), so the whole fix lands as ONE commit. Worktree is clean (`git status --porcelain`
  empty) and HEAD is FIX_HEAD.
- Tooling: local `gitleaks 8.30.1` (`/opt/homebrew/bin/gitleaks`), `git 2.54.0`, `node v24.15.0`.
- Every gitleaks invocation carried `--redact`. Every experiment ran in a `mktemp -d` scratch git
  repository outside `$WT`; every key-shaped value was assembled at RUN TIME from `/dev/urandom`
  plus `printf`-joined word fragments. No `.env*` file other than `.env.example` was read, commit
  `24353cf1c` was never inspected, and no secret value, no real-looking secret, and no complete
  literal PEM marker pair appears in this report.
- Nothing in `$WT` was edited, staged or committed except this one file.

---

## 1. Per-finding verdicts

| Finding | ADDRESSED / PARTIALLY / NOT | Evidence at FIX_HEAD |
|---|---|---|
| **N1 (P1)** — the branch fails its own gate: a literal PEM opening/closing marker pair in the drill paragraph | **ADDRESSED** | The exact scan the script builds, run by hand over the branch range: `gitleaks git --log-opts="--diff-merges=remerge 75c8d54c..8837643e" --redact --no-color --config .gitleaks.toml --report-format json --report-path - .` → stdout `[]`, **exit 0**, stderr `INF 3 commits scanned.` / `INF scanned ~176435 bytes (176.43 KB) in 117ms` / `INF no leaks found`. 3 scanned = the 3 commits in the range; `git log --format=$'\x1e%H' --numstat --diff-merges=remerge` over the same range yields `countCommitsAddingText` = **3**, so `3 >= 3` → the script's own decision is PASS. The reworded recipe writes no marker as a literal: it builds the delimiter with `dash5=$(printf '%.0s-' $(seq 5))` and joins `BEGIN`/`END` with `printf`. Recipe followed **literally** in a scratch repo (add, then `git rm` in the next commit) → exit **1**, exactly **one** `private-key` finding, `Secret: "REDACTED"`, `Match` redacted. The "48 bytes of entropy is enough" sub-claim also reproduces. |
| **N2 · N3 (P1/P2)** — false FAIL on a line-deletion-only commit and on a revert; the test locked the wrong model in | **ADDRESSED** | `scripts/ci/secret-scan.ts` now fails only on a SHORTFALL: `if (scannedCommits < minimumExpectedCommits)`. Measured in scratch: line-deletion-only on a surviving file → gitleaks 1 / minimum 0 → **PASS**; add-then-revert (2 commits) → gitleaks 2 / minimum 1 → **PASS**. Both were FAIL under round 2's equality. The wrong-model test `does not count commits gitleaks will not scan (empty, deletion-only, rename, binary)` is **gone**; its `0\t7\tsrc/b.ts` record now lives in a new test that asserts **PASS**. 18/18 tests execute green against the real implementation (run outside `$WT` on a `git show` copy, Node type-stripping + a minimal `vitest` shim; no `pnpm` in `$WT`). |
| **N4 (P2)** — `-diff`/`binary` file invisible to the scan, accepted as a documented limit | **ADDRESSED (documented, as decided)** | Script header carries a `LIMITS — what a sufficient count does NOT prove` block; runbook carries **"Known limit — `.gitattributes` can hide a file from the scan."**; the ledger paragraph carries "A sufficient count does **not** prove the range was fully read". Reproduced both directions: a complete runtime-built PEM as `*.pem` **with** `-diff` → `--numstat` reports `-`/`-`, minimum stays at 1 (the `.gitattributes` line), gitleaks 1 → **PASS** (the documented false pass); the identical commit **without** the attribute → **FAIL(finding: private-key/REDACTED)**. The `binary` attribute behaves identically (`-`/`-` in numstat, PASS). Grep over the tree at FIX_HEAD finds **no** sentence left that implies counts prove coverage. |
| **N5 (P3)** — the false "gitleaks counts only commits that ADD a line" measurement in three durable places | **ADDRESSED** | (a) `scripts/ci/secret-scan.ts` header: "gitleaks … counts a commit when that commit yields at least one hunk on a file that SURVIVES the commit — added OR removed lines"; (b) `.claude/reference/arch-review-log.md:3` (the 2026-09-21 #1374 paragraph): same corrected model plus "a **lower bound, not an equality** (owner decision, round 2)"; (c) `docs/superpowers/plans/feat-1374-secret-scan-deviations.md`: an inline `[CORRECTED 2026-09-21 by review round 2 …]` bracket inside the round-1-fixes entry **and** a new round-2 entry recording N1/N2/N3/N4. All three re-measured this round and found TRUE. |

### Locked-surface checks

- The **7 intake-locked test titles** (`tests_to_add` in `docs/superpowers/plans/feat-1374-secret-scan-intake.json`,
  verified against the worktree's own copy) are present **verbatim**: six in
  `scripts/ci/__tests__/secret-scan.test.ts:90, 112, 123, 169, 185, 265` and
  `includes the secret scan in package, lint CI and local pre-push` in
  `src/__tests__/ci-audit-wiring.test.ts` (that file is **unchanged** since ROUND1_SHA).
- The round-1-added locked title `fails closed when gitleaks exits 0 with an empty report but
  scanned fewer commits than the range holds` is present verbatim at
  `scripts/ci/__tests__/secret-scan.test.ts:196` and is **honestly asserted under lower-bound
  semantics**: its fixture gives 3 text-adding commits (so `minimumExpectedCommits === 3` **and**
  the range holds 3) against `cleanGitleaksStderr(0)`; the assertions read
  `scanned 0 commit(s)`, `fewer than the 3 commit(s)`, `that add text`, and
  `not.toMatch(/passed \(/)`. Title and behaviour agree — the title's "the range holds" and the
  message's "commits … that add text" coincide in that fixture; no equality is implied anywhere.
- **Mutation-tested, executed (not reasoned)** — each new branch is load-bearing:

  | Mutation | Result |
  |---|---|
  | `scannedCommits < minimumExpectedCommits` → `!==` | **2 FAIL** — the line-deletion-only and revert tests redden (this is exactly N2/N3) |
  | shortfall check removed | **1 FAIL** — `fails closed when gitleaks exits 0 with an empty report but scanned fewer commits than the range holds` |
  | `added > 0` → `added >= 0` | **1 FAIL** — `derives the minimum from text-adding commits only` |
  | `Number.isFinite(added) && added > 0` → `true` | **1 FAIL** — same test (binary `-` rows) |
  | git-error-on-stderr check removed | **1 FAIL** — `fails closed when gitleaks reports a git error on stderr` |
  | scanned-count-absent check removed | **1 FAIL** — `fails closed when gitleaks reports no scanned-commit count at all` |
  | (restored) | **18 PASS / 0 FAIL** |

---

## 2. Experiment table

Every row runs the script's exact two commands:
`git log --format=$'\x1e%H' --numstat --diff-merges=remerge <range>` (fed through
`countCommitsAddingText` copied verbatim from `secret-scan.ts` at FIX_HEAD) and
`gitleaks git --log-opts="--diff-merges=remerge <range>" --redact --no-color --config <cfg>
--report-format json --report-path - .`, then applies the pass rule from
`runSecretScan`. All in `mktemp -d` scratch repos outside `$WT`.

| # | Case | gitleaks count | minimum | Script outcome |
|---|---|---|---|---|
| A | normal add (append a line) | 1 | 1 | PASS ✔ |
| B | **line-deletion-only, file survives** | **1** | **0** | **PASS ✔ (N2 fixed — was FALSE FAIL)** |
| C | **add-then-revert, 2-commit range** | **2** | **1** | **PASS ✔ (N3 fixed — was FALSE FAIL)** |
| D | whole-file deletion (`git rm`) | 0 | 0 | PASS ✔ |
| E | rename-only (100% similarity) | 0 | 0 | PASS ✔ |
| F | binary-only add (random bytes) | 0 | 0 | PASS ✔ |
| G | clean merge, no conflict (3 commits) | 2 | 2 | PASS ✔ |
| H | **evil merge: fake key ONLY in the conflict resolution** | 3 | 3 | **FAIL(finding n=1, `private-key`, REDACTED) ✔** — reported exactly once |
| I | **round-1 reproduction: broken `.gitattributes` textconv + runtime fake key in range** | **0** | **1** | **FAIL(git-error-on-stderr) ✔** — `ERR [git] fatal: cannot exec …`, `ERR error="stderr is not empty"`, `INF 0 commits scanned.`, stdout `[]`, exit **0**. Caught by TWO independent conditions (stderr marker AND shortfall). |
| J | **N4 accepted limit: complete PEM as `*.pem` with `-diff`** | 1 | 1 | **PASS — FALSE PASS (documented N4)** |
| J2 | control: identical commit, no attribute | 1 | 1 | FAIL(finding n=1, `private-key`) ✔ |
| J3 | same with `binary` attribute instead of `-diff` | 1 | 1 | PASS — FALSE PASS (same documented limit) |
| P1 | pure new-file add | 1 | 1 | PASS ✔ |
| P2 | empty file added | 0 | 0 | PASS ✔ |
| P3 | symlink add | 1 | 1 | PASS ✔ |
| P4 | mode-only (`chmod +x`) | 0 | 0 | PASS ✔ |
| P5 | rename **with** modification | 1 | 1 | PASS ✔ |
| P6 | empty commit (`--allow-empty`) | 0 | 0 | PASS ✔ |
| P7 | add lines to A + delete file B in one commit | 1 | 1 | PASS ✔ |
| P8 | add a file, delete it in the next commit | 1 | 1 | PASS ✔ |
| Q2 | octopus merge (2 side branches) | 3 | 3 | PASS ✔ |
| — | **branch range `MERGE_BASE..FIX_HEAD` (real, in `$WT`)** | **3** | **3** | **PASS ✔ — N1 closed** |
| — | runbook drill recipe followed literally | 2 | 2 | FAIL(finding n=1, `private-key`, `Secret`+`Match` REDACTED) ✔ |
| — | 48-byte body (one 64-char line) | 1 | 1 | FAIL(finding n=1, `private-key`) ✔ |
| — | opening marker with NO closing marker | 1 | 1 | PASS (not detected) — matches the runbook's stated non-detection ✔ |
| — | merge-variant measurement, same evil-merge repo | `-m` 2 findings/3 scanned · `--cc` 0/2 · `-c` 0/2 · `--first-parent -m` 1/2 · `--diff-merges=remerge` **1/3** | — | reproduces the runbook's table exactly ✔ |

### Attacking the bound

| Attack | Result |
|---|---|
| **False FAIL** — an honest range where gitleaks scans FEWER commits than the minimum with **no** `ERR`/`FTL`/`fatal:` line | **CONSTRUCTED (R4).** `.gitattributes` `*.gen diff=blank` + `git config diff.blank.textconv /usr/bin/true` (a driver that succeeds and emits nothing). A commit adding a 2-line innocuous `out.gen`: `--numstat` counts `2 0 out.gen` so **minimum = 1**, while `git log -p` emits no hunk so **gitleaks = 0**, exit 0, `[]`, **0 error lines on stderr** → `FAIL(shortfall)` on a range with no secret in it. **Not reachable in this repo today**: the tracked `.gitattributes` at FIX_HEAD declares only `text`/`eol` settings plus `filter=lfs diff=lfs merge=lfs -text` for three brand-asset globs, and no `diff.lfs.textconv` is configured on this machine (`git config --global/--system --get-regexp '^diff\.lfs'` → empty). Adding an empty-output textconv driver would block every push until removed. It is the mirror image of N4 and fails in the SAFE direction. |
| Same mechanism **with** a fake key present (Q1) | gitleaks 0 / minimum 1, no ERR line → `FAIL(shortfall)` — the lower bound catches a class that N4's `-diff` does not (there, `--numstat` also goes blind and the minimum does not rise). |
| **False PASS** — a range containing a fake key where all conditions hold | **THREE found.** (1) **N4, documented**: `-diff` or `binary` attribute (rows J / J3). (2) **`gitleaks:allow` on the finding's start line** (R1b): scanned 1 / minimum 1 / exit 0 / `[]` → PASS with a complete runtime-built fake key in the range. (3) **a committed `.gitleaksignore`** carrying the finding fingerprint (R2): scanned 2 / minimum 2 / exit 0 / `[]` → PASS. The script passes no `--ignore-path`, so gitleaks reads `.gitleaksignore` from the repo root automatically. Both (2) and (3) are gitleaks-level suppressions present identically at ROUND1_SHA — **pre-existing, not introduced by these fixes** — so they go to the appendix, not the defect table. |
| Extension-based suppression | `leak.png` / `.jpg` / `.svg` / `.pdf` → **PASS** with a complete fake key; `.txt` / `.md` / `.lock` / `.mp4` → FAIL(finding). Cause: gitleaks' own **default global allowlist `paths`** (`[extend] useDefault = true`), not this repo's `.gitleaks.toml`. Pre-existing; appendix. |
| `.gitleaks.toml` scoping claim re-verified | A complete runtime-built PEM planted at the allowlisted path `src/lib/notifications/email/__tests__/send-email.test.ts` → **FAIL(finding n=1, `private-key`, REDACTED)**. The `targetRules = ["generic-api-key"]` scoping on the path block holds. |

---

## 3. Doc-claim audit — every sentence this round changed in the runbook's "Secret scan" section

Scope isolated precisely by diffing the discarded `8092131a4` against FIX_HEAD (still in the object
database), so this is the round-3 delta only, not round 2's.

**19 claims checked: 15 TRUE, 2 FALSE, 2 NOT RE-RUN.**

TRUE (measured this round, not assumed):

1. "A PASS requires *all four* of: gitleaks exited 0; its JSON report is `[]`; its own `N commits
   scanned` count is **at least** the number of commits in the range that add at least one text
   line (git is asked with the same `--diff-merges` flag); and its stderr carries no git error
   marker." — matches `runSecretScan` exactly; all four branches mutation-proven.
2. "The count check is a **lower bound, not an equality**." — `scannedCommits < minimumExpectedCommits`.
3. "gitleaks counts every commit that adds a text line" — held in every ordinary shape measured
   (A, C, P1, P3, P5, P7, P8, G, H, Q2). One measured exception exists (a `.gitattributes` textconv
   driver emitting nothing, R4/Q1) and it makes the gate **fail**, never pass; recorded as a new
   defect below, not as a falsification of the design.
4. "it also counts some that only remove lines from a surviving file" — row B (1 vs 0).
5. "a line-deletion-only commit or a revert legitimately makes gitleaks' count the higher of the
   two" — rows B (1>0) and C (2>1).
6. "Scanning *fewer* commits than the range's text-adding commits is the failure — it means the
   scan stopped short." — rows I and Q1.
7. "The count check catches a scan that *stopped*; it does **not** prove every byte in the range
   was read, and a sufficient count is not evidence of full coverage." — row J.
8. "A file that `.gitattributes` marks `-diff` or `binary` produces no text hunk in `git log -p` …
   and git's `--numstat` reports `-`/`-` for it too, so the script's own minimum does not rise
   either." — measured for both attributes (`- - leak.pem`, `- - leak.key`).
9. "Measured on 8.30.1: a complete PEM committed as `*.pem` **with** a `-diff` attribute passes
   this gate; the identical commit without the attribute fails it." — rows J / J2.
10. "This is a gitleaks-level limitation, not something the script can close without modelling git
    attributes itself." — consistent with 8 (both sides of the comparison go blind together).
11. "a PEM opening line with no matching closing line" is not detected — measured, 0 findings.
12. "What *is* detected … is a **complete PEM block**: the standard PEM opening line (five hyphens,
    then `BEGIN RSA PRIVATE KEY`, then five hyphens), at least one line of base64 body, and the
    matching closing line" — reproduced; the rule's own regex requires ≥64 characters between the
    markers.
13. "The first cut of this paragraph spelled both markers out and the branch failed its own scan."
    — corroborated by the triage/deviations record and by the now-clean branch scan.
14. The `bash` recipe block, and "the command shape above over that range reports exactly one
    `private-key` finding with `\"Secret\": \"REDACTED\"`" — followed literally, exit 1, one finding.
15. "As little as 48 bytes of entropy (one 64-character body line) is enough to fire the rule." —
    measured, finding fires.

FALSE (one line each):

- **FALSE 1 — `docs/runbooks/secrets-rotation-api-keys.md`, "Neither marker is written out in full
  anywhere in this repo":** `.env.example:92` (tracked, pre-existing) writes a complete opening
  marker and a complete closing marker on one line, and
  `docs/reviews/feat-1374-secret-scan/round-2-verification.md` — committed in FIX_HEAD itself —
  writes a complete opening marker at line 31 and a complete closing marker at line 154.
- **FALSE 2 — same paragraph, "The `private-key` rule matches from an opening marker through to the
  next closing one **wherever they sit**, prose included, so a complete pair written into a doc is
  itself a finding":** not unconditional — the rule needs ≥64 characters between the markers (so
  `.env.example:92`'s adjacent pair is not a finding), and the >9 KB pair inside
  `round-2-verification.md` matches the regex yet is dropped by gitleaks' own default global
  allowlist (`TRC skipping finding: global allowlist allowed-regex=true … rule-id=private-key`), so
  it is not a finding either.

NOT RE-RUN this round (round-2 evidence stands, not re-verified here to avoid writing further
key-shaped strings): "a vendor prefix followed by ~90 identical characters (below the rule's
entropy floor)"; "the same prefix followed by 95 random `[A-Za-z0-9_-]` characters".

Advisory, not a factual claim: "a PR that adds `-diff` or `binary` attributes for a text file
deserves a human look."

### N5's three durable places — re-checked

| Place | Corrected? |
|---|---|
| `scripts/ci/secret-scan.ts` header | YES — "counts a commit when that commit yields at least one hunk on a file that SURVIVES the commit — added OR removed lines", plus the explicit asymmetry and LIMITS paragraphs |
| `.claude/reference/arch-review-log.md:3` (2026-09-21 #1374 paragraph) | YES — corrected model + "lower bound, not an equality (owner decision, round 2)" + the N4 limit |
| `docs/superpowers/plans/feat-1374-secret-scan-deviations.md` | YES — inline `[CORRECTED 2026-09-21 by review round 2 …]` bracket in the round-1 entry, plus a new round-2 entry covering N1–N4 |

A tree-wide grep at FIX_HEAD for the old model ("counts only commits that ADD…") returns only the
CORRECTED sentences. No sentence anywhere implies that matching counts prove coverage.

---

## 4. Defects the fixes INTRODUCED (fix hunks and direct callers only)

| ID | Sev | file:line | Finding |
|---|---|---|---|
| **M1** | **P3** | `.github/workflows/ci.yml:283`; `docs/audits/2026-07-06-codebase-audit-findings.md:45` | **Stale equality wording survives the owner's lower-bound decision.** Both say the scan fails "on an empty report whose scanned-commit **count does not match the range**". Under FIX_HEAD only a SHORTFALL fails; a count *higher* than the minimum is the normal, expected case on any range containing a revert or a deletion-only commit, and both sentences describe that as a failure. `docs/superpowers/plans/feat-1374-secret-scan-deviations.md:295` has the same "count equal to the scannable-commit count" phrasing inside the round-1-fixes entry — partially mitigated there by the round-2 entry below it, but the sentence itself is uncorrected. N5's remediation covered three durable places; these two (three counting the deviations line) were not in that list and are now wrong. |
| **M2** | **P3** | `docs/runbooks/secrets-rotation-api-keys.md` (the rewritten drill paragraph) | The two FALSE doc claims in §3. The first ("neither marker is written out in full anywhere in this repo") is falsified by `.env.example:92` and by `docs/reviews/feat-1374-secret-scan/round-2-verification.md:31,154` — the latter committed by this very fix commit. The second ("a complete pair written into a doc is itself a finding", unconditional) is falsified by both of those files, which contain complete pairs and are not findings. The paragraph's operative instruction — build every part at run time, copy no marker out of the runbook — is correct and unaffected; only its two factual premises are overstated. |
| **M3** | **P3** | `scripts/ci/secret-scan.ts` — `countCommitsAddingText` vs gitleaks' diff path | **A textconv driver that emits nothing produces a shortfall FAIL on a clean range.** `--numstat` counts the added lines (minimum rises) while `git log -p` emits no hunk (gitleaks counts 0), exit 0, `[]`, **no `ERR`/`FTL`/`fatal:` line** — so the shortfall branch is the only thing that fires and it fires on an honest push. Reproduced (R4). Fails in the safe direction and is unreachable in this repo today (the tracked `.gitattributes` sets only `text`/`eol` plus `filter=lfs diff=lfs merge=lfs -text`, and no `diff.lfs.textconv` is configured), so it is a documentation gap rather than a live break: the runbook's "Known limit" names only the `-diff`/`binary` direction (a false PASS) and does not mention the textconv direction (a false FAIL), which is the failure a developer would actually have to debug. |

No P0/P1/P2 defect found. No FALSE PASS attributable to these fixes: the two false passes reachable
without a `.gitattributes` change (`gitleaks:allow`, `.gitleaksignore`) behave identically at
ROUND1_SHA and are recorded in the appendix.

---

## Appendix — new, untriaged observations (unchanged code / pre-existing; no verdict claimed)

- **`gitleaks:allow` on a finding's start line is a one-token bypass of the whole gate.** A commit
  adding a complete runtime-built fake key with that marker appended to its opening line scans 1 /
  minimum 1 / exit 0 / `[]` → PASS. Identical behaviour at ROUND1_SHA. Neither the script header
  nor the runbook's "Known limit" mentions it; the repo has no policy against the marker and no
  audit that greps for it.
- **A committed `.gitleaksignore` is a one-file bypass.** gitleaks reads `.gitleaksignore` from the
  repo root automatically and the script passes no `--ignore-path`; a fingerprint line there makes
  a range containing a complete fake key PASS (scanned 2 / minimum 2 / exit 0 / `[]`). No such file
  is tracked at FIX_HEAD.
- **gitleaks' inherited default global allowlist silently exempts whole file classes.** With
  `[extend] useDefault = true`, `config/gitleaks.toml` v8.30.1 carries a global `paths` allowlist
  covering `bmp|gif|jpe?g|png|svg|tiff?`, `docx?|xlsx?|pdf|bin|…`, `node_modules/`, every common
  lockfile, `vendor/…`, `gitleaks.toml` itself and more. Measured: a complete fake key committed as
  `leak.png`/`.jpg`/`.svg`/`.pdf` → **PASS**; as `.txt`/`.md`/`.lock`/`.mp4` → FAIL. It also carries
  a global `regexes` list that suppressed the complete marker pair in
  `round-2-verification.md`. This is a much larger blind spot than the documented `.gitattributes`
  one, it is inherited from a locked round-0 decision (`useDefault = true`), and it is undocumented
  in both the script header and the runbook.
- The pass-branch comment "Three more conditions have to hold" precedes four `if` blocks
  (non-zero exit, git error marker, count absent, shortfall). Defensible if "count present and
  sufficient" is read as one condition; noted only because the header's own list is also four.
- `realExec`'s `maxBuffer` is 64 MB; an overflow surfaces as `git exited null` with no hint that the
  buffer was the cause (carried over from round 2's appendix, still true).
- The `generic-api-key` UUID value allowlist would also suppress a genuine UUID-shaped secret —
  the locked round-0 decision, noted for completeness (carried over from round 2's appendix).

---

**VERDICT: APPROVED** — all four accepted round-2 findings are addressed with executed evidence:
the branch's own scan over `MERGE_BASE..FIX_HEAD` is clean (`[]`, exit 0, 3 commits scanned) and the
reworded drill recipe reproduces the one-finding, fully-redacted result when followed literally
(N1); the lower bound passes line-deletion-only and revert ranges while still failing every
shortfall, with the wrong-model test removed and the whole suite green and mutation-proven (N2/N3);
the `.gitattributes` limit is documented in both required places with no residual
counts-prove-coverage claim (N4); and the false measurement is corrected in all three durable
places (N5). The three defects found are all P3 documentation accuracy — no false pass and no live
false fail is attributable to these fixes.
