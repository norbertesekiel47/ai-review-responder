# feat-qr-review-request — deviations

- [2026-08-26] AMENDMENT #1 (narrowing, auto-approved per step 2 rule): removed
  `src/app/api/locations/review-qr/**` from `allowed_edit_surface`. The owner
  PNG endpoint is not built at all — the settings page server-renders QR data
  URLs (the `src/app/api/_shared/channels/start.ts` `QRCode.toDataURL`
  precedent), and the download anchor uses the data URL directly. One fewer
  route, no route-auth surface, smaller diff. Both intake copies updated.
- [2026-08-26] Test retitle (deviations-file entry, not an amendment — the
  #643 rule): "rejects a review-qr asset request for a location outside the
  caller's account" → "returns only the caller's account locations from
  getOwnerReviewQrLocations". Same tenant-scope intent; with the endpoint
  dropped, scoping is enforced by the module query (`WHERE account_id = …`)
  plus `requireOwnerAccess` on the settings pages. Recorded for owner
  visibility at step 6 read-back.
