// e2e/fixtures/zernio-fixture-server.ts
//
// In-memory fake Zernio HTTP server for the multi-location E2E verification
// kit (PR F). It implements the subset of the Zernio API that the REAL
// transport (`src/lib/zernio/client/transport.ts` + the per-domain clients in
// `src/lib/zernio/client/*`) calls, so the full ingest → draft → notify →
// approve → publish loop can run for N locations without a real Google
// Business Profile or Zernio sandbox credentials.
//
// Point the worker at it with `ZERNIO_API_BASE=<server.url>` (the transport
// appends `/v1/...` paths to that base). Unlike `MOCK_EXTERNAL_APIS=true`,
// which short-circuits the transport entirely, this server exercises the real
// fetch/classify/parse code path end-to-end.
//
// CONTRACT THAT MATTERS (everything else is loose):
//   * JSON response SHAPES must match what the per-domain clients normalize.
//   * Seeded reviews MUST carry
//       name: 'accounts/{accountId}/locations/{locationId}/reviews/{reviewId}'
//     with {locationId} === a seeded zernio_location_id. Otherwise
//     `extractLocationFromReviewName` (src/lib/reviews/zernio-normalize.ts)
//     returns null and `ZernioReviewIngestWorker` fails closed.
//
// Operations implemented (one endpoint per transport `endpointKind`):
//   create_profile   POST   /v1/profiles
//   start_connect    GET    /v1/connect/googlebusiness
//   list_locations   GET    /v1/connect/googlebusiness/locations
//   select_location  POST   /v1/connect/googlebusiness/select-location
//   list_reviews     GET    /v1/accounts/{accountId}/gmb-reviews
//   publish_reply    POST   /v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply
//   delete_reply     DELETE /v1/inbox/reviews/{reviewId}/reply
//   delete_profile   DELETE /v1/profiles/{profileId}
//   delete_account   DELETE /v1/accounts/{accountId}
// Plus a control endpoint, NOT part of the Zernio API:
//   seed reviews     POST   /__control/reviews   { locationId, reviews[] }

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ZernioReview } from '../../src/lib/zernio/types';

export interface ZernioFixtureLocation {
  id: string;
  name: string;
  address: string;
}

export interface ZernioReviewSeed {
  locationId: string;
  reviews: ZernioReview[];
}

export interface ZernioFixtureOptions {
  /** Defaults to 'fixture-account-1' — the {accountId} segment in review names
   *  and the account id returned by select_location. */
  accountId?: string;
  /** Locations returned by list_locations. Defaults to a single location whose
   *  id is the first seed's locationId, or 'fixture-loc-1' when no seeds. */
  locations?: ZernioFixtureLocation[];
  /** Initial per-location review seeds. More can be added at runtime via
   *  POST /__control/reviews. */
  seeds?: ZernioReviewSeed[];
}

export interface PublishedReplyRecord {
  accountId: string;
  reviewId: string;
  comment: string;
}

export interface DeletedReplyRecord {
  reviewId: string;
}

export interface ZernioFixtureServer {
  url: string;
  /** All publish_reply calls recorded in order — for E2E assertions. */
  publishedReplies: PublishedReplyRecord[];
  /** All delete_reply calls recorded in order — for E2E assertions. */
  deletedReplies: DeletedReplyRecord[];
  /** Seed (or replace) the reviews returned by list_reviews for a location. */
  seedReviews(seed: ZernioReviewSeed): void;
  stop(): Promise<void>;
}

/**
 * Build a Zernio/Google-Business review resource name. This is the ONE
 * load-bearing string in the whole fixture: the ingest worker parses the
 * {locationId} segment out of it and fails closed on any deviation.
 * Format: accounts/{accountId}/locations/{locationId}/reviews/{reviewId}.
 */
export function buildReviewName(
  accountId: string,
  locationId: string,
  reviewId: string,
): string {
  return `accounts/${accountId}/locations/${locationId}/reviews/${reviewId}`;
}

const STAR_BY_RATING: Record<number, ZernioReview['starRating']> = {
  1: 'ONE',
  2: 'TWO',
  3: 'THREE',
  4: 'FOUR',
  5: 'FIVE',
};

/**
 * Convenience builder for a contract-correct ZernioReview. Callers pass the
 * account + location so `name` carries the seeded zernio_location_id.
 */
export function makeFixtureReview(input: {
  accountId: string;
  locationId: string;
  reviewId: string;
  reviewerName?: string;
  rating?: 1 | 2 | 3 | 4 | 5;
  comment?: string | null;
  createTime?: string;
}): ZernioReview {
  const rating = input.rating ?? 5;
  const createTime = input.createTime ?? new Date().toISOString();
  return {
    id: input.reviewId,
    name: buildReviewName(input.accountId, input.locationId, input.reviewId),
    reviewer: {
      displayName: input.reviewerName ?? 'Fixture Reviewer',
      profilePhotoUrl: null,
      isAnonymous: false,
    },
    rating,
    starRating: STAR_BY_RATING[rating]!,
    comment: input.comment === undefined ? 'A fixture review.' : input.comment,
    createTime,
    updateTime: createTime,
    reviewReply: null,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  return JSON.parse(raw);
}

/**
 * Start the fixture server on an ephemeral port. Resolves once listening so
 * the returned `url` is immediately usable. The server holds all state in
 * memory and is fully stoppable.
 */
export async function startZernioFixtureServer(
  opts: ZernioFixtureOptions = {},
): Promise<ZernioFixtureServer> {
  const accountId = opts.accountId ?? 'fixture-account-1';
  const reviewsByLocation = new Map<string, ZernioReview[]>();
  for (const seed of opts.seeds ?? []) {
    reviewsByLocation.set(seed.locationId, seed.reviews);
  }

  const locations: ZernioFixtureLocation[] =
    opts.locations ??
    (() => {
      const seededLocationIds = [...reviewsByLocation.keys()];
      const firstLocationId = seededLocationIds[0] ?? 'fixture-loc-1';
      return [{ id: firstLocationId, name: 'Fixture Location 1', address: '1 Fixture St' }];
    })();

  const publishedReplies: PublishedReplyRecord[] = [];
  const deletedReplies: DeletedReplyRecord[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const path = requestUrl.pathname;

    // Control endpoint — seed/replace reviews for a location. Not Zernio API.
    if (method === 'POST' && path === '/__control/reviews') {
      const body = (await readJsonBody(req)) as ZernioReviewSeed | undefined;
      if (!body || typeof body.locationId !== 'string' || !Array.isArray(body.reviews)) {
        sendJson(res, 400, { error: 'invalid_seed' });
        return;
      }
      reviewsByLocation.set(body.locationId, body.reviews);
      sendJson(res, 200, { seeded: body.reviews.length, locationId: body.locationId });
      return;
    }

    // create_profile — POST /v1/profiles
    if (method === 'POST' && path === '/v1/profiles') {
      sendJson(res, 200, { profile: { _id: 'fixture-profile-1' } });
      return;
    }

    // delete_profile — DELETE /v1/profiles/{profileId}
    if (method === 'DELETE' && /^\/v1\/profiles\/[^/]+$/.test(path)) {
      sendNoContent(res);
      return;
    }

    // start_connect — GET /v1/connect/googlebusiness
    if (method === 'GET' && path === '/v1/connect/googlebusiness') {
      const state = requestUrl.searchParams.get('state') ?? 'fixture-state';
      sendJson(res, 200, {
        authUrl: 'http://localhost:3000/__fixture_oauth_complete',
        state,
      });
      return;
    }

    // list_locations — GET /v1/connect/googlebusiness/locations
    if (method === 'GET' && path === '/v1/connect/googlebusiness/locations') {
      sendJson(res, 200, { locations });
      return;
    }

    // select_location — POST /v1/connect/googlebusiness/select-location
    if (method === 'POST' && path === '/v1/connect/googlebusiness/select-location') {
      await readJsonBody(req);
      sendJson(res, 200, { account: { accountId } });
      return;
    }

    // list_reviews — GET /v1/accounts/{accountId}/gmb-reviews?locationId=...
    const reviewsMatch = path.match(/^\/v1\/accounts\/([^/]+)\/gmb-reviews$/);
    if (method === 'GET' && reviewsMatch) {
      const locationId = requestUrl.searchParams.get('locationId') ?? '';
      const reviews = reviewsByLocation.get(locationId) ?? [];
      sendJson(res, 200, { reviews, nextPageToken: undefined });
      return;
    }

    // publish_reply — POST /v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply
    const publishMatch = path.match(
      /^\/v1\/accounts\/([^/]+)\/gmb-reviews\/([^/]+)\/reply$/,
    );
    if (method === 'POST' && publishMatch) {
      const body = (await readJsonBody(req)) as { comment?: string } | undefined;
      const comment = typeof body?.comment === 'string' ? body.comment : '';
      const reviewId = decodeURIComponent(publishMatch[2]!);
      publishedReplies.push({
        accountId: decodeURIComponent(publishMatch[1]!),
        reviewId,
        comment,
      });
      sendJson(res, 200, { comment, updateTime: new Date().toISOString() });
      return;
    }

    // delete_reply — DELETE /v1/inbox/reviews/{reviewId}/reply
    const deleteReplyMatch = path.match(/^\/v1\/inbox\/reviews\/([^/]+)\/reply$/);
    if (method === 'DELETE' && deleteReplyMatch) {
      deletedReplies.push({ reviewId: decodeURIComponent(deleteReplyMatch[1]!) });
      sendNoContent(res);
      return;
    }

    // delete_account — DELETE /v1/accounts/{accountId}
    if (method === 'DELETE' && /^\/v1\/accounts\/[^/]+$/.test(path)) {
      sendNoContent(res);
      return;
    }

    sendJson(res, 404, { error: 'not_found', method, path });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, {
        error: 'fixture_internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    publishedReplies,
    deletedReplies,
    seedReviews(seed: ZernioReviewSeed): void {
      reviewsByLocation.set(seed.locationId, seed.reviews);
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
