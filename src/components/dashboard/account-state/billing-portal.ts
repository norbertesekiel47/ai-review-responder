export async function openBillingPortal(
  billingPortalUrl: string,
  options: {
    fetchFn?: typeof fetch;
    navigate?: (url: string) => void;
  } = {},
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const navigate = options.navigate ?? ((url: string) => window.location.assign(url));
  const response = await fetchFn(billingPortalUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error('billing_portal_unavailable');
  }

  const body = (await response.json()) as { url?: string };
  if (!body.url) {
    throw new Error('billing_portal_url_missing');
  }

  navigate(body.url);
}
