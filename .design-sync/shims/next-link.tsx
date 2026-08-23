// design-sync shim for `next/link`. The Next router does not exist in a plain
// browser bundle, so Link degrades to the anchor it renders in production.
// Router-only props are dropped; every DOM prop passes through.
import type { AnchorHTMLAttributes, ReactNode } from 'react';

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string | { pathname?: string };
  children?: ReactNode;
  prefetch?: boolean | null;
  replace?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  passHref?: boolean;
  legacyBehavior?: boolean;
};

export default function Link({
  href,
  children,
  prefetch: _prefetch,
  replace: _replace,
  scroll: _scroll,
  shallow: _shallow,
  passHref: _passHref,
  legacyBehavior: _legacyBehavior,
  ...rest
}: LinkProps) {
  const to = typeof href === 'string' ? href : (href?.pathname ?? '#');
  return (
    <a href={to} {...rest}>
      {children}
    </a>
  );
}
