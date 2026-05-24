# CI Keystone Design

Date: 2026-05-24
Status: Draft for user review

## Summary

This design implements the first Step 1 keystone from `docs/sass_ready/README.md`: stand up GitHub Actions CI from zero. The first pass should be a fast, reliable PR gate that runs existing local checks in GitHub before adding database-backed integration or Playwright gates.

The chosen approach is the minimal hard-gate CI:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

This gives RepWorth immediate merge protection without blocking on staging database credentials, preview infrastructure, or browser test runtime tuning.

## Goals

- Create the first `.github/` structure for RepWorth.
- Add a PR CI workflow that uses the repo's existing Node and pnpm versions.
- Keep the CI gate deterministic and secret-free for the first rollout.
- Add the repository hygiene files called out by Spec 24 task 0: Dependabot, PR template, and CODEOWNERS.
- Leave a clear path to add integration tests, e2e tests, and branch protection after the first green CI run.

## Non-Goals

- Do not add `TEST_DATABASE_POOL_URL` or staging Supabase setup in this slice.
- Do not run Playwright on every PR yet.
- Do not configure Vercel or Railway preview environments.
- Do not add branch protection through the GitHub API in this slice.
- Do not introduce new test frameworks or change application behavior.

## Current Context

- There is no `.github/` directory today.
- `package.json` already has the commands needed for the first gate.
- `.nvmrc` pins Node `v24.15.0`.
- `package.json` pins `pnpm@11.0.9`.
- `test:integration` requires `TEST_DATABASE_POOL_URL`; that makes it unsuitable for the first secret-free PR gate.
- `test:e2e` is configured for Playwright and should be added later for `main`, scheduled, or staging-backed runs.
- Spec 24 says CI is the keystone that unblocks later fail-the-build work in Specs 07, 08, 09, 12, 19, 22, 23, and 25.

## Workflow Design

Create `.github/workflows/ci.yml` with one workflow triggered on:

- `pull_request`
- `push` to `main`

Use Ubuntu runners and the repo's pinned runtime:

- `actions/checkout`
- `actions/setup-node` with `node-version-file: .nvmrc`
- Corepack enabled
- pnpm prepared at version `11.0.9`
- pnpm store cache keyed by `pnpm-lock.yaml`
- `pnpm install --frozen-lockfile`

Use separate jobs for granular branch protection checks:

- `lint`
- `typecheck`
- `test`
- `build`

Each job can duplicate setup at first. If runtime becomes too slow, consolidate or add a shared setup pattern later. The first target is correctness and clear failure reporting, not maximum YAML cleverness.

## Environment Design

The first CI workflow should avoid production secrets. It should only set safe CI defaults where a command requires them.

For build-time app behavior, prefer mock and local values:

- `CI=true`
- `MOCK_EXTERNAL_APIS=true`
- local URLs such as `NEXT_PUBLIC_APP_URL=http://localhost:3000`
- non-secret dummy values only where Next.js build-time validation requires them

Do not add real Supabase, Stripe, Redis, Resend, Twilio, OpenAI, Anthropic, or Google credentials to this first PR gate.

If `pnpm build` exposes missing environment assertions, fix the CI environment narrowly. Do not weaken runtime production assertions to make CI pass.

## Repository Hygiene Files

Add `.github/dependabot.yml`:

- npm ecosystem against `/`, weekly.
- GitHub Actions ecosystem against `/`, weekly.
- Keep update groups conservative so dependency review remains readable.

Add `.github/pull_request_template.md`:

- Summary.
- Verification.
- Risk / rollout notes.
- SaaS-readiness spec reference when applicable.

Add `.github/CODEOWNERS`:

- Default ownership for all files.
- Use the current solo-founder reality: the repository origin owner is `@norbertesekiel47`.

## Follow-Up Path

After the first CI workflow is green:

1. Turn on branch protection for `main` requiring the four CI checks.
2. Add integration CI once `TEST_DATABASE_POOL_URL` is available as a GitHub secret.
3. Add Playwright on `main` push, nightly, or staging deploy once preview/staging URLs are reliable.
4. Layer later fail-the-build gates from SaaS-readiness specs onto this workflow family.
5. Update `docs/sass_ready/24-devops-deployment.md` to mark task 0 as shipped and note that integration/e2e gates remain follow-ups.

## Validation

Before claiming implementation complete:

- Run the narrow local checks that mirror the workflow:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
- Inspect workflow YAML for invalid indentation and unsupported action inputs.
- Confirm `.github/` files are tracked.
- Confirm no secrets were committed.

## Risks

- **Risk:** CI build fails because local `.env.local` masks required build-time envs. **Mitigation:** add safe dummy env values in the workflow, preserving production runtime checks.
- **Risk:** Four separate jobs duplicate dependency install time. **Mitigation:** accept the initial cost for clear required checks; optimize only after observing GitHub runtime.
- **Risk:** Dependabot creates noisy PRs. **Mitigation:** weekly cadence and grouped updates.
- **Risk:** CODEOWNERS uses an incorrect handle. **Mitigation:** use the verified repository origin owner, `@norbertesekiel47`.
