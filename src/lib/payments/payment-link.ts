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
  // Validate the configured payment link URL parses — a misconfigured env var
  // (typo, leading whitespace, missing scheme) would otherwise produce a
  // mangled href that the browser sends users to. Return null so callers can
  // surface a "contact support" message instead.
  //
  // Beyond syntax, ENFORCE https://. The URL constructor accepts any
  // scheme — javascript:, data:, http:, file:, etc. — and the result
  // flows into PlanPickerClient as `window.location.href = paymentUrl`
  // and (in similar callers) as a rendered `<a href>`. A javascript:
  // URL there is XSS; a data: URL is phishing; http:// is a downgrade.
  // Stripe Payment Links are ALWAYS https://buy.stripe.com/..., so any
  // other scheme means the env var is wrong and we should fail closed
  // rather than send the user there.
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') {
    return null;
  }
  // Build the final URL via the parsed instance, not by string-concatenating
  // the raw env value. Two reasons:
  //   1. Drops any fragment (parsed.hash). A Stripe Payment Link should
  //      never have one, but if the env value accidentally contains
  //      `https://buy.stripe.com/foo#bar`, the manual concatenation would
  //      mis-place our query params AFTER the fragment, producing a broken
  //      URL the browser silently strips.
  //   2. Normalizes whitespace + ensures correct query separator. URL.toString()
  //      always produces `?a=b&c=d` form regardless of whether the original
  //      had no query, leading whitespace, or a trailing `?` with no params.
  parsed.hash = '';
  parsed.searchParams.append('client_reference_id', businessId);
  parsed.searchParams.append('prefilled_email', ownerEmail);
  return parsed.toString();
}
