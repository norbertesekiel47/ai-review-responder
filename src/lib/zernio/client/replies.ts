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
  };
}
