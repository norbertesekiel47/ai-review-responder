import type { ZernioLocationOption, ZernioReview } from '../types';
import { summarizeShape } from './diagnostics';
import type { ZernioTransport } from './transport';

function normalizeLocations(raw: unknown): ZernioLocationOption[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const arr =
    (Array.isArray(o.locations) ? o.locations : undefined) ??
    (Array.isArray(o.data) ? o.data : undefined) ??
    (Array.isArray(o.results) ? o.results : undefined) ??
    [];
  return (arr as Array<Record<string, unknown>>).map((loc) => ({
    id:
      (typeof loc._id === 'string' ? loc._id : undefined) ??
      (typeof loc.id === 'string' ? loc.id : undefined) ??
      (typeof loc.locationId === 'string' ? loc.locationId : undefined) ??
      '',
    name:
      (typeof loc.name === 'string' ? loc.name : undefined) ??
      (typeof loc.title === 'string' ? loc.title : undefined) ??
      (typeof loc.displayName === 'string' ? loc.displayName : undefined) ??
      '<unnamed>',
    address:
      (typeof loc.address === 'string' ? loc.address : undefined) ??
      (typeof loc.formattedAddress === 'string' ? loc.formattedAddress : undefined) ??
      '',
  })).filter((l) => l.id !== '');
}

export function createLocationClient(transport: ZernioTransport) {
  const listReviews = async (
    accountId: string,
    input: { locationId: string; pageSize?: number; pageToken?: string },
  ) => {
    const raw = await transport.request<{ reviews: ZernioReview[]; nextPageToken?: string }>({
      method: 'GET',
      path: `/v1/accounts/${encodeURIComponent(accountId)}/gmb-reviews?locationId=${encodeURIComponent(input.locationId)}&pageSize=${input.pageSize ?? 50}${input.pageToken ? `&pageToken=${encodeURIComponent(input.pageToken)}` : ''}`,
      endpointKind: 'list_reviews',
      timeoutMs: 15_000,
    });
    // Normalize reviewReply: Zernio may OMIT the field on unanswered reviews
    // rather than returning explicit null. Downstream code uses
    // `reviewReply !== null` / `=== null` strict-equality predicates which
    // would route an `undefined` reviewReply to the answered branch and then
    // crash on .comment. Force every entry to either null or an object at
    // the API chokepoint. See Code Review fix Medium 1 (2026-05-02).
    const reviews = (raw?.reviews ?? []).map((r) => ({
      ...r,
      reviewReply: r.reviewReply ?? null,
    }));
    return { reviews, nextPageToken: raw?.nextPageToken };
  };

  const listAllReviews = async (
    accountId: string,
    opts: { locationId: string; pageSize: number; maxPages: number },
  ): Promise<ZernioReview[]> => {
    const all: ZernioReview[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < opts.maxPages; i++) {
      const page = await listReviews(accountId, {
        locationId: opts.locationId,
        pageSize: opts.pageSize,
        pageToken,
      });
      all.push(...page.reviews);
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return all;
  };

  return {
    startConnect: async (input: { profileId: string; state: string; redirectUrl: string }) => {
      const raw = await transport.request<unknown>({
        method: 'GET',
        path: `/v1/connect/googlebusiness?profileId=${encodeURIComponent(input.profileId)}&headless=true&redirect_url=${encodeURIComponent(input.redirectUrl)}&state=${encodeURIComponent(input.state)}`,
        endpointKind: 'start_connect',
        timeoutMs: 10_000,
      });
      const o = (raw ?? {}) as Record<string, unknown>;
      const authUrl =
        (typeof o.authUrl === 'string' ? o.authUrl : undefined) ??
        (typeof o.url === 'string' ? o.url : undefined) ??
        (typeof o.redirectUrl === 'string' ? o.redirectUrl : undefined);
      if (!authUrl) {
        console.warn(`[zernio.startConnect] UNRECOGNIZED authUrl SHAPE: ${summarizeShape(raw)}`);
        throw new Error('zernio_startConnect_unexpected_response_shape');
      }
      return {
        authUrl,
        state: typeof o.state === 'string' && o.state.length > 0 ? o.state : undefined,
      };
    },

    listLocations: async (input: {
      profileId: string;
      pendingDataToken: string;
      connectToken?: string;
    }) => {
      const raw = await transport.request<unknown>({
        method: 'GET',
        path: `/v1/connect/googlebusiness/locations?profileId=${encodeURIComponent(input.profileId)}&pendingDataToken=${encodeURIComponent(input.pendingDataToken)}`,
        endpointKind: 'list_locations',
        timeoutMs: 10_000,
        headers: input.connectToken ? { 'X-Connect-Token': input.connectToken } : undefined,
      });
      const locations = normalizeLocations(raw);
      return { locations };
    },

    selectLocation: async (input: {
      profileId: string;
      pendingDataToken: string;
      connectToken?: string;
      locationId: string;
      redirectUrl?: string;
    }) => {
      const raw = await transport.request<unknown>({
        method: 'POST',
        path: '/v1/connect/googlebusiness/select-location',
        endpointKind: 'select_location',
        timeoutMs: 15_000,
        headers: input.connectToken ? { 'X-Connect-Token': input.connectToken } : undefined,
        body: {
          profileId: input.profileId,
          locationId: input.locationId,
          pendingDataToken: input.pendingDataToken,
          ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
        },
      });
      const o = (raw ?? {}) as Record<string, unknown>;
      const acctObj = o.account as Record<string, unknown> | undefined;
      const accountId =
        (typeof o.accountId === 'string' ? o.accountId : undefined) ??
        (typeof acctObj?.accountId === 'string' ? (acctObj.accountId as string) : undefined) ??
        (typeof acctObj?._id === 'string' ? (acctObj._id as string) : undefined) ??
        (typeof acctObj?.id === 'string' ? (acctObj.id as string) : undefined) ??
        (typeof o._id === 'string' ? (o._id as string) : undefined) ??
        (typeof o.id === 'string' ? (o.id as string) : undefined);
      if (!accountId) {
        console.warn(`[zernio.selectLocation] UNRECOGNIZED accountId SHAPE: ${summarizeShape(raw)}`);
        throw new Error('zernio_selectLocation_unexpected_response_shape');
      }
      return { accountId };
    },

    listReviews,
    listAllReviews,

    deleteAccount: (accountId: string) =>
      transport.request<void>({
        method: 'DELETE',
        path: `/v1/accounts/${encodeURIComponent(accountId)}`,
        endpointKind: 'delete_account',
        timeoutMs: 10_000,
      }),
  };
}
