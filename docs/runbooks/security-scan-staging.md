# Staging Security Scan

Owner: founder
Cadence: before launch, before material public-route changes, and monthly

Wave 1 does not hard-gate ZAP in secret-free CI because the repo does not expose a stable staging target to pull requests.

## Scope

- Public marketing and legal routes
- Owner login and reset-password surfaces
- Approval link route using staging-only data
- Worker ingress health endpoints exposed in staging

## Required Secret

- `STAGING_BASE_URL`

## Procedure

1. Confirm staging is deployed with staging-only credentials and no production customer data.
2. Set `STAGING_BASE_URL` to the staging app origin.
3. Run the ZAP baseline scan.
4. Review `zap-report.html` for high and medium findings.
5. Create issues for any medium findings and block release for high findings.
6. Record date, actor, target, and result in the scan log.

## Command

```bash
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t "$STAGING_BASE_URL" -r zap-report.html
```

## Exit Policy

- PASS: no high-risk findings.
- FAIL: high-risk findings or scan cannot reach staging.
- WARN: medium findings require issue creation before merge.

## Scan Log

| Date | Actor | Target | Result |
|---|---|---|---|
