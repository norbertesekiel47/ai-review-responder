# Secrets Rotation: Zernio

Owner: founder
Cadence: every 6 months and immediately after suspected exposure

## Scope

- `ZERNIO_API_KEY`
- `ZERNIO_WEBHOOK_SECRET` (the webhook signing secret)

## Read this first — the topology changed and this runbook used to be wrong

> **Corrected 2026-09-01 (deviation D-1 of the E-F1 rotation).** Every earlier version of
> this file said *"add replacement values to Railway worker environment variables."* That is
> the **pre-vault** architecture. Today a single **Infisical `prod` environment syncs to BOTH
> Vercel and Railway.** A direct Railway write is either overwritten by the next sync or
> becomes silent drift — and drift in a credential is an outage whose cause is invisible from
> either side alone.

Three facts that shape every step below:

1. **A vault write is a deploy on every synced platform.** Writing one key redeploys the
   production worker even if no worker path reads it. Railway picks the change up in ~10 s.
   **Vercel does not redeploy itself** — an env change there needs a deploy to be served.
2. **`ZERNIO_WEBHOOK_SECRET` lives in two systems.** The vault value and Zernio subscription
   `6a95315320358f33c89599e5`'s `secret` field must move **together**, or ingest breaks.
   Zernio accepts a **caller-supplied** secret, so you generate this one yourself.
3. **`repworth-worker` is ONE Railway service shared by staging and production.** Always pass
   the environment. Production and staging hold **different** Zernio API keys on the **same
   Zernio account** (E-F3), so rotating one does not touch the other — but webhook
   subscriptions are account-scoped and both are visible under either key. Never re-point an
   endpoint to "fix" that fan-out; it is benign by construction.

## Never put a secret in a command

A secret as a shell argument lands in shell history and in any agent transcript — **including
a command a human types.** This is how the E-F1 incident happened, and how it happened a
second time *during its own remediation*. Use the clipboard:

```bash
umask 077 && pbpaste | tr -d '\n' > .scratch/rotate-zernio-api-key.txt \
  && wc -c < .scratch/rotate-zernio-api-key.txt
```

`tr -d '\n'` is load-bearing. An HMAC keys on the exact byte string, so one invisible trailing
newline gives a signature mismatch indistinguishable from a wrong secret.

Verify a value only by **length + SHA-256 prefix**, never by reading it.

## Procedure

1. **Capture pre-rotation fingerprints from the RUNNING worker.** This is the proof
   obligation: rotation is complete when these have *changed*, not when a write succeeds.

   ```bash
   railway run --service repworth-worker --environment production -- node -e '
     const {createHash}=require("node:crypto");
     for (const k of ["ZERNIO_API_KEY","ZERNIO_WEBHOOK_SECRET"]) {
       const v=process.env[k];
       console.log(k, v?createHash("sha256").update(v).digest("hex").slice(0,16):"UNSET", v?v.length:"");
     }'
   ```

2. **Mint the replacement API key** in Zernio, for the correct profile
   (`repworth-prod-…` for production). Capture it with the clipboard form above. **Leave the
   old key live** — it is still serving production.

3. **Generate the replacement webhook secret yourself**, matching the outgoing shape
   (32 bytes hex = 64 chars), straight to a file, never rendered:

   ```bash
   node -e 'require("node:fs").writeFileSync(".scratch/rotate-zernio-webhook-secret.txt",
     require("node:crypto").randomBytes(32).toString("hex"), {mode:0o600})'
   ```

4. **Prove the new API key before installing it.** Use a **raw** request — the client
   validates request shape before authenticating, so no call through the client
   discriminates a good key from a bad one (E-F2):

   ```bash
   KEY=$(cat .scratch/rotate-zernio-api-key.txt)
   curl -s -o /tmp/p.json -w '%{http_code}\n' -H "Authorization: Bearer $KEY" \
     https://zernio.com/api/v1/profiles; unset KEY
   ```

   Expect `200` **and** the production profile name in the body. The 200 alone proves
   authentication; the profile name proves it is bound to the right tenant.

5. **Write both values to the vault** — `@file` form, so no value is ever an argument:

   ```bash
   infisical secrets set \
     "ZERNIO_API_KEY=@$PWD/.scratch/rotate-zernio-api-key.txt" \
     "ZERNIO_WEBHOOK_SECRET=@$PWD/.scratch/rotate-zernio-webhook-secret.txt" \
     --projectId 1735b0d0-286e-4ca3-a53b-f3a7191b163c --env prod --silent
   ```

   Env slug is **`prod`**, not `production`. Without `--silent` the CLI prints a table;
   redirect it to a file and shred the file either way.

6. **Wait for the Railway deploy and confirm the worker booted carrying the new values** —
   re-run step 1. Both fingerprints must have changed. A vault write that reports success and
   a worker that is actually serving the new secret are different claims.

7. **Only now, `PUT` the Zernio subscription's `secret`** — subscription
   `6a95315320358f33c89599e5`. Vault-first is deliberate: during the gap the worker rejects
   old-signed events, which is correct behaviour. The inverse order puts the failure on the
   inbound path instead.

8. **Verify ingest end to end.** Fire `POST /v1/webhooks/test` with the `webhookId`
   (`webhook.test` is **not** a subscribable event). Confirm a `status='processed'` row lands
   in production `inbound_events`.

9. **Revoke the old API key, and prove it is dead** — the same raw `GET /v1/profiles` must now
   return `401`. **A rotation that leaves the old key live has not reduced the blast radius;
   it has doubled the number of valid keys.**

10. **Shred the plaintext files** (`rm -P .scratch/rotate-*`) and clear the clipboard
    (`printf '' | pbcopy`).

11. **Record** date, actor, fingerprints before/after, and verification result below.

## Rotation Log

| Date | Actor | Secret | Verification |
|---|---|---|---|
