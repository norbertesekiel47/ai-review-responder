---
paths:
  - "src/lib/security/**"
  - "src/proxy.ts"
  - "worker/ingress/rate-limit.ts"
---

# Security edge rules

## Read first

- Bot-protection / edge rate-limiting / WAF / Attack Mode: runbook `docs/runbooks/vercel-waf-rate-limiting.md` + `src/lib/security/botid*` + ADR `docs/adr/0002-botid-server-check-carveout.md`.
- Lab notes: `.claude/reference/lab-notes/vercel-botid-waf.md` (client/server `checkLevel` must match; Deep Analysis is billed; WAF rules have no committable config), `.claude/reference/lab-notes/ingress-rate-limiting.md` (the limiter's scope test needs BOTH arms; the statutory opt-out exemption is read from the RESOLVED route config).
- File map: `docs/directory/lib-platform.md` § `security/`; the `src/proxy.ts` section of the `docs/directory.md` index; `docs/directory/worker-ingress.md` (`rate-limit.ts`).
- Skill `vercel:vercel-firewall` for WAF rules, IP blocking, and Attack Mode.

## Traps

- No trap clauses were moved from `.claude/CLAUDE.md`; the global gotcha "API rate limits fail OPEN by design; the Redis cost RESERVATION precedes every LLM call" stays there — never make the limiters strict.
- Invariant #6 (third-party ingress terminates on Railway) and the Working-rules requirement that webhook handlers verify the signature FIRST stay in `.claude/CLAUDE.md`.

## Rules

- Nothing was moved from `.claude/CLAUDE.md`.
