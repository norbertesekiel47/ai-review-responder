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

    // #355: the delete-inbox-review-reply endpoint requires accountId in the
    // JSON body (docs.zernio.com/reviews/delete-inbox-review-reply). Omitting it
    // returns HTTP 400 missing_required_field — captured on staging 2026-06-27 —
    // which the classifier treats as permanent, silently breaking every edit of
    // a posted reply. Mirror postReply, which already scopes by accountId.
    deleteReply: (accountId: string, reviewId: string) =>
      transport.request<void>({
        method: 'DELETE',
        path: `/v1/inbox/reviews/${encodeURIComponent(reviewId)}/reply`,
        endpointKind: 'delete_reply',
        timeoutMs: 15_000,
        body: { accountId },
      }),
  };
}
