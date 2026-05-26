# Connect Google Business

## When to use

Use this when an owner cannot connect or reconnect Google Business Profile, the OAuth attempt expired, or a Zernio connection needs manual review.

## Customer reply

Hi {{owner_name}},

Please start the Google Business connection again from RepWorth. Use a Google account that manages the location, keep the consent window open until it redirects back, and select the matching location if Google shows more than one.

If the redirect window does not open, use the manual connection link shown on the RepWorth connection page.

## Internal checks

- Confirm the account is not read-only.
- Confirm the owner is using the correct location scope.
- Check for unresolved `zernio_finalize_incidents`.
- Check the latest `zernio_connections` row for `last_error` and status.
- Confirm no stale pending flow is blocking a new attempt.

## Escalation

Escalate when the account is stuck in `finalize_unknown`, when Zernio returns repeated authorization errors, or when the owner can prove Google access but RepWorth cannot list the location.
