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
