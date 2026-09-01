# Evidence — E-F1 secret rotation (production)

Runbooks: [`secrets-rotation-zernio.md`](../secrets-rotation-zernio.md) ·
[`secrets-rotation-email-and-messaging.md`](../secrets-rotation-email-and-messaging.md)
Incident: **E-F1** — `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md`
Standing owed item: `beta-production-standup.md` § Phase E.

---

## Why this exists

`infisical secrets --projectId … --env prod` printed **plaintext values** into a session
transcript on 2026-08-31. Its own `--show-values` help claims masking is the default. It is
not. Three production secrets were exposed:

| Key | What the exposed value can do |
|---|---|
| `RESEND_API_KEY` | send mail as `notifications@repworth.net`; read and alter webhook config |
| `ZERNIO_API_KEY` | read profiles and **POST replies** for any connected Google account |
| `ZERNIO_WEBHOOK_SECRET` | forge `review.*` / `account.*` events into production ingress |

**Blast radius today is near zero and closes at the first connected location.** The
production database is zero-state, no Google Business Profile is connected, and a forged
`review.new` fans out to zero rows. This rotation runs *before* that window closes, not after.

---

## Environment

| Field | Value |
|---|---|
| Target | **production only.** Staging holds different keys at both providers (E-F3, verified by fingerprint) and is not rotated here |
| Vault | Infisical project `1735b0d0-286e-4ca3-a53b-f3a7191b163c`, env slug **`prod`** — *not* `production` (trap 8) |
| Sync targets | **Vercel `Production` AND Railway `production`** — one vault write deploys both (trap 11 → trap 2) |
| Railway | project `ad641d0e-dc01-4250-b71c-db1beedb9c8c`, env `production` = `f8fcd938-9995-429f-b280-4ddde4c76c7e`, service `repworth-worker` — **one service shared with staging, always pass the environment** |
| Vercel | project `rep-worth`, `Production` env. **Vercel needs a redeploy to pick up an env change** |
| Zernio subscription | **`6a95315320358f33c89599e5`** — 4 events, active. Its `secret` must move **with** the vault value |
| Resend endpoint | `3de61a3d-b4d5-416c-a0db-5d581d730a02` — 4 events, enabled. Its `RESEND_WEBHOOK_SECRET` is **provider-issued and NOT in scope** |
| Git SHA at start | `90f8c6d8` (`main`, after PR #1062) |
| UTC start | **2026-09-01T21:46Z** |
| Owner | @norbertesekiel — creates both provider keys; no value passes through the agent transcript |

### Owner decisions, recorded before the first write

1. **Secret handoff:** the owner mints `RESEND_API_KEY` and `ZERNIO_API_KEY` in the provider
   dashboards and writes each to its own mode-600 file under `.scratch/`. The agent generates
   `ZERNIO_WEBHOOK_SECRET` directly into a file. All three reach the vault by the CLI's
   **`KEY=@/path/to/file`** form, so **no value is ever a shell argument** (trap 1).
2. **Cutover order for `ZERNIO_WEBHOOK_SECRET`:** **vault first → confirm the worker booted
   carrying it → then `PUT` Zernio.** During the gap the worker rejects old-signed events,
   which is correct behaviour — it never accepts an unverified one. The inverse order puts the
   failure on the inbound path instead.

---

## Preflight

| # | Check | Result | UTC | Evidence |
|---|---|---|---|---|
| P1 | `.scratch/` is gitignored and mode 700 | ✅ | 21:44Z | `.gitignore:181`; `drwx------` |
| P2 | The `@file` write form exists | ✅ | 21:44Z | `infisical secrets set <name>=@/path/to/file` — from `--help` |
| P3 | All three keys exist on **Vercel** production | ✅ | 21:45Z | `vercel env ls production` lists `RESEND_API_KEY`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, all `Encrypted` |
| P4 | Railway CLI is linked to the right project/env/service | ✅ | 21:43Z | `railway status` → `repworth` / `production` / `repworth-worker` |
| P5 | Code read sites resolved from source, not memory | ✅ | 21:40Z | `RESEND_API_KEY` → `src/lib/config/{server,worker}.ts` (**both** Next.js and worker); `ZERNIO_API_KEY` → `src/lib/zernio/client/transport.ts`; `ZERNIO_WEBHOOK_SECRET` → `worker/ingress/zernio/zernio.ts:311`. All three are boot-asserted in `worker/config/startup-assert.ts` |
| P6 | **Pre-rotation fingerprints captured** | ✅ | 21:42Z | see the table below |
| P7 | `SOLICITATION_RESEND_API_KEY` is not in scope | ✅ | 21:42Z | reads **UNSET** in production. It is a *different* key by design — a leak from the solicitation lane must not be able to forge an approval email (invariants #3/#5) |
| P8 | The stale ngrok Resend endpoint is already gone | ✅ | 21:41Z | F.2a: `DELETE …/webhooks/23123295-…` → `{"deleted":true}` |

### P6 — pre-rotation fingerprints (production)

Read with `railway run --service repworth-worker --environment production -- node .scratch/fp.js`,
which prints a **SHA-256 prefix and a length, never a value**.

| Key | SHA-256 (first 16) | Length | In scope |
|---|---|---|---|
| `RESEND_API_KEY` | `4465dc3c4d547996` | 36 | ✅ rotate |
| `ZERNIO_API_KEY` | `1d47c066425e8011` | 67 | ✅ rotate |
| `ZERNIO_WEBHOOK_SECRET` | `d2a90be01f98b202` | 64 | ✅ rotate |
| `RESEND_WEBHOOK_SECRET` | `799db5754a6eeafc` | 38 | ❌ provider-issued (Svix), not exposed |
| `SOLICITATION_RESEND_API_KEY` | UNSET | — | ❌ not set |

> **These fingerprints are the proof obligation.** A rotation is complete only when all three
> in-scope fingerprints have **changed** in the running production worker — not when the vault
> reports a write, and not when a deploy reports success.
>
> `ZERNIO_WEBHOOK_SECRET` is 64 characters, i.e. 32 bytes hex. The replacement is generated in
> the same shape so nothing downstream has to care.

---

## Deviations

### D-1 (2026-09-01T21:39Z) — all three rotation runbooks describe an architecture that no longer exists

Every one of them says, at step 2, some form of *"add replacement values to Railway
worker environment variables"* (and the email one adds *"and Vercel"*).

**That is the pre-vault topology.** Today a single Infisical `prod` environment syncs to
**both** Vercel and Railway. Writing straight to Railway either gets overwritten by the next
sync or creates silent drift between the vault and the platform — and drift in a *credential*
is not a cosmetic problem, it is an outage whose cause is invisible from either side alone.

Same class as the PITR drill's D-1 earlier today: **a procedure document that has not been
executed since the system changed underneath it.** Both runbooks are corrected in this
session, in the same change as this evidence file.

### D-2 (2026-09-01T21:39Z) — `secrets-rotation-api-keys.md` is not in scope, and E-F1 says it is

The E-F1 record names three runbooks. `secrets-rotation-api-keys.md`'s scope is
`ENCRYPTION_KEY` / `SESSION_COOKIE_SECRET` / `CSRF_SECRET` — none of which was exposed. Only
the Zernio and email-and-messaging runbooks apply. Recorded so a future reader does not rotate
session and CSRF material for no reason, which would log every owner out.

### D-3 (2026-09-01T21:50Z) — **INCIDENT. The agent's own "safe handoff" put a live key in the transcript.** E-F1, repeated, during E-F1's remediation.

The agent instructed the owner to run
`! umask 077 && printf '%s' 'PASTE_KEY_HERE' > .scratch/rotate-zernio-api-key.txt`,
substituting the real key for the placeholder. The owner did exactly that. **A `!`-prefixed
command is echoed into the transcript verbatim**, so the freshly-minted production Zernio API
key was exposed in plaintext at the moment of its creation.

**WHY the reasoning failed, which is the transferable part.** The design goal was stated as
*"no value passes through the agent"* and the mechanism chosen — the owner types it, the agent
reads only a file — satisfies exactly that. It does not satisfy the actual requirement.
**"The agent never sees the value" and "the value is not exposed" are different claims**, and a
user-typed shell command satisfies the first while violating the second by construction. The
agent had written *"no value is ever a shell argument (trap 1)"* into this file's own
Environment block minutes earlier, and then authored a procedure whose entire mechanism was a
shell argument.

The repo rule this broke is explicit: *"Never place an API key, token, or secret as a literal
argument in a Bash command — it lands in transcript history."* It does not distinguish who
types the command, and that is precisely why.

**CORRECT — the clipboard path, which contains no secret at any point:**

```bash
umask 077 && pbpaste | tr -d '\n' > .scratch/rotate-<name>.txt && wc -c < .scratch/rotate-<name>.txt
```

The value moves browser → clipboard → file. It never enters a command line, a shell history,
or a transcript. Clear the clipboard afterwards with `printf '' | pbcopy`. Verify by **length
and SHA-256 prefix**, never by reading. `tr -d '\n'` matters as much as the rest: an HMAC keys
on the exact byte string, so one invisible trailing newline produces a signature mismatch
indistinguishable from a wrong secret.

**Blast radius: none realised.** The exposed key was minted minutes earlier, was never written
to the vault, never deployed, and never used to sign or post anything. No Google Business
Profile is connected. It was revoked and replaced before installation. **But it must be
counted as compromised and killed, not quietly abandoned** — an un-revoked key is a live key
regardless of whether anything was done with it. It is teardown row **T2b**.

**The general lesson is about remediation, not secrets.** A remediation step is written by the
same hands, in the same session, under the same assumptions that produced the original defect.
It deserves the same scrutiny as the thing it is fixing — arguably more, because it arrives
wearing the authority of a fix.

---

---

## Teardown ledger

Written **before the first change**. In a rotation the "fixtures" are the **old credentials**,
which are live until explicitly revoked, and the **plaintext files on disk**.

| # | Fixture | Identifier | How to remove | Created | Done |
|---|---|---|---|---|---|
| T1 | Old `RESEND_API_KEY` | fingerprint `4465dc3c4d547996` | Resend dashboard → API Keys → revoke the **old** key. Verify: it no longer lists | pre-existing | [ ] |
| T2 | Old `ZERNIO_API_KEY` | fingerprint `1d47c066425e8011` | Zernio → revoke the old key. Verify: a raw `GET /v1/profiles` under it returns **401** | pre-existing | [ ] |
| T3 | Old `ZERNIO_WEBHOOK_SECRET` | fingerprint `d2a90be01f98b202` | superseded by the `PUT` to subscription `6a95315320358f33c89599e5`. Verify: a payload signed with the old secret is **rejected** | pre-existing | [ ] |
| **T2b** | **Second Zernio key — minted ~21:50Z and EXPOSED in-session (D-3). Never installed.** | not recorded here by design | Zernio → revoke. Verify: it no longer appears in the key list | **21:50Z** | [ ] |
| T4 | Plaintext key files on disk | `.scratch/rotate-*.txt` | `rm -P` (overwrite before unlink). Verify: `ls .scratch/rotate-*` returns nothing | 21:44Z onward | [ ] |
| T5 | Fingerprint helper | `.scratch/fp.js` | delete. Contains no secret — it prints hashes — but it is drill scaffolding | 21:42Z | [ ] |

> **T1–T3 are the ones that matter.** A rotation that installs new credentials and leaves the
> old ones live has not reduced the blast radius by one bit — it has doubled the number of
> valid keys. **The rotation is not done when the new key works. It is done when the old key
> fails.**

---

## Unproven paths

| # | Path | Status |
|---|---|---|
| U1 | All three fingerprints changed in the running production worker | ⏳ open |
| U2 | Vercel serves the new `RESEND_API_KEY` (needs a redeploy, not just an env write) | ⏳ open |
| U3 | The Zernio subscription `secret` matches the vault value | ⏳ open |
| U4 | A real inbound Zernio webhook verifies under the new secret | ⏳ open |
| U5 | Approval email still sends under the new Resend key | ⏳ open |
| U6 | **Each old credential is dead** — not merely replaced | ⏳ open |

---

## Execution log

### Both provider keys proven live BEFORE installation — 21:52Z

| Key | Probe | Result |
|---|---|---|
| Zernio | raw `GET https://zernio.com/api/v1/profiles` | `200`, body names `repworth-prod-019e4e19-1c5a-72b8-b2a1-3301152e78c7` |
| Resend | `GET https://api.resend.com/domains` | `200`, `repworth.net` **verified**, `us-east-1` |

Both were read from a file into a shell variable and unset immediately — never a literal
argument (D-3's correction). **A key is proven before it is installed, never after**: an
unproven key installed into the vault takes production down and the cause looks like a deploy
failure.

The Resend file's first three characters are `re_`, the expected prefix, and it is 36 bytes —
matching the outgoing key's length exactly.

---

## The write — 2026-09-01T21:52:16Z → 21:52:18Z

```bash
infisical secrets set \
  "RESEND_API_KEY=@$R/.scratch/rotate-resend-api-key.txt" \
  "ZERNIO_API_KEY=@$R/.scratch/rotate-zernio-api-key.txt" \
  "ZERNIO_WEBHOOK_SECRET=@$R/.scratch/rotate-zernio-webhook-secret.txt" \
  --projectId 1735b0d0-286e-4ca3-a53b-f3a7191b163c --env prod --silent
```

`exit=0`, all three key names present in the output, no error marker. `--silent` suppressed
the CLI's table entirely — the output file contained **zero** matches for `re_` or `sk_` — and
it was shredded with `rm -P` regardless. **All three in one call, so one deploy instead of
three.**

### The sync fired in 10 seconds, and on the RIGHT commit

```
2026-09-01T21:52:28.485Z  INITIALIZING  90f8c6d8   ← 10s after the vault write
2026-09-01T21:53:37Z      SUCCESS
```

Commit `90f8c6d8` is the current `main` tip. **Checked deliberately**: the standing trap is
that a Railway redeploy can resurrect a months-old commit. This deploy was variable-triggered
rather than a bare `redeploy`, and the hash was verified against the branch tip rather than
assumed.

### U1 — all three fingerprints changed in production. CLOSED.

`railway run --service repworth-worker --environment production -- node .scratch/fp.js`

| Key | Before | After | Changed |
|---|---|---|---|
| `RESEND_API_KEY` | `4465dc3c4d547996` | **`ac70820f8ab8ed0e`** | ✅ |
| `ZERNIO_API_KEY` | `1d47c066425e8011` | **`6d1d14c1ea4ce593`** | ✅ |
| `ZERNIO_WEBHOOK_SECRET` | `d2a90be01f98b202` | **`ba67fb48f0661c75`** | ✅ |
| `RESEND_WEBHOOK_SECRET` | `799db5754a6eeafc` | `799db5754a6eeafc` | ✅ correctly **un**touched |

Each new fingerprint equals the staged file's, so the value that landed is the value that was
minted — not merely *a* different value.

---

### D-4 (2026-09-01T21:53Z) — `vercel env ls`'s age column does NOT track a synced write

Two minutes after the vault write, `vercel env ls production` still showed all three keys as
**`2d ago`**. The first reading of that was *"the sync never reached Vercel"* — which, had it
been believed, would have made revoking the old Resend key an outage.

**It is false.** Pulling the environment and fingerprinting it shows Vercel holding the new
values already:

| Key | Vercel value | Matches the new file? |
|---|---|---|
| `RESEND_API_KEY` | `ac70820f8ab8ed0e` | ✅ |
| `ZERNIO_API_KEY` | `6d1d14c1ea4ce593` | ✅ |
| `ZERNIO_WEBHOOK_SECRET` | `ba67fb48f0661c75` | ✅ |

The age column reflects something other than a synced value update. **Same shape as trap 12:
a convenient UI column answered a narrower question than the one being asked, and the
narrowing was invisible.** Measure the value, never the metadata about the value.

> ⚠️ **`vercel env pull` writes every production secret to disk in plaintext.** The file was
> mode-600 by `umask 077`, fingerprinted in-process, and shredded with `rm -P` seconds later.
> Treat a pull as creating a fixture, and put it in the teardown ledger before running it.

---

## `ZERNIO_WEBHOOK_SECRET` cutover — vault first, then Zernio

### D-5 (2026-09-01T21:55Z) — the update endpoint is not the one every doc implies

`PUT /v1/webhooks/settings/{id}` → **404**, `endpoint_not_found`. The record in E-F1 reads
*"`PUT` subscription `6a95315320358f33c89599e5`'s `secret`"*, which reads as a RESTful path.

The real shape, from `https://zernio.com/openapi.json`: **`PUT /v1/webhooks/settings`** with
`_id` in the **body**. *"All fields except `_id` are optional; only provided fields will be
updated."*

**That optionality is a safety feature, so the body was reduced to `{_id, secret}`.** The
first attempt had echoed back `name`, `url`, `events` and `isActive` from the GET — which
works, and quietly makes an unrelated regression possible if any of those was read stale. A
body carrying only what changes cannot alter what did not.

The 404's own response named `openapi.json`. **The API answered the question; the second guess
was unnecessary.**

### The PUT — 21:55:59Z, `HTTP 200`

```json
{ "success": true,
  "webhook": { "_id": "6a95315320358f33c89599e5", "name": "RepWorth Production",
               "url": "https://worker.repworth.net/ingress/zernio",
               "events": ["account.connected","account.disconnected","review.new","review.updated"],
               "isActive": true, "failureCount": 0 } }
```

Name, URL, all four events and `isActive` came back unchanged. The staging subscription
(`69f462cd16ebc34c67c9b7a5`, secret length 32, a different shape) was **not touched** —
E-F3's account-scoping means both are visible under either key, and only one was addressed.

### U3 — the two systems hold the same bytes. CLOSED.

```
zernio stored secret sha256_16 = ba67fb48f0661c75
vault / worker value  sha256_16 = ba67fb48f0661c75
MATCH: YES          (old value was d2a90be01f98b202)
```

### U4 — a real signed webhook verified end to end. CLOSED, and it is the conclusive one.

`POST /v1/webhooks/test` with `webhookId` — `webhook.test` is **not** a subscribable event,
so this is the only way to fire it. `HTTP 200`, and production `inbound_events`:

| source | event_type | status | received_at | processed_at | error |
|---|---|---|---|---|---|
| `zernio` | `webhook.test` | **`processed`** | `2026-09-01 21:56:21.589078+00` | `21:56:21.653748+00` | — |

**This is the proof the fingerprint check cannot give.** A fingerprint read through
`railway run` proves the *variable* is set; it does not prove the *running process* holds it.
Here Zernio signed an HMAC with the new secret and the live production worker verified it and
processed the event in 64 ms. Both halves of the two-system cutover are proven by one event.


### Replacement credentials staged — 2026-09-01T21:52Z

Verified by **length and SHA-256 prefix only**. No value was read, printed, or passed as an
argument.

| File | Length | SHA-256 (first 16) | Old fingerprint it must differ from | Differs? |
|---|---|---|---|---|
| `.scratch/rotate-zernio-webhook-secret.txt` | 64 | `ba67fb48f0661c75` | `d2a90be01f98b202` | ✅ |
| `.scratch/rotate-zernio-api-key.txt` | 67 | `6d1d14c1ea4ce593` | `1d47c066425e8011` | ✅ |
| `.scratch/rotate-resend-api-key.txt` | — | — | `4465dc3c4d547996` | ⏳ pending |

`ZERNIO_WEBHOOK_SECRET` was generated by the agent as 32 random bytes hex —
`randomBytes(32).toString('hex')`, written straight to a mode-600 file, never rendered.
It matches the outgoing value's shape (64 chars), so nothing downstream has to change.

**The new Zernio API key is PROVEN live, by the E-F2 method** — a raw request, which bypasses
the client's shape validation and so discriminates a good key from a bad one:

```
GET https://zernio.com/api/v1/profiles   →  200
     repworth-prod-019e4e19-1c5a-72b8-b2a1-3301152e78c7      ← the production profile
     repworth-staging-019e7cb5-…  (+ 3 more staging profiles)
```

Two things this proves at once: the key authenticates, and it is **bound to the right tenant** —
the profile name matches the one E-F2 recorded for production. The staging profiles appearing
alongside is E-F3's account-scoping, expected and benign.

The key was read from the file into a shell variable and unset immediately; it was never a
literal argument (D-3's correction, applied).

---

## U2 — Vercel serves the new values. CLOSED.

The vault write reached Vercel's env store within the same window as Railway's (D-4 —
measured by fingerprint, because the age column lies). But **an env-store write is not a
served value**: Vercel resolves environment at deploy time, so the deployment running at
21:52Z was still serving the old key.

```
vercel redeploy https://rep-worth-8ggje3rrk-… --scope norbert-esekiels-projects \
  --target production --no-wait          # 21:56:59Z
```

| Field | Value |
|---|---|
| New deployment | `rep-worth-o2bxlj601-norbert-esekiels-projects.vercel.app` |
| Created | `2026-09-01T21:57:40Z` — **after** the 21:52:18Z env write, so it resolved the new values |
| State | `Ready`, built in 2 min |
| **Aliases** | **`https://repworth.net`**, `https://www.repworth.net` |

**The alias check is the step that matters.** A redeploy can reach `Ready` and serve nobody;
"a deployment is running" and "production is running it" are different claims — the same
distinction as trap 15, one layer up. Production traffic reaches this deployment.

> Two CLI notes for the next rotation. `vercel redeploy` takes **no `--yes`** (it has
> `--no-wait` and `--target`), and it fails with *"Deployment belongs to a different team"*
> unless `--scope` is passed explicitly, even with exactly one team on the account.

---

### D-6 (2026-09-01T22:05Z) — the disk was a larger exposure than the transcript ever was

Shredding one flagged file prompted a pattern scan of `.scratch/`. It found **18 more files**
holding live production secrets in plaintext, every one a completed-phase artifact from the
2026-08-29 → 08-31 WS8 cutover sessions:

| Class | Files |
|---|---|
| **Complete credential dumps** | `ws8-phase-a/backup/vercel-prod.env`, `v-final.env`, `vercel-now.env`, `vercel-preview.env`, `railway-prod.json`, `backup/railway-prod.json`, `railway-t4.json`, `railway-staging.json`, `inf-verify.json`, `inf-verify2.json` |
| **Authenticated session state** | `pw-state.json` — Playwright storage state. Not a password: a **logged-in session**, which needs no password to use |
| Stripe webhook secrets | `stripe-webhook-secret.env`, `stripe-webhook-secret.txt` |
| Scripts with embedded secrets | `d1-verify-prices.py`, `d3-preflight.py`, `d3-create-endpoint.py`, `d5-enable-endpoint.py` |
| Provider-issued secret | `resend-webhook-create.json` |

**All 18 shredded with `rm -P`, 22:05Z, owner-approved.** Verified by re-running the scan: the
only matches left are this rotation's own in-flight files, which teardown row T4 removes.

**Why this is the session's largest finding, and it is not the file count.** E-F1 was one CLI
printing values once, and it produced a three-secret rotation, a standing rule, and two
handoffs. Meanwhile eighteen files sat on disk holding a superset of the same material — the
*entire* production environment, twice over, plus a live session — accumulated by the very
sessions that were remediating E-F1. Nobody was careless. **Every one of those files was
created by a legitimate step: pull the env to compare it, snapshot it before a risky write,
save the response that shows a one-time secret.** The exposure is not in any single act; it is
that **a working directory accumulates, and no step's cleanup was ever anyone's step.**

The pattern also explains why it stayed invisible: `.scratch/` is gitignored and mode-700, so
every local check says "safe". Gitignore protects the *repository*. It does nothing for the
*disk*, for a backup, or for anything with filesystem read.

**CORRECT, and it is a process change rather than a rule.** A command that writes a secret to
disk **creates a fixture**, and a fixture gets a teardown-ledger row *before* the command runs
— exactly as `vercel env pull` was handled earlier in this same run. The rule "never print a
secret" was already known and followed; the gap was that *writing* one was never counted as
creating something that has to be removed. Worth a periodic sweep:

```bash
grep -rlE 'whsec_[A-Za-z0-9+/=]{10,}|re_[A-Za-z0-9_]{20,}|sk_[A-Za-z0-9]{40,}|rk_live|sk_live|eyJ[A-Za-z0-9_-]{30,}' .scratch
```

> **One correction to keep the record honest.** `RESEND_WEBHOOK_SECRET` (`799db5754a6eeafc`)
> was in `.scratch/resend-whsec.txt` and is **still live in production** — it was not part of
> this rotation. Shredding the file removed the *disk copy*; it did not rotate the credential.
> A file being gone is not a secret being safe.
