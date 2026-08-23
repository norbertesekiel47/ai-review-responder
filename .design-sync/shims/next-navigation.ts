// design-sync shim for `next/navigation`. Preview cards render one component
// outside any route, so every hook returns a neutral, non-throwing value.
export function usePathname(): string {
  return '/';
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}

export function useParams(): Record<string, string> {
  return {};
}

const NOOP_ROUTER = {
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
  prefetch: () => {},
};

export function useRouter(): typeof NOOP_ROUTER {
  return NOOP_ROUTER;
}

export function redirect(_url: string): never {
  throw new Error('[design-sync] redirect() is not available in a preview card');
}

export function notFound(): never {
  throw new Error('[design-sync] notFound() is not available in a preview card');
}
