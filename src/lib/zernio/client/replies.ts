import type { ZernioTransport } from './transport';

export function createReplyClient(transport: ZernioTransport) {
  return {
    postReply: (accountId: string, reviewId: string, input: { comment: string }) =>
      transport.request<{ comment: string; updateTime: string }>({
        method: 'POST',
        path: `/v1/accounts/${encodeURIComponent(accountId)}/gmb-reviews/${encodeURIComponent(reviewId)}/reply`,
        endpointKind: 'publish_reply',
        timeoutMs: 15_000,
        body: { comment: input.comment },
      }),

    deleteReply: (_accountId: string, reviewId: string) =>
      transport.request<void>({
        method: 'DELETE',
        path: `/v1/inbox/reviews/${encodeURIComponent(reviewId)}/reply`,
        endpointKind: 'delete_reply',
        timeoutMs: 15_000,
      }),
  };
}
