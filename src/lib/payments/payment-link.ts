const TIER_ENV: Record<string, string> = {
  founding: 'STRIPE_PAYMENT_LINK_FOUNDING',
  standard: 'STRIPE_PAYMENT_LINK_STANDARD',
};

export function buildPaymentLinkUrl(
  tier: 'founding' | 'standard',
  businessId: string,
  ownerEmail: string,
): string | null {
  const envKey = TIER_ENV[tier];
  if (!envKey) return null;
  const baseUrl = process.env[envKey];
  if (!baseUrl) return null;
  const params = new URLSearchParams({
    client_reference_id: businessId,
    prefilled_email: ownerEmail,
  });
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}${params.toString()}`;
}
