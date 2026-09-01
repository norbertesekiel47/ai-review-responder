# Secrets Rotation: Email And Messaging

Owner: founder
Cadence: every 6 months and immediately after suspected exposure

## Scope

- `RESEND_API_KEY` — transactional email, and the custom-SMTP password
- `SOLICITATION_RESEND_API_KEY` — the solicitation lane's **Sending identity**, a
  *different* key on purpose (a leak here must not be able to forge an approval email —
  invariants #3/#5). Unset in production as of 2026-09-01
- `TWILIO_AUTH_TOKEN`
- `TELEGRAM_BOT_TOKEN`

**Not in scope:** `RESEND_WEBHOOK_SECRET`. It is **provider-issued** (a Svix `whsec_…`, shown
once when the endpoint is created) — you cannot choose it, and rotating it means recreating
the endpoint. Handle it as its own change.

## Read this first — the topology changed and this runbook used to be wrong

> **Corrected 2026-09-01 (deviation D-1 of the E-F1 rotation).** Every earlier version said
> *"add replacement value to Railway and Vercel environment stores."* That is the **pre-vault**
> architecture. Today a single **Infisical `prod` environment syncs to both.** Writing directly
> to a platform is either overwritten by the next sync or becomes silent drift.

Three facts that shape every step:

1. **A vault write is a deploy on every synced platform.** Railway picks the change up in ~10 s
   and redeploys itself. **Vercel does not.** Its env store updates, but the *running*
   deployment keeps serving the old value until you redeploy — and `RESEND_API_KEY` is read by
   **both** the worker and Next.js (`src/lib/config/server.ts`, `src/lib/config/worker.ts`), so
   skipping the Vercel redeploy leaves half of production on a key you are about to revoke.
2. **`vercel env ls`'s age column does not track a synced write** (D-4). It showed `2d ago`
   minutes after a confirmed sync. **Measure the value, not the metadata about it.**
3. **`repworth-worker` is ONE Railway service shared by staging and production.** Always pass
   the environment.

## Never put a secret in a command

A secret as a shell argument lands in shell history and in any agent transcript — **including a
command a human types.** That is how E-F1 happened, and how it happened a second time during
its own remediation. Use the clipboard:

```bash
umask 077 && pbpaste | tr -d '\n' > .scratch/rotate-resend-api-key.txt \
  && wc -c < .scratch/rotate-resend-api-key.txt
```

Verify only by **length + SHA-256 prefix**, never by reading.

> **A command that writes a secret to disk creates a FIXTURE.** Give it a teardown row before
> you run it — `vercel env pull` included, which writes every production secret in plaintext.
> D-6 found 18 such files accumulated across three sessions, every one from a legitimate step
> nobody thought of as creating something.

## Procedure

1. **Capture pre-rotation fingerprints from the RUNNING worker.** Rotation is complete when
   these have *changed*, not when a write succeeds.

   ```bash
   railway run --service repworth-worker --environment production -- node -e '
     const {createHash}=require("node:crypto");
     for (const k of ["RESEND_API_KEY","SOLICITATION_RESEND_API_KEY","TWILIO_AUTH_TOKEN","TELEGRAM_BOT_TOKEN"]) {
       const v=process.env[k];
       console.log(k, v?createHash("sha256").update(v).digest("hex").slice(0,16):"UNSET", v?v.length:"");
     }'
   ```

2. **Mint the replacement** in the provider dashboard. For Resend use **Full access** — the key
   both sends mail and reads webhook configuration. Capture it with the clipboard form above.
   **Leave the old key live**; it is still serving production.

3. **Prove the new key before installing it.** An unproven key installed into the vault takes
   production down, and the failure looks like a deploy problem:

   ```bash
   KEY=$(cat .scratch/rotate-resend-api-key.txt)
   curl -s -o /tmp/d.json -w '%{http_code}\n' -H "Authorization: Bearer $KEY" \
     https://api.resend.com/domains; unset KEY
   ```

   Expect `200` **and** `repworth.net` listed as `verified`.

4. **Write to the vault** — `@file` form, so no value is ever an argument:

   ```bash
   infisical secrets set "RESEND_API_KEY=@$PWD/.scratch/rotate-resend-api-key.txt" \
     --projectId 1735b0d0-286e-4ca3-a53b-f3a7191b163c --env prod --silent
   ```

   Env slug is **`prod`**, not `production`. Without `--silent` the CLI prints a table — the
   E-F1 incident itself. Redirect it to a file and shred the file either way.

5. **Confirm the Railway worker booted carrying it** — re-run step 1 and require the
   fingerprint to have changed.

6. **Redeploy Vercel, then confirm the ALIAS moved.** A `Ready` deployment can serve nobody:

   ```bash
   vercel redeploy <current-prod-url> --scope <team> --target production --no-wait
   vercel inspect <new-url> --scope <team> | grep -A3 Aliases     # must list repworth.net
   ```

   `vercel redeploy` takes **no `--yes`**, and it fails with *"Deployment belongs to a
   different team"* unless `--scope` is passed — even with one team on the account.

7. **Verify the lane actually works.** Approval-email delivery for `RESEND_API_KEY`; SMS
   opt-in/STOP for Twilio; a delivery for Telegram. Prefer Resend's simulator address
   `delivered@resend.dev` — it fires the real event and reaches no human.

8. **Revoke the old secret, and prove it is dead** — the step-3 probe must now return `401`.
   **A rotation that leaves the old key live has not reduced the blast radius; it has doubled
   the number of valid keys.**

9. **Shred the plaintext files** (`rm -P .scratch/rotate-*`), clear the clipboard
   (`printf '' | pbcopy`), and sweep for strays:

   ```bash
   grep -rlE 'whsec_[A-Za-z0-9+/=]{10,}|re_[A-Za-z0-9_]{20,}|sk_[A-Za-z0-9]{40,}' .scratch
   ```

10. **Record** date, actor, fingerprints before/after, and verification result below.

## Rotation Log

| Date | Actor | Secret | Verification |
|---|---|---|---|
| 2026-09-01 | @norbertesekiel + agent | `RESEND_API_KEY` — `4465dc3c4d547996` → **`ac70820f8ab8ed0e`** | `GET /domains` → `200`, `repworth.net` **verified**. Fingerprint changed in the running prod worker; Vercel redeployed and confirmed **aliased to `repworth.net`**. **Old key `b1d63eef-…` (`repWorth`) deleted → `200`, verified absent by re-list.** Lane proof (an actual approval email) deferred to Phase H §9.4. |

Not rotated: `RESEND_WEBHOOK_SECRET` (`799db5754a6eeafc`) — provider-issued, still live, its own change.

Record: `docs/runbooks/evidence/2026-09-01-secret-rotation-evidence.md`.
