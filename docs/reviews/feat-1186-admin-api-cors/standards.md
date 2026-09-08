# Standards & maintainability review — `feat/1186-admin-api-cors`

Axis: standards, module depth, seam placement, locality, duplication, speculative
generality, error handling, test coupling, naming, dependency growth.
Read-only. Committed tree only (`git show 4f132aae:<path>`), fork point `c2de39d8`.
Production diff 398 lines / 4 files. Skill: `thermo-nuclear-code-quality-review`.

Checked against `docs/reviews/finding-checklists/standards-maintainability.md`
before reporting: the accepted classes that recur here are **wrong/stale citations**,
**counting claims**, **a test whose title promises more than its assertion**,
**a duplicated helper with no owner**, and **a self-referential assertion**. All five
appear on this branch; each finding below names which.

---

## Verdict on the shape

The seam is right. Decision-out / headers-in is the correct split, the CORS block
running first inside `proxy()` is correct and well argued, and the loopback rule
being terminal rather than list-driven is the security property the plan says it is.
Nothing here is a structural regression, and I found no code-judo move that deletes
a whole layer — the design is close to minimal for what ADR 0026 locks.

Three judgements the brief asked for explicitly:

**`proxy()` / `handleProxy()` — right shape, not two entry points.** `handleProxy`
is private, `proxy` is the sole export the framework calls. The wrapper exists to
post-stamp every exit, which D-2 justifies (four exits today, more coming). This is a
decorator, not a second door. One wart: `normalizePath(...)` is computed in both
(`:120` and `:157`), so two places must agree on the same derivation — passing
`routePath` down would remove that.

**`addVaryOrigin` exported for its test — acceptable, but avoidable, and I'd move
it.** See F9. I am NOT arguing with ADR 0026 D1: `Vary` is not an `Access-Control-*`
header, and the proxy would still be the only thing that *applies* it. Keeping the
merge logic is right (deleting it because it is unreachable today is the wrong
direction); the question is only where the pure helper lives.

**`src/lib/config/admin-origins.ts` as a new file — yes, forced.** §1's argument
holds on the code: `scripts/ci/process-env-baseline.ts` allowlists the
`src/lib/config/` prefix as the sanctioned `process.env` home, `flags.ts` is boolean
`*_ENABLED` readers, `deployment-lane.ts` is lane resolution, `server.ts`/`client.ts`
are Zod lane schemas. An origin allowlist is none of those, and invariant #12 wants
the decision branch named and focused-tested. New file justified.

**`csrf.ts` after the change — still one module.** 75 lines, three exports, all
answering "is this request from us?". `isSelfOrigin` is `assertSameOrigin`'s own core
promoted, which narrows rather than widens. Not two things.

**Comment density — earns its keep, with one exception.** I read every added comment
block for restatement. They explain WHY (why the loopback return is terminal, why the
preflight must precede branch 4, why the header list is a constant). The exception is
duplication across the *docs* layer, not the code — see F11.

---

## Findings

| # | Sev | file:line | Standard / smell | Finding |
|---|---|---|---|---|
| F1 | medium | `src/proxy.ts:49` | canonical-helper duplication; logic in the wrong layer | `isAdminApiRoute` re-spells the `/api/admin` route set that `src/lib/shared/protected-routes.ts:85` already owns inside `isProtectedRoute`. |
| F2 | medium | `src/lib/config/admin-origins.ts:63` | copy-pasted helper, no owner | An identical private `parseUrl` is added twice in one PR, the other at `src/lib/shared/csrf.ts:9`. |
| F3 | medium | `src/lib/config/__tests__/admin-origins.test.ts:208` | guard reproduces a bypass its own cited precedent documents | The import scan matches only `from '<spec>'`; `import 'postgres';`, `require()` and dynamic `import()` pass. |
| F4 | medium | `src/lib/config/__tests__/admin-origins.test.ts:189` | test title promises more than the assertion delivers | "the CORS import graph" is a hardcoded 4-file list with no transitive closure — and the stated property is already false at HEAD. |
| F5 | medium | `.claude/reference/arch-review-log.md:36` | counting claim is wrong | "40 proxy tests + 37 config/CSRF tests" — measured 23 and 18. |
| F6 | low | `src/lib/config/admin-origins.ts:144` | citation resolves to nothing | Cites "ADR 0026 D14"; ADR 0026 has D1–D8. |
| F7 | low | `src/__tests__/proxy.test.ts:582` | self-referential (vacuous) assertion + dead constant | `expect(ALL_ACCESS_CONTROL_HEADERS).toHaveLength(6)` asserts a literal about itself, and the trailing comment is false. |
| F8 | low | `src/proxy.ts:130` | one variable, two meanings across a guard | `origin !== null` means "header present" before the refusal and "present AND allowed" after it; also normalizes twice. |
| F9 | low | `src/proxy.ts:65` | export widened for a test, on a framework convention file | Pure `Headers` utility exported from a Next 16 proxy-convention module whose documented exports are the proxy function + optional `config`. |
| F10 | low | `src/lib/config/flags.ts:37` | doc comment attached to the wrong symbol | The `requiresProductionConfig` paragraph documents `isProductionEnvironment` (`:49`) but sits on `isPreviewEnvironment` (`:45`). |
| F11 | low | `docs/directory/lib-dashboard-locations-accounts.md:9` | one-owner-per-fact | The parser throw list + terminal loopback rule is written out in full in three live places. |
| F12 | low | `src/lib/shared/__tests__/csrf.test.ts:190` | copy-pasted helper + copy-pasted rationale | Second copy of `stripComments` and of its load-bearing-order comment. |
| F13 | low | `docs/superpowers/plans/feat-1186-admin-api-cors-plan.md` §5 D-2 | fork-relative citation, stale at HEAD, lands on plausible lines | `src/proxy.ts:141,:145,:149,:263` now resolve to unrelated code. |

---

### F1 — `isAdminApiRoute` duplicates `protected-routes.ts`'s route set
`src/proxy.ts:49-51`

```ts
/** The Admin API surface, matched exactly as `isProtectedRoute` matches it. */
function isAdminApiRoute(routePath: string): boolean {
  return routePath === '/api/admin' || routePath.startsWith('/api/admin/');
}
```

`src/lib/shared/protected-routes.ts:85` already carries that exact expression, and
that module is the repo's canonical owner of "which routes are what" — it exports
`normalizePath`, `isProtectedRoute`, `isProtectedOwnerApiRoute`,
`isProtectedMixedRoleApiRoute`, and the proxy already imports four of them.

The docblock is an admission: "matched exactly as `isProtectedRoute` matches it" is a
comment doing the job an import should do. This is the same defect class this branch
exists to close one instance of — ADR 0026 D4 refuses two copies of the own-origin
comparison for exactly this reason, and then the same PR opens a second copy of the
admin-path comparison one layer up. (`handleProxy`'s branch 4 uses a third, looser
spelling, `startsWith('/api/admin')`; D-7 deliberately leaves that alone, which is
fine — but it means the pipeline now has three spellings, not two.)

**Smallest correction.** Export `isAdminApiRoute` from
`src/lib/shared/protected-routes.ts`, call it from `isProtectedRoute`'s disjunction,
import it in `src/proxy.ts`. Net line change is roughly zero and the two spellings
become one.

---

### F2 — `parseUrl` introduced twice in the same PR
`src/lib/config/admin-origins.ts:63` and `src/lib/shared/csrf.ts:9`

Both are new on this branch and the bodies are byte-identical:

```ts
function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}
```

`admin-origins.ts` already imports from `csrf.ts` (`isSelfOrigin`), so there is no
dependency obstacle. The precedent this branch itself sets — ADR 0026 D4, "two
copies of this test can disagree" — applies with equal force to the parse step that
feeds the comparison, and the checklist has already accepted a finding of this exact
shape (`useHasHover` re-implementing `useMediaQuery`, two definitions with no owner).

**Smallest correction.** Pick one owner. Either add `parseUrl` to the existing
`@/lib/shared/csrf` import in `admin-origins.ts`, or — if widening `csrf.ts`'s
surface is unwanted — keep `parseUrl` private in `admin-origins.ts` and have
`csrf.ts` import it, since `csrf.ts` is the module with 20 importers and the smaller
public surface to protect.

---

### F3 — the Edge-safety guard reproduces the bypass its own precedent red-teamed
`src/lib/config/__tests__/admin-origins.test.ts:208`

```ts
const specifiers = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
```

The test's own comment names its precedent: `src/lib/auth/__tests__/admin-transport.test.ts`
§ "Edge safety" (#1183). That precedent's comment (`:113-124`) says, in its own words:

> The first version of this guard matched `^\s*import .* from ` per line and a
> red-team pass walked straight through it twice: `import 'node:crypto';` has no
> `from` […] A guard that only catches the tidy form of a violation is not a guard.

The new guard fixes the *line-shape* half of that (using `matchAll` over the whole
file) and reintroduces the *no-`from`* half. `import 'postgres';`,
`import 'node:crypto';`, `require('bullmq')` and `await import('@/lib/db/server')`
all pass green today in any of the four scanned files.

**Smallest correction.** Follow the precedent's assertion shape: after extracting
specifiers, also assert `expect(code).not.toMatch(/\bimport\s+['"]/)` (side-effect
imports) and `expect(code).not.toMatch(/\brequire\s*\(/)`, or switch the extraction
regex to `/(?:from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g`.

---

### F4 — the guard's title claims a graph; it asserts a hardcoded list
`src/lib/config/__tests__/admin-origins.test.ts:186-193`

Title: *"keeps the CORS import graph free of node builtins, database clients and
forbidden SDKs."* The body scans four hardcoded paths and their **direct**
specifiers only. Two consequences:

1. **It cannot follow the graph it names.** If `admin-origins.ts` grows an import of
   a new local module that itself imports `postgres`, the test stays green. The
   whole reason the module header calls this "Edge-safe by construction" is that
   nothing else guards `src/proxy.ts` (it is outside every ESLint invariant #1 zone),
   so a guard that stops at depth 1 is the only line of defence and it is one edge
   deep.
2. **The stated property is already false.** `src/proxy.ts:2` imports
   `@supabase/ssr`, which depends on `@supabase/supabase-js` — a specifier on this
   test's own `forbidden` list. The guard passes because it never leaves depth 1.

This is the checklist's accepted class verbatim: *"the comment claims [X] while
asserting only [Y] … a comment that promises a guarantee the assertion does not
provide."*

**Smallest correction.** Either (a) narrow the title and the module header to what is
asserted — "no forbidden **direct** import in the four CORS files" — and drop
`@supabase/supabase-js` from `forbidden` (or note why `@supabase/ssr` is exempt), or
(b) walk relative/`@/` specifiers transitively from `src/proxy.ts` and scan the
closure. (a) is the honest one-line fix; (b) is the one that matches the title.

---

### F5 — the arch-review-log's test counts are wrong
`.claude/reference/arch-review-log.md:36` — "40 proxy tests + 37 config/CSRF tests"

Measured on the committed tree at `4f132aae`:

| | count |
|---|---|
| `it(` in `describe('admin API CORS')` (this branch's proxy tests) | **23** |
| `it(` in all of `src/__tests__/proxy.test.ts` | 40 (17 pre-existing) |
| new `it(` across `admin-origins` + `csrf` + `flags` | **18** (12 + 5 + 1) |
| all `it(` in those three files | 31 (12 + 14 + 5) |

"40" is the *file* total, not the branch's contribution, and it happens to collide
with the intake's 40 owed titles — which is exactly what makes it read as correct.
"37" matches neither 18 nor 31. The checklist has accepted this class before
("Three counting claims are wrong … a count is exactly the kind of claim that goes
stale silently").

**Smallest correction.** "23 new proxy tests (40 in the file) + 18 new config/CSRF
tests", or drop the numbers.

---

### F6 — "ADR 0026 D14" does not exist
`src/lib/config/admin-origins.ts:144`

> `* about (ADR 0026 D14 — a canonical-output rule; a browser's own serialization`

ADR 0026 has eight decisions, D1–D8 (`docs/adr/0026-admin-api-cors.md:84,105,132,162,193,200,208,244`).
The intended referent is the **plan's** delta **D-14**
(`feat-1186-admin-api-cors-plan.md` §5). Every other ADR citation in the diff resolves
(D1, D2, D3, D4, Consequences); this one sends a reader to a locked document that has
no such decision, which reads as the ADR being stale rather than the comment.

**Smallest correction.** `(plan §5 D-14 — a canonical-output rule; …)`.

---

### F7 — a constant that is only asserted about, never used
`src/__tests__/proxy.test.ts:294` and `:582`

```ts
const ALL_ACCESS_CONTROL_HEADERS = [ /* 6 header names */ ] as const;
...
expect(ALL_ACCESS_CONTROL_HEADERS).toHaveLength(6); // the list this test sweeps
```

Those are the constant's only two occurrences in the repo. The test that "sweeps" it
does not: it uses `accessControlHeaderNames(response)` and four individual
`.get()` calls. So the assertion compares a literal array to its own literal length —
the same vacuity class the checklist accepted ("a test that compares a value to
itself"), and the trailing comment states a mechanism that does not exist.

**Smallest correction.** Delete both, or make the sweep real:
`for (const h of ALL_ACCESS_CONTROL_HEADERS) expect(refused.headers.get(h)).toBeNull();`
— which would give the constant a job and strictly strengthen the refusal assertion.

---

### F8 — `origin` carries two meanings across the refusal guard
`src/proxy.ts:128-147`

```ts
const origin = rawOrigin === null ? null : normalizeOrigin(rawOrigin);

if (rawOrigin !== null && (origin === null || !isAllowedAdminOrigin(origin, allowlist))) {
  return adminOriginRefusal();
}
if (origin !== null && request.method === 'OPTIONS') { ... }
...
if (origin !== null) { response.headers.set('Access-Control-Allow-Origin', origin); }
```

Before the guard, `origin === null` means "absent **or** unparseable" — and the
comment at `:129-131` says exactly that. After the guard, the unparseable arm is
gone, so `origin !== null` silently changes meaning to "present **and allowed**".
Nothing states that, and the two later reads depend on it for correctness. The plan's
own pseudocode (§2) carried a tri-state `allowed: true | false | null` and named it;
the implementation collapsed the state without replacing the name.

Related: `normalizeOrigin(rawOrigin)` runs in the proxy, then `isAllowedAdminOrigin`
normalizes the already-normalized value again (`admin-origins.ts:178`). Harmless
(idempotent), but it means the module's documented totality over raw input is never
exercised at its only call site, and a reader cannot tell which side owns
normalization.

**Smallest correction (either):** (a) one comment above the OPTIONS branch — "past
this point `origin !== null` means present AND allowed"; or (b) collapse the seam:
have `admin-origins.ts` export
`resolveAllowedAdminOrigin(raw: string | null, allowlist): { kind: 'absent' } | { kind: 'refused' } | { kind: 'allowed'; origin: string }`,
which normalizes once, names all three states, and removes both `null` overloads and
the double parse.

---

### F9 — `addVaryOrigin` exported from a framework convention file for its test
`src/proxy.ts:65`

The docblock is candid: *"Exported for its test: the merge cases cannot be reached
through `proxy()`."* Two things make this worth moving rather than accepting:

1. **`src/proxy.ts` is a Next 16 file-convention module.**
   `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
   § Exports: *"The file must export a single function, either as a default export or
   named `proxy`"*, plus optionally `config`. At the fork point the file exported
   exactly those two. Next does not currently enforce it (build is green), so this is
   not a circumvented tool — but it is a documented convention, and CLAUDE.md's
   Next-16 working rule points at this file.
2. **The helper has zero coupling to the proxy.** It takes a `Headers` and mutates
   it. Nothing about it needs to live next to the request pipeline.

I am explicitly **not** arguing that the merge logic should be deleted because four
of its five branches are unreachable today — `Vary` merging is cheap insurance and
D-15 is right that a `set()` would silently drop `Accept-Encoding` the day an exit
grows one. And I am not arguing with ADR 0026 D1: `Vary` is not an
`Access-Control-*` header, and the proxy remains the only thing that *applies* it,
exactly as it remains the only header-writer while `admin-origins.ts` owns the
decision.

**Smallest correction.** Move `addVaryOrigin` to `src/lib/shared/` (or alongside
`normalizeOrigin` in `admin-origins.ts`) with its unit test, import it in the proxy,
and `src/proxy.ts` goes back to two exports.

---

### F10 — the new flags.ts paragraph documents the wrong function
`src/lib/config/flags.ts:37-44`

The `requiresProductionConfig()` explanation is appended to the comment block that
sits immediately above `isPreviewEnvironment()` (`:45`). Every sentence in it is
about `isProductionEnvironment()` (`:49`), which has no comment at all. On hover, a
reader gets the paragraph on the wrong symbol and nothing on the right one.

**Smallest correction.** Move the new paragraph below `isPreviewEnvironment`'s body,
directly above `isProductionEnvironment`.

---

### F11 — three live copies of the `ADMIN_APP_ORIGINS` behaviour
`docs/directory/lib-dashboard-locations-accounts.md:9`,
`.claude/reference/env-vars.md:48`, `.env.example:131-139`

`docs/agents/context-layout.md:19`: *"One owner per fact. When a fact moves, the old
location gets a pointer, not a copy … Two live copies drift, and the reader cannot
tell which one is current."*

The branch gets the `docs/eservices-variables.md` row right — it summarizes and
points ("Behavior row: `env-vars.md`"). The other three each write out the full
parser rule set independently: wildcard throws · unparseable throws · non-`http(s)`
scheme throws · userinfo/path/query/fragment throws · bare trailing slash normalizes ·
loopback is code-only and terminal in production. That is the same six facts in three
places, plus the code's own docblocks.

**Smallest correction.** Keep `.claude/reference/env-vars.md` as the behaviour owner
(it already declares itself so). Trim the directory row to what a directory row is
for — what the file is and its exports — and end it with "behaviour:
`.claude/reference/env-vars.md`". `.env.example` keeps the two lines a developer
needs (server-only; leave empty locally) and points.

---

### F12 — the comment-stripper is duplicated, comment and all
`src/lib/config/__tests__/admin-origins.test.ts:23` and
`src/lib/shared/__tests__/csrf.test.ts:190`

Same two regexes in the same order, and the load-bearing "line comments first"
rationale written out twice. DEV-6 records the trap honestly and says it belongs in
the lab notes — but the resolution shipped two copies rather than one owner, so the
next person who improves one (say, to handle a `/*` inside a string literal) fixes
half the guards. The failure mode DEV-6 itself names is that a structural guard
*silently scans an empty file and passes* — a drifted second copy is precisely how
that comes back.

**Smallest correction.** One exported helper next to whichever guard is canonical,
imported by the other; the rationale comment lives with the helper.

---

### F13 — plan §5 D-2's proxy citations are stale at HEAD
`docs/superpowers/plans/feat-1186-admin-api-cors-plan.md` §5 D-2

> "A `/api/admin/**` request leaves `proxy()` from four sites today
> (`src/proxy.ts:141`, `:145`, `:149`, `:263`)"

Those resolve at the fork point. At `4f132aae` they land on
`addVaryOrigin(response.headers);`, a comment fragment (`// serialization is already
identical to it.`), a bare `}`, and `return redirectToMfaChallenge();`. All four look
plausible enough that a reader does not notice the miss — the checklist's accepted
wording for exactly this: *"Landing on a plausible-looking line is worse than landing
on nothing. Cite by symbol."* Same mechanism as before: the commit that writes the
citation is the commit that moves the target.

**Smallest correction.** Cite by symbol — "branch 4's three exits plus `handleProxy`'s
terminal `return response`".

---

## Low-confidence appendix (NOT in the table)

- **"Edge" framing may be factually wrong for Next 16.**
  `node_modules/next/dist/docs/.../file-conventions/proxy.md` § Runtime: *"Proxy
  defaults to using the Node.js runtime. The `runtime` config option is not available
  in Proxy files."* Several new comments lean on `src/proxy.ts` running "at the
  request edge" (`admin-origins.ts:29-31`, the Edge-safety test's rationale, which
  forbids `node:` imports that the Node runtime would permit). I am not reporting
  this: the "Edge proxy" vocabulary predates this branch (`src/proxy.ts:19` at the
  fork point) and I have not verified how Vercel actually runs it. If it is wrong it
  is a repo-wide vocabulary bug, not this branch's — worth an owner question.
- **Plan §2 promises test #23 uses "mixed-case **and tab-bearing** fixtures";** the
  shipped test (`proxy.test.ts:688-693`) uses only the mixed-case one. Possibly a
  deliberate drop (a tab in an `Origin` value may not survive `Headers`
  construction). Flagged for the spec axis, not judged here.
- **`admin-origins.ts` (config layer) depending on `shared/csrf.ts`** is a slightly
  odd direction for a config module, and it puts the CSRF module on the proxy's hot
  path for every `/api/admin/**` request. Defensible under D-5 and the module is
  dependency-free; noted only so a future reader knows it was considered.
- **`src/proxy.ts:30`** says the three constants "are the only `Access-Control-*`
  values in the repo", but the header *name* `'Access-Control-Allow-Origin'` is a
  repeated string literal at `:93` and `:146`. The claim is true read as "values";
  too nitty to action.
- **`csrf.test.ts:133`** sets `process.env.ADMIN_APP_ORIGINS` and never restores it
  (that file's `afterEach` only restores `NEXT_PUBLIC_APP_URL`). Harmless today —
  nothing in that file reads it — but it is env leakage between tests.
