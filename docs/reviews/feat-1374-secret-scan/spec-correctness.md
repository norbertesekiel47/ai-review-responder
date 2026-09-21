# Review — spec & correctness (security lens) — `feat/1374-secret-scan`

- **Axis:** spec & correctness, with a security lens
- **MERGE_BASE:** `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- **HEAD_SHA:** `e2c3ac36e53b3a968b52c3129538a4ff3adf12ef`
- **Read from:** the committed SHA (`git show`/`git diff`/`git grep <sha>`), never the working tree.

## Measured diff (`git diff --numstat MERGE_BASE HEAD_SHA`)

Tests excluded from the production buckets.

| Bucket | File | +/- |
|---|---|---|
| code/config | `scripts/ci/secret-scan.ts` (new) | 196 / 0 |
| code/config | `.gitleaks.toml` (new) | 47 / 0 |
| code/config | `.github/workflows/ci.yml` | 36 / 0 |
| code/config | `lefthook.yml` | 5 / 0 |
| code/config | `package.json` | 1 / 0 |
| **code/config total** | | **285 / 0** |
| docs | `docs/superpowers/plans/feat-1374-secret-scan-deviations.md` (new) | 285 / 0 |
| docs | `docs/superpowers/plans/feat-1374-secret-scan-intake.json` (new) | 93 / 0 |
| docs | `docs/runbooks/secrets-rotation-api-keys.md` | 76 / 0 |
| docs | `docs/audits/2026-07-06-codebase-audit-findings.md` | 19 / 17 |
| docs | `.claude/reference/arch-review-log.md` | 2 / 0 |
| **docs total** | | **475 / 17** |
| tests (excluded) | `scripts/ci/__tests__/secret-scan.test.ts` (new) | 130 / 0 |
| tests (excluded) | `src/__tests__/ci-audit-wiring.test.ts` | 6 / 0 |

Every changed path is inside `allowed_edit_surface` (the `.claude/reference/arch-review-log.md`
amendment is recorded and owner-approved in the deviations file). Non-goals hold: no history
rewrite, no gitleaks Action, no pre-commit hook, no change to `claude.yml` /
`claude-code-review.yml`, no dependency added.

## Method

Read-only. All gitleaks experiments ran with the locally installed **gitleaks 8.30.1** inside
`mktemp -d` scratch repositories outside `$WT`, always with `--redact`, using obviously fake
values assembled at runtime from `/dev/urandom`. No `.env*` file other than `.env.example` was
read; commit `24353cf1c` and any `keys.md` path were never shown; no secret value (real or
real-looking) appears in this report.

The one command run inside `$WT` was a read-only `gitleaks git --log-opts=<merge-base>..<head>`
over this branch's own committed range (result: 1 commit scanned, 0 findings, exit 0 — the
branch's own diff is clean, and gitleaks works correctly in a **linked worktree**, where `.git`
is a file).

---

# Findings

## F1 — [P1] The pass branch ignores gitleaks' exit status, and gitleaks exits **0** with `[]` on stdout when its underlying `git log` errors — a real leak in the range ships green

**File:** `scripts/ci/secret-scan.ts:151` (`if (report !== null && report.length === 0)`)
**Contract:** `invariants[1]` — "A gate that cannot see never passes"; the file's own header —
"FAIL CLOSED, on purpose, **in every branch**"; runbook § Secret scan — "**Fails closed, always**".

**Evidence (reproduced end-to-end, scratch repo `/tmp/gl5.zGLQ46`):**

Case A — clean repo, a fake PEM private key committed then deleted in the next commit, range
`basepoint..HEAD`:

```
gitleaks exit=1
stdout=[{ "RuleID": "private-key", ... }]
INF 1 commits scanned.
git rev-list --count basepoint..HEAD = 2
```
→ script takes the finding branch, exit 1. Correct.

Case B — **same repository, same range, same leak**, after `git log -p` is made to write to
stderr (here: a `.gitattributes` `textconv` driver that is not installed on the machine):

```
git rev-list --count basepoint..HEAD = 3
gitleaks exit=0
stdout=[[]]
ERR [git] fatal: unable to read files to diff
ERR error="stderr is not empty"
INF 0 commits scanned.
```
→ `parseReport` returns `[]`, `report.length === 0`, and the script prints
`secret-scan: passed (3 commit(s) scanned in origin/main..HEAD)` and **exits 0**. The private
key is in the range and is never reported.

Independently confirmed on the same class (scratch repo `/tmp/glscratch.l1btM4`): an invalid
`--log-opts` value and a bogus git flag both give `exit=0`, `stdout=[]`, `0 commits scanned` —
gitleaks aborts the whole scan on *any* non-empty git stderr and still reports success.

**Why the existing defence does not cover it.** The header comment correctly identifies and
closes exactly one instance of this family (an unresolvable `origin/main`, pre-resolved with
`git rev-parse --verify`). The family is larger than that one ref case: it is "anything that
makes gitleaks' `git log` subprocess write to stderr". Realistic triggers that survive a passing
`git rev-parse --verify origin/main`: an uninstalled `.gitattributes` diff/textconv or LFS
filter on a runner, a blobless/partial clone that cannot fetch a blob, a `warning:` line from a
damaged commit-graph or a concurrent `git maintenance`, or any future gitleaks/git message
change. The script reads `scanResult.status` only to *print* it in the error branch — it is
never part of the pass decision.

**Failure scenario.** A developer adds a `.gitattributes` textconv entry (or CI lands on a
runner without the referenced tool). From that push onward, every local pre-push run and every
`lint` job prints `secret-scan: passed (N commit(s) scanned)` with a non-zero N and exits 0,
while gitleaks scans nothing. The gate is silently dead and the printed line actively asserts
that it is alive. This is the #1374 failure mode restored.

**Smallest fix.** Two conditions, both already available in the function:
1. require `scanResult.status === 0` for the pass branch (a genuine clean scan exits 0; a
   genuine finding exits 1 with a non-empty array — the two are already distinguished by
   `report.length`, so adding the status check costs nothing);
2. cross-check gitleaks' own `N commits scanned` (parsed from stderr) against `commitCount`
   from `git rev-list`, and fail closed when gitleaks scanned fewer. In case B above the two
   were `0` and `3`.
Either alone kills the reproduction; together they make the whole family fail closed.

---

## F2 — [P1] The `.gitleaks.toml` path allowlist disables **every** rule in six live test suites; a real credential committed there passes the gate

**File:** `.gitleaks.toml:41-47` (second `[[allowlists]]`, `paths = [...]`)
**Contract:** `invariants[4]` — "Prefer a value-pattern entry over a path entry; **a path entry
is only for a file that exists solely as a fixture**." The deviations file itself escalates this
to the review wave as "an explicit question, not a settled point".

**Evidence (scratch repo `/tmp/gl9.nHGQko`, the six real files extracted at `HEAD_SHA`):**

| Config | Fake private key planted in `src/lib/notifications/email/__tests__/send-email.test.ts` |
|---|---|
| gitleaks default ruleset | exit 1 — `private-key` reported |
| `.gitleaks.toml` **as shipped** | **exit 0 — 0 findings** |
| `.gitleaks.toml` + `targetRules = ["generic-api-key"]` on the path block | exit 1 — `private-key` reported, and all 16 fixture false positives still suppressed |

**Verdict: yes, this is a contract violation, and the smallest honest correction is one line.**
Not a shrug: I enumerated what actually fires in those six files under the default ruleset —
**16 findings, all six of them files, and every single finding is `generic-api-key`** (matches
are `tokenHashPrefix:`, `tokenHash:`, `idempotencyKey:`, `SOLICITATION_KEY =`). Nothing else
fires. So the path entry buys suppression of one rule and pays for it by disabling ~200,
including `private-key`, `openai-api-key`, `anthropic-api-key`, `stripe-access-token`, `jwt` and
`aws-access-token`, in six files that are edited by hand, routinely, forever.

Ranked corrections:
1. **Minimum (verified sufficient):** add `targetRules = ["generic-api-key"]` to the existing
   path block. Blast radius drops from every rule to the one rule that actually false-positives;
   the 16 fixture hits stay suppressed. One line, no behaviour change to the gate's true
   positives.
2. **Contract-faithful (what `invariants[4]` asks for):** replace the path block with a
   value-pattern block — `targetRules = ["generic-api-key"]`, `regexTarget = "match"`, a regex
   over the four fixture key names / the hex-hash literal shape those suites use — matching the
   shape of the UUID block directly above it. Then the path block disappears entirely and the
   locked "path entry only for a file that exists solely as a fixture" reservation is honoured
   rather than reinterpreted.

**Failure scenario.** A developer debugging `send-email.test.ts` pastes a live Resend key into a
fixture to reproduce a provider bug and forgets to swap it back. Pre-push: green. `lint`: green.
The key lands on `main` and enters permanent history — the exact event #1374 exists to prevent,
in a file the gate has been told to ignore.

**Note on the config's own reasoning.** `.gitleaks.toml:20-27` argues at length that the
allowlist "cannot hide a real leak" because vendor rules match a token *shape*. That argument is
correct **for the UUID value block** (I confirmed: a fake PEM under the repo config still fires
outside those six paths) and does **not** carry to the path block eleven lines below it. A
reader who checks the reasoning and stops at the first block will conclude the file is safe.

---

## F3 — [P2] Audit C1 step 3 is marked **DONE** for work the branch did not do; the runbook's Scope and procedures are unchanged

**File:** `docs/audits/2026-07-06-codebase-audit-findings.md:44` (fix step 3), and the `[x]` on
line 22.
**Contract:** `user_visible_behavior[6]` — "item C1 shows the **true** status of steps 1, 3 and 4";
the intake rule to tick only when every step is done or explicitly decided.

**Evidence.** The original step 3 asked for two things: *"Update
`docs/runbooks/secrets-rotation-api-keys.md` to include provider/infra keys (it currently covers
only ENCRYPTION_KEY/SESSION_COOKIE_SECRET/CSRF_SECRET)"* **and** *"record this rotation in its
(currently empty) log."*

At `HEAD_SHA` the runbook's `## Scope` section (lines 6-10) still reads exactly
`ENCRYPTION_KEY` / `SESSION_COOKIE_SECRET` / `CSRF_SECRET` — untouched by this diff. The only
provider procedure in the file is the pre-existing "LLM provider keys — `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`" section, added 2026-09-16, which this branch did not modify. There is **no**
rotation procedure for `SERPAPI_API_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `REDIS_CACHE_TOKEN`,
`REDIS_QUEUE_TOKEN`, or `STRIPE_SECRET_KEY` — five of the six keys the new log rows claim were
rotated.

The branch did the second half (six log rows) and none of the first half, and records the whole
step as **DONE — "now covers provider/infra keys"**.

**Failure scenario.** The next rotation of the SerpAPI or Supabase anon key — the "revisit
trigger" case the History-scrub decision explicitly plans for — goes to this runbook, finds no
procedure, and improvises. The 2026-09-16 incident recorded two paragraphs above happened
because the ANTHROPIC procedure did not exist yet.

**Fix.** Either add the missing procedures (or one shared "provider/infra key" procedure naming
the five stores), or change step 3 to `PARTIAL` and state which half is deferred and why. The
C1 checkbox then follows whichever is true.

---

## F4 — [P2] Two Rotation Log rows assert facts the repository contradicts or has never established

**File:** `docs/runbooks/secrets-rotation-api-keys.md:53-54`; same claim mirrored at
`docs/audits/2026-07-06-codebase-audit-findings.md:37`.
**Contract:** `invariants[5]` — "The runbook records **fingerprints, dates and evidence only**";
`user_visible_behavior[5]` specifies the row content as "date, actor, secret name, and the text
owner-reported; not independently verified; no fingerprint recorded".

Both variable names are real (`.env.example:30`, `.env.example:36`). Two claims attached to them
are not.

**(a) `REDIS_QUEUE_TOKEN` is labelled "(Upstash, 2 of 2)".** The repository says otherwise at
`HEAD_SHA`:
- `.env.example:36` — `# REDIS_QUEUE_TOKEN=  # Unused with Railway (no token)`
- `docs/runbooks/deployment-guide.md:380` — "`REDIS_QUEUE_TOKEN` is unused (Railway needs no token)."
- `.claude/CLAUDE.md` Tech stack — "BullMQ queue on **Railway Redis** … cache on **Upstash**".

Only `REDIS_CACHE_TOKEN` is an Upstash token. The row records the rotation of a variable that
the deployment runbook says carries no value, and calls it Upstash.

**(b) Both rows say "still-live value from the `keys.md` exposure".** The 2026-07-06 audit row
these replace read `⚠️ Var renamed — **verify manually**`, i.e. it was explicitly *not*
established that the exposed values correspond to these two names, and the branch contains no
verification. The new text converts an open question into a recorded fact in a permanent record,
in the same row that says "not independently verified".

The other four rows (`OPENAI_API_KEY`, `SERPAPI_API_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`STRIPE_SECRET_KEY`) are supported — the audit's 2026-07-06 column marks each "Still live".

**Fix.** For the queue row: either drop it (nothing to rotate) or restate it as
"`REDIS_QUEUE_TOKEN` — documented unused with Railway Redis; cleared/rotated for completeness".
For both: replace "still-live value from the `keys.md` exposure" with the audit's own 2026-07-06
wording ("var renamed; mapping to the exposed value not verified").

---

## F5 — [P2] The printed commit count is not the count gitleaks scanned; it silently defaults to 0, and in CI it is always one too high

**File:** `scripts/ci/secret-scan.ts:139-141` and `:152`.
**Contract:** `edge_cases[0]` — "prints the count **so a vacuous pass is visible**"; runbook —
"exits 0 but prints **the scanned commit count**, so a vacuous pass is visible rather than
silent"; `observability[0]` — "the **scanned commit count**".

Three separate ways the printed number is not what the docs say it is:

1. **It is the range count, not gitleaks' count.** F1's case B prints
   `passed (3 commit(s) scanned)` while gitleaks logged `0 commits scanned`. The one number that
   would have exposed the vacuous pass is discarded.
2. **`git rev-list --count` failing is swallowed.** `ok(countResult) ? … : 0` plus the
   `Number.isFinite` fallback means a failed or empty `rev-list` yields `0`, printed as
   `passed (0 commit(s) scanned)` — byte-identical to a legitimately empty range. The one signal
   the edge case exists to provide is the signal that gets faked.
3. **Systematically +1 in CI.** `actions/checkout` on a `pull_request` event checks out
   `refs/pull/<N>/merge`, so `HEAD` is a merge commit. `git rev-list --count origin/main..HEAD`
   counts it; gitleaks skips it (see F6). Every `lint` run therefore prints a count one higher
   than gitleaks actually scanned.

**Fix.** Parse gitleaks' own `N commits scanned` from stderr and print that (it becomes the
cross-check in F1's fix). Fail closed rather than defaulting to `0` when `rev-list` fails.

---

## F6 — [P2] A secret introduced only in a merge resolution is never scanned

**File:** `scripts/ci/secret-scan.ts:37` (`RANGE`) / `:143` (`--log-opts=${RANGE}` with no
merge-diff flag).
**Contract:** `goal` — "a gitleaks secret scan of the commit range `origin/main..HEAD`";
`user_visible_behavior[3]` — "the scan reads commits, not the file tree".

**Evidence (scratch repo `/tmp/glm.HIM9rI`).** A three-commit range whose final commit is a
merge whose conflict resolution introduces a fake PEM present in neither parent:

```
commits in range: 3   (A, B, merge)
gitleaks exit=0   0 findings
INF 2 commits scanned.
control: the key IS in the tree at HEAD
```

`git log -p` shows no diff for merge commits by default, so gitleaks never sees the resolution.

**Failure scenario.** A developer merges `main` into a long-lived feature branch, hits a conflict
in a config or fixture file, and pastes a credential while resolving. Pre-push: green. `lint`:
green (the merge commit is inside `origin/main..HEAD`). The squash-merge to `main` carries the
value into permanent history.

Low-frequency but not hypothetical: local `merge main` on a feature branch is normal practice
here, and the resulting merge commit is always inside the scanned range.

**Fix.** Add `--diff-merges=remerge` (git ≥ 2.35) to `--log-opts` — it shows exactly the
evil-merge delta and nothing else, so it does not re-scan either parent's content. Or state the
gap explicitly in the runbook as an accepted limitation.

---

## F7 — [P3] The seven unit tests model a CLI contract that does not match the real binary, and the model's "clean" default is the real failure shape

**File:** `scripts/ci/__tests__/secret-scan.test.ts:39` (`'gitleaks-scan': { status: 0, stdout: '[]' … }`)
and `:113` (the fail-closed test).
**Contract:** `test_seams[0]`; `tests_to_add[4]` — "fails closed when gitleaks exits with an error
that is not a finding".

Because `exec` is injected, nothing in the suite touches flag names, exit codes, or stdout shape.
Three concrete consequences:

- The fake's **default** for a clean scan is `status: 0, stdout: '[]'`. That is byte-for-byte the
  shape a **broken** scan produces (F1, case B). The suite therefore encodes, as its definition of
  success, the exact observation that F1 shows means failure.
- `tests_to_add[4]` is discharged by `status: 1, stdout: ''` only. The real non-finding error
  family that matters — `status: 0, stdout: '[]'` — is untested and, per the default above,
  assumed green.
- No test asserts the exit code is derived from the scan at all, nor that `--report-format json`
  and `--report-path -` are passed. `expect(scanCall!.args).toContain(GITLEAKS_CONFIG_PATH)`
  asserts the *value* `.gitleaks.toml` appears somewhere in `args`, not that it follows
  `--config`. A mutant reordering those flags survives.

The recorded drill is the only thing that has ever run the real binary, and it exercises the
happy path only. No removed, skipped, or loosened test in the diff (`git diff --numstat …
'*test*'` is `130/0` and `6/0`; no `.skip`/`.only`/`.todo`).

**Fix.** Add one case with `status: 0, stdout: '[]'` **and** a `commits scanned: 0` stderr against
a non-zero range count, asserting exit ≠ 0. It fails today and passes after F1's fix — which is
the point.

---

## F8 — [P3] The recorded drill is not reproducible from the runbook text alone

**File:** `docs/runbooks/secrets-rotation-api-keys.md:110-126`.
**Contract:** `observability[1]` — "A **recorded drill** in the runbook: a scratch repository
with a committed-then-deleted fake key fails the scan".

The runbook gives the command shape but never says what the fixture value looked like. Following
it literally, I produced **zero findings twice** before getting a working fixture:
- `sk-ant-api03-` + 90 identical characters → 0 findings (entropy floor);
- `sk-ant-api03-` + 95 random `[A-Za-z0-9_-]` characters → 0 findings (the vendor rule's exact
  length/suffix shape);
- a PEM header with no matching `-----END …-----` line → 0 findings;
- a complete PEM block → **exit 1, `"Secret": "REDACTED"`** ✅ (the drill's claim about redaction
  in both `Secret` and `Match` is confirmed true).

A reader who reproduces the drill with either of the first two shapes concludes the gate is
broken. The runbook also states no gitleaks version and gives no install command, though it says
the hook "prints the install command" (the script does, at `secret-scan.ts:41-45`).

**Fix.** Name the fixture shape used ("a complete fake PEM block, header **and** footer" is
enough), and add the `brew install gitleaks` line plus the pinned version to the § Secret scan
section — it is the only file on `allowed_edit_surface` where a developer will look before
hitting the failure.

---

## F9 — [P3] `origin/main` is hardcoded where the named precedent resolves the PR base ref

**File:** `scripts/ci/secret-scan.ts:37`.
**Contract:** `existing_patterns_to_follow[0]` — "`scripts/ci/merge-ledger-audit.ts` … a tsx audit
with an injected exec seam and a loud failure when `origin/main` is absent."

`merge-ledger-audit.ts:155-157` resolves `` `origin/${githubBaseRef}` `` on a PR and falls back to
`origin/main`. The new script always uses `origin/main`. Per `.claude/CLAUDE.md` § Environments,
`staging` is a long-lived branch and worker/webhook/migration/billing work "rides `staging` first"
via a PR — a PR whose base is `staging`. On such a PR the scan's range is `origin/main..HEAD`,
which includes every commit `staging` carries that `main` does not, so the PR is judged against
history it did not introduce and can fail on a pre-existing finding. (Over-scanning, not
under-scanning, so this is correctness/noise, not a security hole.)

---

## F10 — [P3] The new wiring assertion's title says "lint CI"; the assertion is ci.yml-wide

**File:** `src/__tests__/ci-audit-wiring.test.ts:78-82`.

`inCi` is built by `ciScriptsInvokedIn(join(WORKFLOWS_DIR, 'ci.yml'))` — every `pnpm ci:*` in the
file, in any job. Moving `Run secret scan` from `lint` to `test` or `build` keeps the test green
while the title claims the `lint` job specifically. The assertion *does* discharge the invariant
it exists for: I traced all three removals and each one reddens it (drop from `package.json` →
`declared` fails; from `ci.yml` → `inCi.has` fails; from `lefthook.yml` → `inLefthook.has` fails).

Noted at P3 only because the adjacent `ci:admin-contract` assertion it was modelled on has the
identical title/scope gap — this follows repo convention rather than departing from it. Worth
recording since the checklist has accepted this exact "title overclaims what the body proves"
class repeatedly.

---

# Verified clean (explicitly checked, no finding)

- **The two pinned sha256 values are correct.** `gh release download v8.30.1 --repo
  gitleaks/gitleaks --pattern '*checksums*'` into a `mktemp -d`; both lines match
  `.github/workflows/ci.yml` byte-for-byte:
  `551f6f…70eb  gitleaks_8.30.1_linux_x64.tar.gz` and
  `e4a487…b080  gitleaks_8.30.1_linux_arm64.tar.gz`. **No P0 here.** The ci.yml comment's claim
  that they "come from gitleaks' own published release checksums file, never invented" is true.
- **CI step ordering is correct.** The install step is inside the `lint` job, before
  `Run secret scan`; `sha256sum -c -` runs before `tar -xzf`; the archive is never executed
  before verification; `echo … >> "$GITHUB_PATH"` takes effect for the next step, which is the
  scan; `set -euo pipefail` is set, and an unknown `runner.arch` hard-exits 1 rather than
  skipping.
- **`origin/main` resolves in the `lint` job on a PR.** `actions/checkout` is pinned with
  `fetch-depth: 0`, which populates `refs/remotes/origin/*`; the pre-existing `ci:merge-ledger`
  and `ci:weakened-checks` steps in the same job already depend on it.
- **Draft / docs-only behaviour matches `.claude/CLAUDE.md` § CI & repo.** `lint` carries
  `if: github.event.pull_request.draft == false` and has no `needs:`, so a draft skips it and a
  docs-only PR still runs it — `edge_cases[4]` holds.
- **No other workflow breaks.** `pnpm ci:secret-scan` appears only in `ci.yml` and `lefthook.yml`
  (`git grep -l gitleaks HEAD_SHA` = 10 files, no other workflow). `cache-warm.yml`, `e2e.yml`,
  `react-doctor.yml`, `claude*.yml` reference no `ci:*` script. The `deploy-install` job runs
  `rm -rf .git` then the setup action — `prepare` installs lefthook but runs no hook, so it is
  unaffected.
- **`--report-path -` writes JSON to stdout in 8.30.1, and stdout is never shared.** Across every
  experiment, the ASCII banner and all `INF`/`ERR`/`FTL` lines went to stderr; stdout carried only
  `[]` or the JSON array. (`Q1c` answered.)
- **Missing or invalid `.gitleaks.toml` fails closed.** `--config nope.toml` → `FTL unable to
  load gitleaks config`, **empty stdout**, exit 1 → `parseReport` returns `null` → the script's
  error branch, exit 1. Same for malformed TOML. (`Q1d` answered.)
- **`[[allowlists]]` + `targetRules` + `regexTarget = "match"` is valid syntax in 8.30.1**, and
  the UUID block behaves as documented: a UUID-valued `client_turn_key` / `api_cost_id` fires
  `generic-api-key` under the default ruleset and is suppressed under the repo config (2 → 0),
  while a fake PEM outside the six allowlisted paths still fires. The config loads with no
  warning. (`Q4`, first half.)
- **Shallow clone is safe.** `git clone --depth 1` + `git fetch --depth 1 origin main`:
  `rev-parse --verify origin/main` resolves, `rev-list --count origin/main..HEAD` = 1, and the
  planted leak is caught (exit 1). No under-scan. (`Q1e`.)
- **Linked worktrees work.** gitleaks scans correctly with `.git` as a file — important, since
  `pnpm worktree:new` is the blessed workflow and the pre-push hook runs there.
- **Redaction invariant holds in the script.** `summarizeFindings` prints `RuleID` / `File` /
  `Commit` only, never `Secret` or `Match`.
- **No weakened checks.** Nothing removed, skipped, focused, or loosened in the test diff.

---

# Appendix — non-actionable / below the confidence bar

- **The deviations file's advisory-pass counts (328 → 20, "284 of 312 … were Postgres `uuid`
  columns") were not re-derived.** Re-running `gitleaks dir` over the whole worktree would have
  read `.env.local`, which the secret-handling rules forbid. The one sub-claim I could check
  without that — what fires in the six path-allowlisted files — came back **16 findings, 100%
  `generic-api-key`**, consistent with the doc's characterisation of the false-positive class.
  The four un-allowlisted residuals were not re-checked.
- **The install step switches on `runner.arch` but never `runner.os`,** and both branches select a
  `linux_*` asset. A macOS runner with `runner.arch == ARM64` would pass `sha256sum -c` (the
  checksum is the Linux asset's) and then fail at exec with a confusing error. `.claude/CLAUDE.md`
  says the parked self-hosted runner is a Mac-*hosted* **Linux** VM and every other lane is
  Linux, so this is currently unreachable — noted, not filed.
- **The error branch prints `scanResult.stderr` verbatim** (`secret-scan.ts:173`). gitleaks
  redacts its own log lines under `--redact`, and the branch only fires when gitleaks did not
  produce a report, so I could not construct a case where an unredacted value reaches it. Flagged
  as a thing to keep in mind if the error branch is ever widened.
- **`gitleaks` version drift between local and CI is unpinned** (`brew install gitleaks` tracks
  latest; CI pins 8.30.1). The arch-review-log already records this as the next pass's business,
  so it is a known open item rather than a finding.
- **Naming.** `scripts/ci/secret-scan.ts` has no `docs/directory/` row — correct, `ci:directory-map`
  covers `worker/` and `src/lib/` only.

---

# False doc claims (each re-resolved against `HEAD_SHA`)

1. `docs/audits/2026-07-06-codebase-audit-findings.md:44` — "**Update the rotation runbook**:
   **DONE** — … now covers provider/infra keys". The runbook's `## Scope` still lists only
   `ENCRYPTION_KEY` / `SESSION_COOKIE_SECRET` / `CSRF_SECRET`, and five of the six rotated keys
   have no procedure. (F3)
2. `docs/runbooks/secrets-rotation-api-keys.md` § Secret scan — "**Fails closed, always**"; and
   `scripts/ci/secret-scan.ts:15` — "FAIL CLOSED, on purpose, **in every branch**". Reproduced a
   green pass over a range containing a real finding. (F1)
3. `docs/runbooks/secrets-rotation-api-keys.md` § Secret scan — "prints **the scanned commit
   count**". It prints `git rev-list --count`'s range count, which is 0 on a `rev-list` failure,
   +1 in CI, and unrelated to what gitleaks scanned. Same wording in `observability[0]`. (F5)
4. `docs/runbooks/secrets-rotation-api-keys.md:54` — "`REDIS_QUEUE_TOKEN` (**Upstash**, 2 of 2)".
   `.env.example:36` and `docs/runbooks/deployment-guide.md:380` both say it is unused with
   Railway Redis, which needs no token. (F4a)
5. `docs/runbooks/secrets-rotation-api-keys.md:53-54` and
   `docs/audits/2026-07-06-codebase-audit-findings.md:37` — the two Upstash rows assert a
   "**still-live value** from the `keys.md` exposure". The 2026-07-06 row they replace said
   "Var renamed — **verify manually**", and nothing in the branch verifies it. (F4b)
6. `.github/workflows/ci.yml:241` — "Pinned to the **same gitleaks release installed locally**
   (docs/runbooks/secrets-rotation-api-keys.md "Secret scan")". That runbook section names no
   version, and no local pin exists; the citation resolves to nothing. (F8)
7. `.gitleaks.toml:20-27` — "…so this allowlist **cannot hide a real leak** under them". True of
   the UUID value block it annotates; false of the path block eleven lines below, which hides
   every rule in six files. (F2)

---

**VERDICT: REVISE**

F1 and F2 are the two that matter: the gate can report a green pass over a range that contains a
real finding, and six routinely-edited test files are exempt from every rule rather than the one
rule that false-positives. Both have small, verified fixes (a status + scanned-count check;
`targetRules` on the path block, or the value-pattern entry the locked decision actually asks
for). The rest — F3/F4's overstated permanent records, F5's misreported count, F6's merge blind
spot — are corrections to what the documentation promises, not rebuilds. The wiring, the pinned
checksums, the CI step ordering, the fail-closed config handling, and the redaction invariant all
check out.
