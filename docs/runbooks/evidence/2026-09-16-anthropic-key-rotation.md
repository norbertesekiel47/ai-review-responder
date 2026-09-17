# Evidence — `ANTHROPIC_API_KEY` rotation after an agent-transcript exposure

Runbook: [`secrets-rotation-api-keys.md`](../secrets-rotation-api-keys.md) → *LLM provider keys* ·
precedent: [`2026-09-01-secret-rotation-evidence.md`](2026-09-01-secret-rotation-evidence.md) (E-F1).

## What happened

While checking which production variables were set, the agent ran
`railway variables -s repworth-worker -e production --json` and printed the first 200 characters of
the raw output. That included the production `ANTHROPIC_API_KEY` in plain text, in the session
transcript. **Same class as E-F1**: a tool that prints values by default, used without a filter.
No other secret appeared — the next reads were filtered with `jq`.

## Rotation, as executed

All values were compared by SHA-256 fingerprint (first 12 hex). No key value was printed, passed as
an argument, or written to a file.

| Step | Result |
|---|---|
| Exposed key | fingerprint **`f763cfa21038`**, length 108 |
| Owner creates a new key; **old key revoked first** | — |
| Check with the old key still in place | `GET /v1/models` → **401**. Vault and worker both still `f763cfa21038`: the new key was not saved yet |
| Owner saves the new key in Infisical `prod` | vault **`e19274db2ce6`** |
| Secret Sync → Railway | worker env **`e19274db2ce6`** by 2026-09-17T04:16:04Z |
| Railway auto-redeploy | `086b04bc` started 04:15:30Z, **SUCCESS** ~04:16:22Z; worker uptime 15 s, `/ready` 200 |
| New key accepted | `GET /v1/models` → **200** |
| Old key dead | **401** (the check above) |
| Vercel | no action — no Vercel code reads the key (`src/lib/config/worker.ts` is the only reader) |

## Finding — the fallback was gone for a while, silently

The old key was revoked before the new one was saved. For that window the worker held a dead
Anthropic key. **Nothing visible broke**: OpenAI is the primary model and both production drafts
that day used it. But had OpenAI failed, drafting would have failed instead of falling back. The
window's start was not recorded; it ended at 04:16:22Z. The runbook now says **revoke last**.

## Verdict

✅ **Rotated and proven, 2026-09-17T04:16Z.** Exposed key dead, new key accepted in production,
fallback restored.
