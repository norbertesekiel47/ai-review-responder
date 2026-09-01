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
| T1 | Old `RESEND_API_KEY` | `b1d63eef-e22e-4096-864c-674cc362e6c3` (`repWorth`), fp `4465dc3c4d547996` | `DELETE /api-keys/{id}` → 200, list re-read | pre-existing | **[x] 22:31:24Z** |
| T2 | Old `ZERNIO_API_KEY` | fp `1d47c066425e8011` | owner-revoked; absent from `GET /v1/api-keys` | pre-existing | **[x] 22:29Z** |
| T3 | Old `ZERNIO_WEBHOOK_SECRET` | fp `d2a90be01f98b202` | superseded by the 21:55:59Z `PUT`; dead by construction | pre-existing | **[x] 21:55:59Z** |
| **T2b** | **Zernio key exposed in-session (D-3). Never installed** — proven distinct from the installed one | fp `1826d92ca953c45f` | owner-revoked; absent from `GET /v1/api-keys` | **21:50Z** | **[x] 22:29Z** |
| T4 | Plaintext key files on disk | `.scratch/rotate-*.txt` + 12 probe/response artifacts | `rm -P`; verified by re-scan | 21:44Z onward | **[x] 22:31:39Z** |
| T5 | Fingerprint helper | `.scratch/fp.js` | shredded with the rest | 21:42Z | **[x] 22:31:39Z** |

> **T1–T3 are the ones that matter.** A rotation that installs new credentials and leaves the
> old ones live has not reduced the blast radius by one bit — it has doubled the number of
> valid keys. **The rotation is not done when the new key works. It is done when the old key
> fails.**

---

## Unproven paths

| # | Path | Status |
|---|---|---|
| U1 | All three fingerprints changed in the running production worker | ✅ closed 21:53Z |
| U2 | Vercel serves the new `RESEND_API_KEY` | ✅ closed 21:57:40Z — aliased to `repworth.net` |
| U3 | The Zernio subscription `secret` matches the vault value | ✅ closed 21:56Z — byte-identical |
| U4 | A real inbound Zernio webhook verifies under the new secret | ✅ closed 21:56:21Z — `processed` in 64 ms |
| U5 | Approval email still sends under the new Resend key | ⚠️ **deferred to Phase H §9.4** — the key is proven against the Resend API (`200`, `repworth.net` verified); no production email was sent to prove the *lane*, deliberately |
| U6 | **Each old credential is dead** — not merely replaced | ✅ closed 22:31:24Z |

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

---

## U6 — every old credential is dead. CLOSED 22:31Z, and it needed two attempts.

**Zernio — both keys gone, verified by listing.** `GET /v1/api-keys` (an endpoint the earlier
records did not know existed) returns four keys, and neither the old production key nor the
exposed one is among them:

| id | name | created |
|---|---|---|
| `69f460cf…` | `RepWorth_Test` | 2026-05-01 |
| `6a12a519…` | `CLI (Norberts-MacBook-Pro.local)` | 2026-05-24 |
| `6a1b5af8…` | `RepWorth-Staging-Key` | 2026-05-30 |
| **`6a974840…`** | **`RepWorth-Production-Key`** | **2026-09-01T21:48:48Z** — live |

### A check worth writing down, because the timeline invited a wrong conclusion

The surviving key's `createdAt` (21:48:48Z) is **earlier** than the D-3 exposed paste. That is
consistent with a bad story — that the clipboard still held the exposed key and production was
running it. Checked rather than assumed:

```
installed-in-production sha256_16 = 6d1d14c1ea4ce593
exposed-in-transcript   sha256_16 = 1826d92ca953c45f
→ different keys
```

**Production never ran the exposed key.** The suspicious timestamp was a coincidence of
ordering, and the only way to know that was to hash both. **A plausible reconstruction of a
timeline is not evidence about which bytes are installed.**

### D-7 (2026-09-01T22:29Z) — the preflight captured fingerprints but no PROVIDER-SIDE KEY LIST, and that is why one revocation could not be verified

The owner reported all three revoked. Zernio was verifiable immediately: list the keys, observe
both are absent. **Resend was not.** Its list still held five keys — one new, four older — and
nothing in a fingerprint identifies *which dashboard row* the old key was. `4465dc3c4d547996`
is a hash of a value the agent never held.

The old key was identified **by elimination and name** (`repWorth`, created 2026-04-07, the
only row not explained by staging or the solicitation lane) — an **inference**, and recorded
as one rather than as a verification. The owner confirmed it, said it was revoked, and a
re-list showed it **STILL PRESENT** with the count unchanged at 5. The dashboard action had not
taken effect.

**CORRECT — capture the provider's key list in preflight, alongside the fingerprints.** Then
revocation is verified by simple set difference and needs no inference and no owner round-trip.
Fingerprints prove *the new value landed*; a before-list proves *which old thing must vanish*.
The two answer different questions and the run needs both.

### The deletion, executed via the API behind three guards

The dashboard revocation had silently not applied, so the owner's decision was executed
through `DELETE /api-keys/{id}`:

| Guard | Assertion | Result |
|---|---|---|
| G1 | target id ≠ the id production is running (`66efd971…`) | pass |
| G2 | the **live** row for that id is still named `repWorth` — re-read from the API, not from this file | pass |
| G3 | production's `RESEND_API_KEY` fingerprint already equals `ac70820f8ab8ed0e` | pass |

G3 is the one that makes the delete safe rather than merely correct: **it refuses to revoke an
old credential until production is measurably serving the new one.**

```
DELETE HTTP 200
remaining: repworth-prod-key · solicitation-staging · send reviews key · repworth-staging
b1d63eef-… → GONE — verified revoked
```

---

## Teardown — complete and verified

Every ledger row executed. Then the whole directory was re-scanned rather than trusting the
row ticks:

```
$ grep -rlE 'whsec_…|re_…|sk_…|eyJ…' .scratch
  clean
```

15 files shredded with `rm -P` in this phase (3 key files, the fingerprint helper, 11
probe/response artifacts), on top of D-6's 18. **`.scratch/` now holds no live-secret pattern
at all** — the first time that has been true in this repository since at least 2026-08-29.

---

# Verdict — 2026-09-01T22:32Z

## ✅ **PASS.** All three E-F1 secrets rotated, proven in production, and the old credentials are dead.

| Secret | Old | New | Old key status |
|---|---|---|---|
| `RESEND_API_KEY` | `4465dc3c4d547996` | **`ac70820f8ab8ed0e`** | **deleted**, verified by re-list |
| `ZERNIO_API_KEY` | `1d47c066425e8011` | **`6d1d14c1ea4ce593`** | **revoked**, absent from the key list |
| `ZERNIO_WEBHOOK_SECRET` | `d2a90be01f98b202` | **`ba67fb48f0661c75`** | **overwritten** by the 21:55:59Z `PUT` |

**Elapsed: 21:46Z → 22:32Z, 46 minutes**, of which the rotation itself was ~10.

### The verification ladder, and why only the top two rungs count

1. The vault write returns `exit 0` — **proves nothing about any platform.**
2. `railway run … sha256` — proves the **variable** is set, not that the **process** holds it.
3. **A real signed event.** Zernio signed with the new secret; production verified the HMAC and
   `processed` it in 64 ms. **The only check that proves the live process and the remote system
   agree** — and it settles both halves of a two-system cutover with one event.
4. **The old credential is gone.** Before this, a rotation has not reduced the blast radius; it
   has *doubled the number of valid keys*.

### Seven deviations. Two are the findings; five are traps.

| # | |
|---|---|
| **D-3** | **The remediation reproduced the incident.** The "safe handoff" put a live key in the transcript via a `!` command, while remediating an identical exposure. *"The agent never sees the value"* and *"the value is not exposed"* are different claims. |
| **D-6** | **The disk was a larger exposure than the transcript ever was.** 18 files, ten full credential dumps and a live session, every one from a legitimate step, accumulated by the sessions remediating E-F1. |
| D-1 | Both in-scope runbooks described the pre-vault architecture. Rewritten. |
| D-2 | `secrets-rotation-api-keys.md` was never in scope, despite E-F1 naming it. |
| D-4 | `vercel env ls`'s age column does not track a synced write. |
| D-5 | Zernio's update is `PUT /v1/webhooks/settings` with `_id` in the **body**. |
| D-7 | The preflight captured fingerprints but no provider-side key list — which is why one revocation needed an inference and an owner round-trip. |

### Still open, and deliberately

1. **`RESEND_WEBHOOK_SECRET` (`799db5754a6eeafc`) was not rotated and is still live.** It is
   provider-issued (Svix); rotating it means recreating the endpoint. Its disk copy was
   shredded — **a file being gone is not a credential being safe.**
2. **U5 — no production email was sent.** The key is proven against the Resend API; the
   *lane* is proven by Phase H §9.4, which sends one deliberately.

**UTC start 2026-09-01T21:46Z · UTC end 2026-09-01T22:32Z.**
