---
name: security-and-hardening
description: Design-time security for RepWorth — threat model first, then the project's own seams. Use BEFORE writing the plan or the first test for any change that crosses a trust boundary (a route, a webhook, a worker job payload, an owner or admin action, a token or approval link, an outbound URL fetch, LLM input or output, a new dependency, personal data), and whenever intake risk is high for a security, tenancy, billing or public-posting reason. Not a review step — the review wave and /security-review own that.
---

# Security and Hardening

Security that arrives at review arrives too late: most breaches begin in the
design, not the code. This skill runs at PLAN time, so its output lands in the
behavior contract (`execution-lanes.md` § Tracer bullets and TDD → the security
contract) and becomes the first failing tests.

It supplies the generic method. RepWorth's invariants (`.claude/CLAUDE.md`)
and area rules win wherever they are more specific — see "RepWorth seams" and
"Where generic advice is wrong here" below.

## 1. Threat model first — five minutes, not a ceremony

1. **Map the trust boundaries.** Where does data someone else wrote cross into
   the system? HTTP bodies and params, form fields, webhooks (Stripe, Resend,
   Twilio, Zernio), review text from Google, job payloads, approval links,
   **LLM output**, and values that only look internal: a path in a job payload,
   a provider event replayed from storage. Trust follows who WROTE a value, not
   which channel delivered it.
2. **Name the assets.** Approval tokens, the right to post publicly to Google,
   another tenant's reviews and responses, billing state, admin actions,
   provider credentials, owner contact data.
3. **Run STRIDE over each boundary.**

   | Threat | Ask |
   |---|---|
   | Spoofing | Can someone act as another owner, admin, or provider? |
   | Tampering | Can the payload, the review hash, or the stored state be altered? |
   | Repudiation | Could this action be denied later? Is it on the audit log or run spine? |
   | Information disclosure | Can another tenant's data, a token, or raw review text leak — including into logs? |
   | Denial of service | Can one input exhaust the queue, the pool, or the LLM budget? |
   | Elevation of privilege | Can an owner reach an admin path, or a Copilot account an Autopilot action? |

4. **Write abuse cases next to use cases.** "How would I misuse this?" Each
   answer becomes a negative test title in `tests_to_add`: wrong tenant,
   missing authorization, replayed or stale input, oversized input, partial
   failure that leaves a side effect behind.

If you cannot name the trust boundaries, you are not ready to plan the change.

## 2. RepWorth seams — reuse, never reinvent

| Concern | Use | Read |
|---|---|---|
| Who is the actor, which tenant | `account_id` + `business_id` scoping on every owner read/write; `ci:tenant-scope`, `ci:rls-audit` | invariant #8, #9 |
| Reaching Google | an explicit `approval_method`; auto-policy gates; Judge availability | invariant #3, #4 |
| Approval links and tokens | SHA-256 hash only, POST-only session binding, TTL, rate limit | `approval-security` skill, invariant #5 |
| State change + follow-up work | one transaction via `job_outbox` | `outbox-pattern` skill, invariant #2 |
| Third-party ingress | terminate on Railway, verify the signature FIRST, persist raw payload + event ID | invariant #6 |
| Entitlement | `subscriptionGrantsFullAccess(status)`, never `=== 'active'` | invariant #11 |
| Feature flags, policy tables | server-authoritative; no `NEXT_PUBLIC_*` companion; no client access to `auto_approval_policies` | invariant #13, #14 |
| LLM spend | Redis reservation before the call | `cost-guard` skill |
| Auth flows, signup | Supabase Auth owns passwords and sessions | `.claude/rules/supabase-auth.md` |
| Bots, WAF, edge limits | | `.claude/rules/security-edge.md` |
| Logging | `createWorkerLogger`; never raw review/response text, tokens, secrets, MFA codes | CLAUDE.md § Structured logging |
| Secrets in commands | never a literal argument in Bash | user rules § Secrets |

## 3. Always, ask first, never

**Always:** validate external input at the boundary and narrow `unknown`;
parameterize SQL (Postgres.js tagged templates — never string-built SQL);
rely on React's escaping; give every outbound provider call an explicit
timeout and bounded, jittered retries; make every handler idempotent on the
outbox key.

**Ask the owner first:** a new or changed auth flow; a new category of
personal data; a new external integration; a CORS or CSP change; a file upload;
any change to rate limiting, the trust dial, the veto window, or an autonomy
flag (`flag-flip` skill); any granted role or widened RLS policy.

**Never:** a secret in source, a log, an outbox payload, or a prompt; a raw
approval token at rest; client-side validation as a boundary; `eval` or
`innerHTML` on data; a stack trace or internal error returned to a user.

## 4. Patterns generic to any codebase

**SSRF.** Any URL a user or provider influenced — a webhook target, an
import-from-URL, an image or link preview — can be aimed at `localhost`, cloud
metadata (`169.254.169.254`), or a private range. Allowlist scheme and host,
resolve ALL DNS records and reject if any is non-unicast, forbid redirects.
Known gap: `fetch` resolves again after the check (DNS rebinding) — for a
high-risk surface, connect to the pinned IP or use a filtering agent.

**Destructive operations on derived paths or ids.** A delete, overwrite, or
purge is only as safe as the value naming its target. A shape check ("looks
like a UUID", "absolute path") proves well-formedness, not authorization.
Require: the target sits under an allowlisted root or tenant; it is not the
root itself; ownership evidence is read from authenticated state BEFORE the
operation. On refusal, log and stop — never fall back to a broader default.
The nearest surface here is owner offboarding (`.claude/rules/offboarding.md`).

**LLM features (OWASP LLM Top 10).** Model output is untrusted input: parse,
schema-validate, then use — never into SQL, a shell, a path, or markup.
Review text is attacker-controlled prompt content; the system prompt is not a
security boundary, so enforce permissions in code. Keep secrets and other
tenants' data out of every prompt. Scope tool and agent permissions to the
minimum; an irreversible or public action needs a recorded approval. Bound
tokens, rate, and loop depth.

**Dependencies.** An audit finds KNOWN advisories; it does not find a newly
malicious or typosquatted package. Triage by severity × reachability. Never
apply a forced audit fix. Review a new dependency, its lockfile diff, and any
install-script policy change together: ownership, release age, provenance,
transitive graph. A manifest edit needs `.feature/deps-justification.md`.

**Personal data.** The cheapest data to protect is data never collected.
Collect a field only against a stated purpose; give it a retention limit and a
working deletion path that reaches backups, caches, and analytics copies;
sending PII to an analytics or LLM vendor is sharing and needs a basis. Check
consent and suppression rules before any outbound message
(`.claude/rules/solicitation.md`).

## 5. Where generic advice is wrong here

- **"Fail closed everywhere."** RepWorth's API rate limits fail OPEN by design;
  the Redis cost reservation that precedes every LLM call is what protects
  spend. Do not make the limiters strict. Read
  `.claude/reference/lab-notes/worker-crash-net-cost-guard.md` § Cost-guard
  fail-open/retry matrix before changing any fallback.
- **"Hash passwords with bcrypt."** Supabase Auth owns credentials. Approval
  tokens are SHA-256 hashed by design (high-entropy random tokens, not
  passwords). Use `node:crypto`, never `crypto-js`.
- **"Proxy the webhook through the app."** Ingress terminates on Railway.
- **A browser test with a service credential** does not prove the owner
  authorization path. Exercise it as the real actor.

## 6. Output — what this skill adds to the plan

- The trust boundaries and assets, in two or three lines.
- For each boundary: the seam from §2 it reuses, or why none fits.
- Negative test titles added to `tests_to_add`.
- Any "ask first" item, surfaced to the owner before implementation.

## Red flags

- Input reaching SQL, a shell, a path, or markup without validation.
- A route or job that reads or writes without `account_id` scoping.
- A state change followed by a separate enqueue.
- A webhook handler that parses before it verifies.
- A `SELECT … FOR UPDATE` outside `sql.begin()` relied on as a lock.
- A token, review text, or provider secret in a log line or an outbox payload.
- A new fallback that turns a failure into a silent success.
- A destructive target built from a payload with only a shape check.

Adapted for RepWorth from `security-and-hardening` in
addyosmani/agent-skills @ `c004a74` (MIT). Notice:
`docs/agents/third-party-skills.md`.
