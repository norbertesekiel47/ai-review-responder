# Secrets Rotation: Zernio

Owner: founder
Cadence: every 6 months and immediately after suspected exposure

## Scope

- ZERNIO_API_KEY
- Zernio webhook signing secret

## Procedure

1. Create replacement API key and webhook signing secret in Zernio.
2. Add replacement values to Railway worker environment variables.
3. Deploy the worker.
4. Verify Zernio webhook signature validation, review ingest, and external reply reconciliation in staging.
5. Remove old Zernio credentials.
6. Record date, actor, and verification result in the rotation log.

## Rotation Log

| Date | Actor | Secret | Verification |
|---|---|---|---|
