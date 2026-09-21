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
| 2026-09-20 | @norbertesekiel | `OPENAI_API_KEY` — still-live value from the `keys.md` exposure in commit `24353cf1` (audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | `SERPAPI_API_KEY` — still-live value from the `keys.md` exposure in commit `24353cf1` (audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | `NEXT_PUBLIC_SUPABASE_ANON_KEY` — still-live value from the `keys.md` exposure in commit `24353cf1` (audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | `REDIS_CACHE_TOKEN` (Upstash, 1 of 2) — still-live value from the `keys.md` exposure in commit `24353cf1` (audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | `REDIS_QUEUE_TOKEN` (Upstash, 2 of 2) — still-live value from the `keys.md` exposure in commit `24353cf1` (audit C1) | owner-reported; not independently verified; no fingerprint recorded |
| 2026-09-20 | @norbertesekiel | `STRIPE_SECRET_KEY` (test-mode) — still-live value from the `keys.md` exposure in commit `24353cf1` (audit C1) | owner-reported; not independently verified; no fingerprint recorded |

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
commit range `origin/main..HEAD` — the commits a push or PR adds, never the
working tree — with `--redact` always on, config `.gitleaks.toml`
(`[extend] useDefault = true`, so the full default ruleset applies, including
the `jwt` rule that covers `NEXT_PUBLIC_SUPABASE_ANON_KEY`). It runs in two
places:

- **Locally**, in lefthook's `pre-push` hook (`secret-scan` command). A
  machine without the `gitleaks` binary fails the hook outright and prints
  the install command. `git push --no-verify` is the WIP escape hatch — CI
  is the backstop that still runs the real scan.
- **In CI**, as a named `Run secret scan` step in `.github/workflows/ci.yml`'s
  `lint` job, after an inline step that downloads the pinned gitleaks release
  (same version as local) for the runner's architecture and verifies its
  sha256 **before** extracting or running it. A checksum mismatch fails the
  job.

**Fails closed, always:** an absent `gitleaks` binary, an unresolvable
`origin/main`, or a gitleaks error that is not a finding all exit non-zero —
"a gate that cannot see must never pass." An empty range (nothing new since
`origin/main`) exits 0 but prints the scanned commit count, so a vacuous pass
is visible rather than silent.

**On a finding:** rotate the value FIRST (see the procedures above), *then*
remove it from the file — never just delete the line and leave the old value
live in history. A finding blocks the push/PR until it is either fixed or
allowlisted.

**Adding an allowlist entry:** edit `.gitleaks.toml`. Prefer a value-pattern
regex under `[[allowlists]]` (scoped with `targetRules` to the one rule it's
a false positive for) over a path entry — a path entry is reserved for a
file that exists solely as a fixture. Every entry needs a reason comment:
what class of false positive it suppresses and why it is safe to. Never add
an entry to hide a real secret instead of rotating it.

**The recorded drill (2026-09-21):** in a scratch git repository (outside
this repo, never committed here), a file containing a fake, runtime-assembled
key-shaped string was committed, then deleted in a following commit. Running
the same command shape this script uses —

```
gitleaks git --log-opts=<oldest>..HEAD --redact --config .gitleaks.toml \
  --report-format json --report-path - .
```

— over that two-commit range exited **1**, and gitleaks' own JSON report
(written to stdout) redacted the value in both the `Secret` and `Match`
fields (`"Secret": "REDACTED"`). No secret value appeared in any terminal
output, file, or document at any point in the drill. Full counts from the
advisory full-tree pass that shaped `.gitleaks.toml`'s allowlist:
`docs/superpowers/plans/feat-1374-secret-scan-deviations.md`.
