# Secrets Rotation: API Keys

Owner: founder
Cadence: quarterly and immediately after suspected exposure

## Scope

- ENCRYPTION_KEY
- SESSION_COOKIE_SECRET
- CSRF_SECRET

## Procedure

1. Generate replacement key material with a cryptographically secure generator.
2. Add replacement values to Railway and Vercel environment stores.
3. Deploy worker and app.
4. Verify admin endpoints, encrypted channel data reads, owner sessions, and CSRF-protected writes.
5. Remove old key material from all environment stores.
6. Record date, actor, and verification result in the rotation log.

## LLM provider keys — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`

Added 2026-09-16 after the first rotation of one. The procedure above does not fit: these keys are
issued by the provider, live in the Infisical `prod` vault, and reach Railway through the Secret
Sync. **Only the worker reads them** (`src/lib/config/worker.ts`), so Vercel needs no redeploy.

1. **Create** the replacement key in the provider console. Do not revoke anything yet.
2. **Write** it to Infisical project RepWorth, environment **`prod`** (the slug), in the UI. Never
   into a chat, a terminal argument, or a file.
3. **Confirm the hop by fingerprint, never by value** — vault and worker must match each other and
   differ from the old fingerprint:
   `railway variables -s repworth-worker -e production --json | jq -r '.ANTHROPIC_API_KEY' | tr -d '\n' | shasum -a 256 | cut -c1-12`
4. **Wait for Railway's automatic redeploy** to reach SUCCESS and `/ready` 200.
5. **Prove the new key is accepted** — prints a status code only:
   `railway run -s repworth-worker -e production -- sh -c 'curl -s -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"'` → `200`.
6. **Only then revoke** the old key, and prove it dead the same way (`401`).

**Traps.**
- **Revoke last.** OpenAI is primary and Anthropic is the fallback, so a revoked-before-replaced
  Anthropic key breaks nothing visible — drafts keep working — and silently removes the fallback.
  That is how it went wrong on 2026-09-16.
- **Never dump `railway variables --json` raw.** It prints every secret in plain text. Filter with
  `jq` to the key you need, or to a fingerprint. That is how the key was exposed on 2026-09-16.

## Rotation Log

| Date | Actor | Secret | Verification |
|---|---|---|---|
| 2026-09-16 | @norbertesekiel + agent | `ANTHROPIC_API_KEY` (prod) — exposed in an agent transcript by a raw `railway variables --json` dump. Fingerprint `f763cfa21038` → **`e19274db2ce6`** | Vault and worker fingerprints matched; Railway auto-redeploy `086b04bc` SUCCESS 2026-09-17T04:16:22Z, `/ready` 200; new key **200** on `GET /v1/models`; old key **401** (revoked). Record: `evidence/2026-09-16-anthropic-key-rotation.md` |
| 2026-09-20 | @norbertesekiel | `OPENAI_API_KEY` — value exposed in `keys.md` (commit `24353cf1`, audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | `SERPAPI_API_KEY` — value exposed in `keys.md` (commit `24353cf1`, audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | `NEXT_PUBLIC_SUPABASE_ANON_KEY` — value exposed in `keys.md` (commit `24353cf1`, audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | Upstash **cache** credential (1 of 2) — today it lives in `REDIS_CACHE_URL` (the token is embedded in the `rediss://…upstash.io` URL) and in `REDIS_CACHE_TOKEN`, which carries it separately only for Upstash's REST form. Value exposed in `keys.md` (commit `24353cf1`, audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | Upstash **queue** credential (2 of 2) — `REDIS_QUEUE_TOKEN`: queue Redis credential at the time of the exposure; the queue has since moved to Railway Redis and this variable is unused (`.env.example`, `deployment-guide.md` §1.4). Value exposed in `keys.md` (commit `24353cf1`, audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | `STRIPE_SECRET_KEY` (test-mode) — value exposed in `keys.md` (commit `24353cf1`, audit C1) | owner-reported; not independently verified; no fingerprint recorded |

## History scrub decision

**Decision: no scrub.** No `git filter-repo`, no BFG, no force-push. Decided
2026-09-21 by the owner.

**Reason:** every value exposed by commit `24353cf1`'s root `keys.md` is
rotated and dead (the six rows above, 2026-09-20). A history rewrite plus
force-push breaks every existing clone, worktree, and open PR — real,
immediate cost — for the sake of scrubbing values that no longer grant
access. Low value for the disruption.

**Revisit trigger:** any of the six values above is found live against its
provider. If that happens, scrub becomes the answer regardless of
disruption cost — re-open this decision rather than re-litigating it from
scratch.

## Secret scan

`pnpm ci:secret-scan` (`scripts/ci/secret-scan.ts`) runs gitleaks over the
commit range `<base ref>..HEAD` — the commits a push or PR adds, never the
working tree — with `--redact` always on, config `.gitleaks.toml`
(`[extend] useDefault = true`, so the full default ruleset applies, including
the `jwt` rule that covers `NEXT_PUBLIC_SUPABASE_ANON_KEY`). The base ref is
`origin/main` by default and `origin/$GITHUB_BASE_REF` on a PR opened against
another branch, resolved by `baseRefFor()` in `scripts/ci/merge-ledger-audit.ts`
— the same resolver the merge-ledger and weakened-checks audits use, so a
`staging`-based PR scans only the commits it authored. It runs in two places:

- **Locally**, in lefthook's `pre-push` hook (`secret-scan` command). A
  machine without the `gitleaks` binary fails the hook outright and prints
  the install command. `git push --no-verify` is the WIP escape hatch — CI
  is the backstop that still runs the real scan.
- **In CI**, as a named `Run secret scan` step in `.github/workflows/ci.yml`'s
  `lint` job, after an inline step that downloads the pinned gitleaks release
  for the runner's architecture and verifies its sha256 **before** extracting
  or running it. A checksum mismatch fails the job.

**Version: CI is pinned, your machine is not.** CI pins **gitleaks 8.30.1** by
sha256 (`.github/workflows/ci.yml`, `GITLEAKS_VERSION`). A developer machine
runs whatever Homebrew installed — `brew install gitleaks`, unpinned, no local
pin exists — so the two *can* drift. That is why the scan's **first line of
output** names the local version beside the CI pin, in both the hook and the
CI log:

```
secret-scan: gitleaks 8.30.1 (local install; CI pins 8.30.1 by sha256) — range origin/main..HEAD
```

If those two numbers differ and a finding disagrees between local and CI, that
line is the first thing to read. `brew upgrade gitleaks` (or bumping
`GITLEAKS_VERSION` and both checksums in `ci.yml`) is how they are brought back
together.

**The command shape** the script runs, once the base ref has been resolved:

```
gitleaks git --log-opts="--diff-merges=remerge <base ref>..HEAD" \
  --redact --no-color --config .gitleaks.toml \
  --report-format json --report-path - .
```

`--diff-merges=remerge` (git ≥ 2.35) is load-bearing: `git log -p` shows **no**
diff for a merge commit, so without it a credential pasted in while resolving a
merge conflict is never read, even though the merge commit is inside the range.
Measured against 8.30.1 on a scratch repo whose merge resolution introduced a
key present in neither parent — `-m` finds it but reports it twice, `--cc` and
`-c` find nothing, `--first-parent -m` finds it but drops every side-branch
commit; only `remerge` reports the resolution exactly once and still scans the
whole range.

**Fails closed, always** — "a gate that cannot see must never pass." A PASS
requires *all four* of: gitleaks exited 0; its JSON report is `[]`; its own
`N commits scanned` count is **at least** the number of commits in the range
that add at least one text line (git is asked with the same `--diff-merges`
flag); and its stderr carries no git error marker. The count check is a **lower
bound, not an equality**: gitleaks counts every commit that adds a text line,
and it also counts some that only remove lines from a surviving file, so a
line-deletion-only commit or a revert legitimately makes gitleaks' count the
higher of the two. Scanning *fewer* commits than the range's text-adding
commits is the failure — it means the scan stopped short. Each of these fails
the scan:

- an absent `gitleaks` binary (prints the install command);
- an unresolvable base ref (run `git fetch origin`);
- a `git log` that cannot be read — the commit count is never silently `0`;
- a gitleaks error that is not a finding (nothing parseable on stdout);
- **an empty report from a scan that did not happen.** gitleaks aborts on any
  non-empty stderr from its own `git log` — an uninstalled `.gitattributes`
  textconv driver, a partial clone that cannot fetch a blob, a `warning:` from
  a damaged commit-graph — and then prints `ERR error="stderr is not empty"`,
  `0 commits scanned`, `[]` on stdout, and **exits 0**. Before the round-1
  review of #1374 that read as a pass with a real key in the range.

An empty range (nothing new since the base ref) exits 0 and prints
`passed (0 commit(s) scanned in …)` — gitleaks' own count, so a vacuous pass
is visible rather than silent.

**Known limit — `.gitattributes` can hide a file from the scan.** The count
check catches a scan that *stopped*; it does **not** prove every byte in the
range was read, and a sufficient count is not evidence of full coverage. A file
that `.gitattributes` marks `-diff` or `binary` produces no text hunk in
`git log -p`, so gitleaks never sees its content — and git's `--numstat` reports
`-`/`-` for it too, so the script's own minimum does not rise either. Measured
on 8.30.1: a complete PEM committed as `*.pem` **with** a `-diff` attribute
passes this gate; the identical commit without the attribute fails it. This is a
gitleaks-level limitation, not something the script can close without modelling
git attributes itself. Practical guard: **a PR that adds `-diff` or `binary`
attributes for a text file deserves a human look** — ask what the attribute is
for before approving it.

The same mechanism has a false-FAIL direction, and it is the one a developer
would have to debug: a `.gitattributes` `diff=<driver>` whose `textconv` command
succeeds but prints nothing makes `--numstat` count the added lines while
`git log -p` emits no hunk, so gitleaks scans fewer commits than the minimum and
the gate fails on a clean range **with no `ERR` or `fatal:` line to explain it**.
No such driver is configured in this repo today. If the shortfall message
appears on a range you know is clean, check `.gitattributes` and
`git config --get-regexp '^diff\..*\.textconv$'` first.

**On a finding:** rotate the value FIRST (see the procedures above), *then*
remove it from the file — never just delete the line and leave the old value
live in history. A finding blocks the push/PR until it is either fixed or
allowlisted.

**Adding an allowlist entry:** edit `.gitleaks.toml`. Prefer a value-pattern
regex under `[[allowlists]]` over a path entry — a path entry is reserved for a
file that exists solely as a fixture. **Either kind MUST carry `targetRules`**,
scoping it to the rule it is a false positive for: an allowlist with no
`targetRules` disables every rule in the default set (~200 of them, including
`private-key`, `openai-api-key` and `jwt`) for whatever it matches. An unscoped
path entry shipped in the first cut of this gate and hid a planted private key
in six live test suites. Every entry needs a reason comment: what class of
false positive it suppresses and why it is safe to. Never add an entry to hide
a real secret instead of rotating it.

**The recorded drill (2026-09-21, gitleaks 8.30.1, `brew install gitleaks`):**
in a scratch git repository (`mktemp -d`, outside this repo, never committed
here), a file containing a fake, runtime-assembled key-shaped string was
committed, then deleted in a following commit. Running the command shape above
over that range exited **1**, and gitleaks' own JSON report (written to stdout)
redacted the value in both the `Secret` and `Match` fields
(`"Secret": "REDACTED"`). No secret value appeared in any terminal output,
file, or document at any point in the drill.

**How to build the fake value — a recipe, never a literal.** Most key-shaped
strings a reader invents are *not* detected, so reproducing the drill with the
wrong shape looks like a broken gate. Confirmed non-detections on 8.30.1: a
vendor prefix followed by ~90 identical characters (below the rule's entropy
floor); the same prefix followed by 95 random `[A-Za-z0-9_-]` characters (wrong
length/suffix shape for the vendor rule); a PEM opening line with no matching
closing line. What *is* detected, by the default ruleset's **`private-key`**
rule, is a **complete PEM block**: the standard PEM opening line (five hyphens,
then `BEGIN RSA PRIVATE KEY`, then five hyphens), at least one line of base64
body, and the matching closing line (the same shape, with `END` where the
opening line has `BEGIN`).

Neither marker is written out in full in this runbook, and nothing you copy from
here should be. The `private-key` rule matches from an opening marker through to
the next closing one **wherever they sit**, prose included, when enough text
separates them (measured on 8.30.1: about 64 characters or more), so a complete
pair written into a doc can itself be a finding — in this file it was: the first
cut of this paragraph spelled both markers out and the branch failed its own
scan. Do not rely on the exceptions: `.env.example` carries an adjacent pair that
is too short to match, and a committed review report carries a pair that
gitleaks' default global allowlist happens to drop. So: no part of the value,
markers included, is typed as a literal here; every part is assembled at run
time inside the scratch directory, e.g. in `bash`:

```bash
dash5=$(printf '%.0s-' $(seq 5))     # the PEM delimiter, never typed as a literal
kind='RSA PRIVATE KEY'
{
  printf '%sBEGIN %s%s\n' "$dash5" "$kind" "$dash5"
  head -c 600 /dev/urandom | base64 | fold -w 64
  printf '%sEND %s%s\n' "$dash5" "$kind" "$dash5"
} > fake-key.txt
```

`git add fake-key.txt && git commit`, then `git rm` it in a following commit,
and the command shape above over that range reports exactly one `private-key`
finding with `"Secret": "REDACTED"`. As little as 48 bytes of entropy (one
64-character body line) is enough to fire the rule.

Full counts from the advisory full-tree pass that shaped `.gitleaks.toml`'s
allowlist: `docs/superpowers/plans/feat-1374-secret-scan-deviations.md`.
