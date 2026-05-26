# Security Report

## When to use

Use this when a user reports suspicious access, MFA loss, account takeover concern, or a vulnerability disclosure.

## Customer reply

Hi {{reporter_name}},

We received your security report and will review it with priority. Please send any relevant timestamps, affected account emails, request IDs, screenshots, and steps to reproduce. Do not send secrets, raw tokens, or customer private data unless we specifically request a secure transfer method.

## Internal checks

- Preserve the original report and timestamps.
- Confirm whether the reporter is an account user, partner, or external researcher.
- Check recent auth activity and account audit logs.
- For MFA loss, verify account ownership before changing access.
- For vulnerability reports, reproduce in a safe environment only.

## Escalation

Escalate immediately for account takeover, exposed secrets, payment data exposure, RLS bypass, approval-token leakage, service-role key exposure, or any report affecting multiple tenants.
