import { z } from 'zod';
import type { VoiceConfig } from '@/lib/responses/voice-settings';
import { proposableOperation, type PolicyRestoreWriterPatch } from './catalog';
import { parseReceipt, PROPOSAL_STATUS, type Receipt } from './schema';

const RestoreEnvelopeSchema = z.object({
  restore: z.object({ sourceProposalId: z.uuid() }).strict(),
}).strict();

export interface RestoreInput {
  sourceProposalId: string;
}

/** The caller loads this source with an account-scoped query. */
export interface RestoreSource {
  id: string;
  operation: string;
  contractVersion: number;
  locationId: string | null;
  status: string;
  turnId: string;
  receipt: Receipt | null;
}

export type DerivedRestoreInput =
  | { domain: 'voice'; input: Record<string, unknown>; fields: Partial<VoiceConfig> }
  | { domain: 'policy'; patch: PolicyRestoreWriterPatch };

export function parseRestoreInput(value: unknown): RestoreInput | null {
  const parsed = RestoreEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.restore : null;
}

/** A malformed restore envelope must not fall back to ordinary model input. */
export function hasRestoreInput(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'restore' in value;
}

function validatedReceipt(value: Receipt | null): Receipt | null {
  try {
    return parseReceipt(value);
  } catch {
    // Corrupt historical evidence is an unavailable inverse, never trusted state.
    return null;
  }
}

/** Derive only from this applied Receipt; prior Restore provenance is irrelevant. */
export function deriveRestoreInput(input: {
  accountId: string;
  operation: string;
  contractVersion: number;
  locationId: string | null;
  source: RestoreSource;
}): DerivedRestoreInput | null {
  const { source } = input;
  const operation = proposableOperation(input.operation);
  if (
    !operation
    || source.status !== PROPOSAL_STATUS.APPLIED
    || !z.uuid().safeParse(source.id).success
    || source.operation !== input.operation
    || source.contractVersion !== input.contractVersion
    || operation.contractVersion !== input.contractVersion
    || source.locationId !== input.locationId
    || (operation.scopeRule === 'location' && input.locationId === null)
  ) return null;

  const receipt = validatedReceipt(source.receipt);
  if (
    !receipt
    || receipt.operation !== source.operation
    || receipt.scope.accountId !== input.accountId
    || receipt.scope.locationId !== source.locationId
    || receipt.turnId !== source.turnId
    || receipt.affects !== operation.affects
  ) return null;

  if (operation.domain === 'voice' && receipt.affects === 'future_drafts') {
    const restored = operation.restoreInputFromState(receipt.before);
    // Ordinary parseInput intentionally rejects null tone. The strict Receipt
    // parser above validates this server-owned inverse without widening it.
    return { domain: 'voice', input: restored, fields: operation.writerFields(restored) };
  }
  if (operation.domain === 'policy' && receipt.affects === 'future_eligible_reviews') {
    const target = input.locationId === null
      ? { scope: 'account' as const }
      : { scope: 'location' as const, locationId: input.locationId };
    return {
      domain: 'policy',
      patch: operation.restoreInputFromState(receipt.before, receipt.after, target),
    };
  }
  return null;
}
