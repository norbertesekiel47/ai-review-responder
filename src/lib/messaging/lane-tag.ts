// src/lib/messaging/lane-tag.ts
//
// The Solicitation lane's routing discriminant (#657, spec §5.2) — a CROSS-MODULE
// CONTRACT, and this file is its single authoritative owner.
//
// The tag is EMITTED by `./email-adapter.ts` and READ by
// `worker/ingress/resend/solicitation-lane.ts` (`isSolicitationLane`). The two
// halves live in different module trees and no compiler check binds them, so a
// rename on either side would silently route every solicitation webhook into the
// `notification_deliveries` lane — whose UPDATEs match zero rows, ack 200, and
// lose the bounce or complaint permanently. Import these; never re-spell them.
// `worker/ingress/__tests__/resend-solicitation-routing.test.ts` binds the two
// halves through these constants, so drift fails a test rather than production.
//
// WHY ITS OWN FILE, rather than living on `./messaging-adapter.ts`: that module
// imports `EmailAdapter` for its accessor, so the ingress would reach the Resend
// SDK, `sendEmail` and `getServerConfig` transitively just to read two strings —
// and `email-adapter.ts` importing back would close a cycle. The plan is explicit
// that the lane "shares nothing with the adapter except the solicitation_outreach
// table" and "lands and works whether or not the adapter ever sends"; a leaf
// module with NO imports is what keeps that true. Same reason
// `worker/ingress/resend/bounce-classifier.ts` was extracted in Task 6.
//
// Keep this file import-free.

/** The Resend tag NAME carrying the lane discriminant. */
export const LANE_TAG_NAME = 'lane';

/** The tag VALUE that selects the Solicitation lane. */
export const SOLICITATION_LANE_TAG_VALUE = 'solicitation';
