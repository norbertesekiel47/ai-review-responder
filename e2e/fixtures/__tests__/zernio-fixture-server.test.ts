import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startZernioFixtureServer,
  buildReviewName,
  makeFixtureReview,
  type ZernioFixtureServer,
} from '../zernio-fixture-server';
import { createZernioTransport } from '../../../src/lib/zernio/client/transport';
import { createLocationClient } from '../../../src/lib/zernio/client/locations';
import { createReplyClient } from '../../../src/lib/zernio/client/replies';
import { extractLocationFromReviewName } from '../../../src/lib/reviews/zernio-normalize';

const ACCOUNT_ID = 'fixture-account-1';

describe('buildReviewName', () => {
  it('produces the contract-critical resource-name format the ingest worker parses', () => {
    const name = buildReviewName('acct-9', 'loc-7', 'rev-3');
    expect(name).toBe('accounts/acct-9/locations/loc-7/reviews/rev-3');
    // Round-trips through the worker's fail-closed location parser.
    expect(extractLocationFromReviewName(name)).toBe('loc-7');
  });
});

describe('zernio fixture server (through the real transport)', () => {
  let fixture: ZernioFixtureServer;
  let originalApiBase: string | undefined;
  let originalMockExternalApis: string | undefined;

  beforeEach(() => {
    originalApiBase = process.env.ZERNIO_API_BASE;
    originalMockExternalApis = process.env.MOCK_EXTERNAL_APIS;
    // MUST be off so the transport actually hits the fixture over HTTP rather
    // than short-circuiting to the in-process mock branch.
    delete process.env.MOCK_EXTERNAL_APIS;
  });

  afterEach(async () => {
    if (fixture) await fixture.stop();
    if (originalApiBase === undefined) {
      delete process.env.ZERNIO_API_BASE;
    } else {
      process.env.ZERNIO_API_BASE = originalApiBase;
    }
    if (originalMockExternalApis === undefined) {
      delete process.env.MOCK_EXTERNAL_APIS;
    } else {
      process.env.MOCK_EXTERNAL_APIS = originalMockExternalApis;
    }
  });

  function clientFor(server: ZernioFixtureServer) {
    const transport = createZernioTransport({ baseUrl: server.url, apiKey: 'fixture-key' });
    return {
      locations: createLocationClient(transport),
      replies: createReplyClient(transport),
    };
  }

  it('list_locations returns the configured locations', async () => {
    fixture = await startZernioFixtureServer({
      accountId: ACCOUNT_ID,
      locations: [
        { id: 'loc-1', name: 'Loc One', address: '1 St' },
        { id: 'loc-2', name: 'Loc Two', address: '2 St' },
      ],
    });
    const { locations } = clientFor(fixture);
    const result = await locations.listLocations({
      profileId: 'prof-1',
      pendingDataToken: 'pdt-1',
    });
    expect(result.locations.map((l) => l.id)).toEqual(['loc-1', 'loc-2']);
  });

  it('list_reviews returns seeded reviews whose name carries the seeded locationId', async () => {
    fixture = await startZernioFixtureServer({
      accountId: ACCOUNT_ID,
      seeds: [
        {
          locationId: 'loc-1',
          reviews: [
            makeFixtureReview({
              accountId: ACCOUNT_ID,
              locationId: 'loc-1',
              reviewId: 'rev-1',
              rating: 5,
            }),
          ],
        },
      ],
    });
    const { locations } = clientFor(fixture);
    const reviews = await locations.listAllReviews(ACCOUNT_ID, {
      locationId: 'loc-1',
      pageSize: 50,
      maxPages: 5,
    });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.name).toBe('accounts/fixture-account-1/locations/loc-1/reviews/rev-1');
    // The worker's fail-closed parser must accept it.
    expect(extractLocationFromReviewName(reviews[0]!.name)).toBe('loc-1');
    // listReviews normalizes omitted reviewReply to null.
    expect(reviews[0]!.reviewReply).toBeNull();
  });

  it('returns reviews ONLY for the requested location (per-location isolation)', async () => {
    fixture = await startZernioFixtureServer({
      accountId: ACCOUNT_ID,
      seeds: [
        {
          locationId: 'loc-1',
          reviews: [
            makeFixtureReview({ accountId: ACCOUNT_ID, locationId: 'loc-1', reviewId: 'rev-1' }),
          ],
        },
        {
          locationId: 'loc-2',
          reviews: [
            makeFixtureReview({ accountId: ACCOUNT_ID, locationId: 'loc-2', reviewId: 'rev-2' }),
          ],
        },
      ],
    });
    const { locations } = clientFor(fixture);

    const loc1 = await locations.listAllReviews(ACCOUNT_ID, { locationId: 'loc-1', pageSize: 50, maxPages: 5 });
    const loc2 = await locations.listAllReviews(ACCOUNT_ID, { locationId: 'loc-2', pageSize: 50, maxPages: 5 });
    expect(loc1.map((r) => r.id)).toEqual(['rev-1']);
    expect(loc2.map((r) => r.id)).toEqual(['rev-2']);
  });

  it('returns an empty list for an unseeded location', async () => {
    fixture = await startZernioFixtureServer({ accountId: ACCOUNT_ID });
    const { locations } = clientFor(fixture);
    const reviews = await locations.listAllReviews(ACCOUNT_ID, {
      locationId: 'never-seeded',
      pageSize: 50,
      maxPages: 5,
    });
    expect(reviews).toEqual([]);
  });

  it('records publish_reply and delete_reply calls for E2E assertions', async () => {
    fixture = await startZernioFixtureServer({ accountId: ACCOUNT_ID });
    const { replies } = clientFor(fixture);

    const published = await replies.postReply(ACCOUNT_ID, 'rev-1', { comment: 'Thank you!' });
    expect(published).toMatchObject({ comment: 'Thank you!' });
    expect(fixture.publishedReplies).toEqual([
      { accountId: ACCOUNT_ID, reviewId: 'rev-1', comment: 'Thank you!' },
    ]);

    await replies.deleteReply(ACCOUNT_ID, 'rev-1');
    expect(fixture.deletedReplies).toEqual([{ reviewId: 'rev-1' }]);
  });

  it('supports runtime re-seeding via seedReviews()', async () => {
    fixture = await startZernioFixtureServer({ accountId: ACCOUNT_ID });
    const { locations } = clientFor(fixture);

    const before = await locations.listAllReviews(ACCOUNT_ID, { locationId: 'loc-1', pageSize: 50, maxPages: 5 });
    expect(before).toEqual([]);

    fixture.seedReviews({
      locationId: 'loc-1',
      reviews: [makeFixtureReview({ accountId: ACCOUNT_ID, locationId: 'loc-1', reviewId: 'rev-late' })],
    });

    const after = await locations.listAllReviews(ACCOUNT_ID, { locationId: 'loc-1', pageSize: 50, maxPages: 5 });
    expect(after.map((r) => r.id)).toEqual(['rev-late']);
  });
});
