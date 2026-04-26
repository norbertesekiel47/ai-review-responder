// src/lib/approval/types.ts
//
// Shared type definitions for the approval layer. Lives in its own
// module so locks.ts, audit.ts, and the mode files can import the
// `ApprovalLink` shape without forming a cycle through service.ts.

export interface ApprovalLink {
  id: string;
  response_id: string;
  business_id: string;
  token_hash: string;
  channel: string;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
  device_cookie_hash: string | null;
  created_at: Date;
}
