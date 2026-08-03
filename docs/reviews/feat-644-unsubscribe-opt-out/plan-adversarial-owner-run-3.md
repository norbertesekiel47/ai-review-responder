# #644 plan revision 6 — owner-run `/codex:adversarial-review` #3

**Verdict: needs-attention** · 4 high. All four **ACCEPTED**.
**No revision 7 was written** — two workflow abort criteria fired instead. See
`feat-644-unsubscribe-opt-out-postmortem.md`.

---

## 1. HIGH — unmatched unsubscribe URLs can log the raw token

`logLevel: 'silent'` applies **only after the exact route resolves**. Revision 4 deliberately
requires `/ingress/unsubscribe/<token>/extra` to remain a rate-limited 404 — and those
paths resolve to *no* route, so they carry no silent config. Fastify logs the raw request
URL before `onRequest`, so a valid token plus a trailing segment lands in logs.
**Invariant #5 violation.**

**ACCEPT.** Self-inflicted: revision 4 created this by requiring 404s under the prefix to
stay throttled, and revision 5/6 never revisited what that meant for logging. Round 2's
reviewer originally offered two fixes — "disable request logging for the route **or** install
a token-redacting request serializer" — and I picked the cheaper one, which only ever
covered matched routes.

**Fix requires the global serializer in `worker/config/fastify-options.ts`** → that file is
outside the 21-glob edit surface → **surface amendment #2** → abort criterion.

## 2. HIGH — the Vercel routes have no database workload bound

The §1.4b semaphore protects Railway only. T2 excludes rate limiting and BotID by design,
yet both Vercel routes do DB work: GET resolves the token, POST opens the redemption
transaction. Anonymous random-token traffic fans out across serverless instances and can
exhaust the shared Supavisor backend, delaying unrelated writes *and* legitimate opt-outs.

**ACCEPT, and it is worse than stated for my design**: an in-process semaphore is
meaningless on Vercel, where each serverless instance has its own. The Railway bulkhead does
not generalise to the Vercel half at all, and I never noticed because I designed the bound
on the Railway side and assumed it covered the feature.

## 3. HIGH — the bulkhead can permanently discard valid opt-outs

Under an unknown-token flood, arbitrary requests occupy every semaphore permit and a valid
provider POST is shed. §1.4b claims this is "only deferred… no opt-out is lost", while §1.7
**explicitly admits there is no evidence providers retry a 503**. `Retry-After` is advisory.
So the overload control introduces an intentional silent-loss path for a statutory opt-out.

**ACCEPT — this is a self-contradiction between two sections of my own plan.** §1.7 was
written honestly; §1.4b then leaned on the very assumption §1.7 refuses to make. The
no-loss claim is unsupported and must be withdrawn.

## 4. HIGH — a signed receipt can outlive the suppression it claims

Receipt verification proves only that a suppression existed **when the receipt was minted**.
The success page performs no lookup for ten minutes. If the audited Correction path removes
the suppression after the POST — or races the spent-token ledger check — GET still renders
"You're unsubscribed" while no suppression exists.

**ACCEPT. This is the THIRD distinct false-success vector**, after `?done=1` (owner-run #1)
and spent-token replay (owner-run #2). The mechanical fix is small — verify the live ledger
on GET as well as at mint — but three vectors in three passes is a design signal, not three
unlucky bugs. See the post-mortem's root-cause section.
