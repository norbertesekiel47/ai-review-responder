# Legacy support shell — #1193

Captured 2026-09-11 with Playwright Chromium at 390×900 and 1440×900 from
implementation `ce87e5df8dd2dae000ddbca785c8191d79161d26`.

Target: a temporary loopback Vite harness at `http://127.0.0.1:3113`, importing
the actual `AdminShellFrame`, `AdminIdentity`, `ImpersonationBanner`,
`EndImpersonationButton`, `AdminPage` and global CSS from that implementation.
The page body, Next routing, Supabase sign-out result, identity and session
display props are synthetic. End-session requests were intercepted with local
403/200 fixtures. Other origins were blocked. No live account or session was
created, ended or signed out.

| Capture | What it establishes |
| --- | --- |
| `identity-{390,1440}.png` | Compact identity header, AAL2 status and one Open Admin app link; no sidebar. |
| `active-{390,1440}.png` | Active-session banner and End session control remain in the main content. |
| `sticky-{390,1440}.png` | After scrolling 400px, the banner's measured top is 0px. |
| `aal1-{390,1440}.png` | The local MFA Verify link remains available. |
| `signout-error-{390,1440}.png` | A returned sign-out failure remains visible with an enabled retry control. |

All eight viewport/state combinations passed, with no horizontal overflow or
browser page errors. Checks also followed the plain Admin app anchor to a local
destination fixture, asserted the MFA return href, exercised mocked end-session
refusal/retry/success navigation, and confirmed that login, forgot-password and
reset-password render bare children. See `results.json` for the check record.

This is synthetic component evidence, not an authenticated end-to-end journey.
Computer Use and the agent-browser CLI were unavailable; Playwright was the
available automated fallback. The Vite harness emitted warnings for later
public-page CSS imports; Next's production build is validated separately.
No live Supabase MFA challenge, real sign-out, real end-session backend outcome,
cross-app login continuity or production interaction is claimed here.
