import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('../client', () => ({ getResend: () => ({ emails: { send: mockSend } }) }));
vi.mock('@/lib/shared/mock-mode', () => ({ isMockMode: () => false }));

import { sendApprovalEmail } from '../templates/approval';

const PARAMS = {
  to: 'owner@example.com',
  from: 'noreply@repworth.com',
  locationLabel: 'My Cafe',
  businessName: 'My Cafe',
  reviewerName: 'Jane',
  starRating: 5,
  reviewText: 'Great!',
  reviewDate: '2026-06-01',
  responsePreview: 'Thanks!',
  approvalUrl: 'https://app.repworth.com/approve/tok',
};

describe('sendApprovalEmail idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ data: { id: 'm1' }, error: null });
  });

  it('forwards a Resend idempotency key so timeout-retries and failover do not double-send', async () => {
    await sendApprovalEmail({ ...PARAMS, idempotencyKey: 'approval_request:resp-1:email' });
    const call = mockSend.mock.calls[0] as unknown[];
    expect(call[1]).toEqual({ idempotencyKey: 'approval_request:resp-1:email' });
  });

  it('omits requestOptions when no idempotency key is provided', async () => {
    await sendApprovalEmail({ ...PARAMS });
    const call = mockSend.mock.calls[0] as unknown[];
    expect(call[1]).toBeUndefined();
  });
});
