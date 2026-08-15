# Adversarial approach review — codex (step 7, round 1)

**Target:** branch diff against `682681ab3f656a8bad2811dbf50176070343370f`
**Reviewer:** `codex exec` via `/codex:adversarial-review --background`
**Thread id:** `01a005f5-fad0-7f81-8279-8fc3cdea185f`
**Verdict returned:** `needs-attention`

> **Report authored by the orchestrator, not by codex.** Codex ran in a
> read-only sandbox and reported: *"Requested report file could not be written
> because the workspace is read-only."* Its finding is reproduced verbatim
> below under "Finding as returned"; everything under "Orchestrator grounding"
> is the orchestrator's own verification against the tree, added because a
> trust-boundary claim should not be triaged from a reviewer's summary alone.

## Findings table

| Severity | file:line | Finding |
|---|---|---|
| Medium | `src/app/api/_shared/channels/resolve-actor.ts:45-48` (guard: `scripts/ci/admin-aal2-audit.ts:40,64`) | The portal trust boundary is rebindable rather than structural: both resolvers satisfy one callable type, and the compensating AAL2 audit is a substring scan that a *mention* of `resolveAdminActor` satisfies. |

## Finding as returned (verbatim)

> **[medium] The shared resolver type makes the portal trust boundary rebindable
> (src/app/api/_shared/channels/resolve-actor.ts:45-48)**
>
> Both portal resolvers satisfy the same callable type and are accepted as
> arbitrary runner configuration. An admin route can therefore bind the owner
> resolver (skipping AAL2) or an owner route can bind the admin resolver;
> TypeScript cannot reject either. The AAL2 audit only checks whether route text
> contains `resolveAdminActor`, not that `config.resolveActor` invokes it, so an
> unused or aliased reference can satisfy the audit while the wrong resolver is
> bound. Current shims are tested, but this leaves the claimed structural tenant
> boundary as convention plus brittle text scanning.
>
> Recommendation: Do not accept arbitrary `ChannelActorResolver` bindings. Use
> portal/action-specific config factories or branded admin/owner actor
> capabilities, and enforce the actual resolver binding with an AST audit or
> portal-specific import restrictions.

Codex's summary line labelled this "No-ship", while rating the finding itself
`[medium]`. Those disagree; the orchestrator triages on the `[medium]` rating,
for the reasons in the verdict below.

## Orchestrator grounding (verified against the tree, not taken from the summary)

The finding decomposes into two claims that deserve separate verdicts.

**Claim A — the gate moved from structural to config-bound. TRUE, and new with
this refactor.** Before, `runAdminChannelStart/Cancel/Disable` were admin-only
helpers that called `requireAdminWithAal2` unconditionally; an admin route using
one could not skip MFA step-up. After, the runners are portal-agnostic and call
`config.resolveActor` — a value supplied per route. `ChannelActorResolver`
(`resolve-actor.ts:45-48`) is a bare callable type that both resolvers satisfy,
so `tsc` cannot reject a mis-binding. The branch is aware of this: it is exactly
why the audit's allowlist was repointed from the runners to `resolveAdminActor`
(`scripts/ci/admin-aal2-audit.ts:26-40`, and the deviations log's step-5 entry).

**Claim B — the compensating audit can be satisfied by a mention. TRUE, and
demonstrable.** `scanRouteFile` returns clean when
`GATED_SHARED_HELPERS.some((helper) => text.includes(helper))`
(`scripts/ci/admin-aal2-audit.ts:64`). That is a substring test over the whole
file, so ANY occurrence of the string `resolveAdminActor` clears the route —
including one in a header comment or an import that the file does not bind.

Concrete failure scenario:

```ts
// POST /api/admin/channels/telegram/start — handler resolves via resolveAdminActor.
import { runChannelStart } from '@/app/api/_shared/channels/start';
import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelStart(sql, req, { channel: 'telegram', resolveActor: resolveOwnerActor }),
);
```

The comment alone clears the audit. The route is an admin mutation that runs
under `requireRoleOr401` with **no MFA step-up**. Every real admin route in this
branch carries exactly such a header comment naming its handler, so this is
drift-shaped, not contrived.

Test case `(k)` (`scripts/ci/__tests__/admin-aal2-audit.test.ts:150`) does pin
the regression — but its fixture never mentions `resolveAdminActor`, so it
exercises only the variant where the author also removed the admin import. One
token's difference walks past it.

**What the finding is NOT.** No route on this branch is mis-bound: all 12
bindings are correct and pinned by `src/app/api/admin/channels/__tests__/bindings.test.ts`.
This is a latent CI-guard gap — a future-drift hardening finding — not an
exploitable defect in the shipped diff. Bounding the blast radius of the
hypothetical: a mis-bound admin route resolves through the owner's SESSION, so
it does not hand an attacker a cross-tenant read; the harm is an admin mutation
silently downgraded to owner-level auth with the AAL2 step-up skipped.

## Verdict

**ACCEPT claim B (fix now, narrowly). REJECT claim A's recommended remedy
(branded capabilities / config factories) as out of scope for this branch.**

Rationale: the recommended structural remedy — branded actor capabilities or
portal-specific config factories — is a seam redesign. The plan's own tripwire
says a fifth `ChannelRouteConfig` field means the seam is wrong and the answer
is to re-plan (step 3), not to patch it in a review round; adopting it here
would widen the interface the refactor exists to keep narrow, on a latent
finding, after the gate is green. That is a step-3 decision, and it is recorded
in the PR description as a deliberate deferral rather than an oversight.

What makes claim A dangerous is claim B: a config-bound gate is acceptable when
a mechanical check proves the binding, and unacceptable when the check can be
satisfied by a comment. So the fix targets B and leaves the seam at four fields.
`scripts/ci/admin-aal2-audit.ts` is already inside `allowed_edit_surface`
(amendment 1), so this is not a second amendment.

**Fix applied — in two passes, because the first was under-engineered and the
gate caught it.**

*Pass 1* added a deny rule: an admin route referencing `resolveOwnerActor` is a
FINDING regardless of what else the file contains. It failed the very next gate
run on a REAL route — `src/app/api/admin/channels/telegram/start/route.ts`, whose
header comment reads "The owner equivalent … binds the same runner with
resolveOwnerActor" while correctly binding `resolveAdminActor`.

That false positive is the finding's own lesson, arriving from the other side: a
whole-file substring test is the wrong instrument in BOTH directions. A mention
can CLEAR the allowlist (codex's hole), and a mention can TRIP the deny rule (the
gate's). Patching only the direction codex named would have left the instrument
just as wrong.

*Pass 2* fixed the instrument. `scanRouteFile` now strips comments and runs every
check — mutation-verb detection, gate token, allowlist, deny rule — against CODE
(`stripComments`, `scripts/ci/admin-aal2-audit.ts`). Only full-line `//` comments
are removed so a string containing `https://` is never mistaken for one. Three
cases pin it: `(m)` both resolvers imported → finding, `(n)` the shipped
admin-bound shape → clean, `(o)` a comment naming the owner resolver on a
correctly-bound route → clean. `pnpm ci:admin-aal2` passes across all 32 admin
route files.

This lands closer to codex's actual recommendation ("enforce the actual resolver
binding") than pass 1 did, without the AST rewrite or the seam redesign.

**Accepted residual risk (recorded, not fixed):** the audit is still a text scan
over stripped code, so an admin route that binds a resolver *aliased* through
another module (`import { resolveOwnerActor as r }`, or a re-export) still clears
it, as does an unused `resolveAdminActor` import (though `no-unused-vars` covers
that shape in this repo). Closing the alias case requires the AST audit codex
recommends. Deferred deliberately: an alias is deliberate evasion rather than
drift, and this audit is one of several controls — `bindings.test.ts` pins every
real binding. Promote to a lab-notes entry at step 8 so the next person to touch
this audit knows where its floor is.
