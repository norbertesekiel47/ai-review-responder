// design-sync shim for `next/image`. Renders the plain <img> Next emits,
// honouring `fill` layout so absolutely-positioned art keeps its geometry.
// Optimisation-only props are dropped.
import type { CSSProperties, ImgHTMLAttributes } from 'react';
import { INLINED_ASSETS } from '../.cache/assets';

// Where the app serves public/ in production. An absolute /path resolves
// against the SERVING origin, which for a preview card or a rendered design is
// never RepWorth — so a path with no inlined copy falls back to the live site.
const PUBLIC_ORIGIN = 'https://repworth.net';

/** Absolute public paths get an inlined data URI, else the production origin. */
function resolveSrc(src: string): string {
  if (!src || !src.startsWith('/')) return src;
  return INLINED_ASSETS[src] ?? PUBLIC_ORIGIN + src;
}

type StaticImport = { src: string; width?: number; height?: number };

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | StaticImport;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  unoptimized?: boolean;
  placeholder?: string;
  blurDataURL?: string;
  loader?: unknown;
};

const FILL_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

export default function Image({
  src,
  fill,
  style,
  priority: _priority,
  quality: _quality,
  unoptimized: _unoptimized,
  placeholder: _placeholder,
  blurDataURL: _blurDataURL,
  loader: _loader,
  alt = '',
  ...rest
}: ImageProps) {
  const url = resolveSrc(typeof src === 'string' ? src : src?.src);
  return (
    // The whole point of this shim is to NOT be next/image: the Next runtime
    // does not exist in a design-system bundle.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      style={fill ? { ...FILL_STYLE, ...style } : style}
      {...rest}
    />
  );
}
