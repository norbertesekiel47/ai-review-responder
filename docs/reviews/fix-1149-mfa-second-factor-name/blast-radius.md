# Blast radius — importers of changed files (`fix/1149-mfa-second-factor-name`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/components/auth/useMfaEnrollment.ts` — 5 importer(s)
- src/app/(authenticated)/settings/security/SecurityClient.tsx
- src/app/(authenticated)/settings/security/SecuritySections.tsx
- src/app/(authenticated)/settings/security/__tests__/SecurityClient.test.tsx
- src/app/(authenticated)/settings/security/__tests__/SecuritySections.test.tsx
- src/components/auth/__tests__/useMfaEnrollment.test.tsx

## `src/lib/auth/mfa.ts` — 13 importer(s)
- src/app/admin/impersonate/[sessionId]/view/page.tsx
- src/app/api/auth/mfa/challenge/route.ts
- src/app/api/auth/reset-password/route.ts
- src/app/mfa/challenge/MfaChallengeForm.tsx
- src/components/admin/AdminIdentity.tsx
- src/components/auth/RecoveryStepUpField.tsx
- src/components/auth/hooks/useLoginSubmit.ts
- src/components/auth/useMfaEnrollment.ts
- src/components/auth/useRecoveryStepUp.ts
- src/lib/account-offboarding/destructive-auth.ts
- src/lib/admin/shell-context.ts
- src/lib/auth/__tests__/mfa.test.ts
- src/lib/auth/page-gate.ts
