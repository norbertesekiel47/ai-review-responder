## Summary

-

## Verification

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`

Note: the default `test` CI check is secret-free. Database-backed integration tests may self-skip until `TEST_DATABASE_POOL_URL` is wired into CI, and Playwright is not part of the first PR gate.

## Risk / Rollout

-

## SaaS-Readiness Spec

-
