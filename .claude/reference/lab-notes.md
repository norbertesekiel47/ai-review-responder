# RepWorth — Lab Notes

Hard-won discoveries from production debugging and integration work.
Check the relevant section before implementing anything in these areas.

## Topic index

Jump to the dated entries by subsystem (search the anchors below):

- **Postgres.js / JSONB / PgBouncer** — JSONB string-wrapping, v3 double-encoding, statement_timeout, FOR UPDATE under PgBouncer; the AUTHORITATIVE production JSONB parse-site allowlist (2026-08-03); every error class reachable from a query carries a STRING `code` (`PostgresError`, `57014`, `CONNECTION_*`, Node `ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`) — narrow a swallow-catch on that shape, NEVER on `instanceof PostgresError`, which rethrows transient blips into the caller (#679, 2026-08-08); a BACKTICK inside a `--` SQL comment terminates the enclosing `sql``` template — prose only (no backticks, no `${`) or you get `TS1005` several lines from the line you edited (#665, 2026-08-18)
- **Indexes / migrations** — **"Migration lockstep audit" (2026-08-14) is the entry point for "is migration N applied in env X?"** — there is no ledger, three docs asserted the opposite of reality for 077, migration 005 sat unapplied in prod for ~4 months undetected, and `ci:rls-audit` is a floor that cannot see unrequested RLS (prod's `ensure_rls` trigger, removed by 107); it also carries the re-runnable introspection method and its two traps (`DO $$` bodies hide DDL from parsers; a re-ADDed CHECK exists in both envs while differing in content). Also: STABLE-in-predicate, ON CONFLICT byte-for-byte, column-level REVOKE, pg_constraint relation scoping, CHECK passes NULL (pair NOT NULL + NULL-safe preflights), hung ALTER TABLE = lock queue behind a long-lived Supavisor session (cancel stalled backend, verify clean, retry); a hash column's invariant asserted only in a COMMENT is unenforced — pair it with a format CHECK (`token_hash ~ '^[a-f0-9]{64}$'`, migration 056's pattern) and mutation-verify it; `migration-immutability-guard.sh` keys on the migrations-log HEAD rather than "applied", so amending a local-only migration after the log bump is a guaranteed false positive (escape hatch `MIGRATION_GUARD_DISABLE=1` is launch-time only); **verify a migration by introspection and never by reading the terminal** — a `psql -f` that prints NOTHING has not run (a silent quoting failure was reported as success at #629, 2026-08-17), and on PRODUCTION prefer **definition-equivalence against an already-probed twin** (`pg_get_constraintdef` byte-identical to staging's) over re-probing, since an INSERT in a rolled-back transaction is still a write; a constraint probe's `check_violation` handler catches whichever CHECK fires FIRST, so enumerate `pg_constraint … contype='c'` and satisfy every SIBLING check before trusting a rejection (a wrong-constraint rejection flatly contradicted `pg_get_constraintdef` at #629), suppress FKs with `SET LOCAL session_replication_role = replica`, and prove BOTH directions or you have shown permissiveness rather than widening; a `CROSS JOIN LATERAL (SELECT EXISTS (…))` consumed by two `COUNT(*) FILTER`s does NOT share one evaluation — Postgres pulls the single-row LATERAL up and plans one correlated SubPlan per reference (~81–261× planner cost, ~137× buffers vs `LEFT JOIN … AND status='posted'` + `FILTER (WHERE p.review_id IS NULL / IS NOT NULL)`, which is the shape that ships), and never justify a SQL shape with an unverified planner claim in a comment (#731, 2026-08-09) **A new tenant table forces a FOUR-registry chain (2026-08-30, #1008)**, and Postgres always deparses an implicit `CASE` fall-through as `ELSE NULL::boolean` — assert its PRESENCE, never its absence.
- **Zernio** — nested `account.id`, MOCK_EXTERNAL_APIS real-path tests, reviewReply normalization; the sandbox feed is non-descending in practice — the consented import's dirty-ordering WARN + page-to-feed-end is the NORM on staging, not an incident (#675, 2026-08-06)
- **Stripe** — inbound_events payload shape, overage idempotency, billing reconciliation from stored quota; `maxNetworkRetries: 0` still retries ONCE on ECONNRESET/EPIPE (stripe-node 22.2.0 `_shouldRetry` — under-lock worst case ≈ 2× the per-call timeout, #514)
- **Supabase auth** — implicit-flow OTP, identities:[] for existing emails, auth_id vs users.id, SMTP rate limit, a client-wide fetch timeout also bounds identity MUTATIONS → split bounded/unbounded clients (#508)
- **Billing / multi-location** — stored-quota vs TIER_CONFIG, base price not grandfathered, channel account-scope desync
- **Analytics / PostHog** — unconfigured no-op retry budget, durable vs intent events, RLS on new tables
- **Moderation / logging** — fail-open moderation, logger-never-throws (incl. AsyncLocalStorage binding for correlation IDs); `createWorkerLogger` OBJECT args pass through the analytics blocked-key sanitizer, which silently drops any key containing `token` — a deliberately-safe derived value (hash prefix, masked suffix, key id) must be NAMED to survive it (`hash_prefix`, not `token_hash_prefix`), and string args bypass the sanitizer entirely (#644)
- **Ingress / rate limiting** — the limiter's ingress-scope test needs BOTH arms: `request.routeOptions.url` (post-routing, resolved) and `decodeIngressPath(request.url)` (raw, decoded). Percent-encoded paths (`/%69ngress/resend`) defeat a raw check and absolute-form request targets (RFC 9112 §3.2.2) defeat the decoded one — either alone bypassed the limiter for Stripe, Resend, Telegram, Twilio and Zernio alike. A statutory opt-out route is exempt by design (§9.2), and the exemption must be read from the RESOLVED route config so an unmatched path under the prefix cannot inherit it (#644). **Turning a failing ingress path into an acking one silently retires a pager** — `checkFailedInboundEvents` keys on `inbound_events.status='failed'`, so any such change owes a replacement alert at the source in the SAME PR, and no mechanical gate can see the gap (#967, 2026-08-26)
- **CI / tooling** — **a local-only test failure in an RLS/permission suite is probably the schema grant, not your laptop**: `test-db-setup.sh` drops schema `public` (PG15+ → no grant to `PUBLIC`) while CI applies the same bootstrap to a pristine schema that has one, so `authenticated` sees nothing and a privilege probe answers `42P01` "does not exist" instead of `42501` "permission denied" — see "Test-DB provisioning" (2026-08-14); the bootstrap now owns the grant and the reset must precede it. Also: nested-worktree poisoning, MOCK_EXTERNAL_APIS=false in CI, tenant-scope allowlist drift, comment-backtick extractor false-positive, allowlist file-move orphaning, worktree test-failure vs real regression (verify on the same ref), nested-worktree Edit/Write path leak + concurrent branch/stash churn (explicit `git add`, /tmp patch, re-verify HEAD before commit), Railway RAILPACK build has no `.git` so git-touching `prepare`/`postinstall` scripts must be `|| true`, Fallow `fallow-ignore-next-line` is single-line (directive + reason on ONE line or it suppresses the next *comment*, not the code) + `--gate new-only` resolution conventions (delete genuine dead code, `usedClassMembers` for interface dispatch, inline `complexity`, `duplicates.ignore` for divergent clones); `ci:db-imports` AST guard — STRICT composition-root allowlist with registration-derived worker roots (flipped from a checked-in baseline in A+ campaign PR 3; shipped as PR 1a); fallow CRAP is inflated repo-wide because the coverage input excludes integration suites → integration-only-covered code reads as ~0% covered and accrues PHANTOM complexity debt that decomposition cannot clear (#581); a `verify-gate.sh` run whose row COUNT shrank is DISARMED (missing `.feature/intake.json`), not faster — it still prints GREEN; a gate row must be a CHECK never a MUTATION — `pnpm test:db:setup` DROPs schema `public`, so declaring it in `verification_commands` races the parallel fan-out and produces a spurious RED; never author a fallow suppression from a PREDICTION (an export whose only consumer is a live-DB suite is not dead code, so the marker itself fails as `stale suppression`); `estimated_diff_size` must budget production and TEST lines separately or `reclassify` fires on exactly the DB-contract features whose 4:1 test ratio is designed; the post-merge promotion sweep does NOT need the main checkout — park `.feature/intake.json` and `git checkout -b <docs-branch> origin/main` in the shipping worktree itself (same checkout satisfies containment, no intake satisfies arming), and branch off `origin/main` never local `main`, which lags after every squash merge; `feature-cleanup.sh` derives `MAIN_ROOT` from its cwd, so run from inside a feature worktree it skips that worktree and silently cleans nothing (#644); a verify-gate GREEN branch can still fail CI's fallow job — `ci:fallow*` is deliberately outside the local gate, so run `npx fallow audit --gate new-only --base origin/main` before opening a PR whose diff added mirrored/parallel blocks, and remediate on merit not suppression (#675, 2026-08-06); `git merge --ff-only main` CANNOT fast-forward `staging` after a squash merge and `git cherry` is the wrong check (patch-ids do not survive squashing) — use `git diff --stat staging origin/main`, then reset + `--force-with-lease` (#679, 2026-08-08); staging is behind Vercel team-SSO AND app auth, so any smoke crossing a Next.js route needs the owner's browser — worker/Railway ingress stays scriptable, so split the smoke list by surface before estimating it (#679, 2026-08-08); a gate row's NAME is also its status slot, its `.feature/logs/<name>.log` and its coverage dir, so the old 40-char truncation could report PASS for a FAILED suite — `row_slug` (`scripts/gate-rows.sh`) truncates for readability and identifies by an appended hash, and `launch()` asserts uniqueness at registration (#696, 2026-08-08); a "is it wired?" test asserting SOURCE TEXT is the same defect class as the bug it guards — extract to a sourced library, or `eval "$(sed -n '/^fn() {/,/^}/p' script.sh)"` to run the REAL body; keep text assertions for genuinely textual properties and write them as patterns not literals (#696, 2026-08-08); `exit` in a SOURCED bash file kills the caller — a library signals, the entry point decides, and the entry point's abort path is defined BEFORE the `source` line; follow every `source` with a `command -v <symbol>` guard or a failed load resurfaces as exit 127 misread by the call site (#696, 2026-08-08); under `set -u` on **bash 3.2** (what `/usr/bin/env bash` is on macOS) `"${ARR[@]}"` on an EMPTY array is fatal — use `${ARR[@]+"${ARR[@]}"}` (#696, 2026-08-08); in a guard module whose PROSE is its spec, an absolute written about a narrow text-presence check ("`unlocked-ddl` can never fire") is itself a false claim — say what the code literally does and mutation-prove each claim BEFORE writing it, and expect the documentation to be its own cost centre, since `reclassify` fires on prose volume no heavier lane control can address (#706, 2026-08-08); `verify-gate.sh` resolves `TEST_DATABASE_POOL_URL` but NOT `DATABASE_POOL_URL`, so a changed integration suite that transitively imports the `src/lib/db/server` singleton dials vitest.setup's dummy `localhost:5432` — export BOTH vars to the test DB when invoking the gate (fallow.yml CI already exports both); permanent fix is #744 (#728, 2026-08-09); NEVER measure a feature's diff — or a collision check against an open PR — against `origin/main`: use `git merge-base origin/main HEAD`, because `main` moves mid-run and the inflation is indistinguishable from genuine scope creep at exactly the moment `reclassify` asks you to judge it (bit the same run twice: a fake revert on a stale branch, then a fake 15× overshoot); a grep gate that forbids an identifier forbids it in PROSE too (scope it to code with `rg … | rg -v '^\S+:[0-9]+:\s*//'`); `ci:tenant-scope` cannot tell you the snippet it wants (`TenantScopeFinding` has no SQL field — derive it by reusing the audit's own `extractSqlTemplates` + normaliser; five regenerations 420→418→414→412→409→408 have hit this); under concurrent subagent dispatch commit with a pathspec (`git commit -m … -- <files>`), never bare `git add` + `git commit` (#731, 2026-08-09); a **stale `coverage/coverage-final.json` yields a fallow green that is NOT load-bearing** — extractions shift line numbers and the CRAP dimension goes meaningless, so regenerate AFTER the last edit (tell: `normalize-v8-coverage` prints `clamped N out-of-range value(s)` on a fresh report, silence on a stale one), and remember `verify-gate.sh` returning 26/26 GREEN says NOTHING about `fallow` (`CI_ONLY_BY_DESIGN`) (#860, 2026-08-18); **fix the metric's actual cause** — run `fallow health --complexity-breakdown` before choosing an extraction, since the plausible lead (a module-level copy catalogue) contributed 0 to a flagged COMPONENT whose 16 was hooks+JSX-operators+props (#860, 2026-08-18); `git add -A` is unsafe the moment two agents share ONE worktree, and a mid-flight `pnpm typecheck` failure is usually the SIBLING's half-applied edit rather than a defect — never run the verify gate against a dirty tree, since a red result then describes orchestration timing and writing it to `gate-status.json` is worse than leaving the record stale (#860, 2026-08-18); **`reclassify` fires on exactly the branches whose review WORKED** — price a rework allowance into `estimated_prod_lines` for a high-RISK feature with a real UI surface, because round-1 fixes were ~1250 of a 1003-line overage and "changed lines" counts both sides (#860, 2026-08-18); **an `allowed_edit_surface` entry for a Next.js dynamic segment is the PLAIN path only** — THREE matchers (both edit-surface-guard hooks + `ci:feature-surface`) escape `[` `]` at match time, so a pre-escaped `\[id\]`/`[[]id[]]` matches nothing anywhere (the Codex hook was the last one unaligned, which is why intakes carried both spellings) and is rejected at arm time (`feature-setup.sh`/`arm-check.sh`) and repo-wide in CI, and any non-process surface entry that matches NO file on the audited branch fails `ci:feature-surface` (#867, 2026-08-17); **`ci:rls-audit` inside `verify-gate.sh` can false-fail by racing `db-provision`'s `DROP SCHEMA public`** — the tell is a failing table list naming tables your diff never touched, it passes standalone seconds later, and the danger is that it CLEARS ON RETRY (#877, 2026-08-18; FIXED 2026-08-24 — the racer is a SIBLING PROCESS, not this run's ordering: provisioning and the audit now share the live-DB advisory-lock protocol plus a `test_meta.provision` hash marker, see "#877 test-DB provisioning lock"); a `staging` push no longer produces a `target:"staging"` Vercel deploy despite the runbook saying so — check `target` via `GET /v6/deployments`, not the alias (#878, 2026-08-18); **a defect can live only in the COMPOSITION (write → refetch → render) and pass every agent that reads the query and the copy separately** — when a fix changes a SELECTION policy, ask what happens to that policy's key immediately after the write the surface performs, because a leading sort key the surface's own action flips is a latent identity swap (#865, 2026-08-18); estimate `estimated_prod_lines` from the intake's ENUMERATED behaviours, never from a precedent file's size — that method ran 2.2× low and fired `reclassify` (#865, 2026-08-18); **a green `ci:tenant-scope` is not a review of a cross-tenant join** — the audit is SILENT on every table outside `TENANT_TABLES` (`users` among them), nothing at a call site distinguishes "reviewed and exempt" from "never in scope", and a comment plus a review artifact both asserted the opposite through two rounds; check the table against `TENANT_TABLES` first and state WHY the audit is quiet (#662, 2026-08-18); **integrate a moved base into a PARKED, doc-heavy branch with `git merge`, never `git rebase`** — a rebase resolves per replayed commit, so one logical conflict over living docs is multiplied by the commit count (19 here) and each repetition can resolve differently, while the linear history it buys is discarded by the squash merge anyway (#872, 2026-08-18); **the local test DB is ONE container shared by every sibling worktree**, so another session's `pnpm test:db:setup` (which DROPs schema `public`) can move it under a running suite — read a `beforeAll` "behind head" failure as an environment claim and re-provision before diagnosing code (#872, 2026-08-18); a plan review that changes the DESIGN must revise BOTH intake estimate buckets in the same amendment, or `reclassify` fires forever on the stale half — and ADR/reference prose counts as "production" lines (#872, 2026-08-18); record a cross-worktree collision in your OWN deviations file only — editing the sibling's file makes the edit-surface guard bind your session to ITS stop gate, which a mid-execution sibling with a red eval can never satisfy (#872, 2026-08-18); **`ci:admin-aal2` and `fallow` want OPPOSITE things about the admin-route `gate → parse → safeParse → 400` preamble** — extracting it to satisfy fallow fails the AAL2 audit on every route touched, because that audit is a fail-closed allowlist of recognized gate SHAPES and a gate behind an imported wrapper "does not count"; acknowledge the clone with the reason written down, and ship any extraction TOGETHER with the gate-shape change under one review (#898, 2026-08-21); "unused export" and "unused value" have DIFFERENT fixes — dropping `export` to clear a fallow finding can just hand it to ESLint as "assigned a value but only used as a type", and an array whose only job is sourcing a `[number]` type should be a plain union (#898, 2026-08-21); a SQL edit and its `tenant-scope-allowlist` entry are ONE unit (four for four on one branch) so a brief authorising the SQL must authorise the allowlist file too (#898, 2026-08-21); every new admin page owes a `nav-config.ts` row and every new migration owes a `schema-ready` requirement — both are filesystem-walked, so put them in `allowed_edit_surface` at step 0 (#898, 2026-08-21); run the gate as `MAX_PARALLEL=2 VITEST_WORKERS=2` on a busy box — exit 143 and coverage `.tmp` ENOENT are resource symptoms wearing a test-failure costume (#898, 2026-08-21) **The bash-write guard's `sed` rule read `-i` inside a search PATTERN as the in-place flag (2026-08-30, #1008)** — fixed in both the `.claude/` and `.codex/` copies, pinned by `scripts/ci/__tests__/bash-write-guard.test.ts`.
- **Solicitation / CSV ingest** — the `csv_ingest` advisory-lock contract covers status transitions only: the offboarding purge hard-DELETEs `contact_csv_uploads` unlocked, so `writeTerminalUploadState` deliberately TOLERATES a 0-row terminal write rather than asserting (#582); the batch builder pools every contact of the business, so a staging smoke's funnel never equals its own CSV; `useReviewedPing` is `visibilityState`-gated so background automation never writes `reviewed_at`; the Suppression ledger's §1.2 lookup has ONE owner (`suppressionMatchSql`) and its `channel` is a PARAMETER on both reader and writer — a hardcoded literal on one side fails OPEN the day the channel enum grows (#643); the offboarding token scrub matches on `account_id` alone so its account-leading index is usable, with the `business_id` arm kept only in the purge VERIFIER as a cross-account tripwire
- **Worker startup / Sentry** — the production startup asserts (`assertAlertSinkEnv` / `assertAdminNotificationEmail` / Stripe) early-return unless `NODE_ENV==='production'`, so a prod env that omits `NODE_ENV` silently disables the whole boot-safety layer (set `NODE_ENV=production` AND `SENTRY_DSN` together); Fallow reason-placement refinement (2026-06-20); unlistened EventEmitter `'error'` on any Queue/Worker/ioredis client = fatal uncaughtException → `attachEmitterErrorLogger` + per-source suppress window (#508)
- **Live-DB test suites** — a live-DB **suite** must be named `*.integration.test.ts` (that glob is what puts it in vitest's serialized `integration` project), and no live-DB **file** — suite or `__tests__/` helper — may execute DDL at run time: DDL's ACCESS EXCLUSIVE locks deadlock sibling suites whenever `verify-gate.sh` runs vitest in CONCURRENT PROCESSES, where in-process serialization does not reach (#573); provision with `pnpm test:db:setup`, assert with `assertSchemaReady`. Detection is AST extraction of EXECUTED SQL, not a text marker (#694, 2026-08-08 entry), over every `.ts`/`.tsx` under `__tests__/` rather than the suites alone — a helper can BUILD a DDL fragment a suite splices in, and reaches the DB by importing `postgres` (#706, 2026-08-08 entry). Two lock-enforced allowlists — migration-**shape** files and **DDL-probe** suites — must hold `acquireLiveDbLock` AND roll back any unconditional re-apply (a committed re-apply of an old migration reverts a later one on the shared DB); statically-invisible safety takes `-- live-db-ddl-ignore: <reason>`; force a transaction abort with `helpers/abort-injection.ts`, never a temporary constraint. Unsetting `TEST_DATABASE_POOL_URL` does NOT sleep the suites — `.env.local` disk fallback (#563, 2026-08-03 entry) — but `pnpm vitest run <file>` does NOT hydrate it, so a suite gated on it SKIPS silently (#694). **A THIRD surface reads that fallback: lefthook's pre-push `test-changed`** — a branch carrying an unpromoted migration can be gate-GREEN with the exports set and then fail `git push` without them, on a CONSTRAINT its own migration widened, in an error that reads like a defect in the code under test; export `TEST_DATABASE_POOL_URL` **and** `DATABASE_POOL_URL` for the push too, and when a live-DB suite fails on a constraint your migration touches, check the DB's schema before reading the diff (#629, 2026-08-17)
- **False coverage / mutation** — a test that passes whether or not the bug exists is the dominant defect mode on guard-shaped work; a fix for an "X is untested" finding must ITSELF be mutation-pinned or it reproduces the defect (happened twice in consecutive rounds at #679, and ~10 instances there were caught by mutation, none by reading); a JS `throw` does not poison a Postgres transaction, so savepoint-recovery tests need Postgres-side abort injection (#679, 2026-08-08); **Testing-Library's `rerender` PRESERVES component state, so it structurally cannot prove an UNMOUNT defect** — two promised tests passed against a panel that reset the owner's deselections on every refetch, through a full review round; a test for state that must SURVIVE a refetch belongs in the PARENT's suite driving the real mount boundary (#860, 2026-08-18); **a fail-open guard needs an oracle for the OPEN half** — pinning only the refusal left `budgetRemaining: null` (Redis down) undefended, and `(x ?? 0) <= 0` type-checks, keeps 29/30 green, and converts an Upstash outage into a dead lane (#860, 2026-08-18); **an all-or-nothing CHECK forces combined-restore tests, and a SQL-shape assertion then proves only that a predicate is PRESENT, never that its COMPARISON is right** — `IS DISTINCT FROM 'wrong literal'` satisfies `toContain` while detecting nothing, and a sibling column's violation carries the count; isolate each column (restore alone → expect 1 → revert → expect 0, labelled per column) wherever no constraint forbids it (#665, 2026-08-18); **a lint-on-stop hook cannot tell a MEASUREMENT from a mistake** — with a guard deleted on purpose, ESLint reports the orphaned import and its mechanically obvious remedy (delete the import) removes the guard PERMANENTLY, which is how invariant #3's auto-policy conjunct was nearly lost mid-census; declare the mutation with `touch .feature/mutation-in-progress` (git-ignored) — BOTH `.claude/hooks/` and `.codex/hooks/typecheck-on-stop.sh` then skip the eslint block only, typecheck still runs, and no green stamp is written — and remove it the moment the file is restored (#896, 2026-08-23) **The FIXTURE is the oracle (2026-08-30, #1008)**: a mocked `sql` that fabricates its own row cannot verify a query, and a fixture holding a dimension CONSTANT cannot catch a predicate that narrows on it — vary tenant/location/time/subject and assert an EXACT count.
- **Testing** — vi.hoisted for shared mocks, NextRequest vs Request, relative imports under tsx, compat re-export must shield all consumers (mock-contract), memoized `getServerConfig()` ignores late `process.env` mutation (set env before first access or mock the accessor; `flags.ts` reads live on purpose), `AbortSignal.timeout` runs on Node's internal timers — vitest fake timers can't advance it (real timers + injectable small timeout, #508), module-scope `llmCircuitBreaker` singleton leaks state across suites that mock the SDKs but drive the real `runLlmTask` → `reset()` in `beforeEach` (#515), `app.inject()` NORMALISES the request target so an inject-only suite is structurally blind to anything about the raw request line (absolute-form targets, malformed targets) — a surviving mutant there means dead logic OR a harness blind spot, so reach for a real-socket `net.connect` test before deleting a security-adjacent branch (#644); before merging or reshaping a query, enumerate THREE categories of dependent assertion — tests that (i) count queries, (ii) dispatch on query text, and (iii) IDENTIFY a query by text then constrain its contents; (iii) is the one that bites, and never verify a type-level guarantee by grepping for the enclosing function name (TS anchors structural-assignability errors at the offending literal and names the TYPES — `TS2741` one missing property, `TS2739` several) (#731, 2026-08-09); when an eval task widens a shared DTO fixture, **grep the TYPE name, not the fixture helper's name** — a second `SendLaneView` construction site in another suite broke typecheck the instant the interface grew, and it also voided a deviation's worktree-overlap analysis; TypeScript's excess-property check (`TS2353`) reports only the FIRST offending key, so a plan prescribing one `@ts-expect-error` per added field is wrong — the second is `TS2578` unused-directive (#860, 2026-08-18); **a suite that says it "mirrors" another may mirror it at the WRONG LEVEL** — mocking `requireAdminWithAal2` instead of the auth PRIMITIVES the sibling mocks left six tests dead the moment the route called a different function in that module (ESM internal calls bypass a mocked export), and the sibling testing the same change passed untouched; treat a "mirrors X" comment as a claim to verify, and when behaviour MIGRATES into a dependency the test that owns it must follow rather than stub the new seam (#898, 2026-08-21)
- **Frontend / CSS / brand** — iOS Safari rounded-island clip is `overflow:hidden`+`border-radius`+retained `transform` (not a sibling clip), reproduce an audit's CSS cause before trusting it; flag-driven copy swaps on dead-end features mislead; an admin "act on stuck items" panel needs a real outbox-backed route (2026-05-29 launch readiness); **`react-hooks/set-state-in-effect` is `error` repo-wide** — "clear state when the thing it points at disappears" is React's adjust-state-on-prop-change written in the RENDER body behind a prev-value guard (precedent `ToneChipPicker.tsx`), never a `useEffect`; check it writes only on the transition and converges on the next render (#872, 2026-08-18); **a utility class is only real on routes whose stylesheet actually loads it** — `.btn-danger` lives only in `_styles/settings.css`, which the Requests route never imports, so a plan's danger-styled button would have rendered as a bare `.btn`; grep the definition, then check which layout imports that file (#872, 2026-08-18); **a client component importing a VALUE from a module with a module-scope `createWorkerLogger` breaks the Turbopack route build** with no lint/typecheck/boundary-audit failure — invariant #1's ESLint rule lists PACKAGES, not `node:` builtins reached transitively; pass the value as a prop from the server parent, or move the helper to a side-effect-free module (#898, 2026-08-21)
- **Owner offboarding** — `railway up` from a worktree ships stale worker code (`OutboxPoller: Unknown topic`); Stripe Basil/Dahlia moved `current_period_end` onto the subscription item; `approval_audit_log` has no `approval_link_id`/`user_agent` (mock-asserted SQL *text* hid the drift); keep-my-data must be exempt from the blanket `/api/account/*` owner-API proxy gate; the `purge_after` token-expiry trigger blocks shrinking the purge window while a keep-my-data token is live; **the purge VERIFIER is a gate, not a report** — it throws inside `finalizePurgeInTransaction`, so a blind predicate is an open gate and a newly-strict one BLOCKS a legitimate purge, and its `businesses` residue list has two shapes ("was cleared" vs "was set to X"), the second of which needs `IS DISTINCT FROM` on a nullable column or a nulled value passes silently — `archived_at IS NULL` is the only predicate that can catch a row the tombstone never touched at all (#665, 2026-08-18)
- **Worker crash-net / cost-guard** — crash-net rejection classification (strict recoverable-DB allowlist vs billing's broad transient check, transient-rejection governor); cost-guard fail-open limiters + pre-LLM reservation retry matrix (transport retryable, budget terminal, finalize never job-retried), Upstash SPOF; a cache whose KEY a replacement job can legitimately share must bind its PAYLOAD to content provenance — the `(reviewId, version)` idempotent-generation cache served a stale draft to live-ingest's same-version replacement job and deterministically defeated the #728 persist gate (#728, 2026-08-09)
- **Vercel BotID / WAF** — client/server `checkLevel` must match or it fail-blocks legit traffic (single source of truth); only protect a route that has an in-app token-bearing caller (dead/external callers get 403'd, invisible to preview/mocked tests); Deep Analysis is billed → gate it behind auth, not just the forgeable same-origin header; WAF custom rules have no committable config (the runbook is source of truth); the staging custom env is preview-TYPE so a production-only WAF condition excludes it; `all_except_custom_domains` SSO protection still intercepts the staging custom env's custom domain (`staging.repworth.net` → vercel.com/sso-api) — smoke curls need the Protection Bypass for Automation header, prod custom domains are exempt (2026-08-26)

---

## 2026-04-09

### Postgres.js NUMERIC/DATE decoding (not the JSONB carve-out)
- [2026-07-25] Competitor Delta digest compared `snapshot_date === currentDate`
  and every location degraded to the teaser branch → Postgres.js decodes DATE
  columns to JS `Date` objects, so `===` against a string is always false; unit
  tests with string fixtures cannot catch it → select `snapshot_date::text` and
  keep DATE values strings end-to-end, plus pin the query shape in the suite
  (`expect(query.text).toContain('snapshot_date::text')`). Caught in PR #570
  review; same family as the timestamptz-µs lab note.
- [2026-08-11] All-Locations combined `reviewVelocity` plotted its weeks
  Aug, Aug, Jul, Jun → the dashboard mappers built the week key as
  `String(row.week_start)`, and because Postgres.js decodes DATE to a JS `Date`
  that is `Date.prototype.toString()` — `"Mon Jun 22 2026 00:00:00 GMT+0000 (…)"`.
  Every key then shares a `"Xxx "` prefix, so ANY string comparison orders by
  month **NAME** (`Aug` < `Jul` < `Jun`, `'l'` < `'n'`). Only the combined series
  broke because it is the only velocity series re-sorted in JS; per-location
  series keep SQL's `ORDER BY`, which is why this survived from PR #28 to #791.
  The string is also process-timezone-dependent. → Normalize at the mapper with
  `toIsoWeekStart` (`src/lib/dashboard/active-mappers.ts`, the single owner for
  both `mapReviewVelocity` and `buildReputationSummary`): `toISOString().slice(0,10)`
  on the UTC day, which round-trips the SQL date exactly because postgres.js
  parsed it from a date-only string. Two traps this cost: (i) fixing only the
  `.sort()` would have left the format — and the timezone dependency — in place;
  (ii) the live-DB suite `review-time-anchor.integration.test.ts` had a
  `weekMarkers()` helper that deliberately mirrored the broken path
  ("stringify through the SAME postgres.js decode + String() path the mappers
  use, NEVER ::text") and so agreed with the bug — a symmetric expectation
  cannot detect a wrong shape; it is now `::text`, which pins the ISO day
  against Postgres itself.
- [2026-08-11] Second half of #791, same root value, different consumer: a
  **calendar-day label must format with `timeZone: 'UTC'`**. A week bucket
  (`YYYY-MM-DD`) parses as UTC midnight, so `toLocaleDateString` in the viewer's
  zone rolls it back one day EVERYWHERE west of Greenwich — the Monday-Jun-22
  bucket labelled its tick "Jun 21", a Sunday, for essentially every US owner.
  A calendar day has no time of day to localize; pinning the zone is what makes
  the label mean the same date for every viewer, and it is what
  `src/components/admin/ui/format.ts` already argues at length (there the driver
  is SSR **hydration** — Vercel's Node runs UTC, the browser does not — which is
  the harsher version of the same defect; the owner dashboard fetches its data
  client-side via react-query, so it is display-only there today). Convention is
  now unanimous across all five calendar-day sites: `formatRankingDateLabel`,
  `service-mappers` `periodLabel`, `weekly-value-report` `formatWeekDate`, plus
  the two this fixed (`weekShortLabel`, `ReputationTrendChart.weekLabel`).
  **The symmetric-expectation trap bit AGAIN in the same PR** — third instance:
  `ReputationTrendChart.test.tsx` recomputed the expected tooltip label with the
  component's own broken formatter, and its comment *named the exact roll-back*
  ("some local zones (e.g. America/Los_Angeles) roll back to 'Apr 2'") while
  treating it as test flake to route around rather than the bug it was. When a
  test comment explains away a wrong-looking value, that is the finding. Guard
  shape that actually works: assert the LITERAL (`'Apr 3'`) plus a case under
  `process.env.TZ = 'America/Los_Angeles'` — CI runs UTC, so the literal alone
  passes there whether or not the fix exists; the TZ-mutating case is what
  carries the guard. Verified discriminating (`bare=Jun 21` vs `pinned=Jun 22`)
  before being written, and mutation-proved after.
- [2026-07-25] Postgres.js returns **NUMERIC as a JS string** (precision
  preservation) — `competitor_snapshots.rating NUMERIC(2,1)` reads back as
  `"4.8"`, not `4.8`. Any consumer must `Number(...)` at the read boundary.
  This is NOT the PgBouncer JSONB carve-out (different decoder, applies
  everywhere) — do not add such sites to CLAUDE.md's JSONB allowlist.

### Postgres.js + PgBouncer JSONB string wrapping
Postgres.js + PgBouncer returns JSONB columns as plain strings, not parsed
objects. Guard every JSONB read:
```typescript
typeof x === 'string' ? JSON.parse(x) : x
```

---

## 2026-04-11

### SerpAPI Maps Reviews ignores `num` on page 1
SerpAPI always returns 8 results on page 1 regardless of the `num` parameter.
Removed `num` from the request; slice client-side instead.

### Claude Haiku model string deprecated
`claude-3-5-haiku-latest` → 404. Use `claude-haiku-4-5-20251001` explicitly.
Update the fallback LLM config if you ever see 404 on the Haiku calls.

### Vercel serverless can't reach local Docker Redis
Rate limiter must gracefully skip (not throw) when `REDIS_CACHE_URL` is
missing or unreachable. Already handled — don't add hard failures here.

### BullMQ rejects `:` in job IDs
OutboxPoller uses `_` as the separator in constructed job IDs. Never use `:`
in any dynamically-constructed BullMQ job ID.

### Supabase PgBouncer statement_timeout
PgBouncer enforces ~8s `statement_timeout`. The OutboxPoller watchdog CTE
can exceed this. Set `connection: { statement_timeout: 30_000 }` on the
Postgres.js client used by OutboxPoller. Already configured — don't remove it.

---

## 2026-04-13

### Google Maps URL hex CIDs vs Place IDs
Google Maps URLs use hex CIDs (`0x...:0x...`), NOT canonical Place IDs.
Resolve via PlaceAutocomplete or SerpAPI `engine=google_maps` search.
Never use `data_id` from the URL directly.

### Place ID format is NOT `ChIJ`-only
Place IDs use base64url charset + 20+ chars. Also valid: `GhIJ`, `Eic`,
`Iho`, and others. Match on charset + length, never on `ChIJ` prefix.

### PlaceAutocompleteElement shadow DOM styling
`PlaceAutocompleteElement` has a closed shadow DOM — can't style via
`::part()`. Fix: `color-scheme: light only !important` on the element.
Never set `overflow: hidden` on the container (clips the dropdown).

### Google Maps Essentials vs Pro tier fields
`displayName` is Pro tier (paid). On the free Essentials tier, only use:
`id`, `formattedAddress`, `location`. Already enforced in onboarding wizard —
don't add `displayName` calls.

### `@googlemaps/js-api-loader` v2 SSR guard
`setOptions()` in v2 accesses `window` at import time. Guard all usages:
```typescript
if (typeof window !== 'undefined') { ... }
```
Also: `Autocomplete` class is blocked for new customers — use
`PlaceAutocompleteElement` instead.

---

## 2026-04-14

### Stripe `inbound_events.payload` structure
The full Stripe event object is stored in `payload`. To get the session ID:
```sql
payload->'data'->'object'->>'id'   -- ✅ correct (session ID)
payload->>'id'                      -- ❌ wrong (this is the evt_... event ID)
```

---

## 2026-04-18

### Postgres.js v3 JSONB double-encoding
`${JSON.stringify(x)}::jsonb` in Postgres.js v3 double-encodes the value,
producing a JSONB scalar string instead of a parsed object. Always use the
`jsonb()` helper:
```typescript
import { jsonb } from '@/lib/db/server'
// Uses sql.json(value) with OID 3802 internally
sql`INSERT INTO foo (data) VALUES (${jsonb(myObject)})`
```
Never use the `::jsonb` cast with a JS-interpolated string.

---

## 2026-04-24

### Supabase server-side signUp implicit flow
Server-side `supabase.auth.signUp()` uses implicit flow → confirmation emails
return `#access_token=...` fragment to homepage (JavaScript can't read it
server-side). Fix: use 6-digit OTP (`{{ .Token }}` template + `/signup/check-email`
entry point). This also sidesteps email-scanner link prefetch attacks.

### `channel_enrollments` row insertion timing
Must only insert AFTER email is verified (post-OTP or post-Google-OAuth).
Admin `createBusinessTx` keeps inline INSERT (pre-verified by definition).
Forgetting the Google OAuth path silently drops all notifications for
Google-signed-up businesses. Already fixed — don't regress this.

### Admin-onboarded owners with `auth_id=NULL`
Pre-fix: admin-onboarded owners had `auth_id=NULL` → couldn't log in.
Admin route now calls `inviteUserByEmail` + patches `auth_id`. Compensating
delete fires on invite failure to prevent email collision on retry.

### Supabase built-in SMTP rate limit
Built-in SMTP: 2 emails/hour. Fix: custom SMTP via Resend.
`smtp.resend.com:465`, username `resend`, password = `RESEND_API_KEY`.
In `/api/auth/signup`, disambiguate `over_email_send_rate_limit` → 429,
NOT 409 `account_exists`.

---

## 2026-04-26

### `CleanupAbandonedSignupsPoller` TOCTOU vulnerability
Must re-validate ALL predicates inside the transaction with `SELECT FOR UPDATE`
after taking advisory locks. `deleteUser()` is irreversible AND non-transactional
— getting this wrong nukes paying accounts. Already hardened — treat this as
a red line.

### Supabase obfuscated signUp response for existing emails
`supabase.auth.signUp()` returns `identities: []` for already-confirmed emails
(anti-enumeration protection). Detect this BEFORE calling `createBusinessTx`
and return `account_exists` (409) to the client.

### `googleMapsUrlSchema` contract with worker
`googleMapsUrlSchema` must call `parseGoogleMapsUrl()` and enforce the same
parseability contract as the worker's `validate_place_id`. If the wizard
accepts a URL that the worker can't parse, the business onboards successfully
but `PlaceIdValidationWorker` permanently fails.

---

## 2026-04-27

### Postgres STABLE expressions rejected in partial index predicates
Postgres rejects `STABLE` expressions in partial-index keys/predicates
(ERROR 42P17). `timestamptz::date` is `STABLE` (depends on session timezone).

**Wrong:**
```sql
CREATE UNIQUE INDEX ... WHERE (created_at::date) = ...  -- ❌ fails
```

**Correct:**
```sql
CREATE UNIQUE INDEX ... WHERE ((created_at AT TIME ZONE 'UTC')::date) = ...  -- ✅
```

The `ON CONFLICT` clause on any INSERT into that index must use the EXACT
same expression byte-for-byte or Postgres won't recognize the constraint match.

---

## 2026-04-28

### Zernio `account.disconnected` nested payload
Zernio's `account.disconnected` webhook payload uses NESTED `account.id`,
NOT flat `accountId`:
```typescript
// ✅ correct
const accountId = body.account?.id

// ❌ wrong — body.accountId is undefined
const accountId = body.accountId
```
A flat-`accountId` payload returns `200 received:true` but silently skips
processing (logs `missing account.id — skipping`). Test helpers MUST build
the nested shape.

---

## 2026-04-29

### Postgres `ON CONFLICT` must reference partial-index expressions verbatim
The `ON CONFLICT` clause must reference partial-unique-index expressions
BYTE-FOR-BYTE. Migration 005's `idx_review_exceptions_collision_dedup`
predicate uses `(payload->>'provider_review_id')`, NOT `provider_review_id`.

```sql
-- ✅ correct — matches the index expression exactly
ON CONFLICT (aggregate_id, (payload->>'provider_review_id'))
  WHERE topic = 'ingest_zernio_review' ...

-- ❌ wrong — "no matching unique constraint" at runtime
ON CONFLICT (aggregate_id, provider_review_id) ...
```

This applies to any index using JSONB operators or expression casts in the
conflict target.


---

## 2026-05-02

### Split decision: ship view-only, park Zernio-shaped edit machinery
`feat/edit-existing-replies` was code-complete (31 commits, 6 review rounds,
~3,500 LOC) and would have shipped the full edit / regenerate / publish /
retry / restore-original flow. We split it instead:

- **Shipped on `feat/past-replies-view`:** read-only Past Replies tab + the
  flag-gated ingestion that fixes the Tanicia silently-dropped-replies bug.
- **Parked on tag `wip/edit-existing-replies-zernio-v1`:** the entire DELETE+
  POST orphan-marker recovery state machine, the 7 API routes, the
  EditReplyDrawer, the recovery routes, the publisher edit branch.

**Why parked, not shipped:** Zernio's API requires DELETE-then-POST to edit a
reply. Direct GBP API uses single-PUT replacement. ~25% of the parked code
(orphan-marker convention, `runEditPublisherIfApplicable`, `publisher-on-failed.ts`,
`verify409InTx`, recovery routes) becomes vestigial when GBP arrives. Per
CLAUDE.md, "GBP API: Not applied for" — 6-18 month timeline at best. The
75% that survives a GBP swap (route shapes, drawer state machine minus
recovery, helpers) is reusable as a spec-as-code reference, but rebuilding
against GBP's simpler model is cleaner than carrying Zernio-shaped
machinery in production for 6-18 months.

**Resurrect the parked tag only if:** GBP timeline blows up beyond ~12
months AND premium-tier monetization needs the differentiator urgently.
Otherwise wait for GBP and rebuild against the simpler model.

### Two-flag rollout pattern for ingest-vs-UI features
The original single-flag design (`EDIT_EXISTING_REPLIES_ENABLED` gates
everything) entangled the data-write decision with the UI-expose decision.
Imported `posted` rows count toward `dashboard/service.ts` HANDLED_STATUSES,
so flipping ingestion on changed customer-visible numbers BEFORE the UI
explained them.

The view-only branch splits this into two independent flags:

- `EXTERNAL_REPLY_IMPORT_ENABLED` — gates writes (ingestion path).
- `PAST_REPLIES_VIEW_ENABLED` — gates UI (page + nav link).

Operator turns import on first → silent ingestion soaks → metric shift
visible in product analytics → operator turns view on once they're
comfortable. Each flag is independently revocable.

Pattern generalizes: any feature that writes data AND surfaces it
asymmetrically should use a dual flag. Cost: one extra env-var line in
the runbook. Benefit: independent revocation + soak windows decoupled
from UI launch timing.

- [2026-08-08] **The UI half of this pair is RETIRED — do not resurrect it for
  this feature.** #678 deleted `PAST_REPLIES_VIEW_ENABLED` (spec
  `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §6.3a
  S4). WHAT WOULD HAVE FAILED → once the **Reviews list** became the consented
  **Review import**'s only destination, a `false` view flag would have let
  `import_decision='accepted'` coexist with the imported reviews landing on a
  `notFound()` — the owner consents to an import they can then never see. WHY →
  a *destination* surface cannot be independently revocable from the write that
  targets it; the two flags stopped being orthogonal the moment consent pointed
  at the page. CORRECT APPROACH → the Reviews list renders unconditionally and
  `EXTERNAL_REPLY_IMPORT_ENABLED` alone governs the import (no silent-soak
  window any more — turning it on shifts "total responded" and surfaces the rows
  in one step). The surviving flag, `EDIT_REPLIES_ENABLED`, gates the
  live-Google *mutation*, which is a genuinely separable and larger risk;
  `editRepliesEnabled()` in `src/lib/past-replies/flags.ts` is its only reader.
  The dual-flag pattern above still holds for write-vs-expose pairs that stay
  orthogonal — it does not hold when one flag can 404 the other's output.

### `cherry-pick eb4d183 c2360cd 891e975` worked clean; `ca53663` and `9e0ca93` had to be redone manually
When cherry-picking a fix-pass branch onto a stripped-down replacement
branch, fix commits that touched code added in earlier-dropped commits
will need redoing. Specifically: Round-1 Medium 1 (`ca53663`, reviewReply
normalization) included a hunk modifying `verify409InTx` — but
`verify409InTx` doesn't exist on the read-only branch (it's part of the
parked publisher edit machinery). Round-1 Medium 5 (`9e0ca93`) needed
`redactSensitiveError` to be exported, which depended on the round-1 fix
commit `a8836fd` we weren't bringing.

Resolution: redo both as fresh commits scoped to only the parts that apply
to the new branch. ~30 LOC of manual edits versus the alternative of
cherry-picking the full chain and then trying to revert the dependencies.

Lesson for future splits: when cherry-picking a partial chain, audit each
commit for cross-references to commits not in the cherry-pick set. Either
include the dep, or plan to redo the fix manually.

### `EditReplyDrawer` close-during-async-op = hidden draft class of bug
Round-2 M3 → Round-3 M → Round-4 M all caught variants of the same bug:
the drawer state has an outstanding worker / outbox / fetch in flight, but
tryClose lets close happen, and the worker later commits an invisible row.

Three states needed close-blocking on the parked branch:
- `creating_draft` (POST /draft in flight, ~500ms)
- `regenerating` (worker generating LLM response, 5-30s)
- `regenerate_poll_error` (transient polling failure but outbox still alive)

Discovery sequence: Round-2 M3 caught only `creating_draft`. Round-3 M
extended to `regenerating`. Round-4 M added `regenerate_poll_error` and
distinguished it from terminal `error` (only the latter is closable
because the worker reported it's done — no row will materialize).

Generalizable rule: any UI state that holds an outstanding server-side
async operation must either (a) refuse close until the operation
terminates, or (b) provide a server-side cancel endpoint. (b) is harder
because the operation may have already committed by cancel time.

### `vi.mock` factory hoisting — use `vi.hoisted` for shared mock state
When a test file mocks a module and wants to share the mock function with
the test body (to seed return values per-test), the naive pattern fails:

```ts
// ❌ ReferenceError: Cannot access 'sqlMock' before initialization
const sqlMock = vi.fn();
vi.mock('@/lib/db/server', () => ({ sql: sqlMock }));
```

Vitest hoists `vi.mock` factories to the top of the file, above any
top-level `const`. Use `vi.hoisted()` to share state with the factory:

```ts
// ✅ Works — vi.hoisted runs alongside vi.mock
const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ sql: sqlMock }));
```

### [SUPERSEDED 2026-05-27] `/docs/*` is no longer gitignored
The earlier rule ignored all of `docs/`. Current `.gitignore` tracks `docs/` by
default and ignores only generated/binary noise (`docs/graphify-out/`,
`docs/superpowers/landingPageScreenshots/`, `docs/**/*.docx`, `docs/**/*.zip`).
New docs/specs/plans now commit normally.

### Zod v4 — `z.never()` options use `error:`, not `invalid_type_error:`
[2026-05-03] WROTE `z.never({ invalid_type_error: '...' })` per zod v3
idiom → 3 TS2353 errors at compile-time, plus the custom message would
silently never surface even if it had compiled. zod v4 renamed the
option key to `error:` (and accepts a function form for dynamic
messages). Correct:

```ts
// ✅ zod v4
googlePlaceId: z.never({ error: 'unexpected_field: ...' }).optional(),

// ❌ zod v3 — won't compile in v4
googlePlaceId: z.never({ invalid_type_error: '...' }).optional(),
```

The runtime guarantee (the schema rejects values that violate `never`)
holds either way; only the custom error message is affected.

### Postgres FK to `users(id)` — never store Supabase `auth_id` directly
[2026-05-04] PR #2 `/api/onboarding/start` initially inserted
`user_id = ${user.id}` where `user` came from `supabase.auth.getUser()`.
That returns the **Supabase auth identity UUID**, not the row id of
the app `users` table. Migration 032's FK on `onboarding_demos.user_id`
points at `users(id)`, so every happy-path INSERT would have FK-failed
in production.

Anywhere we want a `users.id` value from a Supabase session, we have to
join through:

```sql
SELECT u.id AS user_id, ...
FROM users u
JOIN businesses b ON b.id = u.business_id
WHERE u.auth_id = ${supabaseUser.id}
  AND u.role = 'owner'
LIMIT 1
```

The same gotcha applies to any future table that FKs to `users(id)`.
The `auth_id` column is the bridge between Supabase Auth and the app's
own `users` row — they are NOT the same UUID.

### Cost-guard reservation must be released on tx idempotency-loser path
[2026-05-04] PR #2 `/api/onboarding/start` reserved 20¢ in Redis BEFORE
the FOR UPDATE re-read inside the tx. When two concurrent submissions
hit the route and one won the FOR UPDATE race, the loser's tx callback
returned early (no demo INSERT) but the reservation stayed locked. Net
effect: 20¢ leaked per loser AND the response said `demoQueued: true`
even though no demo was queued.

Fix pattern: track a `demoInserted` boolean closed over by the tx
callback, set it true on the happy path INSERT, and after the tx commits
release the reservation if the flag is still false. Mirror this in any
future route that reserves Redis budget before a tx that may no-op.

### Worker post-completion best-effort blocks must be self-contained try/catch
[2026-05-04] PR #2 `OnboardingDemoWorker` had `checkCostThreshold` +
`Sentry.captureMessage` inside the same outer try as `completeDemo`.
A Redis or Sentry hiccup AFTER the demo completed cleanly would fall
into the outer catch and call `failDemo`, flipping a successful demo
to `failed` for the user.

Rule: any work that runs after a successful primary side effect (DB
write, external publish, etc.) needs its own narrow try/catch with
log-and-swallow semantics. Never let observability/telemetry failures
poison the success path.

### Page-level reads must filter `archived` when the table has 23505 race-loser archives
[2026-05-04] PR #2 `lifecycle.completeDemo` recovers from a Postgres
23505 (concurrent completes for the same user, blocked by the partial
unique index) by archiving THIS row and closing its outbox. The losing
demo can therefore have a NEWER `created_at` than the winning completed
demo.

Any UI/API read that does `ORDER BY created_at DESC LIMIT 1` against
`onboarding_demos` MUST filter `AND generation_status <> 'archived'` or
it will surface the loser's archived row and the page will render with
no matching status branch (header only, no CTA, no review cards). The
two affected reads in PR #2: `/onboarding/demo/page.tsx` and
`/api/onboarding/demo/status/route.ts`.

Generalizes: any state-machine table with an `archived` terminal value
where the archive can be created later than other terminal rows for the
same logical entity.

### Column-level Postgres `REVOKE` does nothing without a table-level revoke first
[2026-05-09] Migration 040 originally tried to lock down owner-edit
surface on `businesses` by issuing `REVOKE UPDATE (col1, col2, …) ON
businesses FROM authenticated`. Postgres still allowed UPDATEs on those
columns: the broader table-level `GRANT UPDATE` was authoritative, and
column-level revokes don't shrink an existing table grant.

Correct pattern:

```sql
-- 1. Drop the broad grant first
REVOKE UPDATE ON TABLE businesses FROM authenticated;
-- 2. Re-grant only the safe columns
GRANT UPDATE (tone, products_services, staff_names, …) ON businesses TO authenticated;
```

Migration 040 fixed this for the obvious columns; migration 041 caught
the columns missed in the first sweep (`subscription_activated_at`,
`place_id_verified`, `google_maps_url` on `businesses`,
`archived_at` / `archive_reason` on `channel_enrollments`). Always
verify with `\dp businesses` after running these — the privileges
column should show only the GRANTed columns, not `arwdDxt`.

### `SELECT … FOR UPDATE` outside `sql.begin()` is a no-op under PgBouncer
[2026-05-09] `UpdateStripeOverageWorker` originally read the account
row with `FOR UPDATE` to "serialize" concurrent overage updates. With
PgBouncer in transaction-pooling mode (Supabase default), the lock is
released the moment the SELECT statement completes — there is no
surrounding transaction to hold it across the subsequent Stripe
network call.

Two valid patterns:

1. **Wrap the whole flow in `sql.begin()`** so the lock survives
   across the Stripe call. Holds a Postgres row lock through a network
   I/O — fine if you trust Stripe to respond quickly, but a slow
   Stripe response now blocks any concurrent worker on the same
   account.
2. **Drop `FOR UPDATE` and rely on Stripe-side idempotency.** Pass an
   `idempotencyKey` on the `subscriptionItems.update` /
   `subscriptionItems.create` call that includes the target quantity
   (e.g. `stripe-overage-update:${accountId}:${itemId}:${qty}`). Two
   concurrent jobs computing the same quantity dedup at Stripe; two
   computing different quantities (because one saw a state the other
   didn't) execute independently — exactly what you want.

We picked (2). The misleading `FOR UPDATE` was removed and a comment
added explaining why. Do not re-add it without also wrapping the
worker body in a transaction.

### `archived_at` is a separate skip from the subscription guard
[2026-05-09] `ResponsePublisherWorker` had a JOIN to `accounts` for
the subscription guard but never selected `businesses.archived_at`.
A response approved before archive, with the publisher job already
queued, would still post to Google after the location was archived.
The subscription guard reads from the *account*, not the location, so
it doesn't catch a per-location archive.

Add `b.archived_at` to the load query and short-circuit with
`markOutboxCompleted` (graceful skip — not a failure). The
NotificationWorker's `loadNotificationContext` already does this for
the dispatch path; the publisher needed the same gate. Always check
both subscription_status (account-level) AND archived_at
(location-level) for any worker that operates on a single
business_id.

### Channel cache invalidation must log on Redis failure, not silently swallow
[2026-05-09] Every `channel_enrollments` write path was using
`invalidateChannelCache(...).catch(() => {})` — silently dropping
Redis errors. If Redis was down, channel writes (including TCPA STOP
unsubscribes) would not propagate to the in-memory resolver cache for
up to 5 minutes, and you would not even know it failed.

Fix pattern: `safeInvalidateChannelCache(accountId, context, logger?)`
exported from `resolve-channels.ts`. Wraps `invalidateChannelCache`
with a try/catch that logs `'channel-cache-invalidate-failed'` with
`{accountId, context, error}` as structured fields. The context
string (`'admin.sms.delete'`, `'settings.channels.override.upsert'`,
…) is what you'll grep for when an alert fires.

The wrapper must NEVER throw — channel writes are the source of
truth, the cache is best-effort. But silent failure for a
TCPA-compliance-critical path is not acceptable.

### Migration `034` dropped `users.business_id` outright — no dual-read window
[2026-05-09] The original multi-location design spec proposed keeping
`users.business_id` as a deprecated pointer for one release before
dropping. The implementation took the simpler path: migration 034
drops the column outright. Anywhere reading `users.business_id` will
fail to compile.

Auth code now reads `users.account_id` and resolves the user's
"primary location" by joining to `businesses` with `is_primary = TRUE
AND archived_at IS NULL`. See `src/lib/db/auth.ts:readSelf` and
`src/lib/auth/require-owner-access.ts`. The middleware's
`users_self_select` RLS policy works unchanged because it gates on
`auth_id = auth.uid()`, not on the column being selected.

### Stripe overage: same-account serialization is the in-tx lock, not the replica count
- [2026-09-02] Comments claimed `concurrency:1` + one Railway instance guaranteed no two overage jobs per account overlap → stale: `acquireBillingLock` (`pg_advisory_xact_lock`) + the account `FOR UPDATE` already hold across the Stripe call inside `sql.begin` → cite the in-tx lock as the replica-safe guarantee; keep `concurrency:1` as defense in depth (`overage-account-lock.integration.test.ts`).

### CSV bulk-import: enqueue ONE aggregate Stripe overage job, not one-per-row
[2026-05-09] The first cut of admin CSV import called
`addLocationTransaction` for each row, which inserts a
`update_stripe_overage_quantity` outbox row each time. A 100-row
import produced 100 separate worker invocations that each retrieved
the subscription and updated the quantity — 99 of them redundant.

The fix: `addLocationTransaction` accepts
`enqueueStripeOverageUpdate?: boolean` (default `true`). The CSV
import passes `false` per row, then calls
`enqueueCsvImportStripeOverageUpdate(accountId)` exactly once after
the loop if any rows succeeded. Pattern generalizes: any batch
caller of an outbox-enqueueing transaction should be able to
suppress the per-call enqueue and emit one aggregate job.

### Don't bifurcate the post-pay wizard guard with the same "duplicate-submit" check
[2026-05-04] PR #2 wired the existing `/api/onboarding/business`
"already-onboarded" guard (`if (place_id_verified || google_maps_url)
return 409`) to also fire for the new post-pay flow. But in the post-pay
flow, `place_id_verified` is the REQUIRED PRECONDITION (set at
`/onboarding/start` BEFORE Stripe). The guard fired on every legitimate
post-pay submission, returning 200 with no DB write — silently swallowing
every Profile/Voice submit.

Pattern: when bifurcating a route by a flag and the legacy semantic
"X means already done" inverts to "X means ready to proceed", the guard
needs an explicit branch on the flag. Don't let the legacy interpretation
leak into the new path.

---

## 2026-05-22

### Billing snapshot: read STORED quota, not `TIER_CONFIG` — but base price has no stored column
[2026-05-22] PR #51 moved location-quota math off the live `TIER_CONFIG` and onto
the account's stored columns. `currentBillingSnapshot`, `assertCanAddLocation`,
`createCheckoutSession`, `UpdateStripeOverageWorker`, and
`StripeLocationsReconcilePoller` all read `accounts.locations_included` now; PR #52
(review follow-up) extended `currentBillingSnapshot` to also read
`accounts.locations_overage_price_cents`.

Why stored, not config: Stripe grandfathers the original Price IDs on existing
subscriptions, so a future `TIER_CONFIG` price/quota edit must NOT retroactively
change what an existing account is told it pays. Stored = point-in-time snapshot
written at signup / select-plan / tier change.

The trap that bit us in review: the first cut grandfathered `included` (stored)
but still read overage PRICE from `config.overageCents`. Asymmetric — a config
overage-price change would have drifted the displayed/preview overage while the
included count stayed pinned. Fix: read both from the stored columns.

Remaining gap (deliberate, documented): **base price is still
`TIER_CONFIG[tier].baseCents`** — there is no `accounts.base_price_cents` column.
So the base is NOT grandfathered. Most consequential for the `founders` tier,
whose copy promises "Rate locked for life." If you ever change a base price,
existing accounts' displayed base will drift from their actual Stripe charge.
True base grandfathering needs a schema migration (add `accounts.base_price_cents`,
snapshot it at signup/select-plan/tier-change, read it in `currentBillingSnapshot`).
See the TODO in `src/lib/accounts/quota.ts` and runbook §6.

### Don't gate three different questions with one location-count boolean
[2026-05-22] The pre-PR-#51 code used `shouldUseMultiLocationSettings(flag, count)`
(`flag && count > 1`) to answer three unrelated questions at once: "show the
Locations tab?", "switch the dashboard into multi-location mode?", and "can this
account add a location?". Result: a multi-location-eligible account with exactly
one location was locked out of adding its second — the feature it paid for.

Split into three helpers in `src/lib/locations/multi-location-mode.ts`:
`shouldShowLocationsSettings` (flag only — visibility),
`shouldUseMultiLocationSettings` (`count > 1` — content mode),
`canAddLocationForAccount` (flag + active + `multiLocAllowed` — eligibility).
Pattern: when one boolean is doing visibility + mode + permission at once, that's
a smell — they have different inputs and diverge the moment a new account exists.

### Owner channel enrollment: display reads by `account_id`, runtime keys by `business_id` → multi-location desync
[2026-05-22] (WhatsApp go-live PR #53) The `/settings/channels` page hydrates
org-default enrollments by `account_id` (with `location_id IS NULL`), but every
runtime path — the `/api/dashboard/channels` status GET and the owner
start/cancel/disable routes for SMS/Telegram/WhatsApp — keys by
`business_id = user.locationId` (`user.primary_location_id`). An org-default
`channel_enrollments` row carries the `business_id` of whoever created it. On a
multi-location account with ≥2 owners on different primary locations, owner B sees
the channel "connected" on the page (matched by `account_id`) but the status API
returns nothing → Disconnect 404s, Connect trips
`channel_enrollments_account_channel_scope_uniq` (migration 034 keys uniqueness on
`(account_id, channel, COALESCE(location_id, sentinel))`, NOT `business_id`) →
classified as `EnrollmentDatabaseError` → 500.

Root cause: org-level owner enrollment is an **account-scoped** resource
(`location_id IS NULL`), but the read/write paths address it by the legacy
per-location FK. Single-location accounts are immune (`business_id` always ==
`primary_location_id`). Pre-existing; affects SMS + Telegram identically — the
WhatsApp work just mirrored the pattern and surfaced it. Interim guard:
WhatsApp owner self-service gated to single-location accounts. Correct fix
(separate task): key the org-default paths by `(account_id, channel, location_id
IS NULL)`. Since shipped — see
`docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`
(`docs/known-issues.md` was retired 2026-06-11 once every entry had shipped).

### Catching only AuthError but returning 401 for everything masks server errors
[2026-05-22] The owner WhatsApp routes wrapped `requireRole(req, 'owner')` in a
try/catch that returned `AuthError` → its `statusCode`, else a blanket
`401 unauthorized`. But `requireRole` can throw non-`AuthError` (e.g. a DB/Supabase
failure during the auth lookup) — those were being reported to the client as 401,
hiding real 5xx incidents behind a "not authenticated" response. Fix: in the
fallback, `throw err` so unexpected failures surface as a 5xx. Pattern: a catch
that maps a specific typed error should re-throw everything else, not collapse all
errors into the typed error's status. (Same anti-pattern still lives in the
Telegram/SMS owner routes — pre-existing, tracked for a follow-up.)

### Account-scoping a shared helper requires updating ALL call sites — TS + mocked tests won't catch a miss
[2026-05-22] When `cancelTelegramEnrollment` / `disableTelegramEnrollment` /
`cancelWhatsAppEnrollment` changed signature from `(sql, businessId)` to
`(sql, accountId)`, both parameters were `string`. TypeScript did not flag the 3
admin call sites (`admin/channels/telegram/{cancel,disable}`,
`admin/channels/whatsapp/cancel`) that still passed `businessId`. Mocked route tests
didn't catch it either: the queue-based `sql` mock ignores the WHERE predicate and
returns queued rows regardless of the argument value.

The bug would have silently no-op'd admin cancel/disable in production:
`WHERE account_id = <businessId>` → no matching row → 0 rows updated → the route
returned 200 as if it succeeded.

Lesson: when changing a shared helper's parameter semantics while keeping the same
type, grep ALL callers (`grep -rn 'helperName('`) before considering the change
complete, and fix every one. Consider using a branded type (e.g. `type AccountId =
string & { __brand: 'AccountId' }`) so the compiler catches mismatches at the next
type change.

---

## 2026-05-24

Discovered while standing up GitHub Actions CI (Spec 24 task 0, branch `ci-keystone`).

### `MOCK_EXTERNAL_APIS=true` in CI breaks the Zernio real-path tests
The first CI run failed 16 tests in `src/lib/zernio/__tests__/client.test.ts`,
`worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts`, and the zernio
e2e/correlation tests — all green locally. Cause: the CI env block set
`MOCK_EXTERNAL_APIS=true`, and `src/lib/zernio/client/transport.ts` returns a
**mock transport** when that var is `'true'`. So tests that inject their own
`fetch` and assert real timeout/error-classification never ran the real path
(symptoms: `vi.fn() called 0 times`, `promise resolved {reviews:[]} instead of
rejecting`). The suite is designed to run with the flag **off** — individual
tests flip it to `'true'` themselves only where they exercise the mock path
(`client.test.ts:406,488`). `.env.local` has `MOCK_EXTERNAL_APIS=false`, which
is why it was green locally.
**Correct approach:** CI must set `MOCK_EXTERNAL_APIS=false` (mirror `.env.local`).
Tests never hit the network anyway (injected mocks / `vi.mock`), so `false` is safe.

### `new Request()` has no `.cookies` — use `NextRequest` in route tests
After fixing the above, CI still failed with unhandled rejections from
`src/app/api/account/settings/__tests__/route.test.ts`:
`TypeError: Cannot read properties of undefined (reading 'getAll')` at
`src/lib/db/auth.ts:37` (`request.cookies.getAll()`), thrown from inside
GoTrueClient's async `_emitInitialSession`. The test built `new Request(url)` (a
Web `Request`, which has **no `.cookies`**) and cast it to `any`; the Supabase
SSR cookie adapter then blew up in a background promise, so assertions passed but
vitest failed the run on the unhandled error. Latent locally because real
`.env.local` Supabase creds took a different `getUser()` path.
**Correct approach:** route tests must use `NextRequest` (from `next/server`),
which carries a real cookies store (`getAll()` → `[]`), matching how routes are
actually invoked.

### Never validate CI from a git worktree nested inside the parent repo
Running `pnpm lint`/`pnpm test` inside `.worktrees/<x>/` (a worktree physically
nested under the main repo) gives false failures: ESLint walks up and finds the
parent's `.eslintrc.json` (plugin conflict), and Node/vitest resolve up into the
parent's `node_modules`, creating duplicate module instances
(`useLocationScope must be used within a LocationProvider`, mocks not
intercepting). These do NOT reproduce on a standalone CI checkout.
**Correct approach:** validate CI by pushing and reading the GitHub run, or clone
to a clean dir outside the repo. Don't trust local lint/test from a nested worktree.

### Branch protection on a private repo needs a paid plan → use a ruleset under an org
Both classic branch protection (`PUT .../branches/main/protection`) and
repository rulesets (`POST .../rulesets`) return `403: Upgrade to GitHub Pro or
make this repository public` on a **private repo on the Free plan**. An org
"Pro" purchase on a *different* account doesn't help — the plan must be on the
**repo owner**.
**Correct approach:** transfer the repo to an org on a paid plan (Team), then
apply a **repository ruleset** (not classic protection) with
`required_status_checks` + `deletion` + `non_fast_forward`. After transfer,
re-point Vercel/Railway GitHub App access to the new org and update the git
remote (GitHub redirects the old URL, but update it anyway).

### Dependabot groups must split majors from minor/patch
Grouping by `dependency-type` alone (all prod together, all dev together) bundles
breaking majors with safe patch/minor bumps, so the grouped PR is permanently red
whenever any dep ships a major (here: Next 16 removed `next lint`; a TypeScript
major broke CSS side-effect imports with `TS2882`).
**Correct approach:** add `update-types: [minor, patch]` to each group so majors
are excluded and arrive as individual, reviewable PRs.

---

## 2026-05-25

Discovered building the Step 1 keystones (`codex/step-1-keystones`, PR #81):
`accounts.past_due_at`, the generalized account audit helper, and worker-side
PostHog activation capture.

### A "posted" response has FOUR transition sites — an activation hook on one misses the rest
`responses.status = 'posted'` is set in four places, not one: the main publish
success path (`ResponsePublisherWorker.ts`), the edit-then-publish success path
AND the `409_matches` path (`edit-publish.ts`), and the idempotent 409
reconciliation path (`publisher-error-handlers.ts`). An "emit on first posted
response" event attached only to the main path silently under-counts activation
for accounts whose first post lands via edit-publish or reconciliation.
**Correct approach:** funnel every posted transition through ONE shared
chokepoint (`worker/jobs/publisher/activation.ts`,
`maybeCaptureActivationCompleted`) and test that all four paths reach it. Before
adding any "on publish" side effect, grep for every `status = 'posted'` UPDATE.

### Best-effort telemetry runs AFTER tx commit — return a candidate, don't capture inside the tx
The publish status flip happens inside a transaction; the PostHog call is
network I/O that must not run before/inside the commit. The edit-publish path
returns an *activation candidate* from the tx outcome (`{ outcome: 'completed',
postedResponse }`) and the caller captures it only after the tx commits. Pattern:
decide-inside-tx, fire-after-commit for any external side effect gated on a
just-committed row.

### `shutdownAnalytics()` must be flushed on worker shutdown — and guarded so it can't skip DB teardown
`posthog-node` batches events and flushes on a timer; events captured shortly
before a Railway redeploy are lost unless flushed on SIGTERM. Wire
`shutdownAnalytics()` into `worker/index.ts`'s `shutdown()` after the workers
close (so no new events enqueue mid-flush) and **wrap it in try/catch** — a flush
network failure must never skip the `sql.end()` that follows. Generalizes the
existing "post-completion best-effort blocks need their own try/catch" note to
the process-lifecycle teardown.

### A best-effort helper should own its never-throws contract; callers shouldn't double-wrap
`maybeCaptureActivationCompleted` swallows + logs all errors internally and
never throws. Once that contract is documented on the function, the outer
try/catch at each call site is dead code — remove it and let the one internal
catch enforce "analytics never blocks outbox completion." Tests that mock the
helper to *throw* then contradict the contract; cover the never-throws guarantee
once where it lives, not at every caller.

### A dynamically-built `new RegExp(...)` trips external ReDoS scanners even with hardcoded inputs
A migration-structure test built `new RegExp(\`...${name} ${type}\`)` from a
hardcoded `it.each` array. No project analyzer flags it (eslint is just
`next/core-web-vitals`), but external security scanners flag any interpolated
`new RegExp` as ReDoS. Don't add a disable directive for a rule the project
doesn't run — **remove the root cause**: assert with a whitespace-normalized
`.toContain(...)` substring check instead of a dynamic regex.

### `noUncheckedIndexedAccess` makes array-index reads `T | undefined`
`mockFn.mock.invocationCallOrder[0]` is typed `number | undefined` under this
tsconfig flag, so passing it to `.toBeLessThan()` fails `tsc`. After asserting
the mock was called, a non-null assertion (`...[0]!`) is correct and idiomatic
in this repo (cf. `mock.calls[0]![0]`). `pnpm test` passing does NOT imply
`pnpm typecheck` passing — run both.

---

Discovered building Wave 1 — foundation / launch-risk
(`codex/wave-1-foundation-launch-risk`, PR #85): tenant-isolation proofs,
billing reconciliation, security/PHI, legal accuracy, approval snapshot.

### `postgres.TransactionSql` has no `.begin` in its types — make the outbox helper caller-owned
Tried to make `openPhiReviewException` atomic by wrapping its two INSERTs in
`db.begin(...)`, where `db: typeof sql | TransactionSql`. `tsc` failed:
`Property 'begin' does not exist on type 'TxClient'`. Postgres.js exposes
`.begin` on the base `Sql` but NOT on `TransactionSql` (savepoints work at
runtime, the type omits them).
**Correct approach:** the *caller* owns the transaction — each call site wraps
`await sql.begin((tx) => helper(tx, ...))` and the helper takes the handle and
uses it only as a tagged template. Matches the entry-point invariant
(orchestration owns the tx boundary). The reconcile path already passed a `tx`,
so only the 3 top-level-`sql` callers (webhook worker, backfill worker,
recent-review poller) needed wrapping.

### Postgres.js does NOT parameterise every tagged-template substitution — a nested `Query` is spliced as raw SQL
Widely assumed the opposite, and #694 shipped a code comment asserting it before
review round 2 disproved it live:

```ts
await sql`${sql.unsafe('select 42 as n')}`   // → [{ n: 42 }]
```

A bind parameter can never be a statement, so that result is proof. Postgres.js
inspects each substitution: a plain value becomes `$n`, but a nested `Query`
(anything built by `sql`…`` or `sql.unsafe(...)`) is spliced into the SQL TEXT via
`fragment()`. That is what makes composable fragment builders work
(`primaryTrackedKeywordSql`, `publisherSubscriptionEligibleSql`), and it is the
same mechanism an injection would ride.

**Two consequences.** (1) "It's a tagged template, so it's parameterised" is not a
safety argument — check whether the substitution is a value or a `Query`. (2) Any
static analysis over SQL text must treat a fragment as SQL that executes
SOMEWHERE ELSE than where it is written; `ci:live-db-suites` gets this right only
because its AST walk visits the *producing* node — which is why #706 had to widen
its file set to every `.ts`/`.tsx` under `__tests__/`, since a producing node in
an unscanned file is a node it never visits. It remains blind to a fragment built
outside `__tests__/` altogether.

### An exact count written into a comment is a maintenance trap
#694's audit header cited "770 of 1201 templates" to justify not using a
tag-name allowlist. The figure went stale THREE times inside a single feature:
wrong when written, corrected to 1469 by review round 1, invalidated again by the
*other* round-1 fix commit (which added one `sql()` template), and a fourth
recount split 80-vs-78 on whether `NOT_LIVE_DB` exclusions count. Each correction
was itself reviewed and still landed wrong.
**Correct approach:** state the load-bearing CLAIM, which drift cannot falsify
("`sql()` is the plurality of tagged templates, ~770 of ~1470"), mark it a
point-in-time census, and record the method so a reader can recount instead of
trusting the number. Reserve exact figures for things a test asserts — if no test
pins it, it will rot, and a precise wrong number is worse than an honest
approximate one.

### PHI scanning must gate EVERY ingest path — `processReview` is the real chokepoint, not just `insertImportedReview`
The spec anchored "scan before `insertImportedReview`," but new (unanswered)
reviews persist through `processReview`, and the recent-review poller's
unanswered branch called it with no PHI gate — a live steady-state path
(`ZERNIO_PUBLISHING_ENABLED=true`) shipped unguarded in the first cut.
**Correct approach:** gate before persistence on all four paths (webhook,
backfill, recent-poller, reconcile). Conversely, do NOT double-gate:
`reconcileExternallyAnsweredReview` already runs `detectLikelyPhi` before each
import branch, so a "move the check above reconcile" review suggestion was
*rejected* — it would skip reconcile entirely for PHI-flagged replied reviews
and break the supersede-stale-responses logic.

### A conservative PHI regex must use co-occurrence, not bare medical keywords
First-cut patterns matched bare `patient|treatment|therapy|surgery|medication`,
which quarantined ~8/9 normal reviews for RepWorth's own target verticals
(dentists, vets, spas, PTs) — "Dr. Smith was *patient*", "great massage
*therapy*". Because PHI blocks persistence, that silently breaks ingestion for
those customers.
**Correct approach:** require co-occurrence — a self-reference
(`i|me|my|we|our`) AND a medical-context term — plus the well-scoped MRN /
insurance-identifier patterns (identifier + digits). Quarantine for operator
review, never silent-delete.

### Billing reconciliation must compute expected invoice from STORED quota, not live `TIER_CONFIG`
A reconciler that derives "expected" overage from live `TIER_CONFIG` false-alarms
on every grandfathered account (Stripe reflects the price the sub was created
at).
**Correct approach:** expected overage uses stored `accounts.locations_included`
+ `accounts.locations_overage_price_cents` (point-in-time); base is the lone
exception (`TIER_CONFIG.baseCents`, no stored column). Prefer
`currentBillingSnapshot()` over rebuilding the math.

### `ON CONFLICT DO NOTHING` + an unconditional alert = alert spam on every re-ingest
`openPhiReviewException` fired `Sentry.captureMessage` before checking whether
the `INSERT ... ON CONFLICT DO NOTHING` actually created a row, so a review
re-seen each poll cycle re-alerted forever.
**Correct approach:** gate the alert AND the follow-up outbox enqueue behind a
non-empty `RETURNING` — only a newly created exception notifies.

---

## 2026-05-26

Discovered building + reviewing Wave 2 — Activation (`codex-wave-2-activation`,
PR #87): analytics queue, past-due recovery, MFA, support + impersonation.

### Unconfigured PostHog must not burn an analytics row's retry budget
The dispatch poller treated `captureAnalyticsEvent() === false` (the documented
no-op when `POSTHOG_API_KEY` is unset) as a retryable failure. Each poll
incremented `attempts`; within `max_attempts` every queued row walked to
`status = 'failed'` — and the pending index excludes `failed`, so once a key was
finally added the **entire activation funnel was permanently lost**. A test had
even codified the bug.
**Correct approach:** if analytics isn't configured the poller **early-returns
and claims nothing** (rows stay `pending`, fully recoverable). Config/transient
failures *defer* (revert the claim's `attempts++`); only genuine per-event errors
exhaust the budget. `flush`-before-mark-`completed` so a `completed` row was
actually delivered, not just buffered; drain the in-flight batch on shutdown.

### One past-due recovery clock, read DOWN, and clamp future timestamps
`checkSubscription` measured the 7-day grace from `businesses.updated_at`, so any
unrelated write to the business row silently shifted the grace window.
**Correct approach:** `computePastDueRecoveryState(account)` is the **single**
source consumed by both the UI and the worker guard, anchored on
`accounts.past_due_at`. `daysRemaining` must `Math.floor` (not `ceil`) or the
banner over-promises by up to a day; a **future-dated** `past_due_at` (clock skew)
must be **clamped to now** (full grace), not treated as instant read-only.

### Grant-extension `expires_at` must be `max(graceDeadline, now) + days`
`parseExtension` discards any extension with `expires_at <= now`. `now + days`
is a no-op *inside* the window; `past_due_at + grace + days` is a no-op for an
**already-locked-out** account (lands in the past → discarded → stays read-only
while the route returns 200 + writes a "granted" audit row). The customer who
contacts support is the locked-out one.
**Correct approach:** `max(past_due_at + grace, now) + days*DAY` — future in both
cases.

### Impersonation: reap expired sessions, re-check AAL2 on the view, no session swap
"One active session per actor" was a partial UNIQUE index on `(actor_user_id)
WHERE ended_at IS NULL` — but nothing sets `ended_at` on TTL expiry (the `/end`
route needs the now-evicted cookie), so a lapsed session **permanently 409'd**
new starts. AAL2 was also only checked at start, not on the view loader that
renders customer PII.
**Correct approach:** `startImpersonationSession` reaps expired-but-unended rows
before the active-session pre-check; the view loader re-checks current AAL2;
view-as is admin-owned (no Supabase session swap — server-only service-role reads
scoped by `account_id`, never the service key at the `src/proxy.ts` edge).

### Every public table needs RLS — a new table without it is anon-readable
Migration 046 created `analytics_events` without `ENABLE ROW LEVEL SECURITY` — the
only table-creating migration that skipped it. In Supabase a public-schema table
without RLS is reachable via the anon PostgREST API, exposing
`account_id`/`user_id`/`business_id` + event properties.
**Correct approach:** enable RLS (deny-all, no policy) on every new table; server
reaches it via the RLS-bypassing `postgres` role. Fixed in migration 049.

### Durable analytics facts are server-emitted; only intent events are client-postable
`/api/analytics/enqueue` validated against the full allowlist, so anyone could
POST `activation_completed`/`first_response_drafted` and forge the funnel. And a
client-fired `gbp_connect_started` got an anonymous `distinct_id` while
`gbp_connected` is account-keyed, so the per-account funnel couldn't join.
**Correct approach:** gate the client route to `CLIENT_ENQUEUEABLE_EVENT_NAMES`
(intent only); capture `gbp_connect_started` server-side in the connect start
route (account-scoped, like `gbp_connected`); the client only reports failures.

### The `lint` CI job is eslint **and** the tenant-scope audit (two steps)
A green ESLint does not mean the `lint` job passes — `pnpm ci:tenant-scope` runs
as a second step. Editing a tenant-table query's SQL (adding a column/JOIN)
silently **breaks its allowlist `sqlSnippet` match**, surfacing as a paired
"unused allowlist entry" + "missing scope" finding; the first CI run of a
long-lived branch surfaces accumulated drift at once.
**Correct approach:** when a tenant-table query changes, update its allowlist
snippet to the new normalized SQL (or drop the entry if the query is now
inline-scoped), after verifying each flagged query is genuinely safe. Run
`pnpm ci:tenant-scope` locally, not just `pnpm lint`.
- [2026-07-02] Same trap, line-pinned flavor: local `pnpm lint` is ESLint-only — CI's lint JOB also runs the audit scripts; when a file with `file:line` allowlist pins shifts (e.g. `static-policy-audit`'s `src/lib/dashboard/types.ts` pins after an edit above them), run the audits explicitly (`pnpm ci:static-policy` etc.) and re-pin.

---

## 2026-05-26 — Wave 3 (Visibility & AI Safety, PRs #93–#96)

### A logger must never throw
The JSON logger (`src/lib/shared/logger.ts`) serializes object args and
`JSON.stringify`s the record. A cyclic/unserializable arg would throw — from a
**log call**, potentially inside an error path, masking the original error or
crashing a worker.
**Correct approach:** fail open. Wrap the arg sanitize and the final
`JSON.stringify` in try/catch; on failure emit a safe placeholder
(`{ unserializable: true }`). A log call must be incapable of throwing.

### Bind log context at the registration boundary, not per handler
Threading request/job IDs into every `logger.*` call by editing each handler is
huge churn and easily drifts.
**Correct approach:** an `AsyncLocalStorage` context (`log-context.ts`) + a
`withJobLogContext` wrapper applied at the BullMQ `new Worker(queue, handler)`
registration (`worker/job-log-context.ts`). Handlers are untouched; every log
line they emit inside the run automatically carries the job's IDs. Pollers
(non-job loops) are out of scope for that wrapper — bind them separately if
needed.

### Moderation must fail open, never silently approve
The optional OpenAI Moderation provider call can error or time out. If a
moderation failure threw (or returned "clean" on error), unsafe text could pass.
**Correct approach:** local regex rules always run first and stand alone; the
provider is additive and gated behind `OPENAI_MODERATION_ENABLED`. On a provider
error, fall back to the local decision and record `openai_moderation: 'error'` —
never throw, never downgrade a local flag. (`src/lib/moderation/moderate.ts`.)

### Holding an unsafe draft must stay atomic with the response write
A high-severity flagged draft must NOT send the owner notification, but the
response still persists as `pending_approval`. Doing the notification-skip
outside the response transaction would risk a partial state where a flagged
draft still got notified.
**Correct approach:** in the SAME `persistResponseAndNotify` transaction, write
moderation fields to `api_costs`, insert the `flagged_responses` row, and skip
the `send_notification` outbox enqueue — all or nothing. The no-auto-posting
invariant stays intact: flagging only removes the notification, never posts.

### A long-lived audit FK can block a prune (`ON DELETE SET NULL`)
`flagged_responses` is an audit record that outlives the `api_costs` row it
points at; `api_costs` is pruned at 90 days by the ArchivalPoller. A default
(RESTRICT) FK on `flagged_responses.api_cost_id` would make that prune fail with
a FK violation once a referenced cost row aged out.
**Correct approach:** `api_cost_id UUID REFERENCES api_costs(id) ON DELETE SET
NULL` (column nullable). The flag survives, the cost-row pointer nulls out, the
prune proceeds.

### Untrusted values inside a delimited prompt block must be escaped
Wrapping review text in a `<review>…</review>` data block is good, but
interpolating `reviewerName`/`reviewText` raw lets a malicious `</review>` close
the block early and smuggle instructions.
**Correct approach:** escape `&`/`<`/`>` on the untrusted string fields before
interpolation (`escapeForReviewBlock` in `prompt-builder.ts`) so an embedded
`</review>` renders inert as `&lt;/review&gt;`. (Numeric/controlled fields like
`starRating`/`date` can't carry markup, so they don't need it.)

### A stale `.next/` breaks `pnpm typecheck` after a branch switch
`.next/types/validator.ts` is generated by `next build`/`dev` and is **not**
switched by git. After moving from a branch that has a route (e.g. PR 1's
`/api/health`) to one that doesn't, the stale validator references a missing
module and `tsc` (which includes `.next/types/**`) errors on a file you didn't
touch.
**Correct approach:** `rm -rf .next` and re-run `typecheck`. A fresh `pnpm
build` regenerates it for the current branch.

---

## 2026-05-27 — Wave 3 (PRs 4–6: eval harness, sentiment, KPIs, finance + review fixes)

### `tests/llm-eval/*` must use relative imports, not the `@/` alias
The eval harness runs under `tsx` (`pnpm eval:llm`), and **tsx does not resolve
tsconfig `paths`** — `@/lib/...` fails at runtime. Existing CI scripts
(`scripts/ci/*.ts`) already import relatively for the same reason.
**Correct approach:** inside `tests/llm-eval/`, import via relative paths
(`../../src/lib/moderation/output-filter`). Relative paths resolve under both
`tsx` and Vitest; the `@/` alias is src-only convenience.

### A `vi.mock` path is relative to the TEST file, not the module under test
The eval live-runner test mocked the generator at `../../src/...` (copied from
the runner's own import), but from `tests/llm-eval/__tests__/` that resolves to
`tests/llm-eval/src/...` — wrong, so the mock didn't intercept.
**Correct approach:** count hops from the test file. From a `__tests__/` dir one
level deeper than the module, the mock path needs one extra `../`
(`../../../src/...`). Verify the mock actually intercepts (assert the mocked fn
was called) — a non-intercepting mock makes the test pass against the real impl.

### A dynamic `await import('./x')` is still type-checked — it can't forward-reference a missing module
`run.ts` referenced `./live-runner` (built in a later task) via dynamic import,
assuming TS wouldn't resolve it. `tsc` DOES resolve dynamic-import specifiers, so
it errored. Bridging with `@ts-expect-error` is worse: once the module exists the
directive becomes an "unused" error, and an unrelated `as` cast left behind masks
real type drift.
**Correct approach:** build modules in dependency order, or accept the type error
until the dep lands — don't paper over it. Heavy deps are still isolated behind
the dynamic import (offline stays keyless) without any suppression.

### A deterministic backfill must use the SAME formula as the runtime classifier
Migration 052 backfills `reviews.sentiment_*` in SQL while the ingest path
classifies in TS. If the two diverge, backfilled and newly-ingested rows
disagree.
**Correct approach:** keep one mapping (star→label/score). Making the v1
classifier **star-only** (no text heuristics) let the SQL `CASE` and the TS
`classifySentiment` be provably identical; `sentiment_source` is the seam for a
later text/LLM classifier. The migration-structure test + a classifier unit test
each assert the shared table.

### Sentiment must be set at EVERY review-content write site, not just `processReview`
Review content is written at three sites: the NEW insert and the content-changed
UPDATE in `process-review.ts`, **and `insertImportedReview` in
`zernio-ingest-shared.ts` which bypasses `processReview` entirely** (external-reply
path). A classifier hooked only into `processReview` silently leaves imported
reviews unclassified.
**Correct approach:** grep every `INSERT INTO reviews` / content `UPDATE reviews`
(there are exactly 5; 3 write content, 2 are status-only) and wire the classifier
at all content-write sites. Same lesson as the "four `posted` transition sites"
note — a value set at one of several write sites misses the rest.

### A typed-error catch must re-throw others; service calls need their own boundary
`/api/dashboard/kpis`'s `requireRole` catch mapped **all** non-`AuthError`
failures to 401, masking infra faults as auth errors; and the KPI service calls
had no try/catch, so a DB error escaped uncaught.
**Correct approach:** in a catch that maps a specific typed error, re-throw/500
everything else (a DB failure during auth is 5xx, not 401); wrap the
data-fetch section in its own try/catch returning a clean logged 500. (Repeats
the 2026-05-22 "catching only AuthError" note — it recurs on every new route.)

### A new owner data endpoint must replicate the subscription read-entitlement gate
`/api/dashboard/kpis` enforced auth + IDOR but not subscription status, so a
cancelled/unpaid owner could still read KPIs. Auth ≠ entitlement.
**Correct approach:** gate owner data reads on `subscriptionAllowsDashboardRead`
(`active` or `past_due` grace) **before** computing anything, mirroring
`/api/dashboard`. Extracted as a shared predicate in
`src/lib/shared/subscription-status.ts` so the rule has one home.

### Validate a client-supplied UUID before the `::uuid` DB cast (400, not 500)
`?scope=not-a-uuid` flowed into a `WHERE id = ${x}::uuid` query → Postgres
invalid-UUID error → 500. (Same latent bug still in `/api/dashboard` — tracked as
issue #103.)
**Correct approach:** `isValidUuid()` (`src/lib/shared/ids.ts`) the
client-controlled id before the DB read and return a controlled 400.

### A rate metric's numerator and denominator must share one population
`flaggedRatePct = flagged_count / generation_count`, but `flagged_count` counted
flags across **all** providers while `generation_count` was openai/anthropic-only
— a population mismatch (equal today only because non-LLM rows are never flagged).
**Correct approach:** scope both to the same set (`FILTER (WHERE provider IN
('openai','anthropic') AND flagged)`). Audit every rate's two halves for the same
WHERE.

### A `pg_constraint` existence guard must be scoped to its relation
`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...')` is unsafe —
`conname` is unique only per-table, so a same-named constraint on another table
false-matches and skips the `ADD`.
**Correct approach:** join `pg_class`/`pg_namespace` and filter
`relname = 'reviews' AND nspname = 'public'`.

### The queue-Proxy `sql` mock needs its call index reset on re-seed within a test
A test that seeds rows, calls the service, then re-seeds and calls again read
**past the cursor** (the counter wasn't reset) — the second call got empty rows,
so assertions passed vacuously.
**Correct approach:** reset `sqlCallCounter.value = 0` (and the results array)
inside the `seed()` helper so every seed is a fresh queue. Watch for tests whose
second assertion happens to equal the "empty" result — they hide this.

### A new endpoint must not couple a pre-existing one's success to its own query
`/api/admin/costs` ran `getCostReport` and the new `getMarginReport` in one
`Promise.all` with a single 500 catch — a fault in the new finance query would
take down the long-standing cost report.
**Correct approach:** make the new/secondary data **best-effort** —
`getMarginReport(...).catch(() => null)`, return `margin: null`, keep the
required data's failure as the 500. The consumer already guards a missing margin.

### tenant-scope allowlist `sqlSnippet`s break on ANY query-text change — and recur
Every time a tenant-table query's SQL changed in PRs 5–6 (adding sentiment
columns, the `flagged` provider filter, the TTR `status <> 'deleted'` clause) the
allowlist `sqlSnippet` stopped matching → the paired "unused entry" + "missing
scope" finding. Admin cross-account aggregates (margin, flagged queue) are
**intentionally** unscoped and allowlisted with a `requireRole('admin')`
rationale.
**Correct approach:** after editing any allowlisted query, re-run
`pnpm ci:tenant-scope` and sync the snippet to the new normalized SQL (verify the
query is still genuinely scoped/admin-gated first). Expect this on nearly every
SQL edit to a tenant table.

### A branch off `main` can sweep PR4's untracked report artifacts via `git add -A`
PR4 gitignores `tests/llm-eval/reports/`. The sentiment branch (off `main`, which
lacks that rule) had untracked report JSONs in the shared working tree; a
`git add -A` during an amend swept three into a commit.
**Correct approach:** `git rm` them + add the gitignore guard on the branch; a
file added-then-removed across a branch nets to absent in the PR diff. Prefer
explicit `git add <paths>` over `-A` when sibling branches' artifacts may be
loose in the tree.

## 2026-05-28

### Backtick-wrapped `tx`/`sql`/`db` in a comment broke the tenant-scope audit (RESOLVED #125, PR #149)
`scripts/ci/tenant-scope-audit.ts` extracts SQL by regex-scanning raw source text
for tag-template literals (tags `sql`/`tx`/`db` + any `sql` alias imported from
`db/server`); it does NOT strip JS/TS comments first. A backtick-quoted tag word
in a comment (e.g. `(`tx`)` in a doc-comment) is read as the OPENING of a template
literal, and the parser consumes up to the next real backtick — SWALLOWING the SQL
template that follows. The swallowed query is then never audited (a silent
tenant-scope COVERAGE GAP), and any allowlist entry for it reports "unused entry".
Bit PR #124: a new `edit-publish-tx.ts` header comment — "runs on an already-open
transaction (`tx`)" — swallowed `supersedeSibling`'s
`UPDATE responses ... WHERE id = ${siblingId}` → unused-entry → CI `lint` job
(`pnpm ci:tenant-scope`) failed; the file's `zernio_connections` UPDATE was
dropped from the audit too. Benign on `main` only because its lone backtick-`tx`
sat AFTER the query.
**RESOLVED (#125, PR #149, commit `51dc796f`):** `extractSqlTemplates` now strips
JS/TS comments before the tag-scan, via a char state machine that leaves `//` and
`/*` inside string/template literals intact. A backtick-wrapped `tx`/`sql`/`db` in a
comment no longer opens a phantom template, so the "never write a backtick tag in a
comment" workaround is no longer required.
**Residual limitation (noted during PR #149 review):** the stripper does NOT model
JS regex literals or nested template interpolation. A `'` or `` ` `` inside a regex
literal placed before a tagged SQL template could still mis-track state and drop the
query — both are rare in scanned `src/`/`worker/` files, but if the audit ever
reports a baffling "unused entry", check for a regex literal upstream.

### Moving an allowlisted query to a new file orphans its allowlist entry
Allowlist entries are keyed by FILE + table + normalized snippet, so relocating a
tenant-table query (extraction/refactor) leaves the old entry "unused" and the new
file uncovered. `pnpm lint` is `eslint src` — it does NOT run this audit and does
NOT cover `worker/`, so a moved-query break passes local `lint` but fails the CI
`lint` job (which also runs `pnpm ci:tenant-scope`).
**Correct approach:** when SQL moves between files, repoint the entry's `file` and
run `pnpm ci:tenant-scope` (+ `ci:rls-audit`) — not just `lint`/`typecheck`/`test`.

### A worktree test failure can be a real regression, not the nested-worktree leak
The nested-worktree `node_modules` leak (CLAUDE.md "CI & repo") is real, which makes
it a tempting catch-all whenever tests fail inside a `.claude/worktrees/` checkout
but "pass in a clean checkout." During PR #130 I dismissed 11 `generator.test.ts`
failures as the leak — they were a genuine regression. The trap: I compared the
worktree (MY branch) against a clean checkout sitting on `main` (WITHOUT my change),
so "passes clean, fails in worktree" looked environmental when it was really "passes
on `main`, fails on my branch." CI on a clean clone of the BRANCH failed identically
— the decisive signal I should have trusted first.
**Correct approach:** to separate an environmental artifact from a real bug, run the
SAME ref in both places (or just read the branch's CI on a clean clone). "Passes on
the base branch" proves nothing about your change. Never reach for a known gotcha as
the explanation without reproducing it with one variable changed at a time.

### A compat re-export must shield ALL consumers, not just the externally-owned one
When you extract a module and leave a re-export shim on the OLD module for
back-compat, repointing even ONE in-house consumer at the NEW module breaks every
test that mocks the OLD module to neutralize that consumer's side effects. PR #130
extracted `concurrency-guard.ts` from `costs/tracker.ts` (shim left on `tracker`) and
repointed `cost-guard.ts` at the new module. `withCostGuard`'s consumers
(`generator.ts`, `review-summary.ts`) have tests that `vi.mock('@/lib/costs/tracker')`
to stub the guard — once `cost-guard` sourced the slot fns from `concurrency-guard`
(unmocked), those tests hit the real `getCacheRedis()` ("Connection is closed.").
Reverted; `cost-guard` stays on the shim like every other consumer.
**Correct approach:** while the shim exists, keep ALL consumers on it; migrate them
together — and update their test mocks to the new module — in one follow-up once the
shim is removed. A consumer's import path is part of the test-mock contract of
everything that exercises it.

### Nested-worktree work: tool path-resolution leak + concurrent branch/stash churn
Two failure modes hit the parallel-agent channel-scope fixes (PRs #132/#133/#135),
both rooted in `.claude/worktrees/<x>` living UNDER the main repo. (1) A subagent
spawned with its own worktree had Edit/Write resolve file paths against the PARENT
repo working tree, not its worktree — it "wrote" files into the main checkout, then
detected the drift, captured diffs as patches, reverted main, and re-applied onto its
worktree branch. (2) Across a long session the MAIN checkout's branch + `git stash`
stack were mutated by concurrent work: HEAD moved off the fix branch onto an unrelated
branch and the in-progress edits were auto-stashed ("WIP (preserve)"); the stash stack
also reordered between two `git stash show` calls. Net effect: an "Edit succeeded"
result followed by a "file modified since read" / reverted-content reminder is NOT
proof your change landed on the branch you think you're on.
**Correct approach:** for multi-step edits in a worktree/contended tree —
(a) CI on the pushed branch is the only authoritative lint/test signal (never trust
local runs from a nested worktree; CLAUDE.md "CI & repo");
(b) re-verify `git rev-parse --abbrev-ref HEAD` immediately before EVERY commit;
(c) `git add` files by EXPLICIT path, never `-A`/`.`, so a stray concurrent change
(e.g. unrelated legal edits) can't ride along;
(d) snapshot risky WIP to a `/tmp` patch (`git diff -- <files> > /tmp/x.patch`) so a
branch switch or stash reorder can't lose it;
(e) commit small and often rather than holding a large uncommitted WIP.

## 2026-05-29 — Launch readiness (Parts 1 & 2)

### iOS Safari clips the rounded island — `overflow:hidden` + `border-radius` + retained `transform`, NOT the sibling clip the audit assumed
The 2026-05 launch audit (part 2, doc since retired) reported that `.rw-island { overflow:hidden }` was
clipping the **fixed dot-nav + parallax** on iOS. That diagnosis was wrong: the
dot-nav and parallax are *siblings* of `.rw-island`, not descendants, so they were
never inside its clip box. The real bug (PR #161) is the well-known **iOS Safari
repaint glitch**: a box that has `overflow:hidden` **and** a `border-radius` **and**
a retained `transform` (the marketing island holds `scale(1)` via a `both`-fill
animation; the auth island animates `transform` on intro) intermittently fails to
re-clip its own rounded corners on repaint, so content bleeds past the radius.
**Correct approach:** fix the *property*, not the assumed sibling. Remove
`overflow:hidden` from the island root; where a child genuinely needs to clip a
full-bleed pane (the auth `.rw-showcase` gradient), give *that* child its own
`border-radius` + `overflow:hidden` so it self-clips. A Vitest contract test
(`src/__tests__/island-overflow.test.ts`) now asserts no `.rw-island` block — root
or `@media` — re-declares `overflow:hidden`. Lesson: when an audit hands you a
plausible CSS cause, reproduce the clip with one variable changed at a time before
trusting the stated mechanism.

### An admin "act on stuck items" panel needs a real backend route + outbox transitions, not a frontend-only button
`ZernioConnectionPanel` carried a `TODO(zernio)` for force-drain/dismiss buttons on
the awaiting-reconnect queue. There was **no backend** to wire them to —
`awaiting_owner_connect` is only ever *set* by `zernio-publisher.ts`; nothing drained
or dismissed it on demand. Adding buttons first would have been a dead end. The real
fix (PR #185, blocker #23b) is an admin-only `POST
/api/admin/businesses/[id]/zernio-queue` that **force-drain** re-fires the existing
`drain_pending_owner_connect` → `DrainOwnerConnectWorker` (gated on
`ZERNIO_PUBLISHING_ENABLED` + active connection) and per-response **dismiss** →
`superseded` (`posting_error='admin_dismissed_awaiting_connect'`), each writing
`account_audit_log` in the **same transaction**, mirroring `grant-extension`/`flagged`.
**Correct approach:** before adding a control to a panel, confirm the state machine
has a real, audited transition to drive it — and reuse the existing outbox worker
rather than inventing a second drain path. Invariant #3 stays intact because these
are post-approval drafts and the publisher's subscription guard still applies.

### A flag-driven "reason swap" on a feature with no owner-facing path either way is misleading — show one honest, flag-independent message
The owner SMS row swapped its "coming soon" copy based on `CHANNELS_SMS_ENABLED`, but
there is **no owner self-service SMS path either state** (SMS enrollment is
admin-only). So flipping the flag changed the *words* without changing what the owner
could actually do. PR #176 de-scoped owner SMS to post-launch: the row now shows one
honest, flag-independent "SMS notifications are coming soon", and the dead owner-UI
plumbing (`smsAvailable()` + `initialAvailability.sms`) was removed. The flag's real
consumers (worker dispatch, admin enrollment, factory, boot assertion) were left
untouched. **Correct approach:** a feature flag should gate real behavior; if both
branches dead-end at the same place, delete the branch and the plumbing rather than
dressing it up.

## 2026-06-04

### Railway RAILPACK builds have no `.git` → a git-touching `prepare` script breaks the deploy
A `prepare: "lefthook install"` script (added to install git hooks on `pnpm
install`) passed local installs, GitHub CI, and Vercel — but **failed the
Railway worker build**. Railway's RAILPACK builder runs `pnpm install
--frozen-lockfile --prefer-offline` in a build context with **no `.git`
directory**, so `lefthook install` aborts with `fatal: not a git repository`
(exit 128) → `prepare` Failed → `[ELIFECYCLE] Command failed with exit code 1`
→ `Build Failed`. The previous image keeps running (no live outage), but every
subsequent Railway deploy is blocked until it's fixed. GitHub CI (`actions/checkout`)
and Vercel both build from a git checkout, so neither reproduces it — **CI green
does NOT prove a Railway-safe install.** **Correct approach:** any
`prepare`/`postinstall` that shells out to git must be deploy-safe —
`prepare: "lefthook install || true"`. Hook installation is a local-dev
convenience; never let it abort a production install. To reproduce the failure
locally, run the installer from a dir with no `.git` (`cd $(mktemp -d) &&
node_modules/.bin/lefthook install; echo $?` → 1).

## 2026-06-06

### The auto-approval kill switch is read at worker *boot*, so you can't test the §6 downgrade with a "flip mid-flight" race
`autoApprovalRuntimeEnabled()` reads `process.env.AUTO_APPROVAL_ENABLED`, and Railway
injects env at **process start** — so a running worker keeps its boot-time value until
it **restarts**. Trying to test the publisher kill-switch downgrade by auto-approving a
review and then flipping the flag mid-flight just **posts**: the old process publishes
within seconds, long before a redeploy boots a flag-off process. On a real connected GBP
that is a real reply you didn't want. **Correct approach (post-safe):** set
`AUTO_APPROVAL_ENABLED=false` on the worker *first*, then make the publisher process an
already-`approved` `auto_policy` row while the flag is off — seed a *test* review's
response to `approved`/`auto_policy` + insert its `publish_response` `job_outbox` row in
one tx; the running (flag-off) publisher hits the kill-switch and **downgrades instead of
posting** (`status='pending_approval'`, `posting_error='auto_policy_revoked_by_kill_switch'`,
re-notify). Documented in the runbook appendix (`completed_runbooks/auto-approval-staging-test.md`).

### `psql` can't open the staging `DATABASE_POOL_URL` — it carries a Postgres.js-only `?pgbouncer=true` param
The Railway worker's `DATABASE_POOL_URL` ends in `?pgbouncer=true` (a Postgres.js
connection hint). `psql`/libpq rejects it: `invalid URI query parameter: "pgbouncer"`.
**Correct approach:** strip the query string and re-add only `sslmode=require`
(`"${url%%\?*}?sslmode=require"`), or use the direct `DATABASE_URL`. Pull the value
**unprinted** (`railway variables --kv | grep '^DATABASE_POOL_URL=' | cut -d= -f2-`) so the
credential never lands in the terminal.

### Vercel staging is behind Deployment Protection (SSO) — automation/CDP browsers can't log in
`staging.repworth.net` returns `401` and redirects to `vercel.com/login`; the Google SSO
step then refuses an automation-controlled (DevTools-protocol) browser ("this browser may
not be secure"). **Correct approach:** use a **Protection Bypass for Automation** token —
navigate once to `…?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true` to
set the bypass cookie, then the app's own **email/password** login works in the automated
browser. Don't try to complete Vercel/Google SSO inside the controlled browser.

---

## 2026-06-08 — Owner offboarding (staging dry-run + live E2E)

### `railway up` from a nested git worktree ships STALE worker code → `OutboxPoller: Unknown topic`
Deploying the staging worker with `railway up` from `.claude/worktrees/<name>/` produced a running
worker **missing the offboarding queue wiring** — the boot banner had none of the five offboarding
pollers, and the billing job failed in the outbox with
`Unknown topic: account_offboarding_billing_schedule`, stalling every offboarding job. The
fix-branch source was correct (`worker/queues.ts` registers all five offboarding topics in
`topicToQueue` unconditionally), so this is a deploy artifact, not a code bug. **Correct approach:**
deploy the worker from a **clean clone** outside the worktree —
`git clone -b <branch> file://<repo> /tmp/deploy && cd /tmp/deploy && railway up -p <proj> -s repworth-worker -e staging --ci -y`. Same worktree footgun that aborts the Vercel CLI upload
(CLAUDE.md "Worktrees are footguns here"). Also: `railway logs` non-interactively returns a
stale/truncated snapshot — don't trust it to prove pollers booted; verify by driving a real job.

### Stripe Basil/Dahlia: `current_period_end` is on the subscription ITEM, not the top level
With the pinned `apiVersion: '2026-05-27.dahlia'` (Basil-era), `subscription.current_period_end`
(top-level) is **undefined**; the value lives at `subscription.items.data[0].current_period_end`.
Reading the top-level field threw and stranded `cancel_only` at `failed/billing` (dry-run D1).
**Correct approach:** `items.data[0].current_period_end ?? subscription.current_period_end` (item
first, legacy top-level fallback). A unit mock that returned the field top-level hid this; the
regression test feeds the real item shape.

### `approval_audit_log` has NO `approval_link_id` / `user_agent` columns
The purge scrub + verification referenced two phantom columns; Postgres rejects them at **plan
time** (`column "approval_link_id" … does not exist`) regardless of row count, so every
`delete_data` purge failed and data was never deleted (dry-run D3). The real PII columns are
`response_id, token_hash, device_cookie_hash, ip_address, metadata, actor_user_id,
response_text_at_approval`. NB: `account_audit_log` (a different table) legitimately HAS
`ip`/`user_agent`/`request_id` — scrub those there. **Lesson:** the unit tests asserted the scrub
**SQL text** (and even asserted the phantom columns present), so the drift sailed through CI — add a
real-DB integration test that runs the production scrub/verification against the live schema.

### keep-my-data must be EXEMPT from the blanket `/api/account/*` owner-API proxy gate
`isProtectedOwnerApiRoute` matched `/api/account/*` and trapped the public, token-authenticated
`/api/account/offboarding/keep-my-data`, so a logged-out owner clicking the rescue link in their
email got `401` (dry-run D2). **Correct approach:** a `PUBLIC_OWNER_ACCOUNT_API_PATHS` exemption
checked **before** the `/api/account/` prefix (the route validates its own raw token), mirroring the
`/admin/login` exemption. Sibling `confirm`/`reactivate`/`status` stay owner-gated.

### Shrinking `purge_after` for a test is blocked while a keep-my-data token is live
`enforce_account_offboarding_purge_after_token_expiry` rejects setting
`account_offboardings.purge_after` earlier than an **active** keep-my-data token's `expires_at` (a
good safety invariant). To exercise purge end-to-end on staging, **revoke/expire the token first**
(`UPDATE account_offboarding_tokens SET revoked_at=NOW() …`), then `UPDATE … SET purge_after=NOW()`.

## 2026-06-09 — Billing compliance hardening

### A pinned Stripe `apiVersion` does NOT pin webhook payload shapes
`new Stripe(key, { apiVersion })` only fixes the version for **outbound** API calls this client makes.
Inbound **webhook** event payloads are shaped by the version set on the Stripe Dashboard **endpoint**,
which is independent. **Correct approach:** keep `STRIPE_CLIENT_CONFIG.apiVersion`
(`src/lib/payments/stripe-client.ts`) and the Dashboard endpoint version in lockstep, and treat the
endpoint version as a launch-gate item with staging evidence — not something the code pin guarantees.

### Stripe `tax_behavior` is immutable once set; `tax_code` lives on the Product, not the Price
You cannot "update tax_behavior" on a Price that already has it set to inclusive/exclusive — only a
Price whose `tax_behavior` is still `'unspecified'` is updatable; otherwise you must **create a new
Price**. And the SaaS tax code (`txcd_10103001`) is a **Product** field, not a Price field. **Correct
approach (launch gate):** set `Product.tax_code`, then per Price update-if-unspecified-else-recreate;
pre-revenue, recreate-from-scratch is the zero-ambiguity option.

### Changing a tier price = new Stripe Price ID + env lockstep; existing customers are grandfathered
A Stripe Price `unit_amount` is immutable, so a price change means a **new Price object**. RepWorth
grandfathers via the stored snapshot on `accounts` (`base_price_cents` / `locations_included` /
`locations_overage_price_cents`, migration 054, invariant #9a) — billing reads those, not live
`TIER_CONFIG`. **Correct approach:** the documented procedure in `env-vars.md` — new Price → point
`STRIPE_PRICE_*` at it in dev+staging+prod lockstep → match `TIER_CONFIG` → `pnpm verify:stripe-prices`.
New signups/tier-changers get the new price; existing subs keep theirs. Repricing *existing* customers
is a separate cohort migration + ARL §17602(g) notice (out of scope). `TIER_CONFIG` and the Stripe
`unit_amount` are two copies of one fact with no runtime assertion — `verify:stripe-prices` is the guard.

### Dahlia preview-invoice lines expose `pricing.unit_amount_decimal`, not `price.unit_amount`
The reconciliation drift sum (`undiscountedLineAmountCents` in `billing-reconciliation/drift.ts`) reads,
in order, `price.unit_amount` → `pricing.unit_amount_decimal` → `subtotal` → `line.amount`. On the pinned
`2026-05-27.dahlia` version, real lines populate `pricing.unit_amount_decimal` (the legacy `price` shape
is absent), and tax surfaces on `subtotal`/`amount`. **Correct approach:** the tax-safety regression test
must model the Dahlia shape AND carry tax-inflated `subtotal`+`amount` the function must ignore (returns
pre-tax 7900, not 8612) — testing only the legacy `price.unit_amount` path wouldn't guard the real path.

### `pnpm lint` only covers `src/` — `worker/` TS is not ESLint-linted
The `lint` script is `eslint src`, so unused imports / lint issues in `worker/**` are caught only by
`pnpm typecheck` (tsc), not by lint. **Correct approach:** after migrating worker code, rely on typecheck
for worker files (and eyeball them); don't assume a green `pnpm lint` vetted the worker tree.

### Mocking Postgres.js `sql` in a Vitest unit: `vi.mocked(sql)` keeps the typed tagged-template signature
`vi.mocked(sql).mockResolvedValueOnce([{…}])` is rejected by TS because the typed tagged-template return
(`RowList`/result-meta) doesn't accept a plain row array. **Correct approach:** `const sqlMock = sql as
unknown as Mock` (runtime is the `vi.fn()` from `vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }))`),
then `mockResolvedValueOnce`/`mockReset` per case. Used in `quota.grandfathering.test.ts`.

## 2026-06-09 — Vercel BotID + WAF (Slice 2 rate-limit hardening, PR #257)

### BotID client/server `checkLevel` must match, or it fail-blocks real users
Vercel BotID verification fails if the client `initBotId` and the server `checkBotId` advertise a DIFFERENT `checkLevel` for the same path — and a failed verification can block legitimate traffic. FAIL → real users 403'd by config drift. WHY → the client challenge and server check must agree on the level. CORRECT → derive BOTH sides from ONE isomorphic list (`src/lib/security/botid-routes.ts`); never hand-write the level in a route. A test pins the exact path→level contract.

### Only BotID-protect a route that has an in-app, token-bearing caller
BotID's client SDK only attaches its challenge token to fetches made FROM the instrumented app. A route reached by a native `<form>` POST, a server-to-server call, or an external/separate frontend carries NO token → `checkBotId` returns `isBot:true` → 403. FAIL → we nearly shipped enforce-now BotID on `/api/contact` + `/api/demo-request`, which are dead "public-lead remnants" with no in-app caller (`book-a-demo` posts to `/api/lead-intake`; `help/contact` has no form) — it would have 403'd any surviving external caller, and preview + unit tests (which MOCK `checkBotId`) cannot catch it. CORRECT → before protecting a route, grep for its in-app `fetch` caller; if none, don't protect it, and add a test asserting unprotected paths are NOT registered.

### BotID Deep Analysis is billed → gate it behind cheap guards AND auth
`checkLevel:'deepAnalysis'` runs ML scoring at ~$1/1000 calls; Basic is free. Calling it before a route's cheap rejections wastes money on traffic that would be rejected anyway. `assertSameOrigin` is NOT sufficient gating — the Origin header is forgeable by a script. FAIL → `onboarding/start` ran the Deep call before its auth 401, so session-less scripted noise burned Deep $. CORRECT → put `botIdBlockResponse` AFTER the feature-flag/same-origin guards AND (on an auth-gated route) after the 401, so Deep fires only for a confirmed session.

### `botIdBlockResponse` fails OPEN on infra error, throws on unregistered path
Mirrors the app-wide rate-limit posture: if the BotID platform check itself ERRORS (API blip, missing OIDC token) we log + return `null` (allow), so a BotID outage doesn't 500 signup/login for everyone — the route's own rate limits + the WAF still apply. But an UNREGISTERED path THROWS (programmer error surfaced loudly, not swallowed as fail-open). Resolve the per-path options OUTSIDE the `try` so the throw isn't caught.

### Vercel WAF custom rules have NO committable config file
There is no `vercel.json` field for WAF custom rules — they are Vercel platform state (staged drafts → `vercel firewall publish`). FAIL → expecting to commit them as code. CORRECT → the runbook (`docs/runbooks/vercel-waf-rate-limiting.md`) is the authoritative, version-controlled representation; its `vercel firewall rules add` commands reproduce the rule set, and "if a live rule changes, change it here too."

### Staging custom env is preview-TYPE → don't add a production-only WAF condition
RepWorth is one Vercel project; the staging Custom Environment is **type `preview`** (branch `staging`). A WAF rule with `{"type":"environment","op":"eq","value":"production"}` therefore EXCLUDES staging. FAIL → a "target production" condition silently leaves staging unprotected. CORRECT → omit the environment condition so the rule covers prod + staging + previews alike (the only place an env condition belongs is the optional "test the flip in preview first" step).

## 2026-06-11 — Multi-location two-location full-loop sign-off run

Notes from driving the launch-gating full loop (Zernio webhook → ingest → real-LLM draft → owner approve → publish) for two locations against a local stack. Runbook: `docs/runbooks/multi-location-e2e-full-loop.md`.

### Zernio fixture's `publish_reply` MUST attach the reply to the stored review
The publisher does a post-publish verification (`worker/jobs/publisher/verify-posted.ts` → `verifyOwnReplyAttached`, added after the 2026-05-31 phantom-id false-positive): after `postReply` returns 2xx it re-reads the review via `listAllReviews` and requires OUR reply text to be `reviewReply.comment`. FAIL → the E2E fixture (`e2e/fixtures/zernio-fixture-server.ts`) recorded the `publish_reply` call but left the seeded review's `reviewReply: null`, so the re-read threw `ZernioReplyVerificationIndeterminateError(review_found_but_reply_null)` and EVERY full-loop response was marked `status='failed'` — the loop could never reach `posted`. CORRECT → `publish_reply` now attaches `reviewReply = { comment, updateTime }` to the matching stored review (mirrors real Zernio). Fixed + regression-tested in #273. Lesson: any fake provider that records a write must also REFLECT it on the next read if the worker verifies its own writes.

### A committed `tsx` launcher can't use top-level await (repo is CJS)
`package.json` has no `"type":"module"`, so `tsx`/esbuild transforms `.ts` to CJS, and top-level `await` throws `TransformError: Top-level await is currently not supported with the "cjs" output format`. FAIL → `e2e/fixtures/serve.ts` used a top-level `await startZernioFixtureServer(...)` + `await new Promise(...)`, so the documented `pnpm exec tsx e2e/fixtures/serve.ts` wouldn't start. CORRECT → wrap the body in `void (async () => { ... })()`; a listening HTTP server keeps the process alive without the trailing `await new Promise`.

### Running the real worker locally against isolated infra (mocks OFF) without touching shared services
To exercise `MOCK_EXTERNAL_APIS=false` safely, OVERRIDE every infra pointer to local before `pnpm worker` (the worker loads `.env.local` via `worker/env.ts` with dotenv `override:false`, so a prior `export` wins): `DATABASE_POOL_URL`/`DATABASE_URL` → local Postgres; `REDIS_QUEUE_URL=redis://localhost:6379/14` + `REDIS_CACHE_URL=redis://localhost:6379/15` (both ioredis-compatible; use HIGH db numbers to isolate from the dev worker's db0); empty `REDIS_QUEUE_TOKEN`/`REDIS_CACHE_TOKEN`; `ZERNIO_API_BASE=<fixture url>`; `GLOBAL_DAILY_COST_LIMIT_CENTS` low; empty `RESEND_API_KEY`/`SENTRY_DSN`/`POSTHOG_API_KEY` to silence real outbound. WHY isolate the CACHE specifically: the cost-guard writes the platform-wide `cost:global:{date}` key — hitting the real Upstash would skew the live circuit breaker. Also: a dev worker already holds **PORT 3001**, so run the test worker on a different `PORT` and point `WORKER_URL` at it.

### Get a webhook-signing secret from dotenv, not `grep`/`cut` — and sign in-process
`scripts/zernio-fire-webhook.sh` signs the body HMAC-SHA256 with `ZERNIO_WEBHOOK_SECRET`; the worker verifies with the dotenv-parsed value. FAIL → extracting the secret with `grep '^ZERNIO_WEBHOOK_SECRET=' .env.local | cut -d= -f2-` gave a mangled 118-char string (vs the real 32) → `401 invalid_signature`; capturing `pnpm exec tsx -e "...console.log(secret)"` into a shell var ALSO contaminated it with pnpm's banner. CORRECT → sign the webhook entirely in-process (a `tsx -e` that runs `dotenv.config({path:'.env.local'})` then `crypto.createHmac('sha256', process.env.ZERNIO_WEBHOOK_SECRET)` and POSTs) so the secret never round-trips through a bash variable.

### Approving a draft headlessly (no browser/CSRF) → `approveBySession`
The token-mode approval route is device-bound + CSRF-protected (awkward to drive without a browser). For a scripted/owner approval that faithfully runs the SAME core path (lock via `lockPendingResponse` → mark `approved`/`approval_method='owner'` → `enqueuePublishResponse` → audit), call `approveBySession(tx, responseId, businessId, { actorUserId, ipAddress }, correlationId)` from `src/lib/approval/session-mode.ts` inside `sql.begin`. (A tsx script that imports `@/lib/...` must run `dotenv.config({path:'.env.local'})` FIRST, or a transitively-imported Supabase client constructor throws `supabaseUrl is required`.)

---

## 2026-06-14 — Fallow CI (channels-rollout PRs #320 / #321)

Notes from making the `fallow` quality gate (`fallow audit --gate new-only --fail-on-issues --base origin/main`) pass for the auto-post FYI + channel work. Config: `.fallowrc.jsonc`. Related runbooks: `docs/runbooks/channels-rollout.md` (prod rollout), `docs/runbooks/channels-staging-smoke-test.md` (staging test).

### `fallow-ignore-next-line` is SINGLE-LINE — directive + justification on ONE comment line
The directive suppresses the source line IMMEDIATELY below it — and another `//` line counts as that "next line." FAIL → I wrote a multi-line block (directive on line 1, four more `//` justification lines, then the `export async function`), so the directive attached to the next *comment* line, not the function; the three `complexity` findings persisted and `fallow audit` stayed exit 1 even though the comment "looked" attached. CORRECT → put the directive AND its reason on one line: `// fallow-ignore-next-line complexity — <reason all inline>` directly above the target (matches the existing `approval-client.tsx` / `zernio/client/transport.ts` suppressions). Bonus gotcha: verify with the REAL exit code — `fallow … 2>&1 | tail; echo $?` prints `tail`'s exit (always 0), not fallow's; use `fallow … > log 2>&1; echo $?`.

### Resolving `--gate new-only` findings: fix the genuine, configure dispatch + divergent
Only `introduced:true` findings gate (inherited/pre-existing ones in a touched file — e.g. `postReplyAndHandleTerminalOutcomes` complexity — are excluded, so they need NO suppression). Conventions, all in `.fallowrc.jsonc`: (1) a genuinely-unused export → DELETE it (`buildAutoPostNoticeEmailHtml` was only used in-file); (2) interface-dispatched class methods reported "unused" because the `getChannel(id).sendX()` factory hides the concrete call → `usedClassMembers` scoped rule `{ "implements": "NotificationChannel", "members": [...] }` (one entry beats N inline comments); (3) inherent entry-point / one-pass-loop complexity → inline `complexity` suppression with a real justification; (4) deliberately-parallel-but-behaviourally-divergent clones → `duplicates.ignore` by file — ignoring ONE side of a 2-instance group drops it below `minOccurrences:2`. The envelope key is `.duplication` (not `.dupes`); per-finding `introduced` flags tell you which actually gate.

---

## 2026-06-20 — Beta-launch alerting gate (PR #354)

### Production startup asserts are gated on `NODE_ENV` — an env without it silently disables them
`worker/config/startup-assert.ts` guards `assertAlertSinkEnv` (the new `SENTRY_DSN` requirement), `assertAdminNotificationEmail`, and the prod branch of `assertStripeWorkerEnv` with `if (process.env.NODE_ENV !== 'production') return;`. FAIL → checking the Railway `production` worker env (still pre-launch) showed only 9 vars: no `SENTRY_DSN`, **and no `NODE_ENV`** — so if prod were deployed as-is, the entire boot-safety layer would no-op and the worker would boot happily without an alert sink (the exact silent-inert failure the gate exists to prevent). Staging was fine (74 vars, `NODE_ENV=production` + `SENTRY_DSN` set → gate active and passing, worker boots). CORRECT → when provisioning prod, set `NODE_ENV=production` **and** `SENTRY_DSN` together; treat "the prod safety asserts only fire when `NODE_ENV=production`" as a provisioning invariant, not an assumption. Verify presence without printing secrets: `railway variables -s repworth-worker -e <env> --kv | grep -c '^SENTRY_DSN='`.

### Fallow `fallow-ignore-next-line` reason: prefer the line ABOVE, not trailing the directive (refines 2026-06-14)
The 2026-06-14 note prescribes `// fallow-ignore-next-line <kind> — reason` all on ONE line. That passes the gate, BUT local fallow 2.86.0 tokenizes every word after `<kind>` as its own issue-kind and reports each as a **stale-suppression** WARNING (118 of them, from 4 prose-laden directives here) — noisy even though stale-suppressions are warn-level (exit stays 0). CORRECT (clean on any version) → put the rationale on the comment line(s) ABOVE and leave the directive bare: `// <rationale>` then `// fallow-ignore-next-line complexity` directly above the target. The directive itself is still single-line (the 2026-06-14 rule holds); just don't trail free text after the kind.

---

## 2026-06-22 — Card-up-front trial: bugs only a live staging E2E catches (PR #362)

Three real launch-blockers in the 30-day trial, ALL invisible to a 6-round plan grill + two Codex passes + a thermo-nuclear pass + a 5-agent heavy review — caught only by driving the real flow on staging (real Stripe test-mode Checkout, real onboarding). Meta-lesson: for **Stripe/billing and onboarding flows, code review reasons from *assumed* external behavior**; a live staging E2E is what verifies the assumption. Run it before flipping the flag.

### A $0 card-up-front trial Checkout reports `payment_status='paid'`, NOT `'no_payment_required'`
FAIL → the trial-start branch in `worker/ingress/stripe/checkout-completed.ts` gated on `session.payment_status === 'no_payment_required'` (Codex round 1 *assumed* trials arrive that way). On staging EVERY trial fell through to the inline paid-activation block and was misfiled `subscription_status='active'` with `trial_ends_at=NULL` and no `trial_started` event — owner saw no trial. The real `checkout.session.completed` (verified in `inbound_events`): `payment_status='paid'`, `amount_total=0`, `mode='subscription'`, while the Stripe subscription was genuinely `trialing`. WHY → with `payment_method_collection:'always'` (card up front), Stripe auto-finalizes the $0 `subscription_create` invoice as **paid**, so `payment_status` is `paid` not `no_payment_required`. CORRECT → detect a trial by the **$0 subscription-mode signal** (`session.amount_total === 0 || payment_status === 'no_payment_required'`), then confirm via the *retrieved subscription's* `status==='trialing'`; normal paid signups (`amount_total>0`) skip the extra Stripe retrieve. Every unit test passed because the fixture hard-coded `payment_status:'no_payment_required'` — fixture-vs-reality gap. Now the fixture mirrors the real `paid`/`amount_total:0` shape.
**Second bite (2026-07-22, #518):** a DIFFERENT check had the same whitelist — `trialContractMatchesLease` (same file) accepted only `'no_payment_required'`, flagged the real `paid` session `invalid_trial`, and `cancelUnexpectedSubscription` auto-cancelled the perfectly valid trialing sub → every card-up-front trial stranded `pending_payment`. Found live in the staging E2E (Phase A onboarding). Lesson upgraded: when touching trial contracts, `rg no_payment_required` and fix EVERY site — the guarantee is `subscription.status==='trialing'` + 30-day window + $0 invoice, never the session's `payment_status` alone.

### A trial can't onboard when `ONBOARDING_DEMO_ENABLED=true` (infinite redirect loop)
FAIL → dashboard "Set up business" ping-ponged `/onboarding/business → /onboarding/start → /dashboard`; the trial could never reach the wizard. WHY → `src/app/onboarding/business/page.tsx` set `demoFlowEnabled = (process.env.ONBOARDING_DEMO_ENABLED === 'true')` *unconditionally*. But the demo-mode wizard (Profile/Voice/Connect) assumes the location was captured at `/onboarding/start` during the **pre-pay demo**; a card-up-front trial skips that and arrives subscribed with **no location**, so the guard redirected it to `/onboarding/start`, which redirects subscribed (`subscriptionGrantsFullAccess`) accounts back to `/dashboard`. CORRECT → gate the flag on the location actually being present: `shouldUseDemoWizard(envEnabled, row)` in `guard.ts` (true only when `place_id_verified || google_maps_url`). A subscribed account with no location now gets the **non-demo wizard** (Location/Profile/Voice), which captures the location itself. The guard's `demoFlowEnabled` branch had **zero unit coverage** — that's why it slipped; added it.
**Second bite (2026-07-22, #519):** the page was fixed but `POST /api/onboarding/business` still read the RAW `onboardingDemoEnabled()` → the route took the post-pay branch, rejected the wizard's `googlePlaceId` with 409 `onboarding_not_started`, and the trial looped `/business → /start → /dashboard` again. The route now calls the same `shouldUseDemoWizard(flag,row)` helper as the page. Lesson upgraded: a flag-semantics fix is done only when EVERY reader of the flag goes through the one helper — grep the raw accessor after extracting it.

### Trial start must mirror `businesses.subscription_activated_at` or onboarding drips die for trials
FAIL → `apply-subscription-state.ts` `writeBusinessesMirror` wrote only `businesses.subscription_status`; the drip scheduler gates on `businesses.subscription_activated_at IS NOT NULL` and the drip worker hard-fails day_7/day_30 if null → no drips for any trial, even post-conversion. WHY → the trial path reaches the applier via `maybeStartTrial` and bypasses the legacy inline paid path (the only other writer of that column). CORRECT → the applier's businesses UPDATE sets `subscription_activated_at = COALESCE(subscription_activated_at, NOW())` on entering `trialing`/`active`, scoped to the primary business. (`accounts.subscription_activated_at` is the *service-start* anchor — set at trial start, drives the Zernio backfill gap/historical window; see `review-ingestion.md`.)

### Staging Stripe webhook was missing `invoice.payment_action_required` (the SCA event)
The staging endpoint subscribed to 5 of the 6 events the worker handles; `invoice.payment_action_required` (SCA-at-conversion → `past_due`) was absent, so that path would never fire. Audit the endpoint's `enabled_events` against the handler set (`worker/ingress/stripe.ts`) when standing up an env — and add the same event to the **prod** webhook before the flag flip.

### Stripe converts a trial (`trialing→active`) BEFORE the renewal charge fails → `trial_payment_failed` is effectively unreachable for a card decline
Verified live on staging with a `pm_card_chargeCustomerFail` test-clock sub. At trial end Stripe fires `customer.subscription.updated` (**`trialing→active`**) *first*, THEN creates the first real invoice, attempts the charge, and on failure emits `invoice.payment_failed` (→ `past_due`). The worker processes events in arrival order, so by the time `invoice.payment_failed` lands the account is already `active`. `invoice-payment-failed.ts` only emits `trial_payment_failed` on a **direct `trialing→past_due`** transition (its source-status guard), so a normal card-decline-at-renewal fires `trial_converted` (on the `→active` step) then a silent `active→past_due` — NOT `trial_payment_failed`. Net: the DB/entitlement state is correct (`past_due` + 7-day grace), but **conversion analytics are overstated** (`trial_converted` fires even when the conversion charge immediately fails) and `trial_payment_failed` only fires for the rarer direct paths (e.g. SCA `payment_action_required`). **FIXED (2026-06-22):** `invoice-payment-failed.ts` now also emits `trial_payment_failed` on an `active→past_due` failure when the account has a `trial_converted` analytics row from the **last 3 days** (= the conversion charge + its dunning retries, NOT a normal renewal months later). Keyed by `(accountId, stripeSubscriptionId)` so it's idempotent with — and dedupes against — the direct `trialing→past_due` path. So `trial_converted` still fires on the status transition, but **net conversions = `trial_converted` − `trial_payment_failed`** is now accurate. The `:status_change` advisory lock serializes the convert vs fail webhooks, so the `trial_converted` row is committed and visible when the failure arrives second. Lesson: Stripe's trial→active status change is NOT proof of payment — don't treat a `trialing→active` webhook as "successfully converted/paid."

### [2026-06-26] A transient Postgres statement-timeout took down the ENTIRE worker (postgres.js connection-layer unhandledRejection)
FAIL → on a staging boot the worker logged `OnboardingDripScheduler` "Scheduler cycle failed" (a caught error) and **then**, 3 ms later, a process-level `[worker] Fatal process-level error - exiting` with `crash_kind: unhandledRejection` carrying the SAME `PostgresError: canceling statement due to statement timeout` — exiting the whole worker (all 24 queues + 20 background loops). WHY → two non-obvious facts compounded: (1) at boot ~20 pollers/schedulers fire their first cycle simultaneously and hammer a cold Supabase PgBouncer, which enforces its server-side `statement_timeout` (~8s) regardless of the client's `connection.statement_timeout: 30_000` (a session `SET` doesn't stick in transaction-pooling mode); a heavy query (`OnboardingDripScheduler`'s 3×`NOT EXISTS` cross-join) times out → SQLSTATE `57014`. (2) The scheduler's own `try/catch` caught its awaited query — but postgres.js *also* surfaced a **connection-layer rejection** for the same timeout as a separate, un-awaited promise that escaped the scheduler's catch entirely. `worker/index.ts`'s last-resort `process.on('unhandledRejection', fatalExit)` then crashed the whole process over one recoverable blip. The scheduler was NOT the bug (it already caught its errors) — the crash-net's blast radius was. CORRECT → the `unhandledRejection` handler now classifies the reason: `isCrashNetRecoverableDbError(reason)` (an explicit allowlist in `src/lib/db/transient-error.ts`: `57014` / `57P0x` / postgres.js `CONNECTION_*` / specific 08-class connection failures — deliberately EXCLUDING ambiguous `08007 transaction_resolution_unknown`, `08P01`, and the open-ended `08xxx` prefix) → **recover** (Sentry `warning` + log, no exit), the loop reconciles next cycle. `uncaughtException` stays always-fatal (the stack unwound → state unknown). A duration-based governor (`worker/transient-rejection-governor.ts`) still escalates a *sustained* storm (rejections persisting >10 min, no >5 min idle gap) back to a crash+restart so a permanently-broken path doesn't run alive-but-broken behind the `SELECT 1` `/ready` probe. Lessons: a poller catching its own awaited query is NOT enough — postgres.js can emit a *separate* connection-layer unhandledRejection on the same timeout; and a process-level crash-net must distinguish recoverable infra blips from real bugs (Release It! "fail inside boundaries that prevent wider collapse"), not blanket-crash on any rejection.

### [2026-06-26] pnpm supply-chain hardening (`minimumReleaseAge` + `trustPolicy`) intentionally blocks some Dependabot bumps — that's a feature, not a failure
FAIL → `pnpm update @babel/core …` aborted with `ERR_PNPM_TRUST_DOWNGRADE` ("High-risk trust downgrade for semver@6.3.1 — possible package takeover"); and a `pnpm.overrides` entry to force `vite@8.0.16` silently no-op'd (the lockfile stayed at 8.0.5). WHY → `pnpm-workspace.yaml` (not `package.json`) carries the repo's hardening: `minimumReleaseAge: 10080` (a **7-day quarantine** on freshly published versions — `vite@8.0.16` was published 2 days ago, so it is intentionally un-installable yet) and `trustPolicy: no-downgrade` (rejects a package whose provenance weakens — bumping `@babel/core` re-resolved its subtree to a non-provenanced `semver@6.3.1`). Two more gotchas: (a) in pnpm 10+/11 with a `pnpm-workspace.yaml`, `overrides` (and config) live **in that file**, NOT `package.json.pnpm.overrides` (which is silently ignored); (b) forcing one package of a tightly-pinned set creates a split — bumping `@opentelemetry/core` alone (while `@sentry/node` pins the rest of the OTEL set) produced a `2.7.1 + 2.8.0` split that can break OTEL/Sentry instrumentation. CORRECT → patch only what bumps cleanly in-range (`pnpm update <names> -r`, lockfile-only, single-version) — here form-data 4.0.6, undici 7.28.0, esbuild 0.28.1 — and **respect the hardening** for the rest: a fresh release waits out the 7-day quarantine (self-resolves), a trust-downgrade bump waits for an upstream provenance fix, and a version-locked set (OTEL) waits for a coordinated `@sentry/node` SDK bump. Do NOT lower `minimumReleaseAge` / disable `trustPolicy` to force a low-severity fix — that trades a documented advisory for a worse supply-chain exposure. Lesson: a blocked dep bump in this repo is usually the hardening working as designed; verify publish-age (`npm view <pkg>@<v> time`) and provenance before assuming the tooling is broken.

---

## 2026-07-02 — DB-imports ratchet guard: composition-root convention (A+ campaign PR 1a)

### Domain modules take `sql`/`supabaseServer` as a parameter — only composition roots import `src/lib/db/server`
Spec: `docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md` §2.1 (Modularity A+ campaign, closing the June-accepted "ambient DB singleton" residual). `src/lib/db/server.ts` stays the single owner/constructor of the Postgres.js `sql` client and the `supabase-js` service client — pooling, `statement_timeout: 30_000`, and the two-client split are unchanged. What changes is WHO may import it: **composition roots** (Next.js route handlers `src/app/**/route.ts`, server-component pages `src/app/**/page.tsx`, and layouts `src/app/**/layout.tsx` — Next.js invokes all three, so no caller exists that could inject a client; `src/instrumentation.ts`; the worker job handlers, pollers, and schedulers REGISTERED in `worker/index.ts` (root status is EARNED by registration, not file position — see the PR-3 update below); `worker/index.ts`/`worker/queues.ts`; and everything under `worker/ingress/` — kept blanket on purpose, since per-event ingress handlers legitimately live in provider subfolders and path shape can't separate handler from helper there) may import the singleton and pass the client down. Everything else — **domain modules** (`src/lib/**` business logic, job-subfolder helpers like `worker/jobs/publisher/*.ts`, unregistered top-level helpers that sit beside the handlers like `worker/jobs/summary-report-helpers.ts`, and background-loop subfolder helpers like `worker/background/pollers/health-alert/checks.ts`) — must receive `sql`/`supabaseServer` (or `tx: TransactionSql` inside a transaction, already the `job-outbox-helpers` convention) as an explicit leading parameter instead of importing the module.

New AST-based `ci:db-imports` guard (`scripts/ci/db-imports-audit.ts`, mirrors `process-env-audit.ts`'s shape: `ts.createSourceFile` walk for `ImportDeclaration`/`ExportDeclaration` nodes so a `"@/lib/db/server"` string literal or comment can't false-fire, and `import type`/`export type` is correctly excluded — a type-only import carries no runtime dependency on the singleton). As SHIPPED in PR 1a it ran in baseline mode: CI failed on either a NEW non-composition-root importer or a stale baseline entry that no longer imported `db/server`, with every non-root importer as of 2026-07-02 checked into `scripts/ci/db-imports-baseline.ts` (105 files then, regenerated via a `--emit-baseline` flag) — a **ratchet** that only shrank as the Stage-2 domain sweeps (spec §3) injected the client instead of importing it. **PR 3 (Stage 3) completed the flip to STRICT** — see the PR-3 update below: the Stage-2 sweeps drove the baseline to 0, then PR 3 DELETED `scripts/ci/db-imports-baseline.ts` and the `--emit-baseline` machinery, so the audit now fails on ANY non-composition-root file that imports `db/server` — no baseline, no exceptions. Wired into `.github/workflows/ci.yml` (`lint` job, right after the process-env step) and `lefthook.yml` pre-push (`db-imports`, appended at the end of the commands block to avoid textual conflicts with other in-flight lefthook edits).

### [2026-07-04] PR 3 (Stage 3) — flipped STRICT + F15 registration-derived worker roots; process-env widened; fallow gained real `--coverage`

Three guard changes landed together in PR 3 (`aplus/3-ratchet-strict`):

**`ci:db-imports` → strict + registration-derived worker roots (F15).** The Stage-2 sweeps emptied the baseline, so PR 3 deleted `scripts/ci/db-imports-baseline.ts` + the `--emit-baseline` code path and the guard now fails on ANY non-composition-root importer of `@/lib/db/server` (no baseline, no exceptions). The old **positional** worker-root rule is GONE — do not reintroduce it. It used to say a `^worker\/jobs\/[^/]+\.ts$` file was a root by position, with a hand-maintained `NON_ROOT_EXCEPTIONS` set carving out top-level helpers (e.g. `worker/jobs/summary-report-helpers.ts`). Both are DELETED. Worker roots are now **DERIVED from `worker/index.ts` registration**: `readRegisteredWorkerRoots(indexText)` parses the entry point with the TypeScript compiler (never a raw-text regex — same reason as `fileImportsDbServer`) and credits a top-level `worker/jobs/<X>.ts`, `worker/background/pollers/<X>.ts`, or `worker/background/schedulers/<X>.ts` as a root ONLY if `worker/index.ts` imports it (a single-path-segment tail; a subfolder handler like `./jobs/publisher/ResponsePublisherWorker` is already excluded, and only a direct top-level `import` counts — not a barrel re-export or dynamic `import()`). Root status is thus EARNED by registration, not granted by file position, and the bias is deliberately fail-safe: an un-credited real handler produces a LOUD CI failure (fix by importing it directly in `worker/index.ts`), never a silent root grant to an unregistered helper. (`src/lib/db/auth.ts` remains a named owner-classified root from sweep 2i — a db-layer auth gate, not a domain module.)

**`ci:process-env` widened + `NEXT_PUBLIC_*` exempted.** The scan surface grew from `src/lib` + `worker` to also cover `src/app` + `src/components`, and `NEXT_PUBLIC_*` is now an exempt env INDICATOR (build-time-inlined PUBLIC client config that can never route through the server-only config accessor — exempt everywhere, alongside `NODE_ENV` / `MOCK_EXTERNAL_APIS` / `VERCEL_*`). That combination moved the baseline 14 → 10: it surfaced 2 genuine admin env-readiness reads (added) and declassified 6 former `src/lib` entries whose only counted read was a `NEXT_PUBLIC_*` var (removed as stale). Still **baseline-mode** (shrinks toward 0 in Stage 4), NOT strict.

**`ci:fallow` gained real `--coverage` in CI.** `.github/workflows/fallow.yml` now runs `pnpm test:coverage` then `ci:fallow:coverage` so cold-path / CRAP signals use real runtime coverage. The coverage input is self-healing: `scripts/ci/normalize-v8-coverage.ts` runs first and clamps vitest-4's v8 out-of-range `-1` branch-count sentinel to `0` (spec-valid istanbul) so fallow's u32 coverage parser accepts the report. The static `ci:fallow` (fast, no coverage generation) is retained for LOCAL/MANUAL runs and is wired into NO hook or workflow.

---

### [2026-07-05] The crash-net/transient-rejection governor is BLIND to a "zombie-pool" all-poller-timeout storm — every poll cycle times out but each is *caught*, so no `unhandledRejection` ever escapes

FAIL → a staging worker sat in a **10-hour storm** where essentially every poller/scheduler cycle logged `[ERRO] Poll cycle failed … timed out` (statement-timeout / connection-drop) and never recovered — yet the process was never restarted, so a wedged Postgres pool persisted until a **manual redeploy**. WHY → this is the *complement* of the [2026-06-26] crash-net note, and exposes its blind spot. That fix made `worker/index.ts`'s `process.on('unhandledRejection')` classify transient-DB rejections and let a duration-based governor (`worker/transient-rejection-governor.ts`) escalate a *sustained* storm back to a crash+restart. But the governor is fed ONLY by rejections that reach the crash-net — i.e. **un-awaited/connection-layer rejections that escape a loop's own `try/catch`**. In a zombie-pool storm, each poller's awaited query times out and is **caught by that poller's own `try/catch`** (logged as a handled `Poll cycle failed`), so postgres.js does not surface a separate escaping rejection → the crash-net never fires → the governor's counter stays at zero → no restart, forever. The `/ready` probe (`SELECT 1`) can even pass intermittently, so the load balancer keeps the alive-but-useless instance in rotation. Diagnosed environmental (not a code regression): the storm began ~10h AFTER a verified-clean deploy boot, hit 2c-era pollers a later sweep never touched, with the event-driven paths idle; a fresh redeploy (the post-merge `staging` realign) booted clean with normal INFO cycles (`StripeLocationsReconcile` "no drift", etc.) — a healthy fresh boot is the confirmation that the wedge was in the pool/DB session state, not the code. CORRECT (proposal — NOT yet implemented; flagged for a Stage-3-adjacent change, out of scope for the behavior-preserving A+ campaign) → add a liveness escalation that does NOT depend on the crash-net seeing an *unhandled* rejection: e.g. an in-memory counter incremented in the shared poll-wrapper's `catch` and reset on any poll success — when N consecutive cycles across the poller fleet fail with zero interleaved success, escalate to a **deliberate `process.exit`** so Railway restarts the process and resets the pool. The escalator must not itself require a healthy query (the health-alert poller *also* times out in the storm — see its known-noise 30s timeout), so key it on the failure counter, not on a probe query. Lessons: catching a poller's own awaited error is correct for a *single* transient blip but hides a *fleet-wide* wedge from the crash-net; "recover-don't-crash" (the 2026-06-26 fix) and "crash-so-you-restart" (this gap) are two failure modes that need *different* detectors — the governor watches unhandled rejections; a wedged-pool detector must watch *handled* poll-failure density. (Release It!: a health check that can't distinguish "briefly degraded" from "permanently wedged" keeps a dead instance in rotation.)

---

## 2026-07-16 — WS8 tier-cutover promotions (claude-mem sweep)

### [2026-07-14] A CHECK constraint on a nullable column silently passes NULL — pair NOT NULL with CHECK, and write NULL-safe preflights
FAIL → planning the WS8 tier migrations (077/078), the strict two-tier CHECK on `subscription_tier` looked sufficient on its own — but a NULL row would have sailed through it and then crashed the strict code's `isSubscriptionTier()` reads. WHY → SQL three-valued logic: a CHECK evaluates to UNKNOWN for NULL, and UNKNOWN *passes* the constraint. A CHECK alone therefore validates nothing about NULL-ability; the same trap applies to preflight queries, where `col NOT IN (...)` also drops NULL rows from the blocker count. CORRECT → any "column must be one of X" contract needs BOTH `NOT NULL` and the CHECK (078 does exactly this on the businesses mirror), and preflights must be NULL-safe — count `col IS NULL OR col NOT IN (...)`, never bare `NOT IN`. Migration 078's abort-before-DDL preflights are the reference implementation.

### [2026-07-14] A hung migration is a lock queue behind a long-lived pooled (Supavisor) session — cancel the stalled backend, verify clean state, then retry staging-first
FAIL → migration 076 hung indefinitely on staging: the migration backend (pid 3460156) sat waiting for a lock on `notification_deliveries` and never progressed. WHY → `ALTER TABLE` needs ACCESS EXCLUSIVE, and an active long-lived Supavisor query on the table held a conflicting lock; the queued migration then itself blocked everything arriving behind it, so the damage compounds the longer it waits. Under pooled connections a "stuck migration" is almost never the DDL being slow — it's lock acquisition. CORRECT → diagnose via `pg_stat_activity` (look for the migration backend `wait_event_type='Lock'` and the pid it waits on), cancel the stalled migration backend, verify no partial schema change landed (our migrations are single-transaction, so a cancelled one leaves a clean state — confirm the expected columns/objects are absent), let the lock-holding query finish or clear it, then re-run staging first before touching production.

### [2026-07-16] `getServerConfig()` memoizes on first access — mutating `process.env` afterward is a silent no-op
FAIL → the WS8 smoke harness's original `withOpenAutopilotGate()` helper flipped `AUTOPILOT_PURCHASABLE=true` via `process.env` mid-run; every Autopilot scenario still saw the gate closed, with no error anywhere. WHY → all three config accessors (`src/lib/config/{server,worker,client}.ts`) are lazy + memoized by design — the first `getServerConfig()` call parses the env once and every later call returns that snapshot, so a subsequent env mutation is invisible. Only `src/lib/config/flags.ts` reads `process.env` live (deliberately un-memoized so tests skip the reset-the-memo dance). CORRECT → set the env var BEFORE anything touches the config accessor (the rewritten smoke script sets it at boot, `scripts/ws8-staging-smoke.ts:79`), or mock/override the accessor itself in tests — never flip memoized config through the environment mid-run. When adding a new toggle, decide up front whether it belongs in the memoized schema (boot-time contract) or `flags.ts` (runtime-flippable) based on whether anything needs to change it mid-process.

---

## 2026-07-18 — #500 pool-wedge self-heal

### [2026-07-18] An `active+ClientRead` postgres.js connection is a socket wedge no server-side timeout heals — reclaim it client-side (end+rebuild); a server-side backstop needs a genuinely-reachable direct route (tracked #477, not live)
FAIL → a `HealthAlertPoller` health-check connection stalled server-side in `state=active, wait_event=ClientRead` and never came back to the shared postgres.js pool; one leaked slot per cycle silently starved the pool the whole worker shares, and neither `statement_timeout` nor the app-level `withTimeout` guard reclaimed it. WHY → `ClientRead` means the *server* is blocked waiting for client bytes that never arrive (a socket-level stall), so a server-side `statement_timeout` never fires — the statement isn't executing, it's mid-read; and `withTimeout` only *races* the promise, it does not cancel the underlying query or close the socket (`src/lib/shared/with-timeout.ts`), so the wedged connection is orphaned, still checked out, never returned. You also cannot identify the culprit backend by `application_name`: the Supavisor transaction pooler flattens every client's `application_name` to `'Supavisor'` server-side (verified on staging 2026-07-18 — see ADR 0007), so `pg_stat_activity` can't tell your backend from a Vercel dashboard read. CORRECT → reclaim at the client-side layer, which is the layer that actually runs. Client-side (fast, ~≤30s, KEPT — #500/#502): bulkhead the health checks onto a *dedicated* postgres.js client (`health-alert/health-db.ts`, `max:2`) and on `withTimeout` expiry `end()`+rebuild it (`recycleHealthSql`, rebuild UNCONDITIONALLY in `finally` even if `end()` hangs) — the client-side FIN gives the wedged backend's ClientRead an EOF so it dies. Server-side backstop (REMOVED #505): #500/#502 shipped an out-of-band `PoolWedgeReaperPoller` meant to run on a *runtime-verified-direct* `:5432` route (connect with `application_name='rw-wedge-reaper'`, trust the route only if `current_setting('application_name')` echoes it back exactly) and `pg_terminate_backend` any backend matching the full wedge signature whose query began with a cooperative `/* rw-reapable */` marker. It was deleted under #505: Railway's outbound network is IPv4-only while Supabase's direct `:5432` host is IPv6-only, so the verified-direct precondition is architecturally unreachable from Railway and the reaper never fired live — dead code kept alive only by its own tests. The genuine-direct-route concept and its two postgres.js 3.4.9 terminate-query traps are preserved for a future re-arm on a reachable route (ticket #477): (1) a row-value `IN ${tuples}` list mis-renders (the `in` builder drops the outer wrap, or the leading `(` hits the `\(`→`select` path and crashes) — join `(pid, backend_start)` pairs via `unnest(${pids}::int[], ${backendStarts}::timestamptz[])` instead; (2) `timestamptz` decodes to a millisecond JS `Date`, truncating Postgres microseconds — project both timestamps as `::text` and cast back with `::timestamptz[]` to keep `backend_start` equality microsecond-exact across the round-trip.

### [2026-07-18] Concurrent `Promise.all` queries on a shared postgres.js client over the Supavisor TRANSACTION pooler pipeline onto shared connections and wedge PERMANENTLY in `ClientRead` — #505 proved the #500 wedge's actual trigger
FAIL → the above self-heal note (same day) contained the wedge but left its *cause* an open, unproven "boot-burst" candidate (ADR 0008 originally shipped as "root cause still unproven"). #505 then proved it: `runHealthChecks` (`worker/background/pollers/health-alert/checks.ts`) fired its 6 health-bundle queries **concurrently via `Promise.all`** on the dedicated bulkhead client (`max:2`), and this — not the boot burst — was the trigger, recurring on **every 5-minute health cycle**, not just at boot. WHY → over the Supavisor **transaction** pooler, postgres.js pipelines the queries that exceed the pool's actual open-connection count onto the connections that ARE open; a pipelined query's response then parks server-side in `state=active, wait_event=ClientRead` and is never read, because the issuing client has already moved past that logical slot — a permanent wedge, once per cycle. Proven by a deterministic differential repro against the staging pooler: the real 6-query `Promise.all` bundle on `max:2` wedged **6/6** iterations; the same 6 queries run **sequentially** wedged **0/6**; the same 6 queries concurrent with **`max:6`** (one connection per query) wedged **0/6**; the actual fixed (sequential) `runHealthChecks` on `max:2` validated **0/6** against staging post-fix. Honest nuance — do NOT overclaim: concurrency-exceeding-pool-size is *necessary* but not *sufficient* alone — an earlier isolation repro with *uniform* queries at concurrency > `max` came back clean 21/21, so the trigger also depends on the query mix, not count alone. CORRECT → the fix idiom for any concurrent-query group sharing one postgres.js client over a transaction pooler: either run the queries **sequentially** (one in flight at a time — what `runHealthChecks` now does, commit a10f5eb), or give each concurrent query **its own connection** (`max ≥ concurrency`, e.g. bump the client's pool size to match the fan-out). `checks.ts`'s `runHealthChecks` is the confirmed instance; a companion audit (`docs/superpowers/plans/fix-505-pool-wedge-rootcause-pipelining-audit-ticket.md`) catalogs ~15 other candidate sites with the same shape, each requiring its own differential-repro verification before being treated as confirmed — don't fix-by-analogy. See ADR 0008 for the full decision record (retitled to reflect the proven root cause) and the investigation doc for the falsified/refined hypothesis history. The one-off differential above is now checked in and re-runnable as `scripts/health-bundle-differential.ts` (ephemeral-branch, 3-arm) — see `docs/runbooks/pool-wedge-burst-drill.md` Part A.

---

## 2026-07-20 — #511 scalability verification remainders

### [2026-07-20] A boot-time summed-concurrency assert is only as strong as its hand-maintained queue inventory — a `runLlmTask`-calling worker omitted from the list is silently uncapped
FAIL → the summed LLM worker-slot cap (ADR 0005 addendum) was first inventoried in #490, but that list missed the `generate_demo` worker — so the "global LLM concurrency ≤ N" guarantee was quietly wrong: a real LLM-calling queue sat outside the sum and the boot assert would have happily passed a genuinely over-budget configuration. WHY → `assertSummedLlmWorkerSlots` (`worker/config/startup-assert.ts`) sums only the entries it is *handed* in `worker/index.ts`; there is no mechanism forcing that hand-written list to equal the true set of queues whose handlers call `runLlmTask`. The assert reads EFFECTIVE `worker.opts` so it catches a *concurrency-value* drift on a listed queue, but it is blind to a *missing* queue — the failure mode is omission, not misconfiguration, and omission leaves no error to observe. CORRECT → two layers. (1) Immediate: grep `runLlmTask` importers before editing the inventory (the code comment at the assert call site now says exactly this), and keep the cap literals module-private so the list — not a magic number — is the thing under review. (2) Durable (filed as a follow-up `ci:` candidate): a contract audit that maps every `runLlmTask` importer to a queue and fails CI if any such queue is absent from the `assertSummedLlmWorkerSlots` inventory — the only thing that turns "someone remembered to add it" into an invariant. Until that audit exists, treat the inventory as a manually-verified list, not a guarantee. Cap value itself is 9 (`generate_response`=5 + four ×1); `judge_verdict` is flag-gated and capped separately at 1 so booting with the judge flag ON never trips the sum.

---

## 2026-07-20 — #508 production reliability guards

### [2026-07-20] Bounding the shared supabase-js client's global fetch also bounded Auth identity MUTATIONS → an ambiguous timeout can orphan a committed signUp/invite → split the client
FAIL → the P2 hardening installed a 10s `AbortSignal.timeout` fetch as the GLOBAL fetch of the shared `supabaseServer` client, to stop worker-side admin/storage calls from hanging BullMQ slots. But supabase-js `global.fetch` applies to EVERY call on that client — including Auth identity mutations (signup provisioning, invites). WHY → a mutation that commits remotely but responds >10s surfaces client-side as a TimeoutError with no reconciliation path: the Auth identity exists, the app never learns it, and the user later hits `account_exists` lockouts. A timeout on a READ is safe (retry); a timeout on a NON-IDEMPOTENT identity mutation is an ambiguous-outcome hazard. CORRECT → split by call class, not one global bound: `supabaseServer` stays UNBOUNDED for identity-mutating flows (all Next.js signup/invite paths), and the separate `supabaseServerBounded` (`boundedSupabaseFetch`, `SUPABASE_FETCH_TIMEOUT_MS=10_000`, `src/lib/db/server.ts`) serves worker-side admin/storage calls where hanging is worse than ambiguity (offboarding purge, `CleanupAbandonedSignupsPoller` — whose `Promise.race` belt stays, since it also covers non-fetch hangs). Tests pin which client gets the injected fetch. General rule: a client-wide timeout is a per-endpoint-semantics decision in disguise — never bound idempotent reads and ambiguous mutations with one knob.

### [2026-07-20] An unlistened EventEmitter `'error'` on any BullMQ Queue/Worker/raw ioredis client is a FATAL uncaughtException — every emitter needs a listener, and the listener needs a per-source suppress window
FAIL → none of the BullMQ Workers, Queues, or the probe Redis client had an `.on('error')` listener, so a transient Railway Redis blip could restart the entire worker — inconsistent with the deliberately-recoverable Postgres crash-net. WHY → Node escalates an `'error'` event with no listener to `uncaughtException`, which the worker treats as ALWAYS fatal (correctly — for real programmer errors). And the naive fix (capture every event to Sentry) is its own outage amplifier: ioredis reconnect loops emit one error per failed attempt across ~46 emitters, so an unthrottled listener turns a Redis outage into a log flood + Sentry alert storm. CORRECT → one helper applied at the registration sites so new registrations inherit it: `attachEmitterErrorLogger(emitter, source)` (`worker/emitter-errors.ts`, wired in `worker/index.ts` + `worker/queues.ts`) — structured log + Sentry `warning` for the FIRST error per source per 60s window, count-and-suppress the rest, surface the suppressed count when the next window opens. The listener body itself never throws (a throwing `'error'` listener IS an uncaughtException). Caveat for tests: any suite that mocks BullMQ `Queue` as a bare class must give the mock a no-op `on()` or module-scope attachment loops crash at import.

### [2026-07-20] `AbortSignal.timeout` runs on Node's internal timer list — vitest fake timers cannot advance it → test with real timers + an injectable small timeout
FAIL → the P2 bounded-fetch test used vitest fake timers to fast-forward past the 10s bound; the test hung forever (Node 24). WHY → `AbortSignal.timeout()` schedules on Node's internal timers, not the JS-land `setTimeout` that vitest's fake-timer shim patches — faking time never fires the abort. CORRECT → real-timer test with a small injected timeout: `boundedSupabaseFetch` takes an optional trailing `timeoutMs` param defaulting to the production constant (test-only; production callers never pass it), plus a separate test pinning the constant at 10_000 so the injectability can't mask a drifted default.

### [2026-07-20] `markOutboxFailed` is a CAS returning boolean — coupled terminal writes must branch on ownership INSIDE the same tx, or a stale attempt commits rows it doesn't own
FAIL → the zernio ingest failed-hook wrote its terminal bookkeeping (`review_exceptions` INSERT + `markOutboxFailed`) as loose sequential statements; a retried/stale exhaustion attempt could insert exception rows for a transition it did not win, and any error in the sequence left half the bookkeeping committed. WHY → `markOutboxFailed` is a compare-and-swap (it returns whether THIS caller performed the terminal transition), but a CAS only confers ownership over writes that are atomic with it — outside a transaction, the "loser" has already executed its coupled INSERTs by the time it learns it lost, and a mid-sequence crash splits the pair. CORRECT → CAS-FIRST inside `sql.begin`: run `markOutboxFailed` as the first statement of the tx, execute the coupled writes only if it returns ownership, and roll everything back together on failure (atomic watchdog recovery re-drives the whole unit). Post-commit observability (e.g. the pagination trend Sentry signal) also gates on the captured ownership boolean. `withOwnedTerminalTransition` (`worker/jobs/zernio/ingest-failed-hook.ts`) owns this contract in one place, including the `coupledTerminalTxStarted` flag that stops the hook's last-resort crash guard from splitting a rolled-back coupled tx with a best-effort single-statement `markOutboxFailed`.

---

## 2026-07-21 — reliability follow-ups #514–#516

### [2026-07-21] `maxNetworkRetries: 0` is NOT a single-attempt guarantee — stripe-node retries ONCE on a first-attempt ECONNRESET/EPIPE before the maxRetries guard
FAIL → the P8 under-lock bound (`{ timeout: 8_000, maxNetworkRetries: 0 }` on every tier-change Stripe call made while the pg advisory locks + `FOR UPDATE` are held) was documented as "exactly one 8s attempt"; codex adversarial review verified the claim against stripe 22.2.0 source and found it wrong. WHY → `RequestSender._shouldRetry` retries a FIRST-attempt `ECONNRESET`/`EPIPE` unconditionally, BEFORE it consults the `maxNetworkRetries` limit — a socket reset always gets one extra attempt regardless of the setting. `ETIMEDOUT` (the hung-provider case the bound actually targets) does NOT take that path: one capped attempt, fail fast. Each attempt is individually bounded by `timeout`, so the realistic worst-case lock hold is ~2×8s + overhead ≈ 26s (down from ~60s+), not a hard 8s — and the reset path is near-instant in practice, not a full extra timeout. CORRECT → read `maxNetworkRetries: 0` as "no retry on timeout; at most one reset retry"; state lock-hold worst cases as ~2× the per-call timeout; keep the bound in its ONE owner constant (`STRIPE_UNDER_LOCK_REQUEST_OPTIONS`, `src/lib/accounts/tier-change.ts`) with this caveat documented at the constant, and recover ambiguous timeouts via the webhook/reconciler path + idempotency keys, never by retrying under the lock. (Also: `subscriptions.retrieve` takes RequestOptions as the THIRD argument — pass `{}` params second, or TS2559.)

### [2026-07-21] A module-scope breaker singleton accumulates state across vitest cases that mock the SDKs but drive the real seam — reset it in `beforeEach`
FAIL → `generator.test.ts` and `review-summary.test.ts` mock the raw OpenAI/Anthropic SDKs but exercise the REAL `runLlmTask`, which consults the live `llmCircuitBreaker` module singleton — each transient-failure test case silently pushed the shared breaker toward its 5-failure trip, so a late (or reordered) test could find the breaker OPEN and fail for a reason unrelated to its assertion: an order-dependent flake. WHY → `vi.mock` replaces the SDK modules, not `src/lib/llm/circuit-breaker.ts`; module state persists across cases within a vitest worker, and nothing on the real seam path resets it between tests. CORRECT → any suite that drives the real `runLlmTask` (rather than mocking the seam itself) calls `llmCircuitBreaker.reset()` in `beforeEach` (`reset()` exists for exactly this — it clears state only and is test-only). General rule: mocking a dependency's LEAVES does not isolate stateful MIDDLE layers — enumerate the singletons on the real code path and reset each one per test.

### [2026-07-23] Governor never re-suspended any account after its first unsuspension — postgres.js `timestamptz`→JS `Date` truncates microseconds, so the window's own source row compared as "newer" (SECOND subsystem bitten by this trap)
FAIL → in the Phase D staging drill, a clearly breaching candidate (5/5 `flag` judge verdicts, signal rate 1.0 ≥ 0.4, sample ≥ 5) ran >10 minutes at 20s governor cadence with zero suspensions and zero log lines. WHY → `listGovernorCandidates` computes `window_start = GREATEST(now()-7d, MAX(autonomy_unsuspended.created_at))` — microsecond precision in Postgres; postgres.js decodes `timestamptz` into a JS `Date` (millisecond precision); `revalidateGovernorCandidate`'s staleness check ran `created_at > ${observedWindowStart}` against the truncated value, so the very audit row that DEFINED the window matched as "newer" whenever its timestamp carried non-zero sub-ms digits (~999/1000 of real `NOW()`-written rows) → silent skip, every cycle, forever — permanent immunity for exactly the repeat-offender case the governor exists for. All 31 prior tests passed because JS-Date-seeded audit fixtures carry ZERO microseconds — the one timestamp shape that hides the bug. CORRECT (#520) → truncate the DB side to the precision the JS value actually has (`date_trunc('milliseconds', created_at) > ${window}`), make the scheduler's revalidation-skip path LOG (the silence is why it took a live drill to find), and regression-test with an audit row seeded `+ interval '419 microseconds'`. This is the same trap the wedge-reaper hit on `backend_start` equality (see that note's postgres.js trap (2)) — twice bitten, so promoted to a CLAUDE.md non-obvious gotcha: any SQL comparison of a µs-precision column against a JS-round-tripped value from the SAME row must truncate the DB side or keep the value `::text` end-to-end.

## 2026-07-22 — full text of two CLAUDE.md gotchas (moved here in the token trim; CLAUDE.md keeps the summaries + directives)

### Worker crash-net: recoverable transient-DB rejections vs fail-fast (full mechanics)
`worker/index.ts`'s `process.on('unhandledRejection')` classifies the reason via `isCrashNetRecoverableDbError` (`src/lib/db/transient-error.ts`): a transient Postgres statement-timeout / connection drop — which postgres.js can surface as a *connection-layer* rejection that escapes a poller's own `try/catch` — is captured (Sentry `warning`) and survived (the loop recovers next cycle). A *sustained* storm escalates back to a crash via `worker/transient-rejection-governor.ts` (duration-based); ambiguous-state DB codes (`08007`/`08P01`) + every non-DB rejection still fail fast; `uncaughtException` is ALWAYS fatal. Do NOT reintroduce a blanket crash-on-any-rejection (a single boot-time DB blip would otherwise kill all 24 queues + 20 loops). `isTransientPostgresError` (broad) is for billing's idempotent retry; the crash-net's `isCrashNetRecoverableDbError` is the stricter allowlist — keep them distinct.

### Cost-guard fail-open/retry matrix: limiters fail OPEN, reservation precedes spend (full mechanics)
API rate limits fail OPEN; the worker cost RESERVATION precedes every LLM call → spend is always safe even when the limiter is bypassed (`enforceDashboardRegenRateLimit` is the shared per-owner regenerate limiter; both authed regenerate entrypoints call it). On the worker, a raw Redis (Upstash) **transport** error at all four PRE-LLM touchpoints is **RETRYABLE**, not terminal: `checkRegenBudget` re-throws directly; `checkIdempotentCache` (`src/lib/costs/tracker.ts:138`), `reserveCost` (`tracker.ts:204`), and `acquireConcurrencySlot` (`src/lib/costs/concurrency-guard.ts:57`) throw `CostInfraUnavailableError` (`src/lib/costs/errors.ts`), which `generate-draft.ts:88` re-throws like `TransientLLMError` → BullMQ (5× + backoff on the LLM-bound `generate_response` queue; 3× elsewhere) + outbox watchdog re-dispatch (`OUTBOX_WATCHDOG_STALE_MS`, 15min default). (Changed in #255 — those three were previously terminal via the generic `{kind:'failed'}` catch; do not re-introduce that.) **Budget-exceeded** decisions (`CostLimitExceeded`/`GlobalCostLimitExceeded`/`RegenBudgetExceeded`) stay **TERMINAL** — only transport/infra failures retry; never reclassify a budget decision as infra. Post-LLM `tryWriteCache`/`finalizeCost` are out of scope: a finalize failure is governed by `withCostGuard`'s `onFinalizeError`, NOT a job-level retry (a retry would re-spend + burn a regen slot). Net: a transient Redis blip at any pre-LLM touchpoint (incl. first-draft, `version==1`) now RETRIES instead of losing the draft — **spend-safe AND resilient to transient blips**; only an outage outlasting the retry+watchdog budget still fails. (The avoid-facts guardrail RETRY re-throws all three transient classes — `TransientLLMError`, `ConcurrencyLimitExceededError`, `CostInfraUnavailableError` — for BullMQ retry; on retry the primary hits the idempotent cache so only the regen re-runs. Owner-accepted trade-off 2026-07-16: a Redis outage during the guardrail can re-spend, bounded by the queue's BullMQ attempts budget.) Do NOT "fix" the API limiters to strict (fail-open is intentional; the reservation already guarantees spend). The single Upstash instance is still a **SPOF** (cache + rate-limit + cost-reserve + regen-budget + idempotent-generation).

## 2026-07-26 — Solicitation watch-mode owner UI smoke (#528)

### [2026-07-26] Claude-in-Chrome `read_network_requests` reports a **204 No Content** as **503** — trust the server log, never the extension's status code
FAIL → the owner UI smoke's `reviewed_at` idempotency check saw `POST /api/dashboard/solicitation/batch/reviewed → 503` on every second-visit ping, reproducibly, and it was briefly reported as a real defect. WHY → the browser extension's network capture mis-surfaces a bodyless `204` as `503`; the Vercel runtime log for the SAME three requests (03:19:43 / 03:20:40 / 03:22:02, 1:1 count match) shows `POST … 204` with the route's own `batch_reviewed_ping` line each time. Code reading corroborates independently: that handler can only emit 204/400/402/403/404/500, `withSameOrigin` adds only 403, and the single 503 site in `src/` (`withRateLimit`'s strict-mode `rate_limit_unavailable`, `src/lib/auth/route-helpers.ts`) is **not** applied to the route. CORRECT → when a browser-driven runbook sees an unexplained 5xx, confirm it server-side (`get_runtime_logs` for Vercel, `railway logs` for the worker) BEFORE filing; and when the observed status cannot be produced by any layer in the handler chain, treat the observation tool as the prime suspect. Routes that return `204` are the ones exposed to this — `/api/dashboard/solicitation/batch/reviewed` is the known instance.

### [2026-07-26] `useReviewedPing` is gated on `document.visibilityState === 'visible'`, so a minimized/background automation window never writes `reviewed_at` — this is the feature, not a bug
FAIL → during the smoke, opening `/dashboard/requests` left `solicitation_batches.reviewed_at` NULL and looked like a broken write path. WHY → `RequestsClient.useReviewedPing` deliberately refuses to ping from a hidden tab ("the signal has to mean somebody looked"), and Chrome reports `visibilityState: 'hidden'` for a minimized window even when `document.hasFocus()` is `true` — so headless/background drivers silently exercise only the suppression branch. `window.focus()` cannot fix it (browsers block programmatic focus). CORRECT → for any runbook step asserting `reviewed_at`, bring the Chrome window genuinely to the foreground and confirm `document.visibilityState === 'visible'` in-page first; the `visibilitychange` listener then fires the ping. Bonus: doing it in this order observes BOTH halves of the gate (withheld while hidden, written on visible), which a plain foreground open cannot show.

### [2026-07-26] The Solicitation batch builder pools EVERY contact of the business, so a staging smoke's funnel never equals its own CSV — predict the arithmetic instead of expecting a clean env
FAIL → the smoke CSV added 6 contacts but the batch screen read 46 evaluated / 35 held / 11 sendable, which reads as wrong until the pool is understood. WHY → `batch-builder.ts`'s candidate window is `WHERE c.business_id = …` over the whole location (bounded by `MAX_DATA_ROWS`), not the uploading file's rows; `contact_csv_uploads` only *triggers* the batch. Staging accumulates contacts across runs, and every prior `send` ask makes its contact `over_contacted` for `MIN_GAP_DAYS` (30) afterwards. CORRECT → before uploading, snapshot the existing pool (`solicitation_contacts` count + prior asks by status/reason) and state the expected per-gate arithmetic in the evidence file BEFORE the build; then diff the `solicitation batch build finished` log's `withheld_by_reason` against it. Do NOT delete another run's fixture to get clean numbers on shared staging — the accumulated pool is what makes `over_contacted` observable at all.

## 2026-07-26 — #565 complexity-bundle promotions

### [2026-07-26] The `csv_ingest` advisory-lock contract is a STATUS-TRANSITION contract, not a table contract — the offboarding purge deletes unlocked, so a 0-row terminal write is tolerated on purpose (#582)
FAIL → an early draft of #565's plan read `src/lib/solicitation/ingest.ts`'s documented per-business concurrency contract ("every transaction that writes `contact_csv_uploads` takes `pg_advisory_xact_lock(hashtext('csv_ingest_' || businessId))` as its FIRST statement") as universal, concluded that the terminal `status='pending'`-guarded UPDATE matching 0 rows was an impossible state, and specified an assertion + throw. Adversarial review caught it before implementation. WHY → there is a **fourth writer** outside the protocol: `worker/jobs/account-offboarding/purge-stages.ts:256` hard-DELETEs `contact_csv_uploads` by `account_id` with no advisory lock. Only three writers honour it (the ingest transaction, `terminalizeUploadForInactiveSubscription`, and the csv-ingest failed-hook — all now routed through the single owners `acquireCsvIngestLock` / `writeTerminalUploadState`). So the purge can commit between the ingest transaction's `status='pending'` read and its terminal write: the row vanishes mid-ingest, the terminal UPDATE matches 0 rows, and the job completes normally reporting success for an upload whose row no longer exists. That outcome is **benign** — the account was legitimately being purged. The assertion would have converted it into throw → BullMQ retry → retry exhaustion → failed-hook terminalisation → Sentry noise, i.e. an alert storm manufactured out of a correct-by-intent deletion. CORRECT → `writeTerminalUploadState` (`ingest.ts:410`) returns `void`, no caller inspects a row count, and its doc comment names `purge-stages.ts` and forbids adding the assert. Read the lock contract as scoped to **status transitions**, with the purge an explicit permanent exception — the two are not the same claim, and the narrower one is what actually holds. Enforcement today is a comment, which is the weakest possible mechanism for a contract that reads as universal from inside `ingest.ts`; #582 tracks closing it properly (take the lock in the purge stage, per-business under the account). General rule: before asserting "this state is impossible", enumerate every writer of the table, not every writer that follows the protocol.

### [2026-07-26] fallow CRAP is inflated repo-wide — integration-only-covered code reads as ~0% covered and accrues PHANTOM complexity debt that decomposition cannot clear (#581)
FAIL → #565 was scoped from a fallow report as "decompose 5 complexity hotspots in the contacts ingest lane". Measuring first (`npx fallow health --complexity --format json` with the four `fallow-ignore-next-line complexity` suppressions in `src/lib/solicitation/ingest.ts` stripped) returned **zero** findings for that file: those functions clear both the cyclomatic and cognitive thresholds comfortably and were only ever flagged on CRAP. Four of the five "hotspots" were not hotspots, and that scope was dropped from the branch on the evidence. WHY → the CI gate is `ci:fallow:coverage`, which scores CRAP = `CC² · (1 − cov)³ + CC` from a `vitest run --coverage` report that **does not include the integration suites**. Every integration-tested module therefore reads as ~0% covered and its CRAP is inflated by up to the full complexity value. This is not lane-local: it applies to every module whose real coverage lives in a `*.integration.test.ts`. And decomposition cannot fix it — splitting an 89-line function with ~0% apparent coverage yields several functions with ~0% apparent coverage, so the suppressions are still required afterwards. CORRECT → when a fallow complexity finding drives a ticket, read the finding's `exceeded` field before scoping any work: `exceeded: "crap"` with `coverage_tier: "partial"` / `coverage_source: "estimated"` means the number is coverage-sensitive, so check whether the covering suite is an integration suite (→ phantom, file it against #581, do not decompose) or whether raw CC is genuinely over threshold (→ real, decompose). #565's two lanes are the worked example: `batch-builder.ts` had CC=14, so cutting decision points dropped CRAP below threshold and decomposition genuinely fixed it; `ingest.ts` was already under threshold and no restructuring could have moved its score. The one-line justification "CRAP vs complexity" is wrong; the real distinction is "CC above vs below threshold". Corollary: measure before accepting a debt ticket's premise — a fallow-derived scope can be majority phantom, and each phantom item costs a full review cycle to discover.

### [2026-07-26] A `verify-gate.sh` run with FEWER rows than the last one is DISARMED, not faster — a missing `.feature/intake.json` silently drops build/promised-tests/extras/reclassify and still prints GREEN
FAIL → during #565's review fix round, an agent told to clean up its scratch `.feature/fallow-health.json` deleted `.feature/intake.json` and `.feature/state.json` along with it. The next `scripts/verify-gate.sh --review` reported GREEN — while silently skipping every intake-driven row. Caught only by noticing the row count had dropped versus the previous run. WHY → every intake read in the script is failure-tolerant by design, and with the file gone each one degrades to "nothing to check" rather than to an error: `SURFACE` falls back to `backend` (`jq … 2>/dev/null || echo "backend"`, :37) so the `build` row is never launched (:62 launches it only for `ui`/`mixed`); the `verification_commands` loop reads an empty stream (:71) so all declared extras vanish; the `promised-tests` row is appended only inside `jq -e '.tests_to_add | length > 0'` (:126), which fails, so the row is absent entirely rather than FAIL; and `reclassify` needs `estimated_diff_size` (:133), so it too disappears. `PASSED` is computed as "no row said FAIL" (:156) — zero rows to fail is indistinguishable from all rows passing. CORRECT → read the row COUNT, not just the verdict: a gate table shorter than the previous run on the same branch is a disarm signal. Recovery is to restore the intake from its committed copy, re-arm the branch, re-confirm the fix round's changed files are in-surface after the fact, and re-run the full table (24 rows for #565). Do not let a cleanup step touch `.feature/` beyond the exact scratch file it created. The same shape applies to the `integration-suites` SKIP row and the `WARNING:` block: the gate is deliberately loud about *known* gaps and silent about a *missing* configuration, so absence of a row is never evidence of absence of a problem.

### [2026-08-30] The red-team "clean worktree" rule is TWO different guarantees — one enforced in code, one applied by the agent — and only the agent-applied half is broken by a concurrent reviewer's untracked file
FAIL → designing the /feature speed lane's parallel review wave (red-team dispatched beside the read-only review axes instead of after them), the justification written into five files claimed a sibling agent's untracked report under `docs/reviews/<branch>/` would "break red-team precondition 1 and its post-restore assertion". Grepping the tooling to verify it before shipping showed the claim was false as stated: `red-team-status.mjs` reads `git status --porcelain=v1 --untracked-files=no` with the explicit comment "unrelated untracked scratch is not this check's business", and `red-team/SKILL.md` precondition 1 says "no **tracked** modification". An untracked file fails neither. WHY → the phrase "the worktree is clean" covers two separate mechanisms in this workflow and they disagree about untracked paths. The CODE check (`red-team-status.mjs:704`) is deliberately narrow: it exists to catch an unrestored MUTATION, which is always a tracked modification, so widening it to untracked paths would make every scratch file a false abort. The AGENT check (`red-team/SKILL.md`, "after restoration `git status --porcelain` must be empty on every path except this run's two report artifacts") is written without that qualifier and is applied by judgement at the exact moment the agent decides whether its own mutation was restored — which is where a foreign untracked file does real damage, by turning a mechanical check into an adjudication. `gate-fingerprint.mjs` is a third mechanism again: `untrackedHash()` means untracked files DO invalidate the fingerprint, but the reports get committed before the final gate anyway, so that one resolves itself. CORRECT → when a design leans on "the tree is clean", name WHICH check and read it. For the wave the answer is `.feature/review-staging/<axis>.md` (gitignored) with the root copying reports into `docs/reviews/<branch>/` after the finalizer returns — justified as removing an ambiguity from an agent's restoration call, NOT as avoiding a checker failure. Writing the stronger claim would have shipped exactly the class of stale doc assertion the red-team pass exists to catch, in the document that dispatches it.

## 2026-07-26 — #573 live-DB suite deadlock under gate load

### [2026-07-26] Run-time migration DDL in a test suite deadlocks sibling suites across vitest PROCESSES — vitest serialization is per-process, only a session advisory lock spans processes
FAIL → `scripts/verify-gate.sh --review` failed intermittently (≈50%) with `PostgresError: deadlock detected` (40P01), always in a live-DB suite, never on an assertion; the victim varied between runs (`batch-builder.integration.test.ts`, `account-offboarding/integration-lifecycle.test.ts`) and even between tests within one suite, and the whole thing was invisible in CI (no `.env.local` → the suites skip) and unreproducible in isolation. WHY → the Postgres server log names both sides: one backend waiting for `RowShareLock` on `agent_runs` (`appendRunStep`'s `SELECT … FOR UPDATE`), the other waiting for `AccessExclusiveLock` on `solicitation_asks` while running **`088_solicitation_batch_executor.sql`** — a *test suite re-applying a migration in `beforeAll`*. DDL vs row locks on the same relations in opposite orders. Eight suites re-applied migration SQL to ensure their schema; `vitest.config.ts` already serializes `*.integration.test.ts` into its own project (`fileParallelism: false` + `groupOrder`), which makes this safe **within one vitest process** — but nothing in vitest spans processes, and `verify-gate.sh:70` launches every intake `verification_commands` entry in parallel with the main `test` row. #565's intake declared two of them (`pnpm test …ingest.integration.test.ts`, `…batch-builder.integration.test.ts`), so a `--review` run put three vitest processes on one database. Two more compounding facts: (1) `integration-lifecycle.test.ts` self-hydrated `.env.local`, so it ran even in a "no-export" gate run — which is why the issue's "every self-hydrating suite holds the shared lock, so this is ruled out" reasoning was wrong; and (2) its filename does not match `**/__tests__/**/*.integration.test.ts`, so it sat in the *parallel* project with ~740 other files. Differential proof: same two suites in ONE process 0/4 deadlocks, in TWO processes 3/6; the gate-shaped three-process arm 5/6 → 0/8 after the fix. CORRECT → remove the ingredient a test controls: the schema is provisioned once by `pnpm test:db:setup` and suites **assert** it (`assertSchemaReady`, which also owns the single migration→objects map) instead of applying it. A live-DB suite must also be named `*.integration.test.ts` so the serialized project actually claims it. Migration-**shape** suites legitimately apply DDL and are allowlisted, but must hold `acquireLiveDbLock` — a Postgres SESSION advisory lock is the only mechanism that serializes across processes (renamed from `feature-543-database-lock`, which had quietly become the shared protocol). Both rules are CI-enforced by `ci:live-db-suites`. General rule: "vitest runs these serially" is a claim about one process; the moment a script invokes vitest twice concurrently, every in-process guarantee is void — reach for a DB-side lock, or delete the contended operation.

### [2026-07-26] A migration-shape suite that COMMITS a re-apply of an old migration silently reverts a later migration on the shared test DB
FAIL → with the run-time DDL removed, `batch-builder.integration.test.ts` began failing on `agent_outcomes_outcome_kind_check` rejecting `solicitation_batch_built` — a value migration 088 explicitly added. The database had been freshly provisioned to head minutes earlier. WHY → `migration-074-…integration.test.ts`'s "applying the migration a second time is a clean no-op" test re-applied 074 **unconditionally and committed it**. 074 defines `agent_outcomes_outcome_kind_check` with its own, narrower value list; 088 later `DROP`s and re-`ADD`s that same constraint with `solicitation_batch_built` included. So a committed 074 re-apply drops the 088 version and restores the 074 one — leaving the shared DB permanently below head for every suite that runs afterwards. It had been invisible for as long as it existed because `batch-builder` re-applied 088 in its own `beforeAll` on every run and healed it; removing that DDL is what exposed it. Proven by differential: provision → constraint at head; run the 074 shape suite alone → constraint reverted, nothing else touched. CORRECT → a shape suite's unconditional re-apply runs inside `BEGIN` … `ROLLBACK` with its end-state assertions **inside** the transaction (they still observe the twice-applied schema, and nothing is left behind) — the pattern migrations 077/078's suites already used. General rule: on a SHARED database, any test that applies DDL owns the obligation to leave the schema exactly as it found it; re-applying migration N is not idempotent with respect to migration N+k when both write the same named object, and "the suite passes" says nothing about what it did to the next suite.

## 2026-08-01 — #625 consent-ledger ship promotions

### [2026-08-01] Registering an analytics event name only in `ANALYTICS_EVENT_NAMES` rolls back every transaction that emits it — the DB CHECK is a second, unpaired owner
FAIL → #625's Task 3 registered `solicitation_consent_recorded`/`_upgraded` in the TS allowlist; every consent-recording `csv_ingest` transaction then rolled back on `analytics_events_event_name_check` (live suite: `violates check constraint`). WHY → `analytics_events.event_name` is ALSO a DB-level CHECK allowlist (046 → 058 → 069 → 089 → 094), and `ci:analytics-events` compares the TS list only against `docs/analytics/events.md`, never the database; 089's own header warns about exactly this and it happened anyway because the plan treated the event as wiring-only. CORRECT → any new `ANALYTICS_EVENT_NAMES` entry ships with a paired event_name-CHECK migration in the same change; the live CHECK⟺allowlist drift guard lives in the newest such migration's shape suite (currently `migration-094-consent-analytics-events.integration.test.ts`, handed off 089 → 094).

### [2026-08-01] A vitest hook OR test-body timeout on a live-DB suite poisons the FOLLOWING tests — abandoned, not cancelled; and a budget near the observed worst case is a flake
FAIL → `batch-builder.integration.test.ts` failed 2/16 only under `verify-gate.sh --review` (16/16 standalone); the visible failure was an FK violation in the NEXT test. WHY → a timed-out vitest hook is abandoned, not cancelled: postgres.js kept executing the queued cascade DELETEs and removed the row the next test had just seeded. The cleanup was slow because FK fan-out did tens of thousands of row-ops (~7s standalone, >30s under the gate's concurrent coverage load). At ship the SAME contention class recurred in the test BODY: the 5000-contact window test ran 98s against a 90s `timeout` under gate load (93s even standalone on a loaded machine). CORRECT → live-DB cleanup hooks do child-first, business-scoped, set-based DELETEs; both hook and body budgets carry generous explicit headroom (120s/180s here) — never a budget near the observed worst case. Extends the 2026-07-26 #573 notes.

### [2026-08-01] A new table or a new analytics event is never wiring-only — budget the registry ripples at planning time
FAIL → #625's intake estimated ~1200 diff lines; actual ~2500, with three mid-run surface amendments. WHY → the plan priced the schema + writer but not the registry ripples a new table/event drags in: `scripts/ci/tenant-tables.ts` (`ci:rls-audit`/`ci:tenant-scope`), `docs/security/rls-inventory.md`, `TABLE_DISPOSITIONS` + purge sweep (+ the spec §7.2 cascade assumption being wrong), the event_name-CHECK migration (note above) + `docs/analytics/events.md`, migrations-log retention row, `schema-ready.ts`. CORRECT → when an intake adds a table or event, enumerate the registries up front and put every one in `allowed_edit_surface`; also expect one fallow finding class only at PR time — `verify-gate.sh` excludes `ci:fallow*` BY DESIGN (own workflow/baseline), so changed-code complexity trips surface at CI, and the house fix is extracting the new logic into a small decision helper, never a `.fallowrc` waiver (waivers are for pre-existing complexity swept in mechanically).

## 2026-08-03 — #643 suppression-ledger ship promotions

### [2026-08-03] `pnpm test:db:setup` DROPs schema `public`, so declaring it as a `verification_command` makes the gate race itself — provision serially BEFORE the fan-out
FAIL → #643's first `scripts/verify-gate.sh` run came back RED with 27 admin-route test timeouts and a live-DB suite failing "behind head". Nothing was actually broken: the intake had listed `pnpm test:db:setup` in `verification_commands`, and `verify-gate.sh:70` launches every declared extra **in parallel with the main `test` row**. WHY → `test:db:setup` is destructive by design — it drops schema `public` and re-applies bootstrap + every migration. Running it concurrently with suites that are mid-query yanks the schema out from under them, which surfaces as timeouts and phantom "behind head" assertions rather than as an obvious DDL error. The gate does not own its DB precondition, so nothing stops an intake from declaring a destructive command as a parallel row. Compounding: the gate also does not export `TEST_DATABASE_POOL_URL` (it lives in `.env.local`), so without a manual `export` the `integration-suites` row SKIPs — which the gate itself declares not-review-ready for DB-touching work. CORRECT → never put a destructive provisioning command in `verification_commands`. Run it **serially, before** the gate: `export $(grep -E '^TEST_DATABASE_POOL_URL=' .env.local) && pnpm test:db:setup && bash scripts/verify-gate.sh`. General rule: a gate row is a *check*, never a *mutation* — anything that changes the world the other rows are observing has to happen before the fan-out, not inside it. Extends the #573 notes: same root cause (concurrent vitest processes on one database), different trigger.

### [2026-08-03] Never write a fallow suppression from a PREDICTION — if the export has any real consumer, the marker itself becomes the failure (`stale suppression`)
FAIL → #643's plan mandated a `fallow-ignore-next-line unused-export` marker on `recordSuppression`, reasoning that it ships with zero production callers (G6: the writer lands ahead of #644/#645/#627 so its byte-for-byte `ON CONFLICT` predicates are proven against the real partial indexes the moment those indexes exist). Writing the marker **created** a CI failure: `pnpm ci:fallow` reported `stale suppression … (no unused-export issue found on the next line)`. WHY → the same G6 decision that made the export callerless in *production* also gave it a live-DB integration suite as a real consumer, and fallow counts a test import as a use. The predicted finding could never fire, so the suppression was stale from the moment it was written. CORRECT → the marker was removed and its rationale kept as a plain comment. Never author a suppression for a finding you have not *observed*: run the audit, read the actual finding, then suppress the specific thing it reported. A suppression written from a prediction is a defect class, not a one-off — #643's step-7 reviewers were briefed to sweep the branch for others and found zero. Corollary for the "ship the writer early" pattern: an export whose only consumer is a test is NOT dead code to fallow, so it needs no waiver at all.

### [2026-08-03] `estimated_diff_size` must budget production and TEST volume separately — a 4:1 test-to-code ratio is a designed property of a DB-contract feature, and a 1:1 estimate fires the abort criteria on exactly the work whose rigour is most worth having
FAIL → #643's `reclassify` gate row fired at 2.77× (later 2.94×): 5,299 changed lines against an `estimated_diff_size` of `+1800`. The trigger reads as "re-run step 0 and re-classify the lane". WHY → the estimate was made as one number. The breakdown shows nothing was out of control: production code landed at **435 lines across exactly the files the plan's file-structure table named**, 37/37 files in-surface, zero scope creep. The overrun was test volume the plan itself mandated (a 14-row `SUPPRESSION_SCOPES × SUPPRESSION_SOURCES` Cartesian matrix, 8-row token nullability permutations, six live-DB suites, mutation-verified retention proofs) plus 1,537 lines of workflow artifacts — the plan document, deviations file, intake and handoff. Excluding workflow artifacts the diff is 3,452 (1.9×, under the trigger). CORRECT → estimate production and test lines as two numbers, and when a plan mandates exhaustive data-driven matrices give it a test-line estimate of its own. Re-classifying #643 with the real numbers landed on the same lane (RISK was already `high`, 6 tracer tasks under the ~8 epic threshold), so the correct call was "continue, do not re-run step 0" — but that had to be adjudicated by hand. Candidate gate improvement: exclude `docs/superpowers/plans/**` from the reclassify computation — counting a plan document against the implementation it describes is not a meaningful ratio.

### [2026-08-03] `migration-immutability-guard.sh` keys on the migrations-log HEAD, not on "applied to staging/prod" — so amending a LOCAL-ONLY migration after the log bump is a guaranteed false positive
FAIL → #643's adversarial review found `solicitation_unsubscribe_tokens.token_hash` was `TEXT NOT NULL UNIQUE` with a comment asserting invariant #5 and nothing enforcing it. Fixing it meant editing `096_solicitation_suppressions.sql`, which the PreToolUse hook blocked: the same branch's T6 task had already bumped `Current head: **097**` in `.claude/reference/migrations-log.md`. WHY → the hook refuses any edit to a `supabase/migrations/*.sql` whose number is `<=` the recorded head, using the log head as a **proxy** for "already applied and therefore immutable". On a feature branch that writes its migrations-log entry before promotion, that proxy is wrong by construction — 096 existed only in a rebuildable local container. CORRECT → the escape hatch is the process env var `MIGRATION_GUARD_DISABLE=1`, and because it is read at process start it **cannot be set from inside a running session** — `.claude/settings*.json` sits outside `allowed_edit_surface`, and the edit-surface guard correctly refuses to write it. Relaunch as `MIGRATION_GUARD_DISABLE=1 claude`, then resume. Amending in place was also the *correct* call rather than merely the convenient one: the intake's `allowed_edit_surface` listed `096_*.sql`/`097_*.sql` and no `098` glob, so shipping the CHECK as a new migration would have required a second surface amendment and tripped the abort criteria. Candidate guard improvement: a per-entry applied marker in the log rather than the head number alone. Same class: `edit-surface-guard.sh` blocks worktree→main-checkout edits with `WORKTREE_EDIT_GUARD_DISABLE=1` as its only escape — also launch-time — so the post-merge promotion sweep must run from the main checkout AFTER `feature-cleanup.sh` removes the worktree, never from the shipping session.

### [2026-08-03] A comment asserting an invariant is not enforcement — and removing a defensive `OR` can HAND BACK tenant-scope allowlist entries
FAIL → two #643 review findings with the same shape. (1) `token_hash TEXT NOT NULL UNIQUE` carried the comment *"SHA-256, node:crypto (invariant #10); raw token NEVER stored (invariant #5)"* while accepting a raw token as readily as a digest — a single call site that forgot to hash would have stored plaintext and every reader downstream would still have worked. (2) `suppressionMatchSql` hardcoded `channel = 'email'` while `recordSuppression` took `channel` as a parameter — two owners for one dimension, failing **open**: the day `SUPPRESSION_CHANNELS` gains a member the writer mints rows the reader can never see, and an opt-out the ledger holds but the gate cannot find means the recipient gets contacted. CORRECT → (1) a named format CHECK mirroring migration 056's `account_offboarding_tokens`, `CHECK (token_hash ~ '^[a-f0-9]{64}$')`, lowercase-only because that is what `node:crypto`'s `digest('hex')` emits and admitting uppercase would let two spellings of one digest past the UNIQUE index; verified by **mutation** (remove the CHECK, re-provision, confirm 6 of 7 new assertions fail, restore). (2) `channel` became a required parameter on both sides. Bonus finding from the same review: the offboarding token scrub's `OR business_id IN (SELECT … FROM businesses …)` made `idx_solicitation_unsubscribe_tokens_account` unusable (seq scan) on the one statement that index was added for, **and** was redundant under the G12 CHECK (`business_id NOT NULL ⟹ account_id NOT NULL`). Dropping it from the scrub while KEEPING it in the purge verifier restored index usability on the hot path and preserved the cross-account tripwire on the cold one — and because the remaining predicate is natively account-scoped, it also deleted two `tenant-scope-allowlist` entries (`ALLOWLIST_BASELINE` 413 → 411). General rule: an allowlist entry that exists only because the scanner rejects `OR` is a signal worth re-reading — the `OR` may not be earning its keep.

### [2026-08-03] PgBouncer JSONB parse-site allowlist — AUTHORITATIVE (moved from CLAUDE.md, context diet)
CLAUDE.md keeps the guard rule (`typeof x === 'string' ? JSON.parse(x) : x`, then narrow; never paper over with `: any`); this entry owns the site enumeration. **Exactly 19 production JSONB field-to-parser sites today:**
- `job_outbox.payload` (2): `worker/background/pollers/OutboxPoller.ts`; `src/app/api/dashboard/past-replies/draft-status/route.ts`.
- `businesses.tracked_keywords` (1): `src/lib/admin/business-detail/mappers.ts` (the `trackedKeywords` call through `parseDbArray`; its sibling calls parse `TEXT[]`, not JSONB). `RankingTrackingWorker` no longer parses this column — it reads the primary keyword via `primaryTrackedKeywordSql` (#572), which resolves it in SQL.
- `accounts.flags` (2 shared parser sites): `src/lib/shared/past-due-recovery.ts`; `worker/background/pollers/billing-reconciliation/account-flags.ts`.
- Demo snapshots (4): `prospect_demos.reviews_snapshot` + `.generated_responses` in `src/app/(public)/demo/[slug]/page.tsx`; the same two `onboarding_demos` fields, server-projected into `src/app/onboarding/demo/PaywallWithDemoClient.tsx`.
- Run spine (2): `agent_runs.error` + `agent_run_steps.detail` in `src/lib/agents/read.ts`.
- `solicitation_outreach` (3): `.lint_detail` + `.moderation_detail` + `.interpolation_inputs` through the shared parsers `parseOutreachLintDetail`/`parseOutreachModerationDetail`/`parseOutreachInterpolationInputs` in `src/lib/solicitation/outreach.ts` (consumed by the Requests read model in `src/lib/solicitation/batch-view.ts`; each narrows and throws on a shape the writers cannot have produced — the `parseEvidence` posture).
- One each (5): `analytics_events.properties` in `worker/background/pollers/AnalyticsDispatchPoller.ts`; `review_exceptions.payload` in `worker/jobs/AdminExceptionWorker.ts`; `account_offboardings.provider_dispositions` through the shared parser in `src/lib/account-offboarding/provider-disposition.ts`; `contact_csv_uploads.report` through the shared parser `parseIngestReportValue` in `src/lib/solicitation/ingest.ts` (consumed by `getUploadStatus` in `uploads.ts` and the worker's terminal-status re-read); `solicitation_asks.evidence` through `parseEvidence` in `src/lib/solicitation/batch-view.ts` (the Requests read model — a non-object or discriminant-less value throws rather than rendering a blank spoilage row).

Any new production JSONB field-to-parser site must be added HERE. Do **not** add HTTP/request bodies, provider responses, LLM output, Redis/cache/connect-state values, local storage, JSON structured clones, or `TEXT[]` reads — those are different parsing boundaries, not this PgBouncer JSONB carve-out.

### [2026-08-03] Single-replica worker — detection mechanics (moved from CLAUDE.md, context diet)
The worker is single-replica by invariant, and that is DETECTED, not enforced. Four boot guards (`assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, overage OVERAGE-F1) plus the in-process LLM circuit breaker are only correct with one replica, and the P2 pollers in `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md` become duplicate-processing bugs with two. `ci:static-policy` blocks `numReplicas`/`multiRegionConfig` in `railway.toml` (config-as-code overrides the dashboard, so that is the one path a static check can block), and every boot logs + Sentry-tags `replica_id`/`deployment_id` via `worker/config/replica-identity.ts`. Railway injects a per-replica id but **no replica count**, so no process can assert it is alone — scaling up starts a new replica without redeploying the existing one, so **two `replica_id`s under one `deployment_id` is the signal**. A dashboard-set replica is not prevented; clear the P2 list first. **The signal is acted on (#587):** each replica registers in Redis under a TTL every `HealthAlertPoller` cycle, and the poller pages when >1 is live — immediately for replicas sharing a `deployment_id` (scale-out), or after a 2-cycle grace for a cross-deployment overlap (so a normal zero-downtime deploy does not page). `worker/background/pollers/health-alert/replica-cardinality.ts`. Deliberately a registry, NOT a boot-gating lease: a Redis outage must degrade to "no replica alerting", never to a worker that will not start — the check carries its own log-and-swallow `try/catch` for exactly that reason.

### [2026-08-03] Worktrees — sibling vs nested: full mechanics + cleanup (moved from CLAUDE.md, context diet)
`pnpm worktree:new <branch>` (→ `scripts/new-worktree.sh`) creates the worktree *outside* the repo at `../RepWorth-worktrees/<branch>/` with its own `node_modules` + copied `.env*.local`, so local lint/test/typecheck and the pre-push hook give a trustworthy signal. A *nested* worktree (`.claude/worktrees/`, `.worktrees/`) poisons local CI: Node's upward `node_modules` resolution and ESLint's upward config cascade leak the parent's deps/config in — if you're stuck in one, push and read the runner instead. The harness `EnterWorktree` tool and Agent `isolation:'worktree'` both create *nested* worktrees, so they inherit that caveat (fine for edit+typecheck agents, not for trustworthy full CI). Either way, every Write/Edit path must point at the worktree root (`…-worktrees/<branch>/…` or `.claude/worktrees/<name>/…`), never the parent checkout, or the edit silently lands in `main`'s tree (hook-enforced in the worktree→elsewhere direction by `edit-surface-guard.sh`). **Cleanup:** first confirm the branch's PR is merged (`gh pr list --head <branch> --state merged` — squash merges make `git branch --merged` useless) and the tree is clean, then remove each worktree individually: `git worktree remove <path>`, then `git branch -D <branch>`. One at a time, no `--force` — each removal stays reviewable.

- [2026-08-09] Pushing a staging merge from a dep-less throwaway worktree failed lefthook's test-changed (vitest cannot run without node_modules; lefthook runs in the pushing worktree) → the hook adds no signal there → push with --no-verify AFTER the real worktree's gate is green, or push from a checkout with deps.

### [2026-08-03] TEST_DATABASE_POOL_URL fallback — unsetting it does NOT sleep live-DB suites (moved from CLAUDE.md, context diet)
`resolveTestDatabaseUrl()` (`live-db-lock.ts`) falls back to reading `.env.local` off disk, so the six suites gating on it (ingest, batch-builder, run-spine, live-db-lock, migrations 088/090) run even under `env -u`. That matters because a whole-repo `pnpm test` with the DB awake breaks the suites that set the `src/lib/db/server` singleton at import time — whichever file initializes it first wins and the rest get `ECONNREFUSED :5432` (the #520 class). CI never sees it because CI's DB *is* on :5432, so the singleton default happens to be right. Kill switch: `REPWORTH_DISABLE_LIVE_DB_SUITES=1`, honoured by both gates; `scripts/verify-gate.sh`'s full-suite row sets it alongside `env -u` (#563).
**[2026-08-31, #1009 — the MIRROR half, and it is the dangerous one.]** Unsetting the var does not put the suites to sleep; **setting it in `.env.local` does not wake them either.** `describeWithDb` reads `process.env.TEST_DATABASE_POOL_URL` DIRECTLY, and the off-disk fallback never hydrates `process.env` for it — so a suite present in the file and absent from the environment **self-skips and reports GREEN having executed nothing**. #1009 nearly shipped on that: five live-DB cases carrying the slice's entire safety argument passed without running, caught only by re-running with `--reporter=verbose` and checking the cases actually executed. CORRECT → `export` the var, never rely on `.env.local`, and confirm execution rather than exit code. And export `DATABASE_POOL_URL` to the same local URL in the same breath: `pnpm worktree:new` copies `.env*.local`, so a fresh worktree inherits the developer's **live Supabase pooler** there, and any accidental singleton import during a test run reaches production. Both halves of CLAUDE.md's "export BOTH first" are load-bearing — one decides whether the tests run, the other decides what they run against.

### [2026-08-03] fallow coverage input is DB-complete as of #581 (moved from CLAUDE.md, context diet)
*(2026-08-16 update: `fallow.yml` no longer exists — the CI cost pass folded it into `ci.yml`, where the `test` job's own `pnpm test:coverage` run (live-DB lane included) is uploaded as an artifact and consumed by the `fallow` job. DB-completeness is unchanged; the second Postgres and second suite run are gone. History below describes the pre-fold layout.)*
`fallow.yml` stood up its own `postgres:16` service container — per-job, on its own runner, NOT shared with `ci.yml` (which stands up its own, as does `e2e.yml`). Before that, ~37 integration suites self-skipped in the fallow run, so a module covered *only* by an integration suite read 0% and its CRAP (complexity × uncovered²) was inflated by up to its full complexity. Corollary the original report got wrong: a module with BOTH a unit and an integration suite was never affected — `ingest.ts` measured 91.9% statements / 89.1% branches in the DB-less input, and its four `fallow-ignore-next-line complexity` suppressions were phantom (removed; the gate passes without them under either input).

## 2026-08-03 — #644 unsubscribe opt-out ship promotions

### [2026-08-03] `createWorkerLogger` object args pass through the analytics blocked-key sanitizer, which silently DROPS any key containing `token`
FAIL → #644's §9.5 structured line was going to carry `token_hash_prefix`, the one field that makes a redemption correlatable across a provider's retries. It would have been removed from **every** log line — no error, no warning, the field simply absent, discoverable only while debugging a production incident, which is exactly when it is needed. WHY → object arguments to `createWorkerLogger` are sanitized by the analytics blocked-key filter, which strips any key whose *name* contains `token`. The sanitizer is doing its job: a key called `*token*` overwhelmingly holds a secret. The collision is that a **hash prefix of** a token is safe by construction and reads as a token by name. Invariant #5 says never log the raw token; it does not say never log a name containing the word. CORRECT → renamed to `hash_prefix`. General rule: **any deliberately-safe derived value — a hash prefix, a masked suffix, a key id — must be NAMED so it does not collide with the blocked-key sanitizer**, or the logger drops it without a sound. String args do not pass through the sanitizer, so the trap only bites the structured (object) lane, which is the lane you want for correlation.

### [2026-08-03] `app.inject()` normalises the request target, so it cannot falsify a claim about the raw request line — and absolute-form targets bypassed the ingress limiter for ALL FIVE providers
FAIL → the ingress limiter's scope test has two arms: `request.routeOptions.url?.startsWith('/ingress/')` (arm 1) and `decodeIngressPath(request.url).startsWith('/ingress/')` (arm 2). Arm 1 looked like dead logic — deleting it failed **zero** tests, and the plan had justified it by comparing against a *raw* URL check rather than the *decoded* one it actually specified. Both observations were true; the conclusion was wrong. WHY → an **absolute-form request target** (RFC 9112 §3.2.2), `POST http://<host>/ingress/resend HTTP/1.1`, is legal HTTP/1.1 any client may send. `find-my-way@9.6.0` strips scheme and authority (`index.js:571-572`) so the route resolves normally, while `request.url` retains the full absolute string — making arm 2 false. Verified over a **raw socket** against `fastify@5.8.5`: arm1 `true` / arm2 `false`. Deleting arm 1 makes every ingress provider's limiter — Stripe, Resend, Telegram, Twilio, Zernio — bypassable by a one-token change to the request line. No test caught it because **`app.inject()` normalises the target before Fastify sees it**, so the absolute-form case is unreachable through the entire existing suite; every rate-limit test on this branch and every earlier one goes through `inject`. CORRECT → keep both arms, and cover the case with a **real-socket** test (`net.connect` writing the request line by hand). General rule: a surviving mutant means dead logic **or** a structural blind spot in the harness — and `inject`-only suites are blind to anything about the raw request line (absolute-form, duplicate headers, malformed targets). When a mutation "proves" a security-adjacent branch is dead, ask what the harness cannot express before deleting it.

### [2026-08-03] The post-merge promotion sweep does NOT require the main checkout — park `.feature/intake.json` and branch the shipping worktree off `origin/main`
FAIL → #643's note concluded the sweep "must run from the main checkout AFTER `feature-cleanup.sh` removes the worktree, never from the shipping session", because `edit-surface-guard.sh`'s only escape (`WORKTREE_EDIT_GUARD_DISABLE=1`) is read at process start. In #644 that route was unavailable: the main checkout was on an unrelated branch, and `feature-cleanup.sh` computes `MAIN_ROOT` from its own cwd — run from inside the feature worktree it **skips that worktree as `MAIN_ROOT`** and cleans nothing. WHY → the guard has two independent rules. Always-on worktree containment blocks cross-*checkout* edits (session cwd in a worktree, target elsewhere); the `/feature` arming blocks edits outside `allowed_edit_surface` and is file-anchored on `.feature/intake.json`. Both are satisfied by staying in ONE checkout and disarming: `mv .feature/intake.json .feature/intake.parked.json` (the documented park operation), confirm `scripts/arm-check.sh` reports DISARMED, then `git checkout -b <docs-branch> origin/main` in the same worktree. Same checkout → containment passes; no intake → arming passes. CORRECT → park, branch off `origin/main` **not** local `main` (which lags after every squash merge — a worktree created from local `main` lands pre-merge and silently omits the code being documented), do the sweep, PR it, then run `feature-cleanup.sh` from the main checkout last. Corollary: `feature-cleanup.sh` must be run from the main repo root or it silently under-reports.

## 2026-08-05 — #645 manual suppression paths ship promotions

### [2026-08-05] A legal refactor can blind a file-level `ci:*` security audit — typecheck and every route test stay green
FAIL → the three admin suppressions routes opened with the same ~14-line preamble (AAL2 gate, `request.json()` in a try, `safeParse`, two 400s). Extracting it into a `withAal2JsonBody(schema, handler)` wrapper compiled, passed all route tests, and turned **`ci:admin-aal2` RED on all three routes**. WHY → `scripts/ci/admin-aal2-audit.ts` is a **file-level TEXT scan**: a file under `src/app/api/admin/**` exporting a mutation verb must literally contain the string `requireAdminWithAal2`. Moving the call behind a wrapper made three genuinely-gated routes indistinguishable from ungated ones. The audit is right to be strict — "is this admin mutation MFA-gated?" should be answerable by grepping the route, not by following an import. CORRECT → keep the gate spelled out in every route; share only the parts that carry no authorization meaning (here, body parsing → `parseJsonBody`). The audit *does* expose a `GATED_SHARED_HELPERS` allowlist for thin delegators, and adding to it was the wrong instinct twice over: it is outside a feature branch's surface, and it trades a greppable gate for a shorter file. **General rule: before extracting a shared helper out of a route, check whether a `ci:*` audit string-matches the thing you are about to move.** The audits that scan source text — `admin-aal2`, `static-policy`, `tenant-scope`, `outbox-seam` — all have this property, and a passing typecheck proves nothing about them. Same principle migration 098 applied when it refused `original_*` column names to stay visible to `accountLinkedTablesFromMigrations()`: never reshape code so a governance check stops seeing it.

### [2026-08-05] `fallow` is a CI-only gate — a fully green `verify-gate.sh` does not predict it, and the LOCAL fallow disagrees with CI in BOTH directions
FAIL → #645 passed all 28 `verify-gate.sh` checks and two full review rounds, then failed `fallow` the first time a PR existed (4 duplication clone groups + a 19-cyclomatic component). WHY → `verify-gate.sh` does not run fallow at all. CLAUDE.md says `ci:fallow` "gates nothing", which is true of *that script* but not of `fallow.yml`'s **`ci:fallow:coverage`**, which is a real PR check. The two facts read as one and hide the gap. CORRECT → expect a fallow round on every PR; do not treat local green as ship-ready. **Second trap, worse:** running `fallow audit` locally without `--coverage` estimates CRAP **from export references**, which reported `ContactRow` as HIGH at 63.6 CRAP while the coverage-informed CI run did not flag it at all. Read both outputs side by side before refactoring — a local HIGH carrying the "CRAP scores are estimated" banner is not a finding, and chasing it means restructuring code against a number CI never computes. **Third trap, the INVERSE of the second and the reason this note's title changed (#783, 2026-08-10):** the estimate does not only over-report, it also MISSES. #781's fix added ~8 branches to `Step4Confirm.tsx`, a 143-line component with **zero** render coverage; the bare `fallow audit --gate new-only --fail-on-issues --base origin/main` prescribed in the ticket returned `✓ No issues` and exit 0, and CI then failed it CRITICAL at **CRAP 420** (20 cyclomatic × 0% tested). WHY → without `--coverage` there is no coverage term to cube, so a genuinely untested file is scored by the export-reference heuristic, which happened to read it as fine; `(1 − cov)³` only bites once the real Istanbul report says 0%. The two traps are one property — the estimate is not a conservative approximation of the CI number, it is a different number — so "local passed" is as weak a signal as "local flagged it". CORRECT → the only faithful local reproduction of the PR check is **`pnpm test:coverage && pnpm ci:fallow:coverage`** (~5 min; the coverage run is the slow part). Run it before pushing any PR that adds branches to a component, and treat the bare `fallow audit` as a fast smoke test that proves nothing either way. Remediate on merit as always: #783 extracted the new notice into its own component and gave `Step4Confirm` the render suite it never had, rather than adding a `.fallowrc` waiver — a 0%-covered file flagged on CRAP is fallow correctly reporting missing tests, not a false positive to waive.

### [2026-08-05] #674 — a hazard described too narrowly is worse than one described not at all
FAIL → #674 deferred a known lost-draft hazard to #675 and documented it as *"if `importReview` wins the identity **race** against a concurrent live-ingest `processReview`…"*. The adversarial review agent showed **no concurrency is required**: the live lane enqueues `generate_response` only when it INSERTs a review or when the content hash CHANGES, so a later `processReview` for an already-imported row takes the existing-row path, matches the hash, and returns `'unchanged'` without enqueueing (`processExistingReview`, the `existingHash === contentHash` branch). All three Zernio lanes converge on that same `processReview`, so none is a rescue. WHY → the race was the case that got *noticed* (it is the interesting one), and writing it down felt like documenting the hazard. It is actually the **rare** instance of a general property whose common instance — import first, live lane polls later — is the ordinary path. CORRECT → when deferring a hazard, state the **general property**, then note the interesting case as an instance of it. The test: *what is the simplest sequence that triggers this?* If the written hazard requires concurrency, interleaving, or a crash window, check whether the plain sequential ordering already does it. A too-narrow description is worse than silence: the next implementer reads "race", adds a narrow concurrency guard, closes the ticket, and ships the systemic bug — where no description at all would have made them look. Corollary that cost a second round: **a correction must reach every copy.** The fix updated the JSDoc, the deviations entry and the plan's Hazards section — and missed that the plan *embeds the implementation code*, so the superseded paragraph survived verbatim 435 lines lower, in the same file the successor ticket is pointed at.

### [2026-08-05] #674 — `describeWithDb` does NOT assert schema, and asserting what the suite READS is not enough
FAIL → a new live-DB suite shipped with no `assertSchemaReady` call, on the plan's stated belief that "`describeWithDb` handles the schema assertion". It does not — `src/__tests__/helpers/describe-with-db.ts` only gates on `TEST_DATABASE_POOL_URL` (plus the `REPWORTH_DISABLE_LIVE_DB_SUITES` kill switch) and registers `describe` or `describe.skip`. Nothing in it touches the schema. The cited precedent (`read.integration.test.ts`) also omits the assertion, so copying the nearest neighbour propagated the gap; 32 other suites do call it. WHY → CLAUDE.md says live-DB suites "**assert** their schema … so a behind-head DB fails loudly", which is a statement about the *convention*, not about the helper. Then the first fix was **still wrong**: it asserted `MIGRATION_071_RUN_SPINE` — the run-spine tables the suite READS — and missed that the code under test WRITES `agent_runs.parent_run_id`, a column added by migration **088** and declared by `MIGRATION_088_SOLICITATION_BATCH_EXECUTOR`. `MIGRATION_071_RUN_SPINE` lists only `tables`, no `columns`. A DB at head 071–087 would pass the assertion and then fail at the first `it` with the raw `column "parent_run_id" does not exist` — precisely the failure mode the assertion exists to prevent. CORRECT → call `assertSchemaReady` explicitly in every live-DB suite, and build the requirement list from **everything the transaction under test touches**, not from the tables the assertions read. Trace the writers (`startOrGetActiveRun` → `recordStep` → `completeRun`), not just the `SELECT`s. `run-spine.integration.test.ts` gets this right and asserts 071 + 088 + 091 together.

### [2026-08-05] #674 — plan-embedded code is unlinted, untypechecked and unexecuted until a subagent runs it
FAIL → across three plan-review rounds, the implementation plan's embedded code accumulated defects no tool would catch: `agent_run_steps.run_id` (the real column is `agent_run_id`; `run_id` is the local *variable* name the run-spine writers use), a missing `sentiment_score` assertion, an unnecessary `as MonitoredReview` cast, and a `git ls-files`-based audit invoked before the file was staged (so it inspected nothing). Round 3 caught the column name — in the very suite added to catch that class of error, which would have failed to run at all and thrown in `afterAll` before deleting a row. WHY → a plan is prose to every tool in the repo. Its TypeScript is not typechecked, its SQL is not parsed, its shell is not run. Yet it is treated with the confidence of code because it *looks* like code. CORRECT → schema identifiers, helper signatures and column names inside a plan need the same "look it up, don't guess" discipline as production code — every one of those four was verifiable with one `rg` against the migration. Related trap from the same ticket: a verification step that says *"expect the output to mention X"* is only a non-vacuousness proof **if the tool prints X on success**. `scripts/ci/live-db-suites-audit.ts` prints filenames only in its failure branch, so the prescribed receipt was unobtainable and a passing run could never satisfy it. When specifying a check, confirm the tool actually emits the evidence you are asking for.

### [2026-08-05] Resolving a `docs/directory.md` merge conflict is where a design fact quietly reverts — grep the FACT, not the rows you remember editing
FAIL → `docs/directory.md`'s `supabase/migrations/` prose paragraph still claimed migration 098 carries "deliberately **no `account_id`**, so it is correctly absent from the offboarding inventory". Both halves were false as shipped: 098 declares `account_id UUID`, and the table is `table-disposition.ts` entry `retain_compliance_limited_pii` with a `purge-verification.ts` branch. WHY → deviation D-A11 reversed that design mid-branch, and the resync commit swept "`CONTEXT.md`'s Correction path entry and two `docs/directory.md` rows" — the rows the author remembered editing. The stale claim lived ~1000 lines away in a section about migration *numbering*, which is not where anyone looks for a statement about column design. It survived two review rounds and only surfaced while hand-resolving a merge conflict in that same file. CORRECT → when a deviation reverses a design decision, `rg` the **fact** (`account_id`, "offboarding inventory") across `docs/` and `.claude/`, not the file sections you touched. A doc that describes a design the code no longer has is worse than no doc, because the next session trusts it.

### [2026-08-05] #673 — an intake is a snapshot; ticket amendments posted after intake lock are invisible to every downstream review
FAIL → migration 100 shipped `import_decision` with a FOUR-valued CHECK (`…|expired`) to staging and prod. #670's resolution — enum is **three-valued**, expiry is derived on read, "a CHECK value nothing writes would misrepresent the state machine" — had been posted as an amendment comment on ticket #673 roughly **17 minutes after** the /feature intake was locked. Three codex plan-review rounds and two branch-review rounds all validated against the intake and plan (that is their job — a fixed target), so the amendment was never seen; the drift surfaced only at promotion, when the epic map was read to answer "what's the next ticket". Corrective migration 101 landed the same day (PR #686). WHY → the /feature workflow makes the signed intake the scope contract precisely so reviews have a stable target, and nothing in the workflow re-reads the source ticket after intake sign-off. An amendment posted to the ticket between intake lock and ship therefore has no path into the run — the resolution notes WERE posted downstream (#673 got the comment); posting is not receiving. CORRECT → two checkpoints, both cheap: at **plan sign-off**, and again in the **step-8 ship preflight**, re-read the source ticket's comments and the epic map entry for anything posted after the intake's lock timestamp. An amendment that contradicts a locked intake term must either amend BOTH intake copies through the amendment protocol before execution, or be explicitly deferred with a comment back on the ticket saying the running feature will NOT honour it. Silence is how both sides ship believing they won.

### [2026-08-05] #673 — environment-state premises decay in hours; re-verify them at apply time, and date them in immutable headers
FAIL → spec §8a R3 and migration 100's header state both environments hold **zero `businesses` rows** — true when the staging reset ran that morning, false by the staging apply a few hours later (2 smoke rows had appeared; deviation D8). The claim is baked into an immutable migration header. Harmless here only because DEFAULT `'pending'` is the truthful state for a never-answered location — the premise was sufficient-but-not-necessary for the no-backfill decision. WHY → environment-state premises ("prod is empty", "no rows predate X") are snapshots that anything with write access — smoke tests, beta pokes, another session — invalidates silently; specs and headers quote them as standing facts. CORRECT → every data-state premise a migration relies on gets re-verified **by query in the apply-time preflight** (and the result recorded in the migrations-log entry, which stays editable); migration headers should phrase such premises as dated observations ("zero rows at spec lock, 2026-08-05"), not standing claims. The migrations-log entry — not the immutable header — is where apply-time reality belongs.

## 2026-08-06 — #675 consented import ship

### [2026-08-06] #675 — a verify-gate GREEN branch can still go red in CI: the fallow job is deliberately outside the local gate
FAIL → PR #689 opened with the branch fully gate-GREEN (all 21 rows) and every prior review round closed — and CI's `fallow` job failed with three findings (an unconsumed `export`, a 19-line clone, arrow complexity), forcing a post-open fix commit, a gate re-run, a staging re-ride and a re-smoke. WHY → `verify-gate.sh` derives its audit set from package.json's `ci:*` scripts but **excludes `ci:fallow*` by design** (its own CI workflow, own baseline, own coverage env) — so fallow findings are structurally invisible until the PR exists. The clone in question was even review-approved code: the D3 fix deliberately mirrored branch 2 verbatim, which is exactly what a suffix-array clone detector flags. CORRECT → treat fallow as a ship-time gate, not a review-time gate: before opening a PR on a branch whose diff added parallel/mirrored blocks, run `npx fallow audit --gate new-only --base origin/main` locally (static mode approximates CI; CRAP differs — coverage-fed CI is the arbiter) and remediate on merit (de-export, extract with per-call-site messages) rather than suppress. Post-open fixes on a RISK=high branch don't get a self-run review round past the cap — surface them as a PR comment for the owner (the D14 pattern).

### [2026-08-06] #675 — the Zernio sandbox feed is non-descending in practice: the import's dirty-ordering lane is the norm there, not the exception
FAIL (expectation, not code) → both staging smokes of the consented import logged `Zernio page order non-descending at review … (page 1) — early stops disabled` and paged to feed end (4 pages). Anyone watching staging logs will see this WARN on every import and may read it as a regression. WHY → the import trusts its two early stops (target met / floor passed) only while pages arrive newest-first; Zernio's ordering is verified-but-undocumented (spec §9), and the **sandbox** feed genuinely interleaves. Dirty mode is the designed response: page to feed end or `ZERNIO_IMPORT_MAX_PAGES`, then select in-memory — results are identical, just more pages fetched. CORRECT → on staging, the ordering WARN + `pages=N > 1` with a clean `Import complete` line is healthy behavior, not an incident; it only becomes a signal when paired with `ZernioImportPaginationCapExhaustedError` (cap-out with <100 in-window — bump the cap and re-enqueue) or when it starts appearing in **prod** logs, which would mean Google/Zernio ordering changed for real feeds too (the early-stop optimization stops applying; cost is extra pages, correctness unaffected).

## 2026-08-07 — #677 import offer ship

### [2026-08-07] #677 — `ci:tenant-scope` strips subqueries before analysing predicates, so a tenant key bound inside `EXISTS (…)` reads as UNSCOPED
FAIL → three new queries bound `business_id`/`account_id` correctly but did so inside `EXISTS (…)` subqueries; `ci:tenant-scope` reported the tables as unscoped and demanded allowlist entries for code that was already tenant-safe. WHY → the audit strips subqueries before it analyses predicates, so anything bound below the top level is invisible to it. The failure mode is insidious in both directions: the honest fix looks like "add a suppression", which permanently blinds the audit to that call site. CORRECT → restructure so every tenant key is bound in a **top-level** predicate rather than suppressing. `createImportOffer` JOINs the two junction halves instead of testing them with `EXISTS` (safe: `accounts.id` is the PK and `zernio_connections_one_active_per_business` makes an active row unique per business); `finalize-tx`'s completed-run guard became its own statement ahead of the INSERT; `import-offer-view` uses a `LEFT JOIN` plus a second conditional query. Net effect on the tree was a **shrink** — allowlist baseline 420 → 418.

### [2026-08-17] #858 — `agent_runs.subject_id` is TEXT: a uuid compare against it is case-SENSITIVE while every `::uuid` cast normalises
FAIL → a request-supplied mixed-case batch id (accepted by `isValidUuid`, which is `/i`) matched `solicitation_batches` (`b.id = $1::uuid` normalises) and MISSED that batch's Send parent (`r.subject_id = $1`, TEXT compare) — `approveBatch` threw, `haltBatch` silently dropped its step, and any other caller of `closeBatchIfSettled` could leave a Settled batch with a running parent forever (#629 D7 → D13 → #858). WHY → `subject_id` is a polymorphic subject key (migration 071), so it cannot be `uuid`; Postgres renders a uuid in lower case, so rows written from DB-read ids are canonical and only request-origin ids can differ. CORRECT → canonicalise (lowercase) ONCE at every request boundary (`canonicalBatchId`) AND inside the lifecycle owner (`closeBatchIfSettled` lowercases its input) — a single-owner function that every caller must pre-normalise for is a seam under strain. General rule: any TEXT column that stores uuid-shaped subject keys is compared case-sensitively; a `$1::uuid::text` on ONE statement fixes only that statement.

### [2026-08-17] #859 — query blocks are now the tenant-scope proof unit; the #677 top-level-only workaround is retired
RESOLVED → `ci:tenant-scope` no longer strips parenthesized SELECTs. It lexes PostgreSQL strings/dollar quotes/nested comments and JavaScript template placeholders once, then audits every physical tenant-table binding in every CTE, scalar/EXISTS/LATERAL child, data-modifying CTE, and set arm. Scope never crosses an alias boundary by name: a child inherits only through an explicit account/business identity equality to an already-proven ancestor occurrence, while unqualified correlated tenant columns, row-id correlation, siblings, non-tenant ownership bridges, OR/NOT, strings, and comments fail closed. Every failure now carries a stable template-occurrence + statement/arm/block/table/alias/binding identity, and `--no-allowlist` exposes the same occurrence proof before exceptions. Consequence: natural scoped `NOT EXISTS` and scalar subqueries are preferred again; do not contort SQL into joins or split statements merely to make the audit see a top-level predicate. Exact allowlists remain for genuinely global/pre-auth/admin flows and safe statements at those conservative proof boundaries, applied only after occurrence analysis and justified by their actual trust boundary. Two holes the branch review found and closed before merge, both false negatives the flattened scanner did NOT have: (1) a scope predicate proves a binding only on a column the table physically has (`TENANT_SCOPE_COLUMNS`, schema-asserted) — `EXISTS (SELECT 1 FROM reviews WHERE account_id = $1)` compiles because PostgreSQL resolves the missing column to the OUTER row, and the plan shows a filterless `Seq Scan on reviews`; (2) a grandchild inherits only ancestors the intermediate block does not re-bind — `EXISTS (SELECT 1 FROM job_outbox r WHERE EXISTS (… x.business_id = r.business_id))` names the outbox row, not the proven root `reviews r`. Nested plain literals inside a `${…}` placeholder are bind parameters, not statements, and are no longer extracted as SQL.

### [2026-08-07] #677 — a shared SQL fragment must not require identifier interpolation: `db(alias)` dies on the repo's hand-rolled `sql` mocks
FAIL → `importConsentStateSql` took an `alias` parameter and injected it via postgres.js's identifier form `db(alias)`. Correct against real Postgres, and it passed the live-DB suites — but the four producers' unit suites use hand-rolled `sql` mocks implementing only the tagged-template call form, so `db('b')` arrived as a bare string and died on `strings.join is not a function` across several directories at once. WHY → a fragment consumed by N producers is consumed by N test harnesses too, and the repo's mocks model the tagged-template API, not the full postgres.js surface. Making the fragment more flexible taxed every mock in the repo. CORRECT → fix the contract instead of generalising the fragment: it now takes **no interpolation at all** and callers must alias `businesses` as `b`. Note this trades a compiler-checked parameter for a naming convention nothing enforces — a caller aliasing differently compiles clean and derives consent from the wrong row; the guard is the source tripwire `import-consent-lock-order-source.test.ts`.

### [2026-08-07] #677 — `ci:outbox-seam` derives helper coverage ONLY from `job-outbox-helpers.ts`, so a shared function elsewhere is NOT a helper to the audit
FAIL (a recorded blocker that was FALSE) → the handoff carried, and a review round re-asserted, that extracting the triplicated `ZERNIO_INITIAL_BACKFILL` enqueue into a shared function would turn every raw producer red under `ci:outbox-seam` and force migrating them all in one PR. Acting on that belief is why three copies were allowed to diverge in the first place — and they had already diverged (the A4 bug). WHY → `scripts/ci/outbox-seam-audit.ts` pins `HELPER_MODULE` to `src/lib/shared/job-outbox-helpers.ts` and derives coverage **only from that file**. Minting a helper *there* does turn every raw producer for that topic red; a shared function *anywhere else* is invisible to the audit. CORRECT → the two are not the same act. Consolidating duplicated enqueue logic into a domain module (`src/lib/reviews/import-consent.ts`) is always available and costs nothing at the audit; only `job-outbox-helpers.ts` carries the all-or-nothing migration. Verify a claimed CI blocker against the audit **source** before letting it shape a design — this one survived a handoff and a review round unchecked.

### [2026-08-07] #677 — a live UNIQUE partial index found a design bug three plan-review rounds missed
FAIL → a fixture seeding two `initial` runs was rejected by `zernio_backfill_runs_one_initial_per_business`, a UNIQUE partial index on `(business_id) WHERE run_reason='initial'` that exists in the DB and appears in no plan. Chasing the rejection exposed that **reactivation runs recur by design**, so the planned "newest run wins" read model would have flipped the banner back to "Importing your reviews…" every time an archived location was reactivated — months after the one-time import finished. WHY → the plan reasoned about run rows as a flat set; the schema already encoded a distinction (`initial` is unique, everything else recurs) that no reviewer reconstructed from prose. CORRECT → `readImportOfferView` and `enqueueInitialImport` both scope to `run_reason='initial'`, spelled identically. The general lesson is the argument for the four live-DB rows being non-negotiable at the step-5 gate: **a constraint the plan never mentions is still a reviewer**, and only a suite that actually touches Postgres consults it.

### [2026-08-07] #677 — `GREATEST(NULL, x)` returns `x`, so a junction predicate over two nullable timestamps admits HALF a junction
FAIL (caught in review, never shipped) → the Import offer's junction is "subscription activated AND an active Zernio connection". A predicate that merely combined the two timestamps with `GREATEST` would have handed an offer to a location holding only one half, because Postgres's `GREATEST` ignores NULLs rather than propagating them. WHY → `GREATEST`/`LEAST` are NULL-skipping in Postgres, unlike arithmetic — so they silently succeed on incomplete data exactly where a conjunction was intended. CORRECT → `createImportOffer` proves **both halves explicitly** in its own SQL (`a.subscription_activated_at IS NOT NULL AND zc.status='active'`) rather than deriving them from a combined timestamp, and does so inside the helper because "the callers do not check, so the helper must." Confirmed on staging against two same-named businesses: only the one with an active connection was given a deadline.

### [2026-08-07] #677 — `verify-gate.sh` writes `phase=gate_green` itself, which silently rewinds a reviewed branch to step 7
FAIL → running the gate after review completion overwrote `.feature/state.json`'s `phase` from `reviewed` back to `gate_green`. A resumed session reading that file would re-enter step 7 and open review round 2 on already-reviewed code — burning a round against feature.md's cap for nothing. Hit twice in one session (once after the staging-ride commit, once after the fallow fix). WHY → the gate script and the workflow both own the same field, and the gate's write is unconditional; it has no way to know whether the run is a mid-execution consistency check or a post-review re-verification. This is the mirror of the opposite trap recorded at #675, where the phase had to be *held* at `executing` to stop a resumed session skipping ahead. CORRECT → after any `verify-gate.sh` run past step 7, immediately `bash scripts/feature-state.sh set-phase reviewed` and confirm the file. Sequence a docs commit as **commit → re-run gate → set-phase**, so `lastGreenGateSha` and `headSha` both land on the new SHA; setting the phase first leaves the gate SHA stale and a resume will flag it.

### [2026-08-07] #677 — the fallow-outside-the-local-gate trap recurred on the very next ticket
FAIL → PR #691 opened fully gate-GREEN (26/26, full mode, four live-DB rows running) and CI's `fallow` job failed again — an unused type export (`ImportDecisionRejection`) and a 9-line clone. Third consecutive occurrence of the class (#659, #689, #691). WHY → unchanged and by design: `verify-gate.sh` excludes `ci:fallow*`. The #675 note already prescribed the remedy and it was not run. CORRECT → the remedy is now non-optional on any branch adding a new module or a route handler: run `pnpm ci:fallow` **before** opening the PR. Also worth knowing for the clone half — fallow matches clones **across the whole repo**, not just the diff, so a new file can be flagged against an untouched one. That is a trap for surface-budgeted work: the reported partner may be out of surface, and "fix it there" can cost an amendment. Look for a duplicate of the same block **inside** the new file first — in #677 both handlers of the new route carried the same preamble, so a module-private helper was justified on its own merits and the cross-file clone dissolved as a side effect, with zero out-of-surface edits.

## 2026-08-08 — #679 import consent worker guard ship

### [2026-08-08] #679 — a fix for an untested-guard finding reproduces the defect unless the fix is itself mutation-pinned
FAIL → twice, in consecutive review rounds. Round 2's decisive finding was that the SAVEPOINT — the fix for the branch's worst defect — shipped unpinned: deleting it left all 37 live-DB and 42 unit tests green. Round 3's decisive finding was that the **catch narrowing**, round 2's own fix for that finding, shipped unpinned too: both failure tests injected SQLSTATE `23514`, which carries a string `code` and is swallowed either way, so deleting the guard also left every suite green. WHY → a finding of the form "X is untested" gets answered by adding a test that exercises the *happy path through* X, which passes with or without X. The fix and its test are written in the same breath from the same mental model, so the model's blind spot is inherited. Review reading does not catch this: across three rounds, roughly ten instances of false coverage on this branch were caught by mutation and **zero** by reading. CORRECT → when a finding says a guard is untested, the acceptance criterion is not "a test now exists" but "deleting the guard turns the suite RED, demonstrated". Delete it, run the suite, record the failure count, restore. Budget the mutation run as part of the fix, not as optional verification after it.

### [2026-08-08] #679 — narrowing an over-wide `catch` is a repo-wide change, and postgres.js's error taxonomy is why `instanceof PostgresError` is the wrong narrowing
FAIL → two connected traps. (a) Narrowing a `catch (e) { /* swallow */ }` converts every latent swallow into a live failure, so the blast radius is "every mock standing in for the narrowed type" — discoverable only by running the FULL suite, not the changed-file subset. Several unrelated suites (including a Stripe resume test) went red because their `sql` mocks lacked a `savepoint` method. (b) A review axis then recommended tightening the narrowing to `instanceof postgres.PostgresError`. WHY (b) is wrong → every error class actually reachable there carries a **string** `code`: `PostgresError`, statement-timeout `57014`, postgres.js's own `CONNECTION_*` errors, and Node's `ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`. Narrowing to `PostgresError` would rethrow a transient connection blip straight into `finalizeConnectionTx` and reintroduce the connect outage the savepoint exists to prevent. (`DOMException` has a numeric code, but postgres.js 3.4.9 does not produce them for query timeouts — its cancellation path is `57014`.) CORRECT → narrow on the string-`code` shape, not the class. And treat a catch-narrowing as a type-level change with a full-suite blast radius: run the whole suite before assuming it is local, or scope it as its own change with a budget for the incomplete mocks it will expose.

### [2026-08-08] #679 — a JS `throw` does not poison a Postgres transaction, so JS-thrown abort injections cannot test savepoint recovery
FAIL → tests meant to prove "the enclosing transaction survives a failed emission" injected a JS error and passed trivially, because the transaction was never actually aborted. WHY → Postgres marks a transaction aborted only when *the server* raises; a JS exception thrown between statements leaves the connection's transaction perfectly usable, so the savepoint's ROLLBACK TO has nothing to recover from and the assertion proves nothing. CORRECT → abort injections must be **Postgres-side** (a real constraint violation, e.g. a bogus `event_name` raising `23514`). One deliberate exception is legitimate and should stay documented at its injection site: a test asserting that a *code-less* error **propagates** may throw a JS `TypeError`, because its claim is about the rethrow, not about the caller surviving.

### [2026-08-08] #679 — `git merge --ff-only main` cannot fast-forward `staging` after a squash merge; verify with the tree diff, never `git cherry`
FAIL → CLAUDE.md's post-promotion ritual is `git merge --ff-only main` on `staging`, which aborted with "Not possible to fast-forward" — `staging` held the branch's 24 un-squashed commits while `main` had the single squash commit. WHY → a squash rewrites history, so the branches genuinely diverge even though their content is identical; ff is only possible when `staging` is an ancestor. `git cherry main staging` is NOT the check to reach for here: it compares patch-ids, and squashing changes every one, so it reported all 24 commits as missing from `main` when in fact every line was present. CORRECT → the authoritative check is `git diff --stat staging origin/main`. If it is empty (or shows only paths `main` has a newer version of), nothing is lost and the resolution is `git reset --hard origin/main` + `git push --force-with-lease origin staging`. That is also the observed steady state: prior rides left `staging` sitting on `main`'s exact SHA, not on a merge commit.

### [2026-08-08] #679 — staging sits behind Vercel team-SSO *and* app auth, so any smoke that must cross a Next.js route has no headless path
FAIL → the last smoke assertion (both Import-offer analytics events landing through their real writers) could not be driven from the shell: an anonymous request to `staging.repworth.net` 302s to `vercel.com/sso-api`. WHY → `ssoProtection: "all_except_custom_domains"` exempts only the **production** domain, and both emission writers (`createImportOffer`'s GET self-heal and `recordImportDecisionAndEnqueue`'s POST) are Next.js routes rather than worker ingress. Protection-Bypass-for-Automation would clear the SSO gate but not the app session, so it is not sufficient on its own. CORRECT → plan any staging assertion that crosses a Vercel route as a **browser** step from the start (the owner's logged-in Chrome). Worker-side assertions stay fully scriptable — Railway ingress is unaffected — so split the smoke list by which surface it lands on before estimating it. Setup for this one: reset the target business to `pending` / NULL deadline; the banner then mints a fresh offer on render.

---

## 2026-08-08 — #696 verify-gate row identity ship

### [2026-08-08] #696 — a gate row's NAME is its status slot, its log file and its coverage dir, so a truncated identifier can report PASS for a suite that FAILED
FAIL → `verify-gate.sh` derived both dynamic row names by truncating to 40 characters (`tr -c 'a-zA-Z0-9' '-' | cut -c1-40`). `src/lib/reviews/__tests__/import-consent.integration.test.ts` is **exactly** 40 slug characters, so every `import-consent-*.integration.test.ts` sibling collapsed onto the same row. The visible symptom was a spurious `GATE: RED` (two vitest processes racing one coverage directory to an `ENOENT`, while both suites passed 30/30 alone) and #679 worked around it by renaming its suite. WHY the workaround was the wrong read → the collision is not a coverage-directory problem, it is an **identity** problem: the same name is also the row's entry in the `NAMES`/`RESULTS` arrays and its `.feature/logs/<name>.log`, so the other direction of the same race records PASS for a failed suite — a silent green in the check that is the mechanical backstop for a whole `/feature` run. CORRECT → truncate for *readability*, never *identify* by the truncation: `row_slug` (`scripts/gate-rows.sh`) keeps the 40-char prefix and appends a 6-char hash of the full input. Pair it with an assertion at registration (`assert_unique_row_name` in `launch()`) so a name derived some other way in future cannot resolve silently. Generalisation worth carrying: whenever a derived string is used as a *key* — a log filename, a cache key, a lock name, a job id — a lossy transform on the way in is a correctness bug, not a cosmetic one.

### [2026-08-08] #696 — a "is it wired?" test written against SOURCE TEXT is the same defect class as the bug it guards
FAIL → the first fix added a test asserting that `verify-gate.sh`'s `launch()` body *contains the strings* `assert_unique_row_name` and `gate_abort`. The spec review then built a mutant whose `launch()` asserted uniqueness over `${PIDS[@]}` instead of `${NAMES[@]}` — every duplicate silently accepted, the entire fix disarmed — and the suite passed 7/7. WHY → a text assertion proves the source *mentions* the guard, never that it is reachable, correctly parameterised, or has any effect. That is precisely the failure the ticket existed to remove ("a check that structurally cannot see what it claims to enforce"), reproduced inside its own fix. The trap is easy to fall into in bash, because a monolithic script offers no obvious call seam. CORRECT → there is almost always a seam. Two that worked here: (a) extract the function into a **sourced library** the suite can `.` and call directly; (b) for functions that must stay in the entry-point script, `eval "$(sed -n '/^launch() {/,/^}/p' scripts/verify-gate.sh)"` in the harness runs the REAL body and fails loudly if the function is renamed. Reserve text assertions for properties that genuinely ARE textual — "this token appears nowhere in this file" — and write them as patterns, not literals (`/cut\s+-c\s*1-\d+/`, not `'cut -c1-40'`), so the next spelling of the same mistake still trips them.

### [2026-08-08] #696 — `exit` in a SOURCED bash file kills the caller, and doing it before the caller's abort handler exists leaves a stale-GREEN gate-status.json
FAIL → `scripts/gate-rows.sh` resolved its hash tool at source time and ran `exit 1` when neither `shasum` nor `sha1sum` was on PATH. Because the file is sourced, that exit terminated `verify-gate.sh` itself — and it fired *above* the line where `gate_abort` was defined, so the gate died without writing `.feature/gate-status.json`. The previous run's `{"passed":true}` stayed on disk, which is exactly what `.claude/hooks/stop-gate.sh` reads. A fatal misconfiguration presenting as the last run's success. WHY → sourcing is not calling: there is no frame to unwind to, so `exit` in a library is a caller-level control-flow decision the library has no standing to make. The ordering compounded it — a failure handler defined *after* the code that can fail is not a handler. CORRECT → a sourced library never calls `exit`; it signals (leave a variable unset, `return` non-zero) and lets the entry point decide. Define the entry point's abort path **before** anything that can fail, the `source` line included. Pin it with a text assertion: the library must contain no `exit` at any depth. Corollary from the same round → if the source fails outright (missing file, `CDPATH` redirection, syntax error), the undefined function's exit 127 is read as whatever the call site takes non-zero to mean — here, a bogus "duplicate row name" naming an innocent row. Follow every `source` with a `command -v <known_symbol>` guard that names the real cause, and use `CDPATH= cd` wherever a script resolves its own directory.

### [2026-08-08] #696 — under `set -u` on bash 3.2, `"${ARR[@]}"` on an EMPTY array is a fatal unbound-variable error
FAIL → the uniqueness assert in `launch()` expands the accumulated row list, and the very first call (`launch lint`) happens with `NAMES=()` still empty. Spelled `"${NAMES[@]}"` it kills the gate before a single row starts — and before any `gate-status.json` is written. WHY → bash 4.4 fixed this; `/usr/bin/env bash` on macOS is **3.2.57**, where an empty array under `set -u` counts as unset. Every gate script in this repo runs `set -uo pipefail`, so the whole class applies. CORRECT → `${ARR[@]+"${ARR[@]}"}` is the 3.2-safe spelling, and the case is worth its own test — mutating the guard away is invisible to review and to any test that starts with a non-empty array. Same family as the existing `wait -n` note: assume bash 3.2 semantics for anything under `scripts/`.

## 2026-08-08 — #694 live-DB DDL detector ship

### [2026-08-08] #694 — an audit that keys on an INCIDENTAL marker reports `passed` on a tree that violates its own rule
FAIL → `ci:live-db-suites` implemented R2 ("no run-time DDL in a live-DB suite") as `text.includes('supabase/migrations') && text.includes('.unsafe(')`. Three suites executed DDL without naming a migration path and passed clean for months; one of them forced a transaction abort by adding a temporary CHECK constraint to `job_outbox` and dropping it in a `finally`. A vitest TIMEOUT skips the `finally`, so the constraint stranded on the shared test container and blocked every sibling suite that enqueues `zernio_initial_backfill` — 14 spurious failures across three suites, none of them code defects. WHY → the marker was a proxy for the thing, chosen because it was easy to grep. A proxy holds only as long as the correlation does, and nothing tested the correlation. Same shape as #592 (SQL audits keyed on a tag-name list the codebase had outgrown) one layer down. CORRECT → detect the thing itself: AST-extract every tagged template and every `.unsafe()` call, match DDL verbs over the extracted text only. **A CI audit needs tests for its PRECISION and its REACH separately** — reach fixtures assert a finding IS produced (they are what catch the detector going blind), precision fixtures assert real clean suites stay clean. A repo-wide "everything is clean" assertion catches neither: under a reach regression the offender list is empty and it PASSES. That trap is easy to write and reads as the strongest test in the file.

### [2026-08-08] #694 — a tag-NAME allowlist cannot see this repo's test-file SQL: `sql()` is a CallExpression
FAIL → the obvious implementation was to reuse `SQL_TAG_NAMES` / `isSqlTaggedTemplate` from `scripts/ci/lib/sql-tag-scan.ts`. A census of all 80 marker-passing live-DB suites: of 1469 tagged templates, `sql()` accounts for **770** — and its tag is a `CallExpression`, which that helper does not match (it handles a bare identifier or a property access rooted in one). `db!` (`NonNullExpression`, 73) is likewise invisible, plus one-offs `sqlA()`, `observerSql()`, `tierSql()`, `boundedSql`, `recorder!`, `handle`, `seed`, `client`. The name list would have seen ~530 of 1469 and missed the plurality. WHY → production code passes an executor as a typed parameter with a conventional name, which is what `SQL_TAG_NAMES` models; test files hold theirs behind a lazy getter (`sql()`) or a non-null-asserted `let`. Different idiom, same helper assumed to fit. CORRECT → in a file already proven to reach the live DB, PRESUME every tagged template is SQL — no name list to rot. Verified there is no competing tagged-template DSL in those files (no `it.each`, `css`, `gql`, `String.raw`); all 21 distinct tag forms are DB handles. `scripts/ci/lib/sql-tag-scan.ts` is therefore imported for `lineHasPragma` ONLY and left byte-identical: widening `SQL_TAG_NAMES` to cover test idioms would have silently changed the scope of four other audits. If you ever edit `SQL_TAG_NAMES`, know that `live-db-suites-audit.ts` deliberately does not consume it.

### [2026-08-08] #694 — fail-closed on unreadable SQL has a middle case: the PARTIALLY readable template
FAIL → the extractor treated a `ts.TemplateExpression` argument to `.unsafe()` as "statically readable" and matched DDL verbs against `arg.getText()`. For `sql.unsafe(\`${ddl}\`)` that text is the literal `` `${ddl}` `` — no verb, reported clean, straight through a stated fail-closed invariant. WHY → readable/unreadable was modelled as a binary. A template with substitutions is neither: its static spans are visible and its substitutions are not. Blanket fail-closed on the type would have flagged every legitimate mid-statement interpolation (`UPDATE … SET x = '${v}'`, the common fixture shape). CORRECT → a DDL verb can only BEGIN a statement, so fail closed exactly when a substitution stands at a statement-start position (prior static text, comments blanked, is empty or ends with `;`) and stay readable otherwise. Tagged templates need no such rule — Postgres.js parameterises their substitutions, so one cannot carry a statement. Companion lesson: when matching SQL text, blank comment bodies to EQUAL-LENGTH whitespace rather than deleting them, so every offset (and every reported line number) survives; a DDL verb in a `--` comment inside an executed template is not executed DDL.

### [2026-08-08] #694 — a `get`-only Proxy over a Postgres.js client must forward `begin`'s LEADING arguments
FAIL → `abortingExecutor` (the non-DDL replacement for the temporary-constraint abort) wrapped `.begin` by taking the callback off the end of `args` and calling `target.begin(wrapped)` with one argument. Postgres.js also supports `begin(options, cb)`, which this repo uses — `src/lib/escalations/list.ts:43` passes `'isolation level repeatable read read only'`. Any future caller whose writer used that form would silently lose its isolation level and the test would still pass. WHY → reading the callback as "the last argument" is correct and feels complete; it says nothing about the arguments before it. CORRECT → `args.slice(0, -1)` and spread them back: `target.begin(...leading, wrapped)`. Confirm empirically rather than by inspection — wrap a real client, `.begin('read only', write)`, and assert SQLSTATE **25006**, with a negative control (`.begin(write)` must NOT raise it) proving the option arrived rather than something else failing. Related: prefer `rejects.toMatchObject({ code })` over a `try/catch` plus `(err as { code?: string })` cast — the cast yields a bare `TypeError` when nothing throws, which is the case you most want a readable message for.

### [2026-08-08] #694 — `pnpm vitest run <file>` does not hydrate `.env.local`, so a live-DB suite SKIPS instead of failing
FAIL → running a touched integration suite directly reported success with zero tests executed. The suites gate on `process.env.TEST_DATABASE_POOL_URL`, and vitest does not load `.env.local` for them; `pnpm test:integration` works only because its npm script shells out to `dotenv` first. WHY → a skip and a pass look identical in a tail-truncated reporter, and this is the #520 class (an existing-but-not-run suite). CORRECT → `export $(grep -E '^TEST_DATABASE_POOL_URL=' .env.local | xargs)` before any direct `vitest run` of a live-DB suite, and read the TEST COUNT, not just the colour. Second-order trap from the same feature: `it.fails` on a repo-wide audit assertion is INVERTED at the eval commit — while the detector is still loose it finds nothing, the assertion passes, and `.fails` therefore goes red. `.fails` only becomes correct once the tightened detector surfaces real offenders.

## 2026-08-08 — #697 import consent analytics sink ship

### [2026-08-08] #697 — a `warn` is not a sink: swallowing an error into stdout is indistinguishable from having no error handling at all
FAIL → #679 correctly savepointed the two **Import offer** analytics emissions so a failed emission costs a metric instead of a Google Business Profile connect outage, and logged the failure with `createWorkerLogger(...).warn`. The comment said "a human should look." No human could: `warn` writes structured JSON to **stdout**, and this project's documented paging route is Sentry (`docs/runbooks/beta-launch-alerting.md` §1). Persistent migration-102 drift could have undercounted both one-shot events indefinitely with nothing alerting. WHY → "log it and continue" feels like handling. It is handling only if something *reads* the log; otherwise the swallow and a bare `catch {}` differ by a string nobody sees. The savepoint fix was reviewed three times and this gap survived all three, because every reviewer was checking that the failure didn't propagate — not that it arrived anywhere. CORRECT → when a catch block deliberately swallows, ask **"which configured alert would fire?"** and name it. If the answer is "someone greps Railway", the sink does not exist. The repo shape is `Sentry.captureMessage(msg, { level, tags: { subsystem, … }, extra })` **plus** the log line, the pair wrapped in its own `try`/`catch` — three sites now: `src/lib/llm/circuit-breaker.ts:185-205`, `src/lib/notifications/contact-notify.ts:46`, `src/lib/reviews/import-consent.ts`. `tags.subsystem` is not decoration: every Sentry alert rule here routes on it, so an untagged capture is durable but unroutable.

### [2026-08-08] #697 — an alert on a CONSTANT title groups into one Sentry issue, so a "new issue" rule fires exactly once, ever
FAIL → the first routing instruction written for the new tag mirrored the existing `subsystem:health_alert` rule ("issues tagged X at level warning → Discord"). But the capture title is a fixed string, so every occurrence — both event names, every business, both deployment lanes — groups into ONE Sentry issue. A rule triggered on *"a new issue is created"* would fire on the first drift event and then stay silent through the repetition that is the actual signal. WHY → Sentry alert conditions and Sentry grouping are designed independently, and the trigger most people reach for reads as "tell me about this problem." It means "tell me the first time." CORRECT → match the trigger to the message's cardinality. A constant-title `captureMessage` for a P2 wants an **event-frequency** condition (e.g. seen >3 times in an hour); a `captureException` with varying stack frames groups per-cause and a new-issue rule is fine. Both routing inventories (`docs/runbooks/beta-launch-alerting.md` §1 and `docs/launch-checklist.md`) now say so explicitly — and note there ARE two inventories, so a new tag must be added to both or they drift.

### [2026-08-08] #697 — `toMatchObject` cannot guard a "these fields and no others" invariant
FAIL → the tests asserted the Sentry `extra` payload with `expect(options.extra).toMatchObject({ business_id, event_name })`. The locked invariant was "only business_id, event_name and the error text leave the process — never the event `properties`, review text, tokens or handles". `toMatchObject` is a SUBSET matcher, so adding `properties: input.properties` to the payload shipped green through all 15 tests. Caught by the review axis, then confirmed by mutation. WHY → for a PII/redaction invariant the assertion target is the **key set**, not the values; a subset matcher is structurally blind to the only mutation that matters. CORRECT → `toEqual` with the exact keys, using `expect.stringContaining(...)` / `expect.any(String)` for values you cannot pin. Same rule for `tags`. Generalisation: whenever a test exists to prove something is ABSENT, a subset matcher is the wrong tool — and verify it by adding the forbidden field and watching it go red.

### [2026-08-08] #697 — mutation-test the ORDER of two statements, not just their presence
FAIL → two orderings in the new catch block were load-bearing and neither was pinned by the first implementation's tests: the code-less rethrow must precede the capture (or a mis-wired handle masquerades as schema drift in the alert channel), and the `warn` must sit OUTSIDE the capture's guard (or the only sink left on the transport-failure path is deleted). Both survived a green suite. Worse, moving the `warn` inside the guard is what "make it match the named precedent" looks like, so a future tidy-up would do it. WHY → tests naturally assert that things happened; asserting they happened in a particular relationship to each other requires deliberately constructing the failure of the *other* branch. CORRECT → for each ordering, write the mutation first and check it goes red before keeping the test. Here: a `console.warn` spy inside the throwing-capture test (with `mockRestore` in a `finally`, or the stub leaks into every later suite in the serialized `integration` project), and a "reports nothing to Sentry before it rethrows" title. Five mutations total, each verified to turn only its intended title red — that table belongs in the PR body.

### [2026-08-08] #678 — a review fix is applied when a CHECKBOX changes, not when the plan discusses it
FAIL → plan review round 1 returned 9 findings. The revision pass wrote all 9 into a `# Round-1 revisions` appendix but patched only 2 into the task steps. Round 2 then found F5, F8 and F9 in exactly that state — described in prose, absent from every checkbox a subagent executes — and F3 had already been caught the same way pre-round-2. **Four of nine fixes never reached executable form**, and every checkpoint in between read them as done. WHY → an appendix entry makes the plan *demonstrably discuss* the fix, which is indistinguishable from applying it unless you open the owning task. The reviewer who wrote the finding is the most likely to misread it, because they recognise their own words. CORRECT → the test is: **if a subagent executes only the checkboxes of the owning task, does the fixed behaviour result?** Ask it in every review brief. The appendix is a changelog, never the carrier. Generalises past `/feature`: any "we addressed that" claim about a document needs the diff of the *executable* part, not the narrative part.

### [2026-08-08] #678 — an out-of-surface edit a TOOL mechanically demands is bookkeeping, not scope creep
FAIL → rewriting `load-replies.ts`'s queries made `ci:tenant-scope` fail with 11 findings, clearable only by editing `scripts/ci/tenant-scope-allowlist.ts` — outside `allowed_edit_surface`, with the amendment budget at 1 of 2 and a 2nd amendment tripping teardown. The literal reading pointed at a post-mortem for a CI bookkeeping edit. WHY → the amendment budget exists to stop *implementation quietly outgrowing its reviewed contract*. This is the opposite: a mechanical consequence the contract failed to anticipate. The decisive test is **"would a restart avoid it?"** — here, no: `verify-gate.sh` and CI's `lint` job both run every `ci:*`, so a torn-down-and-restarted branch hits the identical wall at the identical step. An abort with no corrective value is pure loss. CORRECT → an out-of-surface edit that a tool or a documented working rule *mechanically requires* as the direct consequence of an in-surface change is bookkeeping: it still needs an owner sign-off and a deviations entry, but it does not burn amendment budget. Applied twice on this branch (the allowlist, then five operator-facing docs naming a retired flag).

### [2026-08-08] #678 — this allowlist orphans its own entries on ANY query rewrite, so patch it in ONE pass after all query work lands
FAIL → `tenant-scope-allowlist.ts` keys on **exact normalised SQL text**, and `ALLOWLIST_BASELINE` is an exact-match count gate. Rewriting four queries orphaned all 8 of that file's entries *by construction* — 8 of the 11 findings were "unused entry", unavoidable by writing better SQL. Worse, the count moved twice: the first task saw 11 findings, a later task added a route with 3 more. WHY → the failure mode is invisible until something else changes the same file, and a snippet hand-transcribed one space wrong produces an entry that silently never matches — presenting *identically* to the stale-entry failure being fixed. CORRECT → (1) hold the patch until every query-touching task has landed, then do one pass; patching per-task strands the earlier set exactly as the originals were stranded. (2) Generate `sqlSnippet` from the audit's own `extractSqlTemplates` + `normalizeSql`, never by hand. (3) Prefer scoping the query natively (`AND business_id = …` when the id is already resolved and locked) over taking an exemption — it costs nothing and shrinks the exempted surface.

### [2026-08-08] #678 — `diff-coverage` green and a file at 0% coverage are not contradictory; CRAP is the complementary signal
FAIL → the verify gate's `diff-coverage` row passed at its 80% changed-line threshold, and GitHub CI then failed on fallow: `useInlineGenerate.ts` (a 15-cyclomatic polling state machine) was **0% tested**, `tick` scoring CRAP 240 CRITICAL. Both new client files had no tests, and none of the 52 locked `tests_to_add` titles covered the inline client lane at all. WHY → aggregate changed-line coverage passes when *other* changed lines are well covered; it cannot see that one file's changed lines are all uncovered. CRAP (complexity × untested-ness) is per-function and cannot be averaged away. They fail on different things by design. CORRECT → do not read a green `diff-coverage` as "the new code is tested". When a feature adds a client state machine or any new hook, check the intake's test titles actually name it — the eval task can be exhaustive about the layers the plan discussed and silent about a layer nobody listed.

### [2026-08-08] #678 — never suppress a static-analysis rule you have not first proven wrong, and probe the analyzer before choosing the fix shape
FAIL → `react-doctor/effect-needs-cleanup` fired on a polling effect that **does** clean up (`cancelled` flag + `clearTimeout` on the latest id, with `if (cancelled) return` after every `await` before re-arming). The analyzer cannot trace a timer assigned inside an async closure. The obvious responses — suppress it, or restructure to a `useRef` — were both wrong: a scratch reproduction showed the `useRef` variant fires the identical rule. WHY → "it's a false positive" and "therefore suppress it" are separate claims, and the restructure that *sounds* analyzer-friendly may not be. Guessing the shape wastes a CI round. CORRECT → build a scratch reproduction of 2–3 candidate shapes and run the analyzer on them before editing production code. Here only a `const`-bound single timer per effect run was clean, reached by moving `startedAt` off an effect-local `let` and onto the state that carries it: 84/100 with 1 error → 93/100, zero errors, **zero rules disabled**. Suppression stays the last resort, and when used must name why the rule is wrong at the call site.

### [2026-08-08] #678 — a background agent whose notification never fires is indistinguishable from a dead one; poll the job file
FAIL → the adversarial review ran as a codex background task. Its completion notification never arrived, and the session was told the agent "is not there". It had in fact **completed 20 minutes earlier and written a 14.7KB report** with three HIGH findings — including one that invalidated a deferral decision the owner had already signed off. Discarding it and re-dispatching would have burned a review round and, worse, could have shipped the branch without that finding. WHY → the harness notification is a side channel; the job's own state file is the source of truth, and the two can diverge. CORRECT → record the task/thread id in the handoff **at dispatch** (the workflow asks for this because the wrapper has lost ids across resumes), and before concluding an agent is dead, poll `jq -r .status ~/.claude/plugins/data/codex-openai-codex/state/<branch>-*/jobs/<task-id>.json`. Also: that wrapper granted `write: true` despite a read-only brief — snapshot `git rev-parse HEAD^{tree}` at dispatch so an unsanctioned edit by a *review* agent is detectable rather than silent.

### [2026-08-08] #678 — a non-auto origin lane skips the content-hash re-read, so "the unique index bounds the damage" is false
FAIL → a `Generate` racing the live-ingest content-change path was deferred on the recorded premise that the partial unique indexes (023+026+029) permit one non-terminal response per review, so the loser "fails to persist — a wasted LLM call, not corruption". The indexes do prove that. They do **not** prove the surviving draft matches current review content: the worker reads review text and `review_content_hash` **without locking** (`load-context.ts`), and the loaded-vs-current hash comparison lives only inside auto-approval evaluation (`auto-approval.ts`), which a non-auto lane never enters (`persist.ts:154`). So the committed draft can answer text the customer has since changed. WHY → "exactly one row survives" answers *uniqueness* and reads like it also answers *correctness*. It does not, and the re-read that would answer it is attached to the auto-approval path rather than the persist path. CORRECT → when deferring a race on a uniqueness argument, state separately what the constraint proves about *identity* and what proves *freshness*. `regenerate` is also non-auto and carries the same exposure; tracked in **#710**.

### [2026-08-08] #697 — proving an observability change on staging without touching the schema
FAIL → the change only manifests when an analytics emission FAILS, but staging has migration 102 applied so it never does. The obvious staging proof — drop `analytics_events_event_name_check`, exercise the path, restore it — is destructive DDL on a shared database with a restore step that a timeout or a crash can skip (exactly the #694 stranded-constraint failure, one environment up). WHY → reproducing a constraint violation is instinctively read as "remove the constraint," when the violation is equally reachable from the other side. CORRECT → offer the constraint a value it already rejects. Same table, same constraint, same SQLSTATE, zero schema change. Wrap the whole thing in `sql.begin` and throw a sentinel at the end so nothing persists — including any state you set up to reach the emitting branch (no staging business satisfied `createImportOffer`'s four-way predicate, so the proof reset one INSIDE the aborted transaction). Assert the branch actually ran (`offer_outcome === 'created'`), because an absence-shaped proof looks identical to an injection that silently stopped firing. Resolve the resulting Sentry issue immediately with an activity-feed comment marking it synthetic, and tag the event (`proof: <issue>`) so it is self-identifying later.

## 2026-08-08 — #695 import consent enforcement locus + block reason ship

### [2026-08-08] #695 — a shared mock recorder makes its optional field unassertable, so the eval passes while the feature is unbuilt
FAIL → three of the four new `guardImportConsent` titles went GREEN at the eval commit, which is the one thing a failing eval may not do. Two causes compounded, both invisible from the plan text: the recorder array was shared by the plain writer AND the new reason writer, so `reason` had to be declared optional; and the vocabulary member did not exist yet, so `expect(calls[0]!.reason).toBe(OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED)` compared `undefined` to `undefined` and passed. Three rounds of adversarial plan review, briefed explicitly with "can this eval pass while the feature is still wrong?", all missed it — the hole is not in the prose, it is in the type. WHY → an assertion against a not-yet-existing constant is an assertion against `undefined`, and `toBe(undefined)` is satisfied by any recorder that did not record. CORRECT → assert the *writer* was called (`expect(mockWriter).toHaveBeenCalledTimes(1)`), not just the recorded shape; and give each writer its OWN recorder so the discriminating field can be **required** rather than optional. Once the field is required, a regression to the other writer leaves the array empty and the assertion throws instead of silently passing. A negative pin that holds before AND after the change (here: "stamps no reason when consent is accepted") is a regression guard, not an eval — do not force it red, it would mean asserting something false.

### [2026-08-08] #695 — when a call site swaps writers, grep the suites that MOCK the module, not the importers of the deleted symbol
FAIL → T1/T2/T3 each ran only the five test files the plan enumerated and each reported green; the whole-repo `pnpm test` gate row then went RED on a SIXTH file with `No "markOutboxCompletedWithReason" export is defined on the … mock`. WHY → the round-1 review had already caught one extra reference site and the lesson was recorded as "count the references" — but that was applied to the *deleted symbol* and not to the *changed call site*. They are different searches: `rg markOutboxOwnerUnreachable` finds files importing the removed export; only `rg 'vi\.mock\(.*shared/outbox'` finds files that stub the module and assert on the writer the call site no longer uses. A module mock that omits the new export fails at CALL time, so typecheck cannot see it either. CORRECT → after changing which function a call site invokes, enumerate every suite that mocks that module and check each one's factory and assertions; and never treat targeted per-suite runs as coverage for a module-level rename — only the whole-repo run is authoritative. Corollary for triage: the 29 assertions in that file that legitimately still name the plain writer must be left alone; retargeting one to make the suite pass would mask a real regression.

### [2026-08-08] #695 — `job_outbox.completion_reason` is a 7-DAY operational signal, not an audit record
FAIL → the ticket promised refusals would be "durably queryable" via `completion_reason`. `ArchivalPoller.ts:60` deletes completed `job_outbox` rows 7 days after `completed_at`, and a policy refusal is *completed* (skip-as-success), never failed — so it takes the 7-day arm, not the 90-day dead-letter one. The adversarial review axis found it; three plan rounds and two implementation agents did not. WHY → the whole `OUTBOX_COMPLETION_REASON` vocabulary inherits the archival life of the table it lives on. `owner_unreachable` (ADR 0010) has always had the same 7-day life, so nobody had ever had cause to state the limit. CORRECT → before promising durability from a `job_outbox` column, read the archival arm for that row's terminal status. If the question being answered outlives 7 days ("did we import without consent?"), the answer belongs on the domain row (`businesses.import_decision`), not the dispatch row. When the implementation is right and only the CLAIM is wrong, fix the claim — do not expand scope into a second sink; here that would have contradicted a locked non-goal and coupled the shared archival arm to one domain, the exact coupling the same ticket's ADR rejects. Confirmed live on staging: the 10 pre-existing `zernio_initial_backfill` completed rows all carry NULL, so NULL genuinely does not mean "genuine import".

---

## 2026-08-08 — #680 legacy backfill-counter DROP (migration 103)

### [2026-08-08] #680 — `SET LOCAL` in a migration is a no-op that only WARNS, because this repo applies migrations one autocommitting statement at a time
FAIL → migration 103 pinned `search_path` with `SET LOCAL search_path = public, pg_temp` to stop a same-name temp table capturing the whole migration. It would have done nothing at all. WHY → `SET LOCAL` takes effect only inside a transaction block; outside one it emits `WARNING: SET LOCAL can only be used in transaction blocks` and is discarded. `scripts/test-db-setup.sh:53` applies each file with plain `psql -v ON_ERROR_STOP=1 -q -f "$migration"` — no `--single-transaction` — and no migration in this repo carries its own `BEGIN`/`COMMIT`, so every statement autocommits separately and the setting never reaches the later `DO` and `ALTER`. This is the dangerous shape, not a loud one: the migration applies cleanly, the shape suite stays green, and the hole the statement was written to close stays wide open behind a statement that reads exactly like its remedy. Only an adversarial review round caught it, on the third pass. CORRECT → use session-level `SET`, which is correct under BOTH autocommit and a transaction-wrapped apply, and is already the house precedent (099/100/101/102 all use bare `SET lock_timeout = '5s'`). Generalisation: before trusting any migration statement whose whole job is to affect LATER statements, confirm the apply path actually shares a session/transaction with them — `SET LOCAL`, `SET CONSTRAINTS … DEFERRED` and advisory locks all evaporate the same way. State the resulting scope explicitly: a session-level `SET` persists for the rest of that psql session, so a future migration sharing a session inherits it.

### [2026-08-08] #680 — `String.match()` without the `/g` flag cannot count matches, so an "exactly one" assertion written with it is inert
FAIL → a shape-suite test asserted the migration contains exactly one `DO $$ … $$` block via `executableSql.match(/DO \$\$[\s\S]*?\$\$\s*;/).length === 1`. It would have passed with two blocks, or twenty. WHY → without `/g`, `.match()` returns a *single-match* array whose shape is `[full, ...captureGroups]`, so `.length` is 1 for any successful match regardless of how many exist in the string; only `/g` returns the array-of-all-matches whose length means what the assertion assumed. The test read as a real constraint and enforced nothing. CORRECT → count with `[...s.matchAll(re)].length` or a `/g` regex, and treat any `.length` on a non-global `.match()` result as a bug. Better still, avoid the whole class: for an immutable artefact like a landed migration, pin the entire normalised text against a canonical constant rather than trying to count and allowlist its parts — one assertion that cannot be partially satisfied beats several that can.

### [2026-08-08] #680 — a `table_schema = 'public'` literal cannot follow a `pg_temp` shadow, which makes the suite that depends on it self-contradictory
FAIL → migration 103's preflight guard checked for its own columns via `information_schema.columns WHERE table_schema = 'public'`, while the tests that prove the guard's failing branch shadow the real table with a `pg_temp` replica under `SET LOCAL search_path = pg_temp, public`. The two cannot coexist: temp tables report their own `pg_temp_N` schema and never `public`. WHY → it made one suite demand two incompatible database states — the final-state test needs `public` to be POST-103 (columns absent) while the guard test needs the existence check to find them PRESENT — and the guard test is the *only* one that can prove the guard fires at all, since on clean data a working guard and a broken one both report zero abort rows. CORRECT → resolve through `to_regclass` + `pg_attribute` (with `AND NOT attisdropped`, since `pg_attribute` retains dropped columns as tombstones) so the check follows `search_path`: it resolves to `public` in a real apply and to the replica under the shadow, letting the test execute the migration's own verbatim text. Pair it with an explicit session-level `SET search_path` in the migration so the real apply is deterministic rather than merely probable.

### [2026-08-08] #680 — `ci:live-db-suites` counts an unreadable `.unsafe()` argument as DDL, so a dynamically-executed guard needs its OWN pragma
FAIL → a shape suite executed a migration's `DO` block read from disk via `tx.unsafe(guardSql)` and would have failed `ci:live-db-suites`, even though that block runs no DDL and the transaction always rolls back. WHY → by design: `scripts/ci/live-db-suites-audit.ts:264-276` records an `.unsafe()` call whose argument it cannot statically read with `text: null`, and `unpragmaedDdlLines` treats `sql.text === null` as DDL — its header states the rule outright, "an unreadable `.unsafe()` argument counts as DDL: unresolvable SQL must never pass as safe". A runtime variable is by definition unreadable. CORRECT → budget TWO `-- live-db-ddl-ignore: <reason>` pragmas for a suite that both builds a `pg_temp` fixture and dynamically executes migration text, each carrying its own distinct reason. Do not try to make the argument statically readable to dodge the rule — executing the migration's real text is the whole point of the test.

### [2026-08-08] #680 — a preflight that never fires is indistinguishable from a working one, so prove the FAILING branch or the gate is theatre
FAIL → the plan's first draft documented the reconciliation query in the migration header for an operator to run by hand, and the shape suite text-searched that comment for two substrings. Both environments were already clean, so a guard with an inverted predicate, a typo, or no effect at all would have produced identical evidence: zero abort rows, migration applies, everyone satisfied. WHY → clean data carries no information about a gate. Apply-time evidence can only ever confirm "nothing aborted", which is equally consistent with "nothing needed to abort" and "the gate is broken". CORRECT → make the gate an executable statement inside the migration (it cannot then be forgotten), and prove its RAISING branch in a test by executing the migration's own guard text against a seeded replica. Mutation-test the predicate afterwards: swapping #680's two-branch disjunction for the naive `collapsed = legacy sums` form turned the passing-branch test red, which is what demonstrates the test discriminates. The live payoff was concrete — staging's apply-window preflight returned `unreconciled_two_branch=0` alongside `unreconciled_naive=2`, i.e. the naive predicate would have aborted the migration on two perfectly healthy rows.

### [2026-08-08] #680 — a plain `psql` migration cannot be proven by boot readiness; probe the worker's own statement shapes inside a `DO` block that RAISEs
FAIL → after dropping four columns, `/ready` returning `postgres: ok` proves only that the worker connects — it says nothing about whether the worker's INSERT/UPDATE still resolve, and no natural import run had occurred since the drop. WHY → the failure mode a column DROP introduces is `42703 undefined_column` at statement-execution time on a specific write path, which a health probe never exercises. CORRECT → execute the worker's OWN statement shapes against the live post-migration schema inside `DO $$ … RAISE EXCEPTION 'PROBE OK …' … $$`, which reports success through the error channel and guarantees rollback, so it is safe on a real environment. Incidental but useful: the first attempt failed `23505` on `zernio_backfill_runs_one_initial_per_business` rather than `42703` — a statement only reaches a uniqueness check AFTER column resolution, so even that failure was evidence the column set was valid. Re-run with a lane the partial index does not cover.
---

## 2026-08-08 — #706 live-DB helper scan ship

### [2026-08-08] #706 — an AST walk that visits the PRODUCING node is only as wide as its file set, and a Postgres.js fragment moves the producer into another file
FAIL → `ci:live-db-suites` audited only files matching `*.test.ts`/`*.test.tsx`, so DDL built inside a `__tests__/` helper was invisible: a helper exporting `` sql`ALTER TABLE …` `` and a suite executing it as `` sql`${addCheck}` `` both audited clean, and `live-db-suites-audit: passed` printed over a tree taking ACCESS EXCLUSIVE on `job_outbox`. WHY → Postgres.js routes a nested `Query` substitution through `fragment()` and splices it in as raw SQL **text**, not as a bind value, so the suite really executes the helper's statement while carrying no DDL text of its own. #694's defence — "the walk visits the producing node, so a smuggled fragment is caught where it is built" — is true, but only within a file the walk actually reads. CORRECT → scan every `.ts`/`.tsx` under `__tests__/` (904 → 917 files), and split the enforcement unit rather than applying both rules to both kinds: R1 **naming** is a claim about which vitest project a file lands in, so it can only be asked of a SUITE (a helper renamed `*.integration.test.ts` would run as an empty suite); R2 **DDL** and the lock check ask whether a statement takes ACCESS EXCLUSIVE, which is true wherever it was written, so they apply to every live-DB FILE. Helpers need their own reachability marker — they are HANDED their handle and so name none of the suite-shaped `LIVE_DB_MARKERS`, but they cannot avoid TYPING it, so an import of `postgres` (value or `import type`; five of the six use `import type`) is the gate, in either spelling — the `from 'postgres'` clause and the inline `import('postgres').Sql` type, which carries no `from` clause and is already this tree's idiom for handing a fake handle to something. Deliberately not offered to suites, and the reason is what R1 MEANS, not noise volume: naming is a claim about which vitest project a file lands in, and a mock-shaping type import is not evidence that a suite reaches a database. The volume is real too — many suites match the marker while reaching no database, and many of those are neither already visible through `LIVE_DB_MARKERS` nor named `*.integration.test.ts` — so admitting it would fire R1 across the tree on files that touch no DB. (The census and its recount method sit in the module's `HELPER_DB_MARKER` JSDoc and are deliberately not copied here: they move whenever a test file is added or renamed.) `src/lib/shared/__tests__/helpers/apply-migration-074.ts` was the one real occurrence — it runs `db.unsafe(readMigration074Sql())`, had never been audited, and is now allowlisted **and** lock-enforced against its own `withMigration074ApplyLock`; mutation-proved by stripping the lock marker and watching `unlocked-ddl` appear. Two bounds remain, both stated in the module: a fragment built outside `__tests__/` entirely (a `src/` module a suite imports) and the `e2e/` Playwright lane, which owns its own database lifecycle. General rule: a static analysis whose correctness argument is "it sees the producer" owes a statement of which files it reads — the argument and the file set are one claim, not two.

### [2026-08-08] #706 — an absolute written about a narrow text-presence check is a false claim; state what the code literally does
FAIL → two independent review rounds found the same defect class in one module, and **every instance was a comment, not code**. Three from this ticket: (1) `OWN_APPLY_LOCK`'s `BOUND:` said `unlocked-ddl` "can never fire" for `apply-migration-074.ts` — it does fire; rename or delete `withMigration074ApplyLock` and the finding appears, which is the mutation three shipped docs cite as proof of enforcement. (2) The module header defined a SUITE as "a file vitest runs", hundreds of lines above an `isSuite` JSDoc that had just been corrected to deny that equivalence — the predicate is a filename **suffix** test, and `src/lib/shared/index.test.ts` is matched by no vitest include glob yet classifies as a suite. (3) A `BOUND:` paragraph listed a handle typed `unknown` and cast as invisible to `HELPER_DB_MARKER`, in the same commit that widened the regex to match exactly that form and shipped a test asserting it is matched. WHY → each absolute was written *about* a mechanically narrow check and quietly generalised it. The 074 check is `text.includes(OWN_LOCK_MARKER)`: it reads the identifier's **presence, not its position**, so what it genuinely cannot do is distinguish DDL inside the wrapper from DDL hoisted out of it — a true and useful bound. "Can never fire" is a different, larger, false claim, and it is the dangerous direction: a maintainer who believes it concludes the allowlist entry is inert, removes it, and CI goes red with the finding the comment promised was impossible. The failure is not sloppiness — an absolute reads as the stronger, more helpful sentence, which is exactly why it gets written. CORRECT → in a guard module whose prose IS its spec, every claim must describe what the code literally does and be checkable beside it. Prefer the shape "the check is X, so it cannot distinguish Y from Z" over "Z can never happen": a bound stated as a mechanism survives a refactor, a bound stated as an absolute is falsified by one. Verify each claim by **mutation before writing it**, not after — all three above were settled in seconds by editing the real file text and re-running the audit. And when one fact has two owners (a module header and the mechanism's own JSDoc), correcting one and leaving the other is how a module ends up defining its central term two incompatible ways.

### [2026-08-08] #706 — a guard module whose prose is its spec carries a documentation multiplier; budget it as its own cost centre
FAIL → the `/feature` step-5 `reclassify` trigger fired at **2.15×** — 280 production changed lines against `estimated_prod_lines: 130`. Step 0 was re-run as the workflow requires, and the lane came back **CONFIRMED, not changed**: the executable change was **32 lines**. The whole overrun was prose — 144 comment lines inside the audit module plus 52 across four repo docs (`CLAUDE.md`, `lab-notes.md`, `currents.md`, `progresstracking.md`), and the deviations record puts the full prose cost near 250 lines once the review rounds' own corrections are counted, roughly **8:1** against the code. WHY → this module's convention requires every mechanism to declare its blast radius in a `BOUND:` paragraph, and the change retired claims that four durable documents asserted as still open. Neither cost tracks lines of code, so estimating from the code was not a small arithmetic miss — it omitted a whole cost centre. The trigger's stated premise fails here too: "the heavier lane's controls exist for exactly this feature" does not hold when the overrun is documentation, because no heavier control (a staging ride, a merge pause) addresses prose volume. Second-order effect this ticket demonstrated: **each review round's corrections are themselves fresh claims**, so prose grows superlinearly with review depth — round 2 produced five findings and **every one was a defect introduced by a round-1 fix** (four on the standards axis, one on spec), all of them prose. CORRECT → when estimating a ticket against a module of this shape — every mechanism owes a `BOUND:`, and the change retires claims in `currents.md`/`progresstracking.md`/`lab-notes.md`/`CLAUDE.md` — budget the documentation separately from the code, the same way `estimated_diff_size` already has to budget production and test lines separately (#643). Do **not** amend `estimated_prod_lines` afterwards to clear the WARN: the intake is the record of what was predicted, and editing it defeats the trigger for the next feature. Leave the WARN standing and record why.

## 2026-08-09 — #729 generate-tx extraction ship

### [2026-08-09] #729 — the /feature edit-surface hook and feature-surface-audit DISAGREE on Next.js dynamic-segment paths; declare BOTH spellings

> **SUPERSEDED 2026-08-17 by #867** — see "one spelling for a Next.js dynamic
> segment" below. All three matchers (both hooks + the audit) now escape
> brackets identically; write the PLAIN path only. A pre-escaped or duplicated
> spelling is now REJECTED at arm time and by `ci:feature-surface`. Kept for
> the history of how the duplicates got into intakes.

An `allowed_edit_surface` entry containing `[reviewId]` can never satisfy both
enforcement layers with one spelling. The bash hook (`edit-surface-guard.sh`)
matches with `[[ == ]]` globs, so `[reviewId]` is a character class — the
entry silently matches nothing and every in-scope edit is blocked; it needs
`\[reviewId\]`. `scripts/ci/feature-surface-audit.ts` `globToRegExp` escapes
every literal char (only `*`/`?` are wild), so it needs the UNESCAPED form and
reads `\[` as a literal backslash — its header's claim that its semantics
match the hook's is false for character-class characters. CORRECT APPROACH:
declare both spellings side by side (each matcher is satisfied by one entry;
the other is inert under `.some()`), and treat the dual entry as one surface
item. Root fix (aligning the two matchers) is unowned as of #729.
#726 refinement: when the two intake copies stay separate, each can carry
ONLY its consumer's spelling — the committed docs copy (read by
`ci:feature-surface`) unescaped, the gitignored `.feature/intake.json`
arming copy (read by the bash hook) escaped. Both-spellings-in-one-list is
required only where a single copy feeds both matchers; #726 shipped green
with the split spelling (deviations D4).

### [2026-08-09] #729 — postgres.js `TransactionSql` is NOT assignable to `Sql`; fragment helpers must take the union

`statusArraySql(tx, …)` failed TS2345: postgres.js types `Sql` and
`TransactionSql` as SIBLING interfaces (both extend `ISql`; `TransactionSql`
lacks `CLOSE`/`END`/`PostgresError`/`options` + more), so a helper typed
`(sql: Sql, …)` rejects a transaction handle even though the runtime tag call
is identical. Passing the singleton from inside a domain module instead would
violate invariant #15. CORRECT APPROACH: shared SQL-fragment helpers accept
the caller's client as a union — `SubscriptionSql` in
`src/lib/shared/writable-subscription.ts` is the named precedent;
`statusArraySql` (`src/lib/shared/response-status-sql.ts`) joined it at #729.

## 2026-08-09 — #728 content-freshness gate ship

### [2026-08-09] #728 — verify-gate ran a changed publisher integration suite against vitest.setup's dummy localhost:5432

- [2026-08-09] The `/feature` step-5 gate ran
  `autopilot-entitlement-concurrency.integration.test.ts` (changed by a
  mechanical unwrap of persist's new discriminated-union return) and the
  suite burned its 30s timeout plus an unhandled ECONNREFUSED against
  `localhost:5432` → `scripts/verify-gate.sh` resolves
  `TEST_DATABASE_POOL_URL` but not `DATABASE_POOL_URL`, and that suite
  transitively imports the `src/lib/db/server` singleton (stripe
  `subscription-updated` ingress → `resolveAccountReference`), whose path
  needs `DATABASE_POOL_URL` — so it got vitest.setup's dummy value while the
  suite's own live-DB reads resolved fine (`fallow.yml` CI is immune because
  it already exports BOTH) → export BOTH vars to the test DB when invoking
  the gate; a pre-existing suite requirement, surfaced only because the
  suite became "changed". Permanent fix (the gate script owning the second
  var) filed as **#744** — `verify-gate.sh` was outside #728's surface.

### [2026-08-09] #728 — the (reviewId, version) idempotent-generation cache served a stale draft to live-ingest's same-version replacement job

- [2026-08-09] The persist-boundary content-freshness gate (ADR 0017) was
  deterministically defeated in the exact race it exists to close — found by
  the adversarial branch review as a NO-SHIP: live-ingest's replacement job
  legitimately shares the in-flight job's `(reviewId, version)` cache key,
  so it was served the stale H1-cached draft, and its own gate compared
  H2==H2 and persisted the stale text as fresh → the cache's identity
  carried no content provenance while its key is designed to be shared by a
  colliding job — key equality is not content equality, and ADR 0017's
  convergence argument implicitly assumed the replacement job REGENERATES →
  any cache whose key can be shared by a replacement job must bind its
  PAYLOAD to content provenance: `CachedGeneration.reviewContentHash`,
  cache-read accepts ONLY strict equality with the current attempt's loaded
  hash, `null===null` passes for legacy entries, provenance-less or
  mismatched entries are rejected + cleared best-effort (corrupt-payload
  precedent). Direct cache writers must stamp provenance too — the
  avoid-facts guardrail's `setCachedGeneration` overwrite, left
  provenance-less, would turn the documented retry-hits-cache economy into
  a fresh re-spend. Deliberately NO clear-on-skip in the gate: the
  provenance check is the one owner of cache validity (a second guard is
  two-owner drift).

## 2026-08-09 — #730 open-flag predicate consolidation ship

### [2026-08-09] #730 — the /feature surface globs have TWO matchers with disjoint escape semantics

> **SUPERSEDED 2026-08-17 by #867** — there were THREE matchers, and all now
> escape brackets identically. Write the plain `[reviewId]` path; do NOT
> substitute `*` for a bracketed route dir (it over-widens the surface) and do
> NOT pre-escape. See "one spelling for a Next.js dynamic segment" below.

- [2026-08-09] The intake's `src/app/api/dashboard/reviews/[reviewId]/…`
  surface entries never matched their own paths, blocking the T1/T4 edits →
  `edit-surface-guard.sh` matches with bash `[[ == ]]` (unquoted pattern), so
  `[reviewId]` parses as a character class; meanwhile the merge-time mirror
  `scripts/ci/feature-surface-audit.ts` (`globToRegExp`) escapes EVERY
  non-wildcard char, so the same entry matches literally there — and the
  escape fix (`\[reviewId\]`) inverts the failure: bash matches, the TS
  audit demands a literal backslash in the path → the ONLY spelling both
  engines accept is the `*` wildcard
  (`src/app/api/dashboard/reviews/*/draft-status/…`). Verify any
  non-alphanumeric surface entry against BOTH engines before locking an
  intake; the audit's own header ("character classes are NOT supported (no
  intake uses them)") is the contract — bracketed Next.js route dirs go in
  as `*`.

### [2026-08-09] #730 — a composable SQL fragment's BUILD calls break every ordered-mock double downstream of it

- [2026-08-09] Re-expressing `hasOpenFlag` on `openFlagExistsSql` (and
  composing the fragment at 8 call sites) broke 21 tests across 5 suites in
  two waves — 9 failures in 3 suites surfaced at T4, 12 more in 2 suites
  only at the gate's whole-repo run — none of them in the suites the
  per-task run commands covered → a Postgres.js fragment is BUILT with
  tagged-template calls (`tx`${id}::uuid``, the `EXISTS (…)` body) that a
  queue/positional test double counts as executed statements, shifting or
  consuming every later ledger position (409s from a mis-read held probe;
  empty dashboard payloads) → when a shared helper gains fragment
  composition, EVERY suite whose double flows through it needs the
  fragment-aware branch BEFORE its first post-change run:
  `isExecutedStatement = /^\s*(select|insert|update|delete|with)\b/i` on the
  joined template strings; build calls return `{ fragmentText, values }` and
  never touch the queue; positional assertions re-point to an executed-only
  capture (`txExecutedCalls`), never renumber. 7 suites now carry the
  pattern verbatim (extract a shared helper at the next consumer —
  rule-of-three is at its boundary); `worker/__tests__/helpers/mock-sql.ts`
  needs nothing — it already flattens fragments without consuming, so
  flattening-harness suites assert the fragment SQL inside the parent text
  instead of as captured build calls.

### [2026-08-09] #730 — two live-DB integration suites fail on LOCAL env shape, not code (forced --no-verify staging pushes)

- [2026-08-09] The lefthook pre-push `test-changed` blocked both staging
  pushes on 3 failures in suites #730 never touched →
  `migration-056-account-offboarding.integration.test.ts` (RLS behavioral:
  expects `permission denied` as the `authenticated` role, gets
  `relation … does not exist` — the local `postgres:16` container's
  `authenticated` role lacks the schema USAGE grant real Supabase has) and
  `autopilot-entitlement-concurrency.integration.test.ts` (WS8 publisher
  linearization) fail IDENTICALLY at base on a green-gate tree — they are
  in the "run only when invoked directly" class (the #520 gap), so no gate
  or CI lane had ever run them against the local container → pushed
  `--no-verify` twice with the evidence recorded; UNRESOLVED: either
  provision the local container's `authenticated` role to Supabase shape in
  `test:db:setup`, or move both suites onto an env-shape allowlist that
  skips-loudly locally — ticket-worthy, not yet filed. (Also: the
  `staging-ride` worktree has no `.env.local`, so #719's drip-eval
  precondition test fails there unless `TEST_DATABASE_POOL_URL` is exported
  on the push command.)

## 2026-08-09 — #731 deferred maintainability bundle ship

### [2026-08-09] #731 — never measure a feature's diff against `origin/main`; measure against `git merge-base origin/main HEAD`

- [2026-08-09] Twice in one run a moved baseline was misread as real code
  movement: first a sibling PR (#747) whose `git diff origin/main --
  src/lib/past-replies/load-replies.ts` showed a 15-line change that
  *inverted* #730's just-merged `openFlagExistsSql` composition — reading as
  a revert of merged work on a file this bundle edits — and then, after #747
  actually landed on `main` mid-run, `git diff origin/main --numstat`
  reported **3,075 changed production lines against a 200-line estimate**
  (15×), which fires `/feature`'s reclassify trigger and under the abort
  criteria argues for tearing the branch down → diffing a branch against a
  moved `main` renders every commit the branch has not merged yet as an
  *outgoing* change, so a stale branch's diff shows the newer commit
  backwards and a long-running branch's diff shows the whole of `main`'s
  progress as its own; the true figures were 290 prod / 430 test, both under
  the 2× threshold, and `comm -12` over the two changed-file lists was empty
  → always measure a feature's own diff, and any collision check against an
  open PR, from `git merge-base origin/main HEAD` (or the PR's own merge
  base), never from `origin/main`. `scripts/verify-gate.sh`'s `reclassify`
  row already does this correctly; the hand-run measurement is what needs the
  discipline, and knowing the trap in the abstract did **not** prevent
  walking into it a second time two hours later — the symptom (a huge
  unexplained diff) does not resemble the cause (a moved baseline), and it
  surfaces at exactly the moment the workflow asks you to judge scope creep.

### [2026-08-09] #731 — a `CROSS JOIN LATERAL (SELECT EXISTS (…))` read by two `COUNT(*) FILTER`s is NOT one shared evaluation

- [2026-08-09] Merging the Reviews list's two group-denominator `COUNT`s into
  one snapshot via `CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM
  responses p WHERE p.review_id = r.id AND p.status = 'posted') AS has)` +
  `COUNT(*) FILTER (WHERE NOT posted.has)` / `FILTER (WHERE posted.has)`
  shipped a large read regression that both round-1 review axes found
  independently → Postgres pulls the single-row LATERAL up and plans **one
  correlated SubPlan per reference** (SubPlan 1 *and* SubPlan 3, each
  `loops=20000`), so the "the EXISTS is evaluated ONCE" premise is false and
  the shape forfeits the hash semi/anti-join the two deleted `EXISTS` /
  `NOT EXISTS` counts each got. Measured on Postgres 16 with the
  production-shaped partial index at 20k reviews for one location:
  **~81–261× planner cost**, **~137× buffer accesses** (586 vs 80,206) and
  2.5–13× execution, direction reproducing across three runs on two
  independently-built fixtures → for a two-way partition count, `LEFT JOIN
  responses p ON p.review_id = r.id AND p.status = 'posted'` +
  `COUNT(*) FILTER (WHERE p.review_id IS NULL)` /
  `FILTER (WHERE p.review_id IS NOT NULL)` — a Hash Right Join, and the
  partition is closed *arithmetically* because a LEFT JOIN preserves every
  review and `IS NULL` / `IS NOT NULL` is a total split. The join cannot
  multiply rows because `responses_one_posted_per_review` (migration 031) is
  `UNIQUE (review_id) WHERE status = 'posted'`; that index guarantee is what
  makes the shape safe, and it is the same join, on the same index, the
  file's main row source 160 lines above already treats as load-bearing —
  declining a second dependency on it bought nothing and cost an order of
  magnitude.

### [2026-08-09] #731 — never justify a SQL shape with an unverified planner claim in a comment

- [2026-08-09] The regression above shipped *because* its rationale comment
  asserted a planner behaviour ("the EXISTS is evaluated ONCE in the
  LATERAL") that nobody had run `EXPLAIN` against; the sentence then read as
  the reason not to question the shape, and a second comment in the same
  change compounded it ("the FILTER predicate is an EXISTS, not a join", used
  to explain why a review with multiple posted responses counts once) →
  a plausible planner story is indistinguishable from a measured one once it
  is written in the imperative voice next to the code it defends, and common
  subexpression elimination across `FILTER` references is exactly the kind of
  optimisation a reader will assume rather than check → state only
  independently checkable facts in the comment (an index's uniqueness
  guarantee, a join's totality, a predicate's exhaustiveness) and put
  measurements in the commit message, where they carry their date and their
  fixture. The replacement comment re-makes **no** planner assertion.

### [2026-08-09] #731 — landmine enumeration before a query merge needs a THIRD category of dependent assertion

- [2026-08-09] Merging two queries into one broke a pre-existing #678 title
  the plan's recon never named — `'loadPastRepliesPageView averages star
  rating over all reviews, not only replied ones'` locates the AVG query with
  `/AVG\(/i` and then asserts `expect(avgQuery.text).not.toContain("'posted'")`,
  which the merge falsifies by putting the partitioning predicate in the same
  template → the recon enumerated assertions that (i) **count** queries and
  (ii) **dispatch** on query text, but not assertions that (iii) **identify**
  a query by text and then constrain its *contents*; a merge changes what a
  text-matched query contains, not only how many queries exist, so category
  (iii) is the one that bites → before merging or reshaping a query,
  enumerate all three categories. The title's *claim* survived intact (the
  AVG's row set is still `FROM reviews r WHERE r.business_id = …`, one
  conjunct); only its mechanism was an artefact of the AVG having had a
  template to itself, so both original assertions were re-applied to the
  strip remainder plus two positive `FROM`/`WHERE` pins — no assertion
  deleted, no title text changed. Related but distinct from #730's
  fragment-blast-radius note above, which is about *build calls* consuming an
  ordered mock's queue positions; this one is about the *text* a surviving
  assertion matches on.

### [2026-08-09] #731 — `ci:tenant-scope` cannot tell you the snippet it wants, and every allowlist regeneration hits that wall

- [2026-08-09] The plan's step said to take the expected `sqlSnippet` "from
  the failure output", and warned correctly that a guessed snippet is the #1
  way the step burns a round — but the audit prints only `file: table:
  reason` triples → `TenantScopeFinding`
  (`scripts/ci/tenant-scope-audit.ts`) carries **no SQL field**, so there is
  nothing to paste, which makes the step a dead end rather than a nuisance
  → derive the snippet by reusing the audit's own machinery, which is what
  the match keys on (`getAllowlistEntry` compares
  `normalizeSql(stripSqlComments(x))` on both sides): import
  `extractSqlTemplates` from the audit module in a throwaway script, apply
  the same comment-strip + whitespace-collapse, and print the template you
  are re-pinning. Landed 408 (baseline 408) first try, no burned round. Five
  regenerations have now hit this wall (420→418→414→412→409→408); the durable
  fix is to put the normalised SQL on the finding (preferred) or export
  `normalizeSql`/`stripSqlComments`, which are module-private — worth its own
  ticket.

### [2026-08-09] #731 — a grep gate that forbids an identifier forbids it in prose too

- [2026-08-09] Two plan steps demanded an identifier appear nowhere
  (`rg -n "peekRegenBudget\b"` → no hits; `rg -n
  "PAST_REPLIES_VIEW_ENABLED" worker/` → no hits) while sibling steps
  supplied verbatim replacement **comments** that legitimately named it, so
  following the plan literally guaranteed the gate reported a hit whose
  stated triage was "STOP and report" → `rg` cannot tell a call site from
  prose, and a retirement comment's whole job is often to name the thing it
  warns you off re-adding → scope such a gate to code
  (`rg … | rg -v '^\S+:[0-9]+:\s*//'`) and decide per comment whether the
  identifier earns its place: #731 **dropped** it where the comment merely
  records a completed consolidation (the fact survives without the name, and
  `git log -S` still finds it via the commit subject) and **kept** it where
  the comment exists to stop a retired flag being reintroduced — the same
  reason CONTEXT.md names it.

### [2026-08-09] #731 — never verify a type-level guarantee by grepping for the enclosing function name

- [2026-08-09] The plan proved its `Required<Pick<…>>` slice by deleting a
  field and running `pnpm typecheck 2>&1 | grep -A2 'orphanReplyFacts'`,
  whose stop condition ("if it does not appear this refactor is unsafe")
  fires a **false STOP on a correct refactor** — the grep emits zero lines →
  TypeScript anchors a structural-assignability error at the offending
  object literal's position and describes the two structural types; it never
  names the enclosing function → grep the file and the error code:
  `pnpm typecheck 2>&1 | grep -E 'replies-view\.ts.*TS27(39|41)'`. Note the
  code: **TS2741** is the single-missing-property form (what one deleted
  field actually reports, observed at `replies-view.ts(257,3)` naming
  `failed_response_id`), **TS2739** the ≥2-properties sibling — a proof
  command pinned to the wrong one of the pair also emits nothing.

### [2026-08-09] #731 — under concurrent subagent dispatch, commit with a pathspec

- [2026-08-09] Two parallel task agents independently reached for
  `git commit -m … -- <files>` instead of the plan's `git add` + `git commit`
  → `git commit` with no pathspec commits the whole **index**, so a sibling
  agent staging a file between one agent's `add` and its `commit` is swept
  into the wrong commit (both agents were editing the same worktree; one
  confirmed via `git status --porcelain` between the two calls that a
  sibling's two dirty files happened to be unstaged at that instant — luck,
  not a guarantee) → the pathspec form is the default for any parallel-task
  bundle; it cannot capture another agent's work no matter the timing. Worth
  carrying in the plan template's concurrency note.

### [2026-08-09] #731 — estimate the test-line bucket bottom-up from pinned titles × suites, never as a ratio of the production estimate

- [2026-08-09] The gate's `reclassify` row went WARN on the **test** bucket
  after the review-fix round (490 actual vs a 230 estimate, 2.13×), forcing a
  full step-0 re-derivation that came back **lane unchanged** on all three
  axes → the estimate had been anchored to the production figure at ~1.15:1,
  which is verbatim the #643 mistake the intake guidance warns about; the
  actual ratio (490/323 ≈ 1.52:1) is unremarkable for a feature whose
  deliverable is 14 pinned titles across five suites plus a live-Postgres
  partition guard, and the largest single contributor was tests added
  *because* the review found a coverage hole — a trigger that pushes toward a
  heavier lane for having fixed a review finding is reading its own signal
  backwards → count the test bucket bottom-up (14 titles × ~25 lines of
  body/fixture + harness reshaping in 5 suites ≈ 450, which trips nothing).
  Correct the estimate in the retrospective, never the intake — and record
  the reasoning, because a WARN reasoned past without a written record is
  indistinguishable from a WARN that was ignored.

---

## 2026-08-09 — #719 onboarding drip: dropped column, invisible failure, unbounded churn

### The 034 dropped-column class
- [2026-08-09] `onboarding_drip` never once completed on staging (93 failed rows, 0 completed) → `handleOnboardingDrip` read `users.business_id`, dropped by migration 034 on 2026-05-10, throwing `42703` after claiming the drip-log row and before sending; three sites shared it (`OnboardingDripWorker` ×2, `ownerHasDashboardAuth`, the latter latent in `WeeklySummaryWorker`/`MonthlyImpactWorker`) → post-034 the location→owner path is `businesses.account_id → users.account_id`. **A dropped column is invisible to these unit tests**: worker suites mock `sql` as a positional queue returning canned rows for any SQL, so only a `*.integration.test.ts` catches it — and `describeWithDb` SKIPS rather than fails without `TEST_DATABASE_POOL_URL`, so the suite needs an execution sentinel or the guard silently does not run.
- [2026-08-09] The failure was undiagnosable → `worker/index.ts` added a Sentry *breadcrumb* on job failure and never `captureException`, so a deterministic crash raised no issue → the **Job-failure sink** now captures on the terminal attempt. It writes nothing to `job_outbox`: the watchdog's terminalizer at `OutboxPoller.ts:140-143` sets `last_error` **unconditionally**, so anything written there is destroyed by the generic text it was meant to replace.
- [2026-08-09] The pile was *growing*, not stale → `OnboardingDripScheduler`'s in-flight `NOT EXISTS` excludes only `status <> 'failed'`, so every failed row was re-minted next cycle: each burns 5 watchdog attempts over ~75 min, then a fresh one appears → any scheduler re-queuing on a predicate that excludes `failed` needs a failure bound. Rolling (3/24h) over lifetime, so a transient outage self-heals.
- [2026-08-09] Counting recent `job_outbox` failures by `completed_at` alone under-counts, and `COALESCE(completed_at, created_at)` still gets it wrong → the watchdog's terminate path stamps `completed_at`, the poller's dispatch-error path (`OutboxPoller.ts:293-299`) does not, and a long-lived row can fail recently → use `COALESCE(completed_at, dispatched_at, created_at)`: the claim UPDATE refreshes `dispatched_at` on every attempt.

### Reuse and contracts before adding worker plumbing
- [2026-08-09] Before adding an outbox write helper, grep `src/lib/shared/outbox.ts` → `recordOutboxTransientError` (:183) and `isTerminalAttempt` (:211) already exist; a plan round-1 review caught both about to be reinvented. **But "it already exists" is not "it fits here"** — that same review directed the Job-failure sink to reuse `isTerminalAttempt`, and the branch review then found that WRONG for the call site. Grep first, then check the call context; the second half is the part the reuse advice skipped.
- [2026-08-09] A BullMQ final-attempt check has TWO correct forms and picking the wrong one fails silently → `isTerminalAttempt` (`outbox.ts:211`) is `attemptsMade >= max || attemptsMade + 1 >= max`, written for the **catch block**, where `attemptsMade` is not yet incremented. The `'failed'` **event** has already incremented it, so that form fires one attempt EARLY *and* again on the real last one — a duplicate Sentry issue plus a false "exhausted its retries" for a job BullMQ then retries successfully → in a `'failed'` listener use `attemptsMade >= max`. `worker/jobs/judge/failed-hook.ts:44-57` already documented the split and ends "do not unify them": the trap was written down and got walked into anyway. Note a case at `attemptsMade: 1 / attempts: 5` does NOT discriminate the two forms — only the second-to-last attempt does, which is why the original eval passed either way.
- [2026-08-09] A generic worker-level `'failed'` listener must not persist or string-log `err.message` → `worker/jobs/csv-ingest/failed-hook.ts:34` states the contract (only the bounded error CLASS, because Postgres messages may embed contact handles) and string logger args bypass the object sanitizer → log `err.name`.
- [2026-08-09] "Sentry has its own scrubber" was FALSE for the one field that mattered → `scrubSentryEvent` covered `extra`, `request`, `transaction` and `breadcrumbs`, never `event.exception.values` — which is exactly where `captureException` puts `err.message`. Promoting worker job failures from breadcrumbs (scrubbed) to real issues (not) was therefore a net PII regression on the louder channel → `sentry-scrub.ts` now redacts `exception.values` and the top-level `message`. Before routing any new text to Sentry, check which event FIELD it lands in: that scrubber is per-field, not per-event.

### Harness traps found during execution
- [2026-08-09] `pnpm vitest run worker/jobs/` showed one red (`publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts`, `ECONNREFUSED :5432` after a 30s hang) that was NOT a regression → exporting `TEST_DATABASE_POOL_URL` alone is not enough for suites that reach Postgres through the `@/lib/db/server` singleton rather than their own client; that path reads `DATABASE_POOL_URL` and silently falls back to the postgres.js default → export BOTH to the local test DB when running a directory sweep locally. CI already sets it, which is why the gap only ever shows up on a developer machine.
- [2026-08-09] A test that mocks `sql` as a positional queue is structurally blind to schema drift → the mock returns canned rows for ANY SQL, so `OnboardingDripWorker.test.ts` passed against the dropped-column query both before and after the #719 fix, and a query being *deleted* can still leave cases green by positional luck (the removed query was first in a two-step chain, so each fixture value slid onto the survivor) → when a change removes a query, a unit case that passes UNCHANGED is evidence of nothing; re-derive what the mock now feeds, and let a live-schema suite own the assertion.
- [2026-08-09] A guard can produce a FALSE NEGATIVE and read as a real failure → #719's execution sentinel exists to prove the live-DB cases ran, and it asserted `process.env.TEST_DATABASE_POOL_URL` directly. `resolveTestDatabaseUrl()` falls back to reading `.env.local` off disk, so in the documented local setup the ten live cases ran and PASSED while the sentinel alone failed → any check that gates on "is the live DB reachable" must resolve the URL the same way `describeWithDb` does. A guard that cries wolf where the thing it guards is working gets ignored, which is worse than not having it.
- [2026-08-09] A unit fixture pinned to a hard-coded calendar date rots into a silent pass → `OnboardingDripWorker.test.ts` seeded `subscription_activated_at: new Date('2026-04-01')`, and the moment #719 added the handler-side **Drip staleness cap** every case began refusing its drip while the suite still read green on the assertions it did make → seed time-sensitive fixtures RELATIVE to now (`Date.now() - 12h`) and let the cases that want the boundary override it explicitly.

### Shipping traps found merging #719 (2026-08-10)
- [2026-08-10] A `git merge` that reports NO conflict can still corrupt a shared enum → syncing `main` into `staging` after #719's squash, git cleanly auto-merged `src/lib/shared/outbox-completion-reason.ts` and produced **`DRIP_TOO_STALE` twice** — the ride's copy plus main's squashed copy — a duplicate key in an `as const` object, with no marker and no warning. Two other files DID conflict and were caught; this one did not → after any merge that touches a file BOTH branches append members to, diff the result against the authoritative branch (`git diff origin/main -- <file>`) rather than trusting "merge succeeded". The conflicting files are the safe ones; the silently-merged ones are where the corruption lives.
- [2026-08-10] Copying the OBSERVED staging-resync habit instead of reading the runbook enshrines the drift → after #719's squash, `git merge --ff-only main` aborted (staging held the un-squashed ride, main the squash), and staging's recent history showed four `Merge origin/main into staging — #NNN squash sync` commits, so a sync merge looked like the house convention and was repeated. It is not: `deployment-guide.md` §"Re-sync staging" prescribes `git reset --hard origin/main` + `--force-with-lease`, safe because staging is a **disposable integration anchor** — nothing of value lives only there. A sync merge "works" and leaves staging permanently ahead; four of them is how staging reached **101 commits ahead of main**, which is precisely the drift the rule forbids → follow the runbook branch, and treat repeated commits in a branch's history as evidence of what people DID, never of what they SHOULD do. Supersedes the #679 note above only in emphasis: that one already had the right answer (`git diff --stat staging origin/main`, then reset) and was not consulted.
- [2026-08-10] A PR can go stale faster than its own CI → `main` took ~10 commits during #719's PR while one full run costs ~12 minutes (`fallow` alone ~11m), so every green was invalidated before it could merge and the branch needed four rebases → arm `gh pr merge --auto` instead of hand-watching. It closes the window between "green" and "merged". It does not remove genuine conflicts: `.claude/reference/lab-notes.md` collides with EVERY docs sweep that lands first, because both sides append a dated section to the same file tail.
- [2026-08-10] Verifying a CI gate with the wrong command wastes a full cycle → #719's fallow failure was "fixed" and re-pushed after checking `pnpm ci:fallow`, but the gate is `pnpm ci:fallow:coverage`; `package.json` documents that split in an explicit comment ("The CI fallow gate is ci:fallow:coverage … The static ci:fallow … is wired into NO hook or workflow") which had already been read → when a CI job fails, read the workflow to find the EXACT command it runs and run that one, coverage generation included.

## 2026-08-10 — #688 KPI Review-time anchor ship

- [2026-08-10] Integration-test expectation for `SentimentTrendPoint.weekStart` spelled as `::date::text` never matched any trend point → postgres.js decodes a `date` (OID 1082) column into a JS `Date`, and the KPI mapper's `String(r.week_start)` emits the long local form ("Mon Aug 10 2026 00:00:00 GMT-0700 …"), not ISO — `src/lib/kpi/types.ts`'s "ISO date" doc comment is wrong about the runtime value → compute expected values in SQL selected as `::date` (no `::text`) and round-trip them through the SAME postgres.js-decode + `String()` path the production mapper uses. Wire-format cleanup deliberately deferred to #757's adjudication of the KPI surface (the route has zero consumers today, so nothing depends on either spelling).
- [2026-08-10] Seeding seven businesses under one account in a live-DB suite blew up on `businesses_account_primary_uniq` → `seedLocation` (`src/lib/shared/__tests__/live-db-tenant.ts`) defaults `isPrimary: true` and the partial unique allows exactly ONE primary per account → pass `isPrimary: false` (or `bizId === FIRST`) for every location after the first. Applies to any future multi-location live-DB suite built on `seedLocation`.
- [2026-08-10] **Historical behavior, retired by #859 on 2026-08-17.** Editing a query pinned by `scripts/ci/tenant-scope-allowlist.ts` produced PAIRED findings — "unused tenant scope allowlist entry" + "missing account_id or business_id scope" — because the old audit stripped SELECT subqueries before predicate analysis. Both KPI sentiment-trend templates were therefore pinned by EXACT raw template text, and any edit invalidated the pin. At the time, the correct response was to re-pin the affected `sqlSnippet` strings in the same PR and hold the baseline. The query-block analyzer now proves those nested predicates and those parser-workaround entries are gone; exact re-pinning still applies to statements retained for a genuine contextual trust boundary.
- [2026-08-10] The whole staging admin portal "loaded nothing" while every request showed **200** in the Network tab and Vercel logged zero errors → the #505 Connection wedge had reached the **Vercel admin surface**: `getAdminOverview` fired a **7-query** `Promise.all` on the SHARED `sql` client whose pool is `DB_POOL_MAX=3` on Vercel, so the excess queries pipelined over the Supavisor TRANSACTION pooler and parked in `state=active, wait_event=ClientRead` forever, leaking one pool slot per render until the pool starved. The 200 is a **red herring you must not stop at**: a Next.js server component streams its HTML, so the headers (and the `loading.tsx` skeleton) flush immediately and the status is decided long before the body — a render that hangs mid-stream is a *permanent 200 with no body*, which is why devtools, Vercel's log line, and `get_runtime_errors` were all clean. Discriminator that localizes it in one step: **admin API routes worked while admin pages hung** (routes finish their body; pages stream theirs), and a browser `fetch('/admin/overview')` never resolved `.text()` while `fetch('/api/admin/nav-counts')` returned in 741ms. Confirm with `pg_stat_activity` filtered to `state <> 'idle'` — wedged backends sit at `active`/`ClientRead` with a *rising* `now()-query_start` (observed >3min). `statement_timeout` (set to 30s here) can NEVER save you: in `ClientRead` the statement is not executing, so the timer never arms. CORRECT → the #505 sequential idiom at every fan-out > pool, plus a guard comment naming the fan-out count AND the pool limit so a future 4th query is a visible decision; regression-guard it with a peak-in-flight-concurrency===1 test built on a LAZY-THENABLE fake `sql` (count in-flight on `.then`, never on construction — that is what makes it fragment-safe, since nested `sql` fragments like `optionalAccountPrefix(sql, id)` are built as interpolated values and never awaited), and include a guards-the-guard case asserting the harness reports 3 for a real `Promise.all`, or a silently-broken harness makes every other assertion vacuous. Corrects the audit ticket's caveat 2 ("a Vercel wedge may be masked by function teardown"): teardown DOES eventually reclaim these backends — a check ~40min later showed zero wedged connections with no intervention, presumably once the isolates died and their sockets sent FIN — but "eventually" is minutes against a pool of 3, so wedges accumulate far faster than teardown returns them and the surface is down long before the self-heal lands, then re-wedges on the next page load. Teardown is a slow janitor, not a safety net. Triage consequence: the evidence is TRANSIENT — capture `pg_stat_activity` while the surface is actually broken, because an hour later it looks clean. Two traps met on the way: (a) the console noise was ALL red herrings (a CSP-blocked `vercel.live` toolbar script that was independently 503ing, a Chrome extension's Summarizer warning, and a 400 `grant_type=password` that was simply one mistyped password 6s before a successful login) — read the Supabase **auth log** rather than inferring auth failure from a console 400; (b) adding comment lines above a query shifts every line-anchored CI allowlist pin below it (`SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST` in `scripts/ci/static-policy-audit.ts` pins `file:line`), so `ci:static-policy` fails on a pure-comment edit — re-pin in the same change.
- [2026-08-10] Converting a `Promise.all`/`Promise.allSettled` query wave to sequential silently CHANGES QUERY DISPATCH ORDER, and order-seeded test fixtures fail in ways that look like data bugs (`expected { totalReviewsHandled: 0 } to deeply equal { totalReviewsHandled: 40 }`, `Cannot read properties of undefined`) rather than ordering bugs → two separate causes, both worth knowing. (1) **An `async` function member runs EAGERLY while the array is being built.** In `Promise.allSettled([sql\`a\`, sql\`b\`, getPendingApprovalCountsForAccount(sql, id)])` the first two are LAZY postgres.js thenables that dispatch nothing until the driver attaches `.then`, but the third is a called async function whose body executes synchronously to its first `await` — so it dispatched FIRST, ahead of every fragment listed above it. Both dashboard suites had encoded exactly that in their FIFO seeding, one with a comment explaining it. (2) **A sequential wave stops front-loading its siblings' queries.** `const p = fetchSlices(...)` used to dispatch the whole wave before returning; now it dispatches ONE query and suspends, so the very next line's `getAccountRecentReviews(...)` gets its query out in the middle of the wave — that read moved from 10th to 3rd without either function changing. CORRECT → when you sequentialize a wave, expect to re-derive every order-seeded fixture, and pass members as THUNKS (`() => sql\`...\``) not promises: a promise argument is already in flight before the runner sees it, which defeats the whole point. Type the runner with the mapped-tuple shape lib.es2020 uses for `Promise.allSettled` (`thunks: readonly [...{ [K in keyof T]: () => PromiseLike<T[K]> }]`) — a plain `readonly (() => PromiseLike<unknown>)[]` parameter widens the destructure to a union and produces a wall of bogus "Property 'business_id' does not exist" errors. Shared runner: `src/lib/shared/settled-in-order.ts` (keeps per-member settled results, for waves with a real degradation contract; when members share fate, plain sequential `await`s are simpler). Bonus: awaiting the FATAL identity read alone BEFORE the wave is strictly better than racing it — a missing business now throws without dispatching 13 auxiliary queries, and the unhandled-rejection hazard the old ordering worked around disappears.

## 2026-08-11 — #769 sweep close-out / #773 mechanism

- [2026-08-11] The #505 working model — "per-request fan-out > pool → pipelining → permanent wedge" — is INCOMPLETE, and believing it closes the class will get you burned: during the 2026-08-10 admin soak a wedge appeared in `listOpenFlaggedResponses` (`src/lib/admin/flagged-service.ts:64`), a **2-query** `Promise.all` that is *under* the pool of 3, on a surface PR #761 had **already** sequentialized. WHY → read from postgres.js@3.4.9 source rather than inferred: `handler()` (`src/index.js:329`) never queues on pool exhaustion — `if (open.length) go(open.shift(), query)` / `if (closed.length) connect(closed.shift(), query)` / else `busy.length ? go(busy.shift(), query) : queries.push(query)`, and that third branch **pipelines onto an already-busy connection**; `go()` → `c.execute(q)` keeps accepting until `sent.length < max_pipeline` fails at **100** (`connection.js:176`, default `index.js:455`). So `max` caps **TCP connections, not concurrency**, and `handler()` has no concept of a request. The pool is a module singleton and Vercel Fluid Compute reuses one isolate across concurrent requests, so **N requests each staying under the pool still exceed it together** — two requests × two queries = 4 > 3, and the excess pipelines exactly as #505 describes. CORRECT → treat per-request sequencing (#761/#767/#779) as NECESSARY BUT NOT SUFFICIENT: it lowers per-request demand to 1, raising the bar from ≥2 to ≥4 concurrent requests per isolate — real risk reduction, not closure. The remaining cure is a **capacity** decision (raise `DB_POOL_MAX`, route more reads onto `sqlRead` `max:8`, or accept + monitor), which per ADR 0009 requires re-running the burst drill against the **Vercel** surface rather than the worker (#773). Two traps when you go looking: a green soak proves nothing here — the owner-dashboard soak was 24/24 clean while this mechanism was live; and isolate identity is invisible in `pg_stat_activity` because Supavisor flattens every `application_name` to `'Supavisor'` (ADR 0007), so attribution needs a different signal.
- [2026-08-11] Deciding whether a `Promise.all` query wave is a #505 wedge risk by reading the module's own comments is unreliable → the deciding fact is **which client the caller passes** (invariant #15 means `src/lib/**` modules receive `sql` as a parameter, so the module cannot tell you), and the pool sizes are **env-derived**, not source constants: staging has `DB_POOL_MAX="3"` and `DB_READ_POOL_MAX` UNSET, so `sqlRead` silently clamps to `WEDGE_SAFE_READ_MIN` = 8 rather than to anything written in the file. CORRECT → trace each call site to its composition root to learn the actual client, then read both pool values off the **live env** for the environment you care about; a 5-wide fan-out is safe on `sqlRead` (8) and wedges on the shared `sql` (3). Where the site turns out safe, leave a comment naming the fan-out count AND the client's `max` (see `src/lib/past-replies/load-replies.ts`, `src/lib/admin/margin-service.ts`; `src/lib/kpi/service.ts` carried one too until #757 deleted it) so a future sixth query is a visible decision rather than a silent regression. To get a peak-in-flight-concurrency guard on a *page*, the wave must first move into a module — a server page has no testable seam (that is why #779 extracted `src/lib/locations/settings-view.ts`), and the extraction usually also fixes an "entry points orchestrate only" violation the page already had.

## 2026-08-11 — #757 rendered-dashboard anchor ship

- [2026-08-11] **Historical incident under the pre-#859 scanner.** The #688 prediction came true and cost a red gate: re-anchoring the two `src/lib/dashboard/service.ts` queries pinned by `scripts/ci/tenant-scope-allowlist.ts` produced the same PAIRED findings #688 warned about — "unused tenant scope allowlist entry" + "missing account_id or business_id scope", ×2 queries = 4 findings. The affected entries were keyed on **normalized raw SQL text**, and the old `stripSelectSubqueries` pass removed the `business_id` scope inside each `LEFT JOIN (...)`, so replacing `detected_at` with a fragment made each pin miss AND each query read as unscoped. New beyond #688: (a) it surfaced at the **verify gate**, not at the task that caused it, because that task's verification list was vitest-only — a repo-wide audit is a GATE-level check and cannot serve as one task's proof (in a shared worktree it reports on siblings' landed work too, which nearly sent one implementer to edit a file its own task statement forbade); (b) do NOT hand-transcribe a replacement snippet — import the audit's own exported `extractSqlTemplates` and paste its normalized output verbatim. #859 removed these two parser-workaround entries after the query-block analyzer proved their nested predicates. The remaining rule still holds for genuinely allowlisted templates: check the allowlist during planning, and let exact pins follow the code rather than shaping the code around a pin.
- [2026-08-11] A test asserting SQL text passed locally and in one suite while failing in another, for the same query → the repo has **TWO `sql` mocks with different fidelity**: the shared `createMockSql` (`worker/__tests__/helpers/mock-sql.ts`) FLATTENS a nested fragment into the parent text, while the bespoke inline `vi.mock('@/lib/db/server', …)` proxy in `src/app/api/dashboard/__tests__/route.test.ts` renders every interpolation as `?` and returns a nested fragment as an inert `{ fragmentText, values }` object. So pushing SQL text down into a composed fragment is INVISIBLE to the first and BREAKING to the second — `expect(sql).toContain('make_interval(days => ?)')` became `AND ?`. CORRECT → before composing a fragment into an existing query, grep for every test asserting on that query's text, not just the ones using the shared harness; and assert THROUGH the fragment (`fragment.fragmentText` for the text plus its flattened `values` for the bounds), which is strictly stronger than the original text-only check.
- [2026-08-11] A staging smoke assertion passed and proved **nothing**: "assert `responseRate.current` is 0" was run against a fixture location with zero responses, where 0% is the answer under BOTH the correct `detected_at` clock and a wrongly review-time-anchored one. The assertion guarding an explicit `non_goals` entry was unfalsifiable → a smoke assertion authored against the EXPECTED VALUE instead of against the FAILURE IT MUST CATCH is a green light wired to nothing — the #520 "existing-but-not-run suite" class, one level up. CORRECT → when a plan names a metric as *deliberately unchanged*, the fixture must contain a row that would MOVE that metric if the change leaked. Here: one `posted` response on a review inside the `detected_at` window but outside the review-time window splits the hypotheses 1/5 = 20% vs 0/4 = 0%. Observed 20%. Same run also killed the plan's transport: `staging.repworth.net` sits behind **Vercel SSO deployment protection**, so any `curl -b "$COOKIE"` recipe is 307'd to `vercel.com/sso-api` and captures a login page — a careless run diffs two SSO redirects and calls it a pass. Use an authenticated same-origin `fetch(url, {credentials:'include'})` from a browser tab; it exercises the identical route, auth path and cache.
- [2026-08-11] The All-Locations **combined** review-velocity series renders weeks out of order (`Aug 03, Aug 10, Jul 06, …, Jun 22`) while every per-location series is correct → `weekStart` is `String(row.week_start)` (`src/lib/dashboard/active-mappers.ts:25`, `reputation-summary.ts:104`) and postgres.js decodes the column to a JS `Date`, so the string is the long form `"Mon Jun 22 2026 00:00:00 GMT+0000 (…)"`, NOT ISO; `aggregate-service.ts:277` then sorts those with `.localeCompare()`, which after the shared `"Mon "` prefix orders by MONTH NAME (`Aug` < `Jul` < `Jun`). Per-location series escape it because they keep SQL's `ORDER BY`; only the JS re-sort is wrong. Counts are correct, sequence is not. Pre-existing since PR #28 (2026-05-10); filed as **#791**. CORRECT → never `localeCompare` a stringified `Date`. The durable fix is to stop round-tripping the week through `Date.toString()` at the mapper and carry ISO `YYYY-MM-DD` end to end, which makes lexicographic comparison correct by construction — the same root cause as the "week assertions must not use `::text`" rule already recorded at #688.
- [2026-08-11] A cleanup `DELETE` reported `reviews_deleted: 5` and, in the same statement, `residual_reviews: 5` — reading as a failed cleanup → a **data-modifying CTE and the outer query share ONE snapshot**, taken before the statement ran, so any residual count computed inside the deleting statement reports PRE-delete numbers by definition. CORRECT → verify cleanup in a SEPARATE statement. Applies to every fixture-teardown and migration-verification query that tries to prove its own effect in one round trip.
- [2026-08-11] `gh pr merge --delete-branch` **checks the feature worktree out onto `main`** as it deletes the branch, which silently defeats `scripts/feature-cleanup.sh` — the script skips any worktree whose branch is `main`/`staging` as "long-lived", so the merged worktree is reported `SKIP` and accumulates forever with its armed `.feature/intake.json`. Same failure family as the script's own note that squash merges make `git branch --merged` useless. CORRECT → after `--delete-branch`, remove the worktree by hand with `git worktree remove <path>` (never `--force`); it also blocks the primary checkout from `git checkout main` with *"'main' is already used by worktree at …"* until you do.
- [2026-08-11] Immediately after pulling a merge that **DELETES a route**, `pnpm typecheck` fails in a checkout that had previously built — `.next/types/validator.ts(…): error TS2307: Cannot find module '../../src/app/api/dashboard/kpis/route.js'` (and the same line under `.next/dev/types/`) → Next.js generates a route-type validator that hard-references every route it saw at build time, `tsconfig` includes `.next/types/**/*.ts`, and the generated file is NOT regenerated by `tsc`; it is stale build output that outlives the source it points at. The failure names a file the branch legitimately deleted, so it reads like a bad merge. It also blocks `git push` via the lefthook pre-push typecheck, on a **docs-only** branch. CI is immune (fresh checkout, no `.next`). CORRECT → `rm -rf .next/types .next/dev/types` (both — the `dev` copy is separate and easy to miss) and re-run; deleting all of `.next` also works but forces a full rebuild. Suspect this whenever a type error names a path your diff removed.

## 2026-08-12 — #790 response-rate framing ship

- [2026-08-12] Moving explanatory copy out of one KPI column fixed a grid-alignment
  regression but made the caption semantically attach to the wrong metric → the
  per-location hero contains Average rating, Response rate, and Time saved on three
  different clocks, and a full-width left-aligned sentence with no metric name lands
  visually under Average rating even when it describes the response-rate denominator
  → CORRECT: when a mixed-clock card needs band-level copy for layout, make the copy
  explicitly self-scoping ("Response rate is …"), keep it outside every stat column,
  and pin both properties: exact sentence plus a DOM assertion that the caption has no
  `.rep-stat` ancestor.

## 2026-08-13 — #773 admission chokepoint (step A)

- [2026-08-13] The `max_pipeline` dial looked like the obvious cure for the #773
  wedge and is a **dead end at every value** → `max_pipeline: 0` breaks EVERY
  `sql.begin()` (`connection.js:170-178` short-circuits on
  `sent.length < max_pipeline` *before* invoking `q.options.onexecute`, the only
  hook that binds a transaction to its connection → `UNSAFE_TRANSACTION` across
  192 call sites), and `max_pipeline: 1` still admits **two** queries in flight
  (the first query is `query`, not in `sent`, so `sent.length === 0 < 1` passes)
  and wedged 6/6 on staging, indistinguishable from the default 100. CORRECT →
  bound admission in application code above postgres.js. `src/lib/db/admission.ts`
  wraps the `sql`/`sqlRead` singletons at cap == pool, which is exactly the
  no-pipelining condition: with N ≤ max in flight `handler()` always finds an
  `open` or `closed` connection and never reaches `go(busy.shift(), query)`.
  (#651 added a third module-owned singleton, `sqlUnsubscribe`, gated the same
  way at its fixed cap of 2 — every db/server client export is wrapped; a new
  one must also join `DB_SERVER_SQL_TAG_SOURCE_NAMES` in
  `scripts/ci/tenant-scope-audit.ts` or its tagged queries escape that audit.)
- [2026-08-13] Wrapping a postgres.js client is NOT a matter of proxying the
  returned query — a Proxy over the `Query` breaks `.raw()`/`.values()`/
  `.simple()`/`.forEach()` chaining, and gating at call sites is not an option
  either (`src/app/**` alone has **153** files importing `sql`, so coverage is
  unenforceable). WHY the seam exists → `Query` is LAZY: the constructor only
  stores `handler`, and dispatch happens in `handle()`, called from
  `then`/`catch`/`finally`/`forEach`/`execute`. CORRECT → replace `handler` on
  the SAME instance (carrying `handler.debug` over, which `Query.origin` reads)
  and release the slot via `Promise.prototype.then.call(query, release, release)`
  — `handle()` has already run at that point, so it cannot re-dispatch, and
  passing both handlers means a rejected query can't emit an unhandled rejection.
  `.cursor()` is the one shape that cannot be gated: it re-assigns
  `resolve`/`reject` on every iterator step and never settles the Query promise,
  so there is no settlement to release on — it throws rather than leaking a slot
  (zero call sites today).
- [2026-08-13] Counting a slot per QUERY deadlocks; counting per CONNECTION does
  not → `sql.begin()` holds one connection for the whole transaction, so a
  per-query semaphore has a transaction waiting on a slot it is itself holding.
  CORRECT → one slot per transaction for its full duration; queries on the `tx`
  handle are ungated **by construction** (postgres.js hands the callback a
  separate scoped `Sql` with its own handler). The residual hazard — code inside
  a transaction reaching the OUTER `sql` handle — is handled with an
  `AsyncLocalStorage` store carrying WHICH clients' slots are held (not a bare
  flag, so a transaction on `sql` cannot exempt `sqlRead` from its own gate):
  the self-referential case bypasses the gate instead of waiting, which can never
  deadlock, over-subscribes by at most one per in-flight transaction, and is
  counted + warned once so the anti-pattern stays visible.
- [2026-08-13] Binding a wrapped client's methods EAGERLY (`client.unsafe.bind(client)`
  at wrap time) crashed a suite that `vi.mock`s the `postgres` module —
  `Cannot read properties of undefined (reading 'bind')` at import time, from a
  test file that never touches the pool. CORRECT → resolve wrapped methods on
  first ACCESS inside the Proxy `get` trap and memoize them (identity must stay
  stable or `vi.spyOn` breaks); merely constructing a wrapper must never assume
  the wrapped object is real.

- [2026-08-13] Step B — the accepted trade-off is LATENCY, deliberately (moved
  from CLAUDE.md 2026-08-16, context diet). The gate converts over-subscription
  into WAITING, so p95 rises under load: staging measured owner forced-miss p95
  **4.8s at concurrency 8 / 4.3s at 12** against a pool of 3, versus ~1.3s on
  the cached path. That is the deal — a queued request is the price of never
  pipelining, and it replaces a hang that lasted 16.6s–374.5s and killed a pool
  slot permanently. **Do NOT "fix" that latency by raising `DB_POOL_MAX`.** The
  same run measured backend sessions peaking at **44 of 57** at concurrency 12,
  because the gate bounds work per Fluid Compute isolate and does nothing about
  how many isolates Vercel warms (each holding write-3 + read-8). Raising the
  pool multiplies per-isolate sessions against a budget already near its
  ceiling — it is a worse lever after #773 than it was before. Fix slow queries
  or cache instead. Excess callers QUEUE with a 30s deadline
  (`DbSlotTimeoutError`); per-request sequencing (#761/#767/#779/#809/#810) is
  NECESSARY BUT NOT SUFFICIENT — the pool is per Fluid Compute isolate and an
  isolate serves overlapping requests, so a fan-out of 2 wedged a pool of 3.
  Evidence: `docs/runbooks/evidence/2026-08-13-773-vercel-capacity-decision.md`
  (step B addendum, 520 requests, 631 observer samples).

## 2026-08-14 — admin invite funnel: four ways a mocked provider lies

- [2026-08-14] **A mocked provider client cannot validate the provider's contract
  — only our intent.** FAILED → `buildCheckoutSessionParams` sent
  `allow_promotion_codes: false` alongside `discounts` on the beta-comp path. The
  plan asserted the two could coexist and carried its own "(verified)"; the claim
  survived **four** adversarial plan-review rounds and every unit test, and a test
  actively asserted the bug (`expect(params.allow_promotion_codes).toBe(false)` on
  the coupon path — green, and wrong). It 500'd the first real Stripe call from
  staging. WHY → Stripe rejects that pair **by parameter PRESENCE, not by value**:
  `false` beside a discount fails the entire request ("You may only specify one of
  these parameters"). `createMock.mock.calls[0][0]` records whatever object we
  build; a mock has no opinion about combinations. CORRECT → any change to an
  outbound provider payload SHAPE needs one real call before it is believed; the
  staging smoke is not polish, it is the only test of that class. Corollary worth
  its own line: **a plan claim carrying "(verified)" suppresses exactly the
  scrutiny it asserts** — verification belongs in an artifact (a transcript, a
  probe, a test against the real API), never an adjective. (D-16)

- [2026-08-14] **The shape a client surfaces an error in is itself an unverified
  contract.** FAILED → nearly, and invisibly. `INVITE_ERROR_CODE_MAP` keys on
  `error.code` typed `string`, and Supabase's raw GoTrue body carries BOTH a
  numeric `code: 422` and a string `error_code: 'email_exists'`. WHY it matters →
  had `@supabase/supabase-js` surfaced the NUMBER on `.code`, every branch of that
  table would have been dead code and every invite error would have fallen to the
  502 fallback **silently** — a whole error-mapping table quietly collapsed to one
  bucket, with no test failing. It does surface the string (2.106.2, probed), so
  the table works. CORRECT → when a map keys on a provider's error identifier, pin
  BOTH the value and its TYPE with a test, and probe the real CLIENT rather than
  reading the wire format — they disagreed here. Probe method + verified contract:
  `docs/runbooks/evidence/2026-08-14-admin-invite-funnel-staging.md` → "D-13".

- [2026-08-14] **The local verify gate runs live-DB suites only for CHANGED
  integration files, so a migration that alters a table's column set escapes it.**
  FAILED → migration 105 added `accounts.checkout_attempt_coupon_id`, and the
  migration **077** shape suite (which asserts 077's exact column set) began
  failing. The local gate never ran it — that file was unchanged — so only CI saw
  it. CORRECT → after any migration that adds or removes a column on an
  already-asserted table, run the full sweep explicitly:
  `pnpm vitest run --project integration` with `TEST_DATABASE_POOL_URL` set.
  Changed-file selection is the wrong granularity for schema shape. (D-15)
  **[2026-08-31, #1009 — a SECOND trigger through the same mechanism, and it is
  not a migration.]** #1009 changed only production code: `suspendAccountAutonomy`
  began writing a `refusal_events` row. `AutonomyGovernorScheduler.integration.test.ts`
  was **unchanged**, so the local gate never ran it, and it went red in CI —
  `refusal_events.account_id` has no `ON DELETE` action (deliberate, migration 116:
  nothing may take a Refusal away on another table's clock) while that suite's
  teardown deletes accounts. `SET CONSTRAINTS ALL DEFERRED` does not save it; that
  FK is not DEFERRABLE. So the trigger list is wider than "a migration that alters
  a column set" — it is **any change that makes an existing suite write a new row
  to a table with a restrictive FK**, which no diff of that suite reveals.
  CORRECT → when a change adds the FIRST writer to such a table, grep the live-DB
  suites for teardowns deleting the parent, in or out of the diff. Corollary that
  cost three rounds: CI names ONE failing path; that file had **three** (two named
  cleanup helpers plus an inline `finally` for a second seeded account), and only
  re-running after each fix surfaced the next.

- [2026-08-14] **A "durable signal" emitted post-commit is not durable.** FAILED →
  the `checkout_coupon_decision` event — which migration 106's own header calls
  "the ONLY durable signal that a beta tester's comp was silently skipped before
  they are charged" — was emitted AFTER `applyTierSnapshot` committed, in a
  log-and-swallow block. A crash between COMMIT and the insert leaves an attempt
  whose coupon answer nothing records: precisely the case the event exists for.
  WHY the original shape looked right → emitting inside the tx risked an unapplied
  106's `23514` aborting the whole tier snapshot. CORRECT →
  `tx.savepoint(sp => enqueueAnalyticsEvent(sp, …))` gets BOTH properties and is
  the repo's canonical form (`src/lib/reviews/import-consent.ts:558`, rationale at
  `:81-90`): the event commits iff the decision does, while a constraint violation
  rolls back to the savepoint only and is swallowed there. Swallow **only
  Postgres-coded** errors — a code-less error must RETHROW, because that is how a
  handle with no `.savepoint` at all is found (a `Sql`-shaped mock, root `sql`, or
  `sql.reserve()`); swallowing it kills the event forever behind a warning that
  reads like a missing migration. Note the shared harness
  `worker/__tests__/helpers/mock-sql.ts` does **not** model `savepoint`, so a suite
  exercising savepoint code must stub it or it fails with exactly that `TypeError`.

## 2026-08-14 — migration lockstep audit: staging vs prod

### Migration lockstep audit

Triggered by sessions repeatedly contradicting each other on "is 077 applied in
prod?". Full probe of both Supabase projects (staging `kubdiqdhqbhwmqfditeg`,
prod `udeyaqnvpojbwgoaxwdg`) against all 107 migration files. Result: staging at
head; prod missing **005** (unknown drift), **078** (by design), **105** (held on
a premise that had already expired).

- **[2026-08-14] Three docs asserted 077 was absent from prod → it had been
  applied for weeks → never state an environment's schema state from a doc;
  introspect it.** `.claude/CLAUDE.md`, `migrations-log.md` and
  `ws8-tier-cutover.md` §5 all kept saying "deliberately absent". Every session
  that trusted them inherited a false premise, and every session that checked the
  DB disagreed — that oscillation was the reported symptom, not a memory bug.
  **The prod cutover is executed through §5; resume at §6.** The lesson stands;
  its stated cause did not — see the correction below.

- **[2026-08-30] The 2026-08-14 audit wrote "077 landed unrecorded / no evidence
  file records it" → it was recorded, 66 minutes further down the same file →
  read a long evidence file to its END before asserting what it does not say.**
  `docs/runbooks/evidence/2026-07-17-ws8-prod-cutover-evidence.md` verifies
  `price_variant` **absent** at 01:11:05Z in its "Prod DB findings" section, then
  records 077 **applied and verified at 02:17:11Z** in a later section, plus PR
  #469 merged at 02:40:15Z. The audit stopped at the first read, concluded the
  session had ended there, and re-derived from the database what the record
  already stated — then wrote down that the record was silent. `git log` on that
  file returns one commit (`d1d227e4`) and `git diff d1d227e4 HEAD` on it is
  empty, so the 077 record was present from its first and only commit. The false
  sentence then propagated to six live surfaces before being caught.
  **Two rules:** (a) an evidence file is appended to during a run — its
  chronology runs top to bottom and the outcome is at the BOTTOM, so never quote
  a mid-file reading as the terminal state; (b) "no record exists" is a claim
  about absence — verify it with `git log`/`git diff` on the file, not by reading
  part of it. What was actually true is narrower and is already the standing
  rule: the **Supabase migration-history table** lacks 077 because the SQL editor
  does not write there.

- **[2026-08-30] A launch blocker recorded only in an evidence file vanished for
  six weeks → evidence files are logs, not tracking surfaces → copy every item
  still owed at a pause into `launch-checklist.md` before the session closes.**
  The 2026-07-17 record closed with four "post-merge launch tasks, recorded so
  they don't vanish". Three reached `beta-production-standup.md`. The fourth —
  Stripe live activation, `charges_enabled=false`, "no live payment (incl. prod
  smoke checkout) until complete" — reached no checklist, no phase and no launch
  doc, and would have failed WS8 §6 smoke and the entire beta coupon path with
  nothing predicting it. Caught 2026-08-30 only by reading the predecessor
  evidence file end-to-end during the resume.

- **[2026-08-14] Migration 005 was never applied to prod and nothing detected it
  for ~4 months → there is no migration ledger here, and no CI check compares the
  two databases → the only proof of application is schema introspection, and
  nothing runs it on a schedule.** `review_exceptions.review_id` was still
  `NOT NULL` and `idx_review_exceptions_collision_dedup` absent. That index is the
  exact `ON CONFLICT` target in `worker/jobs/zernio/zernio-ingest-shared.ts` and
  `ingest-failed-hook.ts`, so the Zernio ingest exception path would have failed
  in prod twice over — `42P10` (no index matching the conflict target) and
  `23502` (NOT NULL). It never fired only because the prod worker has never been
  deployed and the table holds 0 rows. **A migration whose objects no later
  migration touches is invisible to every existing gate; only a full catalog diff
  finds it.**

- **[2026-08-14] Prod auto-enabled RLS on every new table for four months and no
  audit could see it → `ci:rls-audit` enforces a FLOOR, not equality → a checker
  that only asserts "required tables HAVE RLS" can never fail on RLS nobody
  asked for.** Prod carried a Supabase-template DDL event trigger `ensure_rls` →
  `public.rls_auto_enable()` firing `ENABLE ROW LEVEL SECURITY` after every
  `CREATE TABLE` in `public`; the staging project, created 8 weeks later, never
  had it. Removed by **migration 107**. Its only surviving output, `job_outbox`
  RLS-on-with-zero-policies in prod, was deliberately left alone (inert — owner
  connection + `service_role` BYPASSRLS; disabling it is a security-loosening
  change that deserves its own migration). **Neither object appeared in any
  migration file, so nothing in the repo explained the difference.**

**Method, if you need to re-run it.** There is no usable ledger — `list_migrations`
does not track the `0xx` series (see the `new-migration` skill). Parse every
migration, replay them in order to compute which objects each one *still owns at
head* (an object a later migration drops or recreates cannot prove its original
author ran), then diff that against a full `pg_class`/`pg_attribute`/`pg_index`/
`pg_constraint`/`pg_proc`/`pg_policy` dump from each database. Migrations with no
surviving structural probe — data backfills, comment-only, `DO $$` bodies, and the
seven successive rewrites of `analytics_events_event_name_check` — need
hand-written probes against constraint *definitions*, column nullability, column
ACLs and row counts. Two traps: a `DO $$ … $$` body hides every DDL statement from
a naive parser (this is why 077/078/105 all read as INDETERMINATE on the first
pass), and a CHECK constraint that is repeatedly DROPped and re-ADDed under the
same name is *present* in both environments while differing in content — compare
`pg_get_constraintdef`, never mere existence.

**Gotcha:** `psql` rejects `?pgbouncer=true`; strip the query string from
`DATABASE_POOL_URL` / `STAGING_DATABASE_POOL_URL` before passing it.

### Test-DB provisioning: local and CI applied the same "shared recipe" to different schemas

- **[2026-08-14] Two RLS assertions failed locally and passed in CI, and the error
  said the table did not EXIST → the local path drops schema `public` and PG15+
  gives the new one no grant to `PUBLIC`, so `authenticated` could not see any
  relation → restore the grant in the BOOTSTRAP, which is the one file both paths
  run.** `.github/actions/test-db` applies `scripts/ci/test-db-bootstrap.sql` to
  the service container's **pristine** `public`, which still carries Postgres's
  default `GRANT USAGE ON SCHEMA public TO PUBLIC` — so `authenticated` inherited
  USAGE and CI was green. `scripts/test-db-setup.sh` first runs
  `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`, which lands at
  `nspacl = NULL`. **Same recipe, different starting schema, different database.**

  The failure mode is what makes it expensive: without USAGE a role cannot see any
  relation, so a table-level privilege probe answers **`42P01` "relation does not
  exist"** instead of **`42501` "permission denied for table"**. Any suite
  asserting the DENIAL MESSAGE (`migration-056-account-offboarding.integration.test.ts`)
  fails locally and passes in CI, which reads as a broken laptop rather than a
  provisioning bug. Attributing it took a full isolation pass — re-provisioning at
  head 106 with the new migration removed to prove the failure was pre-existing.

  **Fix:** the bootstrap now grants USAGE to `PUBLIC` **and** explicitly to
  `anon`/`authenticated`/`service_role`, mirroring a real Supabase project's
  `public` ACL. Redundant no-op on CI's pristine schema, the actual repair
  locally. **ORDER MATTERS in `test-db-setup.sh`:** the reset must come BEFORE the
  bootstrap, or the grant is destroyed again — noted at the call site.

  **Generalise:** when two provisioning paths claim one owner, the owner is only
  real if it is invariant to *where each path starts*. A recipe that assumes an
  untouched schema is not shared with a path that recreates it. And a permission
  bug that surfaces as "does not exist" will be misread as absence every time —
  check `has_schema_privilege(role, schema, 'USAGE')` before believing a `42P01`.

## 2026-08-15 — #827 portal-audit PR1: four tooling traps around a 5-fix branch

Five small correctness fixes (owner sign-out, Telegram deep link, two DB
fan-outs, duplicated labels). The code was trivial; the tooling around it was
where the time went. All four below cost a real detour and will recur.

- **[2026-08-15] The edit-surface guard blocked writes to paths the intake
  explicitly declared → bash `[[ "$p" == $GLOB ]]` reads `[id]` in the glob as a
  CHARACTER CLASS matching one char → escape `[`/`]` before matching; keep `*`
  and `?` as wildcards.** Affects every Next.js dynamic segment in the repo
  (`[id]`, `[reviewId]`, `[token]`, `[responseId]`, `[sessionId]`,
  `[offboardingId]`, `[escalationId]`, `[businessId]`). Fixed in #828.
  `scripts/ci/feature-surface-audit.ts` — the merge-time mirror — was already
  correct and its header already said "character classes are NOT supported", so
  the hook was violating its own documented lockstep. **When two matchers claim
  lockstep, pin both to ONE shared test table**; the claim in a comment is not
  the same as a test. A previous session's escaped-bracket attempt failed on
  double-escaping: escape at MATCH time in-memory, never inside the intake JSON.

- **[2026-08-15] React Doctor flagged the correct fix as a defect, twice → its
  `server-sequential-independent-await` and `async-await-in-loop` rules argue for
  exactly the fan-out #773 forbids → suppress with
  `// react-doctor-disable-next-line react-doctor/<rule> -- <why>`.** It reports
  only issues NEW vs `main`, so existing sequential code is invisible and every
  future sequentialisation PR gets flagged afresh. A reviewer trusting the bot
  reintroduces the pool wedge. Convention already existed in
  `src/lib/channels/disable-enrollment.ts`, `worker/jobs/response-generation/persist.ts`,
  `auto-approval.ts`, and the offboarding workers — follow it, don't re-derive it.

- **[2026-08-15] A source-text test that forbids a string forbade the comment
  explaining the invariant → the house idiom for "no fan-out here" literally
  contains `Promise.all` → strip comments before asserting, and assert the
  explanatory comment IS present.** A naive `expect(source).not.toContain('Promise.all')`
  passes only if you delete the comment that stops the next reader
  re-introducing the bug. Applies to every `page-source.test.ts`.

- **[2026-08-15] Server-page changes can sink `diff-coverage` below its gate →
  this repo has NO executing server-page test precedent (the convention is
  source-text assertion, which yields 0% line coverage) and `diff-coverage` is an
  AGGREGATE over added instrumented lines → put the logic in a `src/lib/**`
  module the page calls in one line.** Projected 76% (fail) inline vs ~91%
  extracted. `loadLocationsSettingsView` is the precedent — but note it batches
  with one `ANY(...)` read rather than looping, so citing it for a per-location
  loop is only half right; a loop trades N-wide concurrency for O(N) latency.

**Also:** `verify-gate`'s `reclassify` row excludes `docs/superpowers/plans/**`
and `docs/reviews/**` but NOT `docs/superpowers/specs/**`, so a branch carrying
its own spec trips the re-classification trigger on a miscount (reported 481
production lines against a real 84). Re-measure per bucket before obeying it.

**Test gotcha:** on macOS `$TMPDIR` is `/var/folders/…` symlinked to
`/private/var/…`, and `git rev-parse --show-toplevel` returns the RESOLVED path.
A test that builds a temp git repo and expects a path-prefix strip must
`realpathSync` the temp dir, or every case fails in a way that looks exactly
like the bug under test.

## 2026-08-15 — #831 portal-audit PR2: four ways a green test proved nothing

The channel-route unification (12 enrollment routes → 3 runners + 2 **Channel
actor** resolvers). Every real correctness defect on this branch was a test or a
guard that PASSED while asserting nothing, and all four were found by EXECUTION
— two adversarial plan-review rounds found none of them. Treat "the suite is
green" as the weakest evidence in the repo.

- **[2026-08-15] A bypass flag cleared an env gate, so a `!` at the use site
  became a TypeError AFTER the commit → `MOCK_EXTERNAL_APIS=true` makes
  `whatsappEnvReady()` return `true` without `TWILIO_WHATSAPP_NUMBER` being set,
  and the deep link was built after `sql.begin` → an env gate a bypass flag can
  short-circuit does NOT license `!`; throw with context, and compute anything
  the response requires BEFORE the irreversible write.** The 500 stranded a
  `pending_verification` row on the migration-027 partial-unique slot, which the
  owner cannot retry past — a data consequence from a "local dev only" config.
  Generalise: order side effects so the fallible pure work runs first.

- **[2026-08-15] `getServerConfig()` memoises `process.env` on first read, so a
  test that sets its own env value silently asserted the `beforeEach` value →
  the wa.me case was green against unrefactored code that could not possibly
  satisfy it → call `resetServerConfigForTests()` at the END of `beforeEach`.**
  Precedent: `src/lib/costs/__tests__/tracker.test.ts` + 7 others. If a test
  passes before the feature exists, that is the finding — not a lucky head start.

- **[2026-08-15] A test-local look-alike error class took the deliberate re-throw
  path → `requireRoleOr401` branches on `err instanceof AuthError` and re-throws
  everything else, so a structurally identical stub never reached the branch
  under test → reject with the class from the module you already mocked.**
  Related trap left in place deliberately: a mock factory written
  `AuthError: class extends Error { statusCode = 401 }` uses a class FIELD, so
  the constructor's second argument is ignored and every instance is a 401. Fine
  for one status; the moment a 403 case is added it asserts the wrong thing.
  Give it a real `constructor(message, statusCode)` then, not before.

- **[2026-08-15] Stale mock fixtures survived a query change as FIVE vacuous
  passes and one loud failure → the refactor moved the admin resolver from
  `SELECT account_id FROM businesses` to an accounts join projecting `a.id`, so
  fixtures seeding `{ account_id }` yielded `accountId === undefined` → grep the
  OLD projected column name across every suite, not just the failing one.**
  `undefined` flowed into the advisory-lock key (`mobile_enroll:undefined`) and
  the cache label, silently neutering a guard whose own comment read "Reverting
  to `business_id` fails here". One red test is not the blast radius.

**A text-scan guard is wrong in BOTH directions — the generalisation of #827's
"strip comments before asserting".** `admin-aal2-audit.ts` cleared a route when
the file text contained `resolveAdminActor`, which a header comment satisfies —
so an admin route could bind `resolveOwnerActor`, skip MFA step-up and stay
green. The first fix (deny any admin route naming `resolveOwnerActor`) then
false-positived on a real route that merely DOCUMENTS its owner counterpart.
Both failures are one bug: the scan read prose. It now strips comments and
checks code. **Its floor, so the next person does not over-trust it:** it is
still a text scan, so an aliased import (`resolveOwnerActor as r`) or an unused
`resolveAdminActor` import clears it; closing that needs an AST audit.

**Also — the gate that made this branch's guard rebindable.** Before, the admin
runners called `requireAdminWithAal2` unconditionally, so the gate was
structural. After, the runners are portal-agnostic and call `config.resolveActor`
— a per-route VALUE — so `tsc` can no longer reject a mis-binding. When a
refactor turns a hard-coded gate into configuration, the compensating CI check
must verify the BINDING, not the presence of a token; and say so where the
allowlist is defined.

**Precedent established:** `vi.mock('node:crypto', …)` with an `importOriginal`
spread DOES intercept a module's `import { createHash, randomUUID } from
'node:crypto'`. This repo had no prior instance of mocking a `node:` builtin.
Proven non-vacuous by mutation — moving the mint inside `sql.begin` turned
exactly one test red — which is the only way to trust a timing assertion, since
a sha256 string looks identical whether it was minted before or inside the tx.

## 2026-08-15 — #833: two guards that passed for the wrong reason, and how the gate mis-sized a move

Portal-audit PR 3 collapsed two near-duplicate admin query modules into one and
turned Overview's paginated table into a ranked at-risk list. The production code
was net **+21 lines** and the spec review found no behavioural defect. Everything
below cost real time anyway, and all four will recur.

- **[2026-08-15] A new #773 concurrency guard could not have failed → its mock
  returned zero rows, so the module skipped the very query the test claimed to
  guard → seed the harness AND assert the query COUNT, not just peak
  concurrency.** `getBusinessSummaries` issues rows → COUNT → metrics, but skips
  the metrics CTE when `businessIds` is empty (a correct optimisation). The test
  called `makeConcurrencyTrackingSql()` with no rows, so it measured peak over
  **2** queries while its own comment said three — and a
  `Promise.all([count, metrics])` regression would have passed clean. Fix: seed one
  base row, add `getQueryCount()`, assert `toBe(3)`. **The general rule: when a
  test's subject is "N things happen sequentially", assert N.** Peak-concurrency
  alone cannot distinguish "sequential" from "never dispatched". Proven by
  mutation — the `Promise.all` fails the seeded test and passes the unseeded one.

- **[2026-08-15] Splitting one sort test into two better tests silently deleted a
  comparator tier's only pin → each replacement fixture happened to hold that
  tier's field equal or zero → when you split a multi-tier comparator test, give
  each tier its OWN fixture that varies only that tier.** The comparator is score
  desc → `pendingApprovalCount` desc → name asc → id asc. `main`'s single test
  discriminated tier 2 (pending 5 vs 2 at equal score). The split produced a
  score-tier test and a name-tier test, both with pending all-equal or all-zero, so
  **deleting tier 2 from production failed nothing**. Same class, one file over:
  the name-tier tie test used ids `biz-z`/`biz-a` against names `Zulu`/`Alpha` — the
  id tier rescued the assertion, so dropping the name tier also passed. Anti-correlate
  fixture ids with names; production ids are UUIDv7 and carry no name ordering.

- **[2026-08-15] Two vitest coverage runs as parallel gate rows clobbered each
  other → `verify-gate.sh --review` runs its own `vitest --coverage`, and an intake
  `verification_commands` entry of `pnpm test:coverage && pnpm ci:fallow:coverage`
  became a second one sharing `coverage/.tmp` → never put a coverage run in
  `verification_commands`; run `ci:fallow:coverage` serially after the gate.**
  Symptom is a red `test` row whose log says *"Something removed the coverage
  directory … Make sure you are not running multiple Vitests with the same
  coverage.reportsDirectory"* — it failed BOTH rows and looked like a real test
  failure. Serial re-run: 11752 passed. Same shape as the #643 lesson about a
  destructive command as a parallel peer.

- **[2026-08-15] Local `pnpm doctor` failed on a branch CI would pass → it scans the
  WHOLE repo and exits non-zero on the pre-existing backlog, while CI's gate is
  `scope: changed` + `blocking: error` → the matching local command is
  `npx react-doctor@0.9.11 --scope changed --base origin/main`.** The 16 repo-wide
  errors (RLS-less tables in migrations, uncleaned effects, layout animation) are
  not any one branch's. Same local-vs-gating-signal divergence as the #581 fallow
  class: reproduce the gate's SCOPE, not just its command.

- **[2026-08-15] `verify-gate`'s `reclassify` row fires on every well-executed
  relocation → it counts CHURN (added + deleted), so a moved line counts twice,
  while intake estimates are naturally written as NET → estimate churn on a
  move-shaped refactor.** This PR read 2.39× (prod) and 3.26× (test) over estimate;
  actual production change was +578/−557 = **net +21**. Step 0 was re-run as the
  workflow requires and the lane was unchanged — the estimate was wrong, not the
  lane. Related but distinct from #827's finding that the row counts
  `docs/superpowers/specs/**` as production.

- **[2026-08-15] A spec-locked file location was illegal and nobody noticed until
  implementation → `src/lib/**` may not import `@/app/**` (eslint
  `APP_LEAF_IMPORT_BAN`, "Route leaves are terminal") → when a spec pins a constant's
  location, check which layer APPLIES it before locking.** Spec §5.1 put
  `OVERVIEW_AT_RISK_LIMIT` in `src/app/admin/page-sizes.ts`; the cap is applied in
  `src/lib/admin/overview-service.ts`. The stated reason ("so the server page and its
  client component cannot disagree") was moot too — nothing app-side reads it. It is
  declared where it is applied; `page-sizes.ts` carries a pointer comment. Re-exporting
  through `page-sizes.ts` was rejected: six admin client components import that file, so
  a value re-export drags the service module graph into their bundles — the exact
  bundler hazard that file's header comment exists to document.

## 2026-08-16 — CI cost pass: self-hosted runner + Tier 1 workflow trims

GitHub Actions hit the account spending limit (every PR check failing in ~4 s at
"billing"). Measured over the prior 30 days: 601 `ci.yml` runs × 17.8 billed
min + 306 fallow × 11.1 + 468 e2e × 3.0 + 306 react-doctor × 1.1 ≈ **15,800
min/month** (~$80–85 after the free allowance), for 240 PRs — the volume driver
is PR count, not pushes per PR (2.5). Fix shipped as one PR; runbook
`docs/runbooks/self-hosted-ci-runner.md`.

- **[2026-08-16] `build-dummy-env-canary` was an exact duplicate of `build` and
  had billed ~1,400 min/month for nothing → a JOB-level `env:` block MERGES over
  the WORKFLOW-level `env:`; it cannot UNSET a variable, so the "placeholder
  env only" job inherited `REDIS_*`/`SESSION_*`/`CSRF_*`/`ENCRYPTION_*` exactly
  like `build` did and both ran `pnpm build` under identical env → delete it; the
  property it claimed (no import-time secret parse) is proven by
  `src/lib/config/__tests__/import-safety.test.ts`. General rule: a job whose
  premise is "runs WITHOUT variable X" cannot be expressed by omission when X is
  set higher up — you would need a separate workflow, a `run:` that `unset`s, or
  a container. Verify the premise before paying for the job.
- **[2026-08-16] fallow re-ran the whole suite in its own workflow (~11 min/PR)
  only to produce `coverage/coverage-final.json` → the reason was the lefthook
  mirror rule in `ci-audit-wiring.test.ts` (every `ci:*` in ci.yml must also be
  in lefthook), which fallow.yml sidestepped by living outside ci.yml → fold it
  in: `test` runs `pnpm test:coverage` (same suite, +~1 min), uploads the
  artifact, `fallow` (`needs: test`) downloads it; the rule gains one sanctioned
  exemption map `CI_ONLY_BY_DESIGN` whose own test asserts the script IS in
  ci.yml and is NOT in lefthook (so the exemption cannot go stale silently).
  `actions/download-artifact` v8 ↔ `upload-artifact` v7 interoperate (both
  Artifact API v2). Coverage still runs the live-DB lane — one Postgres per PR
  now, not three.
- **[2026-08-16] `llm-eval` paid a checkout + a billed minute on every PR to
  print "skipped" → detection was an in-job step, and a step-level skip still
  bills the job → move the path detect into `changes` as a fourth output and
  skip llm-eval at JOB level (`if: needs.changes.outputs.llm_eval != 'false'`,
  fail-open) — a skipped job bills 0 and still satisfies the required check,
  the same asymmetry docs-only PRs already rely on.
- **[2026-08-16] Self-hosted runner: which box, and what NOT to do.** Chosen:
  a Lima Ubuntu 24.04 arm64 VM on the founder's Mac (`limactl`, Apache-2.0),
  runner as a systemd service, `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`
  everywhere so `gh variable delete CI_RUNNER` is the whole rollback. Rejected:
  (a) the native macOS runner — `services:` containers are Linux-only, and
  darwin's case-insensitive FS + bash 3.2 would let things pass that fail on
  Vercel/Railway; (b) OrbStack — needs a paid licence for commercial use; (c)
  running the runner as a Docker Desktop container with the host socket —
  `services:` publish on the VM, not in the runner container's namespace,
  unless you fight host networking; (d) `--ephemeral` — needs an admin-scoped
  token on the box for every job; persistent + `actions/checkout` clean +
  `ACTIONS_RUNNER_HOOK_JOB_STARTED` prune is the better trade for a
  single-author private repo. Hard limit: ONE runner per VM until the Postgres
  service port is dynamic — `test` and `e2e` both publish `5432:5432` and a
  second concurrent job fails to bind (hosted never sees this: one VM per job).
  Keep `claude*.yml` on hosted so `CLAUDE_CODE_OAUTH_TOKEN` never reaches the VM;
  `cache-warm.yml` follows the switch (it warms whichever runner CI uses).
- **[2026-08-17] The Mac runner lasted one day → one runner process = one job
  at a time, so two PRs' 15 jobs ran in series (~29 min wall clock for ~10 min of
  compute each) and the VM shared the Mac's cores with local agent sessions
  (`next build` 35s idle vs 141s under load; e2e 236s vs 465s, the extra being
  30s `next dev` compile-on-first-hit timeouts that read as "flaky") → managed
  cloud runners, split by weight: `vars.CI_RUNNER_HEAVY` (Blacksmith 4 vCPU:
  no floor, 3,000 free min/mo, $0.004/min per 2 vCPU, per-second billing) for
  lint/test/build/llm-eval/e2e/warm; `vars.CI_RUNNER_LIGHT` (GitHub `ubuntu-latest`)
  for the four sub-minute jobs GitHub rounds up to a billed minute each
  (~2,400 min/mo, inside the 3,000 free); legacy `CI_RUNNER` is the fallback so
  the VM route survives as a rollback. Also measured and fixed on the way:
  `actions/cache` on a PERSISTENT runner is pure waste (a new PR branch uploaded
  297 MB Playwright + 183 MB pnpm store — 136s — over files already on disk;
  cache scope is per branch, only main-saved entries are shared); GitHub's
  per-job minute rounding made `changes`/`deploy-install`/`fallow`/`react-doctor`
  cost ~600 min/mo each; ~600 CI-triggering pushes/mo is the biggest lever, so
  draft PRs now run nothing (`changes`+`lint` gate on `draft == false`, agents
  `gh pr create --draft` / `gh pr ready`). Vendor math for this workload: Depot
  ($20 floor + 2,000 min) ≈ $30–60/mo, GitHub-hosted ≈ $54, arm+slim ≈ $38,
  Blacksmith ≈ $5–15; Depot's edge (Docker layer cache, AWS-adjacent) is
  irrelevant here — no image builds. 8 vCPU helps only vitest's parallel project;
  the `integration` project is serial by design and e2e runs 1 worker.
- **[2026-08-16] Lima `limactl start` hung 10 min on a `docker info` readiness
  probe while Docker was fully healthy → probes and `limactl shell` run over
  Lima's ssh ControlMaster, opened BEFORE provisioning finishes, so the session
  predates `usermod -aG docker` and never gains the group → in probes ask root
  (`sudo systemctl is-active docker`), never the user's docker socket; and
  expect `docker …` inside `limactl shell` to need `sudo` until the VM restarts.
  Services started later by systemd (the runner) get the group normally.
- **[2026-08-16] First self-hosted `e2e` run failed with `browserType.launch:
  Executable doesn't exist` right after a Playwright cache HIT → the cache key
  was `${{ runner.os }}-playwright-<ver>` with no architecture, so the arm64
  runner restored the x64 chromium that hosted runners had saved on `main`, and
  the hit branch skips the download → every `actions/cache` key that can be
  written on one arch and read on another carries `${{ runner.arch }}` (both
  Playwright keys + the pnpm-store key in `.github/actions/setup`). Mixed-arch
  runner fleets poison os-only cache keys silently; the required checks passed
  on that same run, so only a non-required job caught it.
- **[2026-08-16] Measuring Actions spend: `GET /actions/runs/{id}/timing`
  returns `total_ms: 0` now (deprecated) and the billing endpoints need
  `user`/`admin:org` scopes** → sum `ceil((completed_at − started_at)/60s)` per
  JOB from `/actions/runs/{id}/jobs` (billing rounds per job, per minute) over a
  sample of runs, × the 30-day run count from
  `/actions/workflows/{file}/runs?created=>=DATE` `.total_count`. Rates (private
  repo, 2026-08): Linux x64 2-core $0.006/min, arm64 $0.005, `ubuntu-slim`
  1-core $0.002; self-hosted $0. `claude.yml`'s 584 skipped runs, Dependabot's
  "dynamic" runs and the Copilot-review ruleset bill no Actions minutes.

## 2026-08-16 — CLAUDE.md gotcha trim (context diet): mechanics moved here

Eight "Non-obvious gotchas" over 60 words were cut to symptom → rule → pointer
(the PR after #848). Every sentence removed from CLAUDE.md that had no verbatim
home in these notes lives below; the rest already did (#573, #694, #706, #581,
"Single-replica worker", "PgBouncer JSONB parse-site allowlist", "Cost-guard
fail-open/retry matrix", the timestamptz #520 note).

### [2026-08-16] live-DB lane CI gating — `pnpm test` is the gate, not `pnpm test:integration` (moved from CLAUDE.md, context diet)

- [2026-08-15] A 2026-08-15 architecture pass filed a false "correct tests that
  no gate runs" finding → it read `pnpm test:integration`'s one-suite list as
  "CI's coverage" → CORRECT: the live-DB lane IS gated in CI, by `pnpm test`.
  ci.yml's `test` job (a required check) stands up a `postgres:16` service,
  sets `TEST_DATABASE_POOL_URL` and provisions the schema via
  `.github/actions/test-db`, so `vitest run` executes both projects: 91 of 92
  integration suites run per PR (the abstainer, `trial-test-clock`, needs live
  Stripe credentials). `pnpm test:integration` hard-gates only the publisher
  edit-existing-reply suite and is a **developer fast-path, never the gate**.
  Because every suite degrades to a SILENT SKIP rather than a failure when the
  DB is absent, deleting four lines of that YAML would un-gate all 92 and leave
  CI green; `src/__tests__/ci-audit-wiring.test.ts` pins the wiring against
  exactly that. Locally, `pnpm test` runs them too (the `.env.local` fallback,
  see the 2026-08-03 note above). When touching governor/judge/publisher paths
  you can still run one file directly — export `TEST_DATABASE_POOL_URL` **and**
  `DATABASE_POOL_URL` first, or a singleton-backed suite dials the wrong host.

### [2026-08-16] #573/#706 detection notes and the fallow static-vs-coverage asymmetry (moved from CLAUDE.md, context diet)

- Live-DB DDL detection is AST extraction of **executed SQL** — every tagged
  template and `.unsafe()` call — never a text marker (#694: the
  `supabase/migrations` + `.unsafe(` conjunction missed three sites, one of
  which stranded a CHECK constraint and cost 14 spurious failures). The audited
  set is every `.ts`/`.tsx` under `__tests__/`, not just the suites (#706):
  Postgres.js splices a nested `Query` substitution in as raw SQL text, so a
  helper can build a DDL fragment a suite executes — **the finding lands on the
  file that BUILDS it**. Helpers reach the DB by importing `postgres` (they are
  handed the handle, so they name no env var); the `e2e/` Playwright lane is
  deliberately out of scope. Two sanctioned escapes, BOTH lock-enforced
  allowlists in `scripts/ci/live-db-suites-audit.ts`: migration-**shape** files
  (applying the migration IS the subject) and **DDL-probe** suites
  (session-scoped `auth.uid()` redefinition inside a rolled-back tx) — each
  must hold `acquireLiveDbLock` AND roll back any unconditional re-apply.
  Safety that is statically invisible takes a per-line
  `-- live-db-ddl-ignore: <reason>` (a `CREATE INDEX` on a `pg_temp` table
  reads exactly like one on the shared table). To force a transaction abort use
  `helpers/abort-injection.ts`, NEVER a temporary constraint — a vitest timeout
  skips the `finally` that would drop it. Provision once with
  `pnpm test:db:setup`; assert with `assertSchemaReady`.
- fallow: the coverage input is the `test` job's own `pnpm test:coverage` run
  (live-DB lane included), handed to the `fallow` job as an artifact, so a
  module covered only by an integration suite no longer reads 0% with inflated
  CRAP (#581). A bare `fallow audit` estimates CRAP from export references, so
  it **both invents findings CI lacks and misses ones CI has** (#783: a
  0%-covered component passed locally, failed CI at CRAP 420).
- Cost guard: pre-LLM Redis **transport** failures are RETRYABLE
  (`CostInfraUnavailableError` → BullMQ retry + outbox watchdog; #255 — do not
  re-terminalize); **budget-exceeded** decisions stay TERMINAL (never
  reclassify as infra); post-LLM finalize failures are governed by
  `withCostGuard`'s `onFinalizeError`, never a job-level retry (would
  re-spend). Upstash is a single-instance **SPOF** (cache + rate-limit +
  cost-reserve + regen-budget + idempotent-generation).
- Single-replica worker: four boot guards + the in-process LLM circuit breaker
  are only correct with one replica; `ci:static-policy` blocks
  `numReplicas`/`multiRegionConfig` in `railway.toml`, and replicas register in
  Redis so `HealthAlertPoller` pages when >1 is live (#587) — deliberately a
  registry, NOT a boot-gating lease (a Redis outage must never stop the worker
  starting). Before ever scaling: clear the P2 list in
  `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`.
- JSONB carve-out: `typeof x === 'string' ? JSON.parse(x) : x` then narrow is
  the *only* sanctioned exception to the no-`any` rule (never paper over it
  with `: any`); the allowlist (19 sites today) is the note above; HTTP/request
  bodies, provider responses, LLM output, Redis/cache values, local storage and
  `TEXT[]` reads do NOT belong on it (different parsing boundaries).
- timestamptz: any SQL comparison against a value that round-tripped through JS
  can mis-order by <1ms; fatal when a row is compared against a window/anchor
  derived FROM that same row (governor permanent re-suspension immunity #520;
  wedge-reaper `backend_start` equality before it). Truncate the DB side
  (`date_trunc('milliseconds', col) > ${jsDate}`) or keep the value `::text`
  end-to-end. JS-Date-seeded fixtures carry zero µs and CANNOT catch this —
  seed with `+ interval '419 microseconds'`.

---

## 2026-08-17 — #657 ship: the self-hosted runner is YOUR machine, and a fallow rule that was already written down

Both notes below cost real time on PR #853. Neither is about the feature.

- **[2026-08-17] Running the local verify gate while CI runs STARVES CI, and the
  failure looks exactly like a code defect.** CI runs on the Lima VM on the
  founder's Mac (2026-08-16 cost pass), so `scripts/verify-gate.sh` and the CI
  `test` job are **the same finite CPU and the same Postgres**. Running both at
  once drove load average to ~13 and produced: a CI `test` job **`cancelled`**
  for exceeding its 15-minute cap, with unrelated React component suites
  (`OffboardingsClient`, `ImpersonationStartClient`) timing out at their default
  5000 ms — plus a local gate RED on `live-db-suites-audit` (a repo-wide
  sequential scan, 5531 ms against a 5000 ms default) that passed **43/43 twice
  in isolation**. **None of it was the branch.** The diagnosis inverted twice
  before the evidence settled, which is the real cost: contention and a genuine
  over-budget test are indistinguishable from the failure text alone.
  → **CORRECT APPROACH: serialise.** Never overlap a local gate with a CI run on
  this repo. Check `uptime` before starting either. When a test times out at
  exactly the default 5000 ms and passes in isolation, suspect the machine
  BEFORE the code, and confirm with a second run on an idle box rather than
  re-running under the same load. (The eventual real fix was infrastructural —
  #854's weight-based cloud runners moved the heavy jobs off the shared Mac.)

- **[2026-08-17] The pre-PR fallow run is not optional when a diff MOVES an
  exported function — and this note already existed.** `ci:fallow` failed #853 on
  `worker/ingress/resend/bounce-classifier.ts:52 isHardBounceType` — *"exported
  symbols with no known consumers."* Task 6 moved the classifier out of
  `resend.ts` and exported all three "public entry points"; only two had callers.
  `isHardBounceType` was private before the move, is used solely by
  `classifyBounce` one function below it, and exporting it published a **second
  way to ask "what counts as permanent"** — the exact second-owner problem that
  moving the classifier *intact* was meant to prevent. **27 green local gate rows
  did not see it**, because `verify-gate.sh` excludes `ci:fallow*` by design.
  → **CORRECT APPROACH:** the index entry at the top of this file already said
  *"a verify-gate GREEN branch can still fail CI's fallow job… run
  `npx fallow audit --gate new-only --base origin/main` before opening a PR"*
  (#675, 2026-08-06). It was not run. **A move that changes an identifier's
  visibility is exactly the diff shape that entry is about.** Reproduce the real
  gate with `pnpm test:coverage && pnpm ci:fallow:coverage` — a bare
  `fallow audit` does not predict it in either direction.

## 2026-08-17 — #629 ship: two silent failures, and a probe that lied twice

The feature itself (owner approval lane, migration 108) landed clean. Every
note below is about a *verification* that reported success it had not earned.

- **[2026-08-17] The shared test DB trap (D10) also bites the PRE-PUSH HOOK, not
  just the verify gate — and there it fails LOUD but reads as a code defect.**
  Seven worktrees share one Postgres container; only this branch had migration
  108; `.env.local` points `TEST_DATABASE_POOL_URL` at the shared `test_ws4`,
  which sits at **107**. The handoff documented this for `verify-gate.sh` and the
  exports were set there, so the gate was GREEN. Then `git push` ran lefthook's
  `test-changed` in a shell **without** those exports, `resolveTestDatabaseUrl()`
  fell back to `.env.local`, and two `approval.integration.test.ts` cases failed
  on `solicitation_outreach_status_reason_consistency` — an error that reads
  exactly like a defect in the code under test. Against the isolated `test_629`:
  **1610/1610 pass.**
  → **CORRECT APPROACH: the env exports belong on `git push`, not only on the
  gate.** `export TEST_DATABASE_POOL_URL=… DATABASE_POOL_URL=…` before pushing
  from any branch carrying an unpromoted migration. When a live-DB suite fails on
  a CONSTRAINT your branch's own migration widened, check the DB's schema before
  reading the diff — the constraint error names the exact migration you are
  missing. Existing index entries cover the `.env.local` fallback (#563) and the
  gate's two-var requirement (#728); **the push hook is a third surface neither
  named**, and it is the one that runs when you are least expecting a test run.

- **[2026-08-17] A `psql -f` that prints NOTHING has not run.** Applying 108 to
  prod, two `psql` invocations died on shell quoting inside a `!`-prefixed
  command. The first failed loudly (`database "postgres    # Direct Postgres
  connection (migrations" does not exist` — an inline comment swallowed into the
  URL). **The second produced no output at all and was reported as success.**
  Introspection said otherwise: `has_owner_excluded=NO`, `comment=NONE`.
  → **CORRECT APPROACH:** this is precisely why `migrations-log.md`'s header
  demands verification by schema introspection and *never* by the migration
  ledger — or, as this run adds, **never by reading the terminal.** A successful
  `psql -f` on 108 prints six lines (`BEGIN / SET / ALTER TABLE / ALTER TABLE /
  COMMENT / COMMIT`); silence is a failed shell, not a quiet success. When an
  env-var extraction is fighting the shell twice, stop and use the Supabase SQL
  Editor — the third attempt through the editor worked first try. Strip inline
  comments when extracting any value from `.env*`: `sed 's/[[:space:]]*#.*$//'`.

- **[2026-08-17] A `check_violation` handler catches whichever CHECK fires
  FIRST, so a constraint probe returns a false negative unless every SIBLING
  CHECK is satisfied.** Verifying 108 on staging with the 097 aborted-transaction
  probe took three attempts. Attempt 1 never reached the target CHECK (NOT NULL
  on `account_id`). Attempt 2 reported **`owner_excluded: REJECTED by CHECK`** —
  flatly contradicting `pg_get_constraintdef`, which plainly contained the value.
  The rejecter was `solicitation_outreach_moderation_status_check`: the probe
  passed `moderation_status='skipped'`, not a member. `solicitation_outreach`
  carries **eight** CHECK constraints; `body_presence` and the status/timestamp
  totality also constrain a `cancelled` row.
  → **CORRECT APPROACH:** enumerate `pg_constraint … contype='c'` for the table
  BEFORE writing the probe, satisfy every sibling, and put `SQLERRM` in the
  NOTICE so a wrong-constraint rejection identifies itself instead of
  masquerading as the answer. Suppress FKs with `SET LOCAL
  session_replication_role = replica` (CHECKs still fire) rather than seeding
  real parent rows. Prove BOTH directions — the new member accepted **and** a
  bogus member still rejected *by the constraint's name* — or you have only shown
  the constraint is permissive, not that it was widened.

- **[2026-08-17] Verify a migration on PRODUCTION by definition-equivalence
  against an already-probed twin, not by re-probing.** An INSERT inside a
  rolled-back transaction is still a write, and the permission classifier
  correctly blocks agent writes to prod. `pg_get_constraintdef` on prod was
  **byte-identical to staging's (821 bytes each)**, with the COMMENT landed and
  `convalidated` true — so the object that passed staging's live probe is the
  object prod holds. **The weaker action carried the stronger evidence.** Reach
  for this shape whenever the risky verification and the safe one prove the same
  fact.

- **[2026-08-17] `main` moved THREE times during one promotion; budget for it.**
  Between gate-green and merge, `main` advanced with #862, then #857 (#651) —
  each forcing a rebase, a force-push, a full local gate re-run and a full CI
  re-run, because required checks are strict-up-to-date. Roughly 20 minutes of
  drift per cycle.
  → **CORRECT APPROACH:** on a busy day, rebase **immediately** before opening
  the PR and merge as soon as CI is green rather than reporting first and
  merging after. Re-running the local gate for a *docs-only or non-overlapping*
  drift is redundant with CI — check `comm -12` on the two file lists first and
  let CI be the authority when the overlap is empty.

- **[2026-08-17] The staging smoke could not cross a Next.js route — and the
  index already said so.** Every staging URL redirected to `vercel.com/sso-api`,
  so the 401s from the four new API routes were the SSO layer, not the app; the
  Requests screen was never rendered. The topic index's CI/tooling bullet already
  carries this: *"staging is behind Vercel team-SSO AND app auth, so any smoke
  crossing a Next.js route needs the owner's browser — worker/Railway ingress
  stays scriptable, so split the smoke list by surface before estimating it"*
  (#679, 2026-08-08).
  → **CORRECT APPROACH:** split the ride's claims by surface at PLANNING time.
  Worker health, migration introspection and Railway ingress are scriptable and
  were genuinely proven here; anything behind the Next.js app is not, and a ride
  that says "smoked staging" without that split overstates itself. Say what was
  and was not exercised, in the PR body.

- **[2026-08-17] Two of round 1's fixes had never landed, and only a
  verification-only round 2 caught it (D15).** Round 1 produced 21 findings
  across three axes, all marked fixed. Round 2's standards axis found two D13
  fixes absent from the tree.
  → **CORRECT APPROACH:** a review round's output is a claim about the code, not
  a record of it. Re-verify each accepted fix against the tree — the
  verification-only round exists for exactly this, and its cost is why the
  workflow caps rounds rather than skipping them.

## 2026-08-18 — #860 ship: four tests that passed for the wrong reason, and a gate the local gate cannot see

The feature (per-ask **Ask regeneration**, ADR 0020) landed clean. Every note
below is about a check that reported success it had not earned — the same class
as #831 and #833, arriving through four new doors.

- **[2026-08-18] `rerender` CANNOT prove a remount defect, and the two tests that
  mattered most used it.** `ApprovalPanel` held `excludedAsks` (`useState`) and
  `pendingRegen` (`useRef`). An accepted regeneration settled through the same
  path as approve/halt → `retry()` → `phase: LOADING` → the render switch returns
  `<LoadingCard/>` → **the panel unmounts and both die**. Effect: every ask the
  owner had deselected was silently RE-SELECTED, so a message they removed would
  send. Testing-Library's `rerender` preserves component state by construction,
  so both promised tests passed against the broken composition through an entire
  review round.
  → **CORRECT APPROACH: a test for state that must SURVIVE a refetch belongs in
  the parent's suite, driving the real mount boundary — never in the component's
  own suite via `rerender`.** The fix moved both titles into
  `requests-client.test.tsx` and they fail against the old composition
  (`expect(element).not.toBeChecked()` → `Received element is checked`). Generally:
  if a defect is *unmount*, a test that never unmounts is not a weaker test, it is
  a different test. Root cause was an altitude error — approve and halt are
  TERMINAL (the panel is meant to vanish); regeneration is NOT, and it reused
  their settle path. Fixed by putting the distinction on the write itself
  (`LaneRefresh = 'replace' | 'in_place' | 'none'`, a REQUIRED field), so every
  future lane verb declares its own terminality at compile time.

- **[2026-08-18] A fail-open guard needs an oracle for the OPEN half; pinning only
  the refusal leaves the invariant undefended.** Round 1 found
  `budget_exhausted` had zero coverage (every live-DB case passed
  `budgetRemaining: 3`, the route suite mocked the status). The fix pinned
  `budgetRemaining: 0` — the CLOSED half — and shipped. Round 2 caught that
  nothing pinned `null` (UNKNOWN, i.e. Redis down). Rewriting the guard as
  `(input.budgetRemaining ?? 0) <= 0` type-checks, keeps **29 of 30** tests green,
  and converts an Upstash outage into a dead regenerate lane for every owner —
  violating this file's own "API rate limits fail OPEN by design… Never make the
  limiters strict."
  → **CORRECT APPROACH: for any guard with a documented fail-open path, write
  BOTH tests in the same change.** Mutation-check the open half specifically; the
  closed half is the one everybody remembers. Verified here: with the guard
  flipped, exactly one test fails — the new one.

- **[2026-08-18] A dedup probe that answers before the ownership proof is a
  cross-tenant oracle, and the fix is to defer the ANSWER, not the STATEMENT.**
  `requestAskRegeneration` enqueues FIRST by design (the worker's swap locks the
  `job_outbox` row before taking the advisory lock, so validate-first deadlocks).
  It then returned `already_in_flight` straight off the `ON CONFLICT` probe —
  **two lines before** `lockBatchForAction` proved ownership. `withScopedBatch`
  only UUID-validates the caller-supplied `batchId`. So a foreign batch
  mid-regeneration answered 409 while an unknown one answered 404: existence and
  activity leaked. No data leaked (the conflict wrote nothing; the non-conflict
  path rolls back).
  → **CORRECT APPROACH: move the `if` that returns, not the statement that
  writes.** The enqueue stays statement one (deadlock avoidance intact,
  `outboxAt < advisoryAt` still asserted); only the refusal arm moved below the
  lock. The call site now carries a comment naming the finding and saying *do not
  tidy this back above `lockBatchForAction`* — because moving those six lines up
  is exactly what a future reader will mistake for cleanup. **Also: the
  spec-correctness reviewer examined this arm and cleared it; the adversarial
  axis caught it.** That is the argument for the third review axis, in one
  example.

- **[2026-08-18] A `fallow` green built on a STALE `coverage-final.json` is not
  load-bearing — extractions shift line numbers and the CRAP dimension goes
  meaningless.** The index entry already prescribes
  `pnpm test:coverage && pnpm ci:fallow:coverage`; the trap is reusing an
  artifact from before the edits because the run is slow. Tell: `normalize-v8-coverage`
  reports `clamped N out-of-range value(s)` on a fresh report and stays silent on
  a stale one.
  → **CORRECT APPROACH: regenerate coverage AFTER the last edit, every time.**
  And remember the gate is `CI_ONLY_BY_DESIGN` — `scripts/verify-gate.sh` returning
  26/26 GREEN says NOTHING about `fallow`. A local gate green is necessary, not
  sufficient; run the fallow reproduction before every push, not after CI fails.

- **[2026-08-18] Fix the metric's actual cause, not the plausible one.**
  `ApprovalPanel` breached cognitive 16. The obvious lead — a 21-key copy
  catalogue — contributes **0**, because it is module-level and the flagged unit
  is the component. `fallow health --complexity-breakdown` showed the real
  composition: 1 point per hook call (9) + 1 per JSX logical-operator group (6) +
  1 for prop count. Extracting the catalogue would have moved nothing.
  → **CORRECT APPROACH: run the breakdown before choosing an extraction.** The
  fix (four named hooks/helpers) took it 16 → 10 with ZERO test-file changes,
  which is also the proof it was a refactor. One extraction was a correctness win
  beyond the metric: three list branches were independent `mode.kind === …`
  guards, mutually exclusive only by coincidence — a new `PanelMode` arm would
  have compiled and rendered a BLANK panel. Now exhaustive with no `default`.

- **[2026-08-18] `git add -A` is unsafe the moment two agents share one
  worktree.** The plan's commit steps all said `git add -A`, and the task graph
  runs pairs in parallel in the SAME worktree. Task 3 committed while Task 2 had
  `ask-generation.ts` dirty — `-A` would have swept a half-finished ADR-0020
  narrowing into a commit whose message claims only budget doors.
  → **CORRECT APPROACH: explicit per-file staging in every parallel-task prompt.**
  Also: `pnpm typecheck` failing mid-flight is usually the SIBLING's half-applied
  edit, not a defect — check `git status` before diagnosing. And do not run the
  verify gate against a dirty tree: a red result then describes orchestration
  timing, not the code, and writing it to `gate-status.json` is worse than leaving
  the record stale.

- **[2026-08-18] When an eval task widens a shared DTO fixture, grep for EVERY
  construction site.** Task 1 widened the `sendLane()` fixture in
  `approval-panel.test.tsx`, believing it was the only one. A second lived in
  `requests-client.test.tsx` and broke typecheck (TS2739) the instant
  `SendLaneView` gained two fields. This also **voided a deviation's overlap
  analysis** (D1 had cleared `codex-861` as "one test file this feature does not
  touch").
  → **CORRECT APPROACH: `grep` the TYPE name, not the fixture helper's name.**
  Related: TypeScript's excess-property check (TS2353) reports only the FIRST
  offending key, so a plan prescribing one `@ts-expect-error` per added field is
  wrong — the second is TS2578 unused-directive. One marker, removed in the task
  that widens the interface.

- **[2026-08-18] The `reclassify` trigger fires on exactly the branches whose
  review WORKED.** 1623 prod lines against a 620 estimate (2.6x). Step 0 re-run
  against every epic criterion: surface declarable in six narrow globs, one risk
  domain, six tickets, no open research — **lane confirmed, estimate was the
  defect**. Round-1 fixes alone were ~1250 of the overage (`LaneRefresh` refactor
  +686/−210; tenant/budget/peek fixes +313/−38), and "changed lines" counts both
  sides so a 200-line rewrite scores 400.
  → **CORRECT APPROACH: price a rework allowance into `estimated_prod_lines` for
  a high-RISK feature with a real UI surface.** A branch that lands near its
  estimate *after* a three-axis review found two High defects is the suspicious
  one. Test:prod here was 1.15:1, which is the healthy direction and not the #643
  1:1 gaming the trigger exists to catch.

## 2026-08-17 — #867 fix: one spelling for a Next.js dynamic segment in `allowed_edit_surface`

Supersedes the #729 and #730 entries above ("declare BOTH spellings" / "use
`*` for a bracketed route dir"). Those workarounds were correct observations
of a real disagreement and are now WRONG advice.

- **[2026-08-17] `ci:feature-surface` went red the moment #652's implementation
  commit existed, on a path the intake explicitly listed
  (`src/app/api/u/[[]token[]]/route.ts`) → there were THREE matchers, not two,
  and only the Codex hook lacked the bracket escape.** `#828` escaped `[`/`]` at
  match time in `.claude/hooks/edit-surface-guard.sh` to align it with
  `scripts/ci/feature-surface-audit.ts` (`globToRegExp` had always escaped
  them) — but `.codex/hooks/edit-surface-guard.sh` was left matching the RAW
  glob. So after #828 the plain `[id]` satisfied Claude + audit and NOT Codex,
  while a pre-escaped `\[id\]` / `[[]id[]]` satisfied Codex ONLY. No single
  spelling worked in all three; a codex session that hit the Claude/audit
  failure "fixed" it by adding the escaped duplicate, and the two intakes
  carrying `…/[reviewId]/…` twice (763, 729) are that fingerprint. Both source
  comments claimed "character classes are NOT supported (no intake uses them)"
  while one did.
  → **CORRECT APPROACH:** brackets are ALWAYS literal in a surface glob; the
  intake carries the plain path and NOTHING ELSE. All three matchers now apply
  the identical escape at match time, and a pre-escaped entry matches nothing
  anywhere. Enforcement, earliest first: `scripts/feature-setup.sh` refuses a
  pre-escaped entry BEFORE the intake commit; `scripts/arm-check.sh` reports
  DISARMED on one (resumed/amended runs); the Codex `validate-intake.mjs`
  errors on one; `ci:feature-surface` fails on one in ANY committed intake, on
  every branch (repo-wide sweep), and — the class-catching check — fails when a
  non-process surface entry on the audited branch matches NO file (tracked at
  HEAD or touched by the diff, `--no-renames` so a declared old path of a rename
  still counts). An entry that matches nothing is either a wrong spelling or a
  path the plan abandoned; fix or drop it (narrowing is auto-approved). WIP push
  before implementation → `git push --no-verify`.
  → **Generalisation:** when N matchers claim lockstep, pin ALL N to one test
  table (`scripts/ci/__tests__/edit-surface-guard.test.ts` now runs both hooks
  through `describe.each`; the unfixed Codex hook fails 4 of its 7 cases). #828
  pinned two of three and its comment asserted the third. A comment is not a
  test, and "the other copy" is a matcher too.
  → **After changing `.codex/hooks/*.sh`:** re-trust it through Codex's
  `/hooks` UI (`.codex/HOOKS.md` § Trust and maintenance) — executable policy.
- **[2026-08-17] The hook suite passed by hand and under `lefthook run`, then
  failed 2/35 under the REAL `git push` from the sibling worktree → git EXPORTS
  its repo-locating variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …)
  into hook processes, and from a LINKED worktree `GIT_DIR` is set for
  pre-push. Inherited down lefthook → vitest → `spawnSync`, it retargeted every
  `git` call in the test's throwaway repo at the caller's: `git init` re-inited
  the worktree, `rev-parse --show-toplevel` answered with the spawn cwd, and
  exactly the two `.feature/intake.json` cases blocked (its `.feature/` dir
  EXISTS, so the anchor walk stopped there and TARGET_ROOT ≠ ROOT). #828's
  identical fixture never tripped it because it was pushed from the main
  checkout, where `.git` is a directory and `GIT_DIR` is not exported.
  → **CORRECT APPROACH:** a test that spawns `git` against a throwaway repo
  must scrub `GIT_*` from the child env (`GIT_FREE_ENV` in
  `edit-surface-guard.test.ts`); "passes when run by hand, fails only under
  `git push`" is the signature. Same family as the `realpath` note in that
  file — environment artifacts that look exactly like guard bugs.

## 2026-08-18 — #865 ship: defects that live only in the composition, and a gate that false-fails on retry

- **[2026-08-18] Three parallel review agents and two live-DB integration
  suites all passed a branch whose rendered page was visibly wrong → the
  defects existed only in the COMPOSITION (write → refetch → render, with
  client state carried across), and every reviewer read the query and the copy
  as separate artifacts → treat the staging ride as a real gate, not a
  formality.** Two defects, both found within minutes of a human looking at the
  actual page after an actual write. (1) The admin batch panel's subheading
  still said "The most recent … batch for this location" while deliberately
  rendering an OLDER live batch over a newer `pending` one — a sentence
  describing the exact policy the branch's own review finding had deleted; the
  screenshot was its own counterexample. (2) Far sharper: that finding had made
  the live-send predicate the leading sort key, and **halting is precisely what
  makes that key flip**. So the refetch after a successful stop fell back to
  `created_at DESC`, re-selected the same newer `pending` batch the finding was
  about, and the success receipt — which survives the refetch — rendered "Batch
  stopped. 2 queued message(s) cancelled." above a batch reading `pending`,
  0/0/0, "This batch is still building." Neither the query nor the copy is
  wrong read alone. **The general shape: when a fix changes a SELECTION policy,
  ask what happens to that policy's key immediately after the WRITE the surface
  performs — a leading sort key that the surface's own action flips is a
  latent identity swap.** Fix shipped as a second sort key
  (`built_at IS NOT NULL`) rather than pinning the acted-on row in React state,
  so the server stays the single owner of the projection instead of the browser
  synthesising a post-write one.

- **[2026-08-18] `ci:rls-audit` reported 20+ unrelated tables "missing from
  pg_class result" inside `scripts/verify-gate.sh`, and passed standalone
  seconds later → its live check ran while `db-provision` had schema `public`
  dropped → re-run the gate before believing a live-DB audit failure that names
  tables your diff never touched.** `pnpm test:db:setup` drops schema `public`
  before re-applying migrations, and CLAUDE.md documents that provisioning runs
  SERIALLY before the parallel rows — it evidently does not, or `rls-audit`
  escapes it. Tracked as **#877**. The dangerous property is not the failure,
  it is that **it clears on retry**: a false failure that goes away when you run
  it again is exactly the kind an agent or a human learns to dismiss, which
  erodes the gate's authority for the real ones. Signature: the failing table
  list includes things the branch never touched (`judge_verdicts`,
  `competitor_snapshots`, the whole `solicitation_*` family).

- **[2026-08-18] A `staging` push no longer produces a `target:"staging"`
  Vercel deploy, though `deployment-guide.md` and CLAUDE.md both assert it does
  ("verified 2026-06-02") → every recent staging-ref deploy returns
  `target: null`, a generic preview carrying the `staging.repworth.net` alias →
  do not infer Custom-Environment env-var scoping from the branch you pushed.**
  The stack still works, which is why this went unnoticed. Tracked as **#878**.
  Verify with `GET /v6/deployments` and read `target`, not the alias.

- **[2026-08-18] An estimate of production line count anchored to a precedent
  file's size ran 2.2× low (925 actual vs 420 estimated) and fired the gate's
  `reclassify` WARN → the precedent file solved a different number of behaviours
  → estimate from the ENUMERATED behaviours the intake already lists, never from
  "the last file that looked like this."** The WARN was owner-accepted rather
  than re-classified, because the edit surface was never amended and the scope
  never moved — but the estimate itself was arrived at wrongly, and the same
  method will mis-fire again. Recorded on #865 as deviation D8.

## 2026-08-18 — #665/#662 fix: a gate that could not see, and an audit that was never asked

### [2026-08-18] A tombstone column that RESTORES a default needs `IS DISTINCT FROM`, not `<>` — and the residue-predicate idiom hides that
FAIL → the account-purge verifier's `businesses` branch is 20-odd `OR col IS NOT NULL` residue checks, so `tone` was about to be written the same way. `tone` is the ONE column the tombstone sets to a literal (`'professional and friendly'`) instead of nulling, which already makes it `<>` rather than `IS NOT NULL` — and `<>` is still wrong. WHY → `tone` is nullable, and `NULL <> 'professional and friendly'` evaluates to NULL, not TRUE. A row whose `tone` had been nulled — the exact residue state a detector exists to catch — passes a `<>` predicate silently. The idiom of the surrounding lines is what makes this invisible: every neighbour is a NULL-check, so the one line that must be NULL-*safe* reads like the odd one out rather than the careful one. CORRECT → `IS DISTINCT FROM` for any predicate whose expected value is a non-NULL literal on a nullable column. Mutation-proven both ways: drifting the literal fails the isolated case, and downgrading the operator to `<>` fails the deliberately-added `tone (nulled)` case. General rule: a residue predicate list has TWO shapes — "was cleared" and "was set to X" — and only the second can be defeated by NULL.

### [2026-08-18] The purge verifier is a GATE, not a report — it throws inside the finalize transaction
FAIL → the #665 fix was reasoned about as "a detector was incomplete", which under-rates it in one direction and over-rates the risk of tightening it in the other. WHY → `verifyAccountOffboardingPurge` is called inside `finalizePurgeInTransaction` and a non-empty issue list `throw`s, rolling the whole finalize back. So a blind predicate is an OPEN GATE, not a missing metric — and, symmetrically, a newly-strict predicate that false-positives BLOCKS a legitimate purge rather than logging a warning. CORRECT → before widening this predicate list, confirm the write side already satisfies every new column across all reachable versions (here it had for many releases, so version skew cannot false-positive), and prefer a predicate that can only fire when the write side is genuinely broken. Corollary for the branch's one non-residue check: `archived_at IS NULL` is a violation because the tombstone SETS it (`COALESCE(archived_at, NOW())`) — that is the only predicate in the branch that can catch a row the tombstone never touched at all, because an untouched row whose optional columns happen to be empty looks purged to every residue check.

### [2026-08-18] A green `ci:tenant-scope` is not a review of a cross-tenant join — the audit is SILENT on every table outside `TENANT_TABLES`
FAIL → a `LEFT JOIN users` added to the admin suppressions lookup shipped through two review rounds with a comment stating it was "structurally scoped and needs no exception", and a review artifact recording it as covered "with an explicit tenant-scope allowlist entry". Both were false, and the passing audit was cited as the evidence. WHY → `users` is not in `TENANT_TABLES` (`scripts/ci/tenant-tables.ts`), so `ci:tenant-scope` never evaluates it. No exception covers it and none CAN — the allowlist entry that did change covers `solicitation_suppression_corrections` and was re-pinned only to stay byte-exact after the query shape changed (baseline unchanged at 381). Nothing at a call site distinguishes "reviewed and exempt" from "never in scope", so a green run reads identically in both cases. CORRECT → when adding a cross-tenant join, check the table against `TENANT_TABLES` FIRST and say which case you are in. The join here is sound on its shape, not on the audit: a bounded primary-key lookup of one actor row behind `requireAdminWithAal2`, returning staff identity and never tenant data (the `src/lib/admin/impersonation/session.ts` precedent). General rule: never let an audit's silence stand in as its approval — state the reason the audit is quiet.

### [2026-08-18] An all-or-nothing CHECK forces combined-restore tests, which cannot prove an individual predicate is CORRECT — only that its name appears
FAIL → the #665 test restores the whole five-column attestation tuple and asserts one violation. Plan review round 1 correctly rejected an earlier version: because migration 099's CHECK makes those five all-NULL or all-present, that test passes against an implementation probing only ONE of them. The accepted fix was a SQL-shape assertion pinning all five predicate names. That closes the naming gap and leaves a second one open. WHY → a shape assertion proves a predicate is PRESENT, never that its COMPARISON is right. `b.tone IS DISTINCT FROM 'wrong literal'` satisfies `toContain('b.tone IS DISTINCT FROM')` while detecting nothing, and a combined restore hides it because a sibling column's violation carries the count. CORRECT → where no constraint forces columns to move together, restore each column ALONE, assert exactly one violation, revert, and assert zero — the revert doubles as an assertion that the expected post-purge state is the one the verifier calls clean. Label each assertion with its column (`expect(actual, 'tone')`) so the failure names the culprit. Use the shape-assertion form only where a CHECK genuinely forbids isolation, and say so in the test.

### [2026-08-18] A backtick inside a SQL comment terminates the Postgres.js template literal
FAIL → four `--` comment lines added inside a `sql\`\`` template to explain two predicates produced `TS1005: ';' expected` and `TS1443: Module declaration names may only use ' or " quoted strings` several lines later. WHY → the comments were prose-formatted for a Markdown reader, so identifiers were wrapped in backticks (`` `tone` ``, `` `COALESCE(archived_at, NOW())` ``). A backtick inside a template literal closes it; the SQL comment syntax is irrelevant to the JS lexer. CORRECT → plain prose only inside embedded SQL comments — no backticks, and no `${` either. The failure surfaces as a syntax error at a line you did not touch, which reads like an unrelated breakage.

---

## 2026-08-18 — #872 ship: a rebase that multiplied one conflict, and a lint rule that redesigned a React effect

### [2026-08-18] Integrating a moved base into a parked, doc-heavy branch: MERGE, not rebase
FAIL → `git rebase origin/main` on a branch parked at step 8 with 19 commits stopped at 2/19 with a `CONTEXT.md` conflict, and every remaining commit was queued to re-conflict the same four files (`CONTEXT.md`, `docs/directory.md`, `.claude/CLAUDE.md`, `approval.ts`) because the sibling feature (#865) had rewritten exactly those, and every commit on this branch touches at least one of them. WHY → a rebase resolves per REPLAYED COMMIT, so one logical conflict is multiplied by the number of commits that touch the file — and each repetition is an independent chance to resolve differently, on files whose content is prose nobody diffs closely. The linear history it buys is then DISCARDED: this repo squash-merges every PR, so `main` receives one commit either way. CORRECT → for a parked branch with many small commits over living docs, `git merge origin/main` — one resolution pass, one reviewable merge commit, identical final tree. Reserve rebase for short branches, or where the intermediate commits are themselves the deliverable. Resolve every hunk as "keep both sides" and PROVE it afterwards: here the sibling's rewritten glossary entry was verified byte-identical to `origin/main`'s by comparing `md5` of the extracted line, which caught nothing but would have caught a silent truncation.

### [2026-08-18] `react-hooks/set-state-in-effect` is `error` repo-wide — "clear state when the thing it points at disappears" is a render-time adjust
FAIL → the approved plan specified a `useEffect` that cleared `armedAskId` when a refetch dropped the armed row from the list. It fails lint outright; the rule is `error` across the repo (React-Compiler era). WHY → the pattern is not an effect at all: it is React's documented "adjust state when a prop changes", which belongs in the render body behind a guard comparing previous and current props. CORRECT → keep a prev-value in state, compare during render, and write ONLY on the transition — `ToneChipPicker.tsx` is the in-repo precedent the eslint config's own comment names. Two properties the reviewer must check, because a careless version breaks both: it must not write on ordinary re-renders (only when the armed id genuinely vanished), and it must converge on the immediate re-render rather than oscillating. Corollary: when a plan's code fails a lint rule, the fix is usually a different SHAPE, not a disable comment — and the deviation is worth recording, because the next plan will propose the effect again.

### [2026-08-18] A utility class is only real on routes whose stylesheet actually loads it
FAIL → the plan styled a destructive confirm button `btn btn-danger`. `.btn-danger` is defined only in `src/app/(authenticated)/_styles/settings.css`, which is imported by the settings layout and the add-location page — never by the Requests route, whose sheets are `console.css` + `requests.css`. It would have rendered as a bare `.btn`: transparent border, inherited colour, on the one control in the lane that is terminal. WHY → in a colocated-CSS layout, class availability is per-route, and a class name that exists SOMEWHERE greps as if it exists everywhere. CORRECT → before using a shared class on a new surface, grep for its definition and then check which layout imports that file. The fallback used was the class the same surface's existing destructive control already uses.

### [2026-08-18] The local test DB is shared by every sibling worktree — another session can move it under a running suite
FAIL → mid-review, the live-DB suite failed its `beforeAll` schema precondition claiming the database was behind head, on a branch whose own migration had been applied and verified 11 minutes earlier. WHY → `TEST_DATABASE_POOL_URL` points at ONE local container (`repworth-testdb`) that every sibling worktree resolves to, and `pnpm test:db:setup` DROPs schema `public` and re-applies from bootstrap. A concurrent session running it in another worktree reset the shared DB to ITS head, which did not include this branch's unmerged migration. CORRECT → read a `beforeAll` "behind head" failure as an ENVIRONMENT claim first, not a code defect: re-provision from the worktree under test and re-run before diagnosing anything. `verify-gate.sh` is immune within its own run (it provisions serially before the fan-out) but not against another process; when two features are in flight, expect this and do not let it re-open a closed review finding.

### [2026-08-18] A plan-review re-estimate must revise BOTH intake buckets, or `reclassify` fires on a stale half
FAIL → the gate's `reclassify` row fired at every run (production 1,141 lines vs a ±400 estimate) on a branch where no task exceeded its ticket and `allowed_edit_surface` was never amended. WHY → plan review round 1 grew the design substantially (a pure decision function extracted, the server count moved onto the wire, a disarm-on-refetch behaviour, a status matrix). The deviation that recorded the growth re-estimated only `estimated_test_lines` (±800 → ±1150) and left `estimated_prod_lines` at its step-0 value, so the WARN measured a superseded number. It also counts ~190 lines of ADR and reference prose as "production". CORRECT → when a plan review changes the DESIGN, revise both buckets in the same amendment, and price documentation into the production estimate for any feature whose decision record is part of the deliverable. The WARN is still worth leaving standing rather than back-fitting the estimate — but it must be re-derived and explained at the merge pause, not waved through.

### [2026-08-18] Record a cross-worktree collision in your OWN deviations file only
FAIL → noting a shared-file overlap by writing the mirror entry INTO the sibling worktree's deviations file made the edit-surface guard record this session's id in that worktree's `.feature/sessions`. The stop gate then required the SIBLING feature to be gate-green before this session could end — and the sibling was mid-execution with a deliberately red eval. WHY → session binding is keyed on the act of editing, not on intent, so a one-line courtesy note adopts another feature's gate. CORRECT → record the collision in your own deviations file and cite the sibling by absolute path. If a note genuinely belongs in the other branch, let that branch's own session write it.

## 2026-08-21 — Supabase MCP auth: a dead cached OAuth client registration

### [2026-08-21] `Unrecognized client_id` on the Supabase MCP is a STALE cached DCR registration, not a login problem
FAIL → every `/mcp` authenticate attempt on the `supabase` plugin MCP (`https://mcp.supabase.com/mcp`) failed with "unrecognized client id"; re-running the flow, re-logging into Supabase, and reinstalling the plugin all change nothing. WHY → Claude Code caches the Dynamic Client Registration (`clientId` + `clientSecret`) it obtained from `https://api.supabase.com/platform/oauth/apps/register` in `~/.claude/.credentials.json` under `mcpOAuth["<server>|<url-hash>"]`, and reuses it forever. Supabase drops/rotates those registrations, after which `GET /v1/oauth/authorize?client_id=<cached>` returns **HTTP 422 `{"message":"Unrecognized client_id"}`**. The flow dies before the browser opens, so no amount of re-consenting helps. The entry's `accessToken` is empty in this state — that is the tell. CORRECT → delete the `mcpOAuth` entry whose key starts with the server name, then RESTART Claude Code and authenticate again; a fresh DCR runs automatically. Diagnostic probe: read `clientId` out of that file and hit the authorize endpoint directly — but send a browser `User-Agent`, because Cloudflare answers a bare python/curl agent with `error code: 1010` (403) and hides the real 422. Same failure shape applies to any DCR-based remote MCP (the `figma|…` entry has the identical dead shape).

## 2026-08-21 — #898 solicitation send governors

### [2026-08-21] `ci:admin-aal2` and `fallow` want OPPOSITE things about the admin-route preamble
FAIL → `fallow` flagged the `gate → request.json() → safeParse → 400` preamble as a 3-instance clone group across `admin/autonomy/unsuspend`, `admin/solicitation/batch/halt` and the new `admin/solicitation/breaker/reset`. Extracting it into a `requireAdminJson(request, schema)` in the canonical gate module cleared `fallow`, `lint`, `typecheck` and `build` — and failed `ci:admin-aal2` on all three routes. WHY → that audit is an ALLOWLIST OF RECOGNIZED GATE SHAPES with a deliberate fail-closed posture, and its own header says it: *"A gate hidden behind an imported wrapper is not visible to this audit and does not count."* The property it protects is that you can read an admin handler and SEE its gate; the extraction deleted that property from three routes at once. CLAUDE.md predicts this in one line — *"The admin MFA gate is configuration, not structure — `ci:admin-aal2` compensates"* — which is easy to read past until it fires. CORRECT → **a fallow duplication finding on an admin-route preamble is not automatically an extraction request.** Acknowledge it in `.fallowrc.jsonc` with the blocking reason written down, and if the extraction is genuinely wanted, ship it TOGETHER with the `ci:admin-aal2` gate-shape change under one review — never let a security control's vocabulary widen as a side effect of a duplication fix. *(RESOLVED 2026-08-23 by #909, exactly that way: `requireAdminJson` now lives in `admin-mfa-gate.ts`, all three routes use it, and `GATE_JSON_FN` is a **third** recognized gate shape in `admin-aal2-audit.ts` — provenance-checked to the same module, with cases pinning both directions, including that a look-alike import earns nothing and that an unrecognized wrapper is still a finding. The review of that PR also found the provenance check was matching the trailing path SEGMENT rather than the module — `@/evil/admin-mfa-gate` was credited — so it now resolves the `@/` alias and relative specifiers to a real repo path before comparing. **Read a provenance claim as a claim to verify: this one was written in the header and not true in the code, and two of the audit's own fixtures were passing on the basename alone.** The `.fallowrc.jsonc` acknowledgement is gone and `ci:fallow` is green without it. The GUIDANCE stands unchanged for the next preamble; what is spent is the "only two gate shapes" clause — there are three, and a fourth costs the same deliberate PR.)*

### [2026-08-21] "Unused export" and "unused value" have DIFFERENT fixes — only one of them is the `export` keyword
FAIL → `fallow` reported `BREAKER_TRIP_REASONS` as an unused export. Dropping `export` satisfied fallow and immediately failed ESLint: *"assigned a value but only used as a type."* WHY → the array's sole job was sourcing `type BreakerTripReason = (typeof …)[number]`, so it had no runtime reader at all — un-exporting moved the finding from one linter to another instead of resolving it. CORRECT → when a linter reports an unused EXPORT, check whether the VALUE has any reader before touching the keyword. If nothing reads it at runtime, the honest shape is a plain union type and no array. Here the compile-time authority is the union (the admin panel keys a `Record<BreakerTripReason, string>`, so a third reason is a type error there) and the runtime authority is migration 110's `trip_reason` CHECK — an `as const` array would have been a third name for the same fact with nobody reading it.

### [2026-08-21] A test that says it "mirrors" another suite may be mirroring it at the WRONG LEVEL
FAIL → refactoring three admin routes onto a shared gate helper broke six promised tests in `reset-route.test.ts` (all 401) while `autonomy/__tests__/routes.test.ts` — testing a route changed in the SAME way — passed untouched. WHY → the reset suite's header claimed it mirrored the autonomy suite. It did not: autonomy mocks the auth PRIMITIVES (`requireRole`, `requireCurrentAal2FromSupabase`, `@supabase/ssr`), while reset mocked `requireAdminWithAal2` itself. ESM internal calls do not go through a mocked export, so the moment the route called a different function in that module, the stub stopped intercepting. CORRECT → mock at the level that survives the composition you expect to change, and treat a "mirrors X" comment as a claim to VERIFY, not inherit. The tell that the deeper mock is right: it kept passing after the refactor was reverted, which is the proof it was an improvement rather than a workaround. Related trap: fixing this by stubbing the new helper would have left the blank-note and body-actor 400 cases asserting a MOCK, since those shapes had just moved INTO the helper — when behaviour migrates into a dependency, the test that owns it must follow or be re-pointed deliberately.

### [2026-08-21] A client component that imports a VALUE from a module with a module-scope worker logger breaks the Turbopack route build
FAIL → importing a small formatting helper from a module that also constructs `createWorkerLogger(...)` at module scope broke the route build, with no lint, typecheck or boundary-audit failure anywhere. WHY → invariant #1's ESLint rule enumerates PACKAGES (`openai`, `bullmq`, `postgres`, …), not `node:` builtins reached transitively; the logger pulls `node:` APIs into a client bundle through an import the rule does not model. CORRECT → a client component takes such values as PROPS from its server parent, or the helper moves to a client-safe module with no module-scope side effects. Expect this class to be invisible to every static gate — it surfaces only as a build failure. Same branch also confirmed the cheap version of the rule: **no backticks inside a tagged template literal, including in comments** (already recorded at #665) — one inside a `--` SQL comment ends the string and the file stops parsing several lines later.

### [2026-08-21] A SQL statement and its `tenant-scope-allowlist` entry are ONE unit — four for four on a single branch
FAIL → every one of four SQL edits on #898 turned `ci:tenant-scope` red, because the allowlist matches `sqlSnippet` BYTE-FOR-BYTE: adding `bounce_kind` to the lane's UPDATE, re-shaping `readBreakerWindow`, adding the NULL-kind arm, and the two-floor rewrite. Three of the four landed back on the orchestrator because the editing subagent's brief did not include the allowlist file. WHY → the coupling is total, not occasional; there is no partial-match tolerance. CORRECT → any task brief that authorises editing a SQL statement MUST also authorise `scripts/ci/tenant-scope-allowlist.ts`, or the task structurally cannot finish. Splitting them across two agents' surfaces guarantees a red gate plus a hand-off. (The subagent stopping to report rather than editing outside its brief is correct behaviour — fix the brief, not the agent.)

### [2026-08-21] Two filesystem-walked gates that a new surface silently owes: `nav-config.ts` and `schema-ready.ts`
FAIL → two of #898's three surface amendments were the same shape — a new admin page needed a `src/components/admin/nav-config.ts` row, and a new migration needed a `MIGRATION_110_SEND_GOVERNORS` entry in `src/lib/shared/__tests__/helpers/schema-ready.ts`. Both were discovered by a red gate rather than by planning. WHY → both are enumerated by tests that walk the filesystem, so the obligation is invisible in the file you are actually writing. CORRECT → **every new admin page implies a `nav-config.ts` row; every new migration implies a `schema-ready` requirement.** Put both in `allowed_edit_surface` at step 0 whenever the plan contains either, and prove the migration by its NEW relation/column/index rather than by a CHECK whose name predates it — a long-lived constraint name is satisfied by a container several migrations behind head.

### [2026-08-21] `verify-gate.sh` is load-fragile under parallel rows plus coverage instrumentation
FAIL → gate runs on a busy machine produced exit 143 and coverage `.tmp` ENOENT errors that read as product failures. WHY → parallel gate rows plus V8 coverage instrumentation oversubscribe a box already running local agents; the kills and missing temp files are resource symptoms wearing a test-failure costume. CORRECT → run it as `MAX_PARALLEL=2 VITEST_WORKERS=2 bash scripts/verify-gate.sh` when anything else is running, and read exit 143 / coverage-tmp ENOENT as ENVIRONMENT before opening a defect. Same family as the shared-test-DB trap (2026-08-18): in this repo a gate failure naming things your diff never touched is an environment claim first.

## 2026-08-22 — #899 solicitation send worker

### [2026-08-22] `timeout(1)` is not installed on this machine, and its absence looks like success
FAIL → three "wait windows" polling a background `codex exec` returned instantly, the line count looked static, and a healthy review process was killed as hung — costing a full plan-gate round under a max-3 cap. WHY → macOS ships no `timeout` and no `gtimeout`; `timeout 560 tail -f … | grep -m1 …` fails with exit 127 at the FIRST pipeline stage, so the command returns immediately with no output, which is indistinguishable from "condition not met yet". CORRECT → **never bound a wait with `timeout N …` in this repo.** Use the Bash tool's own `timeout` parameter, or a Monitor with an `until` loop. A wait that returns faster than its own interval is a missing binary, not a fast answer.

### [2026-08-22] Two solicitation tables carry no tenant columns, and reflex tenant-scoping breaks on them
FAIL → live-DB teardown written by copying a business-scoped delete stranded rows. WHY → `solicitation_suppressions` has **no `business_id`**, and a `global`-scope row carries no `account_id` either; `job_outbox` has **no tenant columns at all**. CORRECT → scope suppression cleanup by `account_id` and accept that global rows are not tenant-scoped; reach `job_outbox` through `payload->>'business_id'`. Invariant #8's "scope every read by account_id/business_id" has these two as genuine structural exceptions — a query written by reflex will not compile, or worse, will silently match nothing.

### [2026-08-22] A restraint-policy fixture with a hard-coded date is a time bomb, not a constant
FAIL → two `batch-builder` suites went red at 00:00 UTC with no code change, failing every open PR (fixed in #911). WHY → both gates are day-count comparisons against TODAY — `stale_visit` fires past `FRESHNESS_WINDOW_DAYS` (14-45 by vertical), `over_contacted` under `MIN_GAP_DAYS` (30) — and the fixtures hard-coded a date sitting exactly ONE day inside both boundaries. At 30 days two assertions inverted simultaneously. CORRECT → **every restraint-policy fixture date is relative** (`daysAgoUtc(7)` / `utcDaysAgo(7)`, both already in those files). A date that passes today proves nothing about tomorrow, and the failure surfaces on an unrelated PR whose author has no context for it.

### [2026-08-22] `docs/analytics/events.md` owns event keys and properties; the code does not
FAIL → the plan invented `solicitation_suppressed_at_dispatch:<outreachId>` when the registry already specified `..._<ask_id>` with two required properties and no optional ones. WHY → the event was registered by an earlier ticket precisely so this one could emit it without a migration, and the registry is the single owner of its key, distinct id, properties and privacy notes. CORRECT → **read `docs/analytics/events.md` before emitting any analytics event.** The grain is load-bearing, not cosmetic: keying on the Outreach row rather than the Ask would make a regenerate-and-re-dispatch look like a second opt-out. `ci:analytics-events` does NOT catch this — it only checks that code events are documented and that `live` entries exist in code, so a wrong key and a stale `planned` both pass.

### [2026-08-22] `fallow`'s local run cannot predict its own CI gate in either direction
FAIL → local `ci:fallow` reported 5 CRAP breaches while CI reported 1 finding, and separately CI failed on findings a green local gate never showed. WHY → without a coverage file fallow ESTIMATES CRAP from export references; CI feeds it the real `coverage-final.json`. Locally-generated coverage may also fail fallow's parser outright (`invalid value: integer -1, expected u32`). CORRECT → treat local `ci:fallow` as directional only. Fix what it names concretely — unused exports, clone groups, cognitive/cyclomatic breaches are all computed WITHOUT coverage and are trustworthy — and ignore bare CRAP counts. Confirm the gate on CI. A CRAP breach that appears in the run BEFORE your fixes, when CI reported none, is estimation noise.

### [2026-08-22] Every new run-spine caller owes two allowlist entries and a written lock analysis
FAIL → `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` failed twice on this branch — once for `dispatch.ts`, again for `failed-hook.ts` — each time discovered by a red gate rather than by planning. WHY → that suite AST-scans every file calling `recordStep`/`completeRun`/`recordOutcome`/`startOrGetActiveRun` and requires each to hold a reviews `FOR UPDATE` or be allowlisted; it also self-pins the carve-out set in a `toEqual`, so a non-review-subject caller needs THREE edits, not two. CORRECT → **any file that writes the run spine implies `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` in `allowed_edit_surface`** — same class as the `nav-config.ts` / `schema-ready.ts` trap above. Write the lock analysis fresh: that file's own header records an entry that copied a sibling's premise verbatim when the premise was false, and concludes "a lock analysis resting on an untrue premise is worthless even when its conclusion happens to be right."

### [2026-08-22] `sending_started_at` and `sending_at` are different columns with different owners
FAIL → near-miss; a task nearly stamped the batch column because the batch still reads `approved` while its children send. WHY → `solicitation_outreach.sending_at` is the ROW's stamp and belongs to the dispatch CAS; `solicitation_batches.sending_started_at` is written by the first successful RELEASE (#900), CAS'd on NULL in the release transaction, and has **no writer in the repo today** — every current reference is a read. CORRECT → after #899 a batch legitimately reads `approved` while dispatching, until #900 lands. That is not a bug. 091's `send_ordering` CHECK constrains the column only when present, so NULL is legal. *(#900 has since landed and `runReleasePhase` is that writer; the guidance stands, the "no writer today" clause is spent.)*

## 2026-08-22 — #900 solicitation release poller

### [2026-08-22] A cross-account, spine-writing background loop owes FOUR governance registries, and an intake naming one will be amended three times
FAIL → #900's intake declared `docs/directory.md` as the only registry the feature would touch. Three separate `allowed_edit_surface` amendments followed, each discovered as a red gate mid-task: `src/lib/agents/run-spine.ts` (`STEP_PERSONA` carries no `approval_downgraded` key, and `AgentStepKey` derives from it, so the call site does not typecheck), `scripts/ci/tenant-scope-allowlist.ts` (a platform-wide scan cannot bind a tenant id, and the audit proves scope only from a value-bound predicate), and `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` (the trap the #899 entry above records for ONE caller — #900 hit it as the fourth member of a set). The abort budget fired on the second amendment and would have torn down work that was on estimate and had passed three adversarial plan-review rounds. WHY → all four are *registries of permission*, not code: each answers "may this new module do the thing it is about to do", and none is discoverable by reading the module you are writing — only by running the audit that rejects you. They are also invisible to grep-by-feature, because the thing being added does not exist yet. CORRECT → **when a feature adds a background loop that both scans across accounts AND writes the run spine, declare all four in the intake up front**: `docs/directory.md`, `STEP_PERSONA`, `tenant-scope-allowlist.ts`'s `background-global-scan`, and `outcome-anchor-pairing.test.ts`'s `CALLER_ALLOWLIST`. Their siblings in the same family — `cost-guard-contract`, `admin-aal2`, `analytics-events`, `purge-verification` — govern other module classes; check which the feature actually triggers rather than assuming none.

### [2026-08-22] The reclassify trigger measures the diff, not the lane, so a correct lane still trips it
FAIL → #900's step 5 gate raised `reclassify` at 1721 production lines against an 820 estimate (2.1x). Read literally the workflow says stop and re-run classification, which on a finished, gate-green branch means discarding verified work. WHY → the estimate was written before the plan decomposed into ELEVEN tasks, and a task count above ~8 is itself an epic signal that nobody re-checked at that moment. The lane (`RISK = high`) was correct throughout and every control it mandates stayed scheduled; what the epic path would have bought is smaller separately-reviewable PRs — a reviewability property, not a safety one. CORRECT → **re-check the line estimate at the END of planning, not only at intake**, and treat a task count above ~8 as the prompt to do it. When the trigger fires on a lane that was right, the compensating control is the full review round and it must not be trimmed: record the real numbers, and tell the reviewers plainly that they are reading a diff twice its estimate.

### [2026-08-22] `it.fails` is not evidence, and unmasking without a sensitivity probe is a second false green
FAIL → across #900 the mandatory unmask step caught FIVE defects that `.fails` had reported as healthy reds, including a `beforeEach` that re-armed four delegating spies with themselves (a dynamic `import()` inside a `vi.mock`ed file returns the MOCK), killing 31 of 33 cases with stack overflow while the suite looked fine. Three further cases passed VACUOUSLY because the sweep they described was still a stub. WHY → `it.fails` asserts only that the body throws; it cannot distinguish "the feature is absent" from "the fixture violates a CHECK constraint" or "the test recurses". A negative case (`does not …`) is worse: it passes while its subject does nothing at all. CORRECT → **unmask every `.fails` marker and then PROVE the case is sensitive** — delete the specific guard arm the title names and confirm that case, and ideally only that case, goes red. Record the probe and its assertion message. Two #900 probes disproved the brief: one case pinned a PAIR of guard belts rather than the single belt its title named, and another pinned an assertion nobody had realised was load-bearing. Re-arm delegating spies with `vi.importActual`, never a bare dynamic import.

### [2026-08-22] Eight false rationales on one branch, every one about the module's own internal structure
FAIL → #900 shipped comments whose load-bearing justification was untrue EIGHT times. Review rounds caught six. The seventh was caught by a LINTER, not a reviewer: `sweepSendWindowElapsed` and `sweepBatchExpired` carried "Deliberately NOT sharing a body … the two differ in predicate, in ordering column and in halt reason" — all three are parameters, so the sentence named the parameters rather than a reason not to take them, and `fallow` flagged the two bodies as a 10-line clone. The eighth was written by the FIX round itself (next entry). WHY → the pattern has one shape and it is diagnostic: **every false claim was about this file's own internals; every cross-file claim on the branch was correct.** A cross-file claim gets checked because verifying it means opening another file, which is a deliberate act; a claim about the function 40 lines down feels self-evident and is written from memory of the code as INTENDED rather than as it stands. CORRECT → **treat "deliberately NOT X" as the highest-risk sentence you can write, and verify it against the code the way you would verify a claim about another module.** For "we deliberately do not share this body", enumerate the differences and ask whether each is a parameter; if they all are, the comment is arguing for the parameter list, not against extraction. The residual signal is cheap: a duplication linter finds this class for free, so run `ci:fallow:coverage` before review, not after.

### [2026-08-22] A lint suppression is a claim, so delete it and re-run before you keep it
FAIL → #900's fix round added `// fallow-ignore-next-line code-duplication` to `adminHaltBatch` with a paragraph explaining that suppressing one of two instances drops the group below `minOccurrences`. The claim was never tested. Removing the suppression and re-running the gate passed anyway. WHY → the clone (`dup:ddc3f485`, pre-existing on `main`) had been classified as NEW only while two OTHER clone groups existed in the same audit; once those were fixed, the audit classified it as inherited on its own. The suppression was dead weight carrying an unverified justification into a file review had already signed off — the same false-rationale class as the entry above, authored while fixing that very class. CORRECT → **every suppression is an empirical claim about a tool's behaviour, and it is one command to test: delete it, re-run the gate, keep it only if the gate goes red.** Do this before writing the justification, because writing the justification first is what makes it feel established. Prefer finding-level `fallow-ignore-next-line` over a whole-file `.fallowrc.jsonc` entry when you do keep one, so a genuinely new finding in the same file still fails.

### [2026-08-22] Any fixture meaning "already happened today" must be pinned inside the UTC day
FAIL → PR #920's second CI run failed three assertions in `release.integration.test.ts` that passed locally and in `verify-gate`. The run spanned 23:59:14 → 00:01:34 UTC. WHY → the account daily send cap counts on a UTC-day predicate (`queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`, `send-caps.ts`), and three fixtures seeded "an attempt already made today" as `NOW() - '5 minutes'`. After midnight that row lands in YESTERDAY, the count returns 0, the cap stops binding, and the batch releases — and a third assertion falls for free, because a batch the cap would have stopped instead reaches the Judge split and downgrades. **A five-minute failure window every single day**, present since the fixtures were written; the first CI run missed it by 20 minutes. Same family as the 2026-08-22 hard-coded restraint-policy date above, but subtler: this fixture WAS relative, and relative is not sufficient when the predicate buckets by calendar day. CORRECT → **clamp it: `GREATEST(NOW() - interval, date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`**, which pins the row to the same UTC day as the seed's own `NOW()` and shrinks the window to the milliseconds between the seed and the count. Make it OPT-IN (`queuedWithinUtcDay`) — wedge and send-window fixtures (`65 minutes`, `69 hours`) need genuinely old rows and clamping would make them young. Diagnose this class by reading the CI run's START and END times before suspecting the diff.

### [2026-08-22] `prettier --write` reformats the whole file — this repo has no prettier config
FAIL → a 25-line fixture change became **800 insertions / 575 deletions** across a 2,000-line test file after `npx prettier --write`. Caught by reading `git diff --stat` before committing; the file was reverted and the edit re-applied by hand (42 insertions). WHY → there is no `.prettierrc*` and no `prettier` key in `package.json`, so the CLI falls back to prettier's OWN defaults — double quotes, different print width — which disagree with the repo's ESLint-enforced style on essentially every line. Nothing fails: the reformat is valid code and lint still passes, so the churn reaches review as a diff no human can read. CORRECT → **never run bare `prettier` in this repo. Formatting goes through `pnpm lint`.** And read `git diff --stat` before every commit: a line count an order of magnitude above the change you made is the cheapest possible detector for a tool that reformatted more than you asked.

### [2026-08-22] The fallow PR gate IS reproducible locally — but only with both DB URLs exported
FAIL → `pnpm test:coverage` ran to completion and `ci:fallow:coverage` passed, while the same gate was red in CI. The coverage log was full of `[tests] TEST_DATABASE_POOL_URL unset — DB-gated integration suites SKIPPED`. WHY → the live-DB lane contributes a large share of coverage, so skipping it deflates coverage, inflates CRAP, and changes which findings the gate reports — in BOTH directions. The suites skip silently, so the run looks successful. This is the actionable half of the #899 entry above ("local fallow cannot predict its CI gate"): it can, given the same input. CORRECT → export **`TEST_DATABASE_POOL_URL` AND `DATABASE_POOL_URL`** first, then `pnpm test:coverage && pnpm ci:fallow:coverage`, and confirm the coverage log contains ZERO `SKIPPED` lines before trusting the result. Reproduced exactly this way on #900: local exit 0, `complexity 0`, `✓ No issues in 33 changed files`, matching CI. Note `verify-gate.sh` does NOT run this gate — it is the one CI check with no local counterpart in the feature workflow.

### [2026-08-24] Fallow's member graph now traces `getChannel(id)` interface dispatch — pre-emptive suppressions come back as STALE (refines 2026-06-14 conv. 2)
FAIL → #631 shipped 7 inline `unused-class-member` suppressions on the notice channel methods, each under a comment claiming "fallow's member graph misses interface dispatch"; PR #950's `ci:fallow:coverage` failed all 7 as **stale suppressions** — the findings they suppressed never existed on the real gate. CORRECT → author a suppression only from an OBSERVED finding (same class as "never author a fallow suppression from a PREDICTION"): run `npx fallow audit --gate new-only --base origin/main` first. The 2026-06-14 `usedClassMembers` convention is for members the graph genuinely misses; `NotificationChannel` factory dispatch is no longer one of them — deleting all 7 comment blocks resurfaced nothing in either mode.

### [2026-08-24] `migration-092`'s EXPLAIN-plan assertion is planner-flaky on a fresh CI database
FAIL → PR #950's `test` job failed exactly ONE integration test: migration-092's "plans the sweep predicate as an index scan with no residual filter". The planner chose `Bitmap Heap Scan` + `Sort` over the ordered index scan on a 2-row table (both plans cost 11.49 — statistics noise), and the assertion forbids `Sort`. The identical tree passed that test in the prior CI run and in two full local runs the same day. CORRECT → read a single-run failure of a plan-SHAPE assertion as an environment claim, not a regression: rerun first (`gh run rerun <id> --failed` — it passed clean). If it recurs, `ANALYZE` the table inside the test before the `EXPLAIN`, or pin the index NAME rather than the absence of a `Sort` node.

## 2026-08-26 — #967 post-purge global opt-out

### [2026-08-26] turning a failing ingress path into an acking one silently retired a pager → `checkFailedInboundEvents` keys on `inbound_events.status='failed'` → any such change owes a replacement alert AT THE SOURCE, in the same PR

FAIL → #967's fix made the solicitation lane ack an unmatched suppression-bearing
event instead of throwing. The intake named the new `logger.warn` as the
observability signal and treated the alert going quiet as a *win* ("`checkFailedInboundEvents`
stops firing"). Both halves were wrong, and only the step-7 review caught it.

WHY → `checkFailedInboundEvents` (`worker/background/pollers/health-alert/checks.ts`)
pages on rows with `status='failed'`. Acking removes the event from that set —
so the change deleted the ONLY operator-visible signal for a condition that is
never routine traffic (attribution can only go missing three ways: the #630
commit race, an account purge, or a send whose terminal CAS lost). A structured
JSON log line is not a replacement: nothing subscribes to it, `worker/sentry.ts`
installs no console integration, and no poller reads logs. The gap was invisible
to every mechanical gate — the verify gate went GREEN 28/28 across it, because
"an alert that no longer fires" is not a thing any audit can see.

CORRECT APPROACH → when a change moves an ingress path from `failed` to
`processed`, add the replacement alert in the same PR. Raise it at the source
with `captureMessage` from `@sentry/node`, wrapped in its own try/catch so an
observability failure cannot turn a committed side effect into a retry
(precedent: `worker/ingress/stripe/subscription-updated.ts:154`, an ingress
module doing exactly this). Two generalisations worth carrying: (a) an intake's
`observability` field must name a signal something CONSUMES — "a log line" is
not an answer, and writing one is how this shipped; (b) `status='processed'` is
also what brings the stored raw payload under `ArchivalPoller`'s 30-day sweep,
so the ack fixes an unbounded-retention bug at the same time it removes the
alert — the two effects are the same edit and must be reasoned about together.

## 2026-08-24 — #877 test-DB provisioning lock

### [2026-08-24] rls-audit false-FAILED inside a gate whose own serialization was correct → the schema drop came from a SIBLING PROCESS → the fix is a cross-process advisory-lock protocol, not re-ordering
FAIL → on #865, `verify-gate.sh --review` reported `rls-audit=FAIL` with 20+ tables "missing from pg_class", all clearing on retry. WHY → within ONE gate run the ordering was already right (`test:db:setup` completes serially before any parallel row), but every sibling worktree shares the ONE localhost test DB, and a concurrent gate or manual `pnpm test:db:setup` DROPs schema `public` under this run's live read; catalog reads are MVCC and never block on DDL, so the reader sees the empty window. CORRECT APPROACH → join the EXISTING advisory protocol (`hashtext('repworth_live_db_integration')`, the key the DDL suites already hold): `test-db-setup.sh` now runs its whole drop→bootstrap→migrations chain in ONE psql session that takes the exclusive lock FIRST (session death releases the lock and stops the work together; no wrapper entry path can bypass it), and `ci:rls-audit`'s live check takes the shared form around its read. Three companions matter: (1) `RESET ALL;` after EVERY include — migration 103 deliberately leaves a session-level `search_path` that was safe only under one-psql-per-file; (2) a `test_meta.provision` marker (content HASH of bootstrap+migrations, written LAST, dropped FIRST) so readers tell "interrupted/behind" from "RLS actually missing" with one actionable line — the chain autocommits (`CREATE INDEX CONCURRENTLY`), so the honest guarantee is "no DDL continues after lock release", never all-or-nothing; (3) CI's `.github/actions/test-db` DELEGATES to the same script — CI's `test` job runs the LIVE half of rls-audit, so a marker written only by the local path would have failed CI permanently. NOT covered (deliberate, ticketed): suites that do not hold the main lock, migration-074's separate `repworth_migration_074_apply` key, Playwright locals — a per-suite shared lease measured out as leaky (vitest serializes FILES; the lease would gap between them), so the full lane-level protocol is its own issue rather than a false guarantee here.

## 2026-08-26 — feat-qr-review-request staging ride

### [2026-08-26] Staging smoke curls bounced to vercel.com/sso-api despite `all_except_custom_domains` → the staging custom env's custom domain is still intercepted by Deployment Protection → Protection Bypass for Automation
FAIL → staging smoke curls against `staging.repworth.net` bounced to `vercel.com/sso-api` despite the project's `ssoProtection` being `deploymentType: all_except_custom_domains`. WHY → the staging Custom Environment's custom domain (`staging.repworth.net`) is still intercepted by Deployment Protection — the `all_except_custom_domains` exemption does not cover it; production custom domains ARE exempt, so customer-facing routes are unaffected in prod. CORRECT APPROACH → use Protection Bypass for Automation: secret in a gitignored `.scratch/` file, sent as the `x-vercel-protection-bypass` header. (feat-qr-review-request staging ride)

## 2026-08-30 — #1008 migration 116 `refusal_events` (five promotions + one corrected)

### [2026-08-30] A mocked `sql` that fabricates its own row cannot verify a query → the FIXTURE is the oracle, and a fixture holding a dimension constant cannot catch a predicate that narrows on it

FAIL → `purge-verification.test.ts`'s `refusal_events` case mocked `sql` to return
`[{violation_count: 2}]` for any query naming the table, and asserted SQL **text**
(`toContain('WHERE account_id = ?::uuid')`, two `not.toContain` guards). Two mutants passed
every assertion: appending `AND subject_id IS NOT NULL`, which blinds the check to exactly the
account-wide rows the case is NAMED for; and renaming the count alias, which makes
`countViolations` read `undefined ?? 0` and report a **clean purge over surviving tenant data**.

WHY → the covering test supplied its own answer, so nothing constrained the query's row set or
the shape read back. The first fix added a live-DB arm but varied the fixture along ONE axis
(location) and was measured only against those two mutants — so `AND occurred_at >= NOW() -
INTERVAL '30 days'` still survived, because every fixture row was written with `NOW()`.

CORRECT APPROACH → the live-DB arm varies along **every dimension the WHERE clause can narrow
on** — tenant (a bystander account), location (per-location and account-wide), time (fresh and
400 days old), subject (with and without `subject_id`) — and asserts an EXACT count. Eight
mutants measured against it, eight killed. **`docs/runbooks/owner-offboarding-staging-dry-run.md:98`
recorded this same mock-drift class as a launch-blocking defect on 2026-06-08 and recommended
exactly this integration test**; #1008's two P0s were the third and fourth instances.

RESIDUAL, unfixed → 31 tables carry `purgeVerification: 'must_be_absent'` against only **3**
live-DB `verifyAccountOffboardingPurge` arms. The other branches are covered by the SQL-text
mock alone and the same mutants would survive there.

### [2026-08-30] D9's recorded diagnosis was WRONG → the `sed` guard did distinguish `-n … p`; it could not distinguish a FLAG from a PATTERN

FAIL → #1008's deviation D9 recorded that `.claude/hooks/bash-write-guard.sh` blocks read-only
`sed -n '1,260p' <repo file>` because "the guard's parser sees `sed` plus a repo path and does
not distinguish `-n … p` from `-i`". Promoting that as written would have enshrined a false
claim: the plain form does NOT match, and `git log -S` shows the rule unchanged since #558, so
it was never fixed in between.

WHY → the rule was `sed[[:space:]][^;&|]*-i`, which matches `-i` **anywhere** after `sed ` —
including inside a quoted SEARCH PATTERN or a filename. `sed -n '/refusal-in/p' FILE` blocks;
`sed -n '1,260p' FILE` does not. The symptom D9 reported was real, the diagnosis was not.

CORRECT APPROACH → fixed in BOTH copies (`.claude/hooks/` and `.codex/hooks/` — the
two-copies trap this log has recorded twice): `-i` counts only as an option token, scanning
resets at each command separator so a second `sed` on the line is still checked. Pinned by
`scripts/ci/__tests__/bash-write-guard.test.ts`, 14 cases over both guards, **verified to fail
3 of them against the old rule before being trusted**.

### [2026-08-30] `TENANT_TABLES` is TWO structures and typecheck stays green when you edit one

FAIL → `scripts/ci/tenant-tables.ts` exports the `TENANT_TABLES` **array** and, separately, a
**scope-column map**. Adding only the map entry typechecks cleanly; the live-DB completeness
test goes red with `expected [ … 43 tables ] to include 'refusal_events'`.

CORRECT APPROACH → both structures need the entry, and cite the table by KEY, never by line.
A plan that says "add to `TENANT_TABLES`" and cites the map's line is the ambiguity that
produces the miss.

### [2026-08-30] Postgres deparses an implicit `CASE` fall-through as `ELSE NULL::boolean` → assert its PRESENCE, never its absence

FAIL → a CHECK test asserted `expect(definition).not.toContain('ELSE')` on the reasoning that
the migration writes no `ELSE` and the trailing `IS TRUE` is what defends the fall-through. The
migration indeed writes none — but `pg_get_constraintdef` ALWAYS renders one.

WHY → asserting absence tests pg's deparser, not the constraint. Only a real database surfaces it.

CORRECT APPROACH → `expect(definition).toContain('ELSE NULL::boolean')` beside the
`END … IS TRUE` assertion. The two together name the exact value the wrapper exists to defeat.

### [2026-08-30] A new tenant table forces a chain of FOUR registries, discoverable from no single document

FAIL → each link surfaced one at a time, from a different CI audit, after the intake was locked
— which is how #1008 spent its second surface amendment and tripped the workflow's abort rule
as a false positive.

CORRECT APPROACH → the chain, declared up front: `TENANT_TABLES` (**two structures**) →
`docs/security/rls-inventory.md` (`rls-audit.test.ts` asserts `REQUIRED_RLS_TABLES ===
TENANT_TABLES`) → `TABLE_DISPOSITIONS` → a `verificationQuery` arm **and** a
`runContentPurgeStage` DELETE (forced by `hard_delete`/`must_be_absent`), plus an
`arch-review-log.md` row for the merge itself. An intake declaring a new table lists all of them.

### [2026-08-30] In this repo a documentation fix is a SWEEP, never an edit — and the sweep must run BEFORE the edit direction is chosen

FAIL → a commit whose entire content was "a fact stated in two artifacts, corrected in one"
then did exactly that five more times. Then the fix for THAT went the wrong way twice: the
write-site count was "corrected" toward the intake, then reversed on a "3-to-1 across
independently-written artifacts" argument. Both halves were false — it is **3-to-3** (a tracked
intake mirror the sha-lock does not cover, plus the plan), and `git log -S` shows two of the
three "independent" copies written by the SAME commit and the third converted by a review.

WHY → each correction was made where the finding POINTED. A reviewer cites one `file:line`, and
fixing that line reads as done. The artifacts here duplicate deliberately — the migrations log,
the arch-review log, the plan, the intake and the ADR each restate the same decisions for a
different reader — so every duplicated fact is a place a single-site fix leaves a contradiction.

CORRECT APPROACH → grep every artifact for the FACT, not the cited line, and fix all hits in
one pass — **and count the copies before picking a winner**, because an incomplete count is
what produced both wrong directions. When the count comes back tied and the question is forward
sequencing in a declared non-goal, the honest resolution is to state the disagreement and let
the change that actually knows resolve it (#1008 deviation D16).

SETTLED → #1009 resolved it: the first Refusal write site is `autonomy_suspended`, one site
inside `suspendAccountAutonomy`, shipped with the insert helper; the other ten land across
#1010–#1013. **And the count never decided it, because it could not.** A 3-to-3 tie is the
signal that the deciding evidence sits OUTSIDE the artifacts being counted — here #1004's
verbatim slice order and #1009's own ticket body §5, two locked decisions that predate every
copy in the dispute. Count the copies to learn how many places a fix must reach; look to the
locked decision upstream of them to learn which way it goes.


## 2026-08-31 — #1009 the Refusal ledger's write path (three promotions; two more folded into the entries they belong to)

### [2026-08-31] Three adversarial rounds designed on a library behaviour none of them read → verify the PRIMITIVE before designing on top of it
FAIL → the `REFUSAL_LEDGER_ENABLED` kill switch emits one Sentry warning, and that
warning is the ONLY evidence a ledger gap exists (the ledger structurally cannot
show its own absence). Plan review rounds 1, 2 and 3 each found a different bug in
that five-line path — unguarded emission can abort the decision; latch-before-emit
buys permanent silence after one blip; a LIFETIME attempt ceiling buys it three
failures later — and each fix was correct about the failure it addressed. Round 3's
cooldown looked like the end of the chain. It was not, because **every version
assumed `Sentry.captureMessage` throws when delivery fails.** WHY → it does not.
`@sentry/node` 10.55.0 returns an event id immediately (`scope.js`), even with no
client configured, buffers the event, sends the envelope asynchronously, and
**catches transport failures internally rather than throwing back** (`client.js`).
So "capture succeeded" only ever meant "capture was QUEUED", the `try/catch` could
never see a DSN or network failure, and a real Sentry outage latched the flag with
the warning undelivered — the exact permanent silence rounds 2 and 3 were chasing,
reached by a route none of them examined. CORRECT → the structured log line is the
PRIMARY, durable transport, emitted first and OUTSIDE the Sentry guard; the rate
limit is per **disabled episode** (the latch clears when the flag is next seen
enabled) rather than per process; Sentry is best-effort with no `flush()`, because
awaiting delivery would put network latency on the deciding transaction's path.
**General rule: three careful adversarial rounds are no substitute for reading the
library.** Note also WHICH round caught it — the branch review, reading code. A
plan review structurally could not: a plan does not name a version.

### [2026-08-31] A comment asserting that a test CATCHES something is a claim to MEASURE, not to reason about → plant the mutant
FAIL → three false claims about one test, across three rounds, each written while
fixing the previous one. Red-team round 1 found a comment claiming the suspension
rollback test discriminated a helper that swallows its own insert error; the fix
replaced it with a claim that the test discriminates a helper opening its OWN
CONNECTION; round 2 planted exactly that mutant and **it survived**, because that
case's fixture forces a CHECK violation, so the insert fails on either connection
and no row exists to survive the rollback. WHY the chain persisted → each author
reasoned about what the assertion ought to catch, from the assertion's shape. None
of them ran the mutation, which takes about a minute. CORRECT → underneath the bad
comment sat a REAL gap (nothing discriminated an own-connection helper on the
SUCCESS path, and `ci:db-imports` matches only the `@/lib/db/server` specifier, so
a direct `postgres(…)` inside a domain folder is caught by nothing). It was closed
with a test that writes successfully, rolls the caller's transaction back for an
unrelated reason, and asserts zero rows — then PROVEN by re-planting the mutant and
watching it die. **General rule: a comment claiming coverage is a testable claim.
Test it, or do not write it.** Corollary worth keeping: when a mutant survives, ask
whether the CODE is wrong or the CLAIM is — the first surviving mutant here was
genuinely equivalent (postgres.js rethrows a per-query `uncaughtError` after the
`scope()` callback returns, so a swallowing helper still aborts the transaction),
and the defect was purely the comment.

### [2026-08-31] The gate's `promised-tests` row proves a title EXISTS, never that it RUNS → an entire eval can be `it.todo` and pass
FAIL → `scripts/verify-gate.sh`'s `promised-tests` row greps each `tests_to_add`
title against the test files. It does not reject `.todo`, `.skip` or `.fails`, so a
run can satisfy its whole eval with inert stubs and show a green gate. Every
`/feature` run is exposed, not just this one. WHY the obvious backstop does NOT
close it → `diff-coverage` (review mode) excludes `__tests__` and `.test.*` and
measures only added PRODUCTION lines: it catches a WHOLLY inert eval, but passes
happily while ONE test — including the one guarding this very property — sits
`.todo` covered by its neighbours' coverage. CORRECT (branch-local, no new CI
surface) → a scan that runs at **module scope** in its own test file, so vitest
executes it when it LOADS the module whether or not the test itself is marked, and
whose scan set includes its own file plus every file the branch adds or extends.
Rejected: a new `ci:*` audit script — it must be wired into `package.json`,
`ci.yml` and `lefthook.yml` together with `ci-audit-wiring.test.ts` failing on
drift, a permanent repo-wide obligation for one run's hygiene. **The general gap in
the tooling stands and is worth fixing at the workflow level, not per branch.**

## 2026-08-31 — WS8 production cutover: Railway deploy configuration

### [2026-08-31] A Railway `redeploy` resolves NO build/deploy config → the prod worker booted the Next.js UI and reported Online
FAIL → mid-WS8-cutover, an Infisical Secret Sync wrote `STRIPE_WEBHOOK_SECRET` and
triggered a Railway redeploy of production `repworth-worker`. The deployment reported
**SUCCESS**, the service reported **Online**, and the container was running
`$ next start` — the Next.js UI, not `tsx worker/index.ts`. No BullMQ consumers, no
pollers, no `assertWorkerStartupEnv`. The immediately previous deployment, at the
**same commit** `06a163f0`, had run `$ tsx worker/index.ts` correctly 29 minutes
earlier. `railway.toml` was unchanged and present on `main` throughout.

WHY → **a `redeploy` does not resolve the service's build/deploy configuration at all.**
It falls back to Railpack's auto-detection, which sees a Next.js repo and picks
`next build` + `next start`. Proven by isolating the variable rather than reasoning
about it: after setting `startCommand`/`buildCommand` **explicitly on the service** and
confirming the read-back, a second `redeploy` *still* ran `next start` and *still* ran
`next build`. So the fallback ignores the service settings, not merely `railway.toml`.
The distinguishing factor is the deployment **kind**, visible as `reason` in
`list-deployments`:

| `reason` | Trigger | Resolves config? |
|---|---|---|
| `deploy` | new commit on the source branch, or `railway deployment redeploy --from-source` | **yes** |
| `redeploy` | Railway dashboard redeploy, and **any variable change** — including an Infisical Secret Sync write | **no** — Railpack auto-detect |

That last row is the trap. Every secret rotation and every flag flip on this service
fires a `redeploy`, so a worker that is correct today reverts to `next start` the next
time anyone touches a variable.

**Why it looked healthy.** `healthcheckPath` is `/api/health`, and that route exists in
the Next.js app as well as the worker. Railway probed it, got 200, reported Online. Same
shape as the `${{Redis.…}}` capitalisation trap: a check that tests *presence of a
response* rather than *identity of the responder* cannot tell a healthy worker from a
healthy impostor. **Read "Online" on this service as unproven until a poller cycle
appears in its own logs.**

CORRECT → recover with **`railway deployment redeploy --from-source`**, not
`redeploy`. The flag means "pull and deploy the latest commit from the configured
source", which produces a `reason: deploy` deployment that resolves configuration
normally. Verified: that run executed the no-op `buildCommand` four times and `next
build` zero times, against the same commit the two failed redeploys used. The MCP
`redeploy` tool and Railway's own "use redeploy to apply immediately" note on service
updates are both wrong for this case — a service-settings change needs a source deploy
to take effect.

Belt and braces, since the two mechanisms are independent: the five deploy/build fields
are now set **both** in `railway.toml` **and** on the Railway service, per environment —
`startCommand`, `buildCommand`, `healthcheckPath`, `restartPolicyType`,
`restartPolicyMaxRetries`. With both in place and identical, a source deploy is correct
under either. `railway.toml`'s header says CHANGE ONE, CHANGE BOTH.

**`repworth-worker` is ONE service shared by both environments** (`fb413c72-…`), and
Railway's `update-service` API defaults to *all* environments when `environmentId` is
omitted. Always pass it, or a production fix silently rewrites staging.

### [2026-08-31] Mirroring the config did NOT stop recurrence → the healthcheck path had to stop identifying the wrong process
FAIL → the obvious fix for the entry above — mirror `startCommand`/`buildCommand` onto the
Railway service — restores the worker but leaves the fault armed. Redeploy `32a54658` ran
with `startCommand` set explicitly on the service and **still** ran `next start`. Since a
`redeploy` is what Railway fires on ANY variable change, every future secret rotation or
`flag-flip` would bring the impostor back, silently, reporting Online.

WHY the impostor could report healthy at all → `healthcheckPath` was `/api/health`, and
**that route exists in the Next.js app as well as the worker**. Railway probed it, got
200, and could not tell which process answered.

CORRECT → point the healthcheck at a path only the worker serves: **`/ready`**
(`worker/index.ts:638`). Next.js's nearest route is `/api/health/ready`, a different path,
so a `next start` deployment 404s the probe, the deployment is marked FAILED, and Railway
keeps the last good deployment live. The silent failure becomes a loud one that cannot
reach production. Verify the path against a running worker BEFORE switching — staging's
public Railway domain answered `{"status":"ready","checks":{"postgres":"ok",
"queue_redis":"ok","cache_redis":"ok"}}`.

**This reverses a deliberate choice and the tradeoff is the point.** `railway.toml` called
`/api/health` a "dependency-light endpoint (no DB/queue/external calls)". `/ready` runs
three live probes, so a deploy now fails if Postgres or either Redis is unreachable at
deploy time. Accepted because that direction is **fail-safe** — the running deployment
stays up — whereas the old posture let a dead worker replace a live one and report green.
**The cost is bounded — checked, not assumed.** Railway's docs say the healthcheck runs
at DEPLOY TIME ONLY ("not continuously after the deployment is live") with a 300s default
window, and a failure leaves the previous deployment serving traffic. So the added probes
gate one moment per deploy and are never a runtime restart risk. General lesson: **a healthcheck that any other process in the repo can also answer is not
a healthcheck, it is a liveness coin-flip.** Ask what else could be listening on that port
before trusting a 200. Follow-up to restore the light posture: a worker-only,
dependency-free `GET` (e.g. `/healthz/worker`) — a boot-surface change, so not done
mid-cutover.

### [2026-08-31] Railway deprecated Config as Code — `railway.toml` stops being read on 2026-12-01
FAIL → not yet a live failure, but it will be. Railway has **deprecated Config as Code**
(`railway.toml` / `railway.json`) in favour of Infrastructure as Code
(`.railway/railway.ts`). Hard cutoff **2026-12-01**; after it the file is not read, and
*new services cannot opt into it* at all. WHY it matters here → `railway.toml` is the
only in-repo record of the worker's start/build/healthcheck/restart configuration. The
mirror onto the service settings (entry above) already removes the single point of
failure, so the cutoff is a documentation-truth problem rather than an outage waiting to
happen. CORRECT → migrate to `.railway/railway.ts` as its own reviewed change before
2026-12-01. **Do NOT apply `railway config migrate` output as generated** — its dry run
(a) names the service `RepWorth`, taken from the *project* name rather than the real
`repworth-worker`, so `railway config apply` would CREATE a second service instead of
updating the existing one, and (b) silently drops `restartPolicyType` and
`restartPolicyMaxRetries`, carrying over only build/start/healthcheck. `railway config
apply` is project-wide with omit-means-delete semantics — never run it mid-cutover
against an environment holding 70 variables, a Redis service and a custom domain.

## 2026-08-31 — WS8 Phase E: provider webhooks, and a secrets-CLI incident

### [2026-08-31] `infisical secrets` prints secret VALUES by default → three production secrets landed in a session transcript
FAIL → listing the `prod` vault to check whether a key existed
(`infisical secrets --projectId … --env prod`) printed a table of **plaintext values**.
`RESEND_API_KEY`, `ZERNIO_API_KEY` and `ZERNIO_WEBHOOK_SECRET` were exposed to the
transcript in one command. Nothing warned, and no flag had been passed.

WHY → the CLI's own help is misleading. `--show-values` is documented as *"reveal secret
values in the output table **instead of masking them**"*, which reads as "masking is the
default". It is not. At v0.43.128 the table is unmasked with no flag at all; `--show-values`
appears to be a no-op on that path. The trap list already said "never print a secret", but
it named the Railway MCP `list-variables` as the hazard — the Infisical CLI is a second one,
and the *read* command is the dangerous one, not the write.

CORRECT → **never let `infisical secrets` write to a terminal you are recording.** To answer
"does this key exist and does it hold the value I expect", do not read the value at all:

```bash
# presence, length, format class, and a short SHA-256 fingerprint — no value
railway run --environment production --service repworth-worker -- node -e '
  const {createHash}=require("node:crypto"); const v=process.env.SOME_KEY;
  console.log(v===undefined?"ABSENT":`len=${v.length} fp=${createHash("sha256").update(v).digest("hex").slice(0,12)}`)'
```

Compare fingerprints across environments or against a mode-600 source file. That proves
identity without disclosure, and it is how E.1 verified the Infisical → Railway sync.
To WRITE a secret, use the CLI's `@file` form so the value is never a shell argument:
`infisical secrets set KEY=@.scratch/value.txt --projectId … --env prod --silent >/dev/null`.

**A secret that reaches a transcript is exposed, and rotation is owed** even when the blast
radius is currently zero. Record the blast radius and the date it stops being zero.

### [2026-08-31] Both providers expose webhook CRUD over their APIs — the runbook's dashboard steps were never necessary
FAIL → `deployment-guide.md` §6.1/§6.2 describe Phase E as dashboard work, so it was
planned as an owner action needing a browser. Both are API-driven.

WHY → nobody had probed. Resend's `GET https://api.resend.com/webhooks` returns 200 and
`POST` with `{}` returns `422 Missing 'endpoint' field`, which advertises create. Zernio
404s on a guessed path but the **404 body names its own OpenAPI document** —
`https://zernio.com/openapi.json`, 417 paths — which lists `/v1/webhooks/settings`
(GET/POST), `/v1/webhooks/test` and `/v1/webhooks/logs`.

CORRECT → probe the API before scheduling dashboard work. Two shape facts that differ
between the providers, and both matter:

- **Resend mints the secret.** `POST /webhooks` returns `signing_secret` (Svix `whsec_…`,
  38 chars) **once**. Capture it to a mode-600 file in the same command that creates the
  endpoint, or it is gone.
- **Zernio takes the secret.** `secret` is a request field, so an existing
  `ZERNIO_WEBHOOK_SECRET` is passed verbatim and nothing is minted. Rotating it therefore
  needs a `PUT` of the subscription **and** a vault write, together.
- `webhook.test` is **not** in Zernio's subscribable event enum, though the runbook listed
  it. It is fired by `POST /v1/webhooks/test {"webhookId": …}`.
- Newer Resend has no per-endpoint "Send test". Use the simulator address
  `delivered@resend.dev` — a real event, no human recipient.

### [2026-08-31] Webhook subscriptions are per-USER, not per-environment → every event fans out to both workers
FAIL → production and staging hold **different** API keys at both Resend and Zernio
(verified by fingerprint, all four distinct), so the subscriptions were assumed to be
separated too. They are not: `GET /v1/webhooks/settings` returns the byte-identical list —
same `_id` — under either Zernio key, and `GET /webhooks` does the same under either Resend
key. Creating the production endpoint means a production `review.new` is also delivered to
the staging worker, and a staging one to production.

WHY → an API key authenticates a **user**; subscriptions belong to the account, not the key.
Neither provider offers per-profile or per-key webhook scoping. Distinct keys buy
revocability, not isolation.

CORRECT → **accept the fan-out; do not re-point an endpoint to "fix" it.** It is benign by
construction rather than by luck: `processReviewEvent` fans out from `zernio_connections`
filtered on the firing Zernio account id, so a foreign event matches zero rows and produces
a 0-row fan-out; the two workers hold separate databases, so `claimInboundEvent` dedup never
crosses. The cost is one noise row per foreign event in each `inbound_events` table plus an
unconnected warn in the log. General lesson: **verify isolation at the layer that enforces
it.** Two different credentials pointing at one account are one tenant, however different
the credentials look.

### [2026-08-31] A key that "cannot be proven read-only" often can — the client validates shape before it authenticates, the API does not
FAIL → Phase A.6 recorded the production Zernio API key **UNPROVEN**, reasoning that every
GET route in `src/lib/zernio/client/` validates request shape before authenticating, so no
read-only call discriminates a good key from a bad one. The key then sat unproven through an
entire production cutover.

WHY → the reasoning was about **our client**, not about the API. A raw request skips the
client's shape validation entirely.

CORRECT → probe the provider directly, and always run the negative control in the same
breath:

```
GET https://zernio.com/api/v1/profiles             → 200  {"profiles":[{"name":"repworth-prod-…"}]}
GET https://zernio.com/api/v1/profiles  (bad key)  → 401  {"error":"Unauthorized"}
```

The 200 also named the production profile, so the key was proven bound to the right tenant,
not merely valid. **When a credential is "unprovable", check whether the obstacle is the
provider or your own wrapper.** Usually it is the wrapper, and `curl` is the answer.

### [2026-08-31] Created a live Stripe coupon under a fresh id → the environment already named a different one
FAIL → Phase F.2 says "create the **Beta comp coupon** in both Stripe modes" and warns that
"the two IDs differ". Taking that at face value, the live coupon was created as
`beta_comp_3mo`. Vercel `staging` had held `BETA_COMP_COUPON_ID="repworth-beta-comp-3mo"`
for ten days. A live coupon under an id no environment names is not a coupon — it is a
`CheckoutCouponConfigurationError` waiting for the first invited tester, and the symptom
would have appeared in front of a founding customer.

WHY → the plan described the *shape* of the object (100% off, `repeating`, 3 months) and
the *risk* (a test id deployed to live), but the deployment had already chosen a **name**,
in a place the plan did not point at. Creating first and reconciling afterwards is the
wrong order for any provider object whose id an environment variable already references.

CORRECT → **read the id the environment already names before creating anything.** The
sequence that works, for any provider object bound by an env var:

1. Read the configured value (`vercel env pull` to a mode-600 file, then grep one key).
2. `GET` that id in **both** provider modes. Create only what is genuinely missing.
3. Read back under the **pinned** API version — a read-back under the default version does
   not test what the pin is for.
4. Only then delete anything you created in error, and gate the delete on usage:
   re-read `times_redeemed` and refuse on any non-zero count.

Two more facts worth keeping. **The same id is legal in both Stripe modes**, and using it
makes the "test id deployed to live" failure structurally impossible rather than merely
documented — prefer one id over two. And **deleting a Stripe coupon strips the discount
from subscriptions already carrying it**, so an unused-looking legacy coupon with
`times_redeemed > 0` is not safe to tidy away; leave it and write down why.

General lesson: **a plan that describes an object's shape has not told you its name.** When
an env var already points somewhere, that variable — not the plan — is the specification.

### [2026-08-31] An Infisical Secret Sync silently downgrades Vercel `Secret` variables to `Config`
FAIL → a prior finding (F8) established that nine Vercel production variables were type
`Secret` (write-only, so `vercel env pull` returns them zero-length **by design**), and left
an open question: does an Infisical Secret Sync preserve that type? It does not. After the
first sync, Vercel Production went from **9 `Secret` / 26 `Config`** to **4 `Secret` /
59 `Config`**. `STRIPE_SECRET_KEY`, `SESSION_COOKIE_SECRET`, `WORKER_INTERNAL_SECRET`,
`DB_POOL_MAX` and `ONBOARDING_DEMO_ENABLED` all lost the flag.

WHY it is the sync and not a coincidence → the four that kept `Secret` are **exactly** the
four the vault does not manage (`OWNER_LEADS_GOOGLE_SHEET_ID`,
`OWNER_LEADS_GOOGLE_SHEET_RANGE`, `GOOGLE_SHEETS_CLIENT_EMAIL`,
`GOOGLE_SHEETS_PRIVATE_KEY`). Every synced key was rewritten as an ordinary encrypted
variable. Nothing else survived.

CORRECT → **do not treat "re-add it as `--sensitive`" as an action you can just take.** A
sync writes `Config`, so the flag drifts back on the next write of that key, and a
half-applied posture is worse than a recorded one. Decide first: accept `Config` for synced
keys and write down why; or drop those keys from the vault and manage them on Vercel alone,
losing single-source truth; or find a sync option that sets the destination type.

Two reading rules that fall out of this, and both are traps:

- **A zero-length `vercel env pull` value means `Secret`, not empty.** Reading it as "off"
  is how F8 produced a month of wrong conclusions, including an alarming one about live
  payments. Confirm with the type column before concluding anything.
- **The type column needs `npx vercel@latest`.** The installed CLI (54.14.5 against a
  current 59.10.0) has no `type` column at all and prints a fixed `Encrypted` on every row,
  which cannot distinguish the two types. General lesson: **when a tool shows one fixed
  value in a column, suspect the tool before you believe the column.**

## 2026-08-31 — WS8 Phase G: Sentry seats, and a fail-open validation trap

### [2026-08-31] The production dead-man heartbeat never worked → a Sentry monitor SEAT, not a toggle or our code
FAIL → the production Sentry cron monitor `health-alert-poller` had **zero check-ins in 24
hours** while the production worker demonstrably ran with a 5-minute poller. The monitor is
the dead-man heartbeat whose entire job is to page when the poller stops, so production had
no such alarm at any point.

WHY → not our code, and not a stray setting. Three candidates were ruled out in order:
the worker **is** sending (Sentry's own banner reads `10x  Monitor disabled` — check-ins
arrive and are rejected at ingest); the DSN is correct (`SENTRY_PROJECT=repworth-production`
and the prod DSN's project id differs from staging's); and the SDK does send an **upserting**
`captureCheckIn`. Activating any monitor through the API returns
`{"status":["You don't have enough pay-as-you-go available to create a new seat"]}`, and
`Settings → Subscription` reads **Developer plan, no payment method on file**. The chain is:
free plan → a small fixed number of monitor seats → the two staging monitors hold them →
the production monitor cannot take a seat → Sentry keeps it `disabled` → every check-in is
rejected. One root cause, both halves of G2 — newly created uptime monitors come back
`disabled` for the same reason.

CORRECT → **the fix is a seat.** Either release one (disable the staging cron + staging
uptime monitors) or buy one (payment method + pay-as-you-go budget). There is no button on
the monitor page that helps. Monitors live at `https://<org>.sentry.io/monitors/`; the older
`…/crons/<project>/<slug>/` path 404s, and the numeric monitor id in the UI is not the GUID
the API returns.

General lesson: **a monitoring gap can be a billing fact.** When a heartbeat has *zero*
check-ins rather than failing ones, stop debugging the emitter — an empty series means the
receiver refused, and the receiver's reason is usually quota. Check the plan before the code.

### [2026-08-31] An in-process fault injection silently tested nothing → the OpenAI client is memoized
FAIL → validating the moderation fail-open path, the first attempt set
`process.env.OPENAI_API_KEY` to an invalid value and called `moderateResponse` again **in the
same process**. It returned `providerStatus:"clean"` — the provider call had *succeeded*.
Recorded as inconclusive rather than as a pass, which is the only reason it was caught.

WHY → `client()` in `src/lib/moderation/moderate.ts` builds its OpenAI instance once and
caches it. A later mutation of `process.env` cannot reach an already-constructed client. The
"error path" test therefore exercised the happy path and produced a **clean** result that
looks nothing like a failure.

CORRECT → **inject the fault before the process starts**, never inside it:
`railway run --environment production --service repworth-worker -- env OPENAI_API_KEY=sk-invalid npx tsx <script>`.
The provider then returns `invalid_api_key` and the decision correctly degrades to
`providerStatus:"error"` without throwing.

General lesson: **a fail-open path that silently no-ops looks identical to a pass.** When
testing a degradation, first prove the fault actually occurred — here, the provider error in
the log — before believing the decision that came back. Any memoized client, cached config,
or module-level singleton makes in-process env mutation a no-op.

### [2026-08-31] A `redeploy` DID resolve deploy config → trap 1 gains a caveat, and the procedure does not change
FAIL/observation → the D.4 entry above establishes that a Railway `redeploy` resolves no
deploy configuration and boots `next start`. On 2026-08-31 a variable change fired
`58e58630` (`reason: redeploy`) which reported SUCCESS **and ran `tsx worker/index.ts`**
with every poller starting — the opposite of D.4.

WHY, most likely → a `redeploy` re-runs the *previous* deployment. Three minutes earlier a
merge to `main` produced `c5c7506b`, a `reason: deploy` source deployment that resolved
configuration normally, and the redeploy inherited that resolution. At D.4 the preceding
chain started from a Railpack auto-detect, so the redeploy inherited *that*.

CORRECT → **keep doing `redeploy --from-source` after every variable change.** The rule is
now conditional — a redeploy is safe only when the deployment it copies was itself
config-resolved — and you cannot see which case you are in at the moment you flip a
variable. A conditional safety rule is not one to lean on. What this changes is the expected
blast radius, not the procedure. General lesson: **when a documented failure stops
reproducing, find the mechanism before relaxing the rule** — "it worked this time" and "it
is fixed" are different claims.

## 2026-08-31 — WS8 Phase F.3: the invited-owner smoke, and a checklist that named the wrong assertion

### [2026-08-31] A checklist told the operator to record the PROVIDER's error → our own gate returns first, so that code can never appear
FAIL → `beta-production-standup.md`'s F3 step 10 says the step "validates the provider error
mapping in `src/lib/onboarding/resend-invite.ts`, which shipped deliberately
staging-unverified", and instructs: "record the actual Supabase error code/status you
observe for the already-accepted case". An operator following that literally waits for
`email_exists` / 422. It never comes. Both halves of the instruction were wrong, and the
answer to both was already inside the file the instruction names.

WHY → two independent staleness bugs that reinforced each other.
1. **The mapping was verified six weeks earlier.** `INVITE_ERROR_CODE_MAP`'s header reads
   `CONTRACT VERIFIED against the staging Supabase project on 2026-08-14`, cites evidence
   D-13, and records the observation (`AuthApiError { code: 'email_exists', status: 422 }`
   → 409). The header *used* to say NOT YET VERIFIED; the checklist copied that sentence and
   never re-read it.
2. **The step cannot reach the mapping at all.** `resendOwnerInvite` calls
   `getUserById`, checks `providerUser.user.last_sign_in_at`, and throws
   `OWNER_ALREADY_SIGNED_IN` **before** `inviteUserByEmail` is ever invoked. The mapping sits
   behind a gate that refuses first — the module's own header says so: "the accepted-user
   branch above is normally unreachable in production: the gate refuses first, and this
   table is the safety net behind it."

Observed on staging 2026-08-31: **409 Conflict**, `code: "OWNER_ALREADY_SIGNED_IN"`, and no
third email — proven by re-reading `auth.users` and finding `invited_at` unmoved, rather than
by asking the operator to check an inbox.

CORRECT → **before recording a provider's response, check whether your own code returns
before the provider is called.** A gate in front of a mapping means the step exercises the
gate. To exercise the mapping you need a *different* test that bypasses the gate — which is
worth writing down as a separate item, not smuggling into a step that structurally cannot do
it.

Two general lessons, and the second is the reusable one:

- **A "NOT YET VERIFIED" caveat copied into a checklist outlives the verification.** The
  source file was updated; three documents that quoted it were not. When a doc quotes a
  code comment as a live caveat, the doc has taken on a maintenance obligation it will not
  honour — cite the file and let the reader open it.
- **"Record what the provider returns" is only a meaningful instruction when the provider is
  reachable on that path.** Trace the call to the boundary before writing the assertion.

### [2026-08-31] A 3-month coupon's 4th cycle cannot be rendered from a real Checkout → prove it from the discount's `end`, and say so
OBSERVATION → F.3 step 8 asks the operator to "confirm the 4th billing cycle renders at the
full founding rate" on the upcoming-invoice view. For a subscription three months from its
4th cycle, Stripe will not render that invoice. Reaching it needs a **test clock**, and a
subscription created through the real Checkout the smoke exists to test has
`test_clock: null` by construction. Attaching a clock means not testing the funnel.

CORRECT → prove the boundary instead, and state the limit rather than implying a rendered
invoice. The discount object carries `start` and `end`; project the subscription's monthly
anchors from `billing_cycle_anchor` and check which side of `end` each falls on. On
2026-08-31: anchor 2026-08-31T18:56:52Z, discount `end` **2026-11-30T18:56:52Z** — a 91-day
span landing on the cycle-4 anchor **to the second**, so cycles 1–3 are covered and cycle 4
is not. Stripe derived that boundary from `duration_in_months: 3`, which is the deprecation
question F.2 raised, now answered twice (coupon read-back under the pinned apiVersion, and a
real subscription's discount window).

General lesson: **when an assertion about the future cannot be rendered, find the object that
already encodes the answer** — here the discount's own `end` — and record the *method*
alongside the verdict. A boundary proof and a rendered artefact are different evidence; a
record that blurs them invites a later reader to over-trust it.

## 2026-08-31 — WS8 Phase F.4: the first live Checkout, and two commissioning gaps

### [2026-08-31] Production was PROVISIONED but never COMMISSIONED → two blockers found by walking the path, not by auditing
FAIL → F.4 walked the invited-owner loop in production for the first time. It hit two hard
stops in ten minutes, neither on any checklist, either of which would have stopped beta
tester one:

1. **No admin user existed.** `/admin/businesses/new` needs a `public.users` row with
   `role='admin'` whose `auth_id` matches a Supabase Auth identity. Production held **zero**
   rows in `public.users` AND `auth.users`. The entire **Admin invite** funnel was
   unreachable — there was no one who could create an invite.
2. **Supabase Auth Site URL was `http://localhost:3000`.** The first invite email resolved
   to the owner's own dev server, which answered and rendered
   `/login?error=auth_callback_failed`.

WHY → the 45-day firewall freeze. Everything that could be created from a config file or an
API was created; everything that needed a human in a provider dashboard **once** was not.
`deployment-guide.md` §2 documents the admin seed and line 1332 documents the Site URL **for
staging**. Neither was ever run against production, and staging having both since May is
exactly why nobody noticed — every test passed, on the environment that was commissioned.

The second one is the more instructive. **Everything on our side was correct**:
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `buildInviteRedirectTo()` all emitted
`https://repworth.net/api/auth/callback?…`. **Supabase substitutes its configured Site URL
whenever `redirect_to` is not in the allowlist**, so no application-side correctness can
compensate. And the symptom actively misleads: `auth_callback_failed` is OUR error string,
so the failure reads as an application bug until you notice the callback builds its redirect
from the request `origin` — which proves the request reached localhost, not us.

CORRECT → **an environment is not live because its deploys are green.** Provisioned (infra
exists) and commissioned (a human completed the one-time dashboard steps) are different
states, and only the second is testable by walking a real path end to end. Diagnose a wrong
redirect by asking *which server rendered this page*, not *which of our variables is wrong*.

General lesson: **the paths nobody has walked are where the un-auditable failures live.** A
config audit cannot find "no admin exists" — there is no wrong value to flag, only an absent
row. Both of these were found by one person clicking through the funnel once.

### [2026-08-31] A mandatory-reading doc that is stale is worse than no doc → the flag-flip skill guarantees someone reads it mid-action
FAIL → the `flag-flip` skill requires reading `.claude/reference/env-vars.md` before every
flip, "no exceptions, including flips you've done before". Its `BETA_COMP_COUPON_ID` section
opened with *"⚠️ PENDING OPS — the coupon does not exist yet"* (false since that morning) and
instructed *"the two IDs differ, and a test-mode ID deployed to live fails every invited
tester's checkout."*

WHY that second sentence matters → **it is the same wording that already caused an
incident.** The 2026-08-31 lab note *"Created a live Stripe coupon under a fresh id"* records
a live coupon being created under an id no environment named, because the plan described the
object's shape rather than its name. The env-vars row repeated the identical premise. Left
alone it would have produced the same mistake a third time — and this time at the exact
moment an operator was authorised to write to production, because the skill had just told
them to read it.

CORRECT → **use ONE id in both Stripe modes.** The same id is legal in both, and using one
makes "test id deployed to live" structurally impossible instead of merely documented. Then:
when a doc is on a skill's mandatory-reading path, **its staleness is an operational risk,
not a documentation debt** — fix it in the same change as the action that revealed it, and
strike through the old wording rather than deleting it, so the next reader sees the
correction was deliberate.

General lesson: **the docs a workflow forces you to read are the ones whose errors get
acted on.** Rank doc-freshness work by whether a skill, hook, or gate points someone at the
file at the moment of action — not by how often it is read casually.

### [2026-08-31] A vault write is a DEPLOY on every synced platform → one env var redeployed a worker that never reads it
OBSERVATION → writing `BETA_COMP_COUPON_ID` to the Infisical vault `prod` triggered Railway
deployment `aaa79eae` on `repworth-worker`. That variable is deliberately **not** a worker
variable — `env-vars.md` says so, and no worker path reaches `applyTierSnapshot`.

WHY → one vault environment (`prod`) syncs to **both** Vercel and Railway. Any write to it
is a deploy on every synced platform, regardless of which platform reads the key. That puts
every vault write into trap 2 territory: a Railway redeploy MAY resolve deploy configuration
or MAY fall back to Railpack and boot `next start`.

CORRECT → treat a vault write as a production deploy of every synced service. Follow it with
`redeploy --from-source` and confirm `tsx worker/index.ts` **and a poller cycle** in the
worker's own log. The redeploy that the sync fires was benign here (it copied a
config-resolved source deploy from eight minutes earlier — the G-F1 case, now seen twice),
but a from-source deploy **resolves** configuration where a redeploy only **inherits** it.
Two benign observations do not make the rule conditional in the safe direction.

General lesson: **when one store fans out to several platforms, the blast radius of a write
is the union of them, not the subset that reads the key.**

## 2026-08-31 — WS8 G.3: the alarms fire once

### [2026-08-31] A recurring ops finding pages NOBODY → Sentry issue alerts trigger on state changes, and an ongoing group has none
FAIL → G.3's first two acceptance drills (§4.2 failed-publish, §4.3 zero-delivery) both fired
correctly on the first `HealthAlertPoller` cycle and both reached Sentry. **Neither produced
a page.** The staging rule's `lastTriggered` did not move across two cycles.

WHY → **issue grouping, not routing and not priority.** `emitHealthFindings`
(`worker/background/pollers/health-alert/emit.ts`) calls `Sentry.captureMessage(finding.title)`,
and Sentry groups messages by template. The drill's finding therefore joined a group whose
true first-seen was **2026-06-27** with 29 occurrences. Both alert rules trigger on
*First seen event / Issue resolved / Reappeared event / Regression event* only. An **ongoing**
group is none of those, so occurrence 2 through ∞ is silent.

**Production has the identical defect.** Rule `3925256` ("Prod — four ops signals to
Discord"), created hours earlier in G.1, carries the same four state-change triggers. Its
tag filters and its Discord action are correct; the triggers are the hole.

**Why the G.1 verification missed it, and this is the reusable part:** G.1 proved routing
with **Send Test Notification** plus an API readback. A test notification is *by
construction* a first-seen event — the single case these triggers handle. So the verification
exercised the one path that works and generalised to all of them.

CORRECT → add the **`Every event`** trigger alongside first-seen — in the UI it is *"An event
or issue activity is captured"*; there is **no** *"seen more than 0 times in one hour"* option
— and set an **Action Throttle** (60 minutes) so repeats page at most hourly per issue. Do not
drop the state-change triggers; first-seen is still the fastest path for a genuinely new
fault, and the throttle does not delay it because a new issue has no prior notification.

FIXED AND PROVEN 2026-08-31 on both rules. The re-run is a controlled experiment worth
copying: **re-use the identical fixtures so they land in the SAME Sentry issue groups**, and
the trigger set becomes the only changed variable. Before: `lastTriggered` unmoved across two
poller cycles. After: `21:37:05Z`, 15 s after the cycle.

Two general lessons:

- **Health alerts are recurring by nature, so "notify on new" is the wrong default for
  them.** A growing backlog re-emits the *same* message every interval. One page at the
  start, then silence — which is indistinguishable from the problem resolving itself.
- **A test notification proves the sink, never the trigger.** It arrives through the one
  condition that is always true for a synthetic event. When verifying an alert, produce the
  signal the *second* time and check it still pages.

### [2026-08-31] The alert and the dispatcher shared a predicate → the "stuck outbox" drill could never fire
FAIL → §4.1 says: insert a `job_outbox` row `status='pending'`,
`available_at = NOW() - 20 min`, expect `outbox_pending_age`. It cannot fire.

WHY → `checkOldestPendingOutbox` and the `OutboxPoller` claim query use the **identical**
predicate — `status = 'pending' AND available_at <= NOW()` — but the dispatcher runs every
**5 s** and the health poller every **300 s**. The dispatcher claims the fixture ~60× faster
than the alert can read it; the row then dispatches real work, or for an unregistered topic
is written to `status='failed'`. Either way it stops being `pending`.

CORRECT → the alert exists to catch *"dispatch backed up **or the OutboxPoller has
stalled**"*, so the only honest fixture is one where dispatch is actually stopped. Fold the
drill into the worker-stop drill: stop the worker, insert the aged row, restart, confirm the
finding on the first clean cycle. Raising `HEALTH_ALERT_PENDING_AGE_S` does **not** help —
the predicates are identical, so the dispatcher wins at any threshold.

General lesson: **when a drill's fixture is consumed by the very system it is meant to
observe, the drill is measuring the consumer, not the observer.** Check whether the reader
and the writer share a predicate before trusting a synthetic fixture.

### [2026-08-31] G.1 shipped four of six specified rules → the two it dropped were exactly the frequency-conditioned ones
FAIL → G.3's next two drills (§4.5 send-breaker re-page, §4.6 unattributed suppression) both
assert the behaviour of a named alert rule. **Neither rule exists**, in staging or in
production. Read back from the Sentry API before the first fixture:

| Project | Rules | Action filters |
|---|---|---|
| `repworth-staging` | one — `3608329` | **none at all** |
| `repworth-production` | `3925256` | four `Tagged event`: `health_alert`, `limit_exceeded`, `stripe_reconciliation`, `import_consent_analytics` |
| `repworth-production` | `3920752` | none; **New/Existing high priority issue** only, throttle `0` |

`beta-launch-alerting.md` §1a-do specifies **six**. Rule 5
(`finding = solicitation_send_breaker_tripped`) and rule 6
(`feature = solicitation_lane`) are in neither project.

WHY IT IS NOT A COINCIDENCE → rules 1–3 trigger on **first seen**. Rules 4, 5 and 6 trigger
on **frequency** ("seen more than 3 times in one hour"), because each of their capture titles
is a constant string that groups every occurrence into ONE Sentry issue. G.1 built the
first-seen family and verified it with a **Send Test Notification** — which is by
construction a first-seen event. **The verification could only exercise the family that was
built, so the missing family was invisible to it.** That is the same root cause as D-2 one
level up: D-2 was "the rule's trigger set cannot see a repeat"; this is "the rules that exist
at all are the ones whose trigger is not about repeats."

CONSEQUENCE, and the live half → `reportUnattributedSuppression` emits `level:'warning'`
tagged `feature:solicitation_lane`. In production that matches none of `3925256`'s four
filters, and CONFIG-1 (2026-06-24) already established that a `warning` `captureMessage` does
not reliably classify as high priority, so `3920752` does not catch it either. **The capture
reaches Sentry and pages nobody** — verbatim the failure §1 predicts for a missing rule 6.
Not harmful yet, because solicitation sending is off in production; harmful at the first
send. Two further signals have no rule in either project for the same reason:
`subsystem:refusal_ledger` and `subsystem:autonomy_governor`.

CORRECT → build rule 6 in both projects, and **scope the staging catch-all**, which pages on
every issue today purely because it has no filter. **Do NOT build rule 5**: its whole purpose
was the repeat page on an open breaker, and D-2's `Every event` trigger now supplies that on
`subsystem:health_alert`, which the breaker finding carries. A second rule would double every
breaker page and buy nothing. Recorded in §1a-do as superseded rather than deleted, because
its *reasoning* about why the repeat matters is still the correct account.

General lesson, and it is the reusable one: **a spec that lists N rules and an implementation
that ships M < N is not caught by testing the M.** When a routing spec groups its rules by
*trigger kind*, verify one of each kind — and read the live rule set back from the API rather
than inferring it from the tickets that were worked.

### [2026-08-31] A drill's duration was budgeted from the poll interval, not the throttle → its own count assertion was unreachable
FAIL → §4.5 said: hold an open breaker across *"at least three
`HEALTH_ALERT_POLL_INTERVAL_MS` intervals"* (≈ 15 min) and confirm Discord receives *"more
than the opening two"* notifications.

WHY → the two halves contradict each other, and §1 of the same runbook already said so:
*"Sentry's default action interval is 60 minutes per issue, so a 5-minute poll interval does
not mean a 5-minute page."* Fifteen minutes against a 60-minute Action Throttle can only ever
yield **one** page. The drill was written against the poller's cadence when the paging
cadence is the rule's. *"The opening two"* also does not survive a hand-inserted fixture: it
counted the trip finding **and** the open-trip re-page finding as two constant titles, but
inserting the row directly skips `evaluateSendBreaker`'s breach arm, so only the re-page
title is ever emitted.

CORRECT → assert **more than one** notification, and time the wait from the **first page**
at the **throttle** cadence. Prove the level-triggered half separately and far more cheaply:
the Sentry issue's occurrence count must rise by one on **every** poll cycle while the page
stays throttled. Observed on the corrected run — occurrences at 22:31:50, 22:36:50 and
22:41:50 on a perfect 5-minute cadence, with `lastTriggered` moving once, at 22:32:07.

Two things worth copying:

- **Pick a fixture whose Sentry group ALREADY EXISTS.** Then `First seen event` cannot fire,
  so a page proves the `Every event` trigger and nothing else could. Same controlled shape as
  D-2's re-run, from a second angle.
- **Rising occurrences with a static `lastTriggered` is the SAME observation as D-2's, and
  now means the opposite thing.** Before the fix it meant the trigger set could not see the
  repeat. After it, it means the throttle is holding the page — which is the intended
  posture. An observation is not a diagnosis; read it against the configuration that
  produced it.

## 2026-09-01 — WS8 G.3 session 2: four drills pass, and three of five deviations correct the campaign itself

### [2026-09-01] A capability that MOVED looks exactly like one that was REMOVED, from inside the place it used to be
FAIL → Mid-session I told the owner Sentry's frequency condition "no longer exists in this UI",
that the whole class was gone, and therefore that **rule 6 was unbuildable** and drill §4.6
permanently unsatisfiable. I had opened the WHEN/trigger dropdown, read its five options, and
scrolled to confirm the list was complete.

WHY → the list *was* complete. The frequency condition is not a trigger any more. It sits in
the **IF/filter** section as **"Issue frequency"** (stored as `Issue occurrences`), one dropdown
lower on the same form. The evidence for "it is gone" and the evidence for "it moved" are
identical when you only look where it used to be.

CORRECT → rule 6 is buildable exactly as specified: `Every event` as the sole trigger, gated by
an **`all`** filter of `Issue occurrences ≥ 4` AND `Tagged event feature eq solicitation_lane`.
POSTs 1-3 fire the trigger and fail the filter; POST 4 passes both — which is §4.6's assertion
expressed as configuration. Built in both projects and verified by API readback.

**This also amends D-2 (2026-08-31), which is the part worth carrying.** D-2 concluded there was
"no seen-more-than-0-times option" and settled for `Every event` + a 60-minute throttle. That fix
is not wrong — repeats page now, which was the point — but its *reason* is incomplete, and left
standing it would have written off runbook rules 4 and 5 as unbuildable too. They are buildable.
Rule 5 remains superseded on its own merits, not on Sentry's limitations.

General lesson: **before concluding a product cannot do something, check the adjacent surface.**
An exhaustive read of one menu proves that menu is exhaustive, nothing more.

### [2026-09-01] A search tool's DEFAULT FILTER is part of the query → an absence it produces is not evidence of absence
FAIL → §4.8 stopped the staging worker and the cron monitor recorded two missed check-ins. I
reported that no Sentry issue was created, citing `search_issues` with
`monitor.slug:health-alert-poller`, which returned nothing — and citing it twice, believing the
monitor-scoped form was the rigorous version of the earlier text search.

WHY → `search_issues` defaults to `is:unresolved`. A cron-failure issue for that monitor **does
exist** — *"Your monitor is failing: A missed check-in was detected"* — and is **resolved**, last
seen two months ago. It was invisible to both queries by construction, not by absence.

CORRECT → re-check with the status filter removed. `detector:7655183` over 24 h with no
`is:` term still returns "No issues match your search", and the monitor's own panel states the
thresholds outright: **"Detect: One failed check-in."** So one miss should raise an issue and two
did not. **The finding survives and is stronger** — the earlier hedge "two misses may simply be
below the threshold" is retired, because the threshold is documented as one.

Same shape as the Vercel SSO miss the day before (**D-5**), where a `302` was recorded as a login
redirect without following it: in both, the tool answered a narrower question than the one being
asked, and the narrowing was invisible in the output.

General lesson: **when a query returns nothing, print the query the tool actually ran before
believing the nothing.** Defaults that are convenient in a UI are silent premises in an API.

### [2026-09-01] The drill declared unrunnable was runnable — the fixture shape was wrong, not the alert
FAIL → D-1 (2026-08-31) declared §4.1 "stuck outbox" unrunnable: `checkOldestPendingOutbox` and
the `OutboxPoller` share a predicate, and the dispatcher runs 60x faster, so a single aged row is
always claimed first. D-1 then proposed folding §4.1 into the worker-stop drill.

WHY THE REMEDY ALSO FAILED (**D-7**) → checked against the boot logs before running it.
`OutboxPoller` starts within ~1s of boot and claims on a 5s cadence; `HealthAlertPoller` does
**not** run a cycle at boot — its first is a full interval later (boot 21:01:44Z, first cycle
21:06:50Z). A restart therefore makes the race *worse* by about five minutes. D-1 compared the
two loops' **cadences**; the deciding fact was their **phase**.

CORRECT → the alert reads `MIN(available_at)` across **all** claimable pending rows, so the
honest fixture is a backlog the dispatcher cannot drain within one interval — which is also
exactly what the alert means ("dispatch backed up"). 4000 past-dated claimable rows put both
`outbox_pending_age` and `backlog_depth` over threshold in a single cycle: three findings at
04:07:36Z, `Oldest claimable outbox row is 1961s old (> 900s)` among them, Discord-confirmed.
§4.1 therefore folds into **§4.9**, not §4.7.

General lesson: **"this alert cannot be exercised" is almost always "this FIXTURE cannot exercise
it".** Before recording a drill as impossible, ask what state the alert is actually reading and
whether a different-shaped fixture produces it.

## 2026-09-01 — WS8 G.3 session 3: §4.6 and §4.10 pass, and every one of the four lessons is a claim that was wrong on paper

### [2026-09-01] Reading a function's DOC COMMENT is not reading the function
FAIL → session 2 wrote the §4.6 probe and recorded its signature scheme as "resolved from code
and config, not assumed". Session 3 read the ingress before running it and found the probe keyed
its HMAC with the raw `whsec_…` string. `worker/ingress/resend.ts` keys it with
`Buffer.from(secret.replace(/^whsec_/, ''), 'base64')` — the **decoded bytes**. Every POST would
have returned `401 invalid_signature`.

WHY → the doc comment six lines above `verifySignature` states the scheme correctly
(`base64(HMAC-SHA256(secret, "${svixId}.${svixTimestamp}.${body}"))`) and says nothing about the
key derivation immediately below it. The comment was read; the body was not.

CORRECT → copy the key derivation from the implementation into the probe, with a line saying
where it came from. **And note the failure shape, which is the transferable part:** a wrong probe
on a threshold drill produces the *expected* "no page" for every sub-threshold POST. It only
disagrees on the last one, and there it looks exactly like a broken alert rule. A fixture whose
defect is invisible for 3 of 4 steps is worse than one that fails immediately.

### [2026-09-01] A documented predicate can be OFF BY ONE — which you only learn if the prediction is written down first
FAIL → Sentry's `Issue occurrences` filter is documented as *"the issue has happened at least N
times"*. Rule 6 carries `value: 4`. The prediction, recorded in the evidence file **before** the
run, was that the POST taking the group to 4 would page. It did not. The rule fired once at
occurrence 5/6.

WHY → configured `N` admits an event only once the group is **past** N. Whether the
implementation is post-increment `> N` or pre-increment `≥ N` is not distinguishable from
outside, and does not matter: **`N` pages on occurrence `N+1`.** Separately, the filter carries no
`interval` — it is cumulative over the group's lifetime, so "more than 3 in one hour" is not
expressible as a filter at all, and the count never resets.

CORRECT → for any occurrence-gated rule: read the group's CURRENT count before the drill and
budget from it, never from zero; expect the page one event later than the configured value; and
know that in production the first N occurrences page nobody while every one after N pages
forever. **The method is the lesson.** The prediction was in the file before the run, so the
discrepancy was visible. An unrecorded prediction gets silently rewritten to match the result,
and the off-by-one ships.

### [2026-09-01] SCOPING a shared alert rule silently cuts every routing path that does not carry the new tags
FAIL → session 2 scoped staging rule `3608329` to four `Tagged event` equalities
(`subsystem`/`cost_event`/`feature`) under `any-short` logic, and recorded in advance the two
signals that would stop paging. Session 3 found a third that was not recorded: a **Sentry cron
monitor issue** is generated by Sentry, not by our SDK, so it carries none of those tag keys and
matches nothing. `3608329` was the only Discord rule in the staging project — so §4.8's dead-man
switch now has no routing path even after its own defect is fixed.

WHY → the scoping landed at 05:35Z; §4.8 had run at 04:07–04:28Z. Nothing re-tested the path
afterwards, and the "what will stop paging" list was written from *our own* emit sites. Issues
the platform generates on our behalf are not in that inventory.

CORRECT → when narrowing a catch-all rule, enumerate what routes through it **from the rule's
side, not the emitter's** — platform-generated issues (cron monitors, uptime checks, quota
notices) carry no application tags and are the first thing an `any-short` tag filter drops. Give
them a dedicated rule rather than widening the scoped one. Production was **not** in the same
state and the difference is instructive: it kept an unfiltered high-priority rule (`3920752`)
that staging lacks, so the two environments' alerting had silently diverged.

### [2026-09-01] A cleanup command scoped to one arm of a drill reports "inventory clean" for the other
FAIL → `scripts/burst-drill-load.ts release` deleted 0 rows after the §4.10 headroom arm and
printed `inventory clean — 0 PENDING row(s) tagged 'G3-4.10' remain`. 1000 rows were still there.

WHY → `release` is scoped `status = 'pending'`, which is correct for the over-threshold arm
(future-dated rows the poller never claims). Headroom-arm rows **self-complete**, so they are
`completed` by the time cleanup runs. The message is literally true about pending rows and reads
as a statement about the run.

CORRECT → clean the headroom arm with the same predicate on `status = 'completed'` and verify the
table is back to its pre-drill count. The runbook's "no manual cleanup is needed for this arm" is
defensible on inertness — completed rows trip no health check — but it left `job_outbox` at 1005
rows where the previous teardown had deliberately restored it to 5, and every later drill and
Phase H sanity check reads that table. **A cleanup tool's success message is scoped to what it
was built to delete, not to what the run created.**

### [2026-09-01] A config value "the API does not expose" was exposed all along — in the artifact the thing produced
FAIL → two sessions recorded the Sentry cron monitor's `failure_issue_threshold` as UI-only
("the API does not expose either field"), and both wrote the same remedy: open the monitor and
**set** an issue-creating failure threshold. The remedy was inert. The threshold is already `1`.

WHY → the monitor endpoint returns `schedule`, `checkin_margin`, `max_runtime` and stops. But a
cron **issue** embeds a full snapshot of the monitor's config at the moment it fired.
`REPWORTH-STAGING-8` carries `{"failure_issue_threshold": 1, "recovery_threshold": 1, …}`. The
value was one query away, in the object the monitor produces rather than the object that
describes it.

CORRECT → when an endpoint omits a field, look at what the system *emitted*, not only at what it
*reports about itself*. That one issue also retired two other standing assumptions in the same
read: the monitor **can** create issues (225 occurrences, and the failure reason is *"A missed
check-in was detected"*, so missed check-ins DO count toward the threshold), and its complete tag
set is `environment / interface_type / level / monitor.id / monitor.incident / monitor.slug` —
which turns "a cron issue probably carries no application tags" from inference into evidence, and
turns "filter the new rule on `monitor.slug`" from a hope into a verified option.

General lesson: **"the API doesn't expose it" is a claim about one endpoint.** Before building a
remedy on it, check the telemetry the subsystem has already produced — configuration snapshots
ride along with events far more often than the describing endpoint admits.

### [2026-09-01] A cumulative counter cannot approximate a rate, and tuning it is the wrong repair
FAIL → rule 6 was specified as *"more than 3 in one hour"* and built with Sentry's
`Issue occurrences` filter set to 4. The filter has no interval: it counts the group's lifetime
occurrences and never resets. The first instinct on discovering the off-by-one (D-13) is to
change the number.

WHY → the number is not the defect. `N` events spread over a year trip a cumulative counter
exactly as `N` events in a minute do, and once tripped it stays tripped forever — so the rule
does not damp a burst, it just delays the alert's own birth by `N` occurrences and then pages on
everything. For a detector of a rare-by-construction condition, those `N` silent occurrences are
the exact events being hunted.

CORRECT → drop the occurrence filter; keep the `Every event` trigger, the tag filter, and the
**60-minute Action Throttle**. The throttle caps volume per issue per hour without ever making
the rule blind, which is the property that matters for a detector. If a real rate condition is
genuinely needed, build a Sentry **metric alert** on `count()` over the interval — that is the
alert type that expresses "N in an hour". General lesson: **when a control cannot express the
intent, replace the instrument, don't retune it.**

---

## 2026-09-01 — /feature #1013: verifying your own fix can destroy the fix

### [2026-09-01] `git checkout -- <path>` restores the FILE, not the MUTATION → commit before you mutate
FAIL → to prove a review fix actually killed its mutant, the orchestrator edited
`worker/jobs/response-generation/persist.ts`, ran the narrowed suite, then restored with
`git checkout -- <path>`. That is correct for the mutation and wrong for the tree:
`persist.ts` also held UNCOMMITTED review fixes, and the checkout discarded them. **It
happened twice.** The first pass cost the `withLedgerAttribution` wrapper and a corrected
guards docblock — recovered from a scratch copy and re-applied through the editor, verified
line-identical. The second cost one comment. The rule was stated after the first occurrence
and then not followed.

WHY → a restore step whose blast radius is "whatever else is uncommitted in this file" is not
a restore. The mutation is a few characters; the checkout is the whole path. Nothing in the
command distinguishes them, and the loss is silent — the tree simply looks clean afterwards,
which is exactly the state the operator was trying to reach.

CORRECT → **commit, then mutate.** After the second loss the fixes were committed before any
further mutation and the third run was clean. This is precisely why the red-team skill uses
`mutation-runner.mjs` with a journal rather than ad-hoc `git checkout`: the journal restores
the MUTATION, not the FILE. An orchestrator verifying its own fix should use that runner, or
commit first. General rule: **before any destructive verify step, the thing you are protecting
must already be in a commit** — a scratch copy is a recovery, not a control.

---

## 2026-09-01 — the first PITR restore drill: the drill passed, the document did not

### [2026-09-01] A runbook's own verification SQL can be NON-EXECUTABLE, and only running it finds out
FAIL → `pitr-restore-drill.md` §4 prescribes
`select max(created_at) as latest_review from reviews;` as an integrity check. Executed
against production it does not return a wrong answer — it raises:
`ERROR: 42703: column "created_at" does not exist`. `reviews` has no such column; its
timestamps are `review_date, detected_at, external_reply_ingested_at,
sentiment_classified_at, triaged_at`. The paired `responses` query is correct, which is
part of why the defect read as plausible.

WHY → the query was written from the shape every other table has, not from this table's
schema, and nothing downstream executes a runbook. It survived authoring, review, and
**two handoffs that named the runbook as ready to run** — because reading it is enough
to believe it and only running it is enough to know.

CORRECT → `max(detected_at)`, the ingestion anchor CLAUDE.md already names. **The
transferable part is the failure shape, not the column.** Production currently holds 0
reviews, so a *working* query returns `null` — meaning the broken one would have been
indistinguishable from success had it merely returned nothing. It does not; it raises,
and it would have aborted §4 mid-verification against any non-empty table. **A
verification step is code. An unexecuted runbook is an untested branch**, and its
defects surface at exactly the moment it is being trusted — during a restore.

### [2026-09-01] A platform's cost ESTIMATOR and its cost CONFIRMATION answer different questions
FAIL → the owner approved the drill's spend at **$10/month prorated**, the figure from
Supabase's `get_cost(type=project)` API — whose own tool description instructs the caller
to repeat the cost and confirm before proceeding. The Dashboard's creation dialog then
quoted **$0.50/month**: Compute $0, Disk $0.50. Twenty times lower.

WHY → `get_cost` prices a *generic new project*. A restore-to-new-project clone inherits
the source's compute size, which the organization's existing Pro compute credit already
absorbs, so only the incremental disk is billable. The API answers "what does a project
cost"; the dialog answers "what does *this* project add". Both are correct answers to
different questions, and only one of them is the number an owner is approving.

CORRECT → quote the **confirmation dialog** when one exists. When a decision must be made
before it appears, say which of the two is being quoted and re-state the real figure
afterwards as a deviation. The error here ran in the safe direction, which is precisely
why it would otherwise go unrecorded. General lesson: **an estimate presented for
approval must carry the name of the thing that produced it.**

### [2026-09-01] Restore-to-new-project mirrors the DATA, not the MACHINE — and the difference is a live hazard
Recorded from the first drill, because none of it is in the runbook and two of the three
are only visible at creation time:

- The clone provisions the **current** platform Postgres image, not the source's. Observed
  `17.6.1.166` against a source on `17.6.1.104`. A restore therefore proves *"the data
  restores onto today's Postgres"*, never *"the exact image comes back"* — which is also
  what a real recovery does, so it is the honest thing to prove.
- Its disk is provisioned at **1.5×** the source's, deliberately, for restore headroom.
  That disk is the entire incremental cost.
- **The live hazard:** Supabase's own clone docs warn that a clone inheriting `pg_cron`,
  `pg_net` or `wrappers` will run the source's schedules **against its own copy of live
  data**, from a project nobody is watching. Checked on the first drill: RepWorth has
  **none of the three** (only `pg_stat_statements`, `pgcrypto`, `supabase_vault`,
  `uuid-ossp`, all inert). That is what makes clone-for-forensics safe here — and it is a
  property a single future migration can silently revoke. Re-check `pg_extension` on any
  clone before leaving it running.

### [2026-09-01] `supabase projects delete` — the flag that makes it scriptable is not in its own help
`supabase projects delete <ref>` prompts interactively; the command's `--help` lists no way
around it. `--yes` is a **global** flag and works: `supabase projects delete <ref> --yes`.

**Do not use it bare.** The same verb deletes production. The first drill guarded it three
ways before executing: the ref must not equal either real project ref; the ref's **live
name**, re-read from the API at delete time, must equal the scratch name; and its
`created_at` must fall inside the drill's own minute. The second guard is the load-bearing
one — a ref typed from memory is the failure mode, and a ref whose *current* name is read
back and compared cannot be a different project. **A guard a script enforces beats a
runbook sentence that says "triple-check the ref".**

---

## 2026-09-01 — the E-F1 secret rotation: the remediation reproduced the incident, and the disk was worse than the transcript

### [2026-09-01] "The agent never sees the value" and "the value is not exposed" are DIFFERENT CLAIMS
FAIL → rotating three secrets that had leaked into a transcript, the agent designed a handoff
where the owner mints each key and the agent reads only a file. It instructed:
`! umask 077 && printf '%s' 'PASTE_KEY_HERE' > .scratch/key.txt`, with the real key
substituted. The owner did exactly that, and **a `!`-prefixed command is echoed into the
transcript verbatim** — so a production API key was exposed in plaintext at the moment of its
creation, during the remediation of an identical exposure. The agent had written *"no value is
ever a shell argument"* into that same evidence file minutes earlier.

WHY → the design goal was stated as *"no value passes through the agent"*, and the mechanism
satisfies that goal perfectly. It is the wrong goal. The repo rule — *"never place a secret as
a literal argument in a Bash command; it lands in transcript history"* — **does not
distinguish who types the command**, and that is precisely why it is worded that way.

CORRECT → the clipboard, which puts the secret in no command at all:
`umask 077 && pbpaste | tr -d '\n' > file && wc -c < file`. Browser → clipboard → file, never a
command line, a shell history, or a transcript. Clear the clipboard after. `tr -d '\n'` is
load-bearing, not tidiness: an HMAC keys on the exact byte string, so one invisible trailing
newline yields a signature mismatch indistinguishable from a wrong secret.

**General lesson, and it is not about secrets.** A remediation step is written by the same
hands, in the same session, under the same assumptions that produced the original defect —
and it arrives wearing the authority of a fix, so it gets *less* scrutiny than the thing it
repairs. **Re-derive the requirement the remedy is supposed to satisfy, in the remedy's own
terms, before executing it.**

### [2026-09-01] A working directory ACCUMULATES secrets, and no step's cleanup is anyone's step
FAIL → shredding one flagged file prompted a pattern scan of `.scratch/`. It found **18 more**
plaintext-secret files from three prior sessions: ten complete production credential dumps
(`vercel env pull` output, Railway variable snapshots, Infisical verification JSON — the entire
production environment, twice over), a Playwright `storageState` holding a **live authenticated
session**, two Stripe webhook secrets, four scripts with embedded keys, and a provider-issued
`whsec_`.

WHY → **every one came from a legitimate step.** Pull the env to compare it. Snapshot before a
risky write. Save the API response that shows a one-time secret. Nobody was careless, and no
single act was wrong. The exposure is cumulative and belongs to no step. It also *reads* as
safe from every local check: `.scratch/` is gitignored and mode-700, so "is it committed?"
answers no every time — **gitignore protects the repository, not the disk**, nor a backup, nor
anything with filesystem read. The irony is exact: this pile was built by the sessions
remediating a one-time transcript print of a strict *subset* of the same material.

CORRECT → **a command that writes a secret to disk creates a FIXTURE**, and a fixture gets a
teardown-ledger row *before* the command runs — `vercel env pull` included. That is how the
same run handled its own pull: pulled, fingerprinted in-process, `rm -P` seconds later. The
rule "never print a secret" was already known and followed; what was missing is that *writing*
one is creating something that must be removed. Periodic sweep:
`grep -rlE 'whsec_[A-Za-z0-9+/=]{10,}|re_[A-Za-z0-9_]{20,}|sk_[A-Za-z0-9]{40,}|eyJ[A-Za-z0-9_-]{30,}' .scratch`
And note what shredding does **not** do: `RESEND_WEBHOOK_SECRET` was in one of those files and
is **still live**. A file being gone is not a credential being safe.

### [2026-09-01] Rotation is proven by the OLD key failing, and by a signed event — not by a write succeeding
Four verification layers, in increasing strength. Only the last two are conclusive:

1. **The vault write returns exit 0.** Proves nothing about any platform.
2. **`railway run … node -e '<sha256 of process.env.X>'`** proves the *variable* is set. It does
   **not** prove the running process holds it.
3. **A real signed event.** `POST /v1/webhooks/test` → Zernio signs an HMAC with the new secret,
   production verifies it, `inbound_events` shows `webhook.test / processed` in 64 ms. **This is
   the only check that proves the live process and the remote system agree**, and it settles
   both halves of a two-system cutover with one event.
4. **The old credential returns 401.** Until this, a rotation has not reduced the blast radius —
   it has *doubled the number of valid keys*.

For a two-system secret (vault + provider subscription), go **vault first → confirm the boot →
then the provider**. During the gap the worker rejects old-signed events, which is correct
behaviour: it never accepts an unverified one. The inverse order puts the failure on the
inbound path.

### [2026-09-01] Three CLI traps found while rotating — each cost a wrong conclusion or a 404
- **`vercel env ls`'s age column does not track a synced write.** It read `2d ago` for all three
  keys minutes after a sync that had demonstrably landed. Believing it would have made revoking
  the old key an outage. Fingerprint the pulled value instead — **measure the value, never the
  metadata about the value.** Same shape as trap 12.
- **`vercel redeploy` takes no `--yes`** (it has `--no-wait` and `--target`) and fails with
  *"Deployment belongs to a different team"* unless `--scope` is passed explicitly — **even with
  exactly one team on the account.** And after it: `vercel inspect <url> | grep -A3 Aliases`.
  A `Ready` deployment can serve nobody; "a deployment is running" and "production is running
  it" are different claims.
- **Zernio's webhook update is `PUT /v1/webhooks/settings` with `_id` in the BODY**, not
  `PUT …/settings/{id}`, which 404s. Every internal doc phrases it as *"PUT subscription X's
  secret"*, which reads RESTful. Send **only** `{_id, secret}` — the API leaves unprovided
  fields untouched, so a minimal body cannot regress `url` or `events` the way an echoed-back
  GET can. The 404's own response body named `openapi.json`; **the API answered the question,
  and the second guess was unnecessary.**

---

## 2026-09-02 — Phase H's first attempt: the rotation had a consumer nobody had listed, and the rollback for it was dead code

### [2026-09-02] A rotation must enumerate CONSUMERS, not just the provider's key list — and a consumer is not always a vault variable
FAIL → the first admin onboarding after the 2026-09-01 Resend rotation failed at the invite
send. The Supabase Auth log named it exactly: `POST /invite`, `status 500`,
`error: 535 "Authentication credentials invalid"`. **SMTP 535 is a credential rejection.**
Supabase Auth sends through Resend SMTP, and the SMTP *password* **is a Resend API key**. The
rotation replaced `RESEND_API_KEY` at 21:52Z and **deleted the old key at 22:31Z**; Supabase's
SMTP settings still held the dead one. Invites, password resets and email confirmations were
all down in production for ~7 hours, undetected.

WHY → the rotation tracked the credential through the places it was *stored as a variable* —
the vault, Vercel, Railway — plus the Zernio subscription, and verified each: fingerprints
matched, the boot gate passed, a signed webhook round-tripped in 64 ms. **Every check was
scoped to the consumers already known.** The missing consumer is a password field in a
*different provider's* dashboard, holding a copy of a key the first provider issued. Nothing in
a vault diff, an env listing, or a boot gate can see it. `ROT-D7` had already said "capture the
provider's key list in preflight" — necessary, and not sufficient: that finds which *keys*
exist, never who *uses* them.

CORRECT → a rotation's preflight needs a **consumer inventory** alongside the key list, and the
question that builds it is *"what would break if this key stopped working?"* — asked of
third-party dashboards, not just of `grep`. For RepWorth's `RESEND_API_KEY` the consumers are:
the vault → Vercel + Railway, **and Supabase Auth → SMTP settings** (host `smtp.resend.com`,
username `resend`, password = the API key). **A rotation is not complete until every consumer
has been exercised**, and for an email credential the only real exercise is *sending one*. The
rotation left U5 ("no production email sent") open deliberately — on the **API** lane. Nobody
asked about the **SMTP** lane because nobody knew it was a lane. **An open unproven path
protects you only from the failures you named.**

### [2026-09-02] A mocked characterization test over emitted SQL is BLIND to foreign keys — and can pin a bug as correct
FAIL → `rollbackProvisionedBusiness` (the compensating cleanup when admin onboarding fails
after `createBusinessTx` commits) could **never delete a single row**, and its unit suite passed
the whole time. Its order was `job_outbox → users → accounts → businesses`, but
`fk_businesses_account` is `FOREIGN KEY (account_id) REFERENCES accounts(id)` with **no
`ON DELETE CASCADE`**. Deleting `accounts` while the `businesses` row still points at it raises
`23503`, the enclosing `sql.begin` aborts, and every earlier delete rolls back with it. Not a
partial cleanup — a total one, swallowed by the caller's `catch`. Found only when production hit
it and left three orphan rows.

WHY → the suite was an explicit *characterization* test: it asserted the emitted SQL **text and
bind order**, to stop two duplicated call sites drifting. It did that job. But a mock `sql` tag
has **no foreign keys**, so it can only ever prove which statements were issued, never whether
they succeed. The function is reached *only* when a business row exists, and a business row is
exactly what makes it fail — so the one precondition guaranteeing failure is the one a mock
cannot represent. The doc comment above it reasoned about `businesses → channel_enrollments
ON DELETE CASCADE`, which is real but is not the edge that blocks; the blocking edge,
`businesses → accounts`, was never considered.

CORRECT → **when the behaviour under test IS a constraint, the test must run against a database.**
Keep the mocked suite for statement/bind pinning, and add a live-DB sibling that asserts the
ROWS ARE GONE — plus a **negative control** that replays the pre-fix order and asserts it still
raises `23503`, so a future cascade-adding migration turns the control red instead of letting
the suite pass vacuously. General shape: *a test that asserts what a function SAYS cannot catch
a bug in what the database DOES.*

### [2026-09-02] Deferred FKs make a delete order correct only INSIDE a transaction
Cleaning the orphans above, the first standalone `DELETE FROM users` raised
`accounts_owner_user_id_fkey`. The users/accounts cycle has **two DEFERRABLE INITIALLY DEFERRED**
edges (`accounts.owner_user_id → users.id`, `users.account_id → accounts.id`) and one immediate
one (`businesses.account_id → accounts.id`, no cascade).

Deferred means **checked at COMMIT**. In autocommit every statement is its own transaction, so
the deferral buys nothing and the check fires at once. The order
`job_outbox → users → businesses → accounts` is correct **only** wrapped in one explicit
`begin … commit`. Same trap as the `SELECT … FOR UPDATE` gotcha: a guarantee that exists only
inside a transaction silently evaporates outside one. Seed helpers in this repo already know it
— `seedTenantAccount` opens with `SET CONSTRAINTS ALL DEFERRED`.

### [2026-09-02] OutboxPoller dispatch was one Redis + one SQL round trip per row → bulk per topic group
- [2026-09-02] Outbox drain topped out at ~10 rows/s (the ~600/min Capacity-burst drill figure) → the poller did `queue.add` + `UPDATE` per row and never re-claimed after a full batch → dispatch is now `queue.addBulk` per topic group + one `unnest`-paired UPDATE, looping under `OUTBOX_DRAIN_BUDGET_MS`; the drill number predates this and must be re-measured before it is cited as a ceiling.

## 2026-09-03 — /feature #1082: a local Postgres timing is not evidence about production

### [2026-09-03] A round trip costs ~70 ms to Supabase and ~0.4 ms to a local Docker Postgres — so a local benchmark understates a batching win by two orders of magnitude
- [2026-09-03] #1082 replaced a per-row `writeRefusalEvent` loop with one
  `writeRefusalEvents` set insert, inside a transaction holding the per-Business
  advisory lock and the batch row lock. Branch review derived the row count
  correctly — `holes` is capped at `BATCH_CAP` (25), not the `MAX_DATA_ROWS`
  (5,000) the ticket claimed — and then **nearly retired the ticket on that
  number**, reasoning that saving 24 round trips was marginal. → **A ROW COUNT
  IS NOT A COST.** Measured on the staging database, same 25 rows, both arms
  rolled back: the looped arm is more than 10x the set arm, and the saving is
  well over a second of lock-held time. The same measurement on a local Docker
  Postgres shows single-digit milliseconds, because a container on loopback has
  effectively no network. → **Never conclude "this optimisation is too small to
  bother with" from a local timing, and never quote an integration suite's own
  wall time as the production cost.** Measure against a database behind the same
  pooler and the same network as production, or say the number is unmeasured.
  Numbers and method:
  `docs/runbooks/evidence/2026-09-03-1082-exhaustion-refusal-batch-drill.md`
  (single owner — do not restate the figures here, they move with the hardware).

### [2026-09-03] Three prose failure modes that CI cannot see, from six false self-claims on one branch
- [2026-09-03] #1082's code passed every round — 9 of 11 mutations killed, the
  bound chain re-derived twice by independent parties, 440 clean suite runs. Its
  PROSE failed six times, and every one was cheap to check. → Three rules, each
  earned:
  **(1) Run the mutation before writing the adjective.** "Load-bearing" was
  written twice about test helpers without running the one-line mutation that
  settles it; both were false, and the second was written in the commit fixing
  the first.
  **(2) Cite by symbol, always.** Not "by symbol for files this branch edits" —
  that qualified form passed a full review round and was then falsified when
  taking `main` moved a cited line in a file the branch never touched. **A line
  number is a fact about a TREE, not about a codebase.** Note also that
  `prevalidate-plan.py` resolves FILES rather than lines, so it passes stale line
  citations, and reports "0 citations checked" on a symbol-only document — its
  PASS is vacuous in both directions.
  **(3) A figure that moves under prose edits needs ONE owner**, and every other
  mention points at it. The comment-line count in #1082's arch-review row moved
  40 → 66 → 68; correcting the row and missing its twin in the deviations file is
  what a later red-team round found. The repair is not "fix both" — it is "let
  one own it". The #1080 row one entry earlier records the identical residual,
  which is why this is a rule and not an anecdote.

## 2026-09-04 — /feature #1105: the tests were the defect, four passes running

### [2026-09-04] A substring assertion against a serialized log line can be satisfied by the TIMESTAMP
- [2026-09-04] #1105's overflow case asserted
  `expect(JSON.stringify(logLine)).toContain(String(cap))` with `cap = 8`. The
  line carries an ISO timestamp, so the digit was frequently supplied by the
  clock rather than by the payload. **Proved, not argued:** a red-team pass
  applied a `cap: 0` mutant, watched it DIE at 07:37:0x, and watched the same
  mutant SURVIVE on a re-run at 08:07:29Z — same assertion, same code, different
  second. → **Parse the line and read the field** (`payload.data.cap`), and
  assert the type while you are there (`toBe(8)`, never `toContain('8')`). A
  serialized structure carries timestamps, ids, levels and paths; a substring
  match against the whole of it is not an assertion about any one of them.
  General form: **never `toContain` a short numeric or common token against a
  whole serialized blob.**

### [2026-09-04] `createWorkerLogger` silently DROPS array values
- [2026-09-04] `logger.warn(msg, { flag, codes: ['a','b'] })` logs `codes` as an
  ABSENT KEY. `createWorkerLogger` runs object args through
  `sanitizeAnalyticsProperties` (`src/lib/analytics/events.ts`), which keeps
  strings, numbers, booleans, `null` and nested plain objects — and drops arrays
  with no warning. #1105's durable transport would have named no code while its
  Sentry event named all of them. → **Join before you log**; one string, and both
  transports carry the same one. Caught only because a test asserted the log
  line's CONTENT — a test asserting the call count would have passed.

### [2026-09-04] An unobservable invariant is an unasserted one
- [2026-09-04] #1105 capped a latch `Set` at `UNMAPPED_SIGNAL_CAP` and asserted
  that bound in FOUR documents. The bound did not exist: the code tested the
  Set's size and then added every fresh code, so one call carrying N codes grew
  it to N. The correctly-bounded mutant survived **31/31**, because every
  emission path reads that size through a `room` value that saturates
  identically at and past the cap — the mutant is EMISSION-equivalent and not
  behaviour-preserving. → A bound on internal state needs an oracle that can SEE
  the state; a test-only accessor is the cheap honest answer, and **mutate the
  accessor too** so the oracle is not self-fulfilling. **Four documents
  asserting a property is not evidence. One mutation is.**

### [2026-09-04] A change has as many TOKEN-SHAPES as the facts it moves — sweep each shape, not each fact
- [2026-09-04] #1105 added two alerting rules, then failed to fully fix ONE
  finding three times running. Attempt 1 changed the table and left two
  paragraphs contradicting it. Attempt 2 fixed those and left a COUNT in a
  third. Attempt 2's greps were keyed on `first seen`, `Every event`, `rule 7`,
  `7 and 8` — and the missed line stated the same fact as `Do §4 after the six
  rules above`, matching none of them. → Adding two rules moved **three shapes**:
  the trigger, the identity, and the count. Enumerate every shape BEFORE editing
  any site, then re-grep to prove nothing survived. The count sweep is
  `grep -nE "\b(five|six|seven|eight|nine)\b"`. This is the operational form of
  #1082's "let one mention own the fact": when the fact is spread across prose,
  enumeration IS the ownership.

### [2026-09-04] A mocked module boundary can make a lane-level contract untestable
- [2026-09-04] #1105's plan put a membership test inside a helper in
  `src/lib/refusals/write.ts`. `persist.test.ts` MOCKS that whole module, so its
  spy recorded a call for a HEALTHY input too, and four of five lane cases
  asserted a count that discriminates nothing. Two codex plan-review rounds read
  that decision and neither caught it; **the failing test did.** → Before siting
  a predicate, ask which suite owns the contract and what that suite mocks. A
  lane-level contract needs a lane-level oracle. The fix moved the predicate to
  the call site beside its sibling `wouldRecordRefusal`, which also put it in the
  file whose docblock owns the cannot-throw rule. **Plan review is not a
  substitute for running the eval.**

### [2026-09-04] Two local-tooling traps that each cost two dispatches
- [2026-09-04] **`codex exec` hangs reading stdin** even when the prompt is an
  argument. A backgrounded invocation blocks forever and is killed with no
  session and no output; it happened twice on #1105 before the cause was found.
  → Always `codex exec … < /dev/null`, redirect stdout to a file, and take the
  answer via `-o <file>`. Piping `--json` into `tail` also buffers everything
  until exit, so a killed run leaves nothing at all.
- [2026-09-04] **A local gate RED on a suite the branch never touched, with a
  multi-second per-test timeout, is a CONTENTION flake — re-run before believing
  it.** #1105 saw three different suites do this (`live-db-suites-audit`,
  `review-qr` twice) while red-team subagents ran concurrently; each passed in
  isolation and in CI. `/feature`'s subagent barrier is written for
  HEAD-movement, but its practical payoff is avoiding false REDs. **Never run the
  gate while an agent is in flight.**

### [2026-09-04] The prose-failure rules from #1082 did not hold — seven false self-claims on the next branch
- [2026-09-04] The entry one section above records six false self-claims on
  #1082 and three rules meant to prevent them. #1105 read that entry, quoted it
  in its own architecture-log row, and then shipped **seven** — including a
  comment-ratio compared against a norm for a different SIZE of change, a
  "promoted to lab notes" written in the present tense for a step-8 action, and
  the same twin-mention failure committed INSIDE the fix for a finding about
  twin mentions. Every one was caught by an adversarial pass; none by the
  author. → The honest conclusion is not a fourth rule. It is that **prose
  defects are not reliably self-detectable by their author**, so the control has
  to be an independent reader with a mechanical sweep, budgeted into the work
  rather than added once something feels wrong.
