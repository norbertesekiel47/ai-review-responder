# Adversarial approach review (Codex gpt-6-astra, session 01a0c4c8-81bc-7233-82a2-caeb36cba921)

MERGE_BASE 75c8d54cb77ac34d1f2f7686b9171528871b81f3 · HEAD 25bf1b3fda644238778fa1322b3da5055f8e8c30 · read-only, committed objects only

| ID | severity P0-P3 | file:line or assumption letter | finding | concrete failure scenario |
|---|---|---|---|---|
| F1 | P2 | **(d)** — `useMfaEnrollment.ts:194,306`; `SecurityClient.tsx:78`; challenge route `:244` | **Unique naming permits repeated abandoned enrollments without an app recovery path.** Cancel discards the QR/secret locally; owner settings displays only verified factors; removal requires AAL2 regardless of factor status. These restrictions predate this fix, but the new allocator permits successive creations past the former name conflict. Excluding cleanup is inadequately justified without establishing server retention/capacity behavior. | A first-time owner starts, cancels, and restarts enrollment. Each successful start creates a fresh unverified factor; previous setups cannot be resumed through the UI or removed at AAL1. **Whether this eventually exhausts GoTrue’s limit remains unverified**, rather than a demonstrated permanent lockout. |
| F2 | P2 | **(g)** — `src/components/auth/__tests__/useMfaEnrollment.test.tsx:119` | **The central cancellation test uses a payload the installed SDK does not produce.** It places an unverified factor in `totp`; auth-js 2.106.2 puts it only in `all`. The tests therefore do not protect the actual dependency that makes this fix work. | Remove the `record.all` traversal from `collectFactors`: the added cancellation test still succeeds, while a real cancelled factor disappears from naming input and the next enrollment retries its occupied name. Use `totp: [], all: [unverifiedFactor]`, plus a mixed verified/unverified fixture. |

**Appendix — verification limits and lower-confidence concerns**

- **(a) GoTrue matching:** The installed SDK forwards `friendlyName` unchanged and recognizes both error codes. It does **not** implement server uniqueness, collation, factor counting, or garbage collection. The intake asserts exact, case-sensitive matching across statuses; I found no independent committed server evidence establishing it. Case-insensitive matching would make an existing `repworth` defeat the allocator, but that is a conditional concern, not a verified finding.

- **(b) SDK behavior verified:** In installed **auth-js 2.106.2**, `GoTrueClient.ts:5427` calls `getUser()`, copies every returned factor into `all`, and populates type-specific arrays only for verified factors. `types.ts:1239` explicitly documents both statuses in `all`. The hook’s normalizer retains both statuses, and `collectFactors` reads `all`. This assumption holds for factors returned by the server.

- **(c) Concurrency:** Read-then-enroll is not atomic. Two tabs can choose the same name; the mapped conflict is a reasonable recoverable outcome if GoTrue returns that code. Retrying after the winning creation becomes visible should select another name. Reloading is unnecessary because the next click already reads fresh; it also cannot guarantee against another simultaneous attempt. The UI disables the button while busy, but the hook has no independent in-flight guard.

- **(d) Capacity/cleanup remains the release-critical unknown:** I could not verify whether the deployed GoTrue limit counts unverified factors, whether cleanup runs on enrollment or timeout, or whether cleanup precedes the capacity check. I am not treating recollection about GoTrue as evidence. **If retained unverified factors consume the limit, repeated cancellations can block first-time enrollment:** the new “Remove one” advice offers no usable recovery to that owner. This is an enrollment dead end, not necessarily a login lockout.

  **Smallest robust design:** add a narrowly scoped, audited server cancellation operation for an owned, still-unverified enrollment, preserving AAL2 requirements for verified-factor removal. Clean up on Cancel and provide recovery for abandoned setups after reload or a lost response; Cancel-only cleanup misses those cases. Merely reusing an ID from `listFactors()` is insufficient: its factor metadata does not supply the original TOTP secret/QR.

- **(e) Raw errors:** React text rendering avoids HTML injection; it does not guarantee safe or useful message contents. An upstream message containing “sign in again” now triggers the authenticator link regardless of its actual cause. A session-expiry message could therefore send a first-time owner to a challenge page with no verified factors. No actual matching enrollment response was established. Prefer an explicit error/action discriminator.

- **(f) Naming:** Numeric suffixes solve uniqueness, not device identification. Gap filling also breaks chronological interpretation; two factors created the same day share the displayed date. Device labels would distinguish them better, but that is a usability tradeoff, not a proven blocker.

Read-only review of committed objects and installed SDK source; no tests, mutations, or live Auth probes executed.

VERDICT: REVISE
