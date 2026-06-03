import { describe, it, expect, vi } from 'vitest';
import { createLocationClient } from '../locations';
import type { RequestOptions, ZernioTransport } from '../transport';
import type { ZernioReview } from '@/lib/zernio/types';

// A fake transport injected straight into createLocationClient so we exercise
// the client's shape-normalization branches (the many `??` fallbacks) without
// any network or the real transport. The existing client.test.ts covers request
// wiring through fetch; this file covers the parsing/normalization paths.
function fakeTransport(
  handler: (opts: RequestOptions) => unknown,
): { transport: ZernioTransport; calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const transport: ZernioTransport = {
    request: async <T>(opts: RequestOptions): Promise<T> => {
      calls.push(opts);
      return handler(opts) as T;
    },
  };
  return { transport, calls };
}

function clientReturning(raw: unknown) {
  const { transport } = fakeTransport(() => raw);
  return createLocationClient(transport);
}

const review = (over: Partial<ZernioReview> = {}): ZernioReview => ({
  id: 'r1',
  name: 'accounts/a/locations/l/reviews/r1',
  reviewer: { displayName: 'A', profilePhotoUrl: null, isAnonymous: false },
  rating: 5,
  starRating: 'FIVE',
  comment: 'Great',
  createTime: '2026-01-01T00:00:00Z',
  updateTime: '2026-01-01T00:00:00Z',
  reviewReply: null,
  ...over,
});

describe('createLocationClient — listLocations / normalizeLocations', () => {
  it('reads locations from the `locations` array key', async () => {
    const client = clientReturning({
      locations: [{ id: 'l1', name: 'One', address: '1 St' }],
    });
    const { locations } = await client.listLocations({
      profileId: 'p',
      pendingDataToken: 'pdt',
    });
    expect(locations).toEqual([{ id: 'l1', name: 'One', address: '1 St' }]);
  });

  it('falls back to the `data` then `results` array keys', async () => {
    const fromData = await clientReturning({
      data: [{ id: 'd1', name: 'D', address: '' }],
    }).listLocations({ profileId: 'p', pendingDataToken: 'pdt' });
    expect(fromData.locations.map((l) => l.id)).toEqual(['d1']);

    const fromResults = await clientReturning({
      results: [{ id: 'res1', name: 'R', address: '' }],
    }).listLocations({ profileId: 'p', pendingDataToken: 'pdt' });
    expect(fromResults.locations.map((l) => l.id)).toEqual(['res1']);
  });

  it('resolves id from _id / id / locationId fallbacks', async () => {
    const client = clientReturning({
      locations: [
        { _id: 'underscore' },
        { id: 'plain' },
        { locationId: 'loc' },
      ],
    });
    const { locations } = await client.listLocations({
      profileId: 'p',
      pendingDataToken: 'pdt',
    });
    expect(locations.map((l) => l.id)).toEqual(['underscore', 'plain', 'loc']);
  });

  it('resolves name from name / title / displayName, defaulting to <unnamed>', async () => {
    const client = clientReturning({
      locations: [
        { id: '1', title: 'FromTitle' },
        { id: '2', displayName: 'FromDisplay' },
        { id: '3' },
      ],
    });
    const { locations } = await client.listLocations({
      profileId: 'p',
      pendingDataToken: 'pdt',
    });
    expect(locations.map((l) => l.name)).toEqual([
      'FromTitle',
      'FromDisplay',
      '<unnamed>',
    ]);
  });

  it('resolves address from address / formattedAddress, defaulting to empty', async () => {
    const client = clientReturning({
      locations: [
        { id: '1', formattedAddress: '500 Fmt Ave' },
        { id: '2' },
      ],
    });
    const { locations } = await client.listLocations({
      profileId: 'p',
      pendingDataToken: 'pdt',
    });
    expect(locations.map((l) => l.address)).toEqual(['500 Fmt Ave', '']);
  });

  it('drops entries with no resolvable id', async () => {
    const client = clientReturning({
      locations: [{ name: 'no id here' }, { id: 'keep' }],
    });
    const { locations } = await client.listLocations({
      profileId: 'p',
      pendingDataToken: 'pdt',
    });
    expect(locations.map((l) => l.id)).toEqual(['keep']);
  });

  it('returns an empty list for non-object or shapeless payloads', async () => {
    for (const raw of [null, undefined, 'string', 42, {}, { locations: 'nope' }]) {
      const { locations } = await clientReturning(raw).listLocations({
        profileId: 'p',
        pendingDataToken: 'pdt',
      });
      expect(locations).toEqual([]);
    }
  });

  it('only sends X-Connect-Token when a connectToken is provided', async () => {
    const { transport, calls } = fakeTransport(() => ({ locations: [] }));
    const client = createLocationClient(transport);
    await client.listLocations({ profileId: 'p', pendingDataToken: 'pdt' });
    await client.listLocations({
      profileId: 'p',
      pendingDataToken: 'pdt',
      connectToken: 'ct',
    });
    expect(calls[0]!.headers).toBeUndefined();
    expect(calls[1]!.headers).toEqual({ 'X-Connect-Token': 'ct' });
  });
});

describe('createLocationClient — startConnect', () => {
  it('resolves authUrl from authUrl / url / redirectUrl fallbacks', async () => {
    const args = { profileId: 'p', state: 's', redirectUrl: 'https://app/cb' };
    expect(
      (await clientReturning({ authUrl: 'https://a' }).startConnect(args)).authUrl,
    ).toBe('https://a');
    expect(
      (await clientReturning({ url: 'https://b' }).startConnect(args)).authUrl,
    ).toBe('https://b');
    expect(
      (await clientReturning({ redirectUrl: 'https://c' }).startConnect(args)).authUrl,
    ).toBe('https://c');
  });

  it('passes through a non-empty returned state, else undefined', async () => {
    const args = { profileId: 'p', state: 's', redirectUrl: 'https://app/cb' };
    expect(
      (await clientReturning({ authUrl: 'https://a', state: 'srv' }).startConnect(args))
        .state,
    ).toBe('srv');
    expect(
      (await clientReturning({ authUrl: 'https://a', state: '' }).startConnect(args))
        .state,
    ).toBeUndefined();
  });

  it('throws on an unrecognized response shape', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      clientReturning({ nope: true }).startConnect({
        profileId: 'p',
        state: 's',
        redirectUrl: 'https://app/cb',
      }),
    ).rejects.toThrow('zernio_startConnect_unexpected_response_shape');
    warn.mockRestore();
  });
});

describe('createLocationClient — selectLocation', () => {
  const args = {
    profileId: 'p',
    pendingDataToken: 'pdt',
    locationId: 'l1',
  };

  it('resolves accountId from each documented fallback position', async () => {
    const cases: Array<[unknown, string]> = [
      [{ accountId: 'top' }, 'top'],
      [{ account: { accountId: 'nested-acct' } }, 'nested-acct'],
      [{ account: { _id: 'nested-underscore' } }, 'nested-underscore'],
      [{ account: { id: 'nested-id' } }, 'nested-id'],
      [{ _id: 'top-underscore' }, 'top-underscore'],
      [{ id: 'top-id' }, 'top-id'],
    ];
    for (const [raw, expected] of cases) {
      const result = await clientReturning(raw).selectLocation(args);
      expect(result.accountId).toBe(expected);
    }
  });

  it('throws on an unrecognized response shape', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(clientReturning({ nope: true }).selectLocation(args)).rejects.toThrow(
      'zernio_selectLocation_unexpected_response_shape',
    );
    warn.mockRestore();
  });

  it('includes redirect_url in the body only when provided', async () => {
    const { transport, calls } = fakeTransport(() => ({ accountId: 'a' }));
    const client = createLocationClient(transport);
    await client.selectLocation(args);
    await client.selectLocation({ ...args, redirectUrl: 'https://app/cb' });
    expect(calls[0]!.body).toEqual({
      profileId: 'p',
      locationId: 'l1',
      pendingDataToken: 'pdt',
    });
    expect(calls[1]!.body).toEqual({
      profileId: 'p',
      locationId: 'l1',
      pendingDataToken: 'pdt',
      redirect_url: 'https://app/cb',
    });
  });
});

describe('createLocationClient — listReviews / listAllReviews', () => {
  it('coerces an omitted reviewReply to null (strict-equality safety)', async () => {
    const raw = { reviews: [review({ reviewReply: undefined as never })] };
    const { reviews } = await clientReturning(raw).listReviews('acct', {
      locationId: 'l1',
    });
    expect(reviews[0]!.reviewReply).toBeNull();
  });

  it('preserves an explicit reviewReply object', async () => {
    const reply = { comment: 'thanks', updateTime: '2026-01-02T00:00:00Z' };
    const raw = { reviews: [review({ reviewReply: reply })] };
    const { reviews } = await clientReturning(raw).listReviews('acct', {
      locationId: 'l1',
    });
    expect(reviews[0]!.reviewReply).toEqual(reply);
  });

  it('returns an empty list when the payload has no reviews', async () => {
    const { reviews, nextPageToken } = await clientReturning({}).listReviews('acct', {
      locationId: 'l1',
    });
    expect(reviews).toEqual([]);
    expect(nextPageToken).toBeUndefined();
  });

  it('paginates with the page token until exhausted', async () => {
    let call = 0;
    const { transport } = fakeTransport(() => {
      call += 1;
      if (call === 1) return { reviews: [review({ id: 'a' })], nextPageToken: 'p2' };
      if (call === 2) return { reviews: [review({ id: 'b' })], nextPageToken: 'p3' };
      return { reviews: [review({ id: 'c' })] };
    });
    const all = await createLocationClient(transport).listAllReviews('acct', {
      locationId: 'l1',
      pageSize: 50,
      maxPages: 10,
    });
    expect(all.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(call).toBe(3);
  });

  it('stops at maxPages even when more pages remain', async () => {
    let call = 0;
    const { transport } = fakeTransport(() => {
      call += 1;
      return { reviews: [review({ id: `r${call}` })], nextPageToken: 'always-more' };
    });
    const all = await createLocationClient(transport).listAllReviews('acct', {
      locationId: 'l1',
      pageSize: 50,
      maxPages: 2,
    });
    expect(all.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(call).toBe(2);
  });
});
