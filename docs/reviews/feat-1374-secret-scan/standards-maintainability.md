# Review — standards & maintainability (axis report)

- **Axis:** standards & maintainability (thermo-nuclear maintainability pass)
- **MERGE_BASE:** `75c8d54cb77ac34d1f2f7686b9171528871b81f3`
- **HEAD_SHA:** `e2c3ac36e53b3a968b52c3129538a4ff3adf12ef`
- **Read from:** committed SHA only (`git show`/`git diff`/`git grep` at `$HEAD_SHA`). No tests or pnpm scripts run. No `.env*` read. Commit `24353cf1c` and `keys.md` never inspected. No secret value appears in this document.

## Measured diff size

`git diff --numstat 75c8d54 e2c3ac3`, tests excluded (`scripts/ci/__tests__/secret-scan.test.ts` 130/0, `src/__tests__/ci-audit-wiring.test.ts` 6/0), the run's own paperwork excluded (`docs/superpowers/plans/feat-1374-secret-scan-{intake.json,deviations.md}` 93/0 + 285/0):

| File | +/− |
|---|---|
| `scripts/ci/secret-scan.ts` (new) | 196 / 0 |
| `docs/runbooks/secrets-rotation-api-keys.md` | 76 / 0 |
| `.gitleaks.toml` (new) | 47 / 0 |
| `.github/workflows/ci.yml` | 36 / 0 |
| `docs/audits/2026-07-06-codebase-audit-findings.md` | 19 / 17 |
| `lefthook.yml` | 5 / 0 |
| `.claude/reference/arch-review-log.md` | 2 / 0 |
| `package.json` | 1 / 0 |
| **production total** | **382 / 17** |

Matches the deviations file's own 397 (it counts the audit doc's 17 deletions as changed lines). The 110-line estimate was wrong; the implemented scope is not. **131 of the 382 lines are prose and config, not code.**

---

## Answers to the specific questions asked

**Is `scripts/ci/secret-scan.ts` (196 lines) the smallest honest implementation?** Substantially yes, and the size is *not* the problem. Comment density is 33 header lines + ~15 docblock lines over 196 total (~24%); the named precedent `scripts/ci/merge-ledger-audit.ts` is 43 header lines over 264 (~23% with docblocks). **The header does not restate the body** — it records three things the body cannot show: the empirically-verified gitleaks exit-0-on-unknown-ref trap (the entire reason `git rev-parse` runs first), why stdout-JSON beats log-text matching, and why the gate fails closed. That is the precedent's own idiom. Not a finding. Every export is consumed by the test file (`RANGE`, `GITLEAKS_CONFIG_PATH`, `GITLEAKS_INSTALL_HELP`, `runSecretScan`, `ExecFn`, `ExecResult`) — same as `merge-ledger-audit.ts`'s `LEDGER_PATH`/`GOVERNANCE_PATHS`; no export is dead. `summarizeFindings`, `parseReport` and `ok` are single-caller local helpers, which the precedent file also uses freely. The real residue is smaller and named in F4/F5.

**`inCi`/`env`:** `env` feeds only a cosmetic ` (CI)` suffix on one log line, and every one of the seven tests passes `env: {}`, so the branch is never exercised. But `runSecretScan({ exec, env, log })` is a **locked intake `test_seams` entry** — not mine to re-litigate. Appendix only.

**Naming vs the `*-audit.ts` convention:** F6. It deviates from 20/20 siblings and breaks nothing mechanical — confirmed: `scripts/verify-gate.sh:398-401` derives the audit set from `package.json`'s `ci:*` keys (not filenames), and `scripts/ci/directory-map-audit.ts:66` scans only `['worker', 'src/lib']`, so **`docs/directory.md` does not cover `scripts/` and no row is owed** (confirmed as asked).

**Is 8.30.1 pinned in exactly one place?** Yes — `.github/workflows/ci.yml:251` is the sole pin; `scripts/ci/secret-scan.ts:15` names it only as a "verified against" note and `.claude/reference/arch-review-log.md:3` is a historical row. The runbook names no version. **The defect is the opposite of what was feared:** the pin is single-owned, but two places assert a *second*, non-existent pin. See F1.

**Does the inline 30-line bash match how this workflow handles other binaries?** It is the only inline binary download in `ci.yml` — every other third-party input is either `uses: <action>@<commit-sha>` or `npm install -g fallow@3.16.0` (`ci.yml:466`). Both of those are version-pinned, and the gitleaks step pins version **and** sha256, so the repo rule ("third-party actions pinned to commit SHAs") is honored in spirit and exceeded in strength. No composite action is the locked decision. Not a finding.

**Does `.gitleaks.toml`'s comment block belong in the config?** Yes. The branch's own runbook section (`docs/runbooks/secrets-rotation-api-keys.md:103-108`) makes "every entry needs a reason comment" the rule, and a reason that lives one file away from the entry is a reason that goes stale. Locality is correct here. Not a finding — but see F2 for what the comment *claims* versus what the entry *does*.

**Does the runbook's "Secret scan" section duplicate the script header / lefthook comment?** Three restatements of "fails closed on an absent binary or an unresolvable `origin/main`" exist (script:11-13, `lefthook.yml:84-86`, `ci.yml:275-276`) plus a fourth, longer one in the runbook (`:92-97`). **Precedent sanctions the first three:** `ci.yml:238-241`'s weakened-checks comment and `lefthook.yml:79-80`'s merge-ledger comment both restate a script's behavior and cite the script. The runbook restatement is the operator-facing copy and is defensible. Appendix, not a finding.

**Do the unit tests couple to argv order?** No — and this is the best part of the diff. `keyFor()` (test:25-31) dispatches on `command` + `args[0]` only; the argv assertions are `toContain('--redact')` / `toContain('--log-opts=…')` / `toContain(GITLEAKS_CONFIG_PATH)`, i.e. set membership, never order or index. The fake is keyed by call *purpose*, so each test states one response and defaults the rest. That is behavior coupling, not argv coupling. Not a finding.

**Is the rewritten audit item C1 consistent with how other items record partial completion?** Yes. `docs/audits/2026-07-06-codebase-audit-findings.md` already uses `[ ]`/`[x]` checkboxes, a `**Verified**` marker and a strikethrough-plus-note form in the fix-order list; C1 now uses `[x]` + a dated status line + per-step `DONE`/`DECIDED` + a struck fix-order entry. The added "Status as of 2026-09-20" column preserves the original 2026-07-06 column rather than overwriting it, and every owner-reported row carries "not independently verified; no fingerprint recorded" — the honest form. Not a finding.

---

## Findings

### F1 — [P2] `ci.yml` and the runbook assert a local-version pin that does not exist

**File:** `.github/workflows/ci.yml:243-244`, `docs/runbooks/secrets-rotation-api-keys.md:87-88`

**Standard violated:** CLAUDE.md, Gate evidence — "Green CI is not proof that documentation is true. Re-check cited line numbers and doc claims against current HEAD before repeating them." Also the one-owner-per-fact rule (`docs/agents/context-layout.md`): a comment that cites a doc as the owner of a fact that doc does not state has no owner at all.

**Evidence:**
- `ci.yml:243-244`: `# #1374. Pinned to the same gitleaks release installed locally` / `# (docs/runbooks/secrets-rotation-api-keys.md "Secret scan"); …`
- The cited section (`secrets-rotation-api-keys.md:73-110`) names **no version number** anywhere. `git grep 8.30.1 $HEAD_SHA` returns exactly three hits: `ci.yml:251`, `secret-scan.ts:15` (a "verified against" note), `arch-review-log.md:3` (a historical row).
- The local install path is unpinned by construction: `GITLEAKS_INSTALL_HELP` (`scripts/ci/secret-scan.ts:44-47`) says `brew install gitleaks` — whatever Homebrew ships that day.
- `secrets-rotation-api-keys.md:87-88` repeats it: "downloads the pinned gitleaks release **(same version as local)**".
- The branch's own arch-log row already records the gap as a deferred item: "Next pass: the gitleaks version is pinned in ci.yml only — a local brew upgrade can drift from CI." So the branch ships a claim in two places that a third place contradicts.

**Why it matters beyond prose accuracy:** `.gitleaks.toml` sets `[extend] useDefault = true`. The default ruleset changes between gitleaks releases, so an unpinned local binary and a pinned CI binary can legitimately disagree on findings — a developer's green pre-push is not evidence of a green `lint` job. The two comments tell the next reader it is.

**Smallest maintainable correction:** delete the false clause from both — `ci.yml:243-244` becomes "Pinned for CI; the local install is deliberately unpinned (`brew install gitleaks`), so local and CI can differ on default-ruleset changes", and drop "(same version as local)" from `secrets-rotation-api-keys.md:88`. (If a true pin is wanted instead, the runbook's "Secret scan" § is the right single owner for the number and `ci.yml`'s `GITLEAKS_VERSION` cites it — but that is a bigger change than this finding requires.)

---

### F2 — [P2] The path allowlist disables **every** gitleaks rule in six live test suites, against the branch's own locked invariant

**File:** `.gitleaks.toml:38-47`

**Standard violated:** the branch's own locked intake invariant — *"Prefer a value-pattern entry over a path entry; a path entry is only for a file that exists solely as a fixture."* (`feat-1374-secret-scan-intake.json`, `invariants[4]`), restated as repo doctrine in `secrets-rotation-api-keys.md:103-108`. Also `security-and-hardening` / constraint-weakening: a suppression broader than the false positive it was written for.

**Evidence:** the block carries no `targetRules`, so unlike its sibling at `.gitleaks.toml:30-36` it suppresses the full inherited default ruleset — `aws-access-token`, `stripe-access-token`, `openai-api-key`, `anthropic-api-key`, `jwt`, `private-key`, `gcp-api-key`, `telegram-bot-api-token` included — for six files:
`worker/ingress/__tests__/unsubscribe{,-rate-limit,-single-flight}.test.ts`, `src/lib/notifications/email/__tests__/{send-email,solicitation-client}.test.ts`, `src/lib/shared/__tests__/migration-096-solicitation-suppressions.integration.test.ts`.

These are behavior suites (rate limiting, single-flight, email send, a migration integration suite), not fixture files. The comment above the block asserts the opposite in the locked decision's own words — *"reserved for a file that exists SOLELY as a fixture … these test suites exist only to assert behavior around token/key-shaped literals"* — which is self-contradicting in a single sentence: a suite that asserts behavior is not solely a fixture.

The branch's deviations file already routes this to the review wave rather than settling it: *"the path entry covers six TEST SUITES, and the locked decision reserved a path entry for 'a file that exists solely as a fixture'. A test suite is not solely a fixture, and a path entry hides every rule in that file."* This finding is that question answered: the scope is too wide.

**Consequence:** a real `sk-…`, `sk_live_…` or `BEGIN PRIVATE KEY` pasted into any of those six files — the exact `keys.md` failure class this branch exists to prevent — passes the gate silently in both lanes. The 28 non-`generic-api-key` findings from the advisory pass were all vendor-shape rules, which is precisely what this block turns off.

**Smallest maintainable correction:** one line. Add `targetRules = ["generic-api-key"]` to the path block, matching the sibling value-pattern block at `.gitleaks.toml:32`. Every false positive the block was written for is still suppressed; every vendor-shape rule still fires in those files. Update the block's comment to say what it now does (suppress the catch-all heuristic in fixture-dense suites) rather than restating the "solely a fixture" claim it does not satisfy.

---

### F3 — [P3] `RANGE` hardcodes `origin/main`, re-spelling a fact the repo already owns in `baseRefFor()`

**File:** `scripts/ci/secret-scan.ts:39` (`export const RANGE = 'origin/main..HEAD';`), used at `:117`, `:126`, `:132`

**Standard violated:** one owner per fact (`docs/agents/context-layout.md`), and the intake's own `existing_patterns_to_follow[0]` — *"`scripts/ci/merge-ledger-audit.ts` … an audit with an injected exec seam and a loud failure when origin/main is absent."*

**Evidence:** the repo has a single exported owner for "which ref is this diff based on": `merge-ledger-audit.ts:156-158`, `export function baseRefFor(githubBaseRef) { return githubBaseRef ? 'origin/' + githubBaseRef : 'origin/main'; }`. `weakened-checks-audit.ts:41` imports it (`import { baseRefFor, isTestFile } from './merge-ledger-audit'`) and uses it at `:220`. `feature-surface-audit.ts:149` re-spells the same expression inline. `secret-scan.ts` is now the third spelling and the only one that ignores `GITHUB_BASE_REF` entirely.

**Consequence:** on a PR whose base is not `main` (the repo keeps a long-lived `staging` branch), the gate scans `origin/main..HEAD`, which includes every commit on the base branch that is not on `main` — commits the PR did not author. Not a false-negative (the range is a superset), but a gate that can fail a PR for a commit outside it is a gate developers learn to `--no-verify` past. Note the mitigating context: the intake's non-goals do literally say *"The range is origin/main..HEAD only"*, so the pin may be deliberate — but nothing in the file says so.

**Smallest maintainable correction:** either `const RANGE = \`${baseRefFor(process.env.GITHUB_BASE_REF)}..HEAD\`` (reuse the existing owner; the `env` dep is already injected, so pass it through instead of reading `process.env`), **or** add one header sentence naming the deliberate departure from the precedent the intake cites — an unrecorded departure reads as an unconsidered one.

---

### F4 — [P3] The commit count degrades silently to `0`, making a broken count indistinguishable from the "vacuous pass" the design says must be visible

**File:** `scripts/ci/secret-scan.ts:126-128`

**Standard violated:** CLAUDE.md working rules — "No silent catches." And this file's own header contract (`:11-13`): *"FAIL CLOSED, on purpose, in every branch."*

**Evidence:**
```ts
const countResult = exec('git', ['rev-list', '--count', RANGE]);
const scannedCommits = ok(countResult) ? Number.parseInt(countResult.stdout.trim(), 10) : 0;
const commitCount = Number.isFinite(scannedCommits) ? scannedCommits : 0;
```
A failed or non-numeric `git rev-list` yields `0`, and the success path at `:146` then prints `secret-scan: passed (0 commit(s) scanned in origin/main..HEAD)`. That string is the *exact* signal the intake and the runbook designate as the visible-vacuous-pass indicator (`secrets-rotation-api-keys.md:95-97`: "An empty range … exits 0 but prints the scanned commit count, so a vacuous pass is visible rather than silent"). A count failure therefore impersonates the one condition the count exists to disambiguate. Every other unknown in this file fails closed; this one alone falls back.

Secondary: two locals for one value. `scannedCommits` is already `0` on the `!ok` path, so `Number.isFinite` is guarding only the non-numeric-stdout case.

**Smallest maintainable correction:** collapse to one local and fail closed, matching every other branch —
```ts
const count = ok(countResult) ? Number.parseInt(countResult.stdout.trim(), 10) : Number.NaN;
if (!Number.isFinite(count)) { /* log + return { exitCode: 1, … } */ }
```
Add the eighth test case alongside the existing seven (`git-count` returning `status: 1`), which the `fakeExec` override map already supports with no new scaffolding.

---

### F5 — [P3] `ScanOutcome.message` is a second output channel for a string that already has one

**File:** `scripts/ci/secret-scan.ts:65-68`, `:106-171`, `:183-192`

**Standard violated:** module depth / single producer per fact; test coupling to a field that exists only for tests.

**Evidence:** every return site builds `message`, passes it to `log(message)`, *and* returns it. `main()` (`:183-192`) reads only `outcome.exitCode` — `message` has no production consumer. All seven tests pass `noopLog` and assert on `result.message`, so the field's sole reason to exist is the test. The precedent does not do this: `merge-ledger-audit.ts` returns an `AuditReport { text, exitCode }` that `emit()` is the *only* printer of — one producer, one consumer, and the tests assert on the returned report because nothing else prints it.

**Consequence:** the log line and the returned string are kept identical by hand at six sites. Nothing fails if they drift, and the tests — which read the return value — would not notice if the *logged* text (the thing a developer actually sees on a failed push) became wrong.

**Smallest maintainable correction:** follow the precedent — have `runSecretScan` return the outcome and let `main()` be the only caller of `console.log`, dropping `log` from `SecretScanDeps`. If `log` must stay (streaming progress), drop `message` and assert on captured log lines using the same recorder array the test file already threads through `fakeExec`. Either way the string gets one producer.

---

### F6 — [P3] `secret-scan.ts` breaks the `*-audit.ts` convention of every sibling gate script

**File:** `scripts/ci/secret-scan.ts` (and `package.json:49`)

**Standard violated:** CLAUDE.md working rules — check the folder's existing shape before adding a file; naming consistency as a navigation affordance.

**Evidence:** every other `ci:*` script declared in `package.json:25-48` resolves to `scripts/ci/<name>-audit.ts` — 20 of 20. The only two non-`-audit` entries are `ci:fallow` (an external binary) and `ci:fallow:coverage` (whose `normalize-v8-coverage.ts` is a preprocessor, not a gate). `secret-scan.ts` is the first *gate* in the folder not to carry the suffix.

**Costs nothing mechanically, confirmed:** `scripts/verify-gate.sh:398-401` derives the audit set from `package.json`'s `ci:*` keys, not from filenames; `scripts/ci/directory-map-audit.ts:66` scans `['worker', 'src/lib']` only, so `docs/directory.md` does not cover `scripts/` and no directory row is owed; `src/__tests__/ci-audit-wiring.test.ts` keys on script names. So the whole cost is the `ls scripts/ci/` affordance.

**Smallest maintainable correction:** rename to `secret-scan-audit.ts` — two references (`package.json:49`, the test's `from '../secret-scan'`). Alternatively keep the name and record why in the header (it is a scanner over commit contents, not an audit of the repo's own source text, which is a real distinction) — but pick one deliberately rather than by default.

---

## Appendix — observations below the 80% bar, or already precedent-sanctioned (non-actionable)

- **`env` / `inCi` (`secret-scan.ts:59-63`, `:107-108`)** — the injected `env` feeds only a cosmetic ` (CI)` suffix on the opening log line, and all seven tests pass `env: {}`, so the branch is never exercised. `runSecretScan({ exec, env, log })` is a **locked intake `test_seams` entry**, so the signature is not re-litigable here. If F5 is taken, `env` naturally goes with `log`.
- **Four restatements of the fail-closed contract** (`secret-scan.ts:11-13`, `lefthook.yml:84-86`, `ci.yml:275-276`, `secrets-rotation-api-keys.md:92-97`). Precedent sanctions the ci.yml and lefthook copies: `ci.yml:238-241` and `lefthook.yml:79-80` both restate a script's behavior in one or two lines and cite the script. The runbook copy is the operator-facing one. Not raised as a finding, but it is the surface a future behavior change will leave stale in four places.
- **`summarizeFindings`'s `> 5` branch (`secret-scan.ts:98`)** — the `"… and N more"` path has no test. Low value; the branch is three tokens and cannot hide a secret (it prints a count).
- **Advisory-pass provenance of the allowlists** — both `.gitleaks.toml` entries were tuned against a **full-tree** `gitleaks dir` pass, while the gate only ever reads `origin/main..HEAD`. The UUID value-pattern entry is genuinely load-bearing (new `docs/runbooks/evidence/**` run logs are committed regularly and carry UUIDs). The path entries are more speculative — they only fire if one of those six suites is edited again. Folded into F2 rather than raised separately.
- **`spawnSync` vs the siblings' `execFileSync`** — a real divergence, and the right one: `spawnSync` returns a status instead of throwing, which is what a gate that must classify exit codes needs. Not a finding.
- **The `ci-audit-wiring.test.ts` addition (`:77-82`)** is strictly redundant with the file's own `it.each(declared)` sweep at `:88-96`, but it exactly mirrors the `ci:admin-contract` block at `:72-76` that the intake names as the pattern to follow. Consistent with precedent; not raised.

---

## Verdict

**VERDICT: REVISE** — no P0/P1. Two P2s, both one-line corrections: F2 widens a suppression past the branch's own locked invariant in the one direction that matters (vendor-shape rules off in six live suites), and F1 ships a doc claim the branch's own arch-log row contradicts. The four P3s are cleanups. The core design — commit-range scan, fail-closed in every branch, injected `exec` seam, behavior-coupled tests, pinned checksum-verified CI binary — is sound and matches its named precedent.
