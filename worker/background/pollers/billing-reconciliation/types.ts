export interface AccountWithLocations {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  locations_included: number;
  locations_overage_price_cents: number;
  active_location_count: number;
  past_due_at: Date | null;
  flags: Record<string, unknown> | null;
}

export interface BillingReconciliationAccount {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  stripe_subscription_id: string | null;
  locations_included: number;
  locations_overage_price_cents: number;
  active_location_count: number;
  past_due_at: Date | null;
  flags: Record<string, unknown>;
}

export interface ExpectedInvoice {
  baseCents: number;
  overageUnits: number;
  overageUnitPriceCents: number;
  totalCents: number;
}

export type DriftSeverity = 'info' | 'unsafe';

export interface DriftFinding {
  severity: DriftSeverity;
  type:
    | 'missing_subscription'
    | 'duplicate_subscription'
    | 'status_mismatch'
    | 'price_mismatch'
    | 'quantity_mismatch'
    | 'upcoming_invoice_mismatch'
    | 'unknown_stripe_state';
  message: string;
  expectedCents?: number;
  actualCents?: number;
}
