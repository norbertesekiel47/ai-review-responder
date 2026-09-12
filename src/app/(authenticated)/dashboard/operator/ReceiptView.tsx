'use client';

import type { Receipt } from '@/lib/agents/operator/schema';
import './operator.css';

export interface ReceiptViewProps {
  receipt: Receipt;
  locationLabel: (locationId: string) => string;
}

/** T4 owns the body. */
export function ReceiptView({ receipt }: ReceiptViewProps) {
  return <div className="op-receipt">{receipt.operation}</div>;
}
